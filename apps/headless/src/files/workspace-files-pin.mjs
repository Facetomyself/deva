import { accessSync, constants as C, openSync, readSync } from 'node:fs'
import { DIRECTORY, PATH, close, fdPath, mountId, sameInode, stat } from './workspace-files-fd.mjs'

const ERROR = {
  PATH: [400, 'Invalid workspace file path or input'],
  NOT_FOUND: [404, 'Workspace file or directory was not found'],
  UNSAFE: [403, 'Workspace entry is not accessible as a regular text file or directory'],
  READ_ONLY: [403, 'Workspace file is read-only'],
  CONFLICT: [409, 'Workspace entry changed; reload before editing'],
  LIMIT: [413, 'Workspace file or directory exceeds the limit'],
  IO: [500, 'Workspace file operation failed']
}
export class WorkspaceFileError extends Error {
  constructor(kind) {
    const [status, message] = ERROR[kind]
    super(message)
    this.code = `ERR_WORKSPACE_FILE_${kind}`
    this.status = this.statusCode = status
  }
}
export const fail = kind => { throw new WorkspaceFileError(kind) }

export function access(fd, info, mode) {
  // Keep Unix read-only/no-search mode intent even if headless runs as uid 0. access(2)
  // also checks the relevant ACL, credentials and Linux's read-only mount state.
  if (((mode & C.R_OK) && !(info.mode & 0o444n)) || ((mode & C.W_OK) && !(info.mode & 0o222n)) ||
      ((mode & C.X_OK) && !(info.mode & 0o111n))) return false
  try { accessSync(fdPath(fd), mode); return true } catch { return false }
}
export function onProjectMount(project, fd) {
  if (mountId(fd) !== project.mount) fail('UNSAFE')
}
export function withDirectory(catalog, id, parts, fn) {
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
      if (!access(fd, stat(fd), C.X_OK)) fail('CONFLICT')
      project.assertCurrent()
    }
    assertCurrent()
    return fn({ project, fd, assertCurrent })
  } finally {
    for (const step of chain.reverse()) close(step.fd)
    project.close()
  }
}
export function regular(info) {
  return info.isFile() && info.nlink === 1n
}
export function sameVersion(a, b) {
  return regular(a) && regular(b) && sameInode(a, b) && a.size === b.size && a.ctimeNs === b.ctimeNs &&
    a.mtimeNs === b.mtimeNs && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid
}
export function assertFile(scope, name, expected) {
  scope.assertCurrent()
  let current
  try {
    current = openSync(fdPath(scope.fd, name), PATH)
    onProjectMount(scope.project, current)
    const info = stat(current)
    if (!sameVersion(expected, info) || !access(current, info, C.R_OK)) fail('CONFLICT')
  } catch { fail('CONFLICT') } finally { close(current) }
}
export function readBytes(fd, info, limit = Number(info.size)) {
  const bytes = Buffer.alloc(Math.min(limit, Number(info.size)))
  let total = 0
  for (let n; total < bytes.length && (n = readSync(fd, bytes, total, bytes.length - total, total));) total += n
  if (total !== bytes.length || !sameVersion(info, stat(fd))) fail('CONFLICT')
  return bytes.subarray(0, total)
}
export function withFilePin(scope, name, fn, onMissing) {
  // O_RDONLY could open a device introduced between lstat and open. Inspect an
  // O_PATH pin first, then only reopen from the held descriptor.
  let pin
  try {
    try { pin = openSync(fdPath(scope.fd, name), PATH) } catch (error) {
      if (error?.code !== 'ENOENT' || !onMissing) throw error
      // This catches a missing leaf only, not a missing or changed ancestor.
      scope.assertCurrent()
      if (!access(scope.fd, stat(scope.fd), C.X_OK)) fail('UNSAFE')
      return onMissing()
    }
    const info = stat(pin)
    onProjectMount(scope.project, pin)
    if (!regular(info) || !access(pin, info, C.R_OK)) fail('UNSAFE')
    assertFile(scope, name, info)
    return fn({ pin, info })
  } finally { close(pin) }
}
export function withReadablePin(pin, info, fn, project) {
  let file
  try {
    file = openSync(fdPath(pin), C.O_RDONLY | C.O_NONBLOCK)
    if (project) onProjectMount(project, file)
    if (!sameVersion(info, stat(file))) fail('CONFLICT')
    return fn(file)
  } finally { close(file) }
}
