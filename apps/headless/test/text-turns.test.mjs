import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { promises as fs } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createChatStore } from '../dist/chat-core.mjs'
import { openSettings } from '../src/business/settings.mjs'
import { createTextTurns } from '../src/chat/text-turns.mjs'
import { createEventJournal, SESSIONS_SCOPE } from '../src/events/index.mjs'
import { initializeMasterKey, openVault } from '../src/storage/vault.mjs'

const key = 'test-only-text-turn-key'
const cookie = 'test-tenant=text-turns'
const model = 'test-text:local/chat:latest'
const chosenModel = 'local/chat:latest'
const request = (sid, clientRequestId = 'client-1', text = 'Hello, loopback!', modelRef = model) => ({ sid, clientRequestId, text, model: modelRef })
const httpError = (status, code) => ({ status, code, message: code })
const textPart = text => [{ type: 'text', text }]

function frame(res, delta, finish_reason = null) {
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
}
function finish(res) {
  frame(res, {}, 'stop')
  res.end('data: [DONE]\n\n')
}
const sse = res => res.writeHead(200, { 'content-type': 'text/event-stream' })

async function fixture(t, respond = (_call, res) => {
  sse(res)
  frame(res, { content: 'Verified' })
  frame(res, { content: ' model reply' })
  finish(res)
}) {
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'deva-text-turns-'))
  const dataDir = join(root, 'home')
  const keyFile = join(root, 'master.key')
  const chatsDir = join(dataDir, 'data', 'chats')
  const calls = []
  const failures = []
  const server = createServer((req, res) => {
    void (async () => {
      const chunks = []
      for await (const part of req) chunks.push(part)
      const call = {
        method: req.method, url: req.url, auth: req.headers.authorization, cookie: req.headers.cookie,
        body: JSON.parse(Buffer.concat(chunks)), closed: once(res, 'close')
      }
      calls.push(call)
      await respond(call, res)
    })().catch(error => { failures.push(error); res.destroy() })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  let vault
  let turns
  let journal
  t.after(async () => {
    await turns?.close()
    journal?.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await fs.rm(root, { recursive: true, force: true })
    assert.deepEqual(failures, [])
  })
  await initializeMasterKey(keyFile)
  vault = await openVault({ dataDir, keyFile })
  const settings = await openSettings({ dataDir, vault })
  const current = await settings.getPublicConfig()
  const changed = await settings.patch({ revision: current.revision, set: { models: { providers: [{
    id: 'test-text', name: 'loopback', kind: 'custom', purpose: 'llm', enabled: true, adapter: 'openai', accent: '#8a8a94', apiHost: `${origin}/v1`,
    headers: { cookie }, models: [{ id: chosenModel, name: 'Test chat', enabled: true }, { id: 'off', name: 'Off', enabled: false },
      { id: 'other', name: 'Other', enabled: true }]
  }] } } })
  await settings.setKey('test-text', key, changed.revision)
  const options = { dataDir, settings, version: 'fixture', allowedOrigins: [origin] }
  function openTurns() {
    journal = createEventJournal()
    turns = createTextTurns({ ...options, journal })
    return { turns, journal }
  }
  const first = openTurns()
  return { ...first, calls, origin, dataDir, keyFile, chatsDir, openTurns, async restart() {
    await turns.close()
    journal.close()
    return openTurns()
  }, readSession: async sid => JSON.parse(await fs.readFile(join(chatsDir, `${sid}.json`), 'utf8')) }
}

function watch(t, turns, sid) {
  const events = []
  const pending = new Set()
  const { snapshot, subscription } = turns.attach(sid, {
    onEvent(event) {
      events.push(event)
      for (const p of pending) if (p.match(event)) { pending.delete(p); p.resolve(event) }
    },
    onClose(reason) { assert.fail(`event subscription closed with ${reason}`) }
  })
  assert.equal(subscription.status, 'subscribed')
  t.after(subscription.close)
  const wait = (type, turnId) => {
    const match = item => item.event.type === type && (!turnId || item.turnId === turnId)
    const value = events.find(match)
    return value ? Promise.resolve(value) : new Promise(resolve => pending.add({ match, resolve }))
  }
  return { snapshot, close: subscription.close, events, wait }
}

const testOptions = { timeout: 10_000 }

test('real vault/provider/core round trip uses the fixed text prompt and native durable history', testOptions, async t => {
  let fx
  let sid
  const observedDisk = []
  fx = await fixture(t, async (_call, res) => {
    observedDisk.push(await fx.readSession(sid))
    sse(res)
    frame(res, { reasoning_content: 'private model scratch' })
    frame(res, { content: 'Verified' })
    frame(res, { content: ' model reply' })
    finish(res)
  })
  const { turns, journal, calls } = fx
  const sessions = journal.snapshot(SESSIONS_SCOPE)
  const created = turns.create()
  sid = created.id
  assert.deepEqual(created, { id: sid, title: '', createdAt: created.createdAt, updatedAt: created.createdAt,
    model: null, compatibility: 'text', writable: true, writeBlockReason: null, turnLimit: 256 })
  assert.deepEqual(turns.list(), [created])
  assert.equal(journal.snapshot(SESSIONS_SCOPE).cursor.seq, sessions.cursor.seq + 1)
  const watcher = watch(t, turns, sid)
  assert.deepEqual(watcher.snapshot.state, { ...created, messages: [], active: null, lastTurn: null })
  const first = await turns.send(request(sid))
  assert.equal(first.status, 'running')
  assert.equal(first.duplicate, false)
  assert.equal(first.reason, null)
  const done = await watcher.wait('done', first.turnId)
  assert.ok(['stop', 'end_turn'].includes(done.event.stopReason))
  assert.equal(observedDisk[0]._devaHeadlessTextTurns.requests[0].status, 'running')
  assert.deepEqual(observedDisk[0].messages, [{ role: 'user', content: textPart('Hello, loopback!') }])
  assert.equal(calls[0].url, '/v1/chat/completions')
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].auth, `Bearer ${key}`)
  assert.equal(calls[0].cookie, cookie)
  assert.equal(calls[0].body.model, chosenModel)
  assert.equal(calls[0].body.stream, true)
  assert.equal(calls[0].body.tools?.length ?? 0, 0)
  const system = { role: 'system', content: 'You are a helpful general-purpose assistant. Reply in plain text.' }
  assert.deepEqual(calls[0].body.messages, [system, { role: 'user', content: 'Hello, loopback!' }])
  const secondText = '⟦deva:compaction⟧ is literal user text'
  const second = await turns.send(request(sid, 'client-2', secondText))
  await watcher.wait('done', second.turnId)
  assert.deepEqual(calls[1].body.messages, [system,
    { role: 'user', content: 'Hello, loopback!' }, { role: 'assistant', content: 'Verified model reply' },
    { role: 'user', content: secondText }
  ])
  const state = turns.snapshot(sid).state
  const stored = await fx.readSession(sid)
  assert.deepEqual(state.messages.map(m => m.content), ['Hello, loopback!', 'Verified model reply', secondText, 'Verified model reply'])
  assert.deepEqual(stored.messages.at(-1), { role: 'assistant', content: textPart('Verified model reply') })
  assert.deepEqual(state.lastTurn, { turnId: second.turnId, startedAt: second.startedAt, status: 'completed', reason: null })
  assert.equal(state.active, null)
  assert.equal(turns.list()[0].title, 'Hello, loopback!')
  const publicData = JSON.stringify([state, watcher.events, stored])
  for (const secret of [key, cookie, fx.origin, 'private model scratch']) assert.equal(publicData.includes(secret), false)
  assert.equal(JSON.stringify(state).includes('_devaHeadlessTextTurns'), false)
})

