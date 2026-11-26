import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { startWorker } from '../../browser-worker/src/worker.mjs'
import { openWorkerClient } from '../../browser-worker/src/client.mjs'
import { createAuthService } from '../src/auth/index.mjs'
import { BrowserHandoffError, createManualBrowser } from '../src/browser/manual-browser.mjs'

const sid = 'sess_controller'
const sites = [{ id: 'portal', label: 'Approved Portal', url: 'https://portal.example.test/private-site-path' }]
const nonce = (byte) => Buffer.alloc(32, byte).toString('base64url')
const click = { type: 'click', x: 20, y: 30 }
const image = Buffer.from('89504e470d0a1a0a0000000d4948445200000400000003000806000000000000000000000049454e44ae426082', 'hex')
const denied = isError('HANDOFF_DENIED')
const unavailable = isError('HANDOFF_UNAVAILABLE')

function isError(code) {
  return (error) => error instanceof BrowserHandoffError && error.code === code && error.message === code && error.cause === undefined
}
function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
function pause() {
  const entered = deferred(), resume = deferred()
  return { entered: entered.promise, resume: resume.resolve, wait() { entered.resolve(); return resume.promise } }
}

async function fixture(t) {
  const temporary = await realpath(tmpdir())
  const root = await mkdtemp(join(temporary, 'deva-controller-'))
  assert.equal(dirname(root), temporary)
  const runDir = join(root, 'run'), egressDir = join(root, 'egress')
  const egressSocket = join(egressDir, 'egress.sock')
  await mkdir(egressDir, { mode: 0o700 })
  const egress = createServer((socket) => socket.destroy())
  egress.listen(egressSocket)
  await once(egress, 'listening')
  await chmod(egressSocket, 0o600)
  const engines = [], calls = [], activeSids = new Set([sid, 'sess_other'])
  let controller, worker, tick = 100, onEngineOpen
  t.after(async () => {
    await controller?.close().catch(() => {})
    await worker?.close().catch(() => {})
    await new Promise((resolve) => egress.close(resolve))
    await rm(root, { recursive: true, force: true })
  })
  worker = await startWorker({
    runDir, egressSocket, sites, executablePath: '/fixture/chromium', egressProbe: () => true,
    proxyFactory: () => ({ url: 'http://127.0.0.1:23456', close() {} }), engineProbe: () => ({ available: true }),
    engineFactory: async ({ startUrl }) => {
      await onEngineOpen?.()
      const state = { privacy: [], inputs: [], frameCalls: 0, active: false, closed: 0 }
      engines.push(state)
      return {
        async close() { state.closed++; await state.onClose?.() },
        getPageInfo() { return { origin: new URL(startUrl).origin, title: 'private-browser-page-title',
          url: `${startUrl}?private=site-query-value` } },
        async setInputPrivacy(active) { state.privacy.push(active); await state.onPrivacy?.(active); state.active = active },
        async dispatchInput(action) { assert.equal(state.active, true); await state.onInput?.(); state.inputs.push(action) },
        async captureFrame(options) {
          assert.deepEqual(options, { privateView: true }); assert.equal(state.active, true)
          state.frameCalls++; await state.onFrame?.()
          return { mimeType: 'image/png', width: 1024, height: 768, bytes: image }
        },
      }
    },
  })
  const originalScrypt = crypto.scrypt
  t.mock.method(crypto, 'scrypt', (password, salt, length, options, callback) =>
    originalScrypt(password, salt, length, { ...options, N: 1024 }, callback))
  const auth = await createAuthService({ dataDir: root })
  const claim = await auth.issueClaim()
  const password = 'controller-fixture-password-29'
  const first = await auth.claim(claim.credential, password)
  const second = await auth.login(password)
  const actor = auth.identify(first.session, first.csrf), other = auth.identify(second.session, second.csrf)
  const remote = openWorkerClient({ runDir })
  const client = Object.fromEntries(Object.entries(remote).map(([op, fn]) => [op, async (args) => {
    calls.push({ op, sid: args?.sid, tabId: args?.tabId, controlId: args?.controlId })
    return await fn(args)
  }]))
  controller = createManualBrowser({ client, auth, sessionExists: (candidate) => activeSids.has(candidate), now: () => tick })
  return { controller, worker, remote, auth, first, actor, other, calls, engines, activeSids,
    advance(ms) { tick += ms }, setOpenHook(fn) { onEngineOpen = fn } }
}

