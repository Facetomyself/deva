import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))
const ts = require('typescript')
const src = new URL('../../apps/desktop/src/workbench/', import.meta.url)
async function moduleUrl(name, dependencies = {}) {
  let js = ts.transpileModule(await readFile(new URL(`${name}.ts`, src), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext }
  }).outputText
  for (const [from, to] of Object.entries(dependencies)) js = js.replaceAll(`'${from}'`, `'${to}'`)
  return `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
}
const transportUrl = await moduleUrl('transport')
const browserUrl = await moduleUrl('browser-transport')
const { createTransport, HttpFailure } = await import(transportUrl)
const { createBrowserTransport, isBrowserKey, isBrowserText, newViewerNonce, pointsOnFrame, wheelPixels } = await import(browserUrl)
const { createManualBrowserPanel } = await import(await moduleUrl('browser-manual', { './transport': transportUrl, './browser-transport': browserUrl }))

const sid = 'the-original_chat-01'
const tabId = 'abcdefghijklmnopqrstuvwxyz'.slice(0, 24)
const site = { id: 'guest-form', label: 'Local form', origin: 'http://example.test:7010' }
const tab = { sessionId: sid, tabId, state: 'open', siteId: site.id, label: site.label, origin: site.origin }
const returned = { ...tab, state: 'returned' }
const rand = (byte) => Buffer.alloc(32, byte).toString('base64url')
const proof = { viewerNonce: rand(254), token: rand(7) }
const bootstrap = { protocol: 1, version: '1.0.0', platform: 'linux', config: {}, csrf: 'owner-csrf', expiresAt: 1900000000000 }
const json = (v, status = 200) => new Response(JSON.stringify(v), { status })
const frameHeader = (width = 1024, height = 768) => {
  const bytes = Buffer.alloc(45)
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(bytes)
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}
const png = (width, height) => new Response(frameHeader(width, height), { headers: { 'content-type': 'image/png' } })
const deferred = () => Promise.withResolvers ? Promise.withResolvers() : (() => {
  let resolve, reject
  const promise = new Promise((rs, rj) => { resolve = rs; reject = rj })
  return { promise, resolve, reject }
})()
const tick = () => new Promise((resolve) => setImmediate(resolve))

const mouse = { type: 'click', x: 431, y: 155 }
const scroll = { type: 'scroll', x: 431, y: 155, deltaX: -5, deltaY: 190 }
const text = { type: 'text', text: '手动输入 👋' }
const key = { type: 'key', key: 'Enter' }

test('capability is strict and browser requests carry only the confirmed HTTP projection', async () => {
  const prefix = `/chats/${sid}/browser`
  const endpoint = `${prefix}/${tabId}`
  const steps = [
    ['GET', '/bootstrap', undefined, json({ ...bootstrap, capabilities: { browserPanel: 'true' } })],
    ['GET', '/bootstrap', undefined, json({ ...bootstrap, capabilities: { textChat: true, browserPanel: true } })],
    ['GET', '/browser/status', undefined, json({ state: 'ready' })],
    ['GET', '/browser/sites', undefined, json({ sites: [site] })],
    ['GET', prefix, undefined, json({ tabs: [{ ...tab, controlId: 'worker-only' }] })],
    ['POST', `${prefix}/open`, { siteId: site.id }, json({ tab })],
    ['POST', `${endpoint}/lease`, { viewerNonce: proof.viewerNonce, intent: 'control' }, json({ token: proof.token, ttlMs: 60_000, controlId: 'worker-only' })],
    ['POST', `${endpoint}/frame`, proof, png()],
    ...[mouse, scroll, text, key].map((action, i) => ['POST', `${endpoint}/input`, { ...proof, seq: i + 1, action }, json({ accepted: true, seq: i + 1 })]),
    ['POST', `${endpoint}/finish`, { ...proof, intent: 'done' }, json({ tab: returned })],
    ['POST', `${endpoint}/close`, {}, json({ closed: true })]
  ]
  const signal = new AbortController().signal
  const base = createTransport(async (url, init) => {
    const [method, route, body, response] = steps.shift()
    assert.equal(url, `/api/v1${route}`)
    assert.equal(init.method, method)
    assert.deepEqual(init.body ? JSON.parse(init.body) : undefined, body)
    assert.equal(init.credentials, 'same-origin')
    assert.equal(init.mode, 'same-origin')
    assert.equal(init.redirect, 'error')
    assert.equal(init.cache, 'no-store')
    assert.equal(init.headers.accept, route.endsWith('/frame') ? 'image/png' : 'application/json')
    if (route !== '/bootstrap') {
      assert.equal(init.headers['x-deva-csrf'], bootstrap.csrf)
      assert.equal(init.referrerPolicy, 'same-origin')
    }
    if (route === `${endpoint}/frame`) assert.equal(init.signal, signal)
    return response
  })
  assert.equal((await base.inspect()).bootstrap.capabilities, undefined)
  assert.deepEqual((await base.inspect()).bootstrap.capabilities, { textChat: true, browserPanel: true })
  const api = createBrowserTransport(base, bootstrap.csrf)
  assert.equal(await api.status(signal), 'ready')
  assert.deepEqual(await api.sites(signal), [site])
  assert.deepEqual(await api.tabs(sid, signal), [tab])
  assert.deepEqual(await api.open(sid, site, signal), tab)
  assert.deepEqual(await api.lease(sid, tabId, proof.viewerNonce), { token: proof.token, ttlMs: 60_000 })
  const frame = await api.frame(sid, tabId, proof, signal)
  assert.equal(frame.type, 'image/png')
  assert.deepEqual(Buffer.from(await frame.arrayBuffer()), frameHeader())
  for (const [i, action] of [mouse, scroll, { ...text, controlId: 'not-in-projection' }, key].entries()) await api.input(sid, tabId, proof, i + 1, action, signal)
  assert.deepEqual(await api.finish(sid, tabId, proof, 'done'), returned)
  await api.close(sid, tabId, signal)
  assert.equal(steps.length, 0)
})

test('transport rejects alias paths, foreign tabs, malformed frames, invalid actions and wrong receipts', async () => {
  const signal = new AbortController().signal
  const responses = [json({ tabs: [{ ...tab, sessionId: 'someone-else' }] }), json({ tabs: [{ ...tab, origin: `${site.origin}/secret` }] }),
    json({ tab: { ...tab, origin: 'https://foreign.test' } }), png(1025, 768), new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }),
    json({ accepted: true, seq: 4 }), json({ tab: { ...returned, tabId: 'A'.repeat(24) } }), json({ error: proof.token }, 401)]
  const api = createBrowserTransport(createTransport(async () => responses.shift()), bootstrap.csrf)
  const bad = /Invalid browser panel/
  for (const path of ['../other', '/other', '.chat', 'chat:suffix', 'chat%2falias', 'chat\n']) await assert.rejects(api.tabs(path, signal), bad)
  await assert.rejects(api.close(sid, `${tabId}\n`, signal), bad)
  await assert.rejects(api.lease(sid, tabId, 'Z'.repeat(43)), bad)
  for (const action of [{ type: 'eval', script: 'return 1' }, { type: 'click', x: 1024, y: 0 },
    { type: 'key', key: 'F5' }, { type: 'text', text: 'X'.repeat(1025) }, { type: 'text', text: '\n' }]) {
    await assert.rejects(api.input(sid, tabId, proof, 1, action, signal), bad)
  }
  await assert.rejects(api.tabs(sid, signal), bad)
  await assert.rejects(api.tabs(sid, signal), bad)
  await assert.rejects(api.open(sid, site, signal), bad)
  await assert.rejects(api.frame(sid, tabId, proof, signal), bad)
  await assert.rejects(api.frame(sid, tabId, proof, signal), bad)
  await assert.rejects(api.input(sid, tabId, proof, 1, mouse, signal), bad)
  await assert.rejects(api.finish(sid, tabId, proof, 'skip'), bad)
  await assert.rejects(api.status(signal), (error) => error.status === 401 && error.code === undefined && !error.message.includes(proof.token))
  assert.equal(responses.length, 0)
})

test('nonce is canonical base64url and gestures use scoped frame pixels and the fixed key list', () => {
  const first = newViewerNonce(webcrypto)
  const second = newViewerNonce(webcrypto)
  assert.match(first, /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u)
  assert.notEqual(first, second)
  assert.equal(Buffer.from(first, 'base64url').length, 32)
  let raw
  assert.equal(newViewerNonce({ getRandomValues: (buffer) => { raw = buffer; return buffer.fill(254) } }), rand(254))
  assert.ok(raw.every((byte) => byte === 0))
  const rect = { left: 10, top: 30, width: 512, height: 384 }
  assert.deepEqual(pointsOnFrame(rect, 266, 222), { x: 512, y: 384 })
  assert.deepEqual(pointsOnFrame(rect, 521.9, 413.9), { x: 1023, y: 767 })
  assert.equal(pointsOnFrame(rect, 522, 414), undefined)
  assert.equal(pointsOnFrame(rect, NaN, 68), undefined)
  assert.equal(wheelPixels(-2, 1, 1024), -32)
  assert.equal(wheelPixels(6, 2, 768), 2048)
  assert.equal(isBrowserKey('ArrowRight'), true)
  assert.equal(isBrowserKey('Control'), false)
  assert.equal(isBrowserText('\ud800'), false)
  assert.equal(isBrowserText('😀'.repeat(512)), true)
})

function fixture(overrides = {}) {
  const calls = []
  const urls = []
  const revoked = []
  const timers = new Map()
  let id = 0, generation = 90, now = 20, expired = 0
  const methods = {
    status: async () => 'ready',
    sites: async () => [site],
    tabs: async () => [],
    open: async () => tab,
    lease: async () => ({ token: rand(generation), ttlMs: 60_000 }),
    frame: async () => new Blob([frameHeader()], { type: 'image/png' }),
    input: async () => {},
    finish: async () => returned,
    close: async () => {},
    ...overrides
  }
  const api = Object.fromEntries(Object.entries(methods).map(([op, method]) => [op, (...args) => {
    calls.push([op, ...args]); return method(...args)
  }]))
  const controller = createManualBrowserPanel(api, sid, () => { expired++ }, {
    nonce: () => rand(++generation), now: () => now,
    objectUrl: () => { const url = `blob:private-frame-${urls.length}`; urls.push(url); return url },
    revokeUrl: (url) => { revoked.push(url) },
    delay: (run, ms) => { timers.set(++id, { run, ms }); return id },
    cancel: (timer) => timers.delete(timer)
  })
  return { controller, calls, urls, revoked, timers, expired: () => expired, setTime: (ms) => { now = ms },
    fire: (ms) => { for (const [key, timer] of timers) if (timer.ms === ms) { timers.delete(key); timer.run(); return } } }
}

async function claim(controller) {
  await controller.load()
  await controller.open(site.id)
  await controller.claim()
  await tick()
}

test('opening the panel checks readiness lazily; no list, capture, claim or input for disabled workers', async () => {
  for (const status of ['unconfigured', 'egress-unavailable', 'binary-missing', 'sandbox-startup-failure', 'worker-unavailable']) {
    const { controller, calls } = fixture({ status: async () => status })
    assert.deepEqual(calls, [])
    await controller.load()
    await controller.open(site.id)
    await controller.claim()
    await controller.close()
    assert.equal(controller.input(mouse), false)
    assert.equal(controller.snapshot().worker, status)
    assert.equal(controller.snapshot().frame, undefined)
    assert.deepEqual(calls.map(([op]) => op), ['status'])
    controller.dispose()
  }
})

test('explicit claim, finish and claim again target the same tab with new proof and sequence 1', async () => {
  const { controller, calls, revoked } = fixture()
  await controller.load()
  await controller.open(site.id)
  assert.deepEqual(calls.map(([op]) => op), ['status', 'sites', 'tabs', 'open'])
  assert.equal(controller.input(mouse), false)
  await controller.claim()
  assert.equal(controller.snapshot().frame, 'blob:private-frame-0')
  assert.equal(controller.input(mouse), true)
  assert.equal(controller.input(text), true)
  assert.equal(controller.input(key), true)
  await tick()
  controller.finish('done')
  assert.equal(controller.snapshot().frame, undefined)
  assert.deepEqual(revoked, ['blob:private-frame-0'])
  assert.equal(controller.input(scroll), false)
  await tick()
  assert.equal(controller.snapshot().notice, 'done')
  assert.deepEqual(controller.snapshot().tab, returned)
  await controller.claim()
  assert.equal(controller.input(scroll), true)
  await tick()
  const leases = calls.filter(([op]) => op === 'lease')
  assert.deepEqual(leases.map(([, sessionId, id]) => [sessionId, id]), [[sid, tabId], [sid, tabId]])
  assert.notEqual(leases[0][3], leases[1][3])
  assert.deepEqual(calls.filter(([op]) => op === 'input').map(([, , , , seq, action]) => [seq, action]), [[1, mouse], [2, text], [3, key], [1, scroll]])
  assert.equal(calls.filter(([op]) => op === 'open').length, 1)
  assert.equal(calls.find(([op]) => op === 'finish')[4], 'done')
  const snapshot = JSON.stringify(controller.snapshot())
  assert.ok(!snapshot.includes(leases[1][3]) && !snapshot.includes(text.text) && !snapshot.includes('controlId'))
  await controller.close()
  assert.equal(controller.snapshot().tab, undefined)
  assert.equal(controller.snapshot().frame, undefined)
  assert.deepEqual(calls.at(-1).slice(0, 3), ['close', sid, tabId])
  controller.dispose()
})

test('an unconfirmed input acknowledgement erases the queue without retrying the gesture', async () => {
  const pending = deferred()
  const { controller, calls, revoked, timers } = fixture({ input: () => pending.promise })
  await claim(controller)
  assert.equal(controller.input(mouse), true)
  assert.equal(controller.input(text), true)
  assert.equal(controller.input(key), true)
  pending.reject(new Error('ack lost'))
  await tick()
  assert.deepEqual(calls.filter(([op]) => op === 'input').map(([, , , , seq, action]) => [seq, action]), [[1, mouse]])
  assert.equal(calls.filter(([op]) => op === 'finish').length, 1)
  assert.equal(calls.at(-1)[4], 'skip')
  assert.deepEqual(revoked, ['blob:private-frame-0'])
  assert.equal(controller.snapshot().notice, 'input-unconfirmed')
  assert.equal(controller.snapshot().frame, undefined)
  assert.equal(controller.input(key), false)
  assert.equal(timers.size, 0)
  controller.dispose()
})

test('blur immediately clears frames and inputs; late frame and input acknowledgements never touch the next lease', async () => {
  const lateFrame = deferred(), lateInput = deferred()
  let frameCount = 0
  const { controller, calls, urls, revoked, fire } = fixture({
    frame: async () => ++frameCount === 2 ? lateFrame.promise : new Blob(), input: () => lateInput.promise
  })
  await claim(controller)
  fire(500)
  assert.equal(controller.input(mouse), true)
  assert.equal(controller.input(text), true)
  controller.suspend()
  controller.suspend()
  assert.equal(controller.snapshot().frame, undefined)
  assert.deepEqual(revoked, ['blob:private-frame-0'])
  assert.equal(calls.findLast(([op]) => op === 'frame')[4].aborted, true)
  assert.equal(calls.findLast(([op]) => op === 'input')[6].aborted, true)
  assert.equal(calls.filter(([op]) => op === 'finish').length, 1)
  await tick()
  assert.equal(controller.snapshot().notice, 'paused')
  await controller.claim()
  assert.equal(controller.snapshot().frame, 'blob:private-frame-1')
  lateFrame.resolve(new Blob())
  lateInput.resolve()
  await tick()
  assert.equal(calls.filter(([op]) => op === 'input').length, 1)
  assert.deepEqual(urls, ['blob:private-frame-0', 'blob:private-frame-1'])
  assert.equal(controller.snapshot().frame, 'blob:private-frame-1')
  controller.dispose()
  assert.deepEqual(revoked, urls)
})

test('panel departure discards stale reads and a late claim is released without ever rendering a frame', async () => {
  const pending = deferred()
  const f = fixture({ lease: () => pending.promise })
  await f.controller.load()
  await f.controller.open(site.id)
  const claiming = f.controller.claim()
  f.controller.dispose()
  await f.controller.load()
  pending.resolve({ token: rand(18), ttlMs: 60000 })
  await claiming
  assert.equal(f.controller.snapshot().phase, 'idle')
  assert.equal(f.controller.snapshot().tab, undefined)
  assert.equal(f.calls.some(([op]) => op === 'frame'), false)
  assert.equal(f.calls.find(([op]) => op === 'finish')[4], 'skip')
  f.controller.dispose()

  const read = deferred()
  let statusCount = 0
  const g = fixture({ status: async () => ++statusCount === 1 ? read.promise : 'sandbox-startup-failure' })
  const loading = g.controller.load()
  g.controller.dispose()
  assert.equal(g.calls[0][1].aborted, true)
  await g.controller.load()
  read.resolve('ready')
  await loading
  assert.equal(g.controller.snapshot().worker, 'sandbox-startup-failure')
  assert.deepEqual(g.calls.map(([op]) => op), ['status', 'status'])
  g.controller.dispose()
})

test('expired leases and logged-out sessions clear the frame and stop input immediately', async () => {
  const f = fixture()
  await claim(f.controller)
  f.setTime(60_021)
  assert.equal(f.controller.input(mouse), false)
  await tick()
  assert.equal(f.controller.snapshot().notice, 'expired')
  assert.equal(f.controller.snapshot().frame, undefined)
  assert.equal(f.calls.some(([op]) => op === 'input'), false)
  f.controller.dispose()

  const g = fixture({ input: async () => { throw new HttpFailure(401) } })
  await claim(g.controller)
  assert.equal(g.controller.input(mouse), true)
  await tick()
  assert.equal(g.expired(), 1)
  assert.equal(g.controller.snapshot().frame, undefined)
  assert.deepEqual(g.revoked, ['blob:private-frame-0'])
  assert.equal(g.controller.input(mouse), false)
  assert.equal(g.calls.some(([op]) => op === 'finish'), false)
})

test('the native workbench mounts the manual dialog and exposes stable form E2E selectors', async () => {
  const [entry, panel] = await Promise.all(['text-workbench.tsx', 'browser-panel.tsx'].map((name) => readFile(new URL(name, src), 'utf8')))
  assert.match(entry, /bootstrap\.capabilities\?\.browserPanel === true/)
  assert.match(entry, /browserOpen\.sid === sid && browserOpen\.transport === browser && !locked/)
  assert.match(entry, /data-testid="workbench-browser-open"/)
  for (const selector of ['dialog', 'site', 'open-site', 'claim', 'frame', 'text', 'send-text', 'complete', 'skip', 'close', 'dismiss', 'status']) {
    assert.ok(panel.includes(`data-testid="workbench-browser-${selector}"`), selector)
  }
  assert.match(panel, /<img ref=\{image\} src=\{frame\}/)
  assert.doesNotMatch(panel, /<iframe|dangerouslySetInnerHTML|localStorage|sessionStorage/)
  assert.match(panel, /event\.nativeEvent\.isTrusted/)
  assert.match(panel, /window\.addEventListener\('blur', api\.suspend\)/)
})
