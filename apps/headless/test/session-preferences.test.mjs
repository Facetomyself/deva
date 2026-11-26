import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { promises as fs } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import WebSocket from 'ws'
import { createChatStore } from '../dist/chat-core.mjs'
import { requestControl } from '../src/control/socket.mjs'
import { startWorkbench } from '../src/server.mjs'
import { initializeMasterKey } from '../src/storage/vault.mjs'

const options = { timeout: 15_000 }
const providerId = 'preferences-fixture'
const model = id => `${providerId}:${id}`
const ledger = '_devaHeadlessTextTurns'
const attachments = '_devaHeadlessTurnAttachments'
const prefs = sid => `chats/${sid}/preferences`
const send = (clientRequestId, text, model) => ({ clientRequestId, text, model })
const reply = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'confirmed response' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`

async function fixture(t) {
  const tmp = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'deva-preferences-'))
  const keyFile = join(tmp, 'master.key')
  const password = randomBytes(24).toString('base64url')
  const key = randomBytes(24).toString('hex')
  const opts = { dataDir: join(tmp, 'deva-home'), keyFile, runDir: join(tmp, 'run'), webDir: join(tmp, 'web'), port: 0 }
  const chats = join(opts.dataDir, 'data', 'chats')
  const calls = [], failures = []
  const upstream = createServer((req, res) => {
    void (async () => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks))
      assert.equal(req.url, '/v1/chat/completions')
      assert.equal(req.headers.authorization, `Bearer ${key}`)
      assert.equal(body.tools?.length ?? 0, 0)
      assert.equal(Object.hasOwn(body, 'reasoning_effort'), false)
      calls.push(body)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (body.messages.at(-1).content === 'hold response') res.flushHeaders()
      else res.end(reply)
    })().catch(error => { failures.push(error); res.destroy() })
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const origin = `http://127.0.0.1:${upstream.address().port}`
  opts.businessOptions = { allowedOrigins: [origin] }
  let app
  t.after(async () => {
    await app?.close()
    upstream.closeAllConnections()
    await new Promise(resolve => upstream.close(resolve))
    await fs.rm(tmp, { recursive: true, force: true })
    assert.deepEqual(failures, [])
  })
  await initializeMasterKey(keyFile)
  app = await startWorkbench(opts)
  const endpoint = (path, method, body, headers = {}) => fetch(`${app.origin}/api/v1/${path}`, {
    method, headers: { ...(method === 'GET' ? {} : { origin: app.origin, 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) })
  })
  function scope(cookie, csrf) {
    const raw = (path, method, body, overrides) => endpoint(path, method, body, { cookie, 'x-deva-csrf': csrf, ...overrides })
    return {
      cookie, raw,
      request: async (path, method = 'GET', body, status = 200, overrides) => {
        const r = await raw(path, method, body, overrides)
        const json = await r.json()
        assert.equal(r.status, status, `${method} ${path}: ${JSON.stringify(json)}`)
        return json
      }
    }
  }
  async function login(path = 'auth/login', body = { password }) {
    const r = await endpoint(path, 'POST', body)
    assert.equal(r.status, 200)
    return scope(r.headers.get('set-cookie').split(';')[0], (await r.json()).csrf)
  }
  const { credential } = await requestControl({ runDir: opts.runDir, op: 'claim' })
  let owner = await login('auth/claim', { credential, password })
  const request = (...args) => owner.request(...args)
  const { revision } = await request('settings')
  const config = await request('settings', 'PATCH', { revision, set: { models: { activeModelId: model('first'), activeEffort: 'default', providers: [{
    id: providerId, name: 'Preferences fixture', kind: 'custom', purpose: 'llm', adapter: 'openai', accent: '#234567',
    apiHost: `${origin}/v1`, enabled: true, models: ['first', 'gpt-5.2', 'role', 'disabled'].map(id => ({ id, name: id, enabled: id !== 'disabled' }))
  }] } } })
  await request(`provider-keys/${providerId}`, 'PUT', { value: key, revision: config.revision })
  async function complete(sid, body, status = 202) {
    const ack = await request(`chats/${sid}/turns`, 'POST', body, status)
    for (let n = 0; n < 150; n++) {
      const { state } = await request(`chats/${sid}`)
      if (!state.active && state.lastTurn?.turnId === ack.turnId) return state
      await delay(10)
    }
    assert.fail('model stream did not end')
  }
  return {
    opts, chats, calls, origin, key, request, login, complete, endpoint,
    get owner() { return owner }, get originWeb() { return app.origin },
    async restart() { await app.close(); app = await startWorkbench(opts); owner = await login() },
    async disk(sid) { return JSON.parse(await fs.readFile(join(chats, `${sid}.json`), 'utf8')) }
  }
}

