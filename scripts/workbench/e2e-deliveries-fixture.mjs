import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { startLocalWebDriver, waitFor, WebDriverError } from './webdriver-local.mjs'

export class DeliveryCheckError extends Error {}
export function check(condition, diagnostic) {
  if (!condition) throw new DeliveryCheckError(diagnostic)
}

export const providerId = 'delivery-e2e-private'
export const providerName = 'Private delivery E2E provider'
export const modelId = 'delivery-e2e-model'
export const question = 'Verify a workbench delivery'
export const firstReply = '# 合成交付'
export const finalReply = `${firstReply}\n\nUTF-8 正文 📝\n\n- Preserves Markdown.`
export const alpha = 'Alpha'
export const folder = '交付 资料'
export const legacyTitle = 'Desktop delivery fixture'
export const legacyName = '合成 交付.txt'
export const legacyRelative = `${folder}/${legacyName}`
export const outsideName = 'private-outside-workspace.txt'
export const legacyBytes = Buffer.from('合成工作区交付 📝\r\nSecond\tline.\n', 'utf8')
const chatRoute = '/v1/chat/completions'
const expectedBody = {
  model: modelId,
  messages: [
    { role: 'system', content: 'You are a helpful general-purpose assistant. Reply in plain text.' },
    { role: 'user', content: question }
  ],
  tools: [], max_tokens: 4096, stream: true, stream_options: { include_usage: true }
}

/** One-shot loopback SSE. Count every request, including model-list probes and rejected ones. */
export async function startDeliveryFixture(key) {
  let count = 0, permitted = false, failure, response
  const server = createServer((req, res) => {
    const number = ++count
    const reject = (status, reason) => {
      failure ??= new DeliveryCheckError(reason)
      if (!res.destroyed && !res.headersSent) res.writeHead(status, { connection: 'close' }).end()
      else res.destroy()
    }
    if (!permitted || number !== 1) return reject(409, 'Unexpected extra upstream request')
    if (req.method !== 'POST' || req.url !== chatRoute) return reject(400, 'Unexpected upstream method or route')
    if (req.headersDistinct.authorization?.length !== 1 || req.headers.authorization !== `Bearer ${key}` ||
        req.headers.cookie !== undefined) return reject(401, 'Upstream request used unexpected credentials')
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) {
      return reject(400, 'Upstream request did not declare JSON')
    }
    void (async () => {
      const chunks = []
      let size = 0
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length
        check(size <= 32 * 1024, 'Upstream JSON exceeded the fixture limit')
        chunks.push(chunk)
      }
      const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
      check(isDeepStrictEqual(body, expectedBody), 'Upstream request did not contain only the expected text conversation')
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' })
      response = res
      frame({ content: firstReply })
    })().catch(error => reject(400, error instanceof DeliveryCheckError ? error.message : 'Upstream JSON processing failed'))
  })
  function frame(delta, finish = null) {
    check(response && !response.destroyed && !response.writableEnded, 'Expected the original upstream stream to remain open')
    const body = { id: 'chatcmpl-deliveries-e2e', object: 'chat.completion.chunk', created: 1, model: modelId,
      choices: [{ index: 0, delta, finish_reason: finish }] }
    response.write(`data: ${JSON.stringify(body)}\n\n`)
  }
  function assertCount(expected) {
    if (failure) throw failure
    check(count === expected, `Expected exactly ${expected} upstream request(s); observed ${count}`)
  }
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    assertCount,
    permitSend() { assertCount(0); permitted = true },
    async waitForSend(signal) {
      await waitFor(() => { if (failure) throw failure; return !!response }, 'delivery turn at upstream fixture', { signal })
      assertCount(1)
    },
    complete() {
      assertCount(1)
      frame({ content: finalReply.slice(firstReply.length) })
      frame({}, 'stop')
      response.end('data: [DONE]\n\n')
    },
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
      server.closeAllConnections()
    })
  }
}

export async function createPrivateRoot() {
  const prefix = join(await realpath(tmpdir()), 'deva-deliveries-e2e-')
  const root = await mkdtemp(prefix)
  check(root.startsWith(prefix) && root.length === prefix.length + 6 && await realpath(root) === root,
    'Unexpected private temporary directory')
  return root
}

/** The sole chat writer before service startup is the authoritative native store. */
export async function seedLegacy(root) {
  const { createChatStore } = await import('../../apps/headless/dist/chat-core.mjs')
  const dataDir = join(root, 'data')
  const workspaceRoot = join(root, 'projects')
  const focusRoot = join(workspaceRoot, alpha)
  const inside = join(focusRoot, legacyRelative), outside = join(root, outsideName)
  const downloadsDir = join(root, 'saved-deliveries')
  await mkdir(join(focusRoot, folder), { recursive: true, mode: 0o700 })
  await mkdir(downloadsDir, { mode: 0o700 })
  await Promise.all([
    writeFile(inside, legacyBytes, { flag: 'wx', mode: 0o600 }),
    writeFile(outside, 'Synthetic file outside the authorized project root.\n', { flag: 'wx', mode: 0o600 })
  ])
  const sid = randomUUID(), id = 'toolu_delivery_fixture'
  const paths = [inside, outside]
  const store = createChatStore({ dataDir })
  const session = store.ensureSession(sid, { focusRoot })
  session.title = legacyTitle
  session.messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'present_files', input: { paths } }] },
    { role: 'user', content: [{ type: 'tool_result', toolUseId: id, content: 'ok' }] }
  ]
  session.delivered = { [id]: paths }
  store.saveStrict(sid)
  const chatFile = join(dataDir, 'data', 'chats', `${sid}.json`)
  const original = await readFile(chatFile)
  return {
    dataDir, downloadsDir, workspaceRoot, sid,
    async assertUnchanged() {
      check(original.equals(await readFile(chatFile)), 'Viewing the delivery changed the native legacy chat')
      check(legacyBytes.equals(await readFile(inside)), 'Viewing the delivery changed the read-only project file')
    }
  }
}