async function open(f, args) {
  return f.controller.open({ actor: f.actor, sid, siteId: 'portal', ...args })
}
async function lease(f, tab, viewerNonce = nonce(21)) {
  const { token, ttlMs } = await f.controller.lease({ actor: f.actor, sid, tabId: tab.tabId, viewerNonce, intent: 'control' })
  assert.equal(ttlMs, 60_000)
  assert.match(token, /^[A-Za-z0-9_-]{43}$/u)
  return { actor: f.actor, sid, tabId: tab.tabId, viewerNonce, token }
}

test('real Unix privacy and action acknowledgements protect the same tab through finish, replay and a new lease', async (t) => {
  const f = await fixture(t), service = f.controller
  assert.deepEqual(await service.status(f.actor), { state: 'ready' })
  assert.deepEqual(await service.sites(f.actor), [{ id: 'portal', label: 'Approved Portal', origin: 'https://portal.example.test' }])
  const tab = await open(f)
  assert.deepEqual(tab, { sessionId: sid, tabId: tab.tabId, siteId: 'portal', state: 'open',
    origin: 'https://portal.example.test', label: 'Approved Portal' })
  const [engine] = f.engines
  assert.deepEqual(engine.privacy, [])
  const start = pause()
  engine.onPrivacy = (active) => active ? start.wait() : undefined
  let signed = false
  const first = lease(f, tab).then((value) => { signed = true; return value })
  await start.entered
  assert.equal(signed, false)
  await assert.rejects(lease(f, tab, nonce(22)), denied)
  start.resume()
  const proof = await first
  const { controlId } = f.calls.find(({ op }) => op === 'startPrivacy') ?? {}
  assert.equal(controlId, undefined, 'startPrivacy has no browser-supplied control ID')
  assert.equal(engine.active, true)
  const action = { type: 'text', text: 'private input at the worker' }
  await assert.rejects(service.input({ ...proof, action, seq: 2 }), denied)
  const input = pause()
  engine.onInput = input.wait
  let accepted = false
  const ordered = service.input({ ...proof, action, seq: 1 }).then((value) => { accepted = true; return value })
  await input.entered
  assert.equal(accepted, false)
  await assert.rejects(service.input({ ...proof, action, seq: 1 }), denied)
  assert.deepEqual(engine.inputs, [])
  input.resume()
  assert.deepEqual(await ordered, { accepted: true, seq: 1 })
  engine.onInput = undefined
  assert.deepEqual(engine.inputs, [action])
  // Each request is transport-local; there is no connection to reopen or second lease to issue.
  const firstFrame = await service.frame(proof), secondFrame = await service.frame(proof)
  assert.deepEqual(firstFrame, { mimeType: 'image/png', width: 1024, height: 768, bytes: image })
  assert.deepEqual(secondFrame, firstFrame)
  assert.notEqual(secondFrame.bytes, firstFrame.bytes)
  assert.throws(() => service.assertFrameCurrent({ ...firstFrame }), denied)
  assert.equal(service.assertFrameCurrent(firstFrame), undefined)
  assert.throws(() => service.assertFrameCurrent(firstFrame), denied)
  assert.deepEqual(firstFrame.bytes, image)
  assert.equal(engine.frameCalls, 2)
  assert.equal(f.calls.filter(({ op }) => op === 'frame').length, 2)
  const stop = pause()
  engine.onPrivacy = (active) => active ? undefined : stop.wait()
  let returned = false
  const finish = service.finish({ ...proof, intent: 'done' }).then((value) => { returned = true; return value })
  await stop.entered
  assert.throws(() => service.assertFrameCurrent(secondFrame), denied)
  assert.deepEqual(secondFrame.bytes, Buffer.alloc(image.length))
  await assert.rejects(service.frame(proof), denied)
  assert.equal(returned, false)
  stop.resume()
  const done = await finish
  assert.deepEqual(done, { ...tab, state: 'returned' })
  assert.deepEqual(await service.finish({ ...proof, intent: 'done' }), done)
  await assert.rejects(service.finish({ ...proof, intent: 'skip' }), denied)
  assert.equal(f.calls.filter(({ op }) => op === 'endPrivacy').length, 1)
  assert.deepEqual(engine.privacy, [true, false])
  assert.equal(engine.closed, 0)
  await assert.rejects(lease(f, tab), denied)
  engine.onPrivacy = undefined
  const next = await lease(f, tab, nonce(22))
  await assert.rejects(service.finish({ ...proof, intent: 'done' }), denied)
  await assert.rejects(service.input({ ...proof, action: click, seq: 1 }), denied)
  assert.notEqual(proof.token, next.token)
  assert.deepEqual(await service.input({ ...next, action: click, seq: 1 }), { accepted: true, seq: 1 })
  const inputs = f.calls.filter(({ op }) => op === 'input')
  assert.notEqual(inputs[0].controlId, inputs[1].controlId)
  assert.equal(inputs[0].tabId, inputs[1].tabId)
  assert.equal(f.engines.length, 1)
  const publicJson = JSON.stringify([tab, done, await service.list({ actor: f.actor, sid }), await service.sites(f.actor)])
  for (const privateValue of ['private input', 'site-query-value', 'private-browser-page-title', proof.token,
    proof.viewerNonce, next.token, inputs[0].controlId, inputs[1].controlId, f.actor.loginSessionId]) {
    assert.equal(publicJson.includes(privateValue), false)
  }
  assert.deepEqual(await service.closeTab({ actor: f.actor, sid, tabId: tab.tabId }), { closed: true })
  assert.equal(engine.closed, 1)
})

