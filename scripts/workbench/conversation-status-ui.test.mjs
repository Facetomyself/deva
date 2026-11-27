import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))
const ts = require('typescript')
const react = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const src = new URL('../../apps/desktop/src/', import.meta.url)
async function load(name, deps = {}, globals = {}) {
  const code = ts.transpileModule(await readFile(new URL(name, src), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }
  }).outputText
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', ...Object.keys(globals), code)(
    key => Object.hasOwn(deps, key) ? deps[key] : require(key), mod, mod.exports, ...Object.values(globals))
  return mod.exports
}
const transport = await load('workbench/transport.ts')
const status = await load('workbench/conversation-status-transport.ts')
const reads = await load('workbench/conversation-status-reads.ts')
const chat = await load('workbench/chat-transport.ts')
const { applyChatFrame } = await load('workbench/chat-stream.ts', { './chat-transport': chat })
const readUI = await load('workbench/conversation-status-ui.tsx', {
  './conversation-status-reads': reads, './conversation-status.css': {}
})
const i18n = { useI18n: () => ({ locale: 'en', t: (key) => ({ 'chat.panel.context': 'Context',
  'chat.panel.usage': '{used}/{window} ({pct})', 'chat.panel.approx': 'About {n}' })[key] ?? key }) }
const contextHelpers = await load('renderer/src/redesign/context-usage.ts')
const format = await load('shared/context.ts')
const ring = await load('renderer/src/redesign/ContextRing.tsx', {
  '../../../shared/context': format, '../i18n/i18n': i18n, './context-usage': contextHelpers, react: { ...react, useLayoutEffect: react.useEffect }
})
const meterDeps = { '../renderer/src/redesign/ContextRing': ring, '../renderer/src/i18n/i18n': i18n, './conversation-status-transport': status }

const sid = 'ordinary-chat'
const peer = 'another-chat'
const model = 'model-provider:qwen3:8b'
const changedModel = 'other-provider:qwen3:8b'
const boot = { protocol: 1, version: '1', platform: 'linux', config: {}, expiresAt: 20, csrf: 'csrf-ui-test' }
const enabled = { ...boot, capabilities: { conversationStatus: true } }
const info = (id = sid, updatedAt = 12) => ({ id, updatedAt, compatibility: 'text', writable: true, title: 'Chat', model: null })
const readMark = (id = sid, updatedAt = 12, unread = true) => ({ id, updatedAt, readAt: unread ? null : updatedAt, unread })
const wireReport = (source, ref = model) => ({ modelRef: ref, usage: source === 'unavailable' ? null : {
  used: source === 'none' ? null : 25_000, window: 100_000, estimated: source === 'estimate', trigger: null
}, source, compaction: 'inactive' })
const map = (...entries) => new Map(entries.map(entry => [entry.id, entry]))
const cursor = (id = sid, seq = 8) => ({ scope: `chat:${id}`, seq,
  epoch: '00000000-0000-4000-8000-000000000001', generation: '00000000-0000-4000-a000-000000000002' })
const observation = (updatedAt = 12, id = sid) => ({ id, updatedAt, cursor: cursor(id) })
const projection = (updatedAt = 12, patch = {}) => ({ status: 'ready', snapshot: { cursor: cursor(), state: {
  ...info(sid, updatedAt), active: null, lastTurn: null, messages: [{ role: 'assistant', content: 'durable' }], ...patch
} } })
const json = (value, code = 200) => new Response(JSON.stringify(value), { status: code })
const signal = new AbortController().signal
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function queuedTransport(steps) {
  return transport.createTransport(async (url, init) => {
    assert.ok(steps.length, `Unexpected request: ${url}`)
    const [method, path, body, result, code] = steps.shift()
    assert.equal(url, `/api/v1${path}`)
    assert.equal(init.method, method)
    assert.deepEqual(init.body && JSON.parse(init.body), body)
    assert.equal(init.credentials, 'same-origin')
    assert.equal(init.mode, 'same-origin')
    assert.equal(init.cache, 'no-store')
    assert.equal(init.redirect, 'error')
    assert.equal(init.referrerPolicy, method === 'POST' ? 'same-origin' : 'no-referrer')
    assert.equal(init.headers['x-deva-csrf'], method === 'POST' ? boot.csrf : undefined)
    if (path !== '/bootstrap') assert.equal(init.signal, signal)
    return json(result, code)
  })
}

