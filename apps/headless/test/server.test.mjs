import assert from 'node:assert/strict'
import { once } from 'node:events'
import * as fs from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { requestControl } from '../src/control/socket.mjs'
import { json } from '../src/http/policy.mjs'
import { startWorkbench } from '../src/server.mjs'
import { initializeMasterKey } from '../src/storage/vault.mjs'

const index = '<!doctype html><title>Workbench</title><script type="module" src="./workbench.js"></script>'
const entry = 'export const mountWorkbench = () => null;'
const manifest = {
  'entry.ts': { file: 'workbench.js', isEntry: true, dynamicImports: ['ui.ts'] },
  'ui.ts': { file: 'assets/ui-eS8VxZ.js', isDynamicEntry: true, css: ['assets/ui-eS8VxZ.css'] }
}

async function fixture(t, { assets = true, key = true } = {}) {
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'deva-srv-'))
  const dataDir = join(root, 'data')
  const keyFile = join(root, 'master.key')
  const webDir = join(root, 'web')
  const runDir = join(root, 'run')
  const instances = []
  t.after(async () => {
    await Promise.allSettled(instances.map(instance => instance.close()))
    await fs.rm(root, { recursive: true, force: true })
  })
  if (key) await initializeMasterKey(keyFile)
  if (assets) {
    await fs.mkdir(join(webDir, 'assets'), { recursive: true })
    await Promise.all([
      fs.writeFile(join(webDir, 'index.html'), index),
      fs.writeFile(join(webDir, 'workbench.js'), entry),
      fs.writeFile(join(webDir, 'manifest.json'), JSON.stringify(manifest)),
      fs.writeFile(join(webDir, 'assets', 'ui-eS8VxZ.js'), 'export const ui = {};'),
      fs.writeFile(join(webDir, 'assets', 'ui-eS8VxZ.css'), 'body { margin: 0 }'),
      fs.writeFile(join(webDir, 'assets', 'ui-eS8VxZ.js.map'), 'not public'),
      fs.writeFile(join(webDir, 'assets', 'unlisted.js'), 'not public'),
      fs.writeFile(join(webDir, '.env'), 'not public')
    ])
  }
  const opts = { dataDir, keyFile, runDir, webDir, port: 0, version: 'test', businessFactory: fakeBusiness }
  async function start(overrides) {
    const instance = await startWorkbench({ ...opts, ...overrides })
    instances.push(instance)
    return instance
  }
  return { root, dataDir, keyFile, webDir, runDir, opts, start }
}

function fakeBusiness() {
  return { getConfig: () => ({ theme: 'dark', secret: 'not public' }), handle: async () => false, close() {} }
}

function http(instance, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port: instance.address.port, path, method, agent: false,
      headers: Object.fromEntries(Object.entries({ host: new URL(instance.origin).host, ...headers }).filter(([, value]) => value !== undefined))
    }, res => {
      const bytes = []
      res.on('data', chunk => bytes.push(chunk))
      res.on('error', reject)
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers, text: Buffer.concat(bytes).toString('utf8')
      }))
    })
    req.once('error', reject)
    req.end(body)
  })
}

function post(instance, path, body, headers = {}) {
  return http(instance, path, {
    method: 'POST', headers: { origin: instance.origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body)
  })
}