test('owner HTTP preferences enforce same scope, two-tab CAS, quiet no-op and native desktop ordering', options, async t => {
  const fx = await fixture(t)
  const { request } = fx
  const [sid, other, legacy, complex] = Array.from({ length: 4 }, randomUUID)
  await fs.mkdir(fx.chats, { recursive: true })
  const privateRoot = '/private/never-serialize-this-folder'
  const nativeSeed = { title: 'Desktop', createdAt: 1, updatedAt: 11, messages: [] }
  await fs.writeFile(join(fx.chats, `${legacy}.json`), JSON.stringify({ id: legacy, ...nativeSeed }))
  await fs.writeFile(join(fx.chats, `${complex}.json`), JSON.stringify({ id: complex, ...nativeSeed, focusRoot: privateRoot, members: [{ sessionId: legacy }] }))
  assert.equal((await fx.endpoint(prefs(sid), 'GET')).status, 401)
  assert.equal((await fx.endpoint(prefs(sid), 'PATCH', { set: { archived: true } })).status, 401)
  assert.deepEqual(await request(prefs(randomUUID()), 'GET', undefined, 404), { error: 'session_not_found' })
  assert.deepEqual(await request(prefs(legacy), 'GET', undefined, 409), { error: 'read_only_session' })
  assert.deepEqual(await request(prefs(complex), 'GET', undefined, 409), { error: 'unsupported_history' })
  assert.deepEqual(await request(prefs(complex), 'PATCH', { revision: 'a'.repeat(64), set: { archived: true } }, 409), { error: 'unsupported_history' })
  const { session } = await request('chats', 'POST', { sessionId: sid })
  await request('chats', 'POST', { sessionId: other })
  const tab = await fx.login()
  const first = await request(prefs(sid))
  assert.deepEqual(first.preferences, { title: '', customTitle: null, archived: false, model: null, effort: null })
  assert.deepEqual(await tab.request(prefs(sid)), first)
  assert.deepEqual(await request(prefs(other), 'PATCH', { revision: first.revision, set: { archived: true } }, 409), { error: 'preferences_conflict' })
  assert.deepEqual(await request(prefs(sid), 'PATCH', { revision: first.revision, set: { archived: true } }, 401, { 'x-deva-csrf': 'wrong' }), { error: 'auth' })
  assert.deepEqual(await request(prefs(sid), 'PATCH', { revision: first.revision, set: { archived: true } }, 403, { origin: fx.origin }), { error: 'origin' })
  for (const set of [{}, [], { folder: privateRoot }, { apiHost: fx.origin }, { sid: other }, { archived: 'false' }, { title: 'unknown' }, { customTitle: 1 }]) {
    assert.deepEqual(await request(prefs(sid), 'PATCH', { revision: first.revision, set }, 400), { error: 'invalid_preferences' })
  }
  const ws = new WebSocket(`${fx.originWeb.replace('http:', 'ws:')}/api/v1/chats/stream`, { headers: { origin: fx.originWeb, cookie: tab.cookie } })
  t.after(() => ws.terminate())
  const [initial] = await once(ws, 'message')
  assert.equal(JSON.parse(initial).t, 'sessions-snapshot')
  const events = []
  ws.on('message', wire => events.push(JSON.parse(wire)))
  const changed = once(ws, 'message')
  const second = await request(prefs(sid), 'PATCH', { revision: first.revision, set: { customTitle: '  New\n title ', archived: true } })
  const [wire] = await changed
  assert.deepEqual(Object.keys(JSON.parse(wire)), ['t', 'cursor'])
  assert.equal(JSON.parse(wire).t, 'sessions-changed')
  assert.equal(second.preferences.title, 'New title')
  assert.equal(second.preferences.customTitle, 'New title')
  assert.equal(second.preferences.archived, true)
  assert.deepEqual(await tab.request(prefs(sid), 'PATCH', { revision: first.revision, set: { archived: false } }, 409), { error: 'preferences_conflict' })
  const third = await request(prefs(sid), 'PATCH', { revision: second.revision, set: { archived: true } })
  assert.notEqual(third.revision, second.revision)
  assert.deepEqual(third.preferences, second.preferences)
  await delay(30)
  assert.equal(events.length, 1)
  const { sessions } = await request('chats')
  const entry = sessions.find(s => s.id === sid)
  assert.equal(entry.updatedAt, session.updatedAt)
  assert.equal(entry.archived, true)
  assert.equal(entry.customTitle, 'New title')
  const state = (await request(`chats/${sid}`)).state
  for (const secret of [privateRoot, fx.opts.dataDir, fx.origin, fx.key]) assert.ok(!JSON.stringify([state, sessions, third]).includes(secret))
  const desktop = createChatStore({ dataDir: fx.opts.dataDir })
  const { title, archived, updatedAt } = desktop.getSession(sid)
  assert.deepEqual({ title, archived, updatedAt }, { title: 'New title', archived: true, updatedAt: session.updatedAt })
  assert.deepEqual(desktop.listSessions().map(s => s.id), sessions.map(s => s.id))
  await fx.restart()
  assert.deepEqual(await request(prefs(sid)), third)
  const reset = await request(prefs(sid), 'PATCH', { revision: third.revision, set: { archived: false, customTitle: '' } })
  assert.deepEqual(reset.preferences, first.preferences)
  assert.notEqual(reset.revision, first.revision)
  assert.equal(Object.hasOwn(await fx.disk(sid), 'archived'), false)
  assert.deepEqual(await request(prefs(sid), 'PATCH', { revision: first.revision, set: { archived: true } }, 409), { error: 'preferences_conflict' })
  assert.equal(fx.calls.length, 0)
})