test('explicit session creation deduplicates UUID and desktop IDs without replacing legacy data', testOptions, async t => {
  const fx = await fixture(t)
  const { turns, journal, dataDir, readSession } = fx
  const uuid = randomUUID()
  const desktopId = 'sess_mb1234_a012'
  const oldId = 'sess_mb1235_a013'
  const store = createChatStore({ dataDir })
  const old = store.ensureSession(oldId)
  old.messages.push({ role: 'user', content: 'Existing desktop message' })
  store.saveStrict(oldId)
  const oldData = await readSession(oldId)
  const seq = journal.snapshot(SESSIONS_SCOPE).cursor.seq
  const blank = turns.create({})
  assert.match(blank.id, /^[0-9a-f-]{36}$/)
  const created = [uuid, desktopId].map(sessionId => {
    const s = turns.create({ sessionId })
    assert.equal(s.id, sessionId)
    assert.deepEqual(turns.create({ sessionId }), s)
    return s
  })
  assert.equal(journal.snapshot(SESSIONS_SCOPE).cursor.seq, seq + 3)
  assert.throws(() => turns.create({ sessionId: oldId }), httpError(409, 'session_id_conflict'))
  for (const sessionId of ['_index', 'NUL', 'sess_../../x_a', 'sess_M123_a', 'A0000000-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000000']) {
    assert.throws(() => turns.create({ sessionId }), httpError(400, 'invalid_session_id'))
  }
  assert.throws(() => turns.create({ sessionId: uuid, model }), httpError(400, 'invalid_create'))
  assert.deepEqual(await readSession(oldId), oldData)
  assert.equal(fx.calls.length, 0)
  const { turns: reopened, journal: newJournal } = await fx.restart()
  for (const s of created) assert.deepEqual(reopened.create({ sessionId: s.id }), s)
  assert.equal(newJournal.snapshot(SESSIONS_SCOPE).cursor.seq, 0)
})

