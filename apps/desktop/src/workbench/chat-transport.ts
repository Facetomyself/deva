import type { Transport } from './transport'

type Dictionary = Record<string, unknown>
const record = (x: unknown): x is Dictionary => typeof x === 'object' && x !== null && !Array.isArray(x)
const nullableString = (x: unknown): x is string | null => x === null || typeof x === 'string'
const time = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0
const id = (x: unknown): x is string => typeof x === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(x)

export const MAX_TEXT_INPUT = 12 * 1024
export const inputBytes = (text: string): number => new TextEncoder().encode(text.trim()).byteLength

export interface ChatSummary {
  id: string
  title: string
  updatedAt: number
  model: string | null
  compatibility: 'text' | 'legacy_text' | 'unsupported'
  writable: boolean
}
export interface ChatTurn {
  turnId: string
  startedAt: number
  status: string
  reason: string | null
}
export interface ChatState extends Omit<ChatSummary, 'updatedAt'> {
  updatedAt?: number
  writeBlockReason: string | null
  turnLimit: number | null
  messages: { role: 'user' | 'assistant'; content: string }[] | null
  active: { text: string; turnId: string; startedAt: number } | null
  lastTurn: ChatTurn | null
}
export interface ChatCursor { epoch: string; scope: string; seq: number; generation: string }
export interface ChatSnapshot { cursor: ChatCursor; state: ChatState }
export type ChatFrame = ({ t: 'snapshot' } & ChatSnapshot) | {
  t: 'event'; cursor: ChatCursor; sessionId: string; turnId: string; type: 'chat'; event: { type: string; text?: string }
}
export interface TurnRequest { clientRequestId: string; text: string; model: string }

function summary(value: unknown): value is Omit<ChatSummary, 'updatedAt'> {
  return record(value) && id(value.id) && typeof value.title === 'string' && nullableString(value.model) &&
    (value.compatibility === 'text' || value.compatibility === 'legacy_text' || value.compatibility === 'unsupported') &&
    typeof value.writable === 'boolean'
}
function listEntry(value: unknown): value is ChatSummary {
  return record(value) && time(value.updatedAt) && summary(value)
}
function turn(value: unknown): value is ChatTurn {
  return record(value) && id(value.turnId) && time(value.startedAt) && typeof value.status === 'string' && nullableString(value.reason)
}
function state(value: unknown): value is ChatState {
  if (!record(value)) return false
  const { updatedAt, writeBlockReason, turnLimit, messages, active, lastTurn } = value
  return summary(value) && (updatedAt === undefined || time(updatedAt)) && nullableString(writeBlockReason) &&
    (turnLimit === null || (typeof turnLimit === 'number' && Number.isSafeInteger(turnLimit) && turnLimit > 0)) &&
    (messages === null || (Array.isArray(messages) && messages.every((m) => record(m) &&
      (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'))) &&
    (active === null || (record(active) && id(active.turnId) && time(active.startedAt) && typeof active.text === 'string')) &&
    (lastTurn === null || turn(lastTurn))
}
function cursor(value: unknown, sid: string): value is ChatCursor {
  return record(value) && typeof value.epoch === 'string' && typeof value.generation === 'string' &&
    value.scope === `chat:${sid}` && typeof value.seq === 'number' && Number.isSafeInteger(value.seq) && value.seq >= 0
}
function snapshot(value: unknown, sid: string): value is ChatSnapshot {
  return record(value) && cursor(value.cursor, sid) && state(value.state) && value.state.id === sid
}
export function parseChatFrame(data: unknown, sid: string): ChatFrame | null {
  if (typeof data !== 'string') return null
  try {
    const value: unknown = JSON.parse(data)
    if (!record(value)) return null
    if (value.t === 'snapshot' && snapshot(value, sid)) return { t: 'snapshot', cursor: value.cursor, state: value.state }
    if (value.t === 'event' && value.type === 'chat' && value.sessionId === sid && typeof value.turnId === 'string' &&
        cursor(value.cursor, sid) && record(value.event) && typeof value.event.type === 'string') {
      const { type, text } = value.event
      if (type === 'text_delta' && typeof text !== 'string') return null
      return { t: 'event', type: 'chat', cursor: value.cursor, sessionId: sid, turnId: value.turnId,
        event: { type, ...(typeof text === 'string' ? { text } : {}) } }
    }
  } catch { /* The next authoritative snapshot replaces a malformed stream. */ }
  return null
}

function path(sid: string): string {
  if (!id(sid)) throw new Error('Invalid chat id')
  return `/chats/${sid}`
}

export function chatStreamUrl(origin: string, sid: string, applied?: ChatCursor): string {
  const url = new URL(`/api/v1${path(sid)}/stream`, origin)
  if (url.protocol === 'https:') url.protocol = 'wss:'
  else if (url.protocol === 'http:') url.protocol = 'ws:'
  else throw new Error('Invalid workbench origin')
  if (applied) {
    const bytes = new TextEncoder().encode(JSON.stringify(applied))
    const encoded = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
    url.searchParams.set('cursor', encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''))
  }
  return url.href
}

export function createChatTransport(transport: Transport, csrf: string) {
  return {
    async list(): Promise<ChatSummary[]> {
      const result = await transport.request('/chats')
      if (!record(result) || !Array.isArray(result.sessions) || !result.sessions.every(listEntry)) throw new Error('Invalid chat list')
      return result.sessions
    },
    async create(sessionId: string): Promise<ChatSummary> {
      const result = await transport.request('/chats', 'POST', { sessionId }, csrf)
      if (!record(result) || !listEntry(result.session) || result.session.id !== sessionId) throw new Error('Invalid created chat')
      return result.session
    },
    async read(sid: string): Promise<ChatSnapshot> {
      const result = await transport.request(path(sid))
      if (!snapshot(result, sid)) throw new Error('Invalid chat snapshot')
      return result
    },
    async send(sid: string, request: TurnRequest): Promise<ChatTurn & { duplicate: boolean }> {
      const result = await transport.request(`${path(sid)}/turns`, 'POST', request, csrf)
      if (!record(result) || !turn(result) || typeof result.duplicate !== 'boolean') throw new Error('Invalid chat acknowledgement')
      return { ...result, duplicate: result.duplicate }
    },
    async stop(sid: string, turnId: string): Promise<boolean> {
      const result = await transport.request(`${path(sid)}/stop`, 'POST', { turnId }, csrf)
      if (!record(result) || typeof result.stopped !== 'boolean') throw new Error('Invalid stop acknowledgement')
      return result.stopped
    }
  }
}
export type ChatTransport = ReturnType<typeof createChatTransport>
