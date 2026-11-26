import { createHash } from 'node:crypto'
import { HttpError } from '../http/policy.mjs'

const groupPattern = /^d_[a-f0-9]{32}$/u
const digestPattern = /^[a-f0-9]{64}$/u
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const itemStatuses = new Set(['ready', 'missing', 'too-large', 'unsupported'])
const itemKinds = new Set(['text', 'image', 'document'])
const images = new Set(['image/png', 'image/jpeg', 'image/webp'])
const mimeTypes = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/pdf', ...images,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'])
const maxBytes = 8 * 1024 * 1024
const maxGroups = 40, maxProjectItems = 20
const hash = input => createHash('sha256').update(JSON.stringify(input)).digest('hex')
const exact = (value, re) => typeof value === 'string' && re.exec(value)?.[0] === value
const notFound = () => { throw new HttpError(404, 'delivery_not_found') }
const changed = () => { throw new HttpError(409, 'delivery_changed') }
const invalid = () => { throw new HttpError(400, 'invalid_delivery') }
const damaged = () => { throw new HttpError(503, 'delivery_unavailable') }
const safeIndex = n => Number.isSafeInteger(n) && n >= 0
const parsedMime = value => typeof value === 'string' ? value.split(';', 1)[0].toLowerCase() : ''

export function safeDeliveryName(name) {
  return typeof name === 'string' && name.isWellFormed() && name.length > 0 && Buffer.byteLength(name) <= 255 &&
    name.trim() === name && !name.startsWith('.') && !name.endsWith('.') &&
    !/[\\/:<>"|?*\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(name) && !/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\s*\.|$)/iu.test(name)
}
function bindRevision(sid, gid, index, base) {
  // Reply hashes are native SHA-256 digests, project file revisions are opaque r_ tags.
  // Neither is returned directly: the HTTP projection binds both to this session, group and item.
  if (!exact(base, digestPattern) && !exact(base, /^r_[a-f0-9]{64}$/u)) damaged()
  return hash(['deva:delivery-revision:v1', sid, gid, index, base])
}
function snapshotProof(sid, records) { return hash(['deva:delivery-page:v1', sid, records.map(r => r.id)]) }
function pageOffset(raw, max, proof) {
  if (raw === null) return 0
  if (!exact(raw, /^[a-zA-Z0-9_-]{1,160}$/u)) invalid()
  let value
  try {
    const bytes = Buffer.from(raw, 'base64url')
    if (bytes.toString('base64url') !== raw) invalid()
    value = JSON.parse(bytes.toString('utf8'))
  } catch { invalid() }
  if (!Array.isArray(value) || value.length !== 2 || !safeIndex(value[0]) || value[0] === 0 || !exact(value[1], digestPattern)) invalid()
  if (value[1] !== proof || value[0] >= max) throw new HttpError(409, 'deliveries_changed')
  return value[0]
}

/** Called only with records selected from the owner's confirmed native conversation. Absolute
 * desktop file names are kept on the host. The client sees a group ID and the ORIGINAL item index. */
export function createDeliveries({ turns, files }) {
  function source(sid) {
    const snap = turns.deliverySnapshot(sid)
    if (!Array.isArray(snap?.records) || !Array.isArray(snap.candidates) || snap.records.length > 1024 || snap.candidates.length > 256) damaged()
    return snap
  }
  async function descriptor(sid, record, entry) {
    const { id, origin } = record, { index } = entry
    if (!exact(id, groupPattern) || !safeIndex(index) || index > 19) damaged()
    const raw = origin === 'reply' ? {
      name: entry.name, size: entry.size, revision: entry.revision, kind: 'text', status: 'ready',
      canDownload: true, canPreview: false, canLocate: false
    } : origin === 'desktop' && files ? await files.inspect(entry.path) : null
    if (!raw || !safeDeliveryName(raw.name)) return null
    if (!itemKinds.has(raw.kind) || !itemStatuses.has(raw.status) || (raw.size !== null && !safeIndex(raw.size))) damaged()
    const ready = raw.status === 'ready'
    const revision = ready ? bindRevision(sid, id, index, raw.revision) : null
    const item = { index, name: raw.name, size: raw.size, status: raw.status, kind: raw.kind, revision,
      canDownload: ready && raw.canDownload === true, canPreview: ready && raw.kind === 'image' && raw.canPreview === true,
      canLocate: ready && origin === 'desktop' && raw.canLocate === true }
    return { item, base: raw.revision }
  }
  async function project(sid, record) {
    if (!Array.isArray(record.entries) || record.entries.length > 20 || !['reply','desktop'].includes(record.origin)) damaged()
    const items = []
    for (const entry of record.entries) {
      const found = await descriptor(sid, record, entry)
      if (found) items.push(found.item)
    }
    if (!items.length) return null
    return { id: record.id, origin: record.origin, ...(exact(record.turnId, uuid) ? { turnId: record.turnId } : {}),
      ...(safeIndex(record.messageIndex) ? { messageIndex: record.messageIndex } : {}), items }
  }
  async function list(sid, cursor) {
    const { records, candidates } = source(sid)
    const proof = snapshotProof(sid, records)
    let at = pageOffset(cursor, records.length, proof), inspected = 0, visited = 0
    const groups = []
    for (; at < records.length && visited < maxGroups; at++) {
      const rec = records[at]
      if (!exact(rec.id, groupPattern) || !Array.isArray(rec.entries) || rec.entries.length > 20) damaged()
      const cost = files && rec.origin === 'desktop' ? rec.entries.length : 0
      if (visited && inspected + cost > maxProjectItems) break
      inspected += cost; visited++
      const group = await project(sid, rec)
      if (group) groups.push(group)
    }
    return { groups, candidates: candidates.map(({ turnId, messageIndex }) => {
      if (!exact(turnId, uuid) || !safeIndex(messageIndex)) damaged()
      return { turnId, messageIndex }
    }), nextCursor: at < records.length ? Buffer.from(JSON.stringify([at, proof])).toString('base64url') : null }
  }
  async function publish(sid, body, authorize) {
    const result = await turns.exportReplyDelivery(sid, body, authorize)
    if (typeof result?.created !== 'boolean' || result.record?.origin !== 'reply') damaged()
    const group = await project(sid, result.record)
    if (!group || group.items.length !== 1) damaged()
    return { created: result.created, group }
  }
  async function resolveItem(sid, gid, index, revision, op) {
    if (!exact(gid, groupPattern) || !safeIndex(index) || index > 19 || !exact(revision, digestPattern)) invalid()
    const { records } = source(sid), record = records.find(r => r.id === gid)
    const entry = record?.entries.find(e => e.index === index)
    if (!entry) notFound()
    const desc = await descriptor(sid, record, entry)
    if (!desc || desc.item.status === 'missing') notFound()
    if (desc.item.status === 'too-large') throw new HttpError(413, 'delivery_too_large')
    if (desc.item.status !== 'ready') throw new HttpError(415, 'delivery_unsupported')
    if (desc.item.revision !== revision) changed()
    if (op === 'locate') {
      if (!desc.item.canLocate) throw new HttpError(415, 'delivery_no_location')
      const spot = await files.locate(entry.path, desc.base)
      if (!exact(spot?.workspaceId, /^w_[a-f0-9]{32}$/u) || typeof spot.path !== 'string' ||
          !spot.path.length || /[\\\p{Cc}]/u.test(spot.path) || spot.path.split('/').some(p => !p || p.startsWith('.'))) damaged()
      return { workspaceId: spot.workspaceId, path: spot.path }
    }
    if (!(op === 'preview' ? desc.item.canPreview : op === 'download' && desc.item.canDownload)) throw new HttpError(415, 'delivery_unsupported')
    const result = record.origin === 'reply' ? await turns.readReplyDelivery(sid, gid, index) : await files.read(entry.path, desc.base, op)
    if (!result) notFound()
    const mime = parsedMime(result.mime)
    if (record.origin === 'reply' && result.revision !== desc.base) changed()
    if (!mimeTypes.has(mime) || (op === 'preview' && !images.has(mime)) || !Buffer.isBuffer(result.bytes) ||
        result.bytes.length > maxBytes || result.bytes.length !== desc.item.size || result.name !== desc.item.name) damaged()
    return { bytes: result.bytes, name: desc.item.name, mime: mime.startsWith('text/') ? mime + '; charset=utf-8' : mime }
  }
  return Object.freeze({ list, publish, resolveItem })
}
