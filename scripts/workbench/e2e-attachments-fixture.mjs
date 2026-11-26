import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createServer, request } from 'node:http'
import { isDeepStrictEqual } from 'node:util'
import { inflateSync } from 'node:zlib'
import pkg from '../../apps/headless/package.json' with { type: 'json' }
import { waitFor } from './webdriver-local.mjs'

export class AttachmentCheckError extends Error {}
export function check(condition, diagnostic) {
  if (!condition) throw new AttachmentCheckError(diagnostic)
}

export const providerId = 'attachment-e2e-private'
export const providerName = 'Private attachment E2E provider'
export const modelId = 'attachment-e2e-model'
export const question = 'Check my two attachments'
export const firstReply = 'Both attachments arrived.'
export const fullReply = `${firstReply} Verification complete.`
export const textName = 'attachment-notes.txt'
export const imageName = 'attachment-pixels.png'
// A generated 2×2 truecolor PNG, with distinct pixels and no imported photo or file.
export const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWNYZ/B3ncFfBggFADLGB23aTHV6AAAAAElFTkSuQmCC', 'base64')
export const textBytes = Buffer.from('合成附件 📝\r\nSecond\tline.\n', 'utf8')
export const uuid4Source = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}'
const chatPath = '/v1/chat/completions'
const expectedBody = {
  model: modelId,
  messages: [
    { role: 'system', content: 'You are a helpful general-purpose assistant. Reply in plain text.' },
    { role: 'user', content: [
      { type: 'text', text: `[附件文件] ${textName}\n\`\`\`\n${textBytes.toString('utf8')}\n\`\`\`\n${question}` },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBytes.toString('base64')}` } }
    ] }
  ],
  tools: [], max_tokens: 4096, stream: true, stream_options: { include_usage: true }
}
const expectedUserAgent = `deva/${pkg.version}`
function safeHeaders(req, host) {
  const fixed = { 'user-agent': expectedUserAgent, host, connection: 'close',
    'accept-encoding': 'gzip, deflate, br', 'transfer-encoding': 'chunked' }
  return req.headers['user-agent'] === expectedUserAgent && Object.entries(req.headersDistinct).every(([name, values]) => {
    if (values.length !== 1) return false
    if (name === 'authorization' || name === 'content-type') return true // Checked separately.
    if (name === 'content-length') return /^\d{1,5}$/.test(values[0])
    return Object.hasOwn(fixed, name) && values[0] === fixed[name]
  })
}

async function consumeJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    check(size <= 32 * 1024, 'Provider JSON exceeded the fixture limit')
    chunks.push(chunk)
  }
  try {
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    const parsed = JSON.parse(raw)
    // Match the provider's JSON.stringify transport, excluding hidden duplicate keys.
    if (JSON.stringify(parsed) !== raw) throw Error('unexpected JSON encoding')
    return parsed
  } catch { throw new AttachmentCheckError('Provider did not send canonical UTF-8 JSON') }
}

function streamReply(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' })
  function chunk(delta, finish = null) {
    check(!res.destroyed && !res.writableEnded, 'Upstream stream closed before the fixture could complete it')
    const body = { id: 'chatcmpl-attachments-e2e', object: 'chat.completion.chunk', created: 1, model: modelId,
      choices: [{ index: 0, delta, finish_reason: finish }] }
    res.write(`data: ${JSON.stringify(body)}\n\n`)
  }
  chunk({ content: firstReply })
  return () => {
    chunk({ content: fullReply.slice(firstReply.length) })
    chunk({}, 'stop')
    res.end('data: [DONE]\n\n')
  }
}

/** Listen only on loopback. Raw requests and secrets are compared in memory and never logged. */
export async function startAttachmentFixture(key) {
  let count = 0, permitted = false, failure, finish
  const server = createServer((req, res) => {
    ++count // Count every request, including pre-Send, model probes, malformed and duplicate ones.
    const reject = (status, error) => {
      failure ??= error
      if (!res.destroyed && !res.headersSent) res.writeHead(status, { connection: 'close' }).end()
      else res.destroy()
    }
    const failed = (status, reason) => reject(status, new AttachmentCheckError(reason))
    if (!permitted) return failed(409, 'An upstream request arrived before Send')
    if (count !== 1) return failed(409, 'More than one upstream request arrived for the attachment turn')
    if (req.method !== 'POST' || req.url !== chatPath) return failed(400, 'Unexpected upstream method or route')
    if (req.headersDistinct.authorization?.length !== 1 || req.headers.authorization !== `Bearer ${key}`) {
      return failed(401, 'Provider request did not use the configured synthetic credential')
    }
    if (!safeHeaders(req, `127.0.0.1:${server.address().port}`)) {
      return failed(400, 'Provider request carried browser or unexpected private headers')
    }
    if (req.headers['content-type'] !== 'application/json') {
      return failed(400, 'Provider request did not declare JSON')
    }
    void (async () => {
      // Exact structural match verifies the UTF-8 text (including CRLF), canonical PNG bytes,
      // allowed model information, and absence of extra fields, paths, IDs, or tickets.
      const body = await consumeJson(req)
      check(isDeepStrictEqual(body, expectedBody), 'Provider JSON differed from the exact text-and-PNG wire contract')
      finish = streamReply(res)
    })().catch(error => reject(400, error instanceof AttachmentCheckError ? error :
      new AttachmentCheckError('Provider request processing failed')))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const assertHealthy = () => { if (failure) throw failure }
  function assertCount(expected) {
    assertHealthy()
    check(count === expected, `Expected exactly ${expected} upstream request(s); observed ${count}`)
  }
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    assertCount,
    permitSend() { assertCount(0); permitted = true },
    async waitForSend(signal) {
      await waitFor(() => { assertHealthy(); return !!finish }, 'attachment turn at upstream fixture', { signal })
      assertCount(1)
    },
    complete() { assertCount(1); check(finish, 'Upstream reply was not started'); finish() },
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
      server.closeAllConnections()
    })
  }
}

/** Explicit fixture-only preflight for development without Chrome or product builds. */
export async function verifyAttachmentFixture() {
  check(imageBytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' &&
    imageBytes.toString('ascii', 12, 16) === 'IHDR' && imageBytes.readUInt32BE(16) === 2 &&
    imageBytes.readUInt32BE(20) === 2 && imageBytes[24] === 8 && imageBytes[25] === 2,
  'Synthetic PNG was not a 2×2 truecolor raster')
  const idat = []
  let hasEnd = false
  for (let at = 8; at + 12 <= imageBytes.length;) {
    const length = imageBytes.readUInt32BE(at)
    const type = imageBytes.toString('ascii', at + 4, at + 8)
    const next = at + length + 12
    check(next <= imageBytes.length && type !== 'acTL', 'Synthetic PNG had invalid or animated chunks')
    if (type === 'IDAT') idat.push(imageBytes.subarray(at + 8, next - 4))
    if (type === 'IEND') hasEnd = length === 0 && next === imageBytes.length
    at = next
  }
  check(hasEnd && inflateSync(Buffer.concat(idat)).length === 14, 'Synthetic PNG scanline size was invalid')
  const key = randomBytes(24).toString('base64url')
  async function exercise(run) {
    const fixture = await startAttachmentFixture(key)
    try {
      const send = (body, extra = {}) => new Promise((resolve, reject) => {
        const req = request(fixture.origin + chatPath, {
          method: 'POST', agent: false, signal: AbortSignal.timeout(5_000),
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'user-agent': expectedUserAgent, ...extra }
        }, resolve)
        req.once('error', reject)
        req.end(JSON.stringify(body))
      })
      await run(fixture, send)
    } finally { await fixture.close() }
  }
  await exercise(async (fixture, send) => {
    check((await send(expectedBody)).statusCode === 409, 'Fixture accepted a request before Send')
  })
  await exercise(async (fixture, send) => {
    fixture.permitSend()
    check((await send({ ...expectedBody, attachmentPath: '/private/synthetic' })).statusCode === 400,
      'Fixture accepted an unexpected attachment path field')
  })
  await exercise(async (fixture, send) => {
    fixture.permitSend()
    check((await send(expectedBody, { cookie: 'synthetic=private' })).statusCode === 400, 'Fixture accepted an unexpected cookie')
  })
  await exercise(async (fixture, send) => {
    fixture.permitSend()
    const response = await send(expectedBody)
    check(response.statusCode === 200 && /^text\/event-stream/.test(response.headers['content-type'] ?? ''),
      'Fixture failed to start the SSE response')
    await fixture.waitForSend()
    fixture.complete()
    const chunks = []
    for await (const chunk of response) chunks.push(chunk)
    const frames = Buffer.concat(chunks).toString('utf8').trimEnd().split('\n\n').map(line => line.slice(6))
    check(frames.length === 4 && frames[3] === '[DONE]' && JSON.parse(frames[2]).choices[0].finish_reason === 'stop' &&
      frames.slice(0, 2).map(frame => JSON.parse(frame).choices[0].delta.content).join('') === fullReply,
    'Fixture did not emit the expected SSE deltas and terminal frame')
    fixture.assertCount(1)
    check((await send(expectedBody)).statusCode === 409, 'Fixture accepted a duplicate provider request')
  })
}