test('serves only the same-origin verified Vite bundle; routes API and probes independently', async t => {
  const paths = await fixture(t)
  const svc = await paths.start({ publicUrl: 'https://workbench.invalid' })
  assert.equal(svc.origin, 'https://workbench.invalid')
  assert.equal(svc.address.address, '127.0.0.1')
  const page = await http(svc, '/')
  assert.equal(page.status, 200)
  assert.equal(page.text, index)
  assert.match(page.headers['content-security-policy'], /script-src 'self';/)
  assert.equal(page.headers['referrer-policy'], 'no-referrer')
  assert.equal(page.headers['permissions-policy'], 'clipboard-read=(), clipboard-write=(self), fullscreen=(self)')
  assert.equal((await http(svc, '/index.html')).text, index)
  const js = await http(svc, '/workbench.js?build=test')
  assert.equal(js.text, entry)
  assert.match(js.headers['content-type'], /^text\/javascript/)
  const css = await http(svc, '/assets/ui-eS8VxZ.css', { method: 'HEAD' })
  assert.equal(css.status, 200)
  assert.equal(css.text, '')
  assert.match(css.headers['content-type'], /^text\/css/)
  assert.equal((await http(svc, '/assets/ui-eS8VxZ.js')).text, 'export const ui = {};')
  assert.equal((await http(svc, '/workbench.js', { method: 'POST' })).status, 405)
  for (const path of ['/livez', '/readyz', '/healthz']) {
    const probe = await http(svc, path)
    assert.equal(probe.status, 200)
    assert.match(probe.headers['content-type'], /^application\/json/)
    assert.equal((await http(svc, path, { method: 'HEAD' })).text, '')
    assert.equal((await http(svc, path, { method: 'POST' })).status, 405)
    assert.equal((await http(svc, `${path}?unknown`)).status, 400)
  }
  for (const path of ['/manifest.json', '/assets/unlisted.js', '/assets/ui-eS8VxZ.js.map', '/.env', '/data/headless-vault.json',
    '/api/v1/latest', '/api/v1/auth/issue-claim', '/readyz/subpath', '/another-page']) {
    const reply = await http(svc, path)
    assert.equal(reply.status, 404, path)
    assert.deepEqual(JSON.parse(reply.text), { error: 'not_found' })
  }
  for (const path of ['//index.html', '/assets/../index.html', '/assets/%2e%2e/index.html', 'http://workbench.invalid/']) {
    assert.equal((await http(svc, path)).status, 400, path)
  }
  for (const path of ['/', '/livez', '/api/v1/auth/state']) {
    assert.equal((await http(svc, path, { headers: {
      host: 'incorrect.invalid', 'x-forwarded-host': 'workbench.invalid'
    } })).status, 403)
    assert.equal((await http(svc, path, { headers: { origin: 'https://incorrect.invalid' } })).status, 403)
    assert.equal((await http(svc, path, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403)
  }
})

test('missing, invalid, or replaced bundle assets never become an SPA fallback or a ready service', async t => {
  const paths = await fixture(t)
  const svc = await paths.start()
  const leaf = join(paths.webDir, 'assets', 'ui-eS8VxZ.js')
  const unrelated = join(paths.root, 'outside.js')
  await fs.writeFile(unrelated, 'outside asset path')
  await fs.rename(leaf, join(paths.root, 'original.js'))
  await fs.symlink(unrelated, leaf)
  assert.equal((await http(svc, '/assets/ui-eS8VxZ.js')).status, 503)
  assert.equal((await http(svc, '/livez')).status, 200)
  assert.deepEqual(JSON.parse((await http(svc, '/readyz')).text), { status: 'not_ready' })
  assert.equal((await http(svc, '/api/v1/auth/state')).status, 200)
  await svc.close()

  const invalid = await paths.start()
  assert.equal((await http(invalid, '/readyz')).status, 503)
  assert.equal((await http(invalid, '/')).status, 503)
  await invalid.close()

  const empty = await paths.start({ webDir: join(paths.root, 'not-yet-built') })
  assert.equal((await http(empty, '/livez')).status, 200)
  assert.equal((await http(empty, '/healthz')).status, 503)
  assert.equal((await http(empty, '/api/v1/nonexistent')).status, 404)
  await empty.close()

  const overlapping = join(paths.dataDir, 'public')
  await assert.rejects(paths.start({ webDir: overlapping }), /separate from private runtime paths/)
})

test('rejects out-of-namespace files, missing dependencies, and regular-file aliases at startup', async t => {
  const paths = await fixture(t)
  const manifestPath = join(paths.webDir, 'manifest.json')
  for (const file of ['../master.key', 'regular.js', 'assets/../workbench.js', 'assets/ui-eS8VxZ.js.map']) {
    await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, extra: { file } }))
    const svc = await paths.start()
    assert.equal((await http(svc, '/readyz')).status, 503, file)
    await svc.close()
  }
  await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, 'ui.ts': { ...manifest['ui.ts'], imports: ['missing.ts'] } }))
  const missing = await paths.start()
  assert.equal((await http(missing, '/readyz')).status, 503)
  await missing.close()

  const alias = 'assets/alias.js'
  await fs.link(join(paths.keyFile), join(paths.webDir, alias))
  await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, alias: { file: alias } }))
  // The real key reader also excludes hard-linked secrets; serve uses a separate key for this check.
  const independent = join(paths.root, 'independent.key')
  await initializeMasterKey(independent)
  const isolated = await fixture(t)
  const svc = await isolated.start({ webDir: paths.webDir, keyFile: independent })
  assert.equal((await http(svc, '/readyz')).status, 503)
  assert.equal((await http(svc, `/${alias}`)).status, 404)
})

