import { randomBytes } from 'node:crypto'
import {
  closeSync, constants as C, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readSync,
  renameSync, unlinkSync, writeFileSync
} from 'node:fs'
import { PATH, fdPath, mountId, openAbsoluteDirectory, sameInode } from '../files/workspace-files-fd.mjs'
import { HttpError } from '../http/policy.mjs'
import { taskConflict, taskLimit, taskUnconfirmed } from './errors.mjs'
import { MAX_TASK_FILE_BYTES, taskRevision } from './native.mjs'

const stats = { bigint: true }
const TASK_FILE = 'tasks.json'
const readFlags = C.O_RDONLY | C.O_NONBLOCK
const writeFlags = C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW | C.O_NONBLOCK
const signature = ['uid', 'gid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs']
const same = (a, b) => sameInode(a, b) && signature.every(key => a[key] === b[key])
const perms = stat => stat.mode & 0o7777n
const ownerDirectory = (stat, uid) => stat.isDirectory() && stat.uid === uid &&
  (perms(stat) & 0o7022n) === 0n && (perms(stat) & 0o500n) === 0o500n
const ownerFile = (stat, uid) => stat.isFile() && stat.uid === uid && stat.nlink === 1n &&
  (perms(stat) & 0o7022n) === 0n && (perms(stat) & 0o400n) === 0o400n

function lstat(path) {
  try { return lstatSync(path, stats) } catch (error) { if (error?.code === 'ENOENT') return null; throw error }
}

const storageError = error => error instanceof HttpError ? error : taskUnconfirmed()

// Every operation pins the fixed directory and closes all of its own descriptors. Production
// uses the existing exclusive workbench volume writer lock. The final synchronous read/CAS
// and atomic rename serialize with cooperating writers; a same-UID writer which ignores that
// lock can still race a syscall boundary (plain rename has no compare-inode precondition).
export function withTaskStorage(root, operation) {
  let dirPin
  try {
    const uid = BigInt(process.geteuid())
    dirPin = openAbsoluteDirectory(root) // O_NOFOLLOW for every path component.
    const dirIdentity = fstatSync(dirPin, stats)
    const mount = mountId(dirPin)
    if (!ownerDirectory(dirIdentity, uid)) throw taskUnconfirmed()
    const path = fdPath(dirPin, TASK_FILE)

    function directory() {
      const pin = openAbsoluteDirectory(root)
      try {
        const held = fstatSync(dirPin, stats)
        const live = fstatSync(pin, stats)
        if (!ownerDirectory(held, uid) || !ownerDirectory(live, uid) || !sameInode(dirIdentity, live) ||
            perms(held) !== perms(live) || mountId(pin) !== mount) throw taskUnconfirmed()
        return held
      } finally { closeSync(pin) }
    }

    function currentIdentity(expected) {
      if (expected === null) {
        if (lstat(path) !== null) throw taskUnconfirmed()
        return
      }
      const pin = openSync(path, PATH)
      try {
        if (!same(expected, fstatSync(pin, stats)) || mountId(pin) !== mount) throw taskUnconfirmed()
      } finally { closeSync(pin) }
    }

    function read() {
      directory()
      const named = lstat(path)
      if (named === null) {
        directory()
        currentIdentity(null)
        return null
      }
      if (!ownerFile(named, uid)) throw taskUnconfirmed()
      if (named.size > BigInt(MAX_TASK_FILE_BYTES)) throw taskLimit()
      // O_PATH pins the regular file before opening for data; a racing FIFO or device is
      // never opened for reading. The anchored proc path refers only to our held descriptor.
      const pin = openSync(path, PATH)
      try {
        const pinned = fstatSync(pin, stats)
        if (!same(named, pinned) || mountId(pin) !== mount) throw taskUnconfirmed()
        const fd = openSync(fdPath(pin), readFlags)
        try {
          const opened = fstatSync(fd, stats)
          if (!same(pinned, opened) || mountId(fd) !== mount) throw taskUnconfirmed()
          const bytes = Buffer.allocUnsafe(Number(opened.size))
          for (let offset = 0; offset < bytes.length;) {
            const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
            if (!count) throw taskUnconfirmed()
            offset += count
          }
          const env = directory()
          currentIdentity(opened)
          if (!same(opened, fstatSync(fd, stats))) throw taskUnconfirmed()
          // Legacy owner 0644 and other safe read-only modes can be inspected. Require exact
          // 0700 data directory + 0600 native file for publication; leave legacy permissions alone.
          return { bytes, identity: opened, writable: perms(env) === 0o700n && perms(opened) === 0o600n }
        } finally { closeSync(fd) }
      } finally { closeSync(pin) }
    }

    function check(before, revision, writing = false) {
      const actual = read()
      if (taskRevision(actual) !== revision || !actual) throw taskConflict()
      if (writing && !actual.writable) throw taskUnconfirmed()
      if (!same(before.identity, actual.identity)) throw taskConflict()
      return actual
    }

    function publish(before, revision, bytes, verifyOwner) {
      const tmp = fdPath(dirPin, `.tasks.json.${randomBytes(16).toString('hex')}.tmp`)
      let result, failure, dir, fd, staged, renamed = false
      try {
        if (!before.writable || perms(directory()) !== 0o700n) throw taskUnconfirmed()
        dir = openSync(fdPath(dirPin), readFlags | C.O_DIRECTORY)
        fd = openSync(tmp, writeFlags, 0o600)
        fchmodSync(fd, 0o600)
        writeFileSync(fd, bytes)
        fsyncSync(fd)
        staged = fstatSync(fd, stats)
        verifyOwner() // Synchronous, immediately before the final on-disk comparison and publication.
        const actual = check(before, revision, true)
        const named = lstat(tmp)
        if (!named || !ownerFile(staged, uid) || perms(staged) !== 0o600n || !same(staged, named) ||
            !same(staged, fstatSync(fd, stats)) || perms(directory()) !== 0o700n) throw taskUnconfirmed()
        currentIdentity(actual.identity)
        renameSync(tmp, path)
        renamed = true
        fsyncSync(dir)
      } catch (error) { failure = storageError(error) }

      // Always make a full disk observation after an attempted publication, including OS
      // failures. A write is acknowledged only for the exact bytes on our own renamed inode.
      // In particular, a concurrent external edit to an equivalent task is never a success.
      try {
        result = read()
        if (!renamed || !result?.writable || !sameInode(staged, result.identity) || !result.bytes.equals(bytes)) {
          failure ??= taskUnconfirmed()
        }
      } catch { failure ??= taskUnconfirmed() }
      try {
        if (fd !== undefined && !renamed) {
          const named = lstat(tmp)
          if (named && sameInode(named, fstatSync(fd, stats))) unlinkSync(tmp)
        }
      } catch { failure ??= taskUnconfirmed() }
      finally {
        try { if (fd !== undefined) closeSync(fd) } finally { if (dir !== undefined) closeSync(dir) }
      }
      if (failure) throw failure
      return result
    }

    return operation({ read, check, publish })
  } catch (error) { throw storageError(error) }
  finally { if (dirPin !== undefined) closeSync(dirPin) }
}
