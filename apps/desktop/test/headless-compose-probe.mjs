// Runs inside the shipping container before and after `docker compose up --force-recreate`.
// Only the fixed, local fixture below is accepted; redirects are disabled.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { isDeepStrictEqual } from 'node:util'

const { DEVA_ORIGIN: origin, DEVA_WEB_TOKEN: token, DEVA_SMOKE_SESSION: existing, DEVA_SMOKE_AFTER_REVOKE: revokeFlag,
  DEVA_MODEL_PROTOCOL: protocol = 'openai', DEVA_SMOKE_EXPECT_PROTOCOL: expected } = process.env
const host = '127.0.0.1', port = 18795, model = 'deva-compose-fixture'
const sidPattern = /^web_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u
assert.ok(process.env.DEVA_MODEL === model && process.env.DEVA_MODEL_BASE_URL === `http://${host}:${port}/v1` &&
  !process.env.DEVA_MODEL_API_KEY, 'fixture model required')
assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/u.test(origin) && /^[A-Za-z0-9_-]{32,128}$/u.test(token), 'loopback origin and owner token required')
assert.ok((expected ?? 'openai') === protocol && (protocol === 'openai' || protocol === (existing ? 'anthropic' : 'responses')),
  'fixture protocol does not match probe stage')
assert.ok(!existing || sidPattern.test(existing), 'invalid session ID')
const afterRevoke = revokeFlag === '1', shouldStop = protocol === 'responses'
assert.ok(revokeFlag === undefined || (afterRevoke && existing && expected === 'openai'), 'revoked stage requires a session and explicit OpenAI expectation')

const attachment = { name: 'reading-notes.md', text: 'A short note.\r\n谢谢。' }
const first = [{ role: 'user', text: 'hello from compose', attachment }, { role: 'assistant', text: 'fixture reply' }]
const interrupted = [...first, { role: 'user', text: 'start a synthetic reply for Stop' }, { role: 'assistant', text: 'visible partial reply' }]
const followUp = { role: 'user', text: 'continue after restart' }
const continued = [...interrupted, followUp, { role: 'assistant', text: 'fixture continuation reply' }]
const revoked = [...continued, { role: 'user', text: 'continue after synthetic document revocation' }, { role: 'assistant', text: 'fixture reply after revoke' }]
const [initial, completed] = afterRevoke ? [continued, revoked] : protocol === 'anthropic' ? [interrupted, continued]
  : existing ? [first, [...first, followUp, first[1]]] : [[], first]