test('only literal capability opts into owner-scoped no-store requests; exact cursor and full model reference go on the wire', async () => {
  const steps = [
    ['GET', '/bootstrap', undefined, { ...boot, capabilities: { conversationStatus: 'true', textChat: true } }],
    ['GET', '/bootstrap', undefined, enabled],
    ['GET', '/conversation-status/reads', undefined, { entries: [readMark()] }],
    ['POST', `/chats/${sid}/read-state`, { updatedAt: 12, cursor: cursor() }, { ...readMark(sid, 12, false), changed: true }],
    ['POST', `/chats/${sid}/context-usage`, { model: null }, wireReport('none')],
    ['POST', `/chats/${sid}/context-usage`, { model }, wireReport('measured')]
  ]
  const base = queuedTransport(steps)
  const previous = (await base.inspect()).bootstrap
  assert.deepEqual(previous.capabilities, { textChat: true })
  assert.equal(status.createConversationStatusTransport(base, previous), undefined)
  const api = status.createConversationStatusTransport(base, (await base.inspect()).bootstrap)
  assert.deepEqual(await api.reads(signal), map(readMark()))
  await assert.rejects(api.mark({ ...observation(), cursor: cursor(peer) }, signal), /observation/)
  for (const patch of [{ epoch: 'short' }, { generation: '00000000-0000-5000-8000-000000000001' },
    { epoch: '00000000-0000-4000-7000-000000000001' }, { seq: Number.MAX_SAFE_INTEGER + 1 }]) {
    await assert.rejects(api.mark({ ...observation(), cursor: { ...cursor(), ...patch } }, signal), /observation/)
  }
  await assert.rejects(api.mark({ ...observation(), id: '../ordinary-chat' }, signal), /scope/)
  await assert.rejects(api.usage(sid, 'qwen3', signal), /model reference/)
  assert.deepEqual(await api.mark({ ...observation(), cursor: { ...cursor(), messages: ['local extra'] } }, signal), { ...readMark(sid, 12, false), changed: true })
  assert.deepEqual(await api.usage(sid, null, signal), wireReport('none'))
  assert.deepEqual(await api.usage(sid, model, signal), wireReport('measured'))
  assert.deepEqual(steps, [])
})

test('read maps cap rows, enforce native unread comparison, and reject mismatched revision acknowledgements', async () => {
  const failures = [
    { entries: [{ ...readMark(), transcript: [] }] }, { entries: [readMark(), readMark()] },
    { entries: [{ ...readMark(), readAt: 12 }] }, { entries: [{ ...readMark(sid, 12, false), readAt: 11 }] },
    { entries: [{ ...readMark(sid, 12, false), readAt: null }] },
    { entries: Array.from({ length: 8193 }, (_, index) => readMark(`c${index}`)) }
  ]
  const marks = [
    { ...readMark(peer, 12, false), changed: true },
    { ...readMark(sid, 12, false), readAt: 13, changed: true },
    { ...readMark(sid, 12, false), readAt: 11, changed: false },
    { ...readMark(sid, 12, false), readAt: null, changed: true }
  ]
  const newer = { ...readMark(sid, 12, false), readAt: 13 }
  const empty = { ...readMark(sid, 12, false), readAt: null, changed: false }
  const wire = [...failures, { entries: [newer, { ...readMark(peer), readAt: 11 }] }, ...marks, { ...newer, changed: false }, empty]
  const api = status.createConversationStatusTransport(transport.createTransport(async () => json(wire.shift())), enabled)
  for (const _ of failures) await assert.rejects(api.reads(signal), /map|entry/)
  assert.deepEqual(await api.reads(signal), map(newer, { ...readMark(peer), readAt: 11 }))
  for (const _ of marks) await assert.rejects(api.mark(observation(), signal), /acknowledgement/)
  assert.deepEqual(await api.mark(observation(), signal), { ...newer, changed: false })
  assert.deepEqual(await api.mark(observation(), signal), empty)
  assert.equal(wire.length, 0)
})

