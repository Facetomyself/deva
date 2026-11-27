import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, get as httpGet } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { requestControl } from '../src/control/socket.mjs'
import { startWorkbench } from '../src/server.mjs'
import { initializeMasterKey } from '../src/storage/vault.mjs'

export const bounds = { timeout: 20_000 }
export const networkTimeout = () => AbortSignal.timeout(4_000)
export const reads = 'conversation-status/reads'
export const chat = sid => `chats/${sid}`
export const read = sid => `${chat(sid)}/read-state`
export const usage = sid => `${chat(sid)}/context-usage`
export const observed = ({ state, cursor }) => ({ updatedAt: state.updatedAt, cursor })
export const reply = 'Private synthetic provider answer.'
export const question = 'Private synthetic conversation text.'
export const rolePrompt = 'Private synthetic role instruction.'
const fixtureKey = 'local-fixture-key-only'
export const fixtures = {
  openai: { model: 'fixture-chat', path: '/chat/v1/chat/completions', host: '/chat/v1', used: 1234, window: 12000 },
  anthropic: { model: 'fixture-claude', path: '/anthropic/v1/messages', host: '/anthropic', used: 1550, window: 14000 },
  responses: { model: 'fixture-responses', path: '/responses/v1/responses', host: '/responses/v1', used: 1666, window: 16000 }
}
export const modelRef = adapter => `qa-${adapter}:${fixtures[adapter].model}`
const disabled = { id: 'disabled', name: 'Disabled fixture', enabled: false, contextWindow: 18000 }
export const disabledRef = 'qa-openai:disabled'

const sse = data => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`

function wire(adapter, mode) {
  const { used } = fixtures[adapter]
  if (adapter === 'anthropic') return [
    [
      { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', content: [],
        usage: { input_tokens: 1100, cache_creation_input_tokens: 150, cache_read_input_tokens: 300, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } }
    ], [
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
      { type: 'message_stop' }
    ]
  ]
  if (adapter === 'responses') return [
    [{ type: 'response.output_text.delta', delta: reply }],
    [{ type: 'response.completed', response: { id: 'resp_fixture', status: 'completed',
      usage: { input_tokens: used, output_tokens: 7, input_tokens_details: { cached_tokens: 400 } } } }]
  ]
  return [
    [{ choices: [{ index: 0, delta: { content: reply }, finish_reason: null }] }],
    [
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ...(mode === 'missing' ? [] : [{ choices: [], usage: {
        prompt_tokens: mode === 'invalid' ? -123 : used, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 300 }
      } }]), '[DONE]'
    ]
  ]
}

function providerConfigs(origin) {
  return Object.entries(fixtures).map(([adapter, { model, host, window }]) => ({
    id: `qa-${adapter}`, name: `Local ${adapter} fixture`, kind: 'custom', purpose: 'llm', accent: '#234567',
    adapter, apiHost: `${origin}${host}`, enabled: true,
    models: [{ id: model, name: model, enabled: true, contextWindow: window }, ...(adapter === 'openai' ? [disabled] : [])]
  }))
}

function loopbackModel() {
  const calls = [], failures = []
  let nextMode = 'measured', finish
  const server = createServer((req, res) => {
    void (async () => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks))
      calls.push({ path: req.url, body })
      const adapter = Object.keys(fixtures).find(name => fixtures[name].path === req.url)
      assert.ok(adapter, `unexpected fixture path: ${req.url}`)
      assert.equal(req.method, 'POST')
      assert.equal(body.model, fixtures[adapter].model)
      assert.equal(body.stream, true)
      assert.equal(body.tools?.length ?? 0, 0)
      assert.equal(req.headers.cookie, undefined)
      if (adapter === 'anthropic') assert.equal(req.headers['x-api-key'], fixtureKey)
      else assert.equal(req.headers.authorization, `Bearer ${fixtureKey}`)
      const mode = nextMode
      nextMode = 'measured'
      const [start, end] = wire(adapter, mode)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(start.map(sse).join(''))
      if (mode === 'hold') {
        const hold = Promise.withResolvers()
        finish = hold.resolve
        res.once('close', hold.resolve)
        await hold.promise
        finish = undefined
      }
      if (!res.destroyed) res.end(end.map(sse).join(''))
    })().catch(error => { failures.push(error); res.destroy() })
  })
  return {
    calls, failures,
    async listen() {
      server.listen(0, '127.0.0.1')
      await once(server, 'listening', { signal: networkTimeout() })
      return `http://127.0.0.1:${server.address().port}`
    },
    async close() {
      finish?.()
      if (server.listening) {
        server.closeAllConnections()
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      }
    },
    mode(mode) { nextMode = mode },
    release() { assert.ok(finish, 'fixture is holding a stream'); finish() }
  }
}

// The session-list stream sends unmasked, single-frame text messages. Use a real upgrade with
// owner credentials without requiring package-mounted tests to import a WebSocket client library.
async function openListPeer(origin, cookie, peers) {
  const req = httpGet(`${origin}/api/v1/chats/stream`, { signal: networkTimeout(), headers: {
    origin, cookie, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13',
    'sec-websocket-key': randomBytes(16).toString('base64')
  } })
  req.once('response', response => { response.resume(); req.destroy(Error(`list upgrade: ${response.statusCode}`)) })
  const [response, socket, head] = await once(req, 'upgrade', { signal: networkTimeout() })
  peers.add(socket)
  socket.once('close', () => peers.delete(socket))
  socket.setTimeout(4_000, () => socket.destroy())
  assert.equal(response.statusCode, 101)
  const input = socket.iterator({ destroyOnReturn: false })
  let buffer = head
  async function fill(size) {
    while (buffer.length < size) {
      const { value, done } = await input.next()
      assert.equal(done, false, 'session-list stream closed before the expected frame')
      buffer = Buffer.concat([buffer, value])
    }
  }
  return {
    close: () => socket.destroy(),
    async next() {
      await fill(2)
      assert.equal(buffer[0], 0x81, 'expected a single text frame')
      assert.equal(buffer[1] & 0x80, 0, 'server frames must be unmasked')
      let len = buffer[1], offset = 2
      if (len === 126) { offset = 4; await fill(offset); len = buffer.readUInt16BE(2) }
      assert.ok(len < 1024, 'only small session-list invalidations are expected')
      await fill(offset + len)
      const frame = JSON.parse(buffer.subarray(offset, offset + len).toString('utf8'))
      buffer = buffer.subarray(offset + len)
      return frame
    }
  }
}

