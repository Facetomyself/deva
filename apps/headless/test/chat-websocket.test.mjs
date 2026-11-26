import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import WebSocket from 'ws'
import { createAuthService } from '../src/auth/index.mjs'
import { chatScope, createEventJournal } from '../src/events/index.mjs'
import { createChatWebSocket } from '../src/events/websocket.mjs'
import { HttpError, httpPolicy } from '../src/http/policy.mjs'

const SID = 'test-session'
const OTHER = 'other-session'
const TURN = 'test-turn'
const path = sid => `/api/v1/chats/${sid}/stream`
const resumed = (sid, cursor) => `${path(sid)}?cursor=${Buffer.from(JSON.stringify(cursor)).toString('base64url')}`
const options = { timeout: 10_000 }

async function fixture(t, journalOptions) {
  const scrypt = crypto.scrypt
  t.mock.method(crypto, 'scrypt', (password, salt, length, config, callback) => {
    scrypt(password, salt, length, { ...config, N: 1024 }, callback)
  })
  const dataDir = await mkdtemp(join(tmpdir(), 'deva-chat-websocket-'))
  const server = createServer((_req, res) => res.writeHead(404).end())
  const sockets = new Set()
  const clients = new Set()
  const journal = createEventJournal(journalOptions)
  let transport
  t.after(async () => {
    for (const ws of clients) ws.terminate()
    await transport?.close()
    journal.close()
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
    await rm(dataDir, { recursive: true, force: true })
  })

  const auth = await createAuthService({ dataDir })
  const issued = await auth.issueClaim()
  const owner = await auth.claim(issued.credential, 'fixture password for loopback auth')
  const state = new Map([SID, OTHER, 'legacy', 'complex'].map(id => [id, {
    id, compatibility: id === 'legacy' ? 'legacy_text' : id === 'complex' ? 'unsupported' : 'text',
    messages: [], active: null
  }]))
  const read = sid => {
    if (!state.has(sid)) throw new HttpError(404, 'session_not_found')
    return structuredClone(state.get(sid))
  }
  let peerSocket, onAttach
  const socketsRead = []
  const turns = {
    snapshot(sid) {
      socketsRead.push(['snapshot', sid])
      return journal.snapshot(chatScope(sid), () => read(sid))
    },
    attach(sid, callbacks) {
      socketsRead.push(['attach', sid])
      // Match the business service: resolve the session before touching the journal.
      read(sid)
      const value = journal.snapshotAndSubscribe(chatScope(sid), () => read(sid), callbacks)
      onAttach?.(sid)
      return value
    }
  }
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('upgrade', (req, socket, head) => {
    peerSocket = socket
    if (!transport.upgrade(req, socket, head)) socket.destroy()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const authority = `127.0.0.1:${server.address().port}`
  const origin = `http://${authority}`
  const policy = httpPolicy(origin)
  transport = createChatWebSocket({ turns, journal, auth, policy })
  const cookie = policy.issueCookie(owner.session, owner.expiresAt).split(';', 1)[0]

  function connect(target = path(SID), headers = {}, wsOptions = {}) {
    const ws = new WebSocket(`ws://${authority}${target}`, { headers: { origin, cookie, ...headers }, ...wsOptions })
    clients.add(ws)
    const frames = []
    let consumed = 0
    ws.on('error', () => {}) // Assertions use the HTTP response or terminal close separately.
    ws.on('message', data => frames.push(JSON.parse(data.toString())))
    ws.once('close', () => clients.delete(ws))
    const closed = new Promise(resolve => ws.once('close', (code, reason) => resolve([code, reason.toString()])))
    return { ws, frames, closed, async next() {
      if (consumed === frames.length) await once(ws, 'message', { signal: AbortSignal.timeout(2000) })
      return frames[consumed++]
    } }
  }
  async function status(target, headers) {
    const { ws } = connect(target, headers)
    const [, res] = await once(ws, 'unexpected-response', { signal: AbortSignal.timeout(2000) })
    res.resume()
    await once(res, 'end')
    ws.terminate()
    return res.statusCode
  }
  return {
    auth, owner, journal, state, transport, policy, socketsRead, connect, status,
    get socket() { return peerSocket },
    afterAttach(handler) { onAttach = handler },
    publish(sid, event) { return journal.publishChat({ sessionId: sid, turnId: TURN, event }) }
  }
}

test('checks real Origin + Host and owner cookie before resolving a chat; restricts the upgrade path', options, async t => {
  const f = await fixture(t)
  assert.equal(await f.status(path(SID), { origin: 'https://unrelated.invalid' }), 403)
  assert.equal(await f.status(path(SID), { origin: '' }), 403)
  assert.equal(await f.status(path(SID), { origin: [f.policy.origin, f.policy.origin] }), 403)
  assert.equal(await f.status(path(SID), { host: 'invalid.example' }), 403)
  assert.equal(await f.status(path(SID), { 'sec-fetch-site': 'cross-site' }), 403)
  assert.equal(await f.status(path(SID), { cookie: '' }), 401)
  assert.equal(await f.status(path('unknown'), { cookie: `${f.policy.cookieName}=${'A'.repeat(43)}` }), 401)
  assert.deepEqual(f.socketsRead, [])
  assert.equal(await f.status(path('%74est-session')), 400)
  assert.equal(await f.status(path('unknown')), 404)
  assert.equal(await f.status(path('complex')), 409)
  assert.equal(await f.status(`${path(SID)}?cursor=${'A'.repeat(513)}`), 400)
  assert.equal(await f.status(`${path(SID)}?cursor=e30&rpc=1`), 400)
  assert.equal(f.journal.stats().subscribers, 0)
  const outside = f.connect('/api/v1/events')
  assert.equal((await outside.closed)[0], 1006)
  const legacy = f.connect(path('legacy'))
  assert.equal((await legacy.next()).state.compatibility, 'legacy_text')
})

test('fresh connections and refresh queue the snapshot before immediately published frames', options, async t => {
  const f = await fixture(t)
  const first = f.connect()
  const empty = await first.next()
  assert.deepEqual(empty, { t: 'snapshot', ...f.journal.snapshot(chatScope(SID), () => f.state.get(SID)) })
  first.ws.close()
  await first.closed
  assert.equal(f.journal.stats().subscribers, 0)

  f.state.get(SID).messages = [{ role: 'user', content: 'hello' }]
  f.state.get(SID).active = { turnId: TURN, startedAt: 1, text: '' }
  f.afterAttach(() => {
    f.afterAttach(undefined)
    f.publish(SID, { type: 'turn_start', screenshot: 'screenshot marker' })
    f.publish(SID, { type: 'text_delta', text: 'first delta', key: 'fixture-key' })
    f.publish(SID, { type: 'error', error: 'raw error marker' })
  })
  const second = f.connect()
  const snapshot = await second.next()
  assert.equal(snapshot.t, 'snapshot')
  assert.deepEqual(snapshot.state, f.state.get(SID))
  assert.equal(snapshot.cursor.seq, 0)
  for (const [index, event] of [{ type: 'turn_start' }, { type: 'text_delta', text: 'first delta' }, { type: 'error' }].entries()) {
    assert.deepEqual(await second.next(), {
      t: 'event', cursor: { ...snapshot.cursor, seq: index + 1 }, type: 'chat', sessionId: SID, turnId: TURN, event
    })
  }
})

test('replay starts after the applied cursor; stale and foreign cursors fetch a new local snapshot', options, async t => {
  const f = await fixture(t, { maxEventsPerScope: 2 })
  const first = f.connect()
  const { cursor: firstCursor } = await first.next()
  const published = f.publish(SID, { type: 'text_delta', text: 'already applied' })
  const applied = await first.next()
  assert.deepEqual(applied.cursor, published.cursor)
  first.ws.close()
  await first.closed

  f.publish(SID, { type: 'text_delta', text: 'recover 1' })
  f.publish(SID, { type: 'text_delta', text: 'recover 2' })
  const replay = f.connect(resumed(SID, applied.cursor))
  for (const [index, text] of ['recover 1', 'recover 2'].entries()) {
    const frame = await replay.next()
    assert.equal(frame.t, 'event')
    assert.equal(frame.event.text, text)
    assert.equal(frame.cursor.seq, applied.cursor.seq + index + 1)
  }
  replay.ws.close()
  await replay.closed

  const foreign = f.publish(OTHER, { type: 'text_delta', text: 'other chat' })
  f.state.get(SID).messages = [{ role: 'assistant', content: 'current projection' }]
  for (const [index, cursor] of [firstCursor, foreign.cursor, { ...applied.cursor, epoch: crypto.randomUUID() }].entries()) {
    const client = f.connect(resumed(SID, cursor))
    const replacement = await client.next()
    assert.equal(replacement.t, 'snapshot')
    assert.equal(replacement.cursor.scope, chatScope(SID))
    assert.equal(replacement.cursor.seq, 3 + index)
    assert.deepEqual(replacement.state, f.state.get(SID))
    f.publish(SID, { type: 'text_delta', text: 'local only' })
    assert.equal((await client.next()).event.text, 'local only')
    client.ws.close()
    await client.closed
  }
  assert.equal(await f.status(resumed('unknown', applied.cursor)), 404)
})

test('allows protocol ping/pong and close; rejects text, binary and even an unfinished data fragment', options, async t => {
  const f = await fixture(t)
  const control = f.connect()
  await control.next()
  const pong = once(control.ws, 'pong')
  control.ws.ping(Buffer.from([0x81, 0x00, 0x89]))
  assert.deepEqual((await pong)[0], Buffer.from([0x81, 0x00, 0x89]))
  control.ws.pong('unsolicited')
  control.ws.close(1000)
  assert.equal((await control.closed)[0], 1000)
  for (const [data, frameOptions] of [
    [JSON.stringify({ type: 'send', text: 'mutate' }), {}],
    [Buffer.from('binary'), { binary: true }],
    ['', { fin: false }]
  ]) {
    const client = f.connect()
    await client.next()
    client.ws.send(data, frameOptions)
    assert.deepEqual(await client.closed, [1008, 'read_only'])
    assert.equal(client.frames.length, 1)
    assert.equal(f.journal.stats().subscribers, 0)
    assert.deepEqual(f.state.get(SID).messages, [])
  }
})

test('revocation is checked before each event, and idle expiry is checked on heartbeat', options, async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = await fixture(t)
  const active = f.connect()
  await active.next()
  f.auth.logout(f.owner.session)
  f.publish(SID, { type: 'text_delta', text: 'after logout' })
  assert.deepEqual(await active.closed, [1008, 'auth'])
  assert.equal(active.frames.length, 1)
  assert.equal(await f.status(path(SID)), 401)

  const replacement = await f.auth.login('fixture password for loopback auth')
  const idle = f.connect(path(SID), { cookie: `${f.policy.cookieName}=${replacement.session}` })
  await idle.next()
  const expired = performance.now() + 12 * 60 * 60 * 1000
  t.mock.method(performance, 'now', () => expired)
  t.mock.timers.tick(5000)
  assert.deepEqual(await idle.closed, [1008, 'auth'])
  assert.equal(f.journal.stats().subscribers, 0)
})

test('heartbeat probes a real WS and terminates a peer that omits pong', options, async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = await fixture(t)
  const client = f.connect(path(SID), {}, { autoPong: false })
  await client.next()
  const ping = once(client.ws, 'ping')
  t.mock.timers.tick(5000)
  assert.equal((await ping)[0].length, 8)
  t.mock.timers.tick(5000)
  assert.equal((await client.closed)[0], 1006)
  assert.equal(f.journal.stats().subscribers, 0)
})