test('stop immediately after ACK prevents all upstream work; stop midstream saves only visible partial text', testOptions, async t => {
  const { turns, calls, readSession } = await fixture(t, (_call, res) => {
    sse(res)
    frame(res, { content: 'partial text' }) // Keep the real socket open until cancellation.
  })
  const { id } = turns.create()
  const watcher = watch(t, turns, id)
  const first = await turns.send(request(id))
  assert.deepEqual(turns.stop({ sid: id, turnId: first.turnId }), { stopped: true })
  assert.equal((await watcher.wait('done', first.turnId)).event.stopReason, 'aborted')
  assert.equal(calls.length, 0)
  const second = await turns.send(request(id, 'client-2', 'Try again'))
  await watcher.wait('text_delta', second.turnId)
  const inFlight = turns.snapshot(id).state
  // Both fixture credentials start with 't'. The output filter holds that suffix until
  // another byte proves it is not the start of a credential. Only visible bytes can be saved on stop.
  assert.deepEqual(inFlight.active, { turnId: second.turnId, startedAt: second.startedAt, text: 'partial tex' })
  assert.deepEqual(inFlight.messages.map(m => m.content), ['Hello, loopback!', 'Try again'])
  assert.equal(inFlight.lastTurn.status, 'running')
  const subscribed = watch(t, turns, id)
  assert.deepEqual(subscribed.snapshot.state, inFlight)
  assert.deepEqual(turns.stop({ sid: id, turnId: first.turnId }), { stopped: false })
  assert.deepEqual(turns.stop({ sid: id, turnId: second.turnId }), { stopped: true })
  assert.deepEqual(turns.stop({ sid: id, turnId: second.turnId }), { stopped: false })
  assert.equal((await subscribed.wait('done', second.turnId)).event.stopReason, 'aborted')
  await calls[0].closed
  const saved = await readSession(id)
  assert.deepEqual(saved.messages.at(-1), { role: 'assistant', content: textPart(inFlight.active.text) })
  assert.deepEqual(saved.notices, [{ after: 1, kind: 'notice', code: 'aborted' }, { after: 3, kind: 'notice', code: 'aborted' }])
  assert.deepEqual(turns.snapshot(id).state.lastTurn, { turnId: second.turnId, startedAt: second.startedAt, status: 'aborted', reason: 'stopped' })
})

