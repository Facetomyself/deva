import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { startWorkbench } from '../src/server.mjs'
import { initializeMasterKey } from '../src/storage/vault.mjs'
import { requestControl } from '../src/control/socket.mjs'

// A real HTTP model endpoint (not a stub of the service, provider core, or settings handler).
test('empty-volume auth → revisioned model settings → bound key → provider response → restart', { timeout: 30000 }, async t => {
  const tmp = await mkdtemp(join(tmpdir(), 'deva-flow-')); t.after(() => rm(tmp, { recursive: true, force: true }))
  const key = randomBytes(24).toString('hex'); const tenant = randomBytes(12).toString('hex')
  const seen = []
  const api = createServer((req, res) => {
    seen.push({ url: req.url, ok: req.headers.authorization === `Bearer ${key}` && req.headers['x-test-tenant'] === tenant })
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'e2e-test-model' }, { id: key }] }))
  }); api.listen(0, '127.0.0.1'); await once(api, 'listening')
  t.after(async () => { api.closeAllConnections(); await new Promise(ok => api.close(ok)) })
  const o = `http://127.0.0.1:${api.address().port}`
  const dataDir = join(tmp, 'data'); const keyFile = join(tmp, 'master.key'); const runDir = join(tmp, 'run')
  await initializeMasterKey(keyFile); const webDir = join(tmp, 'assets'); await mkdir(webDir)
  const opts = { dataDir, keyFile, runDir, webDir, port: 0, businessOptions: { allowedOrigins: [o] } }
  let app = await startWorkbench(opts); t.after(() => app.close())
  let cookie, csrf
  const call = async (path, method = 'GET', body, passCsrf = true) => {
    const headers = { ...(cookie ? { cookie } : {}), ...(method === 'GET' ? {} : { origin: app.origin, 'content-type': 'application/json', ...(passCsrf && csrf ? { 'x-deva-csrf': csrf } : {}) }) }
    return fetch(`${app.origin}/api/v1/${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  }
  const password = randomBytes(24).toString('base64url')
  async function accept(r) { assert.equal(r.status, 200); cookie = r.headers.get('set-cookie').split(';')[0]; csrf = (await r.json()).csrf }
  assert.equal((await call('settings')).status, 401)
  const { credential } = await requestControl({ runDir, op: 'claim' }); await accept(await call('auth/claim', 'POST', { credential, password }))
  const first = await (await call('settings')).json(); assert.match(first.revision, /^[a-f0-9]{64}$/)
  const provider = { id: 'e2e-private', name: 'Test', kind: 'custom', purpose: 'llm', accent: '#123456', adapter: 'openai',
    apiHost: o + '/v1', headers: { 'x-test-tenant': tenant }, enabled: true, models: [{ id: 'e2e-test-model', name: 'Test Model', enabled: true }] }
  const patch = { set: { theme: 'dark', models: { providers: [provider], activeModelId: `${provider.id}:e2e-test-model`, activeEffort: 'default' } }, unset: [], revision: first.revision }
  assert.equal((await call('settings', 'PATCH', patch, false)).status, 401)
  const save = await call('settings', 'PATCH', patch); assert.equal(save.status, 200); const saved = await save.json()
  assert.equal(saved.config.models.providers.find(p => p.id === provider.id).headers['x-test-tenant'], '[deva:stored-header]')
  assert.equal((await call('settings', 'PATCH', patch)).status, 409)
  const keyPath = `provider-keys/${provider.id}`; assert.equal((await call(keyPath, 'PUT', { value: key })).status, 409)
  const add = await call(keyPath, 'PUT', { value: key, revision: saved.revision }); assert.equal(add.status, 200); const afterKey = await add.json()
  assert.equal((await call(keyPath, 'DELETE', { revision: saved.revision })).status, 409)
  const probe = { providerId: provider.id, adapter: provider.adapter, baseURL: provider.apiHost }
  assert.equal((await call('provider-models', 'POST', { ...probe, baseURL: o + '/different' })).status, 409)
  assert.equal(seen.length, 0)
  const list = await call('provider-models', 'POST', probe); assert.equal(list.status, 200); assert.deepEqual(await list.json(), { ok: true, models: ['e2e-test-model'] })
  assert.deepEqual(seen, [{ url: '/v1/models', ok: true }]); assert.deepEqual((await (await call('provider-keys')).json()).ids, [provider.id])
  const bytes = await readFile(join(dataDir, 'config.json'), 'utf8'); assert.ok(!bytes.includes(key) && !bytes.includes(tenant))
  const bootstrap = await (await call('bootstrap')).json(); assert.deepEqual(bootstrap.config, { theme: 'dark' })
  await app.close(); app = await startWorkbench(opts)
  assert.equal((await call('settings')).status, 401); await accept(await call('auth/login', 'POST', { password }))
  assert.deepEqual(await (await call('provider-models', 'POST', probe)).json(), { ok: true, models: ['e2e-test-model'] })
  const recovered = await (await call('settings')).json(); assert.equal(recovered.revision, afterKey.revision)
  const remove = await call(keyPath, 'DELETE', { revision: recovered.revision }); assert.equal(remove.status, 200)
  assert.deepEqual((await (await call('provider-keys')).json()).ids, [])
})