test('different owner login cannot borrow or replace a tab; an intentional same-sid open replaces generation', async (t) => {
  const f = await fixture(t), service = f.controller
  const tab = await open(f), proof = await lease(f, tab)
  const other = { ...proof, actor: f.other }
  await assert.rejects(service.frame(other), denied)
  await assert.rejects(service.input({ ...other, action: click, seq: 1 }), denied)
  await assert.rejects(service.finish({ ...other, intent: 'skip' }), denied)
  await assert.rejects(service.lease({ ...other, intent: 'control' }), denied)
  await assert.rejects(service.closeTab(other), denied)
  await assert.rejects(open(f, { actor: f.other }), denied)
  await assert.rejects(open(f, { siteId: 'unknown' }), denied)
  assert.deepEqual(await service.list({ actor: f.other, sid }), [])
  assert.deepEqual(await service.list({ actor: f.actor, sid: 'sess_other' }), [])
  assert.equal(f.engines[0].closed, 0)
  assert.deepEqual(await service.input({ ...proof, action: click, seq: 1 }), { accepted: true, seq: 1 })
  const second = await open(f)
  assert.notEqual(second.tabId, tab.tabId)
  assert.equal(f.engines[0].closed, 1)
  assert.equal(f.engines[1].closed, 0)
  await assert.rejects(service.frame(proof), denied)
  const next = await lease(f, second)
  await assert.rejects(service.frame({ ...next, token: proof.token }), denied)
  assert.deepEqual(await service.input({ ...next, action: click, seq: 1 }), { accepted: true, seq: 1 })
})

test('finish cancels queued I/O synchronously, discards an in-flight frame and waits for real revocation', async (t) => {
  const f = await fixture(t), service = f.controller
  const tab = await open(f), proof = await lease(f, tab)
  const [engine] = f.engines
  const frame = pause(), release = pause()
  engine.onFrame = frame.wait
  engine.onPrivacy = (active) => active ? undefined : release.wait()
  const running = assert.rejects(service.frame(proof), denied)
  await frame.entered
  const neverInput = assert.rejects(service.input({ ...proof, action: click, seq: 1 }), denied)
  const neverFrame = assert.rejects(service.frame(proof), denied)
  const done = service.finish({ ...proof, intent: 'skip' })
  await Promise.all([neverInput, neverFrame])
  assert.deepEqual(engine.inputs, [])
  assert.equal(f.calls.some(({ op }) => op === 'endPrivacy'), false)
  frame.resume()
  await running
  await release.entered
  assert.equal(engine.active, true)
  release.resume()
  assert.deepEqual(await done, { ...tab, state: 'returned' })
  assert.equal(engine.active, false)
  assert.equal(engine.frameCalls, 1)
})