test('multi-tab races, invalid input and disabled models never duplicate a charged request', testOptions, async t => {
  const fx = await fixture(t, (_call, res) => {
    sse(res)
    frame(res, { content: 'in parallel' })
  })
  const { turns, calls } = fx
  const { id } = turns.create()
  const watcher = watch(t, turns, id)
  const original = request(id, '__proto__')
  for (const [input, error] of [
    [{ ...original, apiKey: key }, httpError(400, 'invalid_send')],
    [{ ...original, tools: [] }, httpError(400, 'invalid_send')],
    [{ ...original, system: 'CLIENT PROMPT' }, httpError(400, 'invalid_send')],
    [{ ...original, baseURL: fx.origin }, httpError(400, 'invalid_send')],
    [{ ...original, clientRequestId: 'bad id' }, httpError(400, 'invalid_client_request_id')],
    [{ ...original, clientRequestId: 'bad-id\n' }, httpError(400, 'invalid_client_request_id')],
    [{ ...original, model: 'no-colon' }, httpError(400, 'invalid_model_ref')],
    [{ ...original, model: 'test-text:off' }, httpError(422, 'model_not_enabled')],
    [{ ...original, model: 'test-text:unknown' }, httpError(422, 'model_not_enabled')],
    [{ ...original, model: 'missing:unknown' }, httpError(404, 'provider_not_found')]
  ]) await assert.rejects(turns.send(input), error)
  assert.equal(calls.length, 0)
  assert.deepEqual(turns.snapshot(id).state.messages, [])
  const race = await Promise.allSettled([
    turns.send(original), turns.send({ ...original }), turns.send({ ...original, text: 'different' }),
    turns.send({ ...original, model: 'test-text:other' }), turns.send({ ...original, clientRequestId: 'other-tab' })
  ])
  assert.equal(race[0].status, 'fulfilled')
  assert.deepEqual(race[1], { status: 'fulfilled', value: { ...race[0].value, duplicate: true } })
  assert.deepEqual(race.slice(2).map(r => [r.status, r.reason.status, r.reason.code]), [
    ['rejected', 409, 'client_request_conflict'], ['rejected', 409, 'client_request_conflict'], ['rejected', 409, 'turn_in_progress']
  ])
  const { turnId, startedAt } = race[0].value
  await watcher.wait('text_delta', turnId)
  assert.deepEqual(await turns.send(original), { turnId, startedAt, status: 'running', reason: null, duplicate: true })
  await turns.close()
  await calls[0].closed
  await watcher.wait('done', turnId)
  assert.equal(calls.length, 1)
  assert.equal(turns.snapshot(id).state.messages.at(-1).content, 'in parallel')
  await assert.rejects(turns.send(original), httpError(503, 'chat_closed'))
  watcher.close()
  const { turns: restarted } = await fx.restart()
  assert.deepEqual(await restarted.send(original), { turnId, startedAt, status: 'aborted', reason: 'shutdown', duplicate: true })
  await assert.rejects(restarted.send({ ...original, text: 'wrong' }), httpError(409, 'client_request_conflict'))
  assert.equal(calls.length, 1)
})

