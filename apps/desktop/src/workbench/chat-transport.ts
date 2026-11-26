import type { Transport } from './transport'

export const isWorkspaceRevision = (value: unknown): value is string => typeof value === 'string' && value.length === 64 && /^[a-f0-9]+$/u.test(value)

type Dictionary = Record<string, unknown>
const record = (x: unknown): x is Dictionary => typeof x === 'object' && x !== null && !Array.isArray(x)
const nullableString = (x: unknown): x is string | null => x === null || typeof x === 'string'
const time = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0
const id = (x: unknown): x is string => typeof x === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.exec(x)?.[0] === x
const attachmentId = (x: unknown): x is string => typeof x === 'string' && x.length === 36 &&
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-)4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(x)
const rolePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u
const reservedRoleIds = new Set(['constructor', 'prototype', '__proto__', ...Object.getOwnPropertyNames(Object.prototype).map((key) => key.toLowerCase())])

// Desktop role IDs are case-sensitive, and existing names can contain dots and underscores.
// Match the server's role ID grammar independently of the conversation ID grammar.
export function isRoleId(value: unknown): value is string {
  return typeof value === 'string' && rolePattern.exec(value)?.[0] === value && !value.endsWith('.') && !value.includes('..') &&
    !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(value) && !reservedRoleIds.has(value.toLowerCase()) &&
    (value === 'general' || value.toLowerCase() !== 'general')
}

export const MAX_TEXT_INPUT = 12 * 1024
export const inputBytes = (text: string): number => new TextEncoder().encode(text.trim()).byteLength

export interface ChatSummary {
  id: string
  title: string
  updatedAt: number
  model: string | null
  personaId?: string
  archived?: boolean
  customTitle?: string
  workspaceRevision?: string
  compatibility: 'text' | 'legacy_text' | 'unsupported'
  writable: boolean
}
export interface ChatTurn {
  turnId: string
  startedAt: number
  status: string
  reason: string | null
}
export const MAX_CHAT_ATTACHMENTS = 4
export interface ChatAttachment { id: string; name: string; mime: string; kind: 'text' | 'image' | 'document'; size: number }
export interface ChatMessage { role: 'user' | 'assistant'; content: string; attachments?: ChatAttachment[] }
export interface ChatState extends Omit<ChatSummary, 'updatedAt'> {
  updatedAt?: number
  writeBlockReason: string | null
  turnLimit: number | null
  messages: ChatMessage[] | null
  active: { text: string; turnId: string; startedAt: number } | null
  lastTurn: ChatTurn | null
}
export interface ChatCursor { epoch: string; scope: string; seq: number; generation: string }
export interface ChatSnapshot { cursor: ChatCursor; state: ChatState }
export type ChatFrame = ({ t: 'snapshot' } & ChatSnapshot) | {
  t: 'event'; cursor: ChatCursor; sessionId: string; turnId: string; type: 'chat'; event: { type: string; text?: string }
}
export interface TurnRequest { clientRequestId: string; text: string; model: string | null; attachments?: string[] }

type TurnDraft = Omit<TurnRequest, 'clientRequestId'>
export function sameTurnDraft(a: TurnDraft | undefined, b: TurnDraft): boolean {
  const prior = a?.attachments ?? []
  const next = b.attachments ?? []
  return !!a && a.text === b.text && a.model === b.model && prior.length === next.length && prior.every((value, i) => value === next[i])
}

const rasterMime = new Set(['image/png', 'image/jpeg', 'image/webp'])
function attachment(value: unknown): value is ChatAttachment {
  return record(value) && Object.keys(value).length === 5 && attachmentId(value.id) && typeof value.name === 'string' &&
    !!value.name && value.name.length <= 255 && Number.isSafeInteger(value.size) && (value.size as number) > 0 &&
    typeof value.mime === 'string' && (
      value.kind === 'image' ? rasterMime.has(value.mime) : value.kind === 'document' ? value.mime === 'application/pdf' :
        value.kind === 'text' && value.mime === 'text/plain')
}
function message(value: unknown): value is ChatMessage {
  if (!record(value) || (value.role !== 'user' && value.role !== 'assistant') || typeof value.content !== 'string') return false
  const { attachments } = value
  return attachments === undefined || (Array.isArray(attachments) && attachments.length <= MAX_CHAT_ATTACHMENTS &&
    attachments.every(attachment) && new Set(attachments.map((entry) => entry.id)).size === attachments.length)
}