test('Unix claim, HTTP sessions, vault, and business API all use the same instance', async t => {
  const { runDir, dataDir, start } = await fixture(t)
  let instanceClosed = 0
  const businessFactory = async options => {
    assert.equal(options.version, 'test')
    assert.equal(options.dataDir, dataDir)
    assert.deepEqual(options.allowedOrigins, ['http://127.0.0.1:2345'])
    const { vault } = options
    await vault.set('test:enabled', 'yes')
    return {
      getConfig: () => ({ theme: 'dark', models: ['private example'] }),
      async handle(req, res, { auth, policy }) {
        if (req.url !== '/api/v1/test-business') return false
        auth.authenticate(policy.cookie(req), req.headers['x-deva-csrf'])
        json(res, 200, { enabled: await vault.get('test:enabled') === 'yes' })
        return true
      },
      close() { instanceClosed++ }
    }
  }
  let svc = await start({ businessFactory, businessOptions: { allowedOrigins: ['http://127.0.0.1:2345'] } })
  assert.deepEqual(await requestControl({ runDir, op: 'status' }), { claimed: false })
  assert.equal((await http(svc, '/api/v1/bootstrap')).status, 401)
  const { credential } = await requestControl({ runDir, op: 'claim' })
  const password = 'one long test phrase 2026'
  assert.equal((await post(svc, '/api/v1/auth/claim', { credential, password }, { origin: undefined })).status, 403)
  const claimed = await post(svc, '/api/v1/auth/claim', { credential, password })
  assert.equal(claimed.status, 200)
  const { csrf } = JSON.parse(claimed.text)
  const cookie = claimed.headers['set-cookie'][0].split(';')[0]
  assert.match(cookie, /^deva-workbench-local=/)
  assert.equal(claimed.text.includes(credential), false)
  assert.deepEqual(await requestControl({ runDir, op: 'status' }), { claimed: true })
  await assert.rejects(requestControl({ runDir, op: 'claim' }), { code: 'CONTROL_FAILED' })
  const bootstrap = await http(svc, '/api/v1/bootstrap', { headers: { cookie } })
  assert.equal(bootstrap.status, 200)
  assert.deepEqual(JSON.parse(bootstrap.text).config, { theme: 'dark' })
  assert.equal((await post(svc, '/api/v1/test-business', {}, { cookie })).status, 401)
  const reply = await post(svc, '/api/v1/test-business', {}, { cookie, 'x-deva-csrf': csrf })
  assert.deepEqual(JSON.parse(reply.text), { enabled: true })
  const socket = svc.controlPath
  await svc.close()
  await assert.rejects(fs.lstat(socket), { code: 'ENOENT' })
  assert.equal(instanceClosed, 1)
  svc = await start()
  assert.deepEqual(await requestControl({ runDir, op: 'status' }), { claimed: true })
  assert.equal((await http(svc, '/api/v1/bootstrap', { headers: { cookie } })).status, 401)
})

test('exclusive writer and startup rollback preserve data and release the Unix endpoint', async t => {
  const paths = await fixture(t)
  const svc = await paths.start()
  await assert.rejects(paths.start({ runDir: join(paths.root, 'alternate-run') }), /startup failed \(writer lock\)/)
  await svc.close()
  const vault = join(paths.dataDir, 'headless-vault.json')
  const original = await fs.readFile(vault)
  const wrongKey = join(paths.root, 'other.key')
  await initializeMasterKey(wrongKey)
  await assert.rejects(paths.start({ keyFile: wrongKey }), error =>
    error.message === 'Workbench startup failed (vault)' && error.cause?.code === 'ERR_VAULT_AUTH')
  assert.deepEqual(await fs.readFile(vault), original)
  await assert.rejects(fs.lstat(svc.controlPath), { code: 'ENOENT' })

  const busy = createServer()
  busy.listen(0, '127.0.0.1')
  await once(busy, 'listening')
  t.after(() => new Promise(resolve => busy.close(resolve)))
  let closed = 0
  await assert.rejects(paths.start({
    port: busy.address().port, businessFactory: () => ({ ...fakeBusiness(), close() { closed++ } })
  }), error => error.message === 'Workbench startup failed (HTTP listener)' && error.cause?.code === 'EADDRINUSE')
  assert.equal(closed, 1)
  await assert.rejects(fs.lstat(svc.controlPath), { code: 'ENOENT' })
  assert.equal((await http(await paths.start(), '/readyz')).status, 200)
})

test('graceful close retains the writer lock until application handlers and business shutdown finish', async t => {
  const paths = await fixture(t)
  const started = Promise.withResolvers()
  const interrupted = Promise.withResolvers()
  const drained = Promise.withResolvers()
  const svc = await paths.start({ shutdownTimeoutMs: 10, businessFactory: () => ({
    ...fakeBusiness(),
    async handle(_req, res) {
      res.once('close', interrupted.resolve)
      started.resolve()
      await drained.promise
      return true
    },
    close() {
      // The lock still excludes another writer when close is invoked.
      return assert.rejects(paths.start(), /startup failed \(writer lock\)/)
    }
  }) })
  t.after(() => drained.resolve())
  const transport = http(svc, '/api/v1/test-business').catch(error => error)
  await started.promise
  const close = svc.close()
  try {
    await interrupted.promise
    assert.strictEqual(svc.close(), close)
    assert.ok((await transport) instanceof Error)
    await assert.rejects(paths.start(), /startup failed \(writer lock\)/)
  } finally {
    drained.resolve()
  }
  await close
  assert.equal((await http(await paths.start(), '/readyz')).status, 200)
})
