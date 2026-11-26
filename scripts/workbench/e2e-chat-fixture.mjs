import { EventEmitter, once } from 'node:events'
import { createServer } from 'node:http'

export class ChatFixtureError extends Error {}

const modelPath = '/v1/models'
const chatPath = '/v1/chat/completions'
const maxRequestBytes = 64 * 1024
const systemMessage = { role: 'system', content: 'You are a helpful general-purpose assistant. Reply in plain text.' }
const noDefinitions = value => value === undefined || (Array.isArray(value) && value.length === 0)

async function readJson(req) {
  const chunks = []
  let bytes = 0
  for await (const part of req) {
    bytes += part.length
    if (bytes > maxRequestBytes) throw new ChatFixtureError('Chat fixture request body exceeded its limit')
    chunks.push(part)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new ChatFixtureError('Chat fixture received invalid JSON') }
}

async function waitUntil(events, predicate, diagnostic, signal) {
  const timeout = AbortSignal.timeout(12_000)
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout
  while (!predicate()) {
    try { await once(events, 'change', { signal: deadline }) }
    catch { throw new ChatFixtureError(diagnostic) }
  }
}

function streamControl(res, events, modelId, number) {
  let closed = false
  res.once('close', () => {
    closed = true
    events.emit('change')
  })
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
  res.flushHeaders()
  function assertOpen() {
    if (closed || res.destroyed || res.writableEnded) {
      throw new ChatFixtureError('Expected original upstream SSE response to remain open')
    }
  }
  function frame(delta, finish = null) {
    assertOpen()
    const chunk = { id: `chatcmpl-e2e-${number}`, object: 'chat.completion.chunk', created: 1, model: modelId,
      choices: [{ index: 0, delta, finish_reason: finish }] }
    res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  }
  return {
    assertOpen,
    delta: text => frame({ content: text }),
    finish() {
      frame({}, 'stop')
      res.end('data: [DONE]\n\n')
    },
    async waitForAbort({ signal } = {}) {
      await waitUntil(events, () => closed, 'Timed out waiting for upstream SSE to close after Stop', signal)
      if (res.writableEnded) throw new ChatFixtureError('Upstream SSE ended normally rather than being aborted')
    }
  }
}

/** Loopback OpenAI wire fixture; request data, headers and raw errors stay private. */
export async function startChatFixture({ key, modelId, otherModelId }) {
  const events = new EventEmitter()
  const modelsResponse = JSON.stringify({ object: 'list', data: [modelId, otherModelId].map(id => ({ id, object: 'model' })) })
  const calls = []
  let requestCount = 0
  let successful = 0
  let failure
  const authorized = req => req.headers.authorization === `Bearer ${key}` &&
    req.headersDistinct.authorization?.length === 1 && req.headers.cookie === undefined
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === modelPath) {
      if (!authorized(req)) return res.writeHead(401).end()
      successful++
      return res.writeHead(200, { 'content-type': 'application/json' }).end(modelsResponse)
    }
    const reject = (status, reason) => {
      failure ??= new ChatFixtureError(reason)
      if (!res.destroyed && !res.headersSent) res.writeHead(status, { connection: 'close' }).end()
      else res.destroy()
      events.emit('change')
    }
    if (req.url?.split('?', 1)[0] !== chatPath) return reject(404, 'OpenAI fixture received an unexpected upstream request')
    const number = ++requestCount // Include duplicates and rejected requests, starting at the wire boundary.
    if (number > 2) return reject(409, 'Chat fixture observed an extra upstream request')
    if (req.method !== 'POST' || req.url !== chatPath) return reject(400, 'Chat fixture received the wrong method or path')
    if (!authorized(req)) return reject(401, 'Chat request did not use the saved Bearer credential or included a cookie')
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) {
      return reject(400, 'Chat request did not declare a JSON body')
    }
    void (async () => {
      const body = await readJson(req)
      if (body?.model !== modelId || body?.stream !== true) {
        return reject(400, 'Chat request did not use the selected upstream model and streaming mode')
      }
      if (!noDefinitions(body.tools) || !noDefinitions(body.functions) ||
        (body.tool_choice !== undefined && body.tool_choice !== 'none') ||
        (body.function_call !== undefined && body.function_call !== 'none')) {
        return reject(400, 'Chat request exposed executable tools')
      }
      calls[number - 1] = { messages: body.messages, stream: streamControl(res, events, modelId, number) }
      events.emit('change')
    })().catch(error => reject(400, error instanceof ChatFixtureError ? error.message : 'Chat fixture request interrupted'))
  })
  function assertRequestCount(expected) {
    if (failure) throw failure
    if (requestCount !== expected) {
      throw new ChatFixtureError(`Expected exactly ${expected} upstream chat requests; observed ${requestCount}`)
    }
  }
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    get successful() { return successful },
    assertRequestCount,
    async expectRequest(number, { messages, signal }) {
      await waitUntil(events, () => failure || calls[number - 1], `Upstream chat request ${number} did not arrive`, signal)
      assertRequestCount(number)
      const call = calls[number - 1]
      const expected = [systemMessage, ...messages]
      if (!Array.isArray(call.messages) || call.messages.length !== expected.length ||
        !expected.every(({ role, content }, index) => call.messages[index]?.role === role && call.messages[index]?.content === content)) {
        throw new ChatFixtureError(`Upstream chat request ${number} did not carry the expected ordered conversation`)
      }
      call.messages = undefined
      return call.stream
    },
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
      server.closeAllConnections()
    })
  }
}