test('context grammar matches server UTF-8 input and exact unavailable, empty and measured projections', async () => {
  const valid = ['A_v1.Name-1:Model Name : beta', 'P:星😀', `p:${'😀'.repeat(128)}`, `${'p'.repeat(96)}:${'x'.repeat(512)}`]
  const bad = ['qwen3', '..:model', 'p: model', 'p:model ', 'p:', 'p:bad\u0001', 'p:a\u007fb', 'p:\ud800bad', 'p:bad\udc00',
    `p:${'😀'.repeat(129)}`, `${'p'.repeat(97)}:model`, 'constructor:model', 'prototype:model', '__proto__:model']
  for (const model of valid) assert.equal(status.fullModelRef(model), true, model)
  for (const model of bad) assert.equal(status.fullModelRef(model), false, model)
  const usage = (source, patch) => ({ ...wireReport(source), usage: { ...wireReport(source).usage, ...patch } })
  const failures = [wireReport('estimate', changedModel), wireReport('unavailable'),
    { ...wireReport('none'), modelRef: null, usage: null }, { ...wireReport('none'), usage: null }, usage('none', { used: 0 }),
    usage('none', { window: 0 }), usage('none', { window: 20_000_001 }), usage('live', { trigger: 30 }),
    usage('live', { used: 0 }), usage('measured', { used: 0 }), usage('measured', { used: 5.5 }),
    usage('estimate', { used: 5.5 }), usage('estimate', { used: Number.MAX_SAFE_INTEGER + 1 })]
  const maximum = usage('none', { window: 20_000_000 })
  const zeroEstimate = usage('estimate', { used: 0 })
  const wire = [...failures, wireReport('unavailable', null), maximum, zeroEstimate]
  const api = status.createConversationStatusTransport(transport.createTransport(async () => json(wire.shift())), enabled)
  for (const ref of bad) await assert.rejects(api.usage(sid, ref, signal), /model reference/)
  for (const _ of failures) await assert.rejects(api.usage(sid, model, signal), /context report/)
  assert.deepEqual(await api.usage(sid, model, signal), wireReport('unavailable', null))
  assert.deepEqual(await api.usage(sid, model, signal), maximum)
  assert.deepEqual(await api.usage(sid, model, signal), zeroEstimate)
  assert.equal(wire.length, 0)
})

test('only the selected, durable, actually visible, idle ready revision is a read candidate', () => {
  const row = info()
  assert.deepEqual(reads.observeReading(row, projection(), true), observation())
  assert.equal(reads.observeReading(row, projection(), false), undefined)
  assert.equal(reads.observeReading(undefined, projection(), true), undefined)
  const legacy = { compatibility: 'legacy_text', writable: false }
  assert.deepEqual(reads.observeReading({ ...row, ...legacy }, projection(12, legacy), true), observation())
  assert.equal(reads.matchingReadEntry({ entries: map(readMark()) }, { ...row, ...legacy }).unread, true)
  for (const rowPatch of [{ archived: true }, { compatibility: 'unsupported' }, { id: 'task-worker' }]) {
    assert.equal(reads.matchingReadEntry({ entries: map(readMark(rowPatch.id ?? sid)) }, { ...row, ...rowPatch }), undefined)
  }
  const variants = [
    [{ ...row, archived: true }, projection()], [{ ...row, id: 'task-worker' }, projection()],
    [{ ...row, compatibility: 'legacy_text' }, projection()], [{ ...row, compatibility: 'unsupported' }, projection()], [row, projection(11)],
    [row, projection(12, { archived: true })], [row, projection(12, { compatibility: 'unsupported' })],
    [row, { ...projection(), status: 'reconnecting' }], [row, projection(12, { id: peer })],
    [row, projection(12, { active: { turnId: 'running' } })], [row, projection(12, { lastTurn: { status: 'running' } })],
    [row, projection(12, { messages: [{ role: 'assistant', content: ' ' }] })], [row, projection(12, { messages: [] })],
    [row, { status: 'ready', snapshot: { ...projection().snapshot, cursor: cursor(peer) } }]
  ]
  for (const [candidate, view] of variants) assert.equal(reads.observeReading(candidate, view, true), undefined)
  const doc = { visibilityState: 'visible', hasFocus: () => true, fullscreenElement: null, querySelector: () => null }
  const scroll = {
    isConnected: true, scrollHeight: 1400, scrollTop: 1000, clientHeight: 400,
    querySelectorAll: () => [{ getBoundingClientRect: () => ({ bottom: 250, top: 50, width: 200 }) }],
    getBoundingClientRect: () => ({ top: 0, bottom: 400, width: 700 })
  }
  const visible = readUI.readViewInForeground
  assert.equal(visible(doc, scroll), true)
  assert.equal(visible({ ...doc, visibilityState: 'hidden' }, scroll), false)
  assert.equal(visible({ ...doc, hasFocus: () => false }, scroll), false)
  assert.equal(visible({ ...doc, querySelector: () => ({ modal: true }) }, scroll), false)
  assert.equal(visible({ ...doc, fullscreenElement: { contains: () => false } }, scroll), false)
  assert.equal(visible(doc, { ...scroll, scrollTop: 900 }), false)
  assert.equal(visible(doc, { ...scroll, querySelectorAll: () => [] }), false)
  assert.equal(visible(doc, { ...scroll, isConnected: false }), false)
  assert.equal(visible(doc, { ...scroll, getBoundingClientRect: () => ({ top: 500, bottom: 900, width: 200 }) }), false)
})

