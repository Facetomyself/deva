import * as chatCore from '../../dist/chat-core.mjs'
import { HttpError } from '../http/policy.mjs'
import { blobPart, createTurnMedia, desktopBlob, digestBytes, mediaHash } from './turn-attachments-media.mjs'

export const ATTACHMENT_META = '_devaHeadlessTurnAttachments'
const MAX_FILES = 4
const MAX_TURN_BYTES = 20 * 1024 * 1024
const MAX_SESSION_BYTES = 48 * 1024 * 1024
const fileId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const validId = id => typeof id === 'string' && id.length === 36 && fileId.test(id)
const textPart = text => ({ type: 'text', text })
const unavailable = () => new HttpError(409, 'unsupported_history')
const storageUnconfirmed = () => new HttpError(503, 'chat_storage_unconfirmed')
const notFound = () => new HttpError(404, 'attachment_not_found')
const limit = code => new HttpError(413, code)
const invalid = code => new HttpError(422, code)

export function attachmentIds(value) {
  if (!Array.isArray(value) || value.length > MAX_FILES || Reflect.ownKeys(value).length !== value.length + 1) {
    throw new HttpError(400, 'invalid_attachments')
  }
  const ids = []
  for (let i = 0; i < value.length; i++) {
    const field = Object.getOwnPropertyDescriptor(value, String(i))
    if (!field?.enumerable || !validId(field.value) || ids.includes(field.value)) {
      throw new HttpError(400, 'invalid_attachments')
    }
    ids.push(field.value)
  }
  return ids
}

const fields = (obj, keys) => obj !== null && typeof obj === 'object' && Object.keys(obj).length === keys.length &&
  keys.every(key => Object.hasOwn(obj, key))
const isPlainText = part => fields(part, ['type', 'text']) && part.type === 'text' && typeof part.text === 'string'
const isQuestion = part => isPlainText(part) && !!part.text.trim()
const sameRef = (part, entry) => {
  const expected = blobPart(entry)
  const keys = Object.keys(expected)
  return fields(part, keys) && keys.every(key => part[key] === expected[key])
}
const sameEntry = (a, b) => ['id', 'name', 'kind', 'mime', 'size', 'blob', 'sha256'].every(key => a[key] === b[key])
const publicEntry = ({ id, name, kind, mime, size }) => ({ id, name, kind, mime, size })
const inputMeta = ({ name, mime, size }) => ({ name, mime, size })

// The side index is a private, strict whitelist: references only (including text uploads),
// bound positionally to native messages and the existing turn ledger.
function validateIndex(value, messages, requests) {
  if (!fields(value, ['version', 'rows']) || value.version !== 1 || !Array.isArray(value.rows) ||
      !value.rows.length || value.rows.length > requests.length) return null
  const byMessage = new Map(), byId = new Map()
  const rows = value.rows
  let total = 0, consumed = 0, userCount = 0, previousRole
  try {
    for (let at = 0; at < messages.length; at++) {
      const m = messages[at]
      if (!fields(m, ['role', 'content'])) return null
      const row = rows[consumed]
      const user = m.role === 'user'
      if (user) userCount++
      else if (previousRole !== 'user') return null
      previousRole = m.role
      if (!row || row.at !== at) {
        // Only the messages created by the strict text writer can be mixed with attached turns.
        if (!Array.isArray(m.content) || m.content.length !== 1 || !isPlainText(m.content[0])) return null
        continue
      }
      if (!user || !fields(row, ['at', 'turnId', 'only', 'items']) || typeof row.only !== 'boolean' ||
          requests[userCount - 1]?.turnId !== row.turnId || !Array.isArray(row.items) || !row.items.length ||
          row.items.length > MAX_FILES || !Array.isArray(m.content) || m.content.length !== row.items.length + 1 ||
          !isQuestion(m.content.at(-1)) || (row.only && m.content.at(-1).text !== chatCore.ATTACHMENTS_ONLY_QUESTION)) return null
      const inTurn = new Set()
      let turnBytes = 0
      for (const [i, entry] of row.items.entries()) {
        if (!fields(entry, ['id', 'name', 'kind', 'mime', 'size', 'blob', 'sha256']) || !validId(entry.id) ||
            inTurn.has(entry.id) || !mediaHash(entry.blob) || !mediaHash(entry.sha256) || !sameRef(m.content[i], entry)) return null
        chatCore.uploadedAttachmentSnapshot({ ...inputMeta(entry), kind: entry.kind })
        const prior = byId.get(entry.id)
        if (prior && !sameEntry(prior, entry)) return null
        inTurn.add(entry.id)
        byId.set(entry.id, entry)
        turnBytes += entry.size
      }
      if (turnBytes > MAX_TURN_BYTES || (total += turnBytes) > MAX_SESSION_BYTES) return null
      consumed++
      byMessage.set(at, row)
    }
  } catch { return null }
  if (consumed !== rows.length || userCount !== requests.length) return null
  return { rows, byMessage, byId, entries: [...byId.values()], total }
}

