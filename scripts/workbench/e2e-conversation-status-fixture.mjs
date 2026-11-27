import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { access, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeMasterKey, openVault } from '../../apps/headless/src/storage/vault.mjs'
import { openSettings } from '../../apps/headless/src/business/settings.mjs'
import { waitFor } from './webdriver-local.mjs'

export class StatusCheckError extends Error {}
export function check(test, message) { if (!test) throw new StatusCheckError(message) }

export const provider = 'status-fixture'
export const primary = 'measured-fixture'
export const alternate = 'estimate-fixture'
export const providerName = 'Synthetic context fixture'
export const modelRef = model => `${provider}:${model}`
export const modelWindow = 12_800
export const measured = 3_200
export const prompts = ['Synthetic context question', 'Synthetic no-usage question']
export const replies = ['Synthetic measured reply.', 'Synthetic reply without usage.']
export const endpoint = '/api/v1/conversation-status/reads'
export const chatPath = sid => `/api/v1/chats/${sid}`

export async function privateFixture() {
  const parent = await realpath(tmpdir())
  const root = await mkdtemp(join(parent, 'deva-wb-conversation-status-'))
  const directory = async () => {
    const stat = await lstat(root)
    check(stat.isDirectory() && stat.uid === process.geteuid() && (stat.mode & 0o777) === 0o700 && await realpath(root) === root,
      'Synthetic root is not private, canonical and owned')
    return stat
  }
  const before = await directory()
  const [dataDir, keyFile, runDir, workspaceRoot, staticDir] = ['data', 'master.key', 'run', 'workspace', 'fixture-static'].map(s => join(root, s))
  const fixture = { root, dataDir, keyFile, runDir, workspaceRoot, staticDir,
    async close() {
      const current = await directory()
      check(before.dev === current.dev && before.ino === current.ino, 'Synthetic root changed identity before cleanup')
      await rm(root, { recursive: true })
      check(await lstat(root).then(() => false, error => error.code === 'ENOENT'), 'Synthetic root remains after cleanup')
    }
  }
  try {
    await Promise.all([workspaceRoot, staticDir].map(dir => mkdir(dir, { mode: 0o700 })))
    // Health checks run the production immutable-bundle validation even without a browser.
    for (const [name, bytes] of Object.entries({ 'index.html': '<!doctype html><title>Fixture-only service</title>',
      'workbench.js': 'export {}\n', 'manifest.json': '{"workbench.html":{"file":"workbench.js","isEntry":true}}' })) {
      await writeFile(join(staticDir, name), bytes, { flag: 'wx', mode: 0o600 })
    }
    await initializeMasterKey(keyFile)
    const key = await lstat(keyFile)
    check(key.isFile() && key.nlink === 1 && key.uid === process.geteuid() && (key.mode & 0o777) === 0o600,
      'Synthetic master key is not a private regular file')
    return fixture
  } catch (error) { await fixture.close(); throw error }
}

export async function configureModels({ dataDir, keyFile }, upstream) {
  const settings = await openSettings({ dataDir, vault: await openVault({ dataDir, keyFile }) })
  const { revision } = await settings.getPublicConfig()
  const models = [primary, alternate].map(id => ({ id, name: id, enabled: true, contextWindow: modelWindow, maxOutput: 512 }))
  const definition = { id: provider, name: providerName, kind: 'custom', purpose: 'llm', adapter: 'openai',
    apiHost: `${upstream.origin}/v1`, accent: '#345678', enabled: true, models }
  const installed = await settings.patch({ revision, unset: [], set: { locale: 'en', theme: 'light', models: {
    providers: [definition], activeModelId: modelRef(primary), activeEffort: 'default'
  } } })
  check((await settings.setKey(provider, upstream.key, installed.revision)).available, 'Synthetic provider key was not installed')
}

async function streamRequest(req) {
  const chunks = []
  let length = 0
  for await (const chunk of req) {
    length += chunk.length
    check(length <= 64 * 1024, 'Synthetic model request exceeded its bound')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

// Strictly loopback OpenAI wire fixture. A reply stays open until the verifier observes the
// actual first delta and moves both pages off the target. No model list or probe is permitted.
export async function startStatusModel(signal) {
  const key = `synthetic-${randomBytes(24).toString('hex')}`
  const calls = []
  let count = 0, failure
  const server = createServer((req, res) => {
    const n = ++count
    void (async () => {
      const selected = [primary, alternate][n - 1]
      check(selected && req.method === 'POST' && req.url === '/v1/chat/completions', 'Unexpected synthetic provider attempt or route')
      check(req.headers.authorization === `Bearer ${key}` && req.headersDistinct.authorization?.length === 1 && !req.headers.cookie,
        'Synthetic model did not receive its saved credential exclusively')
      const body = await streamRequest(req)
      const text = body.messages?.filter(x => x.role === 'user' || x.role === 'assistant').map(x => x.content)
      const expected = n === 1 ? [prompts[0]] : [prompts[0], replies[0], prompts[1]]
      check(body?.stream === true && body.model === selected && JSON.stringify(text) === JSON.stringify(expected) &&
        !body.tools?.length && !body.functions?.length, 'Synthetic turn did not contain the expected ordered conversation and selected model')
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
      res.flushHeaders()
      const frame = (delta, finish_reason = null) => ({ id: `chatcmpl-status-${n}`, object: 'chat.completion.chunk',
        created: 1, model: selected, choices: [{ index: 0, delta, finish_reason }] })
      const send = chunk => {
        check(!res.destroyed && !res.writableEnded, 'Original synthetic provider stream closed early')
        res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      }
      send(frame({ content: replies[n - 1] }))
      calls[n - 1] = { complete() {
        send(frame({}, 'stop'))
        if (n === 1) send({ ...frame({}), choices: [], usage: { prompt_tokens: measured, completion_tokens: 64, total_tokens: measured + 64 } })
        res.end('data: [DONE]\n\n')
      } }
    })().catch(error => {
      failure ??= error instanceof StatusCheckError ? error : new StatusCheckError('Synthetic model rejected the request body')
      if (!res.headersSent) res.writeHead(400).end(); else res.destroy()
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    origin: `http://127.0.0.1:${server.address().port}`, key,
    assertCount(expected) {
      if (failure) throw failure
      check(count === expected && calls.length === expected, `Expected ${expected} explicit model calls; observed ${count}`)
    },
    expect(n) { return waitFor(() => { if (failure) throw failure; return calls[n - 1] }, 'original loopback model stream', { signal }) },
    close() { return new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
      server.closeAllConnections()
    }) }
  }
}

export async function buildPrerequisites(webDir) {
  await Promise.all(['provider', 'chat', 'library'].map(name =>
    access(new URL(`../../apps/headless/dist/${name}-core.mjs`, import.meta.url)))).catch(() => {
    throw new StatusCheckError('Build headless cores with pnpm --filter @deva/headless build')
  })
  if (webDir) await access(join(webDir, 'index.html')).catch(() => {
    throw new StatusCheckError('Build the Vite renderer with pnpm workbench:build')
  })
}

export async function scopedRequest(origin, path, signal, { method = 'GET', body, cookie, csrf } = {}) {
  check(/^http:\/\/127\.0\.0\.1:\d+$/.test(origin) && /^\/[a-zA-Z0-9_/-]+$/.test(path), 'Unexpected synthetic HTTP target')
  const response = await fetch(`${origin}${path}`, { method, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
    headers: { ...(method !== 'GET' && { origin, 'content-type': 'application/json' }), ...(cookie && { cookie }), ...(csrf && { 'x-deva-csrf': csrf }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';', 1)[0] }
}