test('fresh owner list snapshots replicate two-window marks and never write if an unrelated row is visible', async () => {
  const requests = []
  let backing = map(readMark(), readMark(peer))
  const api = {
    reads: async (signal) => { requests.push({ type: 'get', signal }); return new Map(backing) },
    mark: async ({ id, updatedAt }) => {
      requests.push({ type: 'post', id, updatedAt })
      const ack = readMark(id, updatedAt, false)
      backing = new Map(backing).set(id, ack)
      return { ...ack, changed: true }
    }
  }
  const first = reads.createConversationReads(api, assert.fail)
  const second = reads.createConversationReads(api, assert.fail)
  first.scope([], sid)
  second.scope([info(), info(peer)], peer)
  await setImmediate()
  assert.equal(requests.filter(({ type }) => type === 'get').length, 1)
  await second.mark(observation())
  assert.equal(requests.some(({ type }) => type === 'post'), false)
  first.scope([info(), info(peer)], sid)
  await setImmediate()
  await first.mark(observation())
  await first.mark({ ...observation(), cursor: cursor(sid, 9) })
  assert.deepEqual(requests.filter(({ type }) => type === 'post'), [{ type: 'post', id: sid, updatedAt: 12 }])
  assert.equal(second.snapshot().entries.get(sid).unread, true)
  second.scope([info(), info(peer)], peer) // Owner invalidation yields unchanged rows but a fresh session-list snapshot.
  await setImmediate()
  assert.equal(second.snapshot().entries.get(sid).unread, false)
})

test('ambiguous writes reconcile by authenticated GET without replay or consuming later arrivals; explicit Retry can confirm them', async () => {
  for (const error of [new Error('response lost'), { status: 409, code: 'read_view_stale' }]) {
    const attempts = []
    let updatedAt = 12
    let gets = 0
    const ctl = reads.createConversationReads({
      reads: async () => { gets++; return map(readMark(sid, updatedAt)) },
      mark: async (value) => {
        attempts.push(value)
        if (attempts.length === 1) throw error
        return { ...readMark(sid, updatedAt, false), changed: true }
      }
    }, assert.fail)
    ctl.scope([info()], sid)
    await setImmediate()
    await ctl.mark(observation())
    assert.equal(gets, 2)
    assert.equal(ctl.snapshot().review, sid)
    await ctl.mark(observation())
    assert.equal(attempts.length, 1)
    updatedAt = 13
    ctl.scope([info(sid, updatedAt)], sid)
    await setImmediate()
    await ctl.mark(observation(13))
    assert.equal(attempts.length, 1)
    assert.equal(ctl.snapshot().entries.get(sid).unread, true)
    ctl.retry(sid)
    await setImmediate()
    await ctl.mark(observation(13))
    assert.deepEqual(attempts.map(request => request.updatedAt), [12, 13])
    assert.equal(ctl.snapshot().entries.get(sid).unread, false)
  }
})

test('switch and auth cleanup abort stale requests and preserve an honest missing state', async () => {
  const queue = []
  const writes = []
  let expired = 0
  const ctl = reads.createConversationReads({
    reads: (signal) => { const pending = deferred(); queue.push({ signal, ...pending }); return pending.promise },
    mark: (request, signal) => { const pending = deferred(); writes.push({ request, signal, ...pending }); return pending.promise }
  }, () => expired++)
  ctl.scope([info(), info(peer)], sid)
  ctl.scope([info(), info(peer)], peer)
  assert.equal(queue[0].signal.aborted, true)
  queue[0].resolve(map(readMark()))
  await setImmediate()
  assert.equal(ctl.snapshot().phase, 'reading')
  queue[1].resolve(map(readMark(peer)))
  await setImmediate()
  const marking = ctl.mark(observation(12, peer))
  assert.equal(writes.length, 1)
  ctl.scope([info(), info(peer)], sid)
  assert.equal(writes[0].signal.aborted, true)
  writes[0].resolve({ ...readMark(peer, 12, false), changed: true })
  await marking
  queue[2].reject({ status: 404 })
  await setImmediate()
  assert.equal(ctl.snapshot().phase, 'unavailable')
  assert.equal(ctl.snapshot().entries.size, 0)
  assert.equal(expired, 0)
  ctl.retry(sid)
  queue[3].reject({ status: 401 })
  await setImmediate()
  assert.equal(expired, 1)
  ctl.retry(sid)
  ctl.close()
  assert.equal(queue[4].signal.aborted, true)
  assert.equal(ctl.snapshot().phase, 'idle')
})

