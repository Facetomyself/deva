import { randomBytes } from 'node:crypto'
import { channel } from 'node:diagnostics_channel'
import { once } from 'node:events'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { openSettings } from '../../apps/headless/src/business/settings.mjs'
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

// This observer reads only incoming method/path metadata and never accesses HTTP bodies, headers,
// or streams. The real Workbench handles every request, including the only permitted turn writes.
export function observeInteractionWrites(port) {
  const requests = channel('http.server.request.start')
  const turns = []; let violations = 0, fileRead, creating = false, created = 0
  const observe = ({ request, response }) => {
    if (request.socket.localPort !== port || ['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return
    const path = request.url ?? '', method = request.method
    const turn = /^\/api\/v1\/chats\/([\da-f-]+)\/turns$/.exec(path)
    if (turn && method === 'POST') turns.push(turn[1])
    else if (creating && method === 'POST' && path === '/api/v1/chats') { creating = false; created++ }
    else if (fileRead && !fileRead.seen && method === 'POST' && path === fileRead.path) {
      const receipt = fileRead; receipt.seen = true
      response.once('finish', () => { receipt.status = response.statusCode })
    } else if (method !== 'POST' || !['/api/v1/auth/claim','/api/v1/auth/login','/api/v1/auth/logout'].includes(path)) violations++
  }
  requests.subscribe(observe)
  return {
    permitCreate() { check(!creating,'A previous chat creation was not observed'); creating=true },
    createdCount() { return created },
    permitFileRead(id, action) {
      check(!fileRead && typeof id === 'string' && /^w_[0-9a-f]{32}$/.test(id) && ['list','read'].includes(action),'Invalid manual workspace read scope')
      const receipt = { path:`/api/v1/workspaces/${id}/${action}`, seen:false, status:0 }; fileRead = receipt
      return async () => {
        await waitFor(() => receipt.status !== 0, `manual workspace ${action} received a response`,{timeout:6000})
        check(receipt.status === 200 && fileRead===receipt,'Unconfirmed manual workspace read'); fileRead = undefined
      }
    },
    assertTurns(expected) {
      check(!violations && !fileRead && !creating, 'An interaction attempted an unapproved write or an unconfirmed workspace read')
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
