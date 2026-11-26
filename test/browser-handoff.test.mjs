import assert from 'node:assert/strict'
import test from 'node:test'
import { BrowserHandoffError, createBrowserHandoff } from '../apps/headless/src/browser/handoff.mjs'

const actor = Object.freeze({ role: 'owner', ownerId: 'workbench-owner', loginSessionId: 'login-1' })
const sid = 'sess_approved'
const tabId = 'tab-1'
const targetId = 'target-generation-1'
const tab = { actor, sessionId: sid, tabId }
const offer = { ...tab, targetId, origin: 'https://portal.example:8443/' }
const secret = (byte) => Buffer.alloc(32, byte).toString('base64url')
const viewerNonce = secret(21)
const control = { ...tab, viewerNonce, intent: 'control' }
const DENIED = { name: 'BrowserHandoffError', code: 'HANDOFF_DENIED', message: 'HANDOFF_DENIED' }
const UNAVAILABLE = { name: 'BrowserHandoffError', code: 'HANDOFF_UNAVAILABLE', message: 'HANDOFF_UNAVAILABLE' }

function fixture({ seed = 0, workerOverrides, authorizeOverride } = {}) {
  let tick = 100
  let sequence = seed
  const live = new Map([[`${sid}/${tabId}`, targetId]])
  const validLogins = new Set([actor.loginSessionId])
  const approved = new Set([`${sid}/${tabId}/${targetId}`])
  const events = []
  const log = (name, binding, intent) => events.push({ name, binding, intent })
  const worker = {
    isLive: ({ sessionId, tabId, targetId }) => live.get(`${sessionId}/${tabId}`) === targetId,
    pause(binding) { log('pause', binding); return true },
    attach(binding, access) {
      assert.equal(access.allowsInput(), false, 'access is idle until worker confirmation')
      log('attach', binding)
      return true
    },
    release(binding, intent) { log('release', binding, intent); return true },
    close(binding) { log('close', binding); return true },
    ...workerOverrides,
  }
  const authorize = authorizeOverride ?? (({ ownerId, loginSessionId, sessionId, tabId, targetId }) =>
    ownerId === actor.ownerId && validLogins.has(loginSessionId) && approved.has(`${sessionId}/${tabId}/${targetId}`))
  const handoff = createBrowserHandoff({ worker, authorize, now: () => tick,
    randomBytes: (size) => Buffer.alloc(size, ++sequence) })
  return { handoff, worker, authorize, live, validLogins, approved, events, advance: (ms) => { tick += ms } }
}

function start(handoff) {
  assert.equal(handoff.offer(offer).state, 'paused')
  const { token, ttlMs } = handoff.lease(control)
  return { credentials: { ...tab, viewerNonce, token }, ttlMs }
}

test('manual lease controls exactly the reserved Target and returns it to ordinary viewing', () => {
  const { handoff, events } = fixture()
  assert.equal(handoff.available, true)
  const { credentials, ttlMs } = start(handoff)
  assert.equal(Buffer.from(credentials.token, 'base64url').length, 32)
  assert.equal(ttlMs, 60_000)
  const channel = handoff.attach(credentials)
  assert.equal(channel.signal.aborted, false)
  assert.equal(channel.allowsFrame(), true)
  assert.equal(channel.allowsInput(), true)
  assert.equal(handoff.list(tab)[0].state, 'leased')
  const done = { ...credentials, intent: 'done' }
  const result = handoff.finish(done)
  assert.deepEqual(result, { sessionId: sid, tabId, state: 'returned', origin: 'https://portal.example:8443' })
  assert.equal(channel.signal.aborted, true)
  assert.equal(channel.allowsInput(), false)
  assert.equal(channel.allowsFrame(), false)
  assert.deepEqual(handoff.finish(done), result)
  assert.deepEqual(handoff.offer(offer), result)
  assert.throws(() => handoff.finish({ ...done, intent: 'skip' }), DENIED)
  assert.throws(() => handoff.attach(credentials), DENIED)
  assert.throws(() => handoff.lease(control), DENIED)
  assert.deepEqual(events.map(({ name, binding }) => [name, binding.targetId]), [
    ['pause', targetId], ['attach', targetId], ['release', targetId],
  ])
  assert.equal(events[0].binding, events[2].binding)
  assert.equal(Object.isFrozen(events[0].binding), true)
  assert.equal(events[2].intent, 'done')
})

