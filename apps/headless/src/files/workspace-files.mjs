import { createHash, randomBytes } from 'node:crypto'
import {
  accessSync, constants as C, fchmodSync, fchownSync, fsyncSync, openSync, opendirSync, readSync,
  renameSync, unlinkSync, writeFileSync
} from 'node:fs'
import { DIRECTORY, PATH, close, decodeUtf8, fdPath, mountId, sameInode, stat, validWorkspaceName, visibleName } from './workspace-files-fd.mjs'

const MAX_BYTES = 2 * 1024 * 1024
const MAX_DEPTH = 16
const MAX_SCAN = 4096
const BINARY_CONTROL = /[\u0000-\u0008\u000e-\u001f\u007f-\u0084\u0086-\u009f]/u
const ERROR = {
  PATH: [400, 'Invalid workspace file path or input'],
  NOT_FOUND: [404, 'Workspace file or directory was not found'],
  UNSAFE: [403, 'Workspace entry is not accessible as a regular text file or directory'],
  READ_ONLY: [403, 'Workspace file is read-only'],
  CONFLICT: [409, 'Workspace entry changed; reload before editing'],
  LIMIT: [413, 'Workspace file or directory exceeds the limit'],
  IO: [500, 'Workspace file operation failed']
}
class WorkspaceFileError extends Error {
  constructor(kind) {
    const [status, message] = ERROR[kind]
    super(message)
    this.code = `ERR_WORKSPACE_FILE_${kind}`
    this.status = this.statusCode = status
  }
}
const fail = kind => { throw new WorkspaceFileError(kind) }
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
  if (directory && path === '') return []
  if (typeof path !== 'string' || path.length > 4095) fail('PATH')
  const parts = path.split('/')
  if (parts.length > MAX_DEPTH || !parts.every(validWorkspaceName)) fail('PATH')
  return parts
}
function access(fd, info, mode) {
  // Keep Unix read-only/no-search mode intent even if headless runs as uid 0. access(2)
  // also checks the relevant ACL, credentials and Linux's read-only mount state.
  if (((mode & C.R_OK) && !(info.mode & 0o444n)) || ((mode & C.W_OK) && !(info.mode & 0o222n)) ||
      ((mode & C.X_OK) && !(info.mode & 0o111n))) return false
  try { accessSync(fdPath(fd), mode); return true } catch { return false }
}
function editableDirectory(fd) {
  const mode = C.R_OK | C.W_OK | C.X_OK // the parent fd is opened for fsync as well
  return access(fd, stat(fd), mode)
}
function onProjectMount(project, fd) {
  if (mountId(fd) !== project.mount) fail('UNSAFE')
}
function withDirectory(catalog, id, parts, fn) {
  const project = catalog.pinProject(id)
  const chain = []
  let fd = project.fd
  try {
    for (const name of parts) {
      if (!access(fd, stat(fd), C.X_OK)) fail('UNSAFE')
      const next = openSync(fdPath(fd, name), DIRECTORY)
      try {
        onProjectMount(project, next)
        chain.push({ name, parent: fd, fd: next, info: stat(next) })
        fd = next
      } catch (error) { close(next); throw error }
    }
    if (!access(fd, stat(fd), C.X_OK)) fail('UNSAFE')
    function assertCurrent() {
      project.assertCurrent()
      for (const step of chain) {
        let current
        try {
          if (!access(step.parent, stat(step.parent), C.X_OK)) fail('CONFLICT')
          current = openSync(fdPath(step.parent, step.name), DIRECTORY)
          onProjectMount(project, current)
          if (!sameInode(step.info, stat(current))) fail('CONFLICT')
        } catch { fail('CONFLICT') } finally { close(current) }
      }
      project.assertCurrent()
    }
    assertCurrent()
    return fn({ project, fd, assertCurrent })
  } finally {
    for (const step of chain.reverse()) close(step.fd)
    project.close()
  }
}
function entryType(info) {
  if (info.isDirectory()) return 'dir'
  if (info.isFile() && info.nlink === 1n) return 'file'
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
function regular(info) {
  return info.isFile() && info.nlink === 1n
}
function sameVersion(a, b) {
  return regular(a) && regular(b) && sameInode(a, b) && a.size === b.size && a.ctimeNs === b.ctimeNs && a.mtimeNs === b.mtimeNs
}
function revision(path, info, bytes) {
  const key = [path, info.dev, info.ino, info.birthtimeNs, info.size, info.ctimeNs, info.mtimeNs].map(String)
  return 'r_' + createHash('sha256').update(JSON.stringify(key)).update(bytes).digest('hex')
}
function assertFile(scope, name, expected) {
  scope.assertCurrent()
  let current
  try {
    current = openSync(fdPath(scope.fd, name), PATH)
    onProjectMount(scope.project, current)
    if (!sameVersion(expected, stat(current))) fail('CONFLICT')
  } catch { fail('CONFLICT') } finally { close(current) }
}
function readBytes(fd, info) {
  const bytes = Buffer.alloc(Number(info.size))
  let total = 0
  for (let n; total < bytes.length && (n = readSync(fd, bytes, total, bytes.length - total, total));) total += n
  if (BigInt(total) !== info.size || !sameVersion(info, stat(fd))) fail('CONFLICT')
  return bytes.subarray(0, total)
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
  // A normal O_RDONLY open, even with O_NOFOLLOW and O_NONBLOCK, can open a device
  // introduced between lstat and open. Inspect the O_PATH pin first, then reopen it.
  let pin, file
  try {
    pin = openSync(fdPath(scope.fd, name), PATH)
    const info = stat(pin)
    onProjectMount(scope.project, pin)
    if (!regular(info) || !access(pin, info, C.R_OK)) fail('UNSAFE')
    assertFile(scope, name, info)
    if (info.size <= MAX_BYTES) {
      file = openSync(fdPath(pin), C.O_RDONLY | C.O_NONBLOCK)
      if (!sameVersion(info, stat(file))) fail('CONFLICT')
    }
    return fn({ fd: file, pin, info })
  } finally { close(file); close(pin) }
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
