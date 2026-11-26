import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Resolve the existing Vite dependency's esbuild; this test needs no new workspace dependency.
const requireDesktop = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = createRequire(requireDesktop.resolve('vite/package.json'))('esbuild')
const entry = 'apps/desktop/src/main/providers/core.ts'
const { metafile, outputFiles } = await build({
  absWorkingDir: fileURLToPath(new URL('../../../', import.meta.url)),
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  metafile: true,
  write: false
})
const api = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`)
const { createProviderCore } = api
const MOCK_KEY = 'fixture-key-not-a-real-credential'
const timeout = { timeout: 5000 }

function provider(deps = {}) {
  return createProviderCore({
    httpFetch: globalThis.fetch,
    describeNetError: () => 'fixture transport error',
    getAppVersion: () => '9.8.7',
    getSecret: async (id) => id === 'fixture' ? MOCK_KEY : null,
    providerCustomHeaders: () => ({
      'X-Mock-Tenant': '  fixture-tenant  ',
      Authorization: 'should-not-override-auth',
      'X-Api-Key': 'should-not-override-auth'
    }),
    isEn: () => true,
    ...deps
  })
}

async function upstream(t, respond) {
  const calls = []
  const server = createServer(async (req, res) => {
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = Buffer.concat(chunks).toString('utf8')
      const call = { url: req.url, method: req.method, headers: req.headers, body: body ? JSON.parse(body) : null }
      calls.push(call)
      respond(call, res)
    } catch (err) {
      res.destroy(err)
    }
  })
  t.after(() => {
    const closed = new Promise((resolve) => server.close(resolve))
    server.closeAllConnections()
    return closed
  })
  await once(server.listen(0, '127.0.0.1'), 'listening')
  return { base: `http://127.0.0.1:${server.address().port}`, calls }
}

const config = (baseURL, adapter = 'openai') => ({ baseURL, adapter, providerId: 'fixture' })
const request = { model: 'fixture-model', messages: [{ role: 'user', content: 'ping' }] }
const chatChunk = (delta, finish_reason) => ({ choices: [{ delta, finish_reason }] })
const frame = (data) => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`
function sendSSE(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end(events.map(frame).join(''))
}
async function collect(source) {
  const events = []
  for await (const event of source) events.push(event)
  return events
}

// Deliberately no external/alias settings and no Electron injection: validate both the graph and
// the ESM API imported by the real Node process as an independent bundle.
test('the Node bundle has a public factory and only a Node builtin import', () => {
  const [output] = Object.values(metafile.outputs)
  assert.equal(output.entryPoint, entry)
  assert.ok(Object.keys(metafile.inputs).every((path) =>
    /^apps\/desktop\/src\/(main\/providers\/|shared\/)/.test(path) &&
    !/\/(index|types)\.ts$/.test(path)
  ))
  assert.deepEqual([...new Set(output.imports.map(({ path, external }) => `${external}:${path}`))], ['true:node:crypto'])
  assert.equal(typeof api.normalizeMessages, 'function')
  assert.equal(typeof createProviderCore, 'function')
  assert.deepEqual(Object.keys(provider()).sort(), ['listModels', 'streamChat'])
})

test('listModels injects auth only upstream and preserves the IPC result shape', timeout, async (t) => {
  const { base, calls } = await upstream(t, ({ url, headers }, res) => {
    switch (url) {
      case '/api/models':
        res.end(JSON.stringify({ data: [{ id: 'z' }, { name: 'a' }, { id: 'z' }, { id: 1 }, null] }))
        break
      case '/bad/models':
        res.end('not JSON')
        break
      case '/auth/models':
        res.writeHead(401).end(`rejected ${headers.authorization}`)
        break
      default:
        res.destroy()
    }
  })
  const core = provider()
  const actual = await core.listModels(config(` ${base}/api/// `))
  const auth = await core.listModels(config(`${base}/auth`))
  assert.deepEqual(actual, { ok: true, models: ['a', 'z'] })
  assert.deepEqual(auth, { ok: false, kind: 'auth', message: 'Authentication failed (401). Check your API key.' })
  assert.ok(!JSON.stringify([actual, auth]).includes(MOCK_KEY))
  assert.deepEqual(await core.listModels(config(`${base}/bad`)), { ok: true, models: [] })
  assert.deepEqual(await core.listModels(config(`${base}/offline`)), {
    ok: false, kind: 'network', message: 'fixture transport error'
  })
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].headers.authorization, `Bearer ${MOCK_KEY}`)
  assert.equal(calls[0].headers['user-agent'], 'deva/9.8.7')
  assert.equal(calls[0].headers['x-mock-tenant'], 'fixture-tenant')
  assert.equal(calls[0].headers['x-opencode-session'], undefined)
  assert.equal(calls[0].headers['x-api-key'], undefined)
})