// Exercise layout-effect network dependencies without an installed browser/DOM test library.
function effectHarness() {
  let offset = 0
  let effects = []
  const slots = []
  const hooks = {
    useEffect: layout,
    useLayoutEffect: layout,
    useId: () => ':test:',
    useRef: (value) => slots[offset++] ??= { current: value },
    useState: (value) => {
      const i = offset++
      const slot = slots[i] ??= { value }
      return [slot.value, next => { slot.value = typeof next === 'function' ? next(slot.value) : next }]
    }
  }
  function layout(callback, deps) {
    const slot = slots[offset++] ??= {}
    if (!deps || !slot.deps || deps.some((dep, index) => !Object.is(dep, slot.deps[index]))) {
      slot.deps = deps
      effects.push(() => { slot.cleanup?.(); slot.cleanup = callback() })
    }
  }
  return { hooks, render(fn, props) {
    offset = 0
    const value = fn(props)
    const pending = effects
    effects = []
    pending.forEach(effect => effect())
    return value
  }, close() { slots.forEach(slot => slot.cleanup?.()) } }
}

test('the mounted read status checks visibility again after paint and never sends a superseded cursor', async () => {
  const hooks = effectHarness()
  const frames = new Map()
  let frameId = 0
  const notify = new Map()
  const addEventListener = (event, callback) => notify.set(event, callback)
  const removeEventListener = (event, callback) => { if (notify.get(event) === callback) notify.delete(event) }
  const win = { addEventListener, removeEventListener,
    requestAnimationFrame: (callback) => { frames.set(++frameId, callback); return frameId },
    cancelAnimationFrame: (id) => frames.delete(id) }
  const doc = { visibilityState: 'visible', hasFocus: () => true, fullscreenElement: null, querySelector: () => null,
    addEventListener, removeEventListener }
  function tick() {
    const queued = [...frames.values()]
    frames.clear()
    queued.forEach(callback => callback())
  }
  const { DisplayedReadStatus } = await load('workbench/conversation-status-ui.tsx', {
    './conversation-status-reads': reads, './conversation-status.css': {}, react: hooks.hooks
  }, { window: win, document: doc })
  let current = projection()
  const marks = []
  const base = { reads: { mark: async request => marks.push(request) }, locale: 'en', blocked: false,
    atBottom: true, hasContent: true, row: info(), projection: projection(), current: () => current,
    refresh: assert.fail, readView: { phase: 'ready', entries: map(readMark()) }, scroller: { current: {
      isConnected: true, scrollHeight: 400, scrollTop: 0, clientHeight: 400,
      querySelectorAll: () => [{ getBoundingClientRect: () => ({ top: 30, bottom: 150, width: 300 }) }],
      getBoundingClientRect: () => ({ top: 10, bottom: 380, width: 500 })
    } } }
  const render = (props = {}) => hooks.render(DisplayedReadStatus, { ...base, ...props })
  render({ blocked: true })
  tick(); tick()
  assert.deepEqual(marks, [])
  render()
  tick()
  doc.visibilityState = 'hidden'
  tick()
  assert.deepEqual(marks, [])
  doc.visibilityState = 'visible'
  notify.get('visibilitychange')()
  tick()
  current = { ...current, snapshot: { ...current.snapshot, cursor: cursor(sid, 9) } }
  tick()
  assert.deepEqual(marks, [])
  assert.equal(render({ projection: current, readView: { phase: 'reading', entries: map(readMark()) } }).props['data-state'], 'loading')
  tick(); tick()
  assert.deepEqual(marks, [])
  render({ projection: current })
  tick(); tick()
  assert.deepEqual(marks, [{ ...observation(), cursor: cursor(sid, 9) }])
  render({ projection: current, readView: { phase: 'ready', entries: map() } })
  tick(); tick()
  assert.equal(marks.length, 1)
  const unavailable = render({ projection: current, readView: { phase: 'ready', entries: map() } })
  assert.equal(unavailable.props['data-testid'], 'workbench-read-status')
  assert.equal(unavailable.props['data-state'], 'unavailable')
  assert.equal(unavailable.props.children[1].props.children, 'Retry')
  hooks.close()
  assert.equal(notify.size, 0)
})

