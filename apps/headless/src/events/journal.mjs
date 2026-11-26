import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { isSessionId, projectChatEvent } from './chat-event.mjs'

export const SESSIONS_SCOPE = 'sessions'
const CHAT_PREFIX = 'chat:'
const DELIVERY_BATCH = 64
const ignore = () => {}

export function chatScope(sessionId) {
  if (!isSessionId(sessionId)) throw new TypeError('Invalid chat session id')
  return `${CHAT_PREFIX}${sessionId}`
}

function checkScope(scope) {
  if (scope === SESSIONS_SCOPE) return
  if (typeof scope !== 'string' || !scope.startsWith(CHAT_PREFIX) || !isSessionId(scope.slice(CHAT_PREFIX.length))) {
    throw new TypeError('Invalid event scope')
  }
}

function positiveInt(value, name, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new TypeError(`Invalid ${name}`)
  return value
}

function cursorError(cursor, epoch, scope, stream) {
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor) ||
      typeof cursor.epoch !== 'string' || typeof cursor.scope !== 'string' ||
      !Number.isSafeInteger(cursor.seq) || cursor.seq < 0 ||
      typeof cursor.generation !== 'string' || cursor.generation.length !== 36) return 'invalid_cursor'
  if (cursor.epoch !== epoch) return 'epoch_mismatch'
  if (cursor.scope !== scope) return 'scope_mismatch'
  if (!stream || cursor.generation !== stream.generation || cursor.seq < stream.floor) return 'history_lost'
  if (cursor.seq > stream.seq) return 'future_cursor'
  return null
}

function callClose(onClose, reason) {
  try { void Promise.resolve(onClose?.(reason)).catch(ignore) } catch { /* consumer isolation */ }
}

// A stalled Promise may outlive the journal. On close, clear its only path back to the subscription.
function observeDelivery(result, pending) {
  void Promise.resolve(result).then(
    (value) => pending.settle?.(value === false ? 'backpressure' : null),
    () => pending.settle?.('consumer_error')
  )
}

function closeHandle(control) {
  return () => { control.close?.() }
}

function startSubscription({ bus, stream, after, onEvent, onClose, release, deliveryTimeoutMs }) {
  let delivered = after; let scheduled; let pending; let closed = false
  const control = { close: () => finish() }
  const terminal = () => stream.retired ?? (delivered < stream.floor ? 'history_lost' : null)

  function finish(reason) {
    if (closed) return
    closed = true
    control.close = null
    bus.off(stream.topic, wake)
    clearImmediate(scheduled)
    if (pending) {
      pending.settle = null
      clearTimeout(pending.timer)
      pending = null
    }
    release()
    if (reason) callClose(onClose, reason)
  }

  function wake() {
    if (!closed && !scheduled && (!pending || terminal())) scheduled = setImmediate(drain)
  }

  function pause(result) {
    const waiting = {
      settle(reason) {
        clearTimeout(waiting.timer)
        waiting.settle = null
        pending = null
        if (reason) finish(reason)
        else wake()
      },
      timer: setTimeout(() => finish('delivery_timeout'), deliveryTimeoutMs)
    }
    waiting.timer.unref()
    pending = waiting
    observeDelivery(result, waiting)
    wake() // The callback itself may have published and overtaken this subscription.
  }

  function drain() {
    scheduled = undefined
    for (let i = 0; !closed && i < DELIVERY_BATCH; i++) {
      const reason = terminal()
      if (reason) return finish(reason)
      if (pending || delivered === stream.seq) return
      const next = stream.entries.get(delivered + 1)
      if (!next) return finish('history_lost')
      delivered = next.seq
      try {
        const result = onEvent(JSON.parse(next.json))
        if (result === false) return finish('backpressure')
        if (typeof result?.then === 'function') {
          if (closed) void Promise.resolve(result).catch(ignore)
          else pause(result)
          return
        }
      } catch {
        return finish('consumer_error')
      }
    }
    if (terminal() || delivered < stream.seq) wake()
  }

  bus.on(stream.topic, wake)
  wake()
  return closeHandle(control)
}

/**
 * One journal per running instance; scopes are the instance's session-list invalidations and
 * individual chat sessions. Sequence numbers start at zero and advance within a scope generation.
 * The shared LRU here bounds stream metadata, while global FIFO eviction bounds encoded history.
 */
