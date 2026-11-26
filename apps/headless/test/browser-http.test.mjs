import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { requestControl } from '../src/control/socket.mjs'
import { startWorkbench } from '../src/server.mjs'
import { initializeMasterKey } from '../src/storage/vault.mjs'

async function fixture(t, configured) {
  const base = await realpath(tmpdir()), root = await mkdtemp(join(base, 'deva-http-browser-'))
  assert.equal(dirname(root), base)
  const opts = { dataDir: join(root, 'data'), runDir: join(root, 'run'), keyFile: join(root, 'master.key'),
    webDir: join(root, 'web'), port: 0, businessOptions: configured ? { browserRunDir: join(root, 'absent') } : {} }
  let app
  t.after(async () => { try { await app?.close() } finally { await rm(root, { recursive: true, force: true }) } })
  await initializeMasterKey(opts.keyFile)
  app = await startWorkbench(opts)
  const api = (path, init) => fetch(app.origin + '/api/v1/' + path, init)
  const { credential } = await requestControl({ runDir: opts.runDir, op: 'claim' })
  const claim = await api('auth/claim', { method: 'POST', headers: { origin: app.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ credential, password: randomBytes(24).toString('base64url') }) })
  assert.equal(claim.status, 200)
  const cookie = claim.headers.get('set-cookie').split(';')[0], { csrf } = await claim.json()
  const post = (path, body, extra = {}) => api(path, { method: 'POST',
    headers: { origin: app.origin, cookie, 'x-deva-csrf': csrf, 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) })
  const get = (path, extra = {}) => api(path, { headers: { cookie, ...extra } })
  return { api, get, post }
}

test('no browser deployment leaves general chat available and does not advertise a browser', { timeout: 20_000 }, async t => {
  const { api, get, post } = await fixture(t, false)
  assert.equal((await api('browser/status')).status, 401)
  assert.deepEqual(await (await get('browser/status')).json(), { state: 'unconfigured' })
  assert.deepEqual(await (await get('browser/sites')).json(), { sites: [] })
  const { capabilities } = await (await get('bootstrap')).json()
  assert.equal(capabilities.browserPanel, false); assert.equal(capabilities.textChat, true)
  const { session } = await (await post('chats', {})).json()
  assert.ok(session.id)
  const open = `chats/${session.id}/browser/open`
  assert.equal((await post(open, { siteId: 'docs' })).status, 503)
  assert.equal((await post(open, { siteId: 'docs' }, { 'x-deva-csrf': '' })).status, 401)
  assert.equal((await post(open, { siteId: 'docs' }, { origin: 'https://other.invalid' })).status, 403)
  assert.equal((await get('browser/status?token=not-a-token')).status, 400)
  assert.equal((await get(open)).status, 403, 'an origin-less request to a private write route is rejected before dispatch')
  const origin = new URL((await get('browser/status')).url).origin
  assert.equal((await get(open, { origin })).status, 405)
})

test('configuring a socket without a worker exposes a truthful status, no tab and no control frames', { timeout: 20_000 }, async t => {
  const { get, post } = await fixture(t, true)
  const { capabilities } = await (await get('bootstrap')).json()
  assert.equal(capabilities.browserPanel, true)
  assert.deepEqual(await (await get('browser/status')).json(), { state: 'worker-unavailable' })
  const sid = (await (await post('chats', {})).json()).session.id
  const root = `chats/${sid}/browser`
  assert.deepEqual(await (await get(root)).json(), { tabs: [] })
  assert.equal((await post(root + '/open', { url: 'http://example.invalid/' })).status, 400)
  assert.equal((await post(root + '/open', { siteId: 'docs' })).status, 503)
  const stub = 'A'.repeat(24)
  const bad = await post(`${root}/${stub}/frame`, { token: 'short', viewerNonce: 'short' })
  assert.equal(bad.status, 403); assert.equal(bad.headers.get('cache-control'), 'no-store')
  assert.equal((await post(`${root}/${stub}/close`, { actor: { role: 'owner' } })).status, 400)
  assert.equal((await post('auth/logout', {})).status, 200)
  assert.equal((await get('browser/status')).status, 401)
})
