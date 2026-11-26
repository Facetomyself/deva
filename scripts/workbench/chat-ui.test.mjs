import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))
const ts = require('typescript')
const root = new URL('../../apps/desktop/src/workbench/', import.meta.url)
async function compiled(name, imports = {}) {
  const source = await readFile(new URL(`${name}.ts`, root), 'utf8')
  let js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText
  for (const [from, to] of Object.entries(imports)) js = js.replaceAll(`'${from}'`, `'${to}'`)
  return `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
}
const transportUrl = await compiled('chat-transport')
const { createChatTransport, chatStreamUrl, parseChatFrame, inputBytes } = await import(transportUrl)
const { createTransport } = await import(await compiled('transport'))
const { createChatStream, applyChatFrame } = await import(await compiled('chat-stream', { './chat-transport': transportUrl }))
const { chatCopy, turnLabel } = await import(await compiled('chat-copy'))

const sid = 'session_1'
const cursor = (seq, generation = 'generation-1', scope = `chat:${sid}`) => ({ epoch: 'epoch', scope, seq, generation })
const message = (role, content) => ({ role, content })
const active = (text = '') => ({ turnId: 'turn_1', text, startedAt: 123 })
const lastTurn = (status, reason = null) => ({ turnId: 'turn_1', startedAt: 123, status, reason })
const summary = (patch = {}) => ({ id: sid, title: 'Hello', updatedAt: 123, model: 'test:custom:model', compatibility: 'text', writable: true, ...patch })
const state = (patch = {}) => ({ ...summary(), writeBlockReason: null, turnLimit: 256, messages: [], active: null, lastTurn: null, ...patch })
const snapshot = (seq, patch = {}) => ({ cursor: cursor(seq), state: state(patch) })
const event = (seq, type, rest = {}) => ({ t: 'event', cursor: cursor(seq), type: 'chat', turnId: 'turn_1', sessionId: sid, event: { type, ...rest } })
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
const appliedCursor = (url) => JSON.parse(Buffer.from(new URL(url).searchParams.get('cursor'), 'base64url').toString('utf8'))
const settle = () => new Promise((resolve) => setImmediate(resolve))
const deferred = () => { let resolve; const result = new Promise((r) => { resolve = r }); return { result, resolve } }

function fixture(read) {
  const links = []
  const timers = []
  const projections = []
  const stream = createChatStream({ sid, origin: 'https://workbench.example.test', read,
    onChange: (view) => projections.push(view),
    open: (url) => {
      const socket = {
        url, closed: false,
        close() { this.closed = true },
        open() { this.onopen?.({}) },
        frame(data) { this.onmessage?.({ data: JSON.stringify(data) }) },
        drop(code = 1006, reason = '') { this.onclose?.({ code, reason }) }
      }
      links.push(socket)
      return socket
    },
    schedule: (callback, ms) => {
      const item = { callback, ms, cleared: false }
      timers.push(item)
      return () => { item.cleared = true }
    }
  })
  const retry = () => {
    const next = timers.findLast((item) => !item.cleared)
    assert.ok(next, 'reconnect was scheduled')
    next.cleared = true
    next.callback()
  }
  return { stream, links, projections, retry }
}

test('trusts only the explicitly declared text capability and sends settings CSRF with chat writes', async () => {
  const fixtureBootstrap = { protocol: 1, version: '1.0.0', platform: 'linux', config: {}, csrf: 'csrf-fixture', expiresAt: 1900000000000 }
  const request = { clientRequestId: 'request_1', text: '你好', model: 'test:custom:model' }
  const steps = [
    ['GET', '/api/v1/bootstrap', undefined, json({ ...fixtureBootstrap, capabilities: { textChat: 'true' } })],
    ['GET', '/api/v1/bootstrap', undefined, json({ ...fixtureBootstrap, capabilities: { textChat: true, tools: true } })],
    ['GET', '/api/v1/chats', undefined, json({ sessions: [summary(), summary({ id: 'legacy', compatibility: 'legacy_text', writable: false })] })],
    ['POST', '/api/v1/chats', { sessionId: sid }, json({ session: summary() })],
    ['GET', `/api/v1/chats/${sid}`, undefined, json(snapshot(0))],
    ['POST', `/api/v1/chats/${sid}/turns`, request, json({ ...lastTurn('running'), duplicate: false }, 202)],
    ['POST', `/api/v1/chats/${sid}/stop`, { turnId: 'turn_1' }, json({ stopped: true })],
    ['POST', `/api/v1/chats/${sid}/stop`, { turnId: 'turn_1' }, json({ error: 'turn_in_progress' }, 409)]
  ]
  const base = createTransport(async (url, init) => {
    const [method, path, body, response] = steps.shift()
    assert.equal(url, path)
    assert.equal(init.method, method)
    assert.deepEqual(init.body ? JSON.parse(init.body) : undefined, body)
    assert.equal(init.credentials, 'same-origin')
    assert.equal(init.headers['x-deva-csrf'], method === 'POST' ? fixtureBootstrap.csrf : undefined)
    return response
  })
  assert.equal((await base.inspect()).bootstrap.capabilities, undefined)
  assert.deepEqual((await base.inspect()).bootstrap.capabilities, { textChat: true })
  const chat = createChatTransport(base, fixtureBootstrap.csrf)
  assert.equal((await chat.list())[1].compatibility, 'legacy_text')
  assert.equal((await chat.create(sid)).id, sid)
  assert.deepEqual(await chat.read(sid), snapshot(0))
  assert.deepEqual(await chat.send(sid, request), { ...lastTurn('running'), duplicate: false })
  assert.equal(await chat.stop(sid, 'turn_1'), true)
  await assert.rejects(chat.stop(sid, 'turn_1'), { status: 409, code: 'turn_in_progress' })
  assert.deepEqual(steps, [])
  assert.equal(inputBytes(' 中文😀 '), 10)
})

test('serializes the last applied cursor as UTF-8 base64url on the same origin', () => {
  const value = { ...cursor(3), epoch: '服务器🌿' }
  const url = chatStreamUrl('https://workbench.example.test:4321', sid, value)
  assert.match(url, /^wss:\/\/workbench\.example\.test:4321\/api\/v1\/chats\/session_1\/stream\?cursor=[A-Za-z\d_-]+$/)
  assert.deepEqual(appliedCursor(url), value)
  assert.equal(chatStreamUrl('http://localhost:4000', sid), 'ws://localhost:4000/api/v1/chats/session_1/stream')
  assert.throws(() => chatStreamUrl('https://host', '../bad'))
})

test('ignores duplicated deltas and requires authority on mismatched turns, replay gaps or terminal events', () => {
  const initial = snapshot(3, { active: active('A'), messages: [message('user', 'Q')] })
  const delta = value => parseChatFrame(JSON.stringify(value), sid)
  const step = applyChatFrame(initial, delta(event(4, 'text_delta', { text: 'B' })))
  assert.equal(step.state.active.text, 'AB')
  assert.equal(applyChatFrame(step, delta(event(4, 'text_delta', { text: 'B' }))), step)
  assert.equal(applyChatFrame(step, delta({ ...event(5, 'text_delta', { text: 'X' }), turnId: 'old_turn' })), null)
  assert.equal(applyChatFrame(step, delta(event(6, 'text_delta', { text: 'X' }))), null)
  for (const type of ['turn_start', 'done', 'error', 'stream_reset']) assert.equal(applyChatFrame(step, delta(event(5, type))), null)
  assert.equal(delta({ ...event(5, 'text_delta', { text: 'X' }), sessionId: 'other' }), null)
  assert.equal(delta({ ...event(5, 'text_delta'), cursor: cursor(5, 'generation-1', 'sessions') }), null)
})

test('restores external user text, replays after the applied cursor, and converges terminal output once', async () => {
  const fetched = [snapshot(0), snapshot(2, { messages: [message('user', 'Other window prompt')], active: active('one') })]
  let reads = 0
  const terminal = deferred()
  const h = fixture(async () => { reads++; return fetched.shift() ?? terminal.result })
  await settle()
  h.links[0].open()
  assert.equal(h.stream.current().status, 'ready')
  h.links[0].frame(event(1, 'turn_start'))
  await settle()
  assert.equal(h.links[0].closed, true)
  assert.equal(h.stream.current().snapshot.state.messages[0].content, 'Other window prompt')
  assert.equal(appliedCursor(h.links[1].url).seq, 2)
  h.links[1].open()
  h.links[1].frame(event(3, 'text_delta', { text: '+two' }))
  h.links[1].drop()
  h.retry()
  assert.equal(appliedCursor(h.links[2].url).seq, 3)
  h.links[2].open()
  h.links[2].frame(event(4, 'text_delta', { text: '+three' }))
  assert.equal(h.stream.current().snapshot.state.active.text, 'one+two+three')
  h.links[2].frame(event(5, 'done'))
  assert.equal(h.stream.current().status, 'reconnecting')
  assert.equal(h.stream.current().snapshot.cursor.seq, 4)
  assert.equal(h.links[2].closed, true)
  terminal.resolve(snapshot(5, {
    messages: [message('user', 'Other window prompt'), message('assistant', 'one+two+three')], lastTurn: lastTurn('completed', 'end_turn')
  }))
  await settle()
  assert.equal(reads, 3)
  assert.equal(appliedCursor(h.links[3].url).seq, 5)
  h.links[3].open()
  assert.equal(h.stream.current().snapshot.state.active, null)
  assert.deepEqual(h.stream.current().snapshot.state.messages, [message('user', 'Other window prompt'), message('assistant', 'one+two+three')])
  h.stream.close()
})

test('labels completed edge cases, stopped turns and server interruptions distinctly', () => {
  for (const locale of ['en', 'zh-CN']) {
    const labels = [lastTurn('completed'), ...['truncated', 'empty', 'repeated', 'refusal'].map((r) => lastTurn('completed', r)),
      lastTurn('aborted', 'stopped'), lastTurn('aborted', 'shutdown'), lastTurn('interrupted', 'interrupted'), lastTurn('failed', 'timeout')]
      .map((turn) => turnLabel(chatCopy(locale), turn))
    assert.equal(new Set(labels).size, labels.length)
  }
})

test('accepts a replacement snapshot, ignores in-flight reads after switching, and leaves legacy history read-only', async () => {
  const blocked = deferred()
  const h = fixture(() => blocked.result)
  h.stream.close()
  blocked.resolve(snapshot(5))
  await settle()
  assert.equal(h.links.length, 0)
  assert.equal(h.projections.length, 1)
  const readonly = fixture(async () => snapshot(0, { compatibility: 'legacy_text', writable: false, writeBlockReason: 'read_only_session' }))
  await settle()
  assert.equal(readonly.stream.current().status, 'ready')
  assert.equal(readonly.links.length, 0)
  readonly.stream.close()
  const h2 = fixture(async () => snapshot(3, { active: active('old output') }))
  await settle()
  h2.links[0].open()
  h2.links[0].frame({ t: 'snapshot', ...snapshot(1), cursor: cursor(1, 'generation-2') })
  assert.equal(h2.stream.current().snapshot.cursor.generation, 'generation-2')
  assert.equal(h2.stream.current().snapshot.state.active, null)
  h2.links[0].drop(1008, 'auth')
  assert.deepEqual(h2.stream.current(), { status: 'expired', snapshot: undefined })
})
