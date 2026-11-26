import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))
const ts = require('typescript')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const src = new URL('../../apps/desktop/src/workbench/', import.meta.url)
async function load(name, dependencies = {}) {
  const js = ts.transpileModule(await readFile(new URL(name, src), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', js)((name) => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name), module, module.exports)
  return module.exports
}
const base = await load('transport.ts')
const wire = await load('terminal-view-transport.ts')
const controller = await load('terminal-view-controller.ts', { './transport': base, './terminal-view-transport': wire })
const { createWorkspaceFiles } = await load('workspace-files.ts', { './transport': base })
const { createTransport, HttpFailure } = base
const { createTerminalViewTransport, TERMINAL_DEFAULT_SIZE, TERMINAL_COMPACT_SIZE } = wire
const { bindTerminalView, terminalTarget, createTerminalView } = controller

const a = `w_${'a'.repeat(32)}`, b = `w_${'b'.repeat(32)}`
const id = `pt_${'1'.repeat(32)}`, newId = `pt_${'2'.repeat(32)}`
const path = 'docs/名字 <snapshot>.txt', revision = `r_${'c'.repeat(64)}`
const target = { workspaceId: a, path, revision }
const other = { workspaceId: b, path: 'other.txt', revision: `r_${'d'.repeat(64)}` }
const profile = { id: 'text-view', label: 'Read-only text viewer' }
const available = { available: true, profiles: [profile], reason: null }
const initial = { cols: 80, rows: 12, top: 0, left: 0, totalLines: 90, lines: ['first line'] }
const resized = { cols: 64, rows: 8, top: 12, left: 3, totalLines: 90, lines: ['screen from resize'] }
const quit = { code: 17, signal: null, reason: 'quit' }
const disposed = { code: null, signal: 15, reason: 'disposed' }
const lost = { code: null, signal: null, reason: 'worker-lost' }
const creation = (handle = id, screen = initial) => ({ id: handle, sequence: 0, cursor: 1, screen, exit: null })
const batch = (cursor, events, reset = false) => ({ cursor, reset, events })
const screenEvent = (seq, screen) => ({ seq, type: 'screen', screen })
const exitEvent = (seq, exit) => ({ seq, type: 'exit', exit })
const boot = { protocol: 1, version: '1', platform: 'linux', config: {}, csrf: 'owner-csrf', expiresAt: 1_900_000_000_000 }
const json = (value, status = 200) => new Response(JSON.stringify(value), { status })
const flush = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve, reject
  const promise = new Promise((r, j) => { resolve = r; reject = j })
  return { promise, resolve, reject }
}

function fixture(overrides = {}, clockOptions = {}) {
  const calls = [], polls = []
  let now = 80, expired = 0
  const handlers = {
    profiles: async () => available,
    start: async () => creation(),
    input: async (_wid, _id, sequence) => ({ sequence }),
    resize: async (_wid, _id, sequence) => ({ sequence }),
    events: () => { const next = deferred(); polls.push(next); return next.promise },
    dispose: async () => ({ closed: true, exit: disposed }),
    ...overrides
  }
  const transport = Object.fromEntries(Object.entries(handlers).map(([method, handler]) => [method, (...args) => {
    calls.push([method, ...args])
    return handler(...args)
  }]))
  const viewer = createTerminalView(transport, () => { expired++ }, { now: () => now, delay: async () => {}, ...clockOptions })
  return { viewer, calls, polls, tick: () => { now += 100 }, expired: () => expired,
    names: () => calls.map(([method]) => method), forMethod: (method) => calls.filter((entry) => entry[0] === method) }
}

function filesFixture(content = 'editor text') {
  const files = createWorkspaceFiles({ projects: async () => [{ id: a, name: 'A' }, { id: b, name: 'B' }],
    list: async (_wid, dir) => ({ path: dir, writable: true, entries: [] }),
    read: async (wid, selected) => selected === 'binary' || selected === 'oversized' ?
      { kind: selected === 'binary' ? 'binary' : 'tooLarge', path: selected, writable: false } :
      { kind: 'text', content, path: selected, revision: selected === 'no-real-revision' ? 'r_placeholder' : wid === a ? revision : other.revision, writable: true }
  })
  return files
}

test('strict capability plus exact same-origin GET/POST wire, receipt dimensions, reset snapshot and exit', async () => {
  const signal = new AbortController().signal
  const route = `/workspaces/${a}/terminals`
  const steps = [
    ['GET', '/bootstrap', undefined, { ...boot, capabilities: { terminalViewer: 'true', workspaceFiles: true } }],
    ['GET', '/bootstrap', undefined, { ...boot, capabilities: { terminalViewer: true, workspaceFiles: true } }],
    ['GET', '/terminal/profiles', undefined, { ...available, profiles: [{ ...profile, command: 'discard me' }] }],
    ['POST', route, { profile: 'text-view', path, revision, cols: 80, rows: 12 }, creation(id, { ...initial, lines: ['\u001b[31m<text>\u009d\u202e\u2067a\u200cb👩\u200d🔬'] }), 201],
    ['POST', `${route}/${id}/input`, { sequence: 1, key: 'page-down' }, { sequence: 1 }],
    ['POST', `${route}/${id}/resize`, { sequence: 2, cols: 64, rows: 8 }, { sequence: 2 }],
    ['POST', `${route}/${id}/events`, { after: 1, waitMs: 5000 }, batch(5, [screenEvent(4, resized), exitEvent(5, quit)], true)],
    ['POST', `${route}/${id}/dispose`, {}, { closed: true, exit: disposed }]
  ]
  const root = createTransport(async (url, init) => {
    const [method, endpoint, body, response, status] = steps.shift()
    assert.equal(url, `/api/v1${endpoint}`)
    assert.equal(init.method, method)
    assert.deepEqual(init.body && JSON.parse(init.body), body)
    assert.equal(init.mode, 'same-origin')
    assert.equal(init.credentials, 'same-origin')
    assert.equal(init.redirect, 'error')
    assert.equal(init.cache, 'no-store')
    assert.equal(init.headers.accept, 'application/json')
    assert.equal(init.headers.origin, undefined)
    assert.equal(init.keepalive, endpoint.endsWith('/dispose') ? true : undefined)
    const scoped = method === 'POST'
    assert.equal(init.headers['x-deva-csrf'], scoped ? boot.csrf : undefined)
    assert.equal(init.referrerPolicy, scoped ? 'same-origin' : 'no-referrer')
    assert.equal(init.headers['content-type'], scoped ? 'application/json' : undefined)
    if (!['/bootstrap', route].includes(endpoint) && !endpoint.endsWith('/dispose')) assert.equal(init.signal, signal)
    return json(response, status)
  })
  assert.deepEqual((await root.inspect()).bootstrap.capabilities, { workspaceFiles: true })
  assert.deepEqual((await root.inspect()).bootstrap.capabilities, { workspaceFiles: true, terminalViewer: true })
  const api = createTerminalViewTransport(root, boot.csrf)
  assert.deepEqual(await api.profiles(signal), available)
  assert.deepEqual(await api.start({ ...target, contents: 'private', shell: 'never', sid: 'separate', env: {} }, TERMINAL_DEFAULT_SIZE),
    creation(id, { ...initial, lines: ['�[31m<text>���a\u200cb👩\u200d🔬'] }))
  assert.deepEqual(await api.input(a, id, 1, 'page-down', signal), { sequence: 1 })
  assert.deepEqual(await api.resize(a, id, 2, { ...TERMINAL_COMPACT_SIZE, shell: 'discard me' }, signal), { sequence: 2 })
  assert.deepEqual(await api.events(a, id, 1, 5000, signal), batch(5, [screenEvent(4, resized), exitEvent(5, quit)], true))
  assert.deepEqual(await api.dispose(a, id), { closed: true, exit: disposed })
  assert.deepEqual(steps, [])
})

test('wire rejects wrong scope, key, dimensions, status, sequence, cursor and event order', async () => {
  const signal = new AbortController().signal
  const calls = []
  const responses = [json(creation()), json({ ...creation(), sequence: 7 }, 201), json({ closed: true, exit: disposed }),
    json({ sequence: 2 }), json(batch(4, [screenEvent(4, initial)])), json(batch(3, [exitEvent(2, quit), screenEvent(3, initial)])),
    json(batch(2, [screenEvent(2, { ...initial, cols: 161 })])), json(batch(2, [exitEvent(2, { ...quit, signal: 'SIGTERM' })])),
    json({ available: true, profiles: [{ id: 'shell', label: 'Shell' }], reason: null })]
  const api = createTerminalViewTransport(createTransport(async (url) => { calls.push(url); return responses.shift() }), boot.csrf)
  const invalid = /Invalid TTY/
  for (const value of ['../escape', `${a}?x`, `${a}\n`, '/etc/passwd']) await assert.rejects(api.start({ ...target, workspaceId: value }, TERMINAL_DEFAULT_SIZE), invalid)
  for (const value of ['/docs/x', '../x', 'docs/../x', 'C:/x', 'x\\y', 'x\nx']) await assert.rejects(api.start({ ...target, path: value }, TERMINAL_DEFAULT_SIZE), invalid)
  await assert.rejects(api.start({ ...target, revision: 'r_demo' }, TERMINAL_DEFAULT_SIZE), invalid)
  await assert.rejects(api.input(a, id, 1, 'printf hi', signal), invalid)
  await assert.rejects(api.input(a, `${id}/../`, 1, 'up', signal), invalid)
  await assert.rejects(api.input(a, id, 0, 'up', signal), invalid)
  await assert.rejects(api.resize(a, id, 1, { cols: 23, rows: 51 }, signal), invalid)
  await assert.rejects(api.events(a, id, 1, 5001, signal), invalid)
  assert.deepEqual(calls, [])
  await assert.rejects(api.start(target, TERMINAL_DEFAULT_SIZE), /Unexpected HTTP status/)
  await assert.rejects(api.start(target, TERMINAL_DEFAULT_SIZE), invalid)
  assert.equal(calls[2], `/api/v1/workspaces/${a}/terminals/${id}/dispose`)
  await assert.rejects(api.input(a, id, 1, 'up', signal), invalid)
  for (let i = 0; i < 4; i++) await assert.rejects(api.events(a, id, 1, 0, signal), invalid)
  await assert.rejects(api.profiles(signal), invalid)
  assert.deepEqual(responses, [])
})

test('receipts enforce native bounds, validate initial origin and fence reset snapshots', async () => {
  let reply
  const paths = []
  const signal = new AbortController().signal
  const api = createTerminalViewTransport(createTransport(async (url) => {
    paths.push(url)
    return url.endsWith('/dispose') ? json({ closed: true, exit: disposed }) : reply
  }), boot.csrf)
  const invalid = /Invalid TTY/
  const route = `/api/v1/workspaces/${a}/terminals`
  for (const fields of [{ cols: 64 }, { rows: 8 }, { top: 1 }, { left: 1 }]) {
    reply = json(creation(id, { ...initial, ...fields }), 201)
    await assert.rejects(api.start(target, TERMINAL_DEFAULT_SIZE), invalid)
    assert.deepEqual(paths.slice(-2), [route, `${route}/${id}/dispose`])
  }
  const line = `x${'\u0301'.repeat(24_575)} `
  assert.equal(Buffer.byteLength(line + line), 96 * 1024)
  for (const fields of [{ totalLines: 0 }, { totalLines: 4097 }, { top: 90 }, { top: -1 }, { left: 524_288 - 80 + 1 },
    { left: 1.5 }, { lines: [] }, { lines: Array(13).fill('x') }, { lines: ['x', 'y'], top: 89 }, { lines: ['\ud800'] },
    { lines: [line, `${line}x`] }, { lines: [line, `${line.slice(0, -1)}\x1b`] }]) {
    reply = json(batch(4, [screenEvent(4, { ...initial, ...fields })]))
    await assert.rejects(api.events(a, id, 3, 0, signal), invalid)
  }
  for (const value of [batch(12, Array.from({ length: 9 }, (_, i) => screenEvent(4 + i, initial))),
    batch(8, [screenEvent(3, initial), exitEvent(8, quit)], true), batch(3, [], true),
    batch(8, [screenEvent(7, initial), screenEvent(8, initial)], true),
    batch(4, [exitEvent(4, { ...quit, code: -1 })]), batch(4, [exitEvent(4, { ...quit, signal: 2 ** 31 })]),
    batch(4, [exitEvent(4, { ...lost, code: 0 })]), batch(4, [exitEvent(4, { ...lost, signal: 9 })])]) {
    reply = json(value)
    await assert.rejects(api.events(a, id, 3, 0, signal), invalid)
  }
  const maxOffsets = { ...initial, totalLines: 4096, top: 4095, left: 524_288 - 80 }
  const fault = { code: 2 ** 31 - 1, signal: 9, reason: 'fault' }
  const replay = batch(8, [screenEvent(7, maxOffsets), exitEvent(8, fault)], true)
  reply = json(replay)
  assert.deepEqual(await api.events(a, id, 3, 0, signal), replay)
  const exactLimit = batch(5, [screenEvent(4, { ...initial, lines: [line, line] }), exitEvent(5, lost)])
  reply = json(exactLimit)
  assert.deepEqual(await api.events(a, id, 3, 0, signal), exactLimit)
  reply = json({ available: false, profiles: [profile], reason: 'unavailable' })
  await assert.rejects(api.profiles(signal), invalid)
})

test('real selector is passive; the original project and confirmed text revision are required', async () => {
  const f = fixture()
  const files = filesFixture()
  const unbind = bindTerminalView(f.viewer, files)
  await f.viewer.open(target)
  await files.loadProjects()
  await files.select(a)
  await files.toggle('docs')
  for (const file of ['binary', 'oversized', 'no-real-revision']) {
    await files.openFile(file)
    assert.equal(terminalTarget(files.snapshot()), undefined)
  }
  await files.openFile(path)
  assert.deepEqual(terminalTarget(files.snapshot()), target)
  files.edit('draft: do not transmit')
  assert.equal(terminalTarget(files.snapshot()), undefined)
  await f.viewer.open(target)
  files.edit('editor text')
  await files.select(b)
  await files.openFile(other.path)
  await f.viewer.open(target)
  assert.deepEqual(f.calls, [])
  assert.deepEqual(terminalTarget(files.snapshot()), other)
  await f.viewer.open(other)
  assert.deepEqual(f.names(), ['profiles', 'start', 'events'])
  assert.deepEqual(f.calls[1].slice(1), [other, TERMINAL_DEFAULT_SIZE])
  files.edit('new draft')
  assert.equal(f.viewer.snapshot().phase, 'closed')
  assert.equal(f.forMethod('events')[0].at(-1).aborted, true)
  assert.deepEqual(f.forMethod('dispose'), [['dispose', b, id]])
  await files.select(a)
  assert.equal(f.viewer.snapshot().phase, 'closed')
  assert.deepEqual(f.names(), ['profiles', 'start', 'events', 'dispose'])
  unbind()
})

test('burst controls serialize by confirmed sequence, display native resize events and retain exact exit until close', async () => {
  const first = deferred(), resize = deferred(), ending = deferred()
  const f = fixture({ input: (_wid, _id, seq) => seq === 1 ? first.promise : ending.promise, resize: () => resize.promise })
  f.viewer.selectTarget(target)
  await f.viewer.open(target)
  assert.deepEqual(f.viewer.snapshot().screen, initial)
  assert.deepEqual(f.forMethod('events')[0].slice(1, -1), [a, id, 1, 5000])
  await f.viewer.key('x')
  const next = f.viewer.key('page-down')
  await f.viewer.key('down')
  await f.viewer.resize(TERMINAL_COMPACT_SIZE)
  assert.equal(f.viewer.snapshot().phase, 'pending')
  assert.deepEqual(f.forMethod('input').map(call => call.slice(1, -1)), [[a, id, 1, 'page-down']])
  first.resolve({ sequence: 1 })
  await next
  await f.viewer.key('down') // Even a very fast successful ACK grants no extra key in the burst.
  assert.equal(f.forMethod('input').length, 1)
  const setting = f.viewer.resize(TERMINAL_COMPACT_SIZE)
  assert.deepEqual(f.forMethod('resize')[0].slice(1, -1), [a, id, 2, TERMINAL_COMPACT_SIZE])
  resize.resolve({ sequence: 2 })
  await setting
  assert.deepEqual(f.viewer.snapshot().screen, initial) // The ACK does not manufacture a native receipt.
  f.polls[0].resolve(batch(2, [screenEvent(2, resized)]))
  await flush()
  assert.deepEqual(f.viewer.snapshot().screen, resized)
  assert.deepEqual(f.forMethod('events')[1].slice(1, -1), [a, id, 2, 5000])
  const quitting = f.viewer.key('quit')
  assert.deepEqual(f.forMethod('input')[1].slice(1, -1), [a, id, 3, 'quit'])
  f.polls[1].resolve(batch(3, [exitEvent(3, quit)])) // Exit can arrive before the key ACK.
  await flush()
  ending.resolve({ sequence: 3 })
  await quitting
  assert.deepEqual(f.viewer.snapshot(), { phase: 'exited', target, screen: resized, exit: quit })
  await f.viewer.key('up')
  assert.equal(f.forMethod('input').length, 2)
  assert.equal(f.forMethod('events').length, 2)
  assert.deepEqual(f.forMethod('dispose'), [])
  f.viewer.dismiss()
  assert.deepEqual(f.forMethod('dispose'), [['dispose', a, id]])
})

test('disconnect hides old screen; safe reconnect reads the same cursor then applies a reset and real exit', async () => {
  const retry = deferred()
  const f = fixture({}, { delay: (_ms, signal) => { assert.equal(signal.aborted, false); return retry.promise } })
  f.viewer.selectTarget(target)
  await f.viewer.open(target)
  f.polls[0].reject(new TypeError('failed to fetch'))
  await flush()
  assert.equal(f.viewer.snapshot().phase, 'reconnecting')
  assert.equal(f.viewer.snapshot().screen, undefined)
  await f.viewer.key('end')
  assert.deepEqual(f.names(), ['profiles', 'start', 'events'])
  retry.resolve()
  await flush()
  assert.deepEqual(f.forMethod('events').map(call => call.slice(1, -1)), [[a, id, 1, 5000], [a, id, 1, 5000]])
  f.polls[1].resolve(batch(28, [screenEvent(26, resized), exitEvent(28, lost)], true))
  await flush()
  assert.deepEqual(f.viewer.snapshot(), { phase: 'exited', target, screen: resized, exit: lost })
  assert.equal(f.forMethod('events').length, 2)
  f.viewer.disconnect() // Page offline clears even a retained receipt and retires the original handle.
  assert.equal(f.viewer.snapshot().screen, undefined)
  assert.equal(f.viewer.snapshot().issue, 'disconnected')
  assert.deepEqual(f.forMethod('dispose'), [['dispose', a, id]])
})

test('unknown mutation is never replayed; auth loss clears data and only current auth can expire the page', async () => {
  const f = fixture({ input: async () => { throw new TypeError('ack lost') }, start: async (item) => creation(item.workspaceId === a ? id : newId) })
  f.viewer.selectTarget(target)
  await f.viewer.open(target)
  await f.viewer.key('down')
  assert.equal(f.viewer.snapshot().issue, 'uncertain')
  assert.equal(f.viewer.snapshot().screen, undefined)
  assert.equal(f.forMethod('events')[0].at(-1).aborted, true)
  await f.viewer.key('down')
  await f.viewer.open(target)
  assert.deepEqual(f.names(), ['profiles', 'start', 'events', 'input', 'dispose'])
  f.viewer.dismiss()
  await f.viewer.open(target)
  f.polls[0].reject(new HttpFailure(401, 'auth'))
  await flush()
  assert.equal(f.expired(), 0)
  assert.equal(f.viewer.snapshot().phase, 'active')
  f.polls[1].reject(new HttpFailure(401, 'auth'))
  await flush()
  assert.equal(f.expired(), 1)
  assert.deepEqual(f.viewer.snapshot(), { phase: 'error', target, issue: 'auth' })
  assert.deepEqual(f.names().slice(-4), ['profiles', 'start', 'events', 'dispose'])
})

test('cancels a profile check and cleans late creation/resize without changing a replacement panel', async () => {
  const waiting = deferred()
  const f = fixture({ profiles: () => waiting.promise })
  f.viewer.selectTarget(target)
  const checking = f.viewer.open(target)
  f.viewer.selectTarget(undefined)
  assert.equal(f.calls[0].at(-1).aborted, true)
  waiting.resolve(available)
  await checking
  assert.deepEqual(f.names(), ['profiles'])

  const creating = deferred(), resizing = deferred()
  const g = fixture({ start: ({ workspaceId }) => workspaceId === a ? creating.promise : Promise.resolve(creation(newId)), resize: () => resizing.promise })
  g.viewer.selectTarget(target)
  const opening = g.viewer.open(target)
  await flush()
  g.viewer.selectTarget(other)
  await g.viewer.open(other)
  const pendingResize = g.viewer.resize(TERMINAL_COMPACT_SIZE)
  assert.deepEqual(g.viewer.snapshot().target, other)
  creating.resolve(creation(id, { ...initial, lines: ['stale A'] }))
  await opening
  assert.deepEqual(g.forMethod('dispose'), [['dispose', a, id]])
  assert.equal(g.viewer.snapshot().phase, 'pending')
  assert.equal(g.viewer.snapshot().screen.lines[0], 'first line')
  g.viewer.selectTarget(undefined)
  assert.equal(g.forMethod('resize')[0].at(-1).aborted, true)
  assert.equal(g.forMethod('events')[0].at(-1).aborted, true)
  resizing.resolve({ sequence: 1 })
  g.polls[0].resolve(batch(2, [screenEvent(2, resized)]))
  await pendingResize
  assert.deepEqual(g.viewer.snapshot(), { phase: 'closed' })
  assert.deepEqual(g.forMethod('dispose'), [['dispose', a, id], ['dispose', b, newId]])
  assert.equal(g.forMethod('events').length, 1)
})

test('unavailable configurations never start a worker; a changed original revision clears the panel', async () => {
  for (const reason of ['unavailable', 'unconfigured']) {
    const f = fixture({ profiles: async () => ({ available: false, profiles: [], reason }) })
    f.viewer.selectTarget(target)
    await f.viewer.open(target)
    assert.equal(f.viewer.snapshot().issue, reason)
    assert.deepEqual(f.names(), ['profiles'])
  }
  const f = fixture({ input: async () => { throw new HttpFailure(409, 'terminal_source_changed') } })
  f.viewer.selectTarget(target)
  await f.viewer.open(target)
  await f.viewer.key('down')
  assert.equal(f.viewer.snapshot().issue, 'stale')
  assert.equal(f.viewer.snapshot().screen, undefined)
  f.viewer.selectTarget({ ...target, revision: other.revision })
  assert.deepEqual(f.viewer.snapshot(), { phase: 'closed' })
  assert.deepEqual(f.names(), ['profiles', 'start', 'events', 'input', 'dispose'])
})

let locale = 'en'
const i18n = { useI18n: () => ({ locale }) }
const panel = await load('terminal-view-panel.tsx', { '../renderer/src/i18n/i18n': i18n, './terminal-view-controller': controller,
  './terminal-view-transport': wire, './terminal-view.css': {} })
const workspace = await load('workspace-dialog.tsx', { '../renderer/src/i18n/i18n': i18n, './terminal-view-controller': controller,
  './terminal-view-panel': panel, './git-view-controller': {}, './git-view-panel': {}, './workspace-files': {},
  './workspace-line-endings': await load('workspace-line-endings.ts'), './workspace-dialog.css': {} })
function render(files, terminal, open = true) {
  const original = console.error
  // The real client uses layout effects for native dialog and viewport focus; React SSR emits a diagnostic for these.
  console.error = (...args) => { if (!String(args[0]).includes('useLayoutEffect does nothing on the server')) original(...args) }
  try { return renderToStaticMarkup(React.createElement(workspace.WorkspaceFilesPanel, { open, close() {}, controller: files, terminal })) }
  finally { console.error = original }
}

test('workspace details gate the actual bilingual viewer and render escaped, named read-only text and exact receipts', async () => {
  const f = fixture({ start: async () => creation(id, { ...initial, lines: ['<img src=x>', '<script>plain</script>', 'https://example.invalid/'] }) })
  const files = filesFixture()
  const unbind = bindTerminalView(f.viewer, files)
  await files.loadProjects()
  await files.select(a)
  await files.toggle('docs')
  await files.openFile(path)
  assert.doesNotMatch(render(files), /workbench-tty-open/)
  assert.doesNotMatch(render(files, f.viewer, false), /workbench-tty-open/)
  assert.match(render(files, f.viewer), /workbench-tty-open.*Open TTY viewer/)
  assert.match(render(files, f.viewer), /workbench-workspace-editor[^>]*>editor text<\/textarea>/)
  assert.doesNotMatch(render(files, f.viewer), /workbench-tty-panel/)
  files.edit('unsaved')
  assert.match(render(files, f.viewer), /workbench-workspace-editor[^>]*>unsaved<\/textarea>/)
  assert.doesNotMatch(render(files, f.viewer), /workbench-tty-open/)
  await files.openFile('binary')
  assert.doesNotMatch(render(files, f.viewer), /workbench-tty-open/)
  await files.openFile(path)
  files.edit('editor text')
  assert.deepEqual(f.calls, [])
  locale = 'zh-CN'
  try {
    assert.match(render(files, f.viewer), /打开 TTY 查看器/)
    const opening = f.viewer.open(target)
    const loading = render(files, f.viewer)
    assert.match(loading, /data-status="loading"/)
    assert.doesNotMatch(loading, /workbench-(tty-open|workspace-editor)/)
    await opening
    const html = render(files, f.viewer)
    for (const id of ['panel', 'screen', 'size', 'next', 'previous', 'quit', 'close', 'status']) assert.ok(html.includes(`data-testid="workbench-tty-${id}"`), id)
    assert.match(html, /<pre[^>]+tabindex="0"[^>]+role="region"[^>]+aria-label="TTY 文本屏幕"/)
    assert.match(html, /data-cols="80" data-rows="12" data-top="0" data-left="0" data-total-lines="90"/)
    assert.match(html, /调整为 64 × 8.*视口 80 × 12 · 第 1–3 行，共 90 行 · 起始列: 1/s)
    assert.match(html, new RegExp(`<code role="group" title="${revision}" aria-label="版本: ${revision}"><span aria-hidden="true">${revision.slice(0, 14)}…</span></code>`))
    assert.match(html, /磁盘快照:.*docs\/名字 &lt;snapshot&gt;\.txt.*版本:/)
    assert.match(html, /&lt;img src=x&gt;.*&lt;script&gt;plain&lt;\/script&gt;.*https:\/\/example.invalid\//s)
    assert.doesNotMatch(html, /<img src=x>|<script>|href=|contenteditable|workbench-(tty-open|workspace-editor)/)
    const screenAt = html.indexOf('data-testid="workbench-tty-screen"')
    for (const id of ['previous', 'next', 'size', 'quit']) assert.ok(html.indexOf(`data-testid="workbench-tty-${id}"`) < screenAt, id)
    assert.match(html, /<details class="wb-tty__more"><summary>更多导航<\/summary>.*workbench-tty-up.*workbench-tty-end.*<\/details>/)
    f.polls[0].resolve(batch(2, [screenEvent(2, { ...resized, lines: ['screen from resize', 'next visible row'] })]))
    await flush()
    locale = 'en'
    assert.match(render(files, f.viewer), /Viewport 64 × 8 · Rows 13–14 of 90 · First visible column: 4/)
    assert.match(render(files, f.viewer), /<summary>More navigation<\/summary>/)
    locale = 'zh-CN'
    f.polls[1].resolve(batch(3, [exitEvent(3, quit)]))
    await flush()
    const exited = render(files, f.viewer)
    assert.match(exited, /data-status="exited" data-code="17" data-signal="null" data-reason="quit".*退出码: 17/)
    assert.doesNotMatch(exited, /workbench-(tty-open|workspace-editor)/)
    f.viewer.dismiss()
    const closed = render(files, f.viewer)
    assert.match(closed, /打开 TTY 查看器/)
    assert.match(closed, /workbench-workspace-editor[^>]*>editor text<\/textarea>/)
    assert.doesNotMatch(closed, /workbench-tty-panel/)
  } finally { locale = 'en'; unbind() }
})

test('dismiss returns focus after the launch button commits; closed eligibility changes keep the editor slot', async () => {
  const refs = []
  let nextRef = 0, effects = [], focused = 0
  // Model the commit order without a DOM: React assigns the button ref before layout effects run.
  const { TerminalViewer } = await load('terminal-view-panel.tsx', {
    '../renderer/src/i18n/i18n': i18n, './terminal-view-controller': controller, './terminal-view-transport': wire, './terminal-view.css': {},
    react: {
      useId: () => 'viewer', useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
      useRef: (initial) => { const index = nextRef++; return refs[index] ?? (refs[index] = { current: initial }) },
      useLayoutEffect: (effect) => effects.push(effect)
    }
  })
  const { viewer } = fixture()
  const editor = React.createElement('textarea', { defaultValue: 'draft stays in the same slot' })
  function commit(selection) {
    nextRef = 0; effects = []
    const children = TerminalViewer({ api: viewer, target: selection, children: editor }).props.children
    const node = children[0]?.props?.children
    refs[0].current = node?.type === 'button' ? { focus: () => { focused++ } } : null
    effects.forEach(effect => effect())
    return children
  }
  assert.equal(commit(undefined)[1], editor)
  viewer.selectTarget(target)
  assert.equal(commit(target)[1], editor)
  assert.equal(focused, 0)
  await viewer.open(target)
  const opened = commit(target)
  assert.equal(opened[1], false)
  opened[0].props.children.props.close()
  assert.equal(focused, 0)
  const closed = commit(target)
  assert.equal(closed[0].props.children.props['data-testid'], 'workbench-tty-open')
  assert.equal(closed[1], editor)
  assert.equal(focused, 1)
  viewer.selectTarget(undefined)
  assert.equal(commit(undefined)[1], editor)
  assert.equal(focused, 1)
})

test('explicit open distinguishes size, encoding and source-rule failures in both locales without staging text', async () => {
  const cases = [
    [413, 'terminal_limit', 'limit', /64 KiB and 4,096 lines/, /至多 64 KiB 且至多 4,096 行/],
    [422, 'terminal_unsupported', 'unsupported', /Choose a plain UTF-8 text file/, /选择 UTF-8 纯文本文件/],
    [403, 'terminal_source_denied', 'sourceDenied', /Workspace rules restrict access/, /文件受工作区查看限制/]
  ]
  for (const [status, code, issue, en, zh] of cases) {
    const calls = []
    const terminal = createTerminalView(createTerminalViewTransport(createTransport(async (url, init) => {
      calls.push([url, init.method, init.body && JSON.parse(init.body)])
      return init.method === 'GET' ? json(available) : json({ error: code, private: '/host/internal' }, status)
    }), boot.csrf), () => assert.fail('Source errors must not expire the owner session'))
    const files = filesFixture(status === 413 ? 'x'.repeat(65_537) : 'editor text')
    const unbind = bindTerminalView(terminal, files)
    try {
      await files.loadProjects()
      await files.select(a)
      await files.openFile(path)
      assert.match(render(files, terminal), /workbench-tty-open/)
      assert.deepEqual(calls, [])
      await terminal.open(target)
      assert.deepEqual(calls, [
        ['/api/v1/terminal/profiles', 'GET', undefined],
        [`/api/v1/workspaces/${a}/terminals`, 'POST', { profile: 'text-view', path, revision, cols: 80, rows: 12 }]
      ])
      assert.deepEqual(terminal.snapshot(), { phase: 'error', target, issue })
      for (const [language, message] of [['en', en], ['zh-CN', zh]]) {
        locale = language
        const html = render(files, terminal)
        assert.match(html, new RegExp(`role="alert" data-testid="workbench-tty-status" data-status="error" data-issue="${issue}"`))
        assert.match(html, message)
        assert.doesNotMatch(html, /workbench-tty-screen|\/host\/internal/)
      }
    } finally { locale = 'en'; unbind() }
  }
})

test('sequence conflict clears the screen and does not replay or send a subsequent mutation', async () => {
  const f = fixture({ resize: async () => { throw new HttpFailure(409, 'terminal_sequence') } })
  f.viewer.selectTarget(target)
  await f.viewer.open(target)
  await f.viewer.resize(TERMINAL_COMPACT_SIZE)
  await f.viewer.key('down')
  await f.viewer.resize(TERMINAL_COMPACT_SIZE)
  assert.deepEqual(f.viewer.snapshot(), { phase: 'error', target, issue: 'uncertain' })
  assert.deepEqual(f.names(), ['profiles', 'start', 'events', 'resize', 'dispose'])
})

test('entry points bind only the granted workspace surface and gate trusted fixed keyboard events', async () => {
  const [entry, dialog, ui] = await Promise.all(['text-workbench.tsx', 'workspace-dialog.tsx', 'terminal-view-panel.tsx']
    .map(name => readFile(new URL(name, src), 'utf8')))
  assert.match(entry, /filesEnabled && bootstrap\.capabilities\?\.terminalViewer === true/)
  assert.match(entry, /\[terminalEnabled, transport, bootstrap\.csrf, bootstrap\.expiresAt, onExpired, sid\]/)
  assert.match(entry, /terminal=\{locked \? undefined : terminal\}/)
  assert.match(dialog, /\[data-workspace-git\], \[data-workspace-tty\]/)
  assert.match(dialog, /<FileDetails[^>]+terminal=\{terminal\}/)
  assert.match(ui, /nativeEvent\.isTrusted.*api\.open\(target\)/)
  assert.match(ui, /keyboard\.get\(event\.key\)[\s\S]*?active && !event\.repeat\) void api\.key\(key\)/)
  assert.doesNotMatch(ui, /dangerouslySetInnerHTML|\bfetch\(|clipboard|xterm|onPaste/)
})