test('logout, session deletion and short lease expiry close old tabs and cancel outstanding work', async (t) => {
  const f = await fixture(t), service = f.controller
  const tab = await open(f), proof = await lease(f, tab)
  const [engine] = f.engines
  const capture = pause(), close = pause()
  engine.onFrame = capture.wait
  engine.onClose = close.wait
  const running = assert.rejects(service.frame(proof), denied)
  await capture.entered
  const queued = assert.rejects(service.input({ ...proof, action: click, seq: 1 }), denied)
  f.auth.logout(f.first.session)
  await queued
  await assert.rejects(service.frame(proof), denied)
  capture.resume()
  await running
  await close.entered
  close.resume()
  await service.closeSession(sid)
  assert.equal(engine.closed, 1)
  const second = await open(f, { actor: f.other })
  const next = await lease({ ...f, actor: f.other }, second)
  f.advance(60_000)
  await assert.rejects(service.frame(next), denied)
  await service.closeSession(sid)
  assert.equal(f.engines[1].closed, 1)
  const third = await open(f, { actor: f.other })
  await lease({ ...f, actor: f.other }, third)
  f.activeSids.delete(sid)
  await service.closeSession(sid)
  assert.equal(f.engines[2].closed, 1)
})

test('controller shutdown waits for a real close, including a target that completes opening after shutdown', async (t) => {
  const f = await fixture(t)
  const engine = pause()
  f.setOpenHook(engine.wait)
  const opening = assert.rejects(open(f), denied)
  await engine.entered
  let closed = false
  const closing = f.controller.close().then(() => { closed = true })
  assert.equal(closed, false)
  engine.resume()
  await opening
  await closing
  assert.equal(f.engines[0].closed, 1)
  await assert.rejects(f.controller.list({ actor: f.actor, sid }), denied)
})

test('worker privacy failure invalidates local control and an unconfirmed close is never reported as successful', async (t) => {
  const f = await fixture(t), service = f.controller
  const tab = await open(f), proof = await lease(f, tab)
  const [engine] = f.engines
  engine.onPrivacy = (active) => { if (!active) throw Error('private text from fake engine') }
  await assert.rejects(service.finish({ ...proof, intent: 'done' }), unavailable)
  await assert.rejects(service.frame(proof), denied)
  assert.deepEqual(await service.list({ actor: f.actor, sid }), [])
  await assert.rejects(service.close(), unavailable)
  assert.equal(engine.closed, 1)
})

test('a returned tab missing in the worker fails on explicit reacquire without opening a substitute', async (t) => {
  const f = await fixture(t), service = f.controller
  const tab = await open(f), proof = await lease(f, tab)
  await service.finish({ ...proof, intent: 'done' })
  await f.remote.closeTab({ sid, tabId: tab.tabId })
  await assert.rejects(lease(f, tab, nonce(22)), unavailable)
  assert.deepEqual(await service.list({ actor: f.actor, sid }), [])
  assert.equal(f.engines.length, 1)
  assert.equal(f.calls.filter(({ op }) => op === 'open').length, 1)
  const explicitlyOpened = await open(f)
  assert.notEqual(explicitlyOpened.tabId, tab.tabId)
  assert.equal(f.engines.length, 2)
  await assert.rejects(service.frame(proof), denied)
  await assert.rejects(service.close(), unavailable)
})

test('replacement of the exact worker target during endPrivacy never returns completion', async (t) => {
  const f = await fixture(t), service = f.controller
  const tab = await open(f), proof = await lease(f, tab)
  const [engine] = f.engines
  const release = pause()
  engine.onPrivacy = (active) => active ? undefined : release.wait()
  const finish = assert.rejects(service.finish({ ...proof, intent: 'done' }), unavailable)
  await release.entered
  const replacement = await f.remote.open({ sid, siteId: 'portal' })
  release.resume()
  await finish
  assert.notEqual(replacement.tabId, tab.tabId)
  assert.deepEqual(await service.list({ actor: f.actor, sid }), [])
  await assert.rejects(service.frame(proof), denied)
  await f.remote.closeTab({ sid, tabId: replacement.tabId })
  await assert.rejects(service.close(), unavailable)
})

test('worker socket shutdown invalidates the private channel and leaves cleanup unconfirmed', async (t) => {
  const f = await fixture(t), service = f.controller
  const tab = await open(f), proof = await lease(f, tab)
  await f.worker.close()
  await assert.rejects(service.frame(proof), unavailable)
  await assert.rejects(service.input({ ...proof, seq: 1, action: click }), denied)
  assert.deepEqual(await service.list({ actor: f.actor, sid }), [])
  await assert.rejects(service.close(), unavailable)
})
