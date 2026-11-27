import { randomUUID } from 'node:crypto'
import { normalizeSessionTitle, SESSION_TITLE_MAX } from '../shared/session-title'
import { modelAdapters, type AdapterKind } from '../main/providers/adapters'
import type { AdapterTransport } from '../main/providers/types'
import { textAttachmentProblem, type TextAttachment } from './text-file'
import { INPUT, OUTPUT, message, messageBytes, projectMessage, userMessage, type MessageView, type Role, type TextMessage } from './text-message'
import { deriveTitle, listPlainSessionIds, PlainSessionSyncError, readPlainSession, savePlainSession } from '../main/services/chat-store'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const SESSION_ID = new RegExp(`^web_${UUID}(?![\\s\\S])`)
const TURN_ID = new RegExp(`^${UUID}(?![\\s\\S])`)
const HISTORY = 256 * 1024
const SESSIONS = 64, TURNS = 128, CONCURRENT = 2, DEADLINE = 120_000, WIRE = 1024 * 1024
const errors = {
  invalid_request: [400, 'Invalid chat request'], invalid_id: [400, 'Invalid session ID'],
  missing: [404, 'Chat not found'], stale: [409, 'Chat revision or turn changed'],
  busy: [409, 'Chat capacity is busy'], limit: [413, 'Chat limit reached'],
  upstream: [502, 'Model response failed'], storage: [503, 'Chat storage is unavailable']
} as const

export class ChatError extends Error {
  readonly status: number
  constructor(readonly code: keyof typeof errors) {
    super(errors[code][1])
    this.status = errors[code][0]
  }
}

type Session = {
  id: string; title: string; createdAt: number; updatedAt: number; messages: TextMessage[]; webText: true
  archived?: true; webEdits?: number; webCustomTitle?: true
}
type Row = { id: string; title: string; archived?: true }
export type View = Row & { messages: MessageView[]; revision: number; active: string | null }
const sessionKeys = new Set(['id', 'title', 'createdAt', 'updatedAt', 'messages', 'webText', 'archived', 'webEdits', 'webCustomTitle'])
const maxEdits = Number.MAX_SAFE_INTEGER - 2 * TURNS
const revisionOf = (s: Session) => s.messages.length + (s.webEdits ?? 0)
const invalidTitle = /[\u0000-\u001f\u007f\uD800-\uDFFF]/u
const row = (s: Session): Row => ({ id: s.id, title: s.title, ...(s.archived ? { archived: true } : {}) })
type Send = { text: string; revision: number; turnId: string; attachment?: unknown }
type Outcome = 'complete' | 'stopped'
type Sink = (text: string) => Promise<void>

function visible(m: TextMessage): MessageView {
  const result = projectMessage(m)
  if (!result) throw new ChatError('storage')
  return result
}

function automaticTitle(s: Session) {
  const first = s.messages.find(m => m.role === 'user')
  if (!first) return 'New chat'
  const { text, attachment } = visible(first)
  return deriveTitle(text || attachment?.name || '') || 'New chat'
}

function disk<T>(action: () => T): T {
  try { return action() } catch { throw new ChatError('storage') }
}

function load(id: string): Session | undefined {
  // JSON may escape each UTF-8 byte to six ASCII bytes; reserve space for the native envelope.
  const s = disk(() => readPlainSession(id, 6 * HISTORY + 32 * 1024)) as Session | undefined
  if (!s || s.id !== id || s.webText !== true || Object.keys(s).some(key => !sessionKeys.has(key)) ||
      (s.archived !== undefined && s.archived !== true) || (s.webCustomTitle !== undefined && s.webCustomTitle !== true) ||
      (s.webEdits !== undefined && (!Number.isSafeInteger(s.webEdits) || s.webEdits < 1 || s.webEdits > maxEdits)) ||
      ((s.archived || s.webCustomTitle) && !s.webEdits) ||
      typeof s.title !== 'string' || s.title.length > (s.webCustomTitle ? SESSION_TITLE_MAX : 31) ||
      (s.webCustomTitle && (!s.title || invalidTitle.test(s.title) || normalizeSessionTitle(s.title) !== s.title)) ||
      !Number.isSafeInteger(s.createdAt) || !Number.isSafeInteger(s.updatedAt) || !Array.isArray(s.messages) || s.messages.length > 2 * TURNS) return
  let bytes = 0, users = 0, previous: Role | undefined
  for (const m of s.messages) {
    if (!projectMessage(m) || (m.role === 'assistant' && previous !== 'user') ||
        (bytes += messageBytes(m)) > HISTORY || (m.role === 'user' && ++users > TURNS)) return
    previous = m.role
  }
  return s
}

