import { randomBytes } from 'node:crypto'
import { channel } from 'node:diagnostics_channel'
import { once } from 'node:events'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { openSettings } from '../../apps/headless/src/business/settings.mjs'
import { httpPolicy } from '../../apps/headless/src/http/policy.mjs'
import { initializeMasterKey, openVault } from '../../apps/headless/src/storage/vault.mjs'
import { waitFor } from './webdriver-local.mjs'

export class InteractionCheckError extends Error {}
export function check(value, diagnostic) {
  if (!value) throw new InteractionCheckError(diagnostic)
}

export const providerId = 'interaction-e2e-private'
export const modelId = 'interaction-e2e-model'
export const project = 'Interaction fixture project'
export const projectFile = 'fixture.txt'
export const projectText = 'Unrelated synthetic project text.\n'
const modelRoute = '/v1/chat/completions'
const system = { role: 'system', content: 'You are a helpful general-purpose assistant. Reply in plain text.' }

export async function privateRoot() {
  const prefix = join(await realpath(tmpdir()), 'deva-client-interactions-')
  const root = await mkdtemp(prefix)
  check(root.startsWith(prefix) && root.length === prefix.length + 6 && await realpath(root) === root &&
    ((await lstat(root)).mode & 0o777) === 0o700, 'Unexpected private test directory')
  return root
}

export async function seedInteractions(root, { origin, key }) {
  const [dataDir, keyFile, runDir, workspaceRoot] = ['data', 'master.key', 'run', 'projects'].map(name => join(root, name))
  const directory = join(workspaceRoot, project)
  const file = join(directory, projectFile)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(file, projectText, { flag: 'wx', mode: 0o600 })
  const fileSnapshot = async () => {
    const { ino, mode, size, ctimeNs, mtimeNs } = await lstat(file, { bigint: true })
    return { ino, mode, size, ctimeNs, mtimeNs, bytes: await readFile(file), entries: (await readdir(directory)).sort() }
  }
  const original = await fileSnapshot()
  await initializeMasterKey(keyFile)
  const vault = await openVault({ dataDir, keyFile })
  const settings = await openSettings({ dataDir, vault })
  const { revision } = await settings.getPublicConfig()
  const provider = { id: providerId, name: 'Private interaction fixture provider', kind: 'custom', purpose: 'llm',
    accent: '#345678', adapter: 'openai', apiHost: `${origin}/v1`, enabled: true,
    models: [{ id: modelId, name: modelId, enabled: true }] }
  const saved = await settings.patch({ revision, unset: [], set: { locale: 'en', models: { providers: [provider],
    activeModelId: `${providerId}:${modelId}`, activeEffort: 'default' } } })
  check((await settings.setKey(providerId, key, saved.revision)).available, 'Synthetic model credential was not saved')
  return {
    dataDir, keyFile, runDir, workspaceRoot,
    async assertFileUnchanged() {
      check(isDeepStrictEqual(await fileSnapshot(), original), 'A browser interaction changed the workspace fixture file')
    }
  }
}

const chatId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const readsPath = '/api/v1/conversation-status/reads'
const statusPath = /^\/api\/v1\/chats\/([^/]+)\/(context-usage|read-state)$/u
const modelBodies = [null, `${providerId}:${modelId}`].map(model => JSON.stringify({ model }))
const statusLimit = 1024
const parse = bytes => {
  try { return Buffer.isBuffer(bytes) && bytes.length <= statusLimit ? JSON.parse(bytes) : null } catch { return null }
}

// Tee only bounded status bodies at ingress, without adding a stream consumer. Other
// bodies (including auth, model prompts and clipboard text) stay with the real handler.
function observeStatusBody(req, complete) {
  const push = req.push, chunks = []
  let size = 0
  req.push = function (chunk, ...rest) {
    if (chunk !== null) {
      size += Buffer.byteLength(chunk)
      if (size <= statusLimit) chunks.push(Buffer.from(chunk))
    }
    return Reflect.apply(push, this, [chunk, ...rest])
  }
  return () => complete(size <= statusLimit ? Buffer.concat(chunks) : null)
}