test('skip and retry acknowledge one release, without reopening the lease', () => {
  const { handoff, events, advance } = fixture()
  const { credentials } = start(handoff)
  const skip = { ...credentials, intent: 'skip' }
  assert.throws(() => handoff.finish({ ...skip, intent: 'navigate' }), DENIED)
  assert.deepEqual(handoff.finish(skip), handoff.finish(skip))
  assert.equal(events.filter(({ name }) => name === 'release').length, 1)
  assert.equal(events.at(-1).intent, 'skip')
  advance(60_000)
  handoff.sweep()
  assert.throws(() => handoff.finish(skip), DENIED)
  assert.equal(handoff.list(tab)[0].state, 'returned')
})

test('concurrent claim and attach never disclose a second credential or steal a channel', async () => {
  const { handoff, events } = fixture()
  handoff.offer(offer)
  assert.throws(() => handoff.lease({ ...control, intent: 'navigate' }), DENIED)
  assert.throws(() => handoff.lease({ ...control, viewerNonce: 'short' }), DENIED)
  const claims = await Promise.allSettled([viewerNonce, secret(22)].map((nonce) =>
    Promise.resolve().then(() => handoff.lease({ ...control, viewerNonce: nonce }))))
  assert.deepEqual(claims.map(({ status }) => status), ['fulfilled', 'rejected'])
  assert.equal(claims[1].reason.code, DENIED.code)
  const credentials = { ...tab, viewerNonce, token: claims[0].value.token }
  const attempts = await Promise.allSettled([credentials, credentials].map((request) =>
    Promise.resolve().then(() => handoff.attach(request))))
  assert.deepEqual(attempts.map(({ status }) => status), ['fulfilled', 'rejected'])
  assert.equal(attempts[1].reason.code, DENIED.code)
  assert.equal(attempts[0].value.allowsInput(), true)
  assert.deepEqual(events.map(({ name }) => name), ['pause', 'attach'])
})

test('a disconnected viewer can reconnect only with the same nonce, token, login and Target', () => {
  const { handoff, events, advance } = fixture()
  const { credentials, ttlMs } = start(handoff)
  const first = handoff.attach(credentials)
  assert.equal(first.disconnect(), true)
  assert.equal(first.disconnect(), false)
  assert.equal(first.signal.aborted, true)
  assert.equal(first.allowsFrame(), false)
  assert.throws(() => handoff.attach({ ...credentials, viewerNonce: secret(22) }), DENIED)
  assert.throws(() => handoff.attach({ ...credentials, token: secret(22) }), DENIED)
  // Substitute an alternate Base64URL spelling of the token's final byte.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const alias = credentials.token.slice(0, -1) + alphabet[alphabet.indexOf(credentials.token.at(-1)) + 1]
  assert.deepEqual(Buffer.from(alias, 'base64url'), Buffer.from(credentials.token, 'base64url'))
  assert.throws(() => handoff.attach({ ...credentials, token: alias }), DENIED)
  advance(ttlMs - 1)
  const second = handoff.attach(credentials)
  assert.equal(second.allowsInput(), true)
  assert.equal(second.allowsFrame(), true)
  assert.equal(first.disconnect(), false)
  assert.equal(first.allowsInput(), false)
  assert.deepEqual(events.filter(({ name }) => name === 'attach').map(({ binding }) => binding.targetId), [
    targetId, targetId,
  ])
  advance(1)
  assert.equal(second.allowsInput(), false)
  assert.equal(second.signal.aborted, true)
  assert.throws(() => handoff.attach(credentials), DENIED)
  assert.equal(events.at(-1).name, 'close')
})

