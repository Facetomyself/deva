import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { connectProvider } from '../src/business/model-connection.mjs'

test('a server-owned model reference and bound credentials drive a real protocol stream', async t => {
  const seen = []
  const s = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c)
    const body = JSON.parse(Buffer.concat(chunks))
    seen.push({ path: req.url, model: body.model, auth: req.headers.authorization === 'Bearer bound-model-fixture', cookie: req.headers.cookie === 'tenant=bound-fixture' })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const chunk of ['model', ' response']) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] })}\n\n`)
    res.end('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  }); s.listen(0, '127.0.0.1'); await once(s, 'listening')
  t.after(async () => { s.closeAllConnections(); await new Promise(ok => s.close(ok)) })
  const origin = `http://127.0.0.1:${s.address().port}`
  const provider = { id: 'qa', adapter: 'openai', apiHost: origin + '/v1', apiKey: 'bound-model-fixture', enabled: true, purpose: 'llm', headers: { cookie: 'tenant=bound-fixture' }, models: [{ id: 'allowed-model', enabled: true }, { id: 'off', enabled: false }] }
  const settings = { getProvider: async id => id === 'qa' ? structuredClone(provider) : null }
  const opts = { version: 'test', allowedOrigins: [origin], modelId: 'allowed-model' }
  await assert.rejects(connectProvider(settings, 'unknown', opts), { code: 'provider_not_found' })
  await assert.rejects(connectProvider(settings, 'qa', { ...opts, modelId: 'off' }), { code: 'model_not_enabled' })
  const client = await connectProvider(settings, 'qa', opts)
  assert.deepEqual(Object.keys(client), ['listModels', 'streamChat'])
  const events = []; for await (const e of client.streamChat({ model: 'ignored', messages: [{ role: 'user', content: 'hello' }], tools: [] })) events.push(e)
  assert.equal(events.filter(e => e.type === 'text_delta').map(e => e.text).join(''), 'model response')
  assert.ok(events.some(e => e.type === 'done')); assert.deepEqual(seen, [{ path: '/v1/chat/completions', model: 'allowed-model', auth: true, cookie: true }])
})
