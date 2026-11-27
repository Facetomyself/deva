import type { ContextUsage } from '../shared/chat-protocol'
import type { ChatCursor } from './chat-transport'
import type { Bootstrap, Transport } from './transport'

export type ReadEntry = { id: string; updatedAt: number; readAt: number | null; unread: boolean }
export type ReadObservation = Pick<ReadEntry, 'id' | 'updatedAt'> & { cursor: ChatCursor }
export type ContextSource = 'none' | 'estimate' | 'measured' | 'live' | 'unavailable'
export type ContextReport = { modelRef: string | null; usage: ContextUsage | null; source: ContextSource; compaction: 'inactive' }

type Wire = Record<string, unknown>
function exact(value: unknown, ...keys: string[]): value is Wire {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.exec(value)?.[0] === value
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const uuidV4 = (value: unknown): value is string => typeof value === 'string' && value.length === 36 &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
const modelBytes = new TextEncoder()
const reservedProviders = new Set(['__proto__', 'constructor', 'prototype'])
const maxWindow = 20_000_000
const maxReadEntries = 8192

export function fullModelRef(value: unknown): value is string {
  // Match the server's context model grammar; /u treats paired surrogates as one code point.
  if (typeof value !== 'string' || value.length > 609 || value !== value.trim() || /[\x00-\x1f\x7f\ud800-\udfff]/u.test(value)) return false
  const colon = value.indexOf(':')
  const provider = value.slice(0, colon)
  const model = value.slice(colon + 1)
  return colon > 0 && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/u.test(provider) && !reservedProviders.has(provider) &&
    !!model && model === model.trim() && modelBytes.encode(model).length <= 512
}
function readEntry(value: Wire): value is Wire & ReadEntry {
  return validId(value.id) && timestamp(value.updatedAt) && (value.readAt === null || timestamp(value.readAt)) && typeof value.unread === 'boolean'
}
function chatPath(id: string): string {
  if (!validId(id)) throw new Error('Invalid conversation status scope')
  return `/chats/${id}`
}
function contextReport(value: unknown, model: string | null): value is ContextReport {
  if (!exact(value, 'modelRef', 'usage', 'source', 'compaction') || value.compaction !== 'inactive') return false
  const { modelRef, usage, source } = value
  if (source === 'unavailable') return modelRef === null && usage === null
  if (!fullModelRef(modelRef) || (model !== null && model !== modelRef) ||
    !exact(usage, 'used', 'estimated', 'window', 'trigger') || !timestamp(usage.window) || usage.window === 0 ||
    usage.window > maxWindow || usage.trigger !== null) return false
  if (source === 'none') return usage.used === null && usage.estimated === false
  if (!timestamp(usage.used)) return false
  return source === 'estimate' ? usage.estimated === true :
    (source === 'measured' || source === 'live') && usage.used > 0 && usage.estimated === false
}

export function createConversationStatusTransport(transport: Transport, bootstrap: Bootstrap) {
  if (bootstrap.capabilities?.conversationStatus !== true || !bootstrap.csrf) return undefined
  const { csrf } = bootstrap
  const post = (path: string, body: object, signal: AbortSignal) =>
    transport.request(path, 'POST', body, csrf, { signal, referrerPolicy: 'same-origin' })
  return {
    async reads(signal: AbortSignal): Promise<ReadonlyMap<string, ReadEntry>> {
      const result = await transport.request('/conversation-status/reads', 'GET', undefined, undefined, { signal })
      if (!exact(result, 'entries') || !Array.isArray(result.entries) || result.entries.length > maxReadEntries) {
        throw new Error('Invalid conversation read map')
      }
      const entries = new Map<string, ReadEntry>()
      for (const row of result.entries) {
        if (!exact(row, 'id', 'updatedAt', 'readAt', 'unread') || !readEntry(row) || entries.has(row.id) ||
          row.unread !== (row.readAt === null || row.readAt < row.updatedAt)) {
          throw new Error('Invalid conversation read entry')
        }
        entries.set(row.id, row)
      }
      return entries
    },
    async mark({ id, updatedAt, cursor }: ReadObservation, signal: AbortSignal): Promise<ReadEntry & { changed: boolean }> {
      const path = chatPath(id)
      const { scope, epoch, generation, seq } = cursor
      if (!timestamp(updatedAt) || scope !== `chat:${id}` || !uuidV4(epoch) || !uuidV4(generation) || !timestamp(seq)) {
        throw new Error('Invalid conversation read observation')
      }
      const result = await post(`${path}/read-state`, { updatedAt, cursor: { scope, epoch, generation, seq } }, signal)
      if (!exact(result, 'id', 'updatedAt', 'readAt', 'unread', 'changed') || !readEntry(result) || result.id !== id ||
        result.updatedAt !== updatedAt || result.unread !== false || typeof result.changed !== 'boolean' ||
        (result.changed ? result.readAt !== updatedAt : (result.readAt !== null && result.readAt < updatedAt))) {
        throw new Error('Invalid conversation read acknowledgement')
      }
      return { id, updatedAt, readAt: result.readAt, unread: false, changed: result.changed }
    },
    async usage(id: string, model: string | null, signal: AbortSignal): Promise<ContextReport> {
      if (model !== null && !fullModelRef(model)) throw new Error('Invalid context model reference')
      const result = await post(`${chatPath(id)}/context-usage`, { model }, signal)
      if (!contextReport(result, model)) throw new Error('Invalid conversation context report')
      return result
    }
  }
}

export type ConversationStatusTransport = NonNullable<ReturnType<typeof createConversationStatusTransport>>
