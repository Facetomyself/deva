import { constants as C, openSync, opendirSync, readSync } from 'node:fs'
import { DIRECTORY, PATH, close, decodeUtf8, fdPath, mountId, sameInode, stat } from '../files/workspace-files-fd.mjs'
import { access, regular } from '../files/workspace-files-pin.mjs'
import { gitError } from './git-errors.mjs'

const MAX_BYTES = 64 * 1024 * 1024
const MAX_NODES = 30_000
const fail = code => { throw gitError(code) }

// Do not include atime (these reads can update it) or birthtime (old Linux can
// synthesize it from ctime). Inodes identify mounts/entries; the rest fences revisions.
function sameVersion(a, b) {
  return sameInode(a, b) && a.size === b.size && a.ctimeNs === b.ctimeNs && a.mtimeNs === b.mtimeNs &&
    a.mode === b.mode && a.nlink === b.nlink && a.uid === b.uid && a.gid === b.gid
}
function fdVersion(fd) {
  const info = stat(fd)
  const mount = mountId(fd)
  if (!sameVersion(info, stat(fd))) fail('git_stale')
  return { info, mount }
}
function current(expected, actual) {
  if (expected === undefined || actual === undefined) return expected === actual
  return expected.mount === actual.mount && sameVersion(expected.info, actual.info)
}
function assertCurrent(expected, actual) {
  if (!current(expected, actual)) fail('git_stale')
}
function nativeFailure(error) {
  if (typeof error?.code === 'string' && (error.code.startsWith('git_') || error.code === 'unsupported_git_layout')) throw error
  if (['EBADF', 'ENOENT', 'ESTALE'].includes(error?.code)) fail('git_stale')
  if (['EMFILE', 'ENFILE', 'ENOMEM'].includes(error?.code)) fail('git_limit')
  fail('git_unsafe')
}

function peek(parent, name) {
  let fd
  try {
    try { fd = openSync(fdPath(parent, name), PATH) } catch (error) {
      if (error?.code === 'ENOENT') return { fd: undefined, version: undefined }
      nativeFailure(error)
    }
    return { fd, version: fdVersion(fd) }
  } catch (error) {
    close(fd)
    nativeFailure(error)
  }
}
function search(fd, version, expectedMount) {
  if (version.mount !== expectedMount || !version.info.isDirectory() || !access(fd, version.info, C.X_OK)) fail('git_unsafe')
}
export function boundedInteger(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('git_limit')
  return value
}

export function pinGitRoot(source, expectedMount) {
  if (process.platform !== 'linux') fail('unsupported_git_layout')
  if (!Number.isSafeInteger(source) || source < 0 || !['string', 'number'].includes(typeof expectedMount) ||
    !/^\d+$/u.test(String(expectedMount))) fail('git_stale')
  expectedMount = String(expectedMount)
  let root, baseline
  try {
    baseline = fdVersion(source)
    if (baseline.mount !== expectedMount) fail('git_stale')
    search(source, baseline, expectedMount)
    // Each worker owns this descriptor only. The service keeps `source` pinned.
    root = openSync(fdPath(source, '.'), DIRECTORY)
    assertCurrent(baseline, fdVersion(root))
    assertCurrent(baseline, fdVersion(source))
  } catch (error) {
    close(root)
    nativeFailure(error)
  }

  let nodes = 0
  let bytes = 0
  const observed = { version: baseline, children: new Map() }
  function chargeNode() {
    if (++nodes > MAX_NODES) fail('git_limit')
  }
  function checkRoot() {
    if (root === undefined) fail('git_stale')
    try {
      assertCurrent(baseline, fdVersion(source))
      assertCurrent(baseline, fdVersion(root))
    } catch { fail('git_stale') }
  }
  function namedVersion(parent, name, expected) {
    try {
      const { fd, version } = peek(parent, name)
      try { assertCurrent(expected, version) } finally { close(fd) }
    } catch { fail('git_stale') }
  }
  function descend(parent, record, parts, index, fn) {
    if (index === parts.length) return fn(parent, record.version)
    search(parent, record.version, expectedMount)
    const name = parts[index]
    chargeNode()
    const previous = record.children.get(name)
    let inspect
    try { inspect = peek(parent, name) } catch (error) {
      if (previous !== undefined && error.code !== 'git_limit') fail('git_stale')
      throw error
    }
    const { fd, version } = inspect
    try {
      if (previous !== undefined) assertCurrent(previous.version, version)
      const child = previous ?? { version, children: new Map() }
      if (previous === undefined) record.children.set(name, child)
      const answer = fd === undefined ? fn(undefined, undefined) : descend(fd, child, parts, index + 1, fn)
      // Check both the descriptor and the named slot (a bind mount can change the latter
      // without touching parent-directory timestamps).
      if (fd !== undefined) assertCurrent(version, fdVersion(fd))
      namedVersion(parent, name, version)
      assertCurrent(record.version, fdVersion(parent))
      return answer
    } finally { close(fd) }
  }
  function path(parts, fn) {
    checkRoot()
    let result
    try { result = descend(root, observed, parts, 0, fn) } catch (error) { nativeFailure(error) }
    checkRoot()
    return result
  }
  function verifyChildren(fd, record) {
    if (record.children.size) search(fd, record.version, expectedMount)
    for (const [name, child] of record.children) {
      const next = peek(fd, name)
      try {
        assertCurrent(child.version, next.version)
        if (next.fd !== undefined) verifyChildren(next.fd, child)
      } finally { close(next.fd) }
    }
    assertCurrent(record.version, fdVersion(fd))
  }
  return {
    path,
    read(pin, version, limit) {
      const { info } = version
      if (version.mount !== expectedMount || !regular(info) || !access(pin, info, C.R_OK)) fail('git_unsafe')
      if (info.size > BigInt(limit)) return undefined
      const size = Number(info.size)
      if (size > MAX_BYTES - bytes) fail('git_limit')
      bytes += size
      let reader
      try {
        // The only followed link is the kernel's procfd link for the inspected ordinary inode.
        reader = openSync(fdPath(pin), C.O_RDONLY | C.O_NONBLOCK)
        assertCurrent(version, fdVersion(reader))
        const result = Buffer.allocUnsafe(size)
        for (let pos = 0; pos < size;) {
          const count = readSync(reader, result, pos, size - pos, pos)
          if (count === 0) fail('git_stale')
          pos += count
        }
        assertCurrent(version, fdVersion(reader))
        return result
      } finally { close(reader) }
    },
    list(dir, version, visit) {
      search(dir, version, expectedMount)
      if (!access(dir, version.info, C.R_OK | C.X_OK)) fail('git_unsafe')
      const scan = opendirSync(fdPath(dir, '.'), { encoding: 'buffer' })
      try {
        for (let entry; (entry = scan.readSync()) !== null;) {
          chargeNode()
          let name
          try { name = decodeUtf8(entry.name) } catch { continue }
          if (visit(name) === false) break
        }
      } finally { scan.closeSync() }
    },
    entryType(version) {
      if (version.mount !== expectedMount) fail('git_unsafe')
      if (version.info.isDirectory()) return 'dir'
      if (regular(version.info)) return 'file'
      fail('git_unsafe')
    },
    verify() {
      checkRoot()
      try { verifyChildren(root, observed) } catch { fail('git_stale') }
      checkRoot()
    },
    close() {
      if (root === undefined) return
      const fd = root
      root = undefined
      close(fd)
    },
  }
}