const egress = (type, next, turnId = 'T', sessionId = sid) => chat.parseChatFrame(JSON.stringify({
  t: 'event', type: 'chat', cursor: cursor(sessionId, next), sessionId, turnId, event: { type, text: type === 'text_delta' ? 'x' : 'drop this data', usage: 100_000 }
}), sid)

test('scoped context_changed only bumps a chat-local marker; no usage query per delta or stale model', async () => {
  const harness = effectHarness()
  const ctx = await load('workbench/conversation-status-context.tsx', { ...meterDeps, react: harness.hooks })
  const groups = [{ p: { id: 'model-provider', apiHost: 'private address' }, models: [{ id: 'qwen3:8b', contextWindow: 100_000 }] },
    { p: { id: 'other-provider' }, models: [{ id: 'qwen3:8b', contextWindow: 100_000 }] }]
  assert.equal(ctx.contextTarget('qwen3:8b', groups, null), undefined) // Ollama model nickname alone is not a catalog ref.
  assert.equal(ctx.contextTarget('missing-provider:qwen3:8b', groups, null), undefined)
  const first = ctx.contextTarget(model, groups, null)
  const second = ctx.contextTarget(changedModel, groups, null)
  assert.notEqual(first.signature, second.signature)
  assert.doesNotMatch(first.signature, /private address/)
  const lookups = []
  const props = {
    api: { usage: (sid, model, signal) => { const task = deferred(); lookups.push({ sid, model, signal, ...task }); return task.promise } },
    sid, modelReady: true, target: first, blocked: false, onExpired: assert.fail
  }
  let live = projection(12, { active: { turnId: 'T', text: '' } })
  const render = (extra = {}) => harness.render(ctx.WorkbenchContextMeter, { ...props, projection: live, ...extra })
  assert.equal(render().props['data-source'], 'loading')
  assert.equal(lookups.length, 1)
  const wrong = egress('context_changed', 9, 'old')
  assert.deepEqual(wrong.event, { type: 'context_changed' })
  assert.equal(egress('context_changed', 9, 'T', peer), null)
  const states = state => ({ ...live, snapshot: state })
  live = states(applyChatFrame(live.snapshot, wrong))
  assert.equal(live.snapshot.contextVersion, undefined)
  for (let seq = 10; seq < 20; seq++) {
    live = states(applyChatFrame(live.snapshot, egress('text_delta', seq)))
    render()
  }
  assert.equal(lookups.length, 1)
  const stateBefore = live.snapshot.state
  live = states(applyChatFrame(live.snapshot, egress('context_changed', 20)))
  assert.equal(live.snapshot.contextVersion, 20)
  assert.equal(live.snapshot.state, stateBefore)
  render()
  assert.equal(lookups.length, 2)
  assert.equal(lookups[0].signal.aborted, true)
  lookups[1].resolve(wireReport('live'))
  await setImmediate()
  assert.equal(render().props['data-testid'], 'workbench-context-meter')
  live = projection(13, { lastTurn: { turnId: 'T', status: 'completed' } })
  render()
  assert.equal(lookups.length, 3)
  render({ target: second })
  assert.equal(lookups[2].signal.aborted, true)
  assert.equal(lookups[3].model, changedModel)
  lookups[3].resolve(wireReport('estimate', changedModel))
  lookups[2].resolve(wireReport('measured'))
  await setImmediate()
  const meter = render({ target: second })
  assert.equal(meter.props.children.type, ring.ContextRing)
  assert.equal(meter.props.children.props.usage.estimated, true)
  const card = renderToStaticMarkup(react.createElement(ring.ContextRing, { ...meter.props.children.props, open: true }))
  assert.match(card, /<svg class="cf-mp__ring"/)
  assert.match(card, /data-source="estimate">Estimate from saved conversation history/)
  assert.doesNotMatch(card, /cf-mp__tick|measured input tokens/)
  assert.equal(render({ target: undefined }).props['data-source'], 'unavailable')
  assert.equal(render({ target: second, modelReady: false }), null)
  assert.equal(render({ target: second, sid: peer }), null)
  harness.close()
})
