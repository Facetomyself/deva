import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import test from 'node:test'
import { createAuthService } from '../src/auth/index.mjs'
import { httpPolicy, json } from '../src/http/policy.mjs'
import { appearanceSnapshot, sessionRoutes } from '../src/http/session-routes.mjs'

test('public origin and bootstrap projection are explicit', () => {
  for (const value of ['http://example.com', 'https://test:pw@example.com', 'https://example.com/a', 'https://example.com/?x=1'])
    assert.throws(() => httpPolicy(value))
  assert.equal(httpPolicy('https://example.test').cookieName, '__Host-deva-workbench')
  const cookie = httpPolicy('https://example.test').issueCookie('a'.repeat(43), Date.now() + 30000)
  assert.match(cookie, /; HttpOnly; SameSite=Strict; Secure;/)
  assert.doesNotMatch(cookie, /Domain=/)
  assert.deepEqual(appearanceSnapshot({ theme: 'dark', layout: { sidebarWidth: 280, sidebarCollapsed: false, key: 'private' }, models: { headers: { test: 'private' } }, locale: {}, closeToTray: true }),
    { theme: 'dark', layout: { sidebarWidth: 280, sidebarCollapsed: false } })
})

test('native HTTP: claim, session cookie, authenticated bootstrap, CSRF, logout and re-login', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'deva-wb-session-http-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const auth = await createAuthService({ dataDir: dir })
  let handler
  const server = createServer(async (req, res) => {
    if (!await handler(req, res)) json(res, 404, { error: 'not_found' })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise((ok) => server.close(ok)) })
  const origin = `http://127.0.0.1:${server.address().port}`
  const policy = httpPolicy(origin)
  handler = sessionRoutes({ auth, policy, version: 'qa', getConfig: () => ({ theme: 'dark', privateExample: 'NOT_IN_BOOTSTRAP' }) })
  const post = (path, body, extra = {}) => fetch(origin + path, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) })
  const before = await fetch(origin + '/api/v1/bootstrap'); assert.equal(before.status, 401)
  assert.deepEqual(await (await fetch(origin + '/api/v1/auth/state')).json(), { claimed: false })
  const { credential } = await auth.issueClaim()
  const password = 'a fairly long test phrase 2026'
  assert.equal((await post('/api/v1/auth/claim', { credential, password }, { origin: 'https://other.example' })).status, 403)
  const wrongHost = await new Promise((done, fail) => {
    request(origin + '/api/v1/auth/state', { headers: { host: 'unexpected.example', 'x-forwarded-host': new URL(origin).host } }, (r) => { r.resume(); done(r.statusCode) }).on('error', fail).end()
  })
  assert.equal(wrongHost, 403)
  assert.equal((await post('/api/v1/auth/claim', { credential, password, extra: 1 })).status, 400)
  assert.equal((await post('/api/v1/auth/claim', { credential, password: 'a'.repeat(17 * 1024) })).status, 413)
  const claim = await post('/api/v1/auth/claim', { credential, password }); assert.equal(claim.status, 200)
  const cookie = claim.headers.get('set-cookie').split(';')[0]; assert.match(cookie, /^deva-workbench-local=/)
  const issued = await claim.json(); assert.equal(typeof issued.csrf, 'string'); assert.equal(issued.session, undefined)
  const resumed = await fetch(origin + '/api/v1/bootstrap', { headers: { cookie } }); assert.equal(resumed.status, 200)
  assert.equal(resumed.headers.get('cache-control'), 'no-store')
  const snapshot = await resumed.json(); assert.equal(snapshot.csrf, issued.csrf); assert.deepEqual(snapshot.config, { theme: 'dark' }); assert.equal(snapshot.version, 'qa')
  assert.equal((await fetch(origin + '/api/v1/bootstrap', { headers: { cookie: `${cookie}; ${cookie}` } })).status, 401)
  assert.equal((await post('/api/v1/auth/logout', {}, { cookie })).status, 401)
  assert.equal((await post('/api/v1/auth/logout', {}, { cookie, 'x-deva-csrf': issued.csrf })).status, 200)
  assert.equal((await fetch(origin + '/api/v1/bootstrap', { headers: { cookie } })).status, 401)
  const login = await post('/api/v1/auth/login', { password }); assert.equal(login.status, 200)
  assert.notEqual(login.headers.get('set-cookie').split(';')[0], cookie)
  assert.equal((await fetch(origin + '/api/v1/auth/issue-claim')).status, 404)
})
