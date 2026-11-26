import { isDeepStrictEqual } from 'node:util'
import { HttpError } from '../http/policy.mjs'
import { desktopDeliveryRecords, digest, fields, groupId, nativeMessages, object, validDeliveryTurn, webReplies } from './delivery-records-native.mjs'
import { deliveryStorageError, parseNativeJSON, withDeliveryFiles } from './delivery-records-storage.mjs'

const formats = new Map([['md', 'text/markdown; charset=utf-8'], ['txt', 'text/plain; charset=utf-8']])
const missing = () => new HttpError(404, 'session_not_found')
const ineligible = () => new HttpError(404, 'reply_not_exportable')
const invalidExport = () => new HttpError(400, 'invalid_delivery_export')
const validGroupId = value => typeof value === 'string' && value.length === 34 && /^d_[0-9a-f]{32}$/u.test(value)
const revision = value => typeof value === 'string' && value.length === 64 && /^[0-9a-f]{64}$/u.test(value)
const time = value => Number.isFinite(value) && value >= 0
const emptyIndex = () => ({ version: 1, rows: [] })

function exportInput(raw, validSid) {
  if (!raw || ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) || Reflect.ownKeys(raw).length !== 2) throw invalidExport()
  const turn = Object.getOwnPropertyDescriptor(raw, 'turnId')
  const format = Object.getOwnPropertyDescriptor(raw, 'format')
  if (!turn?.enumerable || !format?.enumerable || !validSid(turn.value) || !formats.has(format.value)) throw invalidExport()
  return { turnId: turn.value, format: format.value }
}

function metadata(text, sid) {
  if (text === null) return emptyIndex()
  const index = parseNativeJSON(text)
  // Atomic writer emits one canonical JSON representation. Reject duplicate keys,
  // extra fields, oversized arrays, and IDs from a different session.
  if (!fields(index, ['version', 'rows']) || index.version !== 1 || !Array.isArray(index.rows) || index.rows.length > 512 ||
      text !== JSON.stringify(index)) throw deliveryStorageError()
  const ids = new Set()
  for (const row of index.rows) {
    if (!fields(row, ['id', 'turnId', 'format', 'messageIndex', 'revision']) || !validDeliveryTurn(row.turnId) || !formats.has(row.format) ||
        !Number.isSafeInteger(row.messageIndex) || row.messageIndex < 1 || row.messageIndex > 511 || !revision(row.revision) ||
        row.id !== groupId(sid, 'reply', row.turnId, row.format) || ids.has(row.id)) throw deliveryStorageError()
    ids.add(row.id)
  }
  return index
}

function replyRecord(row, reply) {
  return {
    id: row.id, origin: 'reply', turnId: row.turnId, messageIndex: reply.messageIndex, entries: [{
      index: 0, name: `reply-${String(reply.ordinal + 1).padStart(3, '0')}.${row.format}`, size: Buffer.byteLength(reply.text),
      revision: row.revision, mime: formats.get(row.format)
    }]
  }
}

function checkRows(index, replies) {
  const records = []
  const stale = new Set()
  const verified = new Map()
  for (const [at, row] of index.rows.entries()) {
    const reply = replies.get(row.turnId)
    if (!reply || reply.messageIndex !== row.messageIndex || (reply.revision ??= digest(reply.text)) !== row.revision) {
      stale.add(row.turnId)
      continue
    }
    records.push({ row, reply, at })
  }
  records.sort((a, b) => b.row.messageIndex - a.row.messageIndex || b.at - a.at)
  for (const { row, reply } of records) {
    if (!stale.has(row.turnId)) verified.set(row.id, replyRecord(row, reply))
  }
  return { verified, stale }
}

/** Dedicated synchronous delivery domain; ordinary chat snapshots and events are unchanged.
 * The native writer lock is already held by the caller (the workbench owner). */
