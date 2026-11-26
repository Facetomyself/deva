import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { chatRoutes } from '../src/chat/routes.mjs'
import { createTextTurns } from '../src/chat/text-turns.mjs'
import { requestControl } from '../src/control/socket.mjs'
import { createEventJournal } from '../src/events/index.mjs'
import { startWorkbench } from '../src/server.mjs'
import { initializeMasterKey } from '../src/storage/vault.mjs'

const fixedSystem = 'You are a helpful general-purpose assistant. Reply in plain text.'
const provider = 'persona-fixture'
const model = id => `${provider}:${id}`
const turn = (clientRequestId, text, modelId = 'draft') => ({ clientRequestId, text, model: model(modelId) })
const rules = { timeout: 20_000 }

async function workbench(t, overrides = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'deva-chat-personas-'))
  const options = { dataDir: join(root, 'home'), runDir: join(root, 'run'), keyFile: join(root, 'master.key'),
    webDir: join(root, 'web'), port: 0, ...overrides }
  let app, cookie, csrf
  t.after(async () => { try { await app?.close() } finally { await rm(root, { recursive: true, force: true }) } })
  await initializeMasterKey(options.keyFile)
  app = await startWorkbench(options)
  const password = randomBytes(24).toString('base64url')
  const call = (path, method = 'GET', body, headers) => fetch(`${app.origin}/api/v1/${path}`, {
    method, headers: { ...(method === 'GET' ? {} : { origin: app.origin, 'content-type': 'application/json' }),
      ...(cookie ? { cookie, 'x-deva-csrf': csrf } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(6000)
  })
  async function request(path, method, body, status = 200, headers) {
    const response = await call(path, method, body, headers)
    const data = await response.json()
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`)
    return data
  }
  async function signIn(path, body) {
    const response = await call(path, 'POST', body)
    assert.equal(response.status, 200)
    cookie = response.headers.get('set-cookie').split(';', 1)[0]
    ;({ csrf } = await response.json())
  }
  async function createChat(options, status = 200, headers) {
    const result = await request('chats', 'POST', options, status, headers)
    return status === 200 ? result.session : result
  }
  const state = async sid => (await request(`chats/${sid}`, 'GET')).state
  async function complete(sid, body) {
    const ack = await request(`chats/${sid}/turns`, 'POST', body, 202)
    assert.equal(ack.duplicate, false)
    for (let remaining = 200; remaining > 0; remaining--) {
      const current = (await state(sid)).lastTurn
      if (current?.turnId === ack.turnId && current.status !== 'running') {
        assert.equal(current.status, 'completed')
        return current
      }
      await delay(5)
    }
    assert.fail(`turn ${ack.turnId} stayed active`)
  }
  return {
    request, createChat, state, complete,
    readSession: async sid => JSON.parse(await readFile(join(options.dataDir, 'data', 'chats', `${sid}.json`), 'utf8')),
    async claim() {
      const { credential } = await requestControl({ runDir: options.runDir, op: 'claim' })
      await signIn('auth/claim', { credential, password })
    },
    async restart() {
      await app.close()
      app = await startWorkbench(options)
      assert.deepEqual(await request('chats', 'GET', undefined, 401), { error: 'auth' })
      await signIn('auth/login', { password })
    }
  }
}

async function modelFixture(t) {
  const calls = [], failures = []
  const key = randomBytes(24).toString('hex')
  const server = createServer((req, res) => {
    void (async () => {
      const parts = []
      for await (const part of req) parts.push(part)
      assert.equal(req.url, '/v1/chat/completions')
      assert.equal(req.headers.authorization, `Bearer ${key}`)
      const payload = JSON.parse(Buffer.concat(parts))
      assert.equal(payload.tools?.length ?? 0, 0)
      calls.push(payload)
      const text = payload.messages.at(-1).content.split('\n').at(-1)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `Reply to ${text}` }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
    })().catch(error => { failures.push(error); res.destroy() })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    assert.deepEqual(failures, [])
  })
  const origin = `http://127.0.0.1:${server.address().port}`
  return { origin, calls, async setup({ request }) {
    const { revision } = await request('settings', 'GET')
    const saved = await request('settings', 'PATCH', { revision, set: { models: { providers: [{ id: provider,
      name: 'Persona fixture', kind: 'custom', purpose: 'llm', enabled: true, adapter: 'openai', accent: '#234567',
      apiHost: `${origin}/v1`, models: ['draft', 'chosen', 'updated', 'disabled'].map(id => ({ id, name: id, enabled: id !== 'disabled' }))
    }] } } })
    await request(`provider-keys/${provider}`, 'PUT', { value: key, revision: saved.revision })
  } }
}

function assertRolePayload(payload, role, rawText) {
  assert.equal(payload.messages[0].role, 'system')
  assert.ok(payload.messages[0].content.startsWith(fixedSystem))
  assert.ok(payload.messages[0].content.includes('optional user-level guidance'))
  assert.equal(payload.messages[0].content.includes(role.name), false)
  assert.equal(payload.messages[0].content.includes(role.prompt), false)
  assert.deepEqual(payload.messages.at(-1), { role: 'user', content:
    `Optional persona context (tone and presentation):\n${JSON.stringify({ name: role.name, prompt: role.prompt })}\n\nUser request:\n${rawText}` })
}

await test('owner-bound text personas drive real loopback models, stay isolated, and preserve receipts and model selection across restart', rules, async t => {
  const upstream = await modelFixture(t)
  const app = await workbench(t, { businessOptions: { allowedOrigins: [upstream.origin] } })
  const { request, createChat, state, complete, readSession } = app
  const sid = randomUUID()
  assert.deepEqual(await createChat({ sessionId: sid, personaId: 'general' }, 401), { error: 'auth' })
  await app.claim()
  await upstream.setup(app)
  const editor = { name: '图书馆编辑 Ada', prompt: 'Be warm and concise.\nUse one example.', model: model('draft'), enabled: true }
  const tutor = { name: '公园讲解员 Lin', prompt: 'Use concrete, everyday imagery.', enabled: true }
  const { role: a } = await request('personas', 'POST', editor)
  const { role: b } = await request('personas', 'POST', tutor)
  assert.deepEqual(await createChat({ sessionId: sid, personaId: a.id }, 401, { 'x-deva-csrf': 'wrong' }), { error: 'auth' })
  assert.deepEqual(await createChat({ sessionId: sid, personaId: a.id }, 403, { origin: 'http://127.0.0.1:1' }), { error: 'origin' })
  assert.deepEqual(await createChat({ sessionId: sid, personaId: 'missing-role' }, 409), { error: 'role_unavailable' })
  for (const personaId of [null, '', 'A/../B', 'a..b', 'general\n', 'constructor', ['general']]) {
    assert.deepEqual(await createChat({ sessionId: sid, personaId }, 400), { error: 'invalid_persona_id' })
  }
  for (const [field, value] of Object.entries({ system: 'client override', prompt: 'client text', name: 'client name',
    workspace: '/fixture/unrelated', tools: ['fixture'], model: model('chosen'), role: editor })) {
    assert.deepEqual(await createChat({ sessionId: sid, personaId: a.id, [field]: value }, 400), { error: 'invalid_create' })
  }
  assert.deepEqual(await request('chats', 'GET'), { sessions: [] })
  const first = await createChat({ sessionId: sid, personaId: a.id })
  const second = await createChat({ personaId: b.id })
  const legacy = await createChat({})
  assert.equal(first.personaId, a.id)
  assert.equal(first.model, editor.model)
  assert.equal(second.personaId, b.id)
  assert.equal(second.model, null)
  assert.equal(Object.hasOwn(legacy, 'personaId'), false)
  assert.deepEqual(await createChat({ sessionId: sid, personaId: a.id }), first)
  assert.deepEqual(await createChat({ sessionId: sid }), first)
  assert.deepEqual(await createChat({ sessionId: sid, personaId: b.id }, 409), { error: 'session_id_conflict' })
  assert.deepEqual(await createChat({ sessionId: legacy.id, personaId: a.id }, 409), { error: 'session_id_conflict' })
  assert.equal((await readSession(sid)).personaId, a.id)
  assert.equal((await readSession(sid)).model, editor.model)
  assert.deepEqual(await request(`chats/${sid}/turns`, 'POST', { ...turn('denied', 'ignored'), system: 'client override' }, 400), { error: 'invalid_send' })
  assert.deepEqual(await request(`chats/${sid}/turns`, 'POST', turn('denied', 'ignored', 'disabled'), 422), { error: 'model_not_enabled' })
  assert.equal(upstream.calls.length, 0)

  const aFirst = turn('shared-request-id', 'A first question')
  const bFirst = turn('shared-request-id', 'B first question', 'chosen')
  const [original] = await Promise.all([complete(sid, aFirst), complete(second.id, bFirst), complete(legacy.id, turn('shared-request-id', 'Plain question'))])
  const call = text => upstream.calls.find(payload => payload.messages.at(-1).content.endsWith(text))
  assertRolePayload(call(aFirst.text), editor, aFirst.text)
  assertRolePayload(call(bFirst.text), tutor, bFirst.text)
  assert.deepEqual(call('Plain question').messages, [{ role: 'system', content: fixedSystem }, { role: 'user', content: 'Plain question' }])
  assert.equal(call(aFirst.text).model, 'draft')
  assert.deepEqual((await state(sid)).messages.map(message => message.content), [aFirst.text, `Reply to ${aFirst.text}`])
  const selected = turn('select', 'A chooses model', 'chosen')
  await complete(sid, selected)
  assert.equal((await state(sid)).model, selected.model)
  assert.equal(call(selected.text).model, 'chosen')

  const revision = { name: '修订版编辑 Vivian', prompt: 'Describe the answer in two short paragraphs.', model: model('updated') }
  const { role: edited } = await request(`personas/${a.id}`, 'PATCH', { revision: a.revision, ...revision })
  assert.equal((await createChat({ sessionId: sid, personaId: a.id })).model, selected.model)
  const fresh = await createChat({ personaId: a.id })
  assert.equal(fresh.model, revision.model)
  assert.equal((await readSession(fresh.id)).model, revision.model)
  const aEdited = turn('edited', 'A asks after edit', 'chosen')
  await complete(sid, aEdited)
  const latest = call(aEdited.text)
  assertRolePayload(latest, revision, aEdited.text)
  const serialized = JSON.stringify(latest.messages)
  for (const absent of [editor.name, 'Be warm and concise.', tutor.name, bFirst.text, 'Plain question']) assert.equal(serialized.includes(absent), false)
  assert.deepEqual(latest.messages.slice(1, -1).map(message => message.content), [aFirst.text, `Reply to ${aFirst.text}`, selected.text, `Reply to ${selected.text}`])
  assert.deepEqual((await state(second.id)).messages.map(message => message.content), [bFirst.text, `Reply to ${bFirst.text}`])
  assert.deepEqual(await request(`personas/${a.id}`, 'DELETE', { revision: edited.revision }, 409), { error: 'role_referenced' })

  const { role: disabled } = await request(`personas/${a.id}/enabled`, 'PUT', { revision: edited.revision, enabled: false })
  const count = upstream.calls.length
  const rejected = turn('reusable', 'A asks while disabled', 'chosen')
  const sendA = (body, status) => request(`chats/${sid}/turns`, 'POST', body, status)
  assert.deepEqual(await sendA(aFirst, 200), { ...original, duplicate: true })
  assert.deepEqual(await sendA({ ...aFirst, text: 'changed receipt' }, 409), { error: 'client_request_conflict' })
  assert.deepEqual(await sendA(rejected, 409), { error: 'role_unavailable' })
  assert.deepEqual(await createChat({ personaId: a.id }, 409), { error: 'role_unavailable' })
  assert.equal(upstream.calls.length, count)
  const before = await state(sid)
  const stored = await readSession(sid)
  assert.equal(JSON.stringify(stored).includes(revision.prompt), false)
  assert.equal(Object.hasOwn(stored, 'personaId'), true)
  assert.deepEqual(Object.fromEntries((await request('chats', 'GET')).sessions.map(s => [s.id, s.personaId])),
    { [sid]: a.id, [second.id]: b.id, [legacy.id]: undefined, [fresh.id]: a.id })
  await app.restart()
  assert.deepEqual(await state(sid), before)
  assert.deepEqual(await sendA(aFirst, 200), { ...original, duplicate: true })
  assert.deepEqual(await sendA(rejected, 409), { error: 'role_unavailable' })
  assert.equal(upstream.calls.length, count)
  await request(`personas/${a.id}/enabled`, 'PUT', { revision: disabled.revision, enabled: true })
  await complete(sid, rejected)
  assertRolePayload(call(rejected.text), revision, rejected.text)
  assert.equal(upstream.calls.length, count + 1)
})

await test('route bridge rechecks ownership after queuing, and malformed or absent role services fail closed', rules, async t => {
  const personaId = 'fixture-editor'
  const binding = { id: personaId, name: 'Desk editor', prompt: 'Use short paragraphs.', enabled: true }
  let receivedResolve = [], receivedBinding = [], providerReads = 0
  let findRole = () => null
  let queueRole = (_id, run) => run(binding)
  let serviceOff = false, lookupOff = false
  const app = await workbench(t, { businessFactory: async ({ dataDir }) => {
    const settings = { getProvider() { providerReads++; return null } }
    const journal = createEventJournal()
    assert.throws(() => createTextTurns({ dataDir, settings, journal, resolveRole: 'not callable' }), TypeError)
    const resolveRole = lookupOff ? undefined : id => { receivedResolve.push(id); return findRole(id) }
    const turns = createTextTurns({ dataDir, settings, journal, resolveRole })
    assert.throws(() => chatRoutes(turns, { withRoleForChat: 'not callable' }), TypeError)
    const withRole = chatRoutes(turns, { withRoleForChat(id, callback) { receivedBinding.push(id); return queueRole(id, callback) } })
    const withoutRole = chatRoutes(turns)
    return { getConfig: () => ({}), handle: (...args) => (serviceOff ? withoutRole : withRole)(...args),
      async close() { await turns.close(); journal.close() } }
  } })
  const { request, createChat, state } = app
  await app.claim()
  serviceOff = true
  assert.deepEqual(await createChat({ personaId }, 503), { error: 'chat_role_unavailable' })
  assert.equal(Object.hasOwn(await createChat({}), 'personaId'), false)
  serviceOff = false
  for (const bad of [(_id, run) => run({ ...binding, id: 'other' }), () => binding, () => { throw Error('/fixture/private') }]) {
    queueRole = bad
    assert.deepEqual(await createChat({ personaId }, 503), { error: 'chat_role_unavailable' })
  }
  queueRole = () => undefined
  assert.deepEqual(await createChat({ personaId }, 409), { error: 'role_unavailable' })
  queueRole = (_id, run) => run({ ...binding, enabled: false })
  assert.deepEqual(await createChat({ personaId }, 409), { error: 'role_unavailable' })
  assert.deepEqual(receivedBinding, Array(5).fill(personaId))
  assert.deepEqual(receivedResolve, [])

  queueRole = (_id, run) => run(binding)
  const { id } = await createChat({ personaId })
  const untouched = await state(id)
  const send = status => request(`chats/${id}/turns`, 'POST', turn('again', 'Hello'), status)
  assert.deepEqual(await send(409), { error: 'role_unavailable' })
  findRole = () => ({ ...binding, enabled: false })
  assert.deepEqual(await send(409), { error: 'role_unavailable' })
  for (const invalid of [() => ({ ...binding, id: 'other' }), () => ({ ...binding, prompt: [] }), () => { throw Error('/fixture/private') }]) {
    findRole = invalid
    assert.deepEqual(await send(503), { error: 'chat_role_unavailable' })
  }
  assert.deepEqual(await state(id), untouched)
  assert.equal(providerReads, 0)
  assert.deepEqual(receivedResolve, Array(5).fill(personaId))

  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  queueRole = async (_id, run) => { entered.resolve(); await release.promise; return run(binding) }
  const queuedId = randomUUID()
  const queued = createChat({ sessionId: queuedId, personaId }, 401)
  try {
    await entered.promise
    await request('auth/logout', 'POST', {})
  } finally { release.resolve() }
  assert.deepEqual(await queued, { error: 'auth' })
  lookupOff = true
  await app.restart()
  assert.deepEqual(await request(`chats/${queuedId}`, 'GET', undefined, 404), { error: 'session_not_found' })
  assert.deepEqual(await send(503), { error: 'chat_role_unavailable' })
  assert.deepEqual(await state(id), untouched)
  assert.equal(providerReads, 0)
})