export function observeInteractionWrites() {
  const requests = channel('http.server.request.start')
  const turns = [], created = new Set()
  let port, policy, auth, selected, covered = false, violations = 0, fileRead, creating, send
  function authenticated(req, write) {
    try {
      policy.check(req, write)
      const cookie = policy.cookie(req)
      const actor = write ? auth.identify(cookie, req.headers['x-deva-csrf']) : auth.identify(cookie)
      return actor.role === 'owner' && req.headers['sec-fetch-site'] === 'same-origin' && (!write ||
        (req.headersDistinct['x-deva-csrf']?.length === 1 && /^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')))
    } catch { return false }
  }
  function status(req, res, raw, path, route) {
    const read = path === readsPath
    if (raw !== path || req.method !== (read ? 'GET' : 'POST') || !authenticated(req, !read)) { violations++; return }
    if (read) {
      if (!created.size || req.headers['transfer-encoding'] || ![undefined, '0'].includes(req.headers['content-length'])) { violations++; return }
      res.once('finish', () => { if (res.statusCode !== 200) violations++ })
      return
    }
    const [, sid, kind] = route
    if (covered || sid !== selected || !created.has(sid)) { violations++; return }
    if (kind === 'context-usage') {
      const body = observeStatusBody(req, bytes => modelBodies.includes(bytes?.toString()))
      // The real meter aborts in-flight reads on scope changes. Their wire payload and
      // owner still have to match exactly; only the finished response may be absent.
      res.once('close', () => { if (!body() || (res.writableFinished && res.statusCode !== 200)) violations++ })
      return
    }
    const permitted = send
    if (!permitted?.accepted || permitted.sid !== sid || permitted.marking) { violations++; return }
    permitted.marking = true
    const body = observeStatusBody(req, parse), end = res.end
    res.end = function (bytes, ...rest) {
      const sent = body(), { cursor, updatedAt } = sent ?? {}
      permitted.marked = Number.isSafeInteger(updatedAt) && updatedAt >= 0 && Number.isSafeInteger(cursor?.seq) && cursor.seq >= 0 &&
        typeof cursor.epoch === 'string' && chatId.test(cursor.epoch) && typeof cursor.generation === 'string' && chatId.test(cursor.generation) &&
        isDeepStrictEqual(sent, { updatedAt, cursor: { scope: `chat:${sid}`, epoch: cursor.epoch, generation: cursor.generation, seq: cursor.seq } }) &&
        res.statusCode === 200 && isDeepStrictEqual(parse(bytes), { id: sid, updatedAt, readAt: updatedAt, unread: false, changed: true })
      return Reflect.apply(end, this, [bytes, ...rest])
    }
    res.once('close', () => { if (!permitted.marked || !res.writableFinished) violations++ })
  }
  const observe = ({ request, response }) => {
    if (request.socket.localPort !== port) return
    const raw = request.url ?? '', path = raw.split('?', 1)[0], method = request.method
    const route = statusPath.exec(path)
    if (route || path === readsPath) { status(request, response, raw, path, route); return }
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return
    const turn = /^\/api\/v1\/chats\/([\da-f-]+)\/turns$/.exec(raw)
    if (turn && method === 'POST') {
      turns.push(turn[1])
      const permitted = send
      if (!permitted || permitted.sent || permitted.sid !== turn[1] || covered || !authenticated(request, true)) violations++
      else {
        permitted.sent = true
        response.once('finish', () => { permitted.accepted = response.statusCode === 202 })
      }
    } else if (creating === 'armed' && method === 'POST' && raw === '/api/v1/chats') {
      creating = 'in-flight'
      const end = response.end
      response.end = function (bytes, ...rest) {
        const sid = parse(bytes)?.session?.id
        if (response.statusCode === 200 && typeof sid === 'string' && chatId.test(sid) && !created.has(sid)) {
          created.add(sid); selected = sid; creating = undefined
        } else violations++
        return Reflect.apply(end, this, [bytes, ...rest])
      }
    } else if (fileRead && !fileRead.seen && method === 'POST' && raw === fileRead.path) {
      const receipt = fileRead; receipt.seen = true
      response.once('finish', () => { receipt.status = response.statusCode })
    } else if (method !== 'POST' || !['/api/v1/auth/claim','/api/v1/auth/login','/api/v1/auth/logout'].includes(raw)) violations++
  }
  return {
    factory(openBusiness) { return options => { auth = options.auth; return openBusiness(options) } },
    listen(address, origin) { port = address.port; policy = httpPolicy(origin); requests.subscribe(observe) },
    permitCreate() { check(!creating && !covered, 'A previous chat creation was not observed or the chat is covered'); creating = 'armed' },
    createdCount() { return created.size },
    select(sid) { check(created.has(sid), 'The interaction selected an unknown fixture chat'); selected = sid },
    cover(value) { covered = value },
    permitSend(sid) {
      check(!send && !covered && sid === selected && created.has(sid), 'Expected one explicit Send in the selected fixture chat')
      send = { sid }
    },
    async confirmDisplayed(sid, signal) {
      check(send?.sid === sid, 'No Send expected for this visible reply')
      await waitFor(() => {
        check(!violations, 'An unapproved conversation status request accompanied the explicit Send')
        return send.marked
      }, 'one real read acknowledgement for the completed displayed reply', { signal })
      send = undefined
    },
    permitFileRead(id, action) {
      check(!fileRead && typeof id === 'string' && /^w_[0-9a-f]{32}$/.test(id) && ['list','read'].includes(action),'Invalid manual workspace read scope')
      const receipt = { path:`/api/v1/workspaces/${id}/${action}`, seen:false, status:0 }; fileRead = receipt
      return async () => {
        await waitFor(() => receipt.status !== 0, `manual workspace ${action} received a response`,{timeout:6000})
        check(receipt.status === 200 && fileRead===receipt,'Unconfirmed manual workspace read'); fileRead = undefined
      }
    },
    assertTurns(expected) {
      check(!violations && !fileRead && !creating && !send, 'An interaction attempted an unapproved write, status request or unconfirmed workspace read')
      check(isDeepStrictEqual(turns, expected), 'Workbench turn writes did not match the explicit Send clicks and selected chats')
    },
    close: () => requests.unsubscribe(observe)
  }
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    check(size <= 32 * 1024, 'Upstream JSON exceeded the fixture limit')
    chunks.push(chunk)
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
}

function finishStream(res, reply, number) {
  const frame = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: `chatcmpl-client-interactions-${number}`,
    object: 'chat.completion.chunk', created: 1, model: modelId, choices: [{ index: 0, delta, finish_reason }] })}\n\n`
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' })
  res.write(frame({ content: reply }))
  res.end(frame({}, 'stop') + 'data: [DONE]\n\n')
}

/** A bounded real loopback HTTP/SSE provider. Exact bodies are compared but never logged. */
export async function startInteractionModel() {
  const key = randomBytes(24).toString('base64url')
  let count = 0, completed = 0, expected, failure
  const server = createServer((req, res) => {
    const number = ++count
    const turn = expected
    expected = undefined // A permit authorizes precisely one incoming request.
    const reject = reason => {
      failure ??= new InteractionCheckError(reason)
      if (!res.destroyed && !res.headersSent) res.writeHead(409, { connection: 'close' }).end()
      else res.destroy()
    }
    if (!turn) return reject('Upstream request occurred outside an explicit Send phase')
    if (req.method !== 'POST' || req.url !== modelRoute) return reject('Unexpected upstream method or route')
    if (req.headersDistinct.authorization?.length !== 1 || req.headers.authorization !== `Bearer ${key}` ||
        req.headers.cookie !== undefined || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) {
      return reject('Upstream used unexpected credentials or content type')
    }
    void (async () => {
      const body = await readBody(req)
      check(isDeepStrictEqual(body, { model: modelId, messages: [system, ...turn.messages], tools: [],
        max_tokens: 4096, stream: true, stream_options: { include_usage: true } }),
      'Upstream body differed from the exact expected text conversation and Markdown')
      finishStream(res, turn.reply, number)
      completed++
    })().catch(error => reject(error instanceof InteractionCheckError ? error.message : 'Upstream JSON or SSE processing failed'))
  })
  const assertCount = value => {
    if (failure) throw failure
    check(count === value && completed === value && !expected, 'Unexpected number of upstream requests or completed fixture replies')
  }
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    origin: `http://127.0.0.1:${server.address().port}`, key, assertCount,
    permitSend(previous, messages, reply) { assertCount(previous); expected = { messages, reply } },
    async waitForReply(number, signal) {
      await waitFor(() => { if (failure) throw failure; return completed === number }, 'exact upstream request and synthetic SSE reply', { signal })
      assertCount(number)
    },
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
      server.closeAllConnections()
    })
  }
}