test('OpenAI Chat streams text, thinking, usage and done through real HTTP', timeout, async (t) => {
  const { base, calls } = await upstream(t, (_call, res) => sendSSE(res, [
    chatChunk({ reasoning_content: 'checking' }),
    chatChunk({ content: 'pong' }),
    chatChunk({}, 'stop'),
    { choices: [], usage: { prompt_tokens: 13, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 7 } } },
    '[DONE]'
  ]))
  const messages = [{ role: 'user', content: 'first' }, { role: 'user', content: [{ type: 'text', text: 'second' }] }]
  const original = structuredClone(messages)
  const events = await collect(provider().streamChat(config(`${base}/v1/`), { ...request, messages }))
  assert.deepEqual(events, [
    { type: 'thinking_delta', text: 'checking' },
    { type: 'text_delta', text: 'pong' },
    { type: 'usage', input: 13, output: 4, cacheRead: 7 },
    { type: 'done', stopReason: 'end_turn' }
  ])
  assert.ok(!JSON.stringify(events).includes(MOCK_KEY))
  assert.deepEqual(messages, original)
  assert.equal(calls[0].url, '/v1/chat/completions')
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].headers.authorization, `Bearer ${MOCK_KEY}`)
  assert.equal(calls[0].headers['x-mock-tenant'], 'fixture-tenant')
  assert.deepEqual(calls[0].body, {
    model: 'fixture-model', messages: [{ role: 'user', content: 'first\nsecond' }],
    stream: true, stream_options: { include_usage: true }
  })
  assert.ok(!JSON.stringify(calls[0].body).includes(MOCK_KEY))
})

test('OpenAI preserves HTTP error normalization and Retry-After', timeout, async (t) => {
  const { base } = await upstream(t, (_call, res) => res.writeHead(429, { 'retry-after': '2' }).end('slow down'))
  assert.deepEqual(await collect(provider().streamChat(config(base), request)), [
    {
      type: 'error',
      error: { kind: 'rate_limit', retryable: true, retryAfterMs: 2000, message: 'Rate limited (429). Try again later: slow down' }
    },
    { type: 'done', stopReason: 'error' }
  ])
})

test('OpenAI abort before headers releases the pending HTTP request', timeout, async (t) => {
  let onRequest, onDisconnect
  const requested = new Promise((resolve) => { onRequest = resolve })
  const disconnected = new Promise((resolve) => { onDisconnect = resolve })
  const { base } = await upstream(t, (_call, res) => {
    res.on('close', onDisconnect)
    onRequest()
  })
  const ctrl = new AbortController()
  const result = collect(provider().streamChat(config(base), { ...request, signal: ctrl.signal }))
  await requested
  ctrl.abort()
  assert.deepEqual(await result, [{ type: 'done', stopReason: 'aborted' }])
  await disconnected
})

test('OpenAI abort after the first event terminates the HTTP response', timeout, async (t) => {
  let disconnect
  const disconnected = new Promise((resolve) => { disconnect = resolve })
  const { base } = await upstream(t, (_call, res) => {
    res.on('close', disconnect)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(frame(chatChunk({ content: 'started' })))
    // Leave the upstream open so the test verifies that the client closes it.
  })
  const ctrl = new AbortController()
  const stream = provider().streamChat(config(base), { ...request, signal: ctrl.signal })
  assert.deepEqual(await stream.next(), { done: false, value: { type: 'text_delta', text: 'started' } })
  ctrl.abort()
  assert.deepEqual(await collect(stream), [{ type: 'done', stopReason: 'aborted' }])
  await disconnected
})

test('DSML split across deltas is recovered only when tools are supplied', timeout, async (t) => {
  const left = '<｜DS'
  const right = 'ML｜tool_calls><｜DSML｜invoke name="fixture_tool">' +
    '<｜DSML｜parameter name="value" string="true">one</｜DSML｜parameter>' +
    '</｜DSML｜invoke></｜DSML｜tool_calls>'
  const { base } = await upstream(t, (_call, res) => sendSSE(res, [
    chatChunk({ content: left }), chatChunk({ content: right }), chatChunk({}, 'stop'), '[DONE]'
  ]))
  const core = provider()
  const events = await collect(core.streamChat(config(base), {
    ...request, tools: [{ name: 'fixture_tool', description: 'fixture', inputSchema: { type: 'object' } }]
  }))
  assert.equal(typeof events[0]?.id, 'string')
  assert.deepEqual(events, [
    { type: 'tool_call', id: events[0].id, name: 'fixture_tool', args: { value: 'one' } },
    { type: 'done', stopReason: 'tool_use' }
  ])
  assert.deepEqual(await collect(core.streamChat(config(base), request)), [
    { type: 'text_delta', text: left }, { type: 'text_delta', text: right }, { type: 'done', stopReason: 'end_turn' }
  ])
})