test('crash after dispatch leaves a running ledger record; restart displays interrupted and never replays it', testOptions, async t => {
  const arrived = Promise.withResolvers()
  const fx = await fixture(t, (call, res) => {
    sse(res)
    frame(res, { content: 'not yet persisted' })
    arrived.resolve(call)
  })
  const { turns, journal, calls, keyFile, origin, dataDir, readSession } = fx
  const { id } = turns.create()
  await turns.close()
  journal.close()
  const source = `
    import { openVault } from ${JSON.stringify(new URL('../src/storage/vault.mjs', import.meta.url).href)}
    import { openSettings } from ${JSON.stringify(new URL('../src/business/settings.mjs', import.meta.url).href)}
    import { createEventJournal } from ${JSON.stringify(new URL('../src/events/index.mjs', import.meta.url).href)}
    import { createTextTurns } from ${JSON.stringify(new URL('../src/chat/text-turns.mjs', import.meta.url).href)}
    const [dataDir,keyFile,origin,sid,model] = process.argv.slice(1)
    const vault = await openVault({ dataDir, keyFile })
    const settings = await openSettings({ dataDir, vault })
    const turns = createTextTurns({ dataDir, settings, journal: createEventJournal(), version: 'fixture', allowedOrigins: [origin] })
    await turns.send({ sid, clientRequestId: 'client-1', text: 'Hello, loopback!', model })
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, dataDir, keyFile, origin, id, model], { stdio: ['ignore', 'ignore', 'inherit'] })
  const exited = once(child, 'exit')
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited })
  const call = await Promise.race([arrived.promise, exited.then(() => assert.fail('child exited before model dispatch'))])
  const started = (await readSession(id))._devaHeadlessTextTurns.requests[0]
  child.kill('SIGKILL')
  assert.deepEqual(await exited, [null, 'SIGKILL'])
  await call.closed
  const { turns: recovered } = fx.openTurns()
  const restored = recovered.snapshot(id).state
  assert.equal(restored.active, null)
  assert.deepEqual(restored.messages, [{ role: 'user', content: 'Hello, loopback!' }])
  const terminal = { turnId: started.turnId, startedAt: started.startedAt, status: 'interrupted', reason: 'interrupted' }
  assert.deepEqual(restored.lastTurn, terminal)
  assert.deepEqual(await recovered.send(request(id)), { ...terminal, duplicate: true })
  await assert.rejects(recovered.send(request(id, 'client-1', 'changed')), httpError(409, 'client_request_conflict'))
  assert.equal(calls.length, 1)
  const next = await recovered.send(request(id, 'client-2', 'Continue after restart'))
  await recovered.close() // Accepted new ID, then stop it before the model for deterministic wire assertions.
  assert.equal((await readSession(id))._devaHeadlessTextTurns.requests[0].status, 'interrupted')
  assert.equal(recovered.snapshot(id).state.lastTurn.turnId, next.turnId)
  assert.equal(calls.length, 1)
})

test('native non-text or damaged compacted histories are marked unsupported and left untouched', testOptions, async t => {
  const { turns, dataDir, chatsDir, calls } = await fixture(t)
  const store = createChatStore({ dataDir })
  const examples = [
    ['legacy-text', textPart('original desktop text')],
    ['legacy-tool', [{ type: 'tool_use', id: 'legacy-tool-id', name: 'desktop_tool', input: { hidden: true } }]],
    ['legacy-attachment', [{ type: 'document', mediaType: 'application/pdf', data: 'YQ==' }]],
    ['legacy-missing-blob', [{ type: 'image', mediaType: 'image/png', blob: 'a'.repeat(64) }]],
    ['legacy-incomplete', textPart('readable suffix only')]
  ]
  for (const [id, content] of examples) {
    const s = store.ensureSession(id)
    s.messages = [{ role: id === 'legacy-tool' ? 'assistant' : 'user', content }]
    store.saveStrict(id)
  }
  const incompleteFile = join(chatsDir, 'legacy-incomplete.json')
  const broken = JSON.parse(await fs.readFile(incompleteFile, 'utf8'))
  broken.compacted = { file: 'legacy-incomplete.compacted-missing.jsonl', count: 1 }
  await fs.writeFile(incompleteFile, JSON.stringify(broken))
  assert.equal(turns.list().length, examples.length)
  for (const [id] of examples) {
    const path = join(chatsDir, `${id}.json`)
    const before = await fs.readFile(path, 'utf8')
    const { state } = turns.snapshot(id)
    const legacyText = id === 'legacy-text'
    assert.equal(state.compatibility, legacyText ? 'legacy_text' : 'unsupported')
    assert.deepEqual(state.messages, legacyText ? [{ role: 'user', content: 'original desktop text' }] : null)
    assert.equal(state.writable, false)
    await assert.rejects(turns.send(request(id)), httpError(409, legacyText ? 'read_only_session' : 'unsupported_history'))
    assert.equal(await fs.readFile(path, 'utf8'), before)
  }
  assert.equal(calls.length, 0)
})

test('strict save failure before upstream admission gives no ACK, event, or invisible background request', testOptions, async t => {
  const { turns, calls, chatsDir, readSession } = await fixture(t)
  const { id } = turns.create()
  const before = turns.snapshot(id)
  await fs.mkdir(join(chatsDir, '_index.pending')) // Real shared-store failure, before session replacement.
  await assert.rejects(turns.send(request(id)), httpError(503, 'chat_storage_unconfirmed'))
  await assert.rejects(turns.send(request(id)), httpError(503, 'chat_storage_unconfirmed'))
  const after = turns.snapshot(id)
  assert.deepEqual(after.cursor, before.cursor)
  assert.deepEqual(after.state, { ...before.state, writable: false, writeBlockReason: 'chat_storage_unconfirmed' })
  assert.deepEqual((await readSession(id)).messages, [])
  assert.equal(calls.length, 0)
})

test('terminal save failure invalidates live output without claiming it is durable or allowing replay', testOptions, async t => {
  let response
  const { turns, calls, chatsDir, readSession } = await fixture(t, (_call, res) => {
    response = res
    sse(res)
    frame(res, { content: 'unconfirmed reply' })
  })
  const { id } = turns.create()
  const watcher = watch(t, turns, id)
  const sent = await turns.send(request(id))
  await watcher.wait('text_delta', sent.turnId)
  await fs.mkdir(join(chatsDir, '_index.pending'))
  finish(response)
  assert.equal((await watcher.wait('done', sent.turnId)).event.stopReason, 'error')
  const { state } = turns.snapshot(id)
  assert.deepEqual(state.lastTurn, { turnId: sent.turnId, startedAt: sent.startedAt, status: 'failed', reason: 'storage_unconfirmed' })
  assert.deepEqual(state.messages.map(m => m.content), ['Hello, loopback!'])
  assert.equal((await readSession(id))._devaHeadlessTextTurns.requests[0].status, 'running')
  await assert.rejects(turns.send(request(id)), httpError(503, 'chat_storage_unconfirmed'))
  assert.equal(calls.length, 1)
})

test('model error and unrequested tool sanitize terminal output and terminate the provider iterator', testOptions, async t => {
  let ix = 0
  const { turns, calls, readSession, origin } = await fixture(t, (_call, res) => {
    sse(res)
    frame(res, { content: 'safe partial' })
    if (ix++ === 0) {
      frame(res, { tool_calls: [{ index: 0, id: 'unexpected-call', function: { name: 'unrequested', arguments: JSON.stringify({ secret: key }) } }] }, 'tool_calls')
    } else {
      res.write(`data: ${JSON.stringify({ error: { message: `${key} ${cookie} raw provider error` } })}\n\n`)
    }
    // No EOF: a correct consumer actively closes each abandoned stream.
  })
  const { id } = turns.create()
  const watcher = watch(t, turns, id)
  for (const reason of ['unexpected_tool', 'model_failed']) {
    const sent = await turns.send(request(id, `req-${reason}`))
    assert.equal((await watcher.wait('done', sent.turnId)).event.stopReason, 'error')
    await calls.at(-1).closed
    const state = turns.snapshot(id).state
    assert.equal(state.lastTurn.reason, reason)
    assert.equal(state.messages.at(-1).content, 'safe partial')
    const output = JSON.stringify([await readSession(id), watcher.events, state])
    for (const secret of [key, cookie, origin, 'unrequested', 'raw provider error', 'tool_use']) assert.equal(output.includes(secret), false)
  }
  assert.equal(calls.length, 2)
})

test('bounded ledger retains the oldest request at capacity and rejects only new IDs', testOptions, async t => {
  const fx = await fixture(t)
  const { id } = fx.turns.create()
  await fx.turns.close()
  const store = createChatStore({ dataDir: fx.dataDir })
  const s = store.getSession(id)
  const text = 'Hello, loopback!'
  const fingerprint = createHash('sha256').update(JSON.stringify([model, text])).digest('hex')
  const requests = Array.from({ length: 255 }, (_, i) => ({
    clientRequestId: `seed-${i}`, fingerprint, turnId: randomUUID(), startedAt: i + 1, status: 'aborted', reason: 'stopped'
  }))
  s.messages = requests.map(() => ({ role: 'user', content: textPart(text) }))
  s._devaHeadlessTextTurns = { version: 1, messageCount: s.messages.length, requests }
  store.saveStrict(id)
  const { turns } = await fx.restart()
  const watcher = watch(t, turns, id)
  const last = await turns.send(request(id, 'last'))
  turns.stop({ sid: id, turnId: last.turnId })
  await watcher.wait('done', last.turnId)
  const { state } = turns.snapshot(id)
  assert.equal(state.turnLimit, 256)
  assert.equal(state.writable, false)
  assert.equal(state.writeBlockReason, 'session_turn_limit')
  await assert.rejects(turns.send(request(id, 'new')), httpError(409, 'session_turn_limit'))
  assert.deepEqual(await turns.send(request(id, 'seed-0')), {
    turnId: requests[0].turnId, startedAt: 1, status: 'aborted', reason: 'stopped', duplicate: true
  })
  assert.equal(fx.calls.length, 0)
})

test('oversized reply is cut to the active limit, saved as partial, and releases the transport', testOptions, async t => {
  const { turns, calls, readSession } = await fixture(t, (_call, res) => {
    sse(res)
    frame(res, { content: '0123456789'.repeat(7000) })
  })
  const { id } = turns.create()
  const watcher = watch(t, turns, id)
  const sent = await turns.send(request(id))
  assert.equal((await watcher.wait('done', sent.turnId)).event.stopReason, 'max_tokens')
  await calls[0].closed
  const { state } = turns.snapshot(id)
  assert.equal(state.lastTurn.reason, 'truncated')
  assert.equal(state.messages.at(-1).content.length, 64 * 1024)
  assert.equal((await readSession(id)).messages.at(-1).content[0].text, state.messages.at(-1).content)
})