test('idle or unattached reservations expire, including at the exact boundary', () => {
  const idle = fixture()
  idle.handoff.offer(offer)
  idle.advance(60_000)
  idle.handoff.sweep()
  assert.deepEqual(idle.handoff.list(tab), [])
  assert.throws(() => idle.handoff.lease(control), DENIED)
  assert.deepEqual(idle.events.map(({ name }) => name), ['pause', 'close'])

  const unattached = fixture()
  const { credentials, ttlMs } = start(unattached.handoff)
  unattached.advance(ttlMs)
  assert.throws(() => unattached.handoff.finish({ ...credentials, intent: 'done' }), DENIED)
  assert.deepEqual(unattached.events.map(({ name }) => name), ['pause', 'close'])
})

test('logout, deletion and stale Target notifications invalidate only their exact reservations', () => {
  for (const reason of ['logout', 'delete', 'close']) {
    const { handoff, validLogins, approved, live, events } = fixture()
    const { credentials } = start(handoff)
    const active = handoff.attach(credentials)
    assert.equal(handoff.closeTab(sid, tabId, 'target-unrelated'), 0)
    assert.equal(active.allowsInput(), true)
    assert.equal(handoff.revokeLogin('unrelated-login'), 0)
    assert.equal(handoff.closeSession('sess_unrelated'), 0)
    if (reason === 'logout') {
      validLogins.delete(actor.loginSessionId)
      assert.equal(handoff.revokeLogin(actor.loginSessionId), 1)
      assert.equal(handoff.revokeLogin(actor.loginSessionId), 0)
    } else if (reason === 'delete') {
      approved.clear()
      assert.equal(handoff.closeSession(sid), 1)
      assert.equal(handoff.closeSession(sid), 0)
    } else {
      live.clear()
      assert.equal(handoff.closeTab(sid, tabId, targetId), 1)
      assert.equal(handoff.closeTab(sid, tabId, targetId), 0)
    }
    assert.equal(active.signal.aborted, true)
    assert.equal(active.allowsInput(), false)
    assert.equal(active.allowsFrame(), false)
    assert.throws(() => handoff.attach(credentials), DENIED)
    assert.throws(() => handoff.offer(offer), DENIED)
    assert.deepEqual(events.map(({ name }) => name), ['pause', 'attach', 'close'])
  }
})

test('each frame and input revalidates login, scope and Target without needing lifecycle notification', () => {
  for (const invalidate of [
    ({ validLogins }) => validLogins.clear(),
    ({ approved }) => approved.clear(),
    ({ live }) => live.set(`${sid}/${tabId}`, 'target-replacement'),
  ]) {
    const setup = fixture()
    const { handoff, events } = setup
    const { credentials } = start(handoff)
    const channel = handoff.attach(credentials)
    invalidate(setup)
    assert.equal(channel.allowsFrame(), false)
    assert.equal(channel.allowsInput(), false)
    assert.equal(channel.signal.aborted, true)
    assert.throws(() => handoff.finish({ ...credentials, intent: 'done' }), DENIED)
    assert.deepEqual(events.map(({ name, binding }) => [name, binding.targetId]), [
      ['pause', targetId], ['attach', targetId], ['close', targetId],
    ])
  }
})

test('release checks the pinned Target even if a disconnect listener invalidates it', () => {
  const { handoff, live, events } = fixture()
  const { credentials } = start(handoff)
  const channel = handoff.attach(credentials)
  channel.signal.addEventListener('abort', () => live.set(`${sid}/${tabId}`, 'replacement-while-finishing'))
  assert.throws(() => handoff.finish({ ...credentials, intent: 'done' }), UNAVAILABLE)
  assert.deepEqual(events.map(({ name, binding }) => [name, binding.targetId]), [
    ['pause', targetId], ['attach', targetId], ['close', targetId],
  ])
})

