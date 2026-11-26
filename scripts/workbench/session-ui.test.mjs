import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'

// Use the pinned workspace compiler, as in the existing mount test (no TS loader required).
const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))
const ts = require('typescript')
const url = new URL('../../apps/desktop/src/workbench/transport.ts', import.meta.url)
const source = await readFile(url, 'utf8')
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText
const { captureClaim, createTransport, createSettingsBridge, installSettingsHost, HttpFailure } = await import(
  `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
)

const session = { protocol: 1, version: '1.0.0', platform: 'linux', config: { theme: 'dark' }, csrf: 'csrf-fixture', expiresAt: 1900000000000 }
const cfg = { theme: 'dark', locale: 'en', models: { providers: [{ id: 'existing' }] } }
const keys = { ids: ['existing'], available: true }
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
const deferred = () => {
  let resolve
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

function simulatedFetch(...steps) {
  let cursor = 0
  const seen = []
  const transport = createTransport(async (url, init) => {
    const [expected, send] = steps[cursor++] ?? []
    const request = { path: url, method: init.method, body: init.body === undefined ? undefined : JSON.parse(init.body), csrf: init.headers['x-deva-csrf'] }
    seen.push(request)
    assert.equal(init.credentials, 'same-origin')
    assert.equal(init.mode, 'same-origin')
    assert.equal(init.redirect, 'error')
    assert.equal(init.referrerPolicy, 'no-referrer')
    assert.equal(init.cache, 'no-store')
    assert.equal(init.headers.cookie, undefined)
    assert.equal(init.headers['content-type'], request.body === undefined ? undefined : 'application/json')
    assert.equal(`${init.method} ${url}`, expected, 'route and method')
    return typeof send === 'function' ? send(request) : send
  })
  return { transport, seen, done: () => assert.equal(cursor, steps.length) }
}

function initialSettings(...steps) {
  return simulatedFetch(
    ['GET /api/v1/settings', json({ config: cfg, revision: 'r0' })],
    ['GET /api/v1/provider-keys', json(keys)],
    ...steps
  )
}

function bridgeFor(transport, onFailure = (err) => assert.fail(String(err)), updateBrowserTheme = () => {}) {
  return createSettingsBridge({ transport, bootstrap: session, onFailure, updateBrowserTheme })
}

test('clears the claim fragment synchronously, preserving path, query and history state', () => {
  const state = { existing: true }
  const replacements = []
  const history = { state, replaceState: (...args) => replacements.push(args) }
  const location = { pathname: '/index.html', search: '?view=setup', hash: '#claim=sample%2Bvalue' }
  assert.equal(captureClaim(location, history), 'sample+value')
  assert.deepEqual(replacements, [[state, '', '/index.html?view=setup']])
  assert.equal(captureClaim({ ...location, hash: '#claim=a&claim=b' }, history), undefined)
  assert.equal(captureClaim({ ...location, hash: '#claim=' }, history), undefined)
  assert.equal(captureClaim({ ...location, hash: '#usage' }, history), undefined)
  assert.equal(replacements.length, 3)
})

test('inspection never claims or logs in; user submissions bootstrap and logout sends its CSRF', async () => {
  const auth = { csrf: session.csrf, expiresAt: session.expiresAt }
  const { transport, seen, done } = simulatedFetch(
    ['GET /api/v1/bootstrap', json({}, 401)],
    ['GET /api/v1/auth/state', json({ claimed: false })],
    ['POST /api/v1/auth/claim', json(auth)],
    ['GET /api/v1/bootstrap', json(session)],
    // A new document can resume the server-managed cookie without any client token persistence.
    ['GET /api/v1/bootstrap', json(session)],
    ['POST /api/v1/auth/logout', json({ ok: true })],
    ['GET /api/v1/bootstrap', json({}, 401)],
    ['GET /api/v1/auth/state', json({ claimed: true })],
    ['POST /api/v1/auth/login', json(auth)],
    ['GET /api/v1/bootstrap', json(session)]
  )
  assert.deepEqual(await transport.inspect(), { mode: 'claim' })
  assert.equal(seen.length, 2)
  assert.deepEqual(await transport.claim('claim-fixture', 'password-fixture'), session)
  assert.deepEqual(await transport.inspect(), { mode: 'authenticated', bootstrap: session })
  await transport.logout(session.csrf)
  assert.deepEqual(await transport.inspect(), { mode: 'login' })
  assert.deepEqual(await transport.login('password-fixture'), session)
  assert.deepEqual(seen.filter((r) => r.method === 'POST').map(({ body, csrf }) => ({ body, csrf })), [
    { body: { credential: 'claim-fixture', password: 'password-fixture' }, csrf: undefined },
    { body: undefined, csrf: session.csrf },
    { body: { password: 'password-fixture' }, csrf: undefined }
  ])
  done()
})

test('a broken session protocol or backend is not mistaken for an unclaimed server', async () => {
  const { transport, done } = simulatedFetch(
    ['GET /api/v1/bootstrap', json({ ...session, protocol: 2 })],
    ['GET /api/v1/bootstrap', json({}, 503)]
  )
  await assert.rejects(transport.inspect(), /Invalid session bootstrap/)
  await assert.rejects(transport.inspect(), (e) => e instanceof HttpFailure && e.status === 503)
  done()
})

test('bridge installs only settings APIs; real configuration and key flags are ready before use', async () => {
  const { transport, done } = initialSettings()
  let themeUpdates = 0
  const host = bridgeFor(transport, undefined, () => themeUpdates++)
  assert.deepEqual(host.api.config.getSync(), session.config)
  await host.ready
  const target = {}
  const release = installSettingsHost(target, host.api)
  assert.deepEqual(Object.keys(target.deva).sort(), ['config', 'provider', 'secrets', 'window'])
  assert.deepEqual(target.deva.config.getSync(), cfg)
  assert.deepEqual(await target.deva.secrets.list(), ['existing'])
  assert.equal(await target.deva.secrets.has('existing'), true)
  assert.equal(await target.deva.secrets.available(), true)
  await target.deva.window.setOverlaySymbolColor('#ffffff')
  assert.equal(themeUpdates, 1)
  assert.throws(() => installSettingsHost(target, host.api), /already has/)
  release()
  assert.equal('deva' in target, false)
  done()
})

test('writes and probe wait for the source of truth and advance one shared revision in order', async () => {
  const read = deferred()
  const patchSeen = deferred()
  const patchResult = deferred()
  const { transport, seen, done } = simulatedFetch(
    ['GET /api/v1/settings', () => read.promise],
    ['GET /api/v1/provider-keys', json(keys)],
    ['PATCH /api/v1/settings', ({ body }) => {
      patchSeen.resolve(body)
      return patchResult.promise
    }],
    ['PUT /api/v1/provider-keys/custom%20%2F%2B', json({ ok: true, available: true, revision: 'r2' })],
    ['POST /api/v1/provider-models', json({ ok: true, models: ['a-model'] })],
    ['DELETE /api/v1/provider-keys/custom%20%2F%2B', json({ ok: true, available: true, revision: 'r3' })],
    ['PATCH /api/v1/settings', json({ ok: true, revision: 'r4' })],
    ['POST /api/v1/auth/logout', json({ ok: true })]
  )
  const host = bridgeFor(transport)
  const args = { providerId: 'custom /+', adapter: 'openai', baseURL: 'https://models.example/v1' }
  const write = host.api.config.set({ locale: 'zh-CN', theme: undefined })
  const key = host.api.secrets.set(args.providerId, 'key-fixture')
  const probe = host.api.provider.listModels(args)
  assert.equal(seen.length, 2, 'no mutation before the initial GET acknowledges a revision')
  read.resolve(json({ config: cfg, revision: 'r0' }))
  assert.deepEqual(await patchSeen.promise, { set: { locale: 'zh-CN' }, unset: ['theme'], revision: 'r0' })
  assert.equal(seen.length, 3, 'probe and key cannot overtake an in-flight settings write')
  patchResult.resolve(json({ ok: true, revision: 'r1' }))
  assert.deepEqual(await write, { ok: true })
  assert.deepEqual(await key, { ok: true, available: true })
  assert.deepEqual((await probe).models, ['a-model'])
  assert.deepEqual(await host.api.config.get(), { locale: 'zh-CN', models: cfg.models })
  assert.equal(await host.api.secrets.has(args.providerId), true)
  assert.deepEqual(await host.api.secrets.delete(args.providerId), { ok: true })
  assert.equal(await host.api.secrets.has(args.providerId), false)
  const lastPatch = host.api.config.set({ theme: 'system' })
  const signOut = host.logout()
  await assert.rejects(host.api.config.set({ locale: 'en' }), /Session closed/)
  await lastPatch
  await signOut
  done()
  assert.ok(seen.slice(2).every((request) => request.csrf === session.csrf))
  assert.deepEqual(seen.slice(3).map(({ body }) => body), [
    { value: 'key-fixture', revision: 'r1' }, args, { revision: 'r2' },
    { set: { theme: 'system' }, unset: [], revision: 'r3' }, undefined
  ])
})

test('a stale write stops dependent writes and provider requests without replaying from new settings', async () => {
  const failure = []
  const { transport, done } = initialSettings(
    ['PATCH /api/v1/settings', json({ error: 'conflict' }, 409)],
    ['POST /api/v1/auth/logout', json({ ok: true })]
  )
  const host = bridgeFor(transport, (error) => failure.push(error))
  await host.ready
  const write = host.api.config.set({ models: { providers: [] } })
  const key = host.api.secrets.set('existing', 'key-fixture')
  const probe = host.api.provider.listModels({ providerId: 'existing', adapter: 'openai', baseURL: 'https://models.example/v1' })
  await assert.rejects(write, (e) => e instanceof HttpFailure && e.status === 409)
  await assert.rejects(key, /Reload settings/)
  await assert.rejects(probe, /Reload settings/)
  assert.deepEqual(await host.api.config.get(), cfg)
  assert.equal(failure.length, 1)
  assert.equal(failure[0].status, 409)
  await host.logout()
  done()
})

test('an address change uses the confirmed config and synchronizes credential presence before probing', async () => {
  const previous = { id: 'existing', apiHost: 'https://previous.example' }
  const update = { ...previous, apiHost: 'https://updated.example', headers: { 'x-config': 'header-fixture' } }
  const confirmed = { ...update, headers: { 'x-config': '[deva:stored-header]' } }
  const flags = deferred()
  const refreshStarted = deferred()
  const issues = []
  const { transport, seen, done } = simulatedFetch(
    ['GET /api/v1/settings', json({ config: { models: { providers: [previous] } }, revision: 'r0' })],
    ['GET /api/v1/provider-keys', json(keys)],
    ['PATCH /api/v1/settings', json({ ok: true, config: { models: { providers: [confirmed] } }, revision: 'r1' })],
    ['GET /api/v1/provider-keys', () => { refreshStarted.resolve(); return flags.promise }],
    ['POST /api/v1/provider-models', json({ error: 'provider_changed' }, 409)]
  )
  const host = bridgeFor(transport, (error) => issues.push(error))
  await host.ready
  const updateRequest = host.api.config.set({ models: { providers: [update] } })
  const probe = host.api.provider.listModels({ providerId: update.id, adapter: 'openai', baseURL: update.apiHost })
  await refreshStarted.promise
  assert.equal(seen.length, 4)
  flags.resolve(json({ ids: [], available: true }))
  await updateRequest
  assert.deepEqual(host.api.config.getSync(), { models: { providers: [confirmed] } })
  assert.equal(await host.api.secrets.has(update.id), false)
  await assert.rejects(probe, /409/)
  assert.equal(issues[0].status, 409)
  await assert.rejects(host.api.config.set({ theme: 'dark' }), /Reload settings/)
  done()
})

test('a revoked session drops the in-memory snapshot and blocks downstream writes', async () => {
  const failures = []
  const { transport, done } = initialSettings(['POST /api/v1/provider-models', json({ error: 'auth' }, 401)])
  const host = bridgeFor(transport, (error) => failures.push(error))
  await host.ready
  await assert.rejects(host.api.provider.listModels({ providerId: 'existing', adapter: 'openai', baseURL: 'https://models.example/v1' }), /401/)
  assert.deepEqual(host.api.config.getSync(), {})
  assert.deepEqual(await host.api.secrets.list(), [])
  await assert.rejects(host.api.config.set({ theme: 'dark' }), /Session closed/)
  assert.equal(failures[0].status, 401)
  done()
})

test('read failure exposes no editable bootstrap fallback; a lost write response pauses dependent work', async () => {
  const unavailable = simulatedFetch(
    ['GET /api/v1/settings', json({ error: 'unavailable' }, 503)],
    ['GET /api/v1/provider-keys', json(keys)]
  )
  const unread = bridgeFor(unavailable.transport)
  await assert.rejects(unread.ready, /503/)
  await assert.rejects(unread.api.config.get(), /503/)
  await assert.rejects(unread.api.config.set({ models: { providers: [] } }), /503/)
  unavailable.done()

  const failures = []
  const lost = initialSettings(['PATCH /api/v1/settings', () => { throw new TypeError('network failure') }])
  const host = bridgeFor(lost.transport, (error) => failures.push(error))
  await assert.rejects(host.api.config.set({ locale: 'zh-CN' }), /network failure/)
  await assert.rejects(host.api.secrets.delete('existing'), /Reload settings/)
  assert.deepEqual(await host.api.config.get(), cfg)
  assert.equal(failures.length, 1)
  lost.done()
})