test('ordinary pins and follow intents affect later real provider wire without changing old charge receipts', options, async t => {
  const fx = await fixture(t)
  const { request, complete } = fx
  const { session: { id: sid } } = await request('chats', 'POST', {})
  const firstBody = send('legacy-accepted', 'first question', model('first'))
  await complete(sid, firstBody)
  const firstDisk = await fx.disk(sid)
  const first = await request(prefs(sid))
  assert.equal(first.preferences.title, firstBody.text)
  assert.equal(first.preferences.model, model('first'))
  assert.deepEqual(await request(prefs(sid), 'PATCH', { revision: first.revision, set: { model: model('disabled') } }, 422), { error: 'model_not_enabled' })
  assert.deepEqual(await request(prefs(sid), 'PATCH', { revision: first.revision, set: { model: model('gpt-5.2'), effort: 'high' } }, 422), { error: 'effort_unsupported' })
  assert.deepEqual(await request(prefs(sid), 'PATCH', { revision: first.revision, set: { effort: 'turbo' } }, 400), { error: 'invalid_effort' })
  const pin = await request(prefs(sid), 'PATCH', { revision: first.revision, set: { model: model('gpt-5.2'), customTitle: 'Pinned session', effort: 'default' } })
  assert.equal(pin.preferences.effort, 'default')
  assert.equal(fx.calls.length, 1)
  const afterPin = await fx.disk(sid)
  assert.deepEqual(afterPin[ledger], firstDisk[ledger])
  assert.deepEqual(afterPin.messages, firstDisk.messages)
  assert.equal(afterPin.updatedAt, firstDisk.updatedAt)
  assert.equal((await request(`chats/${sid}/turns`, 'POST', firstBody)).duplicate, true)
  assert.equal(fx.calls.length, 1)
  for (const wrong of [null, model('first')]) {
    assert.deepEqual(await request(`chats/${sid}/turns`, 'POST', send('new', 'stale', wrong), 409), { error: 'session_model_changed' })
  }
  const busy = await request(`chats/${sid}/turns`, 'POST', send('busy', 'hold response', model('gpt-5.2')), 202)
  assert.deepEqual(await request(prefs(sid), 'PATCH', { revision: pin.revision, set: { archived: true } }, 409), { error: 'turn_in_progress' })
  const stop = await request(`chats/${sid}/stop`, 'POST', { turnId: busy.turnId })
  assert.equal(stop.stopped, true)
  await complete(sid, send('busy', 'hold response', model('gpt-5.2')), 200)
  const pinned = await complete(sid, send('wire-pin', 'pin reaches wire', model('gpt-5.2')))
  assert.equal(fx.calls.at(-1).model, 'gpt-5.2')
  assert.equal(pinned.model, model('gpt-5.2'))
  assert.deepEqual(await request(prefs(sid)), pin)
  const follow = await request(prefs(sid), 'PATCH', { revision: pin.revision, set: { model: null, customTitle: null, effort: null } })
  assert.deepEqual(follow.preferences, { title: firstBody.text, customTitle: null, archived: false, model: null, effort: null })
  const follows = send('follow', 'first default', null)
  const firstFollow = await complete(sid, follows)
  assert.equal(firstFollow.model, null)
  assert.equal(fx.calls.at(-1).model, 'first')
  assert.equal((await fx.disk(sid)).model, '')
  const { revision } = await request('settings')
  await request('settings', 'PATCH', { revision, set: { models: { activeModelId: model('gpt-5.2') } } })
  const count = fx.calls.length
  assert.equal((await request(`chats/${sid}/turns`, 'POST', follows)).duplicate, true)
  assert.equal(fx.calls.length, count)
  const last = await complete(sid, send('second-follow', 'second default', null))
  assert.equal(last.model, null)
  assert.equal(fx.calls.at(-1).model, 'gpt-5.2')
  const stored = await fx.disk(sid)
  assert.equal(stored.model, '')
  assert.equal(stored[ledger].requests.find(r => r.clientRequestId === 'follow').model, model('first'))
  assert.equal(stored[ledger].requests.find(r => r.clientRequestId === 'second-follow').model, model('gpt-5.2'))
  await fx.restart()
  assert.deepEqual(await request(prefs(sid)), follow)
  assert.equal((await request(`chats/${sid}/turns`, 'POST', firstBody)).duplicate, true)
  assert.equal((await request(`chats/${sid}/turns`, 'POST', follows)).duplicate, true)
  assert.equal(fx.calls.length, count + 1)
})

