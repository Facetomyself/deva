// Runs inside the shipping container before and after `docker compose up --force-recreate`.
// Only the fixed, local fixture below is accepted; this check never contacts a real provider.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'

const { DEVA_ORIGIN: origin, DEVA_WEB_TOKEN: token, DEVA_SMOKE_SESSION: existing } = process.env
assert.equal(process.env.DEVA_MODEL, 'deva-compose-fixture')
assert.equal(process.env.DEVA_MODEL_BASE_URL, 'http://127.0.0.1:18795/v1')
assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/u.test(origin) && !process.env.DEVA_MODEL_API_KEY)
const protocol = process.env.DEVA_MODEL_PROTOCOL ?? 'openai'
assert.equal(protocol, process.env.DEVA_SMOKE_EXPECT_PROTOCOL ?? 'openai')
assert.ok(['openai', 'responses', 'anthropic'].includes(protocol))
const prompt = existing ? 'continue after restart' : 'hello from compose'
const attachment = { name: 'reading-notes.md', text: 'A short note.\r\n谢谢。' }
const first = [{ role: 'user', text: 'hello from compose', attachment }, { role: 'assistant', text: 'fixture reply' }]
const sent = existing ? { role: 'user', text: prompt } : first[0]
const parts = m => m.attachment ? [`[附件文件] ${m.attachment.name}\n\`\`\`\n${m.attachment.text}\n\`\`\``, m.text] : [m.text]
let cookie, calls = 0
const fixture = createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'POST'); calls++
    assert.equal(req.url, { openai: '/v1/chat/completions', responses: '/v1/responses', anthropic: '/v1/messages' }[protocol])
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks)), history = [...(existing ? first : []), sent]
    assert.equal(body.model, process.env.DEVA_MODEL); assert.equal(body.stream, true); assert.ok(!body.tools)
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const frame = (type, fields = {}) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`)
    if (protocol === 'responses') {
      assert.equal(body.store, false); assert.ok(!body.previous_response_id)
      assert.deepEqual(body.input, history.map(m => ({ role: m.role, content: parts(m).map(text => ({ type: m.role === 'assistant' ? 'output_text' : 'input_text', text })) })))
      frame('response.output_text.delta', { delta: 'fixture reply' })
      frame('response.completed', { response: { id: 'resp_probe', status: 'completed' } })
    } else if (protocol === 'anthropic') {
      assert.equal(req.headers['anthropic-version'], '2023-06-01')
      assert.deepEqual(body.messages, history.map(m => ({ role: m.role, content: parts(m).map(text => ({ type: 'text', text })) })))
      frame('message_start', { message: { id: 'msg_probe', role: 'assistant', content: [] } })
      frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'fixture reply' } })
      frame('content_block_stop', { index: 0 }); frame('message_delta', { delta: { stop_reason: 'end_turn' } }); frame('message_stop')
    } else {
      assert.deepEqual(body.messages, history.map(m => ({ role: m.role, content: parts(m).join('\n') })))
      res.write('data: {"choices":[{"delta":{"content":"fixture reply"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
    }
    res.end()
  } catch (err) { console.error(err.message); res.destroy() }
})
async function api(path, body) {
  const res = await fetch(`${origin}/api/${path}`, { method: body ? 'POST' : 'GET', headers: {
    ...(cookie && { Cookie: cookie }), ...(body && { Origin: origin, 'Content-Type': 'application/json' })
  }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(10000) })
  assert.ok(res.ok, `${path} returned ${res.status}`); return res
}
try {
  await once(fixture.listen(18795, '127.0.0.1'), 'listening')
  const login = await api('login', { token }); cookie = login.headers.get('set-cookie').split(';')[0]; await login.json()
  const sid = existing || (await (await api('sessions', {})).json()).id
  assert.match(sid, /^web_[a-f0-9-]{36}$/u)
  const path = `sessions/${sid}`, title = 'Saved reading notes'
  let view = await (await api(path)).json()
  assert.deepEqual(view.messages, existing ? first : [])
  if (existing) {
    assert.deepEqual((await (await api('sessions/archived')).json()).sessions, [{ id: sid, title, archived: true }])
    assert.deepEqual((await (await api('sessions')).json()).sessions, [])
    view = await (await api(`${path}/archive`, { archived: false, revision: view.revision })).json()
    assert.equal(view.title, title); assert.deepEqual(view.messages, first)
  }
  assert.equal(calls, 0)
  const stream = await api(`${path}/turns`, { text: prompt, revision: view.revision, turnId: randomUUID(), ...(!existing && { attachment }) })
  const events = (await stream.text()).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(events, [{ type: 'delta', text: 'fixture reply' }, { type: 'done', reason: 'complete' }])
  assert.equal(calls, 1)
  const saved = await (await api(path)).json()
  assert.deepEqual(saved.messages, [...view.messages, sent, { role: 'assistant', text: 'fixture reply' }])
  if (!existing) {
    const renamed = await (await api(`${path}/title`, { title, revision: saved.revision })).json()
    const archived = await (await api(`${path}/archive`, { archived: true, revision: renamed.revision })).json()
    assert.ok(archived.archived); assert.deepEqual(archived.messages, first)
  }
  assert.equal(calls, 1)
  console.log(sid)
} finally { fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)) }
