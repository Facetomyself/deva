import { createHash } from 'node:crypto'
import { openSync, opendirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DIRECTORY, close, fdPath, mountId, openAbsoluteDirectory, sameInode, stat, validWorkspaceName, visibleName, workspacePathParts } from '../files/workspace-files-fd.mjs'

const deliverySystemRoots = ['/boot', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/var/log', '/var/cache', '/var/spool', '/var/backups']
const privateDeliveryName = /^(?:credentials?|secrets?|private[-_ ]?keys?|api[-_ ]?keys?|(?:access[-_ ]?|refresh[-_ ]?)tokens?|id[-_](?:rsa|dsa|ecdsa|ed25519)|known_hosts|authorized_keys|passwd|shadow)(?:[._ -]|$)|\.(?:pem|key|p12|pfx|kdbx)(?:\.|$)/iu
const hiddenDeliveryName = name => privateDeliveryName.test(name) || /[\p{Cf}\p{Zl}\p{Zp}]/u.test(name)

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
  if (root == null || root === '') return Object.freeze({
    list: () => [], resolveRoot: () => undefined, resolveDeliveryPath: () => null,
    pinProject() { throw unavailable() }, close() {},
  })
  if (typeof root !== 'string' || !isAbsolute(root) || root.includes('\0')) throw unavailable()
  const base = resolve(root)
  const reserved = [...privateRoots, '/proc', '/dev', '/sys', '/etc', '/run', '/root']
  if (base === '/' || reserved.some(path => overlapsReserved(base, path))) throw unavailable()
  // Apply the extra system-directory exclusion to native deliveries only. Workspace browsing
  // and project identifiers keep their existing contract.
  const deliveryEnabled = !deliverySystemRoots.some(path => overlapsReserved(base, path))
  const deliveryPrefix = base + sep
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
    // Server-read native history only. No absolute path is opened here: derive the
    // catalog ID from an actual direct child. The caller must still pin that ID and
    // verify every intermediate directory and leaf before claiming the item.
    resolveDeliveryPath(absolute) {
      if (!deliveryEnabled || typeof absolute !== 'string' || absolute.length > 4095 ||
          !absolute.startsWith(deliveryPrefix) || Buffer.byteLength(absolute) > 4095) return null
      const split = absolute.indexOf(sep, deliveryPrefix.length)
      if (split < 0) return null
      const name = absolute.slice(deliveryPrefix.length, split)
      const path = absolute.slice(split + 1)
      const parts = workspacePathParts(path)
      if (!validWorkspaceName(name) || hiddenDeliveryName(name) || !parts || parts.some(hiddenDeliveryName)) return null
      let item
      try {
        assertRoot()
        item = openChild(name)
        assertRoot()
        return { id: projectId(item.path, item.info), path }
      } catch { return null } finally { close(item?.sub) }
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
