import { createHash, randomBytes } from 'node:crypto'
import {
  constants as C, fchmodSync, fchownSync, fsyncSync, openSync, opendirSync,
  renameSync, unlinkSync, writeFileSync
} from 'node:fs'
import { PATH, close, decodeUtf8, fdPath, mountId, sameInode, stat, visibleName, workspacePathParts } from './workspace-files-fd.mjs'
import {
  WorkspaceFileError, access, assertFile, fail, onProjectMount, readBytes, regular, sameVersion,
  withDirectory, withFilePin, withReadablePin,
} from './workspace-files-pin.mjs'

const MAX_BYTES = 2 * 1024 * 1024
const MAX_SCAN = 4096
const BINARY_CONTROL = /[\u0000-\u0008\u000e-\u001f\u007f-\u0084\u0086-\u009f]/u
function operation(writing, fn) {
  try { return fn() } catch (error) {
    if (error instanceof WorkspaceFileError || error?.code === 'ERR_WORKSPACE_UNAVAILABLE') throw error
    if (error?.code === 'ENOENT' || error?.code === 'ESTALE') fail(writing ? 'CONFLICT' : 'NOT_FOUND')
    if (error?.code === 'EROFS' || (writing && ['EACCES', 'EPERM'].includes(error?.code))) fail('READ_ONLY')
    if (['ENOTDIR', 'ELOOP', 'EISDIR', 'EACCES', 'EPERM'].includes(error?.code)) fail('UNSAFE')
    fail('IO')
  }
}
function components(path, directory = false) {
  return workspacePathParts(path, directory) ?? fail('PATH')
}
function editableDirectory(fd) {
  const mode = C.R_OK | C.W_OK | C.X_OK // the parent fd is opened for fsync as well
  return access(fd, stat(fd), mode)
}
function entryType(info) {
  if (info.isDirectory()) return 'dir'
  if (regular(info)) return 'file'
  return undefined
}
function listDirectory(scope, parts, writable) {
  const { project, fd, assertCurrent } = scope
  if (!access(fd, stat(fd), C.R_OK | C.X_OK)) fail('UNSAFE')
  const dir = opendirSync(fdPath(fd, '.'), { encoding: 'buffer' })
  const entries = []
  let scanned = 0
  try {
    for (let entry; (entry = dir.readSync()) !== null;) {
      if (++scanned > MAX_SCAN) fail('LIMIT')
      const name = visibleName(entry.name)
      if (!name || (!entry.isFile() && !entry.isDirectory())) continue
      let candidate
      try {
        candidate = openSync(fdPath(fd, name), PATH)
        const type = entryType(stat(candidate))
        if (type && mountId(candidate) === project.mount) entries.push({ name, path: [...parts, name].join('/'), type })
      } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'ESTALE') throw error
      } finally { close(candidate) }
    }
  } finally { dir.closeSync() }
  assertCurrent()
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  })
  return { path: parts.join('/'), entries, writable: writable && editableDirectory(fd) }
}
function revision(path, info, bytes) {
  const key = [path, info.dev, info.ino, info.birthtimeNs, info.size, info.ctimeNs, info.mtimeNs].map(String)
  return 'r_' + createHash('sha256').update(JSON.stringify(key)).update(bytes).digest('hex')
}
function decodeText(bytes) {
  try {
    const content = decodeUtf8(bytes)
    return BINARY_CONTROL.test(content) ? null : content
  } catch { return null }
}
function editableFile(scope, fd, info) {
  // Refuse special mode bits and files whose owner cannot be retained on replacement.
  const uid = process.geteuid()
  return !(info.mode & 0o7000n) && (uid === 0 || BigInt(uid) === info.uid) &&
    access(fd, info, C.W_OK) && editableDirectory(scope.fd)
}
function withFile(scope, name, fn) {
  return withFilePin(scope, name, ({ pin, info }) => {
    if (info.size > MAX_BYTES) return fn({ fd: undefined, pin, info })
    return withReadablePin(pin, info, fd => fn({ fd, pin, info }))
  })
}
function readText(scope, name, path, writable) {
  return withFile(scope, name, ({ fd, pin, info }) => {
    if (fd === undefined) return { path, content: null, tooLarge: true, revision: null, writable: false }
    const bytes = readBytes(fd, info)
    assertFile(scope, name, info)
    const content = decodeText(bytes)
    if (content === null) return { path, content: null, binary: true, revision: null, writable: false }
    return { path, content, revision: revision(path, info, bytes), writable: writable && editableFile(scope, pin, info) }
  })
}
function checkTemp(parent, tempName, expected) {
  let current
  try {
    current = openSync(fdPath(parent, tempName), PATH)
    if (!sameVersion(expected, stat(current)) || mountId(current) !== mountId(parent)) fail('CONFLICT')
  } catch { fail('CONFLICT') } finally { close(current) }
}
function cleanTemp(parent, tempName, fd) {
  let current
  try {
    current = openSync(fdPath(parent, tempName), PATH)
    if (sameInode(stat(fd), stat(current)) && mountId(current) === mountId(parent)) unlinkSync(fdPath(parent, tempName))
  } catch { /* a missing or replaced temp is never adopted */ } finally { close(current) }
}
function replaceText(scope, name, path, previous, bytes) {
  let parent, temp, renamed = false
  const tempName = `.workspace-file-${randomBytes(16).toString('hex')}.tmp`
  try {
    scope.assertCurrent()
    parent = openSync(fdPath(scope.fd, '.'), C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW)
    onProjectMount(scope.project, parent)
    if (!sameInode(stat(parent), stat(scope.fd))) fail('CONFLICT')
    assertFile(scope, name, previous)
    temp = openSync(fdPath(parent, tempName), C.O_RDWR | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW | C.O_NONBLOCK, 0o600)
    writeFileSync(temp, bytes)
    const created = stat(temp)
    if (created.uid !== previous.uid || created.gid !== previous.gid) fchownSync(temp, Number(previous.uid), Number(previous.gid))
    fchmodSync(temp, Number(previous.mode & 0o777n))
    fsyncSync(temp)
    const prepared = stat(temp)
    checkTemp(parent, tempName, prepared)
    // Keep this check immediately before rename. rename changes the named slot in the pinned
    // directory and never follows a destination link. Linux rename has no inode-CAS parameter.
    assertFile(scope, name, previous)
    renameSync(fdPath(parent, tempName), fdPath(parent, name))
    renamed = true
    fsyncSync(parent)
    const saved = stat(temp)
    if (!sameInode(saved, prepared) || saved.size !== BigInt(bytes.length) || !readBytes(temp, saved).equals(bytes)) fail('CONFLICT')
    assertFile(scope, name, saved)
    return { ok: true, revision: revision(path, saved, bytes) }
  } finally {
    if (temp !== undefined && !renamed) cleanTemp(parent, tempName, temp)
    close(temp)
    close(parent)
  }
}
function writeText(scope, name, path, version, bytes) {
  return withFile(scope, name, ({ fd, pin, info }) => {
    if (!editableFile(scope, pin, info)) fail('READ_ONLY')
    if (fd === undefined) fail('LIMIT')
    const original = readBytes(fd, info)
    assertFile(scope, name, info)
    if (revision(path, info, original) !== version) fail('CONFLICT')
    if (decodeText(original) === null) fail('UNSAFE')
    return replaceText(scope, name, path, info, bytes)
  })
}