export function createEventJournal({
  maxChatStreams = 128,
  maxEventsPerScope = 256,
  maxBytes = 2 * 1024 * 1024,
  maxEventBytes = Math.min(maxBytes, 64 * 1024),
  maxSubscribers = 64,
  deliveryTimeoutMs = 15_000
} = {}) {
  positiveInt(maxChatStreams, 'maxChatStreams')
  positiveInt(maxEventsPerScope, 'maxEventsPerScope')
  positiveInt(maxBytes, 'maxBytes')
  positiveInt(maxEventBytes, 'maxEventBytes', maxBytes)
  positiveInt(maxSubscribers, 'maxSubscribers')
  positiveInt(deliveryTimeoutMs, 'deliveryTimeoutMs', 2 ** 31 - 1)
  const epoch = randomUUID()
  const bus = new EventEmitter().setMaxListeners(maxSubscribers)
  const chats = new Map()
  const retained = new Set()
  let retainedBytes = 0; let subscribers = 0; let closed = false
  const sessions = newStream(SESSIONS_SCOPE)

  function newStream(scope) {
    return { scope, generation: randomUUID(), topic: Symbol(scope), seq: 0, floor: 0, entries: new Map(), retired: null }
  }

  function forget(entry) {
    const { stream, seq, bytes } = entry
    retained.delete(entry)
    retainedBytes -= bytes
    stream.entries.delete(seq)
    stream.floor = seq
  }

  function retire(stream, reason) {
    stream.retired = reason
    for (const entry of stream.entries.values()) forget(entry)
    bus.emit(stream.topic)
  }

  function useStream(scope) {
    if (scope === SESSIONS_SCOPE) return sessions
    let stream = chats.get(scope)
    if (stream) chats.delete(scope)
    else {
      stream = newStream(scope)
      if (chats.size === maxChatStreams) {
        const oldest = chats.values().next().value
        chats.delete(oldest.scope)
        retire(oldest, 'scope_evicted')
      }
    }
    chats.set(scope, stream)
    return stream
  }

  const cursorAt = (stream) => Object.freeze({ epoch, scope: stream.scope, generation: stream.generation, seq: stream.seq })

  function publish(scope, event) {
    const stream = useStream(scope)
    if (stream.seq === Number.MAX_SAFE_INTEGER) throw new RangeError('Event sequence exhausted')
    stream.seq++
    const cursor = cursorAt(stream)
    // Avoid serializing enormous deltas. UTF-8 takes at least one byte per UTF-16 code unit.
    const json = event.event?.text?.length > maxEventBytes ? '' : JSON.stringify({ cursor, ...event })
    const bytes = Buffer.byteLength(json)
    if (bytes === 0 || bytes > maxEventBytes) {
      for (const entry of stream.entries.values()) forget(entry)
      stream.floor = stream.seq
      bus.emit(stream.topic)
      return { status: 'snapshot_required', cursor }
    }
    const entry = { stream, seq: stream.seq, json, bytes }
    stream.entries.set(entry.seq, entry)
    retained.add(entry)
    retainedBytes += bytes
    if (stream.entries.size > maxEventsPerScope) forget(stream.entries.values().next().value)
    const wake = new Set([stream])
    while (retainedBytes > maxBytes) {
      const oldest = retained.values().next().value
      forget(oldest)
      wake.add(oldest.stream)
    }
    for (const changed of wake) bus.emit(changed.topic)
    return { status: 'published', cursor }
  }

  function snapshot(scope, readState = () => null) {
    checkScope(scope)
    if (closed) throw new Error('Event journal is closed')
    if (typeof readState !== 'function') throw new TypeError('Expected a synchronous snapshot reader')
    const stream = useStream(scope)
    const cursor = cursorAt(stream)
    const state = readState()
    if (typeof state?.then === 'function') {
      void Promise.resolve(state).catch(ignore)
      throw new TypeError('Snapshot reader must be synchronous')
    }
    if (stream.retired || stream.seq !== cursor.seq) {
      const error = new Error('Event scope changed inside the snapshot reader')
      error.code = 'SNAPSHOT_CHANGED'
      throw error
    }
    return { cursor, state }
  }

  function subscribe(scope, cursor, { onEvent, onClose } = {}) {
    checkScope(scope)
    if (closed) return { status: 'closed' }
    if (typeof onEvent !== 'function' || (onClose !== undefined && typeof onClose !== 'function')) {
      throw new TypeError('Expected event delivery callbacks')
    }
    const stream = scope === SESSIONS_SCOPE ? sessions : chats.get(scope)
    const reason = cursorError(cursor, epoch, scope, stream)
    if (reason) return { status: 'fresh_snapshot', reason }
    if (subscribers === maxSubscribers) return { status: 'busy' }
    useStream(scope)
    subscribers++
    return {
      status: 'subscribed',
      close: startSubscription({
        bus, stream, after: cursor.seq, onEvent, onClose, deliveryTimeoutMs,
        release: () => { subscribers-- }
      })
    }
  }

  return Object.freeze({
    epoch,
    publishChat(payload) {
      if (closed) return { status: 'closed' }
      const event = projectChatEvent(payload)
      if (!event) return { status: 'ignored' }
      const result = publish(chatScope(event.sessionId), event)
      // These desktop events also update the list (for example, a first turn creates a session).
      if (event.event.type === 'turn_start' || event.event.type === 'done' || event.event.type === 'member_report') {
        publish(SESSIONS_SCOPE, { type: 'sessions_changed' })
      }
      return result
    },
    publishSessionsChanged() {
      return closed ? { status: 'closed' } : publish(SESSIONS_SCOPE, { type: 'sessions_changed' })
    },
    snapshot,
    subscribe,
    snapshotAndSubscribe(scope, readState, callbacks) {
      const initial = snapshot(scope, readState)
      return { snapshot: initial, subscription: subscribe(scope, initial.cursor, callbacks) }
    },
    stats() {
      return { retainedBytes, retainedEvents: retained.size, chatStreams: chats.size, subscribers }
    },
    close() {
      if (closed) return
      closed = true
      retire(sessions, 'journal_closed')
      for (const stream of chats.values()) retire(stream, 'journal_closed')
      chats.clear()
    }
  })
}
