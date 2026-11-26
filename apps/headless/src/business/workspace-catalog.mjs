import { createHash } from 'node:crypto'
import { openSync, opendirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DIRECTORY, close, fdPath, mountId, openAbsoluteDirectory, sameInode, stat, visibleName } from '../files/workspace-files-fd.mjs'

const unavailable = () => Object.assign(Error('Workspace is unavailable'), { code: 'ERR_WORKSPACE_UNAVAILABLE', status: 404, statusCode: 404 })
const validId = id => typeof id === 'string' && /^w_[a-f0-9]{32}$/.test(id)
function inside(outer, path) { const r = relative(outer, path); return r === '' || (!isAbsolute(r) && r !== '..' && !r.startsWith(`..${sep}`)) }
function projectId(path, info) {
  // Workspace IDs persisted in PR 4 role bindings must survive the upgrade. The operator
  // grants a direct mounted project directory. Per-operation fd checks independently
  // fence replacement; this hash is neither an access token nor a permanent file handle.
  return 'w_' + createHash('sha256').update(JSON.stringify([path, String(info.dev), String(info.ino)])).digest('hex').slice(0, 32)
}
function overlapsReserved(base, path) {
  if (!path) return false
  const resolved = resolve(path)
  const overlaps = candidate => inside(candidate, base) || inside(base, candidate)
  if (overlaps(resolved)) return true
  // Operator-owned state paths can themselves be symlinks. Keep their physical
  // location reserved even if their configured spelling is outside the grant.
  try { return overlaps(realpathSync.native(resolved)) } catch { return false }
}

/** Only first-level real directories of an explicitly mounted root are choices. resolveRoot
 * serves memory's canonical project-key calculation; file consumers own a pinProject lease. */
export function openWorkspaceCatalog({ root, privateRoots = [] }) {
  if (root == null || root === '') return Object.freeze({ list: () => [], resolveRoot: () => undefined, pinProject() { throw unavailable() }, close() {} })
  if (typeof root !== 'string' || !isAbsolute(root) || root.includes('\0')) throw unavailable()
  const base = resolve(root)
  const reserved = [...privateRoots, '/proc', '/dev', '/sys', '/etc', '/run', '/root']
  if (base === '/' || reserved.some(path => overlapsReserved(base, path))) throw unavailable()
  let fd, rootInfo, rootMount
  try {
    fd = openAbsoluteDirectory(base)
    rootInfo = stat(fd)
    rootMount = mountId(fd)
    if (realpathSync.native(fdPath(fd)) !== base) throw unavailable()
  } catch {
    close(fd)
    throw unavailable()
  }
  let closed = false
  function assertRoot() {
    if (closed) throw unavailable()
    let current
    try {
      current = openAbsoluteDirectory(base)
      if (!sameInode(stat(current), rootInfo) || mountId(current) !== rootMount || realpathSync.native(fdPath(fd)) !== base) throw unavailable()
    } catch { throw unavailable() } finally { close(current) }
  }
  function openChild(name) {
    const sub = openSync(fdPath(fd, name), DIRECTORY)
    try {
      const path = join(base, name)
      if (mountId(sub) !== rootMount || realpathSync.native(fdPath(sub)) !== path) throw unavailable()
      return { sub, path, info: stat(sub) }
    } catch (error) {
      close(sub)
      throw error
    }
  }
  function items() {
    assertRoot()
    const records = []
    // Avoid allocating all entries of a broad mount. A partial catalog confers no grants.
    let scanned = 0
    try {
      const entries = opendirSync(fdPath(fd, '.'), { encoding: 'buffer' })
      try {
        for (let d; (d = entries.readSync()) !== null;) {
          if (++scanned > 4096) throw unavailable()
          const name = d.isDirectory() && visibleName(d.name)
          if (!name) continue
          let item
          try { item = openChild(name) } catch { continue }
          close(item.sub)
          if (records.length >= 256) throw unavailable()
          records.push({ id: projectId(item.path, item.info), name, path: item.path, info: item.info })
        }
      } finally { entries.closeSync() }
      assertRoot()
    } catch { throw unavailable() }
    return records.sort((a, b) => a.name.localeCompare(b.name))
  }
  return Object.freeze({
    list: () => items().map(({ id, name }) => ({ id, name })),
    resolveRoot(id) {
      if (!validId(id)) return undefined
      return items().find(item => item.id === id)?.path
    },
    pinProject(id) {
      if (!validId(id)) throw unavailable()
      const record = items().find(item => item.id === id)
      if (!record) throw unavailable()
      let pinned, released = false
      function assertCurrent() {
        if (released) throw unavailable()
        assertRoot()
        let current
        try {
          current = openChild(record.name)
          if (!sameInode(pinned.info, current.info) || realpathSync.native(fdPath(pinned.sub)) !== record.path) throw unavailable()
        } catch { throw unavailable() } finally { close(current?.sub) }
      }
      try {
        pinned = openChild(record.name)
        if (!sameInode(record.info, pinned.info)) throw unavailable()
        assertCurrent()
        return Object.freeze({ fd: pinned.sub, mount: rootMount, assertCurrent, close() { if (!released) { released = true; close(pinned.sub) } } })
      } catch {
        close(pinned?.sub)
        throw unavailable()
      }
    },
    close() { if (!closed) { closed = true; close(fd) } }
  })
}