test('bounded snapshot rejects a large transcript before upgrade; stalled writes release journal subscriptions', options, async t => {
  const f = await fixture(t)
  f.state.get(SID).messages = [{ role: 'assistant', content: '文'.repeat(750_000) }]
  assert.equal(await f.status(path(SID)), 413)
  assert.equal(f.journal.stats().subscribers, 0)
  f.state.get(SID).messages = []

  const client = f.connect()
  await client.next()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  f.socket.cork() // A real loopback socket with a deterministic stalled write callback.
  for (let disjoint = 0; disjoint < 8; disjoint++) f.publish(SID, { type: 'text_delta', text: 'x'.repeat(32 * 1024) })
  await setImmediate()
  const buffered = f.socket.writableLength
  assert.ok(buffered > 32 * 1024 && buffered < 33 * 1024, `one held wire frame: ${buffered} bytes`)
  t.mock.timers.tick(5000)
  assert.equal((await client.closed)[0], 1006)
  assert.equal(client.frames.length, 1)
  assert.equal(f.journal.stats().subscribers, 0)
})

test('journal loss closes for snapshot recovery; WS service shutdown releases peers and rejects new upgrades', options, async t => {
  const f = await fixture(t, { maxEventsPerScope: 1 })
  const missed = f.connect()
  await missed.next()
  f.publish(SID, { type: 'text_delta', text: 'lost' })
  f.publish(SID, { type: 'text_delta', text: 'retained' })
  assert.deepEqual(await missed.closed, [1012, 'snapshot_required'])
  assert.equal(missed.frames.length, 1)

  const client = f.connect()
  await client.next()
  const parked = f.connect()
  await parked.next()
  parked.ws.pause() // The client deliberately will not acknowledge the close frame.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const closing = f.transport.close()
  assert.equal(f.transport.close(), closing)
  assert.deepEqual(await client.closed, [1001, 'shutdown'])
  assert.equal(f.journal.stats().subscribers, 0)
  t.mock.timers.tick(1000)
  await closing
  parked.ws.resume()
  assert.equal(await f.status(path(SID)), 503)
})

test('transport bounds its own outbound event size and simultaneous peers', options, async t => {
  const f = await fixture(t, { maxEventBytes: 256 * 1024 })
  const large = f.connect()
  await large.next()
  f.publish(SID, { type: 'text_delta', text: '文'.repeat(50_000) })
  assert.deepEqual(await large.closed, [1009, 'frame_too_large'])
  assert.equal(large.frames.length, 1)

  const peers = Array.from({ length: 16 }, () => f.connect())
  await Promise.all(peers.map(peer => peer.next()))
  assert.equal(f.journal.stats().subscribers, 16)
  assert.equal(await f.status(path(SID)), 503)
  peers[0].ws.close()
  await peers[0].closed
  const replacement = f.connect()
  assert.equal((await replacement.next()).t, 'snapshot')
})
