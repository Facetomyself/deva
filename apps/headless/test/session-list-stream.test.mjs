import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import WebSocket from 'ws'
import { createAuthService } from '../src/auth/index.mjs'
import { chatScope, createEventJournal, SESSIONS_SCOPE } from '../src/events/journal.mjs'
import { createChatWebSocket } from '../src/events/websocket.mjs'
import { httpPolicy } from '../src/http/policy.mjs'
import { sessionRoutes } from '../src/http/session-routes.mjs'

const LIST = '/api/v1/chats/stream'
const CHAT = '/api/v1/chats/fixture-chat/stream'
const password = 'temporary loopback fixture password'
const options = { timeout: 10_000 }
const timeout = () => ({ signal: AbortSignal.timeout(2000) })
const resume = cursor => `${LIST}?cursor=${Buffer.from(JSON.stringify(cursor)).toString('base64url')}`
const snapshot = cursor => ({ t: 'sessions-snapshot', cursor })
const changed = cursor => ({ t: 'sessions-changed', cursor })

async function fixture(t, journalOptions, withChatRoutes = false) {
  const scrypt = crypto.scrypt
  t.mock.method(crypto, 'scrypt', (value, salt, length, config, done) => {
    scrypt(value, salt, length, { ...config, N: 1024 }, done)
  })
  const dataDir = await mkdtemp(join(tmpdir(), 'deva-session-list-stream-'))
  const sockets = new Set()
  const clients = new Set()
  const server = createServer()
  let journal = createEventJournal(journalOptions)
  let transport, upgradedSocket, businessTurns
  t.after(async () => {
    for (const ws of clients) ws.terminate()
    await transport?.close()
    await businessTurns?.close()
    journal.close()
    for (const socket of sockets) socket.destroy()
    if (server.listening) await new Promise(resolve => server.close(resolve))
    await rm(dataDir, { recursive: true, force: true })
  })
  const auth = await createAuthService({ dataDir })
  const { credential } = await auth.issueClaim()
  const owner = await auth.claim(credential, password)
  const chatReads = []
  const chatState = sid => ({ id: sid, compatibility: 'text', messages: [{ content: 'private chat body' }] })
  const turns = {
    snapshot(sid) {
      chatReads.push(sid)
      return journal.snapshot(chatScope(sid), () => chatState(sid))
    },
    attach(sid, callbacks) {
      chatReads.push(sid)
      return journal.snapshotAndSubscribe(chatScope(sid), () => chatState(sid), callbacks)
    }
  }
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  server.on('upgrade', (req, socket, head) => {
    upgradedSocket = socket
    if (!transport.upgrade(req, socket, head)) socket.destroy()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const authority = `127.0.0.1:${server.address().port}`
  const origin = `http://${authority}`
  const policy = httpPolicy(origin)
  const authCookie = session => policy.issueCookie(session.session, session.expiresAt).split(';', 1)[0]
  const cookie = authCookie(owner)
  const session = sessionRoutes({ auth, policy, version: 'fixture', getConfig: () => ({}) })
  let chats
  if (withChatRoutes) {
    const [{ createTextTurns }, { chatRoutes }] = await Promise.all([
      import('../src/chat/text-turns.mjs'), import('../src/chat/routes.mjs')
    ])
    businessTurns = createTextTurns({ dataDir, journal, settings: { getProvider() { assert.fail('unexpected model access') } } })
    chats = chatRoutes(businessTurns)
  }
  server.on('request', async (req, res) => {
    if (await session(req, res) || await chats?.(req, res, { auth, policy })) return
    res.writeHead(404).end()
  })
  const bind = () => createChatWebSocket({ turns: businessTurns ?? turns, journal, auth, policy })
  transport = bind()

  function connect(path = LIST, headers = {}, wsOptions = {}) {
    const requestHeaders = { origin, cookie, ...headers }
    for (const name of ['origin', 'cookie']) if (requestHeaders[name] === null) delete requestHeaders[name]
    const ws = new WebSocket(`ws://${authority}${path}`, { headers: requestHeaders, ...wsOptions })
    clients.add(ws)
    const frames = []
    let index = 0
    ws.on('error', () => {}) // Assertions read handshake responses or terminal close codes.
    ws.on('message', data => frames.push(JSON.parse(data.toString())))
    ws.once('close', () => clients.delete(ws))
    const closed = new Promise(resolve => ws.once('close', (code, reason) => resolve([code, reason.toString()])))
    return { ws, frames, closed, async next() {
      if (index === frames.length) await once(ws, 'message', timeout())
      return frames[index++]
    }, async flush() {
      // Give the journal a delivery turn and use a control round trip as the wire barrier.
      await setImmediate()
      const pong = once(ws, 'pong', timeout())
      ws.ping('list-stream-barrier')
      assert.equal((await pong)[0].toString(), 'list-stream-barrier')
    } }
  }

  return {
    connect, auth, chatReads, origin, cookie, authCookie, dataDir,
    http(path, { body, method = body === undefined ? 'GET' : 'POST', headers } = {}) {
      return fetch(`${origin}${path}`, {
        method, headers: { origin, cookie, 'x-deva-csrf': owner.csrf, 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body), ...timeout()
      })
    },
    get journal() { return journal },
    get socket() { return upgradedSocket },
    async status(path = LIST, headers) {
      const { ws } = connect(path, headers)
      const [, res] = await once(ws, 'unexpected-response', timeout())
      res.resume()
      await once(res, 'end', timeout())
      ws.terminate()
      return res.statusCode
    },
    async replaceJournal() {
      await transport.close()
      journal.close()
      journal = createEventJournal(journalOptions)
      transport = bind()
    }
  }
}

test('list-only tabs get just the latest explicitly published invalidation', options, async t => {
  const f = await fixture(t, { maxEventsPerScope: 1 })
  const first = f.connect()
  const second = f.connect()
  const initial = f.journal.snapshot(SESSIONS_SCOPE).cursor
  assert.equal(initial.seq, 0)
  assert.deepEqual(await Promise.all([first.next(), second.next()]), [snapshot(initial), snapshot(initial)])
  assert.deepEqual(f.chatReads, [])
  assert.equal(f.journal.stats().chatStreams, 0)

  const chat = f.connect(CHAT)
  assert.equal((await chat.next()).state.messages[0].content, 'private chat body')
  for (const event of [
    { type: 'text_delta', text: 'unrelated private delta' }, { type: 'turn_start' },
    { type: 'done', stopReason: 'error' }, { type: 'member_report' }
  ]) f.journal.publishChat({ sessionId: 'other-chat', turnId: 'other-turn', event })
  const mine = f.journal.publishChat({ sessionId: 'fixture-chat', turnId: 'chat-turn', event: { type: 'text_delta', text: 'selected-only' } })
  assert.deepEqual(await chat.next(), {
    t: 'event', cursor: mine.cursor, type: 'chat', sessionId: 'fixture-chat', turnId: 'chat-turn',
    event: { type: 'text_delta', text: 'selected-only' }
  })
  await first.flush()
  await second.flush()
  assert.deepEqual(first.frames, [snapshot(initial)])
  assert.deepEqual(second.frames, first.frames)
  assert.deepEqual(f.journal.snapshot(SESSIONS_SCOPE).cursor, initial)

  f.journal.publishSessionsChanged()
  f.journal.publishSessionsChanged()
  const { cursor: latest } = f.journal.publishSessionsChanged()
  assert.equal(latest.seq, 3)
  assert.deepEqual(await Promise.all([first.next(), second.next()]), [changed(latest), changed(latest)])
  const { cursor: next } = f.journal.publishSessionsChanged()
  assert.equal(next.seq, 4)
  assert.deepEqual(await Promise.all([first.next(), second.next()]), [changed(next), changed(next)])
  await first.flush()
  await second.flush()
  await chat.flush()
  assert.deepEqual(first.frames, [snapshot(initial), changed(latest), changed(next)])
  assert.deepEqual(second.frames, first.frames)
  assert.equal(chat.frames.length, 2)
})

test('actual chat HTTP create invalidates both tabs only after strict storage succeeds', options, async t => {
  const f = await fixture(t, undefined, true)
  const first = f.connect()
  const second = f.connect()
  const [initial, otherInitial] = await Promise.all([first.next(), second.next()])
  assert.deepEqual(initial, otherInitial)
  assert.deepEqual(await (await f.http('/api/v1/chats')).json(), { sessions: [] })
  const sid = 'sess_durable_create'
  const chatsDir = join(f.dataDir, 'data', 'chats')
  const created = await f.http('/api/v1/chats', { body: { sessionId: sid } })
  assert.equal(created.status, 200)
  const { session } = await created.json()
  const next = changed({ ...initial.cursor, seq: initial.cursor.seq + 1 })
  assert.deepEqual(await Promise.all([first.next(), second.next()]), [next, next])
  assert.equal(JSON.parse(await readFile(join(chatsDir, `${sid}.json`), 'utf8')).id, sid)
  assert.equal(session.id, sid)
  const duplicate = await f.http('/api/v1/chats', { body: { sessionId: sid } })
  assert.equal(duplicate.status, 200)
  assert.deepEqual(await duplicate.json(), { session })
  const denied = await f.http('/api/v1/chats', { body: { sessionId: 'unauthed' }, headers: { 'x-deva-csrf': 'wrong' } })
  assert.equal(denied.status, 401)
  await denied.json()

  // The session JSON alone does not confirm the strict write: make replacing the
  // list index fail even though the main session file is visible on disk.
  const index = join(chatsDir, '_index.json')
  await rename(index, `${index}.fixture-backup`)
  await mkdir(index)
  const failedSid = 'sess_failed_create'
  const failed = await f.http('/api/v1/chats', { body: { sessionId: failedSid } })
  assert.equal(failed.status, 503)
  await failed.json()
  assert.equal(JSON.parse(await readFile(join(chatsDir, `${failedSid}.json`), 'utf8')).id, failedSid)
  const reread = await f.http('/api/v1/chats')
  assert.equal(reread.status, 200)
  assert.deepEqual((await reread.json()).sessions.map(chat => chat.id), [sid])
  await first.flush()
  await second.flush()
  assert.deepEqual(first.frames, [initial, next])
  assert.deepEqual(second.frames, first.frames)
  assert.deepEqual(f.journal.snapshot(SESSIONS_SCOPE).cursor, next.cursor)
})

test('reconnect always starts at the server watermark, also after an epoch replacement', options, async t => {
  const f = await fixture(t, { maxEventsPerScope: 1 })
  const first = f.connect()
  const { cursor: old } = await first.next()
  first.ws.close()
  await first.closed
  f.journal.publishSessionsChanged()
  const { cursor: current } = f.journal.publishSessionsChanged()
  const returned = f.connect(resume(old))
  assert.deepEqual(await returned.next(), snapshot(current))
  await returned.flush()
  assert.deepEqual(returned.frames, [snapshot(current)])
  const future = f.connect(resume({ ...current, seq: Number.MAX_SAFE_INTEGER }))
  assert.deepEqual(await future.next(), snapshot(current))
  const { cursor: live } = f.journal.publishSessionsChanged()
  assert.deepEqual(await Promise.all([returned.next(), future.next()]), [changed(live), changed(live)])

  await f.replaceJournal()
  assert.deepEqual(await returned.closed, [1001, 'shutdown'])
  const recovered = f.connect(resume(live))
  const fresh = f.journal.snapshot(SESSIONS_SCOPE).cursor
  assert.notEqual(fresh.epoch, live.epoch)
  assert.notEqual(fresh.generation, live.generation)
  assert.equal(fresh.seq, 0)
  assert.deepEqual(await recovered.next(), snapshot(fresh))
  await recovered.flush()
  assert.equal(recovered.frames.length, 1)
})

test('requires fixed Host, Origin and cookie, validates the cursor, and closes on application frames', options, async t => {
  const f = await fixture(t)
  const invalidOrigins = [
    { origin: 'https://unrelated.invalid' }, { origin: null }, { origin: '' }, { origin: [f.origin, f.origin] },
    { host: 'unrelated.invalid', 'x-forwarded-host': new URL(f.origin).host }, { 'sec-fetch-site': 'cross-site' }
  ]
  for (const headers of invalidOrigins) assert.equal(await f.status(LIST, headers), 403)
  for (const cookie of [null, '', `${f.cookie}; ${f.cookie}`]) assert.equal(await f.status(LIST, { cookie }), 401)
  const initial = f.journal.snapshot(SESSIONS_SCOPE).cursor
  for (const path of [
    `${LIST}?cursor=`, `${LIST}?cursor=${'A'.repeat(513)}`, `${resume(initial)}&rpc=1`,
    `${resume(initial)}=`, resume({ ...initial, seq: -1 }), resume({ ...initial, epoch: '' }),
    resume({ ...initial, scope: 'chat:another' }), resume({ ...initial, sid: 'other' })
  ]) assert.equal(await f.status(path), 400)
  assert.equal(f.journal.stats().subscribers, 0)

  for (const [data, opts] of [
    [JSON.stringify({ t: 'create', sid: 'untrusted' }), {}], [Buffer.from('binary'), {}], ['', { fin: false }]
  ]) {
    const peer = f.connect()
    assert.deepEqual(await peer.next(), snapshot(initial))
    peer.ws.send(data, opts)
    assert.deepEqual(await peer.closed, [1008, 'read_only'])
    assert.deepEqual(peer.frames, [snapshot(initial)])
  }
  assert.deepEqual(f.chatReads, [])
  assert.equal(f.journal.stats().subscribers, 0)
  assert.deepEqual(f.journal.snapshot(SESSIONS_SCOPE).cursor, initial)
})

test('idle logout closes only that login’s tabs and the heartbeat removes expired logins', options, async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = await fixture(t)
  const otherLogin = await f.auth.login(password)
  const otherHeaders = { cookie: f.authCookie(otherLogin) }
  const first = f.connect()
  const second = f.connect()
  const other = f.connect(LIST, otherHeaders)
  await Promise.all([first.next(), second.next(), other.next()])
  const logout = await f.http('/api/v1/auth/logout', { method: 'POST' })
  assert.equal(logout.status, 200)
  assert.deepEqual(await logout.json(), { ok: true })
  assert.deepEqual(await Promise.all([first.closed, second.closed]), [[1008, 'auth'], [1008, 'auth']])
  assert.equal(first.frames.length, 1)
  assert.equal(second.frames.length, 1)
  assert.equal(await f.status(), 401)
  const { cursor } = f.journal.publishSessionsChanged()
  assert.deepEqual(await other.next(), changed(cursor))
  const expired = performance.now() + 12 * 60 * 60_000
  t.mock.method(performance, 'now', () => expired)
  t.mock.timers.tick(5000)
  assert.deepEqual(await other.closed, [1008, 'auth'])
  assert.equal(f.journal.stats().subscribers, 0)
  assert.equal(await f.status(LIST, otherHeaders), 401)
})

test('list peers reserve chat capacity and share the global WebSocket limit', options, async t => {
  const f = await fixture(t)
  const lists = Array.from({ length: 8 }, () => f.connect())
  await Promise.all(lists.map(peer => peer.next()))
  assert.equal(await f.status(), 503)
  const chats = Array.from({ length: 8 }, () => f.connect(CHAT))
  await Promise.all(chats.map(peer => peer.next()))
  assert.equal(f.journal.stats().subscribers, 16)
  assert.equal(await f.status(CHAT), 503)
  lists[0].ws.close()
  await lists[0].closed
  const ninthChat = f.connect(CHAT)
  assert.equal((await ninthChat.next()).t, 'snapshot')
  assert.equal(await f.status(), 503)
  ninthChat.ws.close()
  await ninthChat.closed
  assert.equal((await f.connect().next()).t, 'sessions-snapshot')
  assert.equal(f.journal.stats().subscribers, 16)
})

test('stalled list writes stay bounded and missed pongs time out', options, async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const f = await fixture(t)
  const client = f.connect()
  const first = await client.next()
  const socket = f.socket
  socket.cork()
  f.journal.publishSessionsChanged()
  await setImmediate()
  const buffered = socket.writableLength
  assert.ok(buffered > 0 && buffered < 512, `one pending list frame: ${buffered} bytes`)
  for (let i = 0; i < 20; i++) f.journal.publishSessionsChanged()
  await setImmediate()
  assert.equal(socket.writableLength, buffered)
  t.mock.timers.tick(5000)
  assert.deepEqual(await client.closed, [1006, ''])
  assert.deepEqual(client.frames, [first])
  assert.equal(f.journal.stats().subscribers, 0)

  const idle = f.connect(LIST, {}, { autoPong: false })
  assert.equal((await idle.next()).cursor.seq, 21)
  const ping = once(idle.ws, 'ping', timeout())
  t.mock.timers.tick(5000)
  assert.equal((await ping)[0].length, 8)
  t.mock.timers.tick(5000)
  assert.deepEqual(await idle.closed, [1006, ''])
  assert.equal(f.journal.stats().subscribers, 0)
})