export async function workbench(t, { seed } = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'deva-conversation-status-'))
  const opts = { dataDir: join(root, 'home'), runDir: join(root, 'run'), keyFile: join(root, 'master.key'),
    webDir: join(root, 'web'), port: 0 }
  const chatsDir = join(opts.dataDir, 'data', 'chats')
  const readFilePath = join(opts.dataDir, 'read-state.json')
  const configPath = join(opts.dataDir, 'config.json')
  const sessionFile = sid => join(chatsDir, `${sid}.json`)
  const password = randomBytes(24).toString('base64url'), upstream = loopbackModel(), peers = new Set()
  let app
  const closeApp = async () => {
    for (const peer of peers) peer.destroy()
    await app?.close()
  }
  t.after(async () => {
    try { await closeApp() }
    finally {
      await upstream.close()
      await rm(root, { recursive: true, force: true })
    }
    assert.deepEqual(upstream.failures, [])
  })
  const providerOrigin = await upstream.listen()
  opts.businessOptions = { allowedOrigins: [providerOrigin] }
  await mkdir(chatsDir, { recursive: true, mode: 0o700 })
  await seed?.({ readFilePath, configPath, sessionFile })
  await initializeMasterKey(opts.keyFile)
  app = await startWorkbench(opts)

  function raw(path, { method = 'GET', body, headers = {} } = {}, login) {
    const fields = { ...(method === 'GET' || method === 'HEAD' ? {} : { origin: app.origin, 'content-type': 'application/json' }),
      ...(login ? { cookie: login.cookie, 'x-deva-csrf': login.csrf } : {}), ...headers }
    for (const key of Object.keys(fields)) if (fields[key] == null) delete fields[key]
    return fetch(`${app.origin}/api/v1/${path}`, { method, headers: fields, signal: networkTimeout(),
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) })
  }
  function client(cookie, csrf) {
    const login = { cookie, csrf }
    return {
      ...login,
      raw: (path, options) => raw(path, options, login),
      async request(path, { status = 200, ...options } = {}) {
        const res = await raw(path, options, login)
        const data = await res.json()
        assert.equal(res.status, status, `${options.method ?? 'GET'} ${path}: ${JSON.stringify(data)}`)
        return data
      },
      listPeer: () => openListPeer(app.origin, cookie, peers)
    }
  }
  async function login(path = 'auth/login', body = { password }) {
    const res = await raw(path, { method: 'POST', body })
    const data = await res.json()
    assert.equal(res.status, 200, JSON.stringify(data))
    return client(res.headers.get('set-cookie').split(';', 1)[0], data.csrf)
  }
  const { credential } = await requestControl({ runDir: opts.runDir, op: 'claim' })
  const owner = await login('auth/claim', { credential, password })
  const providers = providerConfigs(providerOrigin)
  const { revision } = await owner.request('settings')
  let saved = await owner.request('settings', { method: 'PATCH', body: {
    revision, set: { models: { providers, activeModelId: modelRef('openai'), activeEffort: 'default' } }
  } })
  for (const { id } of providers) saved = await owner.request(`provider-keys/${id}`, {
    method: 'PUT', body: { value: fixtureKey, revision: saved.revision }
  })
  async function untilSnapshot(sid, predicate, browser = owner) {
    for (let i = 0; i < 100; ++i) {
      const snap = await browser.request(chat(sid))
      if (predicate(snap.state)) return snap
      await delay(10)
    }
    assert.fail(`chat ${sid} did not reach the requested stream state`)
  }
  async function complete(sid, turnId, browser = owner) {
    const snap = await untilSnapshot(sid, state => !state.active && state.lastTurn?.turnId === turnId, browser)
    assert.equal(snap.state.lastTurn.status, 'completed')
    return snap
  }
  return {
    owner, login, raw, upstream, providers, providerOrigin, configPath, readFilePath, sessionFile, untilSnapshot, complete,
    get origin() { return app.origin },
    async restart(beforeOpen) { await closeApp(); await beforeOpen?.(); app = await startWorkbench(opts) },
    async create(sid, fields = {}) { return (await owner.request('chats', { method: 'POST', body: { sessionId: sid, ...fields } })).session },
    async send(sid, clientRequestId, model = null, text = question) {
      const ack = await owner.request(`${chat(sid)}/turns`, { method: 'POST', body: { clientRequestId, text, model }, status: 202 })
      assert.equal(ack.duplicate, false)
      return ack
    },
    async native(sid) { return JSON.parse(await readFile(sessionFile(sid), 'utf8')) },
    async nativeReads() { return JSON.parse(await readFile(readFilePath, 'utf8')) }
  }
}

export const writeJson = (path, data) => writeFile(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
export const post = (body, status = 200, headers) => ({ method: 'POST', body, status, headers })
export function assertPrivate(value, secrets) {
  const json = JSON.stringify(value)
  for (const secret of [fixtureKey, question, reply, rolePrompt, ...secrets]) assert.equal(json.includes(secret), false, `unexpected private fixture marker: ${secret}`)
}
