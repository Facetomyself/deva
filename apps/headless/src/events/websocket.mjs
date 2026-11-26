import { randomBytes } from 'node:crypto'
import { STATUS_CODES } from 'node:http'
import { WebSocketServer } from 'ws'
import { isSessionId, projectChatEvent } from './chat-event.mjs'
import { chatScope } from './journal.mjs'
import { HttpError } from '../http/policy.mjs'

const PREFIX = '/api/v1/chats/'
const SUFFIX = '/stream'
const MAX_PEERS = 16
const MAX_CURSOR_CHARS = 512
const MAX_INBOUND_BYTES = 1024
const MAX_EVENT_BYTES = 128 * 1024
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024
const MAX_BUFFERED_BYTES = MAX_SNAPSHOT_BYTES + 4096 // Includes the handshake and framing overhead.
const HEARTBEAT_MS = 5_000
const WRITE_MS = 5_000
const CLOSE_MS = 1_000
const SNAPSHOT_LOST = new Set(['history_lost', 'scope_evicted'])

function endUpgrade(socket, status) {
  if (socket.destroyed) return
  const timer = setTimeout(() => socket.destroy(), CLOSE_MS).unref()
  socket.once('error', () => socket.destroy())
  socket.once('close', () => clearTimeout(timer))
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`)
}

function readCursor(query) {
  if (query === undefined) return null
  const encoded = query.startsWith('cursor=') ? query.slice(7) : ''
  const invalid = () => new HttpError(400, 'invalid_cursor')
  if (!encoded || encoded.length > MAX_CURSOR_CHARS || /[^A-Za-z0-9_-]/.test(encoded)) throw invalid()
  const raw = Buffer.from(encoded, 'base64url')
  if (raw.toString('base64url') !== encoded) throw invalid()
  let cursor
  try { cursor = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) } catch { throw invalid() }
  const { epoch, generation, scope, seq } = cursor ?? {}
  if (!cursor || Object.keys(cursor).length !== 4 || typeof epoch !== 'string' || epoch.length > 64 ||
      typeof generation !== 'string' || generation.length > 64 || typeof scope !== 'string' || scope.length > 133 ||
      !Number.isSafeInteger(seq) || seq < 0) throw invalid()
  return { epoch, generation, scope, seq }
}

function checkSnapshot(snapshot, sid) {
  const { state } = snapshot
  if (state?.id !== sid || (state.compatibility !== 'text' && state.compatibility !== 'legacy_text')) {
    throw new HttpError(409, 'unsupported_history')
  }
}

// Bound the walk as well as the resulting frame. A large legacy transcript is never
// stringified in full, and a partial transcript must never claim a complete cursor.
function encodeSnapshot(snapshot) {
  const frame = { t: 'snapshot', cursor: snapshot.cursor, state: snapshot.state }
  const tooLarge = () => new HttpError(413, 'snapshot_too_large')
  let bytes = MAX_SNAPSHOT_BYTES
  let nodes = 16_384
  function charge(n) {
    bytes -= n
    if (bytes < 0) throw tooLarge()
  }
  function walk(value, depth) {
    if (--nodes < 0 || depth > 12) throw tooLarge()
    if (typeof value === 'string') {
      if (value.length > bytes || Buffer.byteLength(value) > bytes) throw tooLarge()
      charge(Buffer.byteLength(JSON.stringify(value)))
    } else if (Array.isArray(value)) {
      charge(2)
      for (let i = 0; i < value.length; i++) {
        if (i > 0) charge(1)
        walk(value[i] ?? null, depth + 1)
      }
    } else if (value && typeof value === 'object') {
      charge(2)
      let first = true
      for (const key in value) {
        if (!Object.hasOwn(value, key) || value[key] === undefined) continue
        charge(first ? 1 : 2)
        first = false
        walk(key, depth + 1)
        walk(value[key], depth + 1)
      }
    } else {
      charge((JSON.stringify(value) ?? 'null').length)
    }
  }
  walk(frame, 0)
  const encoded = JSON.stringify(frame)
  if (Buffer.byteLength(encoded) > MAX_SNAPSHOT_BYTES) throw tooLarge()
  return encoded
}

// ws exposes complete messages, not their opening fragments. At a control-frame
// boundary inspect only the opcode and skip the bounded masked control payload;
// ws still validates and processes every control frame itself.
function guardControlOnly(socket, onData) {
  let skip = 0
  let needsLength = false
  function scan(chunk) {
    for (let i = 0; i < chunk.length;) {
      if (skip) {
        const consumed = Math.min(skip, chunk.length - i)
        skip -= consumed
        i += consumed
      } else if (needsLength) {
        needsLength = false
        const length = chunk[i++]
        if (length < 128 || length > 253) return // ws rejects invalid control frames.
        skip = 4 + (length & 0x7f)
      } else {
        const opcode = chunk[i++] & 0x0f
        if (opcode <= 2) return onData()
        if (opcode < 8 || opcode > 10) return // ws rejects reserved opcodes.
        needsLength = true
      }
    }
  }
  socket.prependListener('data', scan)
  return () => socket.off('data', scan)
}

function createPeer(ws, { socket, sid, scope, auth, cookie, subscription, remove }) {
  let active = true
  let outstandingWrite, closeTimer, expectedPong
  let controlPending = false

  function release() {
    if (!active) return
    active = false
    cookie = undefined
    stopIngressGuard()
    subscription.close()
    outstandingWrite?.settle(false)
  }

  function disconnect(code, reason) {
    // Drop a blocked socket rather than queueing a close behind undelivered data.
    const blocked = ws.bufferedAmount > 0
    release()
    if (!code || blocked) return ws.terminate()
    closeTimer ??= setTimeout(() => ws.terminate(), CLOSE_MS).unref()
    ws.close(code, reason)
  }

  function authorized() {
    if (!active) return false
    if (ws.readyState !== ws.OPEN) { disconnect(); return false }
    try { auth.authenticate(cookie) }
    catch { disconnect(1008, 'auth'); return false }
    return true
  }

  function writeData(text, limit) {
    if (!authorized()) return false
    const size = Buffer.byteLength(text)
    if (size > limit) { disconnect(1009, 'frame_too_large'); return false }
    if (outstandingWrite || ws.bufferedAmount + size + 14 > MAX_BUFFERED_BYTES) { disconnect(); return false }
    return new Promise(resolve => {
      const timer = setTimeout(() => disconnect(), WRITE_MS).unref()
      function settle(ok) {
        if (outstandingWrite?.settle !== settle) return
        clearTimeout(timer)
        outstandingWrite = undefined
        resolve(ok)
      }
      outstandingWrite = { settle }
      try { ws.send(text, { binary: false }, error => error ? disconnect() : settle(true)) }
      catch { disconnect() }
    })
  }

  function writeControl(kind, payload) {
    if (!authorized()) return
    if (controlPending || ws.bufferedAmount + payload.length + 14 > MAX_BUFFERED_BYTES) return disconnect()
    controlPending = true
    try {
      ws[kind](payload, false, error => {
        controlPending = false
        if (error) disconnect()
      })
    } catch { disconnect() }
  }

  function writeEvent(frame) {
    if (frame.type !== 'chat' || frame.sessionId !== sid || frame.cursor?.scope !== scope) {
      disconnect(1012, 'snapshot_required')
      return false
    }
    const event = projectChatEvent(frame)
    if (!event) { disconnect(1012, 'snapshot_required'); return false }
    if (event.event.text?.length > MAX_EVENT_BYTES) { disconnect(1009, 'frame_too_large'); return false }
    return writeData(JSON.stringify({ t: 'event', cursor: frame.cursor, ...event }), MAX_EVENT_BYTES)
  }

  const dataReceived = () => { if (active) disconnect(1008, 'read_only') }
  const stopIngressGuard = guardControlOnly(socket, dataReceived)
  ws.on('message', dataReceived)
  ws.on('ping', payload => writeControl('pong', payload))
  ws.on('pong', payload => {
    if (expectedPong?.equals(payload)) expectedPong = undefined
  })
  // ws has its own (longer) close timeout for malformed protocol frames.
  ws.on('error', () => disconnect(1002, 'protocol'))
  ws.once('close', () => {
    clearTimeout(closeTimer)
    release()
    remove()
  })

  let initial
  return {
    start(text) {
      if (text === undefined) return
      const writing = writeData(text, MAX_SNAPSHOT_BYTES)
      if (writing) initial = writing.then(ok => { initial = undefined; return ok })
    },
    event(frame) {
      // Journal holds at most one frame while the initial snapshot drains. Subsequent
      // deliveries are paced by their individual socket write callbacks.
      return initial ? initial.then(ok => ok && writeEvent(frame)) : writeEvent(frame)
    },
    ended(reason) {
      disconnect(SNAPSHOT_LOST.has(reason) ? 1012 : 1013, SNAPSHOT_LOST.has(reason) ? 'snapshot_required' : 'stream_ended')
    },
    heartbeat() {
      if (!authorized()) return
      if (expectedPong || controlPending) return disconnect()
      if (outstandingWrite) return // Its independent write deadline still applies.
      expectedPong = randomBytes(8)
      writeControl('ping', expectedPong)
    },
    shutdown() { disconnect(1001, 'shutdown') }
  }
}

/** Bind only the owner workbench's chat stream; the caller owns the HTTP upgrade listener. */
export function createChatWebSocket({ turns, journal, auth, policy }) {
  const wss = new WebSocketServer({
    noServer: true, perMessageDeflate: false, maxPayload: MAX_INBOUND_BYTES,
    allowSynchronousEvents: false, autoPong: false, handleProtocols: () => false
  })
  wss.on('wsClientError', (_error, socket) => endUpgrade(socket, 400))
  const peers = new Set()
  const heartbeat = setInterval(() => { for (const peer of peers) peer.heartbeat() }, HEARTBEAT_MS).unref()
  let closing

  function upgrade(req, socket, head) {
    const target = req.url ?? ''
    const split = target.indexOf('?')
    const path = split < 0 ? target : target.slice(0, split)
    if (!path.startsWith(PREFIX) || !path.endsWith(SUFFIX)) return false
    if (closing) { endUpgrade(socket, 503); return true }
    try {
      policy.check(req, true)
      if (req.headersDistinct.host?.length !== 1 || req.headersDistinct.origin?.length !== 1) throw new Error('origin')
    } catch { endUpgrade(socket, 403); return true }
    const cookie = policy.cookie(req)
    try { auth.authenticate(cookie) } catch { endUpgrade(socket, 401); return true }
    if (req.method !== 'GET') { endUpgrade(socket, 405); return true }
    const sid = path.slice(PREFIX.length, -SUFFIX.length)
    if (!isSessionId(sid) || head.length > 4096) { endUpgrade(socket, 400); return true }
    if (wss.clients.size >= MAX_PEERS) { endUpgrade(socket, 503); return true }

    const scope = chatScope(sid)
    let subscription, peer, initial
    const callbacks = {
      onEvent: frame => peer?.event(frame) ?? false,
      onClose: reason => peer?.ended(reason)
    }
    try {
      const cursor = readCursor(split < 0 ? undefined : target.slice(split + 1))
      if (cursor) {
        checkSnapshot(turns.snapshot(sid), sid)
        subscription = journal.subscribe(scope, cursor, callbacks)
      }
      if (!subscription || subscription.status === 'fresh_snapshot') {
        const attached = turns.attach(sid, callbacks)
        subscription = attached.subscription
        checkSnapshot(attached.snapshot, sid)
        if (subscription.status === 'subscribed') initial = encodeSnapshot(attached.snapshot)
      }
      if (subscription.status !== 'subscribed') throw new HttpError(503, 'stream_unavailable')
    } catch (error) {
      subscription?.close?.()
      const status = error instanceof HttpError && [400, 404, 409, 413, 503].includes(error.status) ? error.status : 503
      endUpgrade(socket, status)
      return true
    }

    // Snapshot construction can consume time near the authentication deadline.
    try { auth.authenticate(cookie) }
    catch { subscription.close(); endUpgrade(socket, 401); return true }

    try {
      // handleUpgrade is synchronous with no verifyClient callback. The journal defers delivery
      // until the next Node turn, so the snapshot is queued before any event can be delivered.
      wss.handleUpgrade(req, socket, head, ws => {
        peer = createPeer(ws, { socket, sid, scope, auth, cookie, subscription, remove: () => peers.delete(peer) })
        peers.add(peer)
        peer.start(initial)
        initial = undefined
      })
    } catch { socket.destroy() }
    finally { if (!peer) subscription.close() }
    return true
  }

  function close() {
    if (closing) return closing
    clearInterval(heartbeat)
    closing = new Promise((resolve, reject) => wss.close(error => error ? reject(error) : resolve()))
    for (const peer of peers) peer.shutdown()
    return closing
  }

  return Object.freeze({ upgrade, close })
}