test('Anthropic and Responses preserve routes, auth, and cache accounting', timeout, async (t) => {
  const { base, calls } = await upstream(t, ({ url }, res) => {
    if (url === '/anth/v1/messages') {
      sendSSE(res, [
        { type: 'message_start', message: { usage: { input_tokens: 3, cache_creation_input_tokens: 4, cache_read_input_tokens: 5 } } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'anthropic' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }
      ])
    } else if (url === '/resp/responses') {
      sendSSE(res, [
        { type: 'response.output_text.delta', delta: 'responses' },
        { type: 'response.completed', response: { usage: { input_tokens: 8, output_tokens: 3, input_tokens_details: { cached_tokens: 2 } } } }
      ])
    } else res.writeHead(404).end()
  })
  const core = provider()
  assert.deepEqual(await collect(core.streamChat(config(`${base}/anth/`, 'anthropic'), request)), [
    { type: 'text_delta', text: 'anthropic' },
    { type: 'usage', input: 12, output: 7, cacheRead: 5, cacheWrite: 4 },
    { type: 'done', stopReason: 'end_turn' }
  ])
  assert.deepEqual(await collect(core.streamChat(config(`${base}/resp/`, 'responses'), request)), [
    { type: 'text_delta', text: 'responses' },
    { type: 'usage', input: 8, output: 3, cacheRead: 2 },
    { type: 'done', stopReason: 'end_turn' }
  ])
  assert.equal(calls[0].headers['x-api-key'], MOCK_KEY)
  assert.equal(calls[0].headers['anthropic-version'], '2023-06-01')
  assert.equal(calls[1].headers.authorization, `Bearer ${MOCK_KEY}`)
  assert.equal(calls[1].body.store, false)
})

test('OpenCode keeps its inference model URL and per-chat or fallback session headers', timeout, async (t) => {
  const { base, calls } = await upstream(t, ({ method }, res) => {
    if (method === 'GET') res.end(JSON.stringify({ models: [{ name: 'fixture-model' }] }))
    else sendSSE(res, [chatChunk({}, 'stop'), '[DONE]'])
  })
  const urls = []
  const transport = (url, init) => {
    const remote = new URL(url)
    assert.equal(remote.hostname, 'opencode.ai')
    urls.push(remote.href)
    // Exercise the true OpenCode URL calculation; only route the wire request to the loopback fixture.
    return fetch(new URL(remote.pathname, base), init)
  }
  const core = provider({ httpFetch: transport })
  const go = config('https://opencode.ai/inference/go/openai/v1/')
  const paid = config('https://opencode.ai/inference/anthropic/v1', 'anthropic')
  assert.deepEqual(await core.listModels(go), { ok: true, models: ['fixture-model'] })
  assert.deepEqual(await core.listModels(paid), { ok: true, models: ['fixture-model'] })
  await collect(core.streamChat(go, { ...request, sessionId: '  chat-session  ' }))
  const overridden = provider({
    httpFetch: transport,
    providerCustomHeaders: () => ({ 'User-Agent': 'fixture/1.0', 'X-OpenCode-Session': 'override' })
  })
  await collect(overridden.streamChat(go, { ...request, sessionId: 'chat-session' }))
  assert.deepEqual(urls, [
    'https://opencode.ai/inference/go/v1/models',
    'https://opencode.ai/inference/v1/models',
    'https://opencode.ai/inference/go/openai/v1/chat/completions',
    'https://opencode.ai/inference/go/openai/v1/chat/completions'
  ])
  assert.match(calls[0].headers['x-opencode-session'], /^deva-[a-f0-9-]{36}$/)
  assert.equal(calls[1].headers['x-opencode-session'], calls[0].headers['x-opencode-session'])
  assert.equal(calls[1].headers['x-api-key'], MOCK_KEY)
  assert.equal(calls[2].headers['x-opencode-session'], 'chat-session')
  assert.equal(calls[3].headers['x-opencode-session'], 'override')
  assert.equal(calls[3].headers['user-agent'], 'fixture/1.0')
})