const transport: AdapterTransport = {
  textOnly: true,
  describeNetError: () => 'Model transport failed',
  async fetchModel(url: string, init: RequestInit): Promise<Response> {
    const response = await fetch(url, { ...init, redirect: 'error' })
    if (!response.ok || !response.body) {
      void response.body?.cancel().catch(() => {})
      throw new Error('Invalid model response')
    }
    let bytes = 0, cr = false
    return new Response(response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, sink) {
        if ((bytes += chunk.byteLength) > WIRE) throw new Error('Model response exceeded byte limit')
        if (!chunk.length) return
        // Keep CRLF in one read even if the upstream split the line ending across chunks.
        if (cr) {
          const joined = new Uint8Array(chunk.length + 1)
          joined[0] = 13
          joined.set(chunk, 1)
          chunk = joined
        }
        cr = chunk.at(-1) === 13
        sink.enqueue(cr ? chunk.subarray(0, -1) : chunk)
      }
    })))
  }
}

async function emit(onDelta: Sink, text: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  let abort!: () => void
  try {
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
    })
    await Promise.race([Promise.resolve().then(() => onDelta(text)), interrupted])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

export function createTextChat({ protocol, baseURL, model, apiKey }: {
  protocol: AdapterKind; baseURL: string; model: string; apiKey: string
}) {
  // The operator selects a single adapter at boot, never from the browser or provider response.
  const stream = modelAdapters[protocol]
  // Private single-writer home: load the bounded native file set once; publish only after a strict write.
  let slots: Map<string, Session | undefined> | undefined
  const active = new Map<string, { turnId: string; abort: () => void }>()
  let closed = false, uncertain = false

  function sessions() {
    if (uncertain) throw new ChatError('storage')
    if (slots) return slots
    const ids = disk(() => listPlainSessionIds(id => SESSION_ID.test(id), SESSIONS, 512))
    if (ids.length > SESSIONS) throw new ChatError('limit')
    return slots = new Map(ids.map(id => [id, load(id)] as const))
  }

  function get(id: string): Session {
    if (typeof id !== 'string' || !SESSION_ID.test(id)) throw new ChatError('invalid_id')
    const s = sessions().get(id)
    if (!s) throw new ChatError('missing')
    return s
  }

  function view(s: Session): View {
    return { ...row(s), messages: s.messages.map(visible),
      revision: revisionOf(s), active: active.get(s.id)?.turnId ?? null }
  }

  function commit(s: Session): void {
    const registry = sessions()
    try { savePlainSession(s) } catch (e) {
      if (e instanceof PlainSessionSyncError) uncertain = true
      throw new ChatError('storage')
    }
    registry.set(s.id, s)
  }

  // Message admission, the assistant's final write and metadata edits share one durable revision.
  // Editing a title/archival state is not conversation activity: keep the original list order.
  function edit(id: string, revision: number, change: { title: string } | { archived: boolean }): View {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new ChatError('invalid_request')
    if (closed) throw new ChatError('storage')
    const s = get(id)
    if (revision !== revisionOf(s)) throw new ChatError('stale')
    const next = { ...s }
    if ('title' in change) {
      const name = normalizeSessionTitle(change.title)
      if (invalidTitle.test(name)) throw new ChatError('invalid_request')
      next.title = name || automaticTitle(s)
      if (name) next.webCustomTitle = true
      else delete next.webCustomTitle
    } else {
      if (change.archived && active.has(id)) throw new ChatError('busy')
      if (change.archived) next.archived = true
      else delete next.archived
    }
    if (next.title === s.title && next.webCustomTitle === s.webCustomTitle && next.archived === s.archived) return view(s)
    if (s.webEdits === maxEdits) throw new ChatError('limit')
    next.webEdits = (s.webEdits ?? 0) + 1
    commit(next)
    return view(next)
  }

  return {
    edit,
    list: (archived = false) => [...sessions().values()].filter((s): s is Session => !!s && !!s.archived === archived)
      .sort((a, b) => b.updatedAt - a.updatedAt).map(row),
    create(): View {
      if (closed) throw new ChatError('storage')
      if (sessions().size >= SESSIONS) throw new ChatError('limit')
      let id: string
      do { id = `web_${randomUUID()}` } while (sessions().has(id))
      const now = Date.now()
      const s: Session = { id, title: 'New chat', createdAt: now, updatedAt: now, messages: [], webText: true }
      commit(s)
      return view(s)
    },
    read: (id: string): View => view(get(id)),
    begin(id: string, input: Send) {
      if (!input || typeof input.text !== 'string' || !Number.isSafeInteger(input.revision) || input.revision < 0 ||
          typeof input.turnId !== 'string' || !TURN_ID.test(input.turnId)) throw new ChatError('invalid_request')
      const text = input.text.trim()
      if (Buffer.byteLength(text) > INPUT) throw new ChatError('limit')
      let file: TextAttachment | undefined
      if (input.attachment !== undefined) {
        const problem = textAttachmentProblem(input.attachment)
        if (problem) throw new ChatError(problem === 'size' ? 'limit' : 'invalid_request')
        file = input.attachment as TextAttachment
      }
      if (!text && !file) throw new ChatError('invalid_request')
      if (closed) throw new ChatError('storage')
      const s = get(id)
      if (active.has(id)) throw new ChatError('busy')
      if (revisionOf(s) !== input.revision) throw new ChatError('stale')
      if (active.size >= CONCURRENT) throw new ChatError('busy')
      const incoming = userMessage(text, file)
      if (s.messages.filter(m => m.role === 'user').length >= TURNS ||
          s.messages.reduce((sum, m) => sum + messageBytes(m), messageBytes(incoming) + OUTPUT) > HISTORY)
        throw new ChatError('limit')
      const next = { ...s, updatedAt: Date.now(), title: s.messages.length || s.webCustomTitle ? s.title : deriveTitle(text || file?.name || ''),
        messages: [...s.messages, incoming] }
      delete next.archived // As on desktop, an explicitly accepted new turn reopens an archived conversation.
      const controller = new AbortController()
      let stopped = false, running: Promise<Outcome> | undefined
      const release = () => { clearTimeout(timer); if (active.get(id) === turn) active.delete(id) }
      const cancel = (owner: boolean) => {
        if (controller.signal.aborted) return
        stopped = owner
        controller.abort()
        if (!running) release()
      }
      const turn = { turnId: input.turnId, abort: () => cancel(true) }
      const timer = setTimeout(() => cancel(false), DEADLINE)
      timer.unref()
      active.set(id, turn)
      try { commit(next) } catch (e) { release(); throw e }

      async function run(onDelta: Sink): Promise<Outcome> {
        let output = '', size = 0
        try {
          controller.signal.throwIfAborted()
          for await (const event of stream({ baseURL, apiKey }, {
            model, maxTokens: 4096, messages: next.messages, signal: controller.signal
          }, transport)) {
            controller.signal.throwIfAborted()
            if (event.type === 'text_delta') {
              if ((size += Buffer.byteLength(event.text)) > OUTPUT) throw new ChatError('limit')
              output += event.text
              await emit(onDelta, event.text, controller.signal)
            } else if (event.type === 'done' && event.stopReason === 'max_tokens') {
              throw new ChatError('limit')
            } else if (event.type === 'error' || event.type === 'tool_call' || event.type === 'tool_call_truncated' ||
                       (event.type === 'done' && event.stopReason !== 'end_turn' && event.stopReason !== 'refusal')) {
              throw new ChatError('upstream')
            }
          }
          controller.signal.throwIfAborted()
          if (!output.trim()) throw new ChatError('upstream')
          return 'complete'
        } catch (e) {
          if (stopped) return 'stopped'
          throw e instanceof ChatError && e.code === 'limit' ? e : new ChatError('upstream')
        } finally {
          controller.abort()
          try {
            if (output.trim()) {
              const latest = get(id) // A second owner window may have renamed the conversation during streaming.
              commit({ ...latest, updatedAt: Date.now(), messages: [...latest.messages, message('assistant', output)] })
            }
          } finally { release() }
        }
      }
      return { run: (onDelta: Sink) => running ??= run(onDelta), abort: turn.abort }
    },
    stop(id: string, turnId: string): void {
      get(id)
      if (typeof turnId !== 'string' || !TURN_ID.test(turnId)) throw new ChatError('invalid_request')
      const turn = active.get(id)
      if (turn && turn.turnId !== turnId) throw new ChatError('stale')
      turn?.abort()
    },
    close(): void {
      closed = true
      for (const turn of active.values()) turn.abort()
    }
  }
}