test('wrong role, second owner login, session or tab cannot inspect or control a lease', () => {
  const { handoff, approved, live, validLogins } = fixture()
  const otherSid = 'sess_other'
  const otherTab = 'tab-2'
  const otherTarget = 'target-other'
  const otherLogin = { ...actor, loginSessionId: 'login-2' }
  live.set(`${otherSid}/${otherTab}`, otherTarget)
  approved.add(`${otherSid}/${otherTab}/${otherTarget}`)
  validLogins.add(otherLogin.loginSessionId)
  const { credentials } = start(handoff)
  const channel = handoff.attach(credentials)
  assert.throws(() => handoff.offer({ ...offer, actor: otherLogin }), DENIED)
  assert.deepEqual(handoff.list({ ...tab, actor: otherLogin }), [])
  assert.throws(() => handoff.list({ ...tab, actor: { ...actor, role: 'agent' } }), DENIED)
  for (const wrong of [
    { actor: otherLogin },
    { actor: { ...actor, ownerId: 'different-owner' } },
    { actor: { ...actor, role: 'agent' } },
    { sessionId: otherSid },
    { tabId: otherTab },
  ]) {
    assert.throws(() => handoff.attach({ ...credentials, ...wrong }), DENIED)
    assert.throws(() => handoff.finish({ ...credentials, ...wrong, intent: 'done' }), DENIED)
    assert.throws(() => handoff.lease({ ...control, ...wrong }), DENIED)
    assert.equal(channel.allowsFrame(), true)
  }
})

test('a valid nonce and token do not cross into a second active tab or session', () => {
  const { handoff, live, approved } = fixture()
  const { credentials } = start(handoff)
  const channel = handoff.attach(credentials)
  const alternateScopes = [{ sessionId: sid, tabId: 'tab-2' }, { sessionId: 'sess_other', tabId }]
  for (const [index, scope] of alternateScopes.entries()) {
    const target = `alternate-generation-${index}`
    live.set(`${scope.sessionId}/${scope.tabId}`, target)
    approved.add(`${scope.sessionId}/${scope.tabId}/${target}`)
    handoff.offer({ ...scope, actor, targetId: target })
    const { token } = handoff.lease({ ...control, ...scope })
    assert.throws(() => handoff.attach({ ...credentials, ...scope }), DENIED)
    assert.throws(() => handoff.finish({ ...credentials, ...scope, intent: 'done' }), DENIED)
    const alternate = handoff.attach({ ...credentials, ...scope, token })
    assert.equal(alternate.allowsInput(), true)
    assert.equal(channel.allowsFrame(), true)
  }
})

test('a Target or tab cannot be registered twice under a different alias or generation', () => {
  const { handoff, live, approved, events } = fixture()
  handoff.offer(offer)
  const alias = 'tab-alias'
  const replacement = 'target-replacement'
  live.set(`${sid}/${alias}`, targetId)
  approved.add(`${sid}/${alias}/${targetId}`)
  assert.throws(() => handoff.offer({ ...offer, tabId: alias }), DENIED)
  live.set(`${sid}/${tabId}`, replacement)
  approved.add(`${sid}/${tabId}/${replacement}`)
  assert.throws(() => handoff.offer({ ...offer, targetId: replacement }), DENIED)
  assert.deepEqual(handoff.list(tab), [])
  assert.deepEqual(events.map(({ name, binding }) => [name, binding.targetId]), [['pause', targetId], ['close', targetId]])
  assert.equal(handoff.offer({ ...offer, targetId: replacement }).state, 'paused')
  assert.equal(handoff.closeTab(sid, tabId, targetId), 0)
  assert.equal(handoff.list(tab)[0].state, 'paused')
})

test('factory instances are isolated and missing or failing workers close access', () => {
  const first = fixture({ seed: 0 })
  const second = fixture({ seed: 80 })
  const { credentials } = start(first.handoff)
  assert.deepEqual(second.handoff.list(tab), [])
  assert.throws(() => second.handoff.attach(credentials), DENIED)
  start(second.handoff)
  assert.throws(() => second.handoff.attach(credentials), DENIED)
  assert.equal(first.handoff.attach(credentials).allowsInput(), true)
  for (const service of [createBrowserHandoff(), createBrowserHandoff({ worker: first.worker }),
    createBrowserHandoff({ worker: { isLive: () => true }, authorize: first.authorize })]) {
    assert.equal(service.available, false)
    assert.deepEqual(service.list(tab), [])
    assert.throws(() => service.offer(offer), UNAVAILABLE)
    assert.throws(() => service.lease(control), UNAVAILABLE)
    assert.throws(() => service.attach(credentials), UNAVAILABLE)
  }
  for (const workerOverrides of [{ pause() {} }, { pause: async () => true }, { pause: () => 1 }]) {
    const unavailable = fixture({ workerOverrides })
    assert.throws(() => unavailable.handoff.offer(offer), UNAVAILABLE)
    assert.deepEqual(unavailable.handoff.list(tab), [])
    assert.equal(unavailable.events.at(-1).name, 'close')
  }
})