/** Chrome writes a staging filename then renames the finished download. Require exactly the
 * expected final filename, regular private-root file, and literal UTF-8 byte sequence. */
export async function expectDownload(directory, name, bytes, signal) {
  check(typeof name === 'string' && name.length > 0 && name === basename(name) && name !== '.' && name !== '..' &&
    !/[\\/\x00-\x1f\x7f]/u.test(name), 'Test expected an invalid download filename')
  await waitFor(async () => {
    const names = await readdir(directory)
    return names.length === 1 && names[0] === name
  }, 'expected completed Chrome download filename', { signal })
  const path = join(directory, name)
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    check(info.isFile() && info.nlink === 1 && info.size === bytes.length, 'Downloaded file had an unexpected type or byte length')
    check(bytes.equals(await file.readFile()), 'Downloaded file differed from the expected UTF-8 bytes')
  } finally { await file.close() }
  await unlink(path) // Remove this exact verified filename in the private directory before the next click.
}

export async function verifyDeliveriesFixture() {
  const root = await createPrivateRoot()
  const key = randomBytes(24).toString('base64url')
  let mock
  try {
    const seed = await seedLegacy(root)
    const { createChatStore } = await import('../../apps/headless/dist/chat-core.mjs')
    const stored = createChatStore({ dataDir: seed.dataDir }).getSession(seed.sid)
    const tool = stored?.messages[0]?.content[0], result = stored?.messages[1]?.content[0]
    const paths = [join(seed.workspaceRoot, alpha, legacyRelative), join(root, outsideName)]
    check(stored?.title === legacyTitle && stored.focusRoot === join(seed.workspaceRoot, alpha) &&
      stored.messages.length === 2 && stored.messages[0].role === 'assistant' && stored.messages[1].role === 'user' &&
      tool?.type === 'tool_use' && tool.name === 'present_files' && result?.type === 'tool_result' && result.toolUseId === tool.id &&
      result.content === 'ok' && JSON.stringify(tool.input.paths) === JSON.stringify(paths) &&
      JSON.stringify(stored.delivered[tool.id]) === JSON.stringify(paths), 'Native store did not round-trip the legacy delivery shape')
    await seed.assertUnchanged()
    check(((await lstat(seed.downloadsDir)).mode & 0o777) === 0o700, 'Fixture download directory is not private')
    // Only the self-test writes a fake file here, to validate the on-disk assertion without Chrome.
    await writeFile(join(seed.downloadsDir, legacyName), legacyBytes, { flag: 'wx', mode: 0o600 })
    await expectDownload(seed.downloadsDir, legacyName, legacyBytes, AbortSignal.timeout(500))
    await verifyRejectedDownloadDirectories(root, seed.downloadsDir)

    mock = await startDeliveryFixture(key)
    mock.assertCount(0)
    mock.permitSend()
    const response = await new Promise((resolve, reject) => {
      const req = request(mock.origin + chatRoute, { method: 'POST', agent: false, signal: AbortSignal.timeout(5_000),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` } }, resolve)
      req.once('error', reject)
      req.end(JSON.stringify(expectedBody))
    })
    check(response.statusCode === 200 && /^text\/event-stream/.test(response.headers['content-type'] ?? ''),
      'Delivery fixture did not open a real SSE response')
    await mock.waitForSend()
    mock.complete()
    const chunks = []
    for await (const chunk of response) chunks.push(chunk)
    const frames = Buffer.concat(chunks).toString('utf8').trimEnd().split('\n\n').map(frame => frame.slice(6))
    check(frames.length === 4 && frames[3] === '[DONE]' && JSON.parse(frames[2]).choices[0].finish_reason === 'stop' &&
      frames.slice(0, 2).map(frame => JSON.parse(frame).choices[0].delta.content).join('') === finalReply,
    'Fixture did not emit the Unicode SSE fragments and terminal frame')
    mock.assertCount(1)
    const extra = await fetch(`${mock.origin}/v1/models`, { redirect: 'error', signal: AbortSignal.timeout(5_000) })
    await extra.body?.cancel()
    check(extra.status === 409, 'Fixture accepted a model-list probe after the only permitted chat request')
  } finally {
    try { await mock?.close() } finally { await rm(root, { recursive: true, force: true }) }
  }
}

async function verifyRejectedDownloadDirectories(root, valid) {
  if (process.platform !== 'linux' || !process.getuid?.() || !process.geteuid?.()) return
  const link = join(root, 'download-link'), publicDir = join(root, 'public-downloads')
  await Promise.all([mkdir(join(valid, 'nested'), { mode: 0o700 }), mkdir(join(publicDir, 'nested'), { recursive: true, mode: 0o700 }),
    symlink(valid, link, 'dir')])
  await chmod(publicDir, 0o755)
  for (const path of [root, tmpdir(), link, join(link, 'nested'), publicDir, join(publicDir, 'nested'),
    join(root, 'missing'), `${root}/./saved-deliveries`]) {
    const rejected = await startLocalWebDriver({ root, profile: join(root, 'unused-profile'), origin: 'http://127.0.0.1:1',
      downloadsDir: path, signal: AbortSignal.abort() }).then(async browser => { await browser.close(); return false },
      error => error instanceof WebDriverError && error.message.startsWith('configure Chrome downloads:'))
    check(rejected, 'WebDriver accepted an unsafe test download directory')
  }
}