function buildPart(entry, bytes, adapter, persisted = false) {
  try {
    return chatCore.buildUploadedPart(inputMeta(entry), bytes, adapter)
  } catch (err) {
    switch (err?.code) {
      case 'attachment_adapter_unsupported': throw invalid(err.code)
      case 'attachment_too_large': throw limit(err.code)
      default:
        if (persisted) throw unavailable()
        throw invalid('invalid_attachment_content')
    }
  }
}

export function createTurnAttachments({ dataDir, uploads }) {
  if (typeof uploads?.read !== 'function') throw new TypeError('uploads must provide read(sid, id)')
  const media = createTurnMedia(dataDir)
  const indices = new WeakMap()

  function index(s, requests) {
    const existing = indices.get(s)
    if (existing?.value === s[ATTACHMENT_META] && existing.messages === s.messages && existing.requests === requests) return existing.index
    const parsed = validateIndex(s[ATTACHMENT_META], s.messages, requests)
    indices.set(s, { value: s[ATTACHMENT_META], messages: s.messages, requests, index: parsed })
    return parsed
  }

  function snapshot(m, row) {
    return { role: m.role, content: row.only ? '' : m.content.at(-1).text, attachments: row.items.map(publicEntry) }
  }

  async function readNew(sid, ids, adapter, previous) {
    let turnBytes = 0
    const added = []
    for (const id of ids) {
      let draft
      const committed = previous?.byId.get(id)
      if (committed) {
        // Explicitly reselecting an already-sent item is authorized by this session's ledger.
        // Its draft may have expired or been retired; never search other sessions or raw paths.
        try { draft = { meta: committed, bytes: media.read(committed) } } catch { throw unavailable() }
      } else {
        try { draft = await uploads.read(sid, id) }
        catch (err) { throw err?.code === 'UPLOAD_NOT_FOUND' ? notFound() : storageUnconfirmed() }
      }
      if (draft == null) throw notFound()
      const { meta, bytes } = draft
      if (meta?.id !== id || !mediaHash(meta.sha256) || !Number.isSafeInteger(meta.size) || meta.size <= 0 ||
          !(bytes instanceof Uint8Array) || bytes.byteLength !== meta.size) throw invalid('invalid_attachment_content')
      turnBytes += meta.size
      if (turnBytes > MAX_TURN_BYTES) throw limit('attachment_turn_limit')
      if ((previous?.total ?? 0) + turnBytes > MAX_SESSION_BYTES) throw limit('attachment_session_limit')
      const raw = Buffer.copyBytesFrom(bytes)
      if (digestBytes(raw) !== meta.sha256) throw invalid('invalid_attachment_content')
      const { display, part } = buildPart(meta, raw, adapter)
      if (display.kind !== meta.kind) throw invalid('invalid_attachment_content')
      const ref = desktopBlob(part, display.name, raw)
      const entry = { id, ...display, blob: ref.blob, sha256: meta.sha256 }
      const prior = previous?.byId.get(id)
      if (prior && !sameEntry(prior, entry)) throw invalid('invalid_attachment_content')
      added.push({ entry, part, ref, bytes: raw })
    }
    return added
  }

  function hydrate(s, previous, adapter) {
    if (!previous) return s.messages
    return s.messages.map((m, at) => {
      const row = previous.byMessage.get(at)
      if (!row) return m
      const parts = row.items.map(entry => {
        let bytes
        try { bytes = media.read(entry) } catch { throw unavailable() }
        const { part } = buildPart(entry, bytes, adapter, true)
        if (desktopBlob(part, entry.name, bytes).blob !== entry.blob) throw unavailable()
        return part
      })
      return { role: 'user', content: [...parts, m.content.at(-1)] }
    })
  }

  async function prepare(s, input, adapter, record, previous, requests) {
    const added = await readNew(s.id, input.attachments ?? [], adapter, previous)
    const historical = hydrate(s, previous, adapter)
    const only = !input.text.trim()
    const question = only ? chatCore.ATTACHMENTS_ONLY_QUESTION : input.text
    const native = textPart(question)
    const user = content => ({ role: 'user', content: [...content, native] })
    const messages = [...s.messages, user(added.map(a => a.ref))]
    const modelContext = [...historical, user(added.map(a => a.part))]
    if (!added.length) return { messages, modelContext, question, patch: {} }
    const items = added.map(a => a.entry)
    const rows = [...(previous?.rows ?? []), { at: s.messages.length, turnId: record.turnId, only, items }]
    const pending = { version: 1, rows }
    if (!validateIndex(pending, messages, requests)) throw unavailable()
    return {
      messages, modelContext, question, patch: { [ATTACHMENT_META]: pending },
      persist() {
        try { for (const { entry, bytes } of added) media.write(entry, bytes) }
        catch { throw storageUnconfirmed() }
      }
    }
  }

  function preview(ownIndex, id) {
    if (!validId(id)) return null
    const entry = ownIndex?.byId.get(id)
    if (!entry) return null
    try { return { meta: { ...publicEntry(entry), sha256: entry.sha256 }, bytes: media.read(entry) } }
    catch { return null }
  }

  return { index, prepare, snapshot, preview, available: idx => media.available(idx.entries), canStage: idx => !idx || idx.total < MAX_SESSION_BYTES }
}