export function createDeliveryRecords({ dataDir, validSid, ledgerKey, active, closing, blocked, cached, classify, attachedIndex, hasMedia }) {
  const ambiguous = new Set()

  function view(sid, use) {
    if (!validSid(sid)) throw new HttpError(400, 'invalid_session_id')
    if (closing()) throw new HttpError(503, 'chat_closed')
    if (blocked(sid) || ambiguous.has(sid)) throw deliveryStorageError()
    try {
      return withDeliveryFiles(dataDir, sid, files => {
        const source = files?.readMain()
        const expected = cached(sid)
        if (!source) throw expected ? deliveryStorageError() : missing()
        const session = source.value
        if (!object(session) || session.id !== sid || typeof session.title !== 'string' ||
            !time(session.createdAt) || !time(session.updatedAt)) throw deliveryStorageError()
        // Desktop cache hydration may include a compacted prefix. Its read-only projection
        // deliberately ignores that cache; Web writers must match the confirmed native file.
        if (expected && !isDeepStrictEqual(session, Object.fromEntries(Object.entries(expected).filter(([, value]) => value !== undefined)))) {
          throw deliveryStorageError()
        }
        const messages = nativeMessages(files, sid, session)
        if (!Object.hasOwn(session, ledgerKey)) {
          const ownsDeliveries = Object.hasOwn(session, 'delivered')
          const records = ownsDeliveries ? desktopDeliveryRecords(sid, messages, session.delivered) : []
          const kind = ownsDeliveries || session.compacted !== undefined || classify(session) !== 'legacy_text'
            ? 'unsupported_history' : 'read_only_session'
          return use({ records, kind })
        }
        const unsupported = () => use({ records: [], kind: 'unsupported_history' })
        if (!source.privateMode) throw deliveryStorageError()
        if (session.compacted !== undefined || classify(session) !== 'text' || !hasMedia(expected ?? session, session)) return unsupported()
        const replies = webReplies(session, session[ledgerKey], attachedIndex(session))
        if (!replies) return unsupported()
        const index = metadata(files.readMetadata(), sid)
        return use({ files, replies, index, ...checkRows(index, replies) })
      })
    } catch (error) {
      if (error instanceof HttpError) throw error
      throw deliveryStorageError()
    }
  }

  function deliverySnapshot(sid) {
    return view(sid, ({ records, replies, verified, stale }) => ({
      records: records ?? [...verified.values()],
      candidates: replies && !active(sid) ? [...replies.values()].reverse().filter(reply => !stale.has(reply.turnId))
        .map(({ turnId, messageIndex }) => ({ turnId, messageIndex })) : []
    }))
  }

  function listDeliveryRecords(sid) { return deliverySnapshot(sid).records }

  function exportReplyDelivery(sid, raw, verifyOwner) {
    if (!validSid(sid)) throw new HttpError(400, 'invalid_session_id')
    const { turnId, format } = exportInput(raw, validSid)
    // This callback can reenter application code. Check writer state only after it returns.
    if (verifyOwner !== undefined) {
      const verified = verifyOwner(sid)
      if (verified === false || typeof verified?.then === 'function') throw new HttpError(401, 'unauthorized')
    }
    if (active(sid)) throw new HttpError(409, 'turn_in_progress')
    let writing = false
    try {
      return view(sid, ({ files, replies, index, verified, stale, kind }) => {
        if (!replies) throw new HttpError(409, kind)
        if (stale.size) throw deliveryStorageError()
        const reply = replies.get(turnId)
        if (!reply) throw ineligible()
        const id = groupId(sid, 'reply', turnId, format)
        const prior = verified.get(id)
        if (prior) {
          if (prior.turnId !== turnId || !prior.entries[0].name.endsWith(`.${format}`)) throw deliveryStorageError()
          return { created: false, record: prior }
        }
        if (index.rows.length >= 512) throw deliveryStorageError()
        const row = { id, turnId, format, messageIndex: reply.messageIndex, revision: reply.revision ?? digest(reply.text) }
        writing = true
        files.saveMetadata(JSON.stringify({ ...index, rows: [...index.rows, row] }))
        return { created: true, record: replyRecord(row, reply) }
      })
    } catch (error) {
      if (writing) ambiguous.add(sid)
      throw error
    }
  }

  function readReplyDelivery(sid, id, index) {
    if (!validSid(sid) || !validGroupId(id) || index !== 0) return null
    try {
      return view(sid, ({ replies, verified }) => {
        const record = verified?.get(id)
        if (!record) return null
        const { name, revision, mime } = record.entries[0]
        return { name, bytes: Buffer.from(replies.get(record.turnId).text, 'utf8'), revision, mime }
      })
    } catch (error) {
      if (error instanceof HttpError && [404, 413, 503].includes(error.status)) return null
      throw error
    }
  }

  return { deliverySnapshot, listDeliveryRecords, exportReplyDelivery, readReplyDelivery }
}
