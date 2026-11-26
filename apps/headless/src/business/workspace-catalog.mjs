import { createHash } from 'node:crypto'
import { closeSync, constants as C, fstatSync, lstatSync, openSync, opendirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const flags = C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW | C.O_NONBLOCK
const unavailable = () => Object.assign(Error('Workspace is unavailable'), { code: 'ERR_WORKSPACE_UNAVAILABLE' })
const child = (fd, name) => `/proc/self/fd/${fd}/${name}`
function inside(outer, path) { const r = relative(outer, path); return r === '' || (!isAbsolute(r) && r !== '..' && !r.startsWith(`..${sep}`)) }
function canonicalDir(path) {
  const real = realpathSync.native(path)
  if (real !== path || !lstatSync(real).isDirectory()) throw unavailable()
  return real
}

/** Only first-level, real directories of an explicitly mounted workspace root are choices. IDs
 * refer to a directory identity, not to arbitrary server paths supplied by a browser. Consumers
 * that access *files* must anchor their own walks to a directory fd; resolveRoot is only a scope
 * resolver for memory's canonical project-key calculation. */
export function openWorkspaceCatalog({ root, privateRoots = [] }) {
  if (root == null || root === '') return Object.freeze({ list: () => [], resolveRoot: () => undefined, close() {} })
  if (typeof root !== 'string' || !isAbsolute(root) || root.includes('\0')) throw unavailable()
  const base = resolve(root)
  const reserved = [...privateRoots, '/proc', '/dev', '/sys', '/etc', '/run', '/root']
  if (base === '/' || reserved.some(p => p && (inside(resolve(p), base) || inside(base, resolve(p))))) throw unavailable()
  const real = canonicalDir(base)
  const fd = openSync(base, flags)
  const rootInfo = fstatSync(fd, { bigint: true })
  let closed = false
  function items() {
    if (closed) throw unavailable()
    const current = lstatSync(base, { bigint: true })
    if (canonicalDir(base) !== real || current.dev !== rootInfo.dev || current.ino !== rootInfo.ino) throw unavailable()
    const records = []
    // Avoid allocating all entries of a mistakenly broad mount. Do not grant a partial catalog.
    let scanned = 0
    const entries = opendirSync(child(fd, '.'))
    try {
      for (let d; (d = entries.readSync()) !== null;) {
        if (++scanned > 4096) throw unavailable()
        if (!d.isDirectory() || d.name.startsWith('.') || /[\u0000-\u001f\u007f/\\]/.test(d.name) || Buffer.byteLength(d.name) > 255) continue
        let sub
        try { sub = openSync(child(fd, d.name), flags) } catch { continue }
        try {
          const info = fstatSync(sub, { bigint: true }); const path = join(base, d.name)
          if (realpathSync.native(`/proc/self/fd/${sub}`) !== path) continue
          if (records.length >= 256) throw unavailable()
          const id = 'w_' + createHash('sha256').update(JSON.stringify([path, String(info.dev), String(info.ino)])).digest('hex').slice(0, 32)
          records.push({ id, name: d.name, path })
        } finally { closeSync(sub) }
      }
    } finally { entries.closeSync() }
    return records.sort((a, b) => a.name.localeCompare(b.name))
  }
  return Object.freeze({
    list: () => items().map(({ id, name }) => ({ id, name })),
    resolveRoot(id) {
      if (typeof id !== 'string' || !/^w_[a-f0-9]{32}$/.test(id)) return undefined
      return items().find(item => item.id === id)?.path
    },
    close() { if (!closed) { closed = true; closeSync(fd) } }
  })
}