/** A file-only API: ids come from the operator catalog, and names are project-relative. */
export function openWorkspaceFiles({ catalog, writable = false }) {
  const canWrite = writable === true
  if (typeof catalog?.pinProject !== 'function') throw TypeError('A workspace catalog is required')
  return Object.freeze({
    async list(id, path = '') {
      const parts = components(path, true)
      return operation(false, () => withDirectory(catalog, id, parts, scope => listDirectory(scope, parts, canWrite)))
    },
    async read(id, path) {
      const parts = components(path)
      const name = parts.pop()
      return operation(false, () => withDirectory(catalog, id, parts, scope => readText(scope, name, path, canWrite)))
    },
    async write(id, input) {
      if (!canWrite) fail('READ_ONLY')
      const { path, content, revision: version } = input ?? {}
      const parts = components(path)
      const name = parts.pop()
      if (typeof content !== 'string' || typeof version !== 'string' || !/^r_[0-9a-f]{64}$/.test(version)) fail('PATH')
      if (content.length > MAX_BYTES || Buffer.byteLength(content) > MAX_BYTES) fail('LIMIT')
      if (!content.isWellFormed() || BINARY_CONTROL.test(content)) fail('PATH')
      return operation(true, () => withDirectory(catalog, id, parts, scope => writeText(scope, name, path, version, Buffer.from(content))))
    }
  })
}