const turns = shouldStop ? [completed, interrupted] : [completed]
const title = 'Saved reading notes'
const route = { openai: '/v1/chat/completions', responses: '/v1/responses', anthropic: '/v1/messages' }[protocol]
const parts = m => m.attachment ? [`[附件文件] ${m.attachment.name}\n\`\`\`\n${m.attachment.text}\n\`\`\``, m.text] : [m.text]
const wire = m => ({ role: m.role, content: protocol === 'openai' ? parts(m).join('\n') : parts(m).map(text => ({
  type: protocol === 'anthropic' ? 'text' : m.role === 'assistant' ? 'output_text' : 'input_text', text
})) })
// Fixed diagnostics, even if an unexpected response contains private values.
const equal = (actual, expected, label) => assert.ok(isDeepStrictEqual(actual, expected), label)
const parse = text => { try { return JSON.parse(text) } catch { throw new Error('invalid probe JSON') } }
let cookie, calls = 0, held
const fixture = createServer(async (req, res) => {
  try {
    const turn = turns[calls++]
    assert.ok(req.method === 'POST' && req.url === route, 'fixture route mismatch')
    assert.ok(turn, 'extra provider request')
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = parse(Buffer.concat(chunks)), reply = turn.at(-1).text
    assert.ok(body.model === model && body.stream === true && !Object.hasOwn(body, 'tools'), 'fixture model request mismatch')
    equal(shouldStop ? body.input : body.messages, turn.slice(0, -1).map(wire), 'provider fixture history mismatch')
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const frame = (type, fields = {}) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`)
    if (protocol === 'responses') {
      assert.ok(body.store === false && !Object.hasOwn(body, 'previous_response_id'), 'Responses must be stateless')
      if (turn === interrupted) held = { response: res, socket: req.socket }
      frame('response.output_text.delta', { delta: reply })
      if (turn === interrupted) return // Only Stop closes this wire; the fixture never sends a terminal or EOF.
      frame('response.completed', { response: { id: 'resp_probe', status: 'completed' } })
    } else if (protocol === 'anthropic') {
      equal(req.headers['anthropic-version'], '2023-06-01', 'Anthropic version mismatch')
      frame('message_start', { message: { id: 'msg_probe', role: 'assistant', content: [] } })
      frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: reply } })
      frame('content_block_stop', { index: 0 }); frame('message_delta', { delta: { stop_reason: 'end_turn' } }); frame('message_stop')
    } else {
      const choice = (delta, finish_reason) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
      choice({ content: reply }, null); choice({}, 'stop'); res.write('data: [DONE]\n\n')
    }
    res.end()
  } catch (err) { console.error(err.message); res.destroy() }
})
async function api(path, body, signal = AbortSignal.timeout(10_000)) {
  const res = await fetch(`${origin}/api/${path}`, { method: body ? 'POST' : 'GET', headers: {
    ...(cookie && { Cookie: cookie }), ...(body && { Origin: origin, 'Content-Type': 'application/json' })
  }, body: body && JSON.stringify(body), signal, redirect: 'error' })
  assert.ok(res.ok, `${path} returned ${res.status}`); return res
}
const json = async (...args) => parse(await (await api(...args)).text())
async function* ndjson(res) {
  assert.ok(/^application\/x-ndjson\b/u.test(res.headers.get('content-type')), 'expected NDJSON')
  let tail = ''
  for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
    const lines = (tail + chunk).split('\n'); tail = lines.pop()
    for (const line of lines) yield parse(line)
  }
  assert.ok(!tail, 'incomplete NDJSON frame')
}
const delta = text => ({ type: 'delta', text }), done = reason => ({ type: 'done', reason })
async function finish(events, ...expected) {
  const received = []; for await (const event of events) received.push(event)
  equal(received, expected, 'unexpected turn frames or terminal reason')
}
function saved(view, history) {
  equal(view.messages, history, 'saved history mismatch')
  equal(view.active, null, 'expected no active turn')
}
try {
  await once(fixture.listen(port, host), 'listening', { signal: AbortSignal.timeout(10_000) })
  const login = await api('login', { token }); cookie = login.headers.get('set-cookie')?.split(';', 1)[0]
  assert.ok(/^deva_web=[A-Za-z0-9_-]+$/u.test(cookie), 'missing owner session cookie')
  equal(parse(await login.text()), { ok: true }, 'login acknowledgement mismatch')
  const sid = existing || (await json('sessions', {})).id
  assert.ok(typeof sid === 'string' && sidPattern.test(sid), 'invalid session ID')
  const path = `sessions/${sid}`
  const send = async (view, { text, attachment }, turnId = randomUUID(), signal) =>
    ndjson(await api(`${path}/turns`, { text, revision: view.revision, turnId, attachment }, signal))
  let view = await json(path)
  saved(view, initial)
  if (existing) {
    assert.ok(view.title === title, 'saved title was not reloaded')
    const index = await json('sessions')
    if (afterRevoke) {
      assert.ok(!view.archived && !Object.hasOwn(index, 'projectDocs'), 'expected restored chat without the document viewer')
      equal(index.sessions, [{ id: sid, title }], 'active list mismatch after revoke')
    } else {
      assert.ok(view.archived === true, 'archive was not reloaded')
      equal((await json('sessions/archived')).sessions, [{ id: sid, title, archived: true }], 'archived list mismatch')
      equal(index.sessions, [], 'active list mismatch')
      view = await json(`${path}/archive`, { archived: false, revision: view.revision })
      assert.ok(!view.archived && view.title === title, 'restore changed the title or archive state')
      saved(view, initial)
    }
  }
  equal(calls, 0, 'session setup contacted the fixture')
  await finish(await send(view, completed.at(-2)), delta(completed.at(-1).text), done('complete'))
  equal(calls, 1, 'complete turn provider call count mismatch')
  view = await json(path); saved(view, completed)
  if (existing) assert.ok(!view.archived && view.title === title, 'continuation changed the title or archive state')
  if (shouldStop) {
    const turnId = randomUUID(), streamDeadline = AbortSignal.timeout(10_000)
    const events = await send(view, interrupted.at(-2), turnId, streamDeadline)
    equal(await events.next(), { value: delta(interrupted.at(-1).text), done: false }, 'missing visible partial before Stop')
    const active = await json(path, undefined, streamDeadline)
    equal(active.active, turnId, 'second turn is not active')
    equal(active.messages, interrupted.slice(0, -1), 'live history mismatch')
    const { response, socket } = held ?? {}
    assert.ok(socket && !socket.destroyed && !response.writableEnded, 'upstream was not open before Stop')
    const stopDeadline = AbortSignal.timeout(3_000)
    const [, ack] = await Promise.all([
      once(socket, 'close', { signal: stopDeadline }), json(`${path}/stop`, { turnId }, stopDeadline)
    ])
    equal(ack, { ok: true }, 'Stop acknowledgement mismatch')
    assert.ok(socket.destroyed && !response.writableEnded && !streamDeadline.aborted && !stopDeadline.aborted,
      'upstream did not close on Stop before fixture EOF or probe deadlines')
    await finish(events, done('stopped'))
    assert.ok(!streamDeadline.aborted, 'turn stream deadline elapsed')
    view = await json(path); saved(view, interrupted)
  }
  if (!existing) {
    const renamed = await json(`${path}/title`, { title, revision: view.revision })
    const archived = await json(`${path}/archive`, { archived: true, revision: renamed.revision })
    assert.ok(archived.archived === true && archived.title === title, 'archive or title did not persist')
    saved(archived, turns.at(-1))
  }
  equal(calls, turns.length, 'final provider call count mismatch')
  console.log(sid)
} finally {
  const closed = new Promise(resolve => fixture.close(resolve)); fixture.closeAllConnections(); await closed
}
