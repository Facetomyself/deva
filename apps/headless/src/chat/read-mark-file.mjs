import { randomBytes } from 'node:crypto'
import {
  constants as C, fchmodSync, fchownSync, fsyncSync, linkSync, openSync, readSync, renameSync, unlinkSync, writeFileSync
} from 'node:fs'
import { PATH, close, fdPath, mountId, openAbsoluteDirectory, sameInode, stat } from '../files/workspace-files-fd.mjs'
import { readStateConflict, readStateLimit, readStateReadOnly, readStateUnconfirmed, readStateUnsupported } from './read-mark-errors.mjs'
import { MAX_READ_STATE_BYTES } from './read-mark-format.mjs'
import { assertPlainMetadata, lockReadState } from './read-mark-unix.mjs'

const NAME = 'read-state.json'
const readFlags = C.O_RDONLY | C.O_NONBLOCK
const newFlags = C.O_RDWR | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW | C.O_NONBLOCK
const mode = info => info.mode & 0o7777n
const sameOwnership = (a, b) => a.uid === b.uid && a.gid === b.gid && a.mode === b.mode
const sameContentStamp = (a, b) => sameInode(a, b) && sameOwnership(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs
const sameFileStamp = (a, b) => sameContentStamp(a, b) && a.nlink === b.nlink && a.ctimeNs === b.ctimeNs

function mounted(fd) {
  try { return mountId(fd) } catch { throw readStateUnsupported() }
}

function safeDirectory(info) {
  if (!info.isDirectory() || info.uid !== BigInt(process.geteuid()) || (mode(info) & 0o7022n)) throw readStateUnsupported()
  if ((mode(info) & 0o500n) !== 0o500n) throw readStateReadOnly()
}

function safeFile(info) {
  // Desktop can produce 0644. Group/other writes, executes and special bits widen this
  // policy; a safe owner-read-only file can be inspected but never replaced by Workbench.
  if (!info.isFile() || info.nlink !== 1n || info.uid !== BigInt(process.geteuid()) || (mode(info) & ~0o644n)) {
    throw readStateUnsupported()
  }
  if (!(mode(info) & 0o400n)) throw readStateReadOnly()
  if (info.size > BigInt(MAX_READ_STATE_BYTES)) throw readStateLimit()
}

function openRoot(root) {
  try { return openAbsoluteDirectory(root) }
  catch (error) { if (error?.code !== 'ENOENT') throw error }
}

export function pinReadMarkRoot(root) {
  if (process.platform !== 'linux') throw readStateUnsupported()
  const fd = openRoot(root)
  if (fd === undefined) return undefined
  try {
    const info = stat(fd)
    safeDirectory(info)
    return { fd, info, mount: mounted(fd) }
  } catch (error) { close(fd); throw error }
}

function validateRoot(root, pin, expected) {
  let current
  try { current = openRoot(root) }
  catch (error) {
    // An existing pin must still resolve by its original binding, including no new symlink.
    if (error?.code === 'ENOTDIR' || error?.code === 'ELOOP') throw readStateConflict()
    throw error
  }
  try {
    if (current === undefined) throw readStateConflict()
    const held = stat(pin.fd)
    const live = stat(current)
    // A held O_PATH descriptor fixes the inode lifetime. Directory ctime (and synthetic
    // birthtime on older kernels) can change while publishing into the *same* directory.
    if (!sameInode(pin.info, live) || !sameInode(held, live) || held.nlink === 0n || mounted(current) !== pin.mount ||
        !sameOwnership(held, live) || (expected && !sameOwnership(live, expected))) throw readStateConflict()
    safeDirectory(live)
    return live
  } finally { close(current) }
}

function probe(dir, name) {
  try { return openSync(fdPath(dir, name), PATH) }
  catch (error) { if (error?.code !== 'ENOENT') throw error }
}

function readBytes(fd, expected) {
  const bytes = Buffer.allocUnsafe(Number(expected.size))
  // Local regular files: a short read is a concurrent change (or an unconfirmed I/O
  // result). Never loop on the attacker-controlled count or read beyond the stat limit.
  if ((bytes.length && readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) || !sameFileStamp(expected, stat(fd))) {
    throw readStateConflict()
  }
  return bytes
}

function checkName(dir, mount, name, expected) {
  const pin = probe(dir, name)
  try {
    if (expected === null ? pin !== undefined : pin === undefined || !sameFileStamp(expected, stat(pin)) || mounted(pin) !== mount) {
      throw readStateConflict()
    }
  } finally { close(pin) }
}

function openNative(dir, mount) {
  // Pin without opening the data plane of a possible symlink, FIFO or device.
  const pin = probe(dir, NAME)
  if (pin === undefined) return null
  let fd
  try {
    const info = stat(pin)
    if (mounted(pin) !== mount) throw readStateUnsupported()
    safeFile(info)
    fd = openSync(fdPath(pin), readFlags)
    if (!sameFileStamp(info, stat(fd)) || mounted(fd) !== mount) throw readStateConflict()
    const source = { fd, info, bytes: readBytes(fd, info) }
    fd = undefined
    return source
  } finally { try { close(fd) } finally { close(pin) } }
}

function stageFile(dir, source, bytes) {
  const name = `.${NAME}.${randomBytes(16).toString('hex')}.tmp`
  const fd = openSync(fdPath(dir, name), newFlags, 0o600)
  const stage = { fd, name }
  try {
    const created = stat(fd)
    if (!created.isFile() || created.nlink !== 1n || created.uid !== BigInt(process.geteuid())) throw readStateConflict()
    // Probe before writing even the temporary bytes: a directory default ACL can affect
    // the empty staging inode, and chmod of an inherited ACL can widen its group mask.
    assertPlainMetadata(dir, fd, ...(source ? [source.fd] : []))
    if (!sameFileStamp(created, stat(fd))) throw readStateConflict()
    const intendedMode = source ? mode(source.info) : 0o600n
    const intendedGid = source?.info.gid ?? created.gid
    if (created.gid !== intendedGid) fchownSync(fd, Number(created.uid), Number(intendedGid))
    fchmodSync(fd, Number(intendedMode))
    writeFileSync(fd, bytes)
    fsyncSync(fd)
    const info = stat(fd)
    safeFile(info)
    if (mode(info) !== intendedMode || info.gid !== intendedGid || !readBytes(fd, info).equals(bytes)) throw readStateConflict()
    return { ...stage, info }
  } catch (error) {
    try { removeStage(dir, stage) } catch { /* leave unconfirmed staging names alone */ }
    close(fd)
    throw error
  }
}

function removeStage(dir, stage) {
  const pin = probe(dir, stage.name)
  try {
    // A same-UID, noncooperating writer can replace the name; do not delete an observed
    // replacement. Linux does not expose inode-conditional unlink through Node.
    if (pin !== undefined && sameInode(stat(stage.fd), stat(pin))) unlinkSync(fdPath(dir, stage.name))
  } finally { close(pin) }
}

function attachStage(dir, stage, replace) {
  const target = fdPath(dir, NAME)
  const temporary = fdPath(dir, stage.name)
  try {
    if (replace) {
      // flock + the final comparison serialize cooperating writers, even across processes.
      // Plain rename has no compare-inode precondition against a same-UID writer ignoring flock.
      renameSync(temporary, target)
    } else {
      // Publish an initially absent file without ever overwriting a newly appeared name.
      linkSync(temporary, target)
    }
  } catch (error) {
    let observed
    try {
      observed = probe(dir, NAME)
      if (observed !== undefined && sameInode(stage.info, stat(observed))) throw readStateUnconfirmed()
    } catch { throw readStateUnconfirmed() }
    finally { close(observed) }
    throw error
  }
}

function publish(dir, mount, verifyRoot, source, bytes, verify) {
  if (!(mode(verifyRoot()) & 0o200n) || (source && !(mode(source.info) & 0o200n))) throw readStateReadOnly()
  lockReadState(dir)
  verifyRoot()
  checkName(dir, mount, NAME, source?.info ?? null)
  const stage = stageFile(dir, source, bytes)
  let pending = true
  let installed
  try {
    verify() // Staging and fsync are done; only bounded CAS reads precede publication.
    verifyRoot()
    // Check bytes as well as metadata after the callback: some Unix filesystems expose
    // coarse timestamps. Keep the source and stage inodes pinned until the commit completes.
    if (!readBytes(stage.fd, stage.info).equals(bytes) || (source && !readBytes(source.fd, source.info).equals(source.bytes))) {
      throw readStateConflict()
    }
    checkName(dir, mount, stage.name, stage.info)
    checkName(dir, mount, NAME, source?.info ?? null)
    attachStage(dir, stage, source !== null)
    pending = source === null
    try {
      if (pending) {
        removeStage(dir, stage)
        pending = false
      }
      fsyncSync(dir)
      installed = openNative(dir, mount)
      if (!installed || !sameContentStamp(stage.info, installed.info) || !installed.bytes.equals(bytes)) throw readStateUnconfirmed()
      verifyRoot()
      checkName(dir, mount, NAME, installed.info)
    } catch { throw readStateUnconfirmed() }

    // The commit was observed and durable. Propagate the exact approved verify error,
    // but never roll back or acknowledge a publication after revoked/stale access.
    verify()
    try {
      verifyRoot()
      if (!readBytes(installed.fd, installed.info).equals(bytes)) throw readStateUnconfirmed()
      checkName(dir, mount, NAME, installed.info)
    } catch { throw readStateUnconfirmed() }
  } finally {
    // Cleanup never masks a fresh authorization/domain error, nor targets the native name.
    try { if (pending) removeStage(dir, stage) } catch { /* leave unconfirmed staging names alone */ }
    try { close(installed?.fd) } finally { close(stage.fd) }
  }
}

export function withReadMarkFile(root, pin, operation) {
  const before = validateRoot(root, pin)
  const dir = openSync(fdPath(pin.fd), readFlags | C.O_DIRECTORY)
  let source
  try {
    if (!sameInode(before, stat(dir)) || mounted(dir) !== pin.mount) throw readStateConflict()
    const verifyRoot = () => validateRoot(root, pin, before)
    verifyRoot()
    source = openNative(dir, pin.mount)
    const confirm = () => {
      verifyRoot()
      if (source && !readBytes(source.fd, source.info).equals(source.bytes)) throw readStateConflict()
      checkName(dir, pin.mount, NAME, source?.info ?? null)
    }
    return operation(source?.bytes ?? null, confirm, (bytes, verify) => publish(dir, pin.mount, verifyRoot, source, bytes, verify))
  } finally { try { close(source?.fd) } finally { close(dir) } }
}
