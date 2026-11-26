import { createHash } from 'node:crypto'
import { posix, win32 } from 'node:path'
import { deliveryLimitError, deliveryStorageError, parseNativeJSON } from './delivery-records-storage.mjs'

const maxMessages = 4096
const maxParts = 16384
const maxDesktopGroups = 256
const maxPaths = 20 // Original desktop present_files limit.
const maxReply = 64 * 1024 // UTF-16 units, same as the text turn writer.
const maxQuestion = 12 * 1024
const TURN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
export const validDeliveryTurn = value => typeof value === 'string' && value.length === 36 && TURN_ID.test(value)
const desktopId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 &&
  !/[\u0000-\u0020\u007f-\u009f]/u.test(value) && value.isWellFormed()
export const fields = (obj, keys) => object(obj) && Object.keys(obj).length === keys.length && keys.every(key => Object.hasOwn(obj, key))
export const object = obj => obj !== null && typeof obj === 'object' && !Array.isArray(obj)
export const digest = value => createHash('sha256').update(value).digest('hex')
export const groupId = (sid, origin, ...identity) => `d_${digest(JSON.stringify(['deva-delivery-v1', sid, origin, ...identity])).slice(0, 32)}`

const textPart = value => fields(value, ['type', 'text']) && value.type === 'text' && typeof value.text === 'string'
const oneText = message => Array.isArray(message.content) && message.content.length === 1 && textPart(message.content[0])
  ? message.content[0].text : null

function notice(after, { status, reason }, text) {
  if (status === 'failed') return { after, kind: 'error', message: '模型回复未能完成。' }
  const code = status === 'aborted' || status === 'interrupted' ? 'aborted'
    : reason === 'refusal' ? (text?.trim() ? null : 'refused')
      : ['empty', 'truncated', 'repeated'].includes(reason) ? reason : null
  return code ? { after, kind: 'notice', code } : null
}

/** One native user message and at most one native assistant message per receipt,
 * in admission order. Require this correspondence across the entire ledger, not
 * merely a nearby assistant message after a matching turn ID. */
export function webReplies(session, ledger, attachmentIndex) {
  if (!fields(ledger, ['version', 'messageCount', 'requests'])) return null
  const replies = new Map()
  let cursor = 0
  let notices = 0
  for (const [ordinal, row] of ledger.requests.entries()) {
    const keys = ['clientRequestId', 'fingerprint', 'turnId', 'startedAt', 'status', 'reason']
    if (Object.hasOwn(row, 'model')) {
      if (typeof row.model !== 'string' || row.model.length > 512) return null
      keys.push('model')
    }
    if (!fields(row, keys) || !validDeliveryTurn(row.turnId)) return null
    const user = session.messages[cursor]
    if (!fields(user, ['role', 'content']) || user.role !== 'user') return null
    if (!attachmentIndex?.byMessage.has(cursor)) {
      const text = oneText(user)
      if (!text || text.length > maxQuestion || !text.trim() || Buffer.byteLength(text) > maxQuestion) return null
    }
    cursor++
    const messageIndex = cursor
    let text = null
    const assistant = session.messages[cursor]
    if (assistant?.role === 'assistant') {
      if (!fields(assistant, ['role', 'content'])) return null
      text = oneText(assistant)
      if (text === null || !text.length || text.length > maxReply || ['running', 'interrupted'].includes(row.status)) return null
      cursor++
    }
    if (row.status === 'completed' && row.reason === null) {
      if (!text?.trim()) return null
      // Lone surrogates have no exact UTF-8 encoding. Keep the native reply visible, but not exportable.
      if (text.isWellFormed()) replies.set(row.turnId, { turnId: row.turnId, messageIndex, ordinal, text })
    } else if (row.reason === 'empty' && text?.trim()) return null
    const expected = notice(cursor, row, text)
    if (expected) {
      const recorded = session.notices?.[notices++]
      const names = Object.keys(expected)
      if (!fields(recorded, names) || !names.every(key => recorded[key] === expected[key])) return null
    }
  }
  return cursor === session.messages.length && notices === (session.notices?.length ?? 0) ? replies : null
}

function validateMessages(messages) {
  return Array.isArray(messages) && messages.length <= maxMessages && messages.every(m =>
    object(m) && ['assistant', 'user'].includes(m.role) && (typeof m.content === 'string' || Array.isArray(m.content)))
}