function summary(value: unknown): value is Omit<ChatSummary, 'updatedAt'> {
  return record(value) && id(value.id) && typeof value.title === 'string' && nullableString(value.model) &&
    (value.personaId === undefined || isRoleId(value.personaId)) &&
    (value.archived === undefined || typeof value.archived === 'boolean') &&
    (value.customTitle === undefined || typeof value.customTitle === 'string') &&
    (value.workspaceRevision === undefined || isWorkspaceRevision(value.workspaceRevision)) &&
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
    (messages === null || (Array.isArray(messages) && messages.every(message))) &&
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

function attachmentPath(sid: string, aid: string): string {
  if (!attachmentId(aid)) throw new Error('Invalid attachment id')
  return `${path(sid)}/attachments/${aid}`
}

export function attachmentPreviewUrl(sid: string, aid: string): string {
  return `/api/v1${attachmentPath(sid, aid)}/preview`
}

function utf8Base64url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function chatStreamUrl(origin: string, sid: string, applied?: ChatCursor): string {
  const url = new URL(`/api/v1${path(sid)}/stream`, origin)
  if (url.protocol === 'https:') url.protocol = 'wss:'
  else if (url.protocol === 'http:') url.protocol = 'ws:'
  else throw new Error('Invalid workbench origin')
  if (applied) url.searchParams.set('cursor', utf8Base64url(JSON.stringify(applied)))
  return url.href
}

export function createChatTransport(transport: Transport, csrf: string) {
  return {
    async list(): Promise<ChatSummary[]> {
      const result = await transport.request('/chats')
      if (!record(result) || !Array.isArray(result.sessions) || !result.sessions.every(listEntry)) throw new Error('Invalid chat list')
      return result.sessions
    },
    async create(sessionId: string, personaId?: string): Promise<ChatSummary> {
      if (personaId !== undefined && !isRoleId(personaId)) throw new Error('Invalid role id')
      const result = await transport.request('/chats', 'POST', { sessionId, ...(personaId ? { personaId } : {}) }, csrf)
      if (!record(result) || !listEntry(result.session) || result.session.id !== sessionId ||
          (personaId !== undefined && result.session.personaId !== personaId)) throw new Error('Invalid created chat')
      return result.session
    },
    async read(sid: string): Promise<ChatSnapshot> {
      const result = await transport.request(path(sid))
      if (!snapshot(result, sid)) throw new Error('Invalid chat snapshot')
      return result
    },
    async uploadAttachment(sid: string, file: File, mime: string): Promise<ChatAttachment> {
      const name = file.name.normalize('NFC')
      const result = await transport.uploadAttachment(sid, file, utf8Base64url(name), mime, csrf)
      if (!record(result) || !attachment(result.attachment) || result.attachment.name !== name || result.attachment.mime !== mime ||
          result.attachment.size !== file.size)
        throw new Error('Invalid attachment acknowledgement')
      return result.attachment
    },
    async removeAttachment(sid: string, aid: string): Promise<void> {
      const result = await transport.request(attachmentPath(sid, aid), 'DELETE', undefined, csrf)
      if (result !== undefined && (!record(result) || result.ok !== true)) throw new Error('Invalid attachment removal acknowledgement')
    },
    async send(sid: string, request: TurnRequest): Promise<ChatTurn & { duplicate: boolean }> {
      const ids = request.attachments
      if (ids !== undefined && (!Array.isArray(ids) || ids.length > MAX_CHAT_ATTACHMENTS ||
          !ids.every(attachmentId) || new Set(ids).size !== ids.length)) throw new Error('Invalid turn attachments')
      const { clientRequestId, text, model } = request
      const result = await transport.request(`${path(sid)}/turns`, 'POST', { clientRequestId, text, model, ...(ids?.length ? { attachments: ids } : {}) }, csrf)
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