test('verified role and attachment history survive metadata edits and strict disk failures are explicit', options, async t => {
  const fx = await fixture(t)
  const { request, complete } = fx
  const persona = { name: 'Preferences tester', prompt: 'Use a clear tone.', model: model('role'), enabled: true }
  const { role } = await request('personas', 'POST', persona)
  const { session: { id: sid } } = await request('chats', 'POST', { personaId: role.id })
  const initial = await request(prefs(sid))
  const follow = await request(prefs(sid), 'PATCH', { revision: initial.revision, set: { model: null } })
  const fileName = 'research notes.txt'
  const { attachment } = await request(`chats/${sid}/attachments`, 'POST', Buffer.from('Fixture attachment bytes\n'), 201,
    { 'content-type': 'application/octet-stream', 'x-deva-file-name': Buffer.from(fileName).toString('base64url'), 'x-deva-file-type': 'text/plain' })
  const attached = { ...send('with-attachment', '', null), attachments: [attachment.id] }
  const first = await complete(sid, attached)
  assert.equal(first.title, fileName)
  assert.equal(first.model, null)
  assert.deepEqual(first.messages[0].attachments, [attachment])
  assert.equal(fx.calls.at(-1).model, 'role')
  const before = await fx.disk(sid)
  const rev = await request(prefs(sid))
  assert.notEqual(rev.revision, follow.revision)
  const renamed = await request(prefs(sid), 'PATCH', { revision: rev.revision, set: { customTitle: 'Documents', archived: true } })
  const reset = await request(prefs(sid), 'PATCH', { revision: renamed.revision, set: { customTitle: null, archived: false } })
  assert.equal(reset.preferences.title, fileName)
  assert.equal(reset.preferences.customTitle, null)
  const committed = await fx.disk(sid)
  for (const field of [ledger, attachments, 'messages', 'updatedAt']) assert.deepEqual(committed[field], before[field])
  await request(`personas/${role.id}`, 'PATCH', { revision: role.revision, ...persona, model: model('gpt-5.2') })
  await complete(sid, send('after-role-update', 'With current role', null))
  assert.equal(fx.calls.at(-1).model, 'gpt-5.2')
  assert.equal(fx.calls.at(-1).messages.some(m => m.role === 'user' && m.content.includes('Fixture attachment bytes')), true)
  const candidate = await request(prefs(sid))
  const path = join(fx.chats, `${sid}.json`)
  const checked = await fx.disk(sid)
  // A writable parent can replace a 0400 inode, but a preference request must still respect read-only mode.
  await fs.chmod(path, 0o400)
  assert.deepEqual(await request(prefs(sid)), candidate)
  assert.deepEqual(await request(prefs(sid), 'PATCH', { revision: candidate.revision, set: { archived: true } }, 503), { error: 'chat_storage_unconfirmed' })
  assert.deepEqual(await fx.disk(sid), checked)
  await fs.chmod(path, 0o640)
  assert.deepEqual(await request(prefs(sid), 'PATCH', { revision: candidate.revision, set: { archived: true } }, 503), { error: 'chat_storage_unconfirmed' })
  assert.deepEqual(await fx.disk(sid), checked)
  await fs.chmod(path, 0o600)
  const oversized = randomUUID()
  const oversizedPath = join(fx.chats, `${oversized}.json`)
  await fs.writeFile(oversizedPath, '{}', { mode: 0o600 })
  await fs.truncate(oversizedPath, 128 * 1024 * 1024 + 1)
  assert.deepEqual(await request(prefs(oversized), 'GET', undefined, 503), { error: 'chat_storage_unconfirmed' })
  await fs.unlink(oversizedPath)
  const drifted = { ...checked, title: 'External native edit' }
  await fs.writeFile(path, JSON.stringify(drifted))
  assert.deepEqual(await request(prefs(sid), 'PATCH', { revision: candidate.revision, set: { archived: true } }, 409), { error: 'preferences_conflict' })
  assert.deepEqual(await request(prefs(sid), 'GET', undefined, 503), { error: 'chat_storage_unconfirmed' })
  assert.deepEqual(await fx.disk(sid), drifted)
  await fx.restart()
  const fresh = await request(prefs(sid))
  assert.equal(fresh.preferences.title, drifted.title)
  const index = join(fx.chats, '_index.json')
  await fs.unlink(index)
  await fs.mkdir(index)
  assert.deepEqual(await request(prefs(sid), 'PATCH', { revision: fresh.revision, set: { archived: true } }, 503), { error: 'chat_storage_unconfirmed' })
  assert.deepEqual(await request(prefs(sid), 'GET', undefined, 503), { error: 'chat_storage_unconfirmed' })
  assert.deepEqual(await request(prefs(sid), 'PATCH', { revision: fresh.revision, set: { archived: false } }, 503), { error: 'chat_storage_unconfirmed' })
  await fs.rmdir(index)
  const count = fx.calls.length
  await fx.restart()
  const recovered = await request(prefs(sid))
  assert.equal(recovered.preferences.archived, true)
  assert.notEqual(recovered.revision, fresh.revision)
  assert.deepEqual((await request(`chats/${sid}`)).state.messages[0].attachments, [attachment])
  assert.equal((await request(`chats/${sid}/turns`, 'POST', attached)).duplicate, true)
  assert.equal(fx.calls.length, count)
})