export function nativeMessages(files, sid, session) {
  if (session.messages?.length > maxMessages) throw deliveryLimitError()
  if (!validateMessages(session.messages)) throw deliveryStorageError()
  const compacted = session.compacted
  if (compacted === undefined) return session.messages
  const prefix = `${sid}.compacted-`
  if (!fields(compacted, ['count', 'file']) || !Number.isSafeInteger(compacted.count) || compacted.count < 1 ||
      typeof compacted.file !== 'string' || !compacted.file.startsWith(prefix) ||
      !/^[A-Za-z0-9_-]{1,128}\.jsonl$/u.test(compacted.file.slice(prefix.length)) || !compacted.file.endsWith('.jsonl')) {
    throw deliveryStorageError()
  }
  if (compacted.count + session.messages.length > maxMessages) throw deliveryLimitError()
  const text = files.readCompacted(compacted.file)
  if (text === null) throw deliveryStorageError()
  let start = 0
  const messages = []
  // An interrupted desktop append may leave extra lines; the main file commits only `count`.
  for (let lines = 0; messages.length < compacted.count && start < text.length; lines++) {
    if (lines >= maxMessages) throw deliveryLimitError()
    const newline = text.indexOf('\n', start)
    const end = newline < 0 ? text.length : newline
    if (end !== start) messages.push(parseNativeJSON(text.slice(start, end)))
    start = end + 1
  }
  if (messages.length !== compacted.count || !validateMessages(messages)) throw deliveryStorageError()
  return [...messages, ...session.messages]
}

function validatedPaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > maxPaths) return null
  const unique = new Set()
  for (const p of paths) {
    if (typeof p !== 'string' || !p.length || p.length > 4096 || Buffer.byteLength(p) > 4096 ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(p) || !p.isWellFormed()) return null
    const absolutePosix = p.startsWith('/') && p.length > 1 && !p.endsWith('/') && posix.normalize(p) === p
    const absoluteWindows = /^(?:[A-Za-z]:\\|\\\\[^.\\?][^\\]*\\[^\\]+\\)/u.test(p) && !p.endsWith('\\') && win32.normalize(p) === p
    if (!absolutePosix && !absoluteWindows) return null
    const identity = absoluteWindows ? p.toLowerCase() : p
    if (unique.has(identity)) return null
    unique.add(identity)
  }
  return paths.map((path, index) => ({ index, path }))
}

export function desktopDeliveryRecords(sid, messages, delivered) {
  if (!object(delivered)) return []
  if (Object.keys(delivered).length > maxParts) throw deliveryLimitError()
  const uses = new Map()
  const results = new Map()
  const deliveries = []
  let count = 0
  const unique = (map, id, value) => map.set(id, map.has(id) ? null : value)
  for (const [at, message] of messages.entries()) {
    const content = message.content
    if (!Array.isArray(content)) continue
    if ((count += content.length) > maxParts) throw deliveryLimitError()
    for (const part of content) {
      if (!object(part) || typeof part.type !== 'string') throw deliveryStorageError()
      if (part.type === 'tool_use' && desktopId(part.id)) {
        unique(uses, part.id, at)
        if (message.role === 'assistant' && part.name === 'present_files') deliveries.push({ id: part.id, at })
      } else if (part.type === 'tool_result' && desktopId(part.toolUseId)) {
        unique(results, part.toolUseId, { at, part })
      }
    }
  }
  const records = []
  const completeBatches = new Map()
  function completeBatch(at) {
    if (completeBatches.has(at)) return completeBatches.get(at)
    const next = messages[at + 1]
    const calls = messages[at].content.filter(p => p.type === 'tool_use')
    const complete = next?.role === 'user' && Array.isArray(next.content) && next.content.length === calls.length &&
      next.content.every(p => p.type === 'tool_result') && calls.every(call =>
        uses.get(call.id) === at && results.get(call.id)?.at === at + 1)
    completeBatches.set(at, complete)
    return complete
  }
  // Newest first; keep the exact native order of the files within each group.
  for (const { id, at } of deliveries.reverse()) {
    const result = results.get(id)
    if (uses.get(id) !== at || result?.at !== at + 1 || !completeBatch(at) ||
        (result.part.isError !== undefined && result.part.isError !== false) ||
        typeof result.part.content !== 'string' || !result.part.content.trim() || !Object.hasOwn(delivered, id)) continue
    const entries = validatedPaths(delivered[id])
    if (!entries) continue
    if (records.length >= maxDesktopGroups) throw deliveryLimitError()
    records.push({ id: groupId(sid, 'desktop', id), origin: 'desktop', messageIndex: at, entries })
  }
  return records
}
