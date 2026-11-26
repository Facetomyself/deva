import { absoluteTarget } from './wire.mjs'

const normalized = new WeakSet()
const MAX_SITES = 128
const badText = /[\u0000-\u001f\u007f-\u009f]/

function list(raw, label) {
  let value = raw
  if (typeof raw === 'string') {
    if (raw.length > 1024 * 1024) throw new TypeError(`Invalid ${label} list`)
    try { value = JSON.parse(raw) } catch { throw new TypeError(`Invalid ${label} JSON`) }
  }
  if (!Array.isArray(value) || value.length > MAX_SITES) throw new TypeError(`Invalid ${label} list`)
  return value
}

/** Deployment JSON: [{id: 'docs', label: 'Documentation', url: 'https://docs.example.com/start'}]. */
export function parseSites(raw) {
  if (typeof raw === 'object' && raw !== null && normalized.has(raw)) return raw
  const ids = new Set()
  const sites = Array.from(list(raw, 'site'), (row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== 3 ||
        !['id', 'label', 'url'].every((key) => Object.hasOwn(row, key))) throw new TypeError('Invalid site entry')
    const { id, label, url } = row
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id) || badText.test(id) || ids.has(id) ||
        typeof label !== 'string' || !label.trim() || label.length > 256 || badText.test(label) ||
        typeof url !== 'string' || url.length > 4096 || url.includes('?')) throw new TypeError('Invalid site entry')
    const target = absoluteTarget(url)
    if (!target) throw new TypeError('Invalid site start URL')
    ids.add(id)
    return Object.freeze({ id, label, url: new URL(url).href, origin: target.origin })
  })
  Object.freeze(sites)
  normalized.add(sites)
  return sites
}

export function sitePolicy(sites, privateOrigins) {
  const registered = new Set(parseSites(sites).map(({ origin }) => origin))
  const privateAllowed = new Set(Array.from(list(privateOrigins, 'private origin'), (value) => {
    const target = absoluteTarget(value)
    if (!target || target.path !== '/' || !registered.has(target.origin)) throw new TypeError('Expected a registered exact private origin')
    return target.origin
  }))
  // HTTP is only available as an explicit deployment-origin exception, never as a public default.
  for (const origin of registered) {
    if (origin.startsWith('http:') && !privateAllowed.has(origin)) throw new TypeError('HTTP origin requires an explicit private origin exception')
  }
  return { registered, privateAllowed }
}