test('worker attach/release failure disables control and redacts worker errors', () => {
  for (const action of ['attach', 'release']) {
    const privateError = 'private screenshot bytes and secret form contents'
    const fail = { [action]: () => { throw new Error(privateError) } }
    const { handoff, events } = fixture({ workerOverrides: fail })
    const { credentials } = start(handoff)
    const channel = action === 'release' ? handoff.attach(credentials) : null
    const trigger = action === 'release' ? () => handoff.finish({ ...credentials, intent: 'done' }) :
      () => handoff.attach(credentials)
    assert.throws(trigger, (error) => {
      assert.equal(error instanceof BrowserHandoffError, true)
      assert.equal(error.message, UNAVAILABLE.message)
      assert.equal(error.cause, undefined)
      assert.equal(error.stack.includes(privateError), false)
      return true
    })
    if (channel) assert.equal(channel.signal.aborted, true)
    assert.deepEqual(handoff.list(tab), [])
    assert.equal(events.at(-1).name, 'close')
  }
})

test('approval, public projections, worker metadata and guard results exclude sensitive data', (t) => {
  const logging = ['debug', 'info', 'log', 'warn', 'error'].map((name) => t.mock.method(console, name, () => {}))
  const sensitive = 'sensitive-form-password'
  const { handoff, events } = fixture()
  const injected = { title: sensitive, password: sensitive, input: sensitive, frame: sensitive,
    payload: sensitive, url: sensitive, account: sensitive, screenshot: sensitive }
  const projection = handoff.offer({ ...offer, ...injected,
    origin: `https://${sensitive}:${sensitive}@portal.example:8443/private/${sensitive}?credential=${sensitive}#${sensitive}`,
    label: '批准的站点' })
  assert.deepEqual(projection, { sessionId: sid, tabId, state: 'paused', origin: 'https://portal.example:8443', label: '批准的站点' })
  const lease = handoff.lease({ ...control, ...injected })
  assert.deepEqual(Object.keys(lease), ['token', 'ttlMs'])
  const credentials = { ...tab, viewerNonce, token: lease.token, ...injected }
  const channel = handoff.attach(credentials)
  assert.equal(channel.allowsInput({ payload: sensitive }), true)
  assert.equal(channel.allowsFrame({ frame: sensitive }), true)
  const json = JSON.stringify([projection, handoff.list(tab), channel, handoff, handoff.finish({ ...credentials, intent: 'done' })])
  for (const nonpublic of [sensitive, lease.token, viewerNonce, targetId, actor.ownerId, actor.loginSessionId]) {
    assert.equal(json.includes(nonpublic), false)
  }
  for (const { binding } of events) {
    assert.deepEqual(Object.keys(binding), ['ownerId', 'loginSessionId', 'sessionId', 'tabId', 'targetId'])
    assert.equal(JSON.stringify(binding).includes(sensitive), false)
  }
  assert.equal(logging.every((log) => log.mock.callCount() === 0), true)
})

test('a failed close quarantines the Target and a regressed monotonic clock ends a lease', () => {
  const { handoff, advance } = fixture({ workerOverrides: { close: () => false } })
  const { credentials } = start(handoff)
  const channel = handoff.attach(credentials)
  advance(-1)
  assert.equal(channel.allowsFrame(), false)
  assert.equal(channel.signal.aborted, true)
  advance(1)
  assert.throws(() => handoff.offer(offer), DENIED)
})
