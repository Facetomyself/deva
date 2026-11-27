import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))
const ts = require('typescript')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const src = new URL('../../apps/desktop/src/', import.meta.url)
async function load(path, imports = {}, globals = {}) {
  const js = ts.transpileModule(await readFile(new URL(path, src), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }
  }).outputText
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', ...Object.keys(globals), js)(
    (name) => Object.hasOwn(imports, name) ? imports[name] : require(name), mod, mod.exports, ...Object.values(globals))
  return mod.exports
}
const base = await load('workbench/transport.ts')
const transport = await load('workbench/task-inspection-transport.ts')
const taskController = await load('workbench/task-inspection-controller.ts', {
  './transport': base, './task-inspection-transport': transport
})
const { createTaskInspection } = taskController
const time = await load('workbench/task-inspection-time.ts')
const copy = await load('workbench/task-inspection-copy.ts')
const messages = (await load('renderer/src/i18n/messages.ts')).messages
let uiLocale = 'en'
const i18n = { useI18n: () => ({ locale: uiLocale, t: (key) => key.split('.').reduce((part, name) => part?.[name], messages[uiLocale]) ?? key }) }
const reactSSR = { ...React, useLayoutEffect: React.useEffect }
const parts = await load('renderer/src/redesign/TaskInspectionParts.tsx', { '../i18n/i18n': i18n })
const desktopSchedule = await load('renderer/src/features/chat/schedule.ts')
const editor = await load('renderer/src/features/chat/ScheduleEditor.tsx', { '../../i18n/i18n': i18n,
  '../../components/Select': await load('renderer/src/components/Select.tsx', { react: reactSSR }), './schedule': desktopSchedule })
const taskUI = await load('workbench/task-inspection-ui.tsx', {
  react: reactSSR, '../renderer/src/features/chat/ScheduleEditor': editor, '../renderer/src/i18n/i18n': i18n,
  '../renderer/src/redesign/TaskInspectionParts': parts, './task-inspection-copy': copy, './task-inspection-time': time,
  './task-inspection.css': {}
})
const { TaskInspectionPanel } = taskUI
const noop = () => {}
const noComponent = () => null
const { IconRail } = await load('renderer/src/redesign/IconRail.tsx', {
  '../i18n/i18n': i18n, './ProfilePanel': { ProfilePanel: noComponent }, './shell-common': { Avatar: noComponent }
})
const { createTransport, HttpFailure } = base
const { createTaskInspectionTransport } = transport

const a = 'bd437558-f2d4-4054-b0e4-9a454b68ac03', b = 'native_task_2'
const revision = 'a'.repeat(64), newer = 'b'.repeat(64), execution = 'inactive'
const now = Date.UTC(2031, 6, 1, 17, 13, 0)
const once = { kind: 'once', at: '2031-07-01T13:13', tz: 'America/New_York' }
const recurring = { kind: 'recurring', cron: '17 13 * * *', tz: 'UTC' }
const summary = (id = a, extra = {}) => ({ id, title: 'Native <img src=x> schedule', status: 'active', schedule: once,
  createdAt: now, updatedAt: now, lastRunAt: now, nextRunAt: now, runCount: 1, ...extra })
const task = (id = a, extra = {}) => ({ ...summary(id), prompt: '<script>alert(1)</script>\n**plain**', auth: { personaId: null, modelRef: 'local:model' },
  sessionId: `task-${id}`, ownerSessionId: null, originSessionId: null, consecutiveErrors: 1, pauseAllowed: true,
  runs: [{ firedAt: now, finishedAt: now + 1_000, status: 'error', summary: '<img src=x onerror=alert(1)>', error: 'Recorded <error>' }], ...extra })
const list = (tasks = [summary(), summary(b)]) => ({ tasks, revision, execution })
const detail = (record = task(), rev = revision) => ({ task: record, revision: rev, execution })
const preview = { ok: true, description: 'Schedule calculation <b>only</b>', nextRunAt: now }
const boot = { protocol: 1, version: '1', platform: 'linux', csrf: 'private-csrf', config: {}, expiresAt: now }
const json = (value, status = 200) => new Response(JSON.stringify(value), { status })
function deferred() {
  let resolve, reject
  const promise = new Promise((ok, bad) => { resolve = ok; reject = bad })
  return { promise, resolve, reject }
}
function fixture(overrides = {}, beforePause = async () => {}) {
  let expiries = 0
  const calls = []
  const reads = { list: async () => list(), detail: async (id) => detail(task(id)), preview: async () => preview,
    pause: async () => {}, ...overrides }
  const api = Object.fromEntries(Object.entries(reads).map(([method, call]) => [method, (...args) => {
    calls.push({ method, args: args.slice(0, -1), signal: args.at(-1) })
    return call(...args)
  }]))
  return { api: createTaskInspection(api, { expired: () => { expiries++ }, beforePause }), calls, expired: () => expiries }
}

const input = { schedule: recurring, locale: 'en', allowPast: false }

const bootWithTasks = { ...boot, capabilities: { taskInspection: true } }
const taskButton = (html) => html.match(/<button[^>]+aria-label="Tasks"[^>]*>/)?.[0]

test('the actual AlarmClock rail button keeps Desktop behavior and exposes accessible Web state', () => {
  const render = (overrides = {}) => renderToStaticMarkup(React.createElement(IconRail, {
    tab: 'chats', onTab: noop, listCollapsed: false, chatAlert: false, onOpenSettings: noop, ...overrides
  }))
  const desktop = taskButton(render({ tab: 'tasks' }))
  assert.match(desktop, /aria-current="true"/)
  assert.doesNotMatch(desktop, /disabled|workbench-tasks-toggle|aria-expanded|aria-controls/)
  const unavailable = 'Available on Desktop'
  const unsupported = taskButton(render({ unavailable }))
  assert.match(unsupported, /disabled=""/)
  assert.match(unsupported, /title="Available on Desktop"/)
  assert.doesNotMatch(unsupported, /workbench-tasks-toggle|aria-expanded/)
  const support = { panelId: 'saved-tasks', disabled: false, buttonRef: React.createRef() }
  const closed = taskButton(render({ unavailable, taskInspection: support }))
  assert.match(closed, /type="button"/)
  assert.match(closed, /data-testid="workbench-tasks-toggle"/)
  assert.match(closed, /aria-current="false" aria-expanded="false"/)
  assert.doesNotMatch(closed, /disabled|aria-controls/)
  const open = taskButton(render({ tab: 'tasks', unavailable, taskInspection: support }))
  assert.match(open, /class="cf-navbtn is-active"/)
  assert.match(open, /aria-current="true" aria-expanded="true" aria-controls="saved-tasks"/)
  assert.match(taskButton(render({ unavailable, taskInspection: { ...support, disabled: true } })), /disabled=""/)
})

test('the real Workbench mounts only the task main alongside the rail and restores the selected chat', async () => {
  const pending = deferred()
  const f = fixture({ list: () => pending.promise })
  let rail
  const sid = 'retained-chat'
  const draftModule = await load('workbench/quote-draft.ts', {
    '../renderer/src/redesign/ConvMessage': { withQuote: (quote, body) => quote ? `${quote}\n\n${body}` : body },
    './chat-transport': { inputBytes: (value) => Buffer.byteLength(value), MAX_TEXT_INPUT: 12*1024 }
  })
  const draft = draftModule.createQuoteDrafts()
  draft.setBody(sid, 'retained draft')
  const selected = { id: sid, title: 'Retained chat', compatibility: 'text', updatedAt: now }
  const selectCalls = []
  const wk = { selected: sid, sessions: [selected], select: (id) => selectCalls.push(id), drafts: draft,
    isSelected: id => id === sid, selectionStamp: id => id === sid ? 1 : undefined,
    projection: { status: 'ready', snapshot: { cursor: { generation: 'test' }, state: { writable: true, compatibility: 'text' } } } }
  const window = { innerWidth: 1200, innerHeight: 900 }
  // Mount the real React composition with only the non-task host-dependent hooks mocked.
  const chatSurface = await load('renderer/src/redesign/ChatSurface.tsx', { './redesign.css': {} })
  const resizing = await load('renderer/src/redesign/resizable.tsx', {}, { window })
  const chatCopy = await load('workbench/chat-copy.ts')
  const inertModules = Object.fromEntries([
    './browser-manual', './browser-panel', './browser-transport', './deliveries-transport',
    './git-view-controller', './git-view-transport', './library-memory', './library-transport', './library-workspace',
    './session-preference-ui', './session-workspace-transport', './workspace-dialog', './workspace-files', './workspace-transport',
    './terminal-view-controller', './terminal-view-transport', './project-document-controller', './project-document-transport',
    '../renderer/src/redesign/ConvMessage', './text-workbench.css'
  ].map(name => [name, {}]))
  const { default: TextWorkbench } = await load('workbench/text-workbench.tsx', {
    ...inertModules, react: { ...reactSSR, useSyncExternalStore: (_subscribe, read) => read() },
    '../renderer/src/i18n/i18n': i18n,
    '../renderer/src/store/models': { findActive: noop, useModels: () => ({ ready: false, providers: [] }) },
    '../renderer/src/redesign/ChatSurface': chatSurface, '../renderer/src/redesign/shell-common': { Avatar: noComponent },
    '../renderer/src/redesign/IconRail': { IconRail: (props) => { rail = props; return React.createElement(IconRail, props) } },
    '../renderer/src/redesign/Rail': { ThreadRow: ({ active, session }) => React.createElement('span', { 'data-active-chat': active && session.id }) },
    '../renderer/src/redesign/ComposerControls': { ComposerWorkspaceButton: noComponent, ComposerSendButton: noComponent,
      ComposerDraftInput: () => React.createElement('div', { 'data-chat-draft': draft.read(sid).body }) },
    '../renderer/src/redesign/ComposerQuoteBar': { ComposerQuoteBar: noComponent },
    '../renderer/src/features/chat/CodeClipboard': await load('renderer/src/features/chat/CodeClipboard.tsx'),
    './client-clipboard': await load('workbench/client-clipboard.ts'),
    './client-paste-feedback': { useClientPasteNotice: () => ({}), ClientPasteFeedback: noComponent },
    './client-shell-ui': { useClientShell: () => ({}), ClientFullscreenButton: noComponent },
    './conversation-selection-ui': { useConversationSelection: () => ({}), ConversationSelectionStatus: noComponent },
    './conversation-status-context': {}, './conversation-status-reads': { matchingReadEntry: noop },
    './conversation-status-transport': { createConversationStatusTransport: noop },
    './conversation-status-ui': { useConversationReadMap: () => ({}), ReadThreadRow: ({ children }) => children },
    './quote-draft': draftModule,
    '../renderer/src/redesign/composer-editor': { useComposerEditor: () => ({}) },
    '../renderer/src/redesign/ModelMenu': { modelGroups: () => [], ModelSelectButton: noComponent },
    '../renderer/src/redesign/resizable': resizing,
    './attachment-ui': { useAttachmentDrafts: noop }, './attachment-drafts': { readyAttachmentIds: () => [] },
    './chat-copy': chatCopy, './chat-transport': { createChatTransport: noop, inputBytes: (value) => value.length },
    './deliveries-controller': { eligibleDeliveryReplies: () => new Map() },
    './deliveries-ui': { useDeliveries: () => ({ view: { groups: [] } }) },
    './session-preferences': { projectSession: (row) => row },
    './session-workspace-ui': { useSessionWorkspace: () => ({ view: {} }), AttachedWorkspaceLabel: noComponent },
    './task-inspection-controller': { ...taskController, createTaskInspection: () => f.api },
    './task-inspection-transport': transport, './task-inspection-ui': taskUI, './use-text-workbench': { useTextWorkbench: () => wk }
  }, { window })
  const render = (bootstrap = bootWithTasks, locked = false) => renderToStaticMarkup(React.createElement(TextWorkbench, {
    bootstrap, locked, transport: {}, beforeWrite: noop, onExpired: noop, renderSettings: noComponent,
    notice: React.createElement('p', { id: 'auth-notice' }, 'Auth notice')
  }))
  const invalidCapability = render({ ...boot, capabilities: { taskInspection: 'true' } })
  assert.match(taskButton(invalidCapability), /disabled=""/)
  assert.doesNotMatch(invalidCapability, /workbench-tasks-toggle/)
  assert.match(taskButton(render(bootWithTasks, true)), /disabled=""/)
  rail.onTab('tasks')
  assert.deepEqual(f.calls, [])
  const original = render()
  assert.match(original, /<aside class="cf-rail"/)
  assert.match(original, /class="cf-conv__head"/)
  assert.match(original, /data-active-chat="retained-chat"/)
  assert.match(original, /data-chat-draft="retained draft"/)
  assert.doesNotMatch(original, /workbench-tasks-panel/)
  assert.equal(rail.listCollapsed, false)
  assert.deepEqual(f.calls, [])
  rail.onTab('tasks')
  let opened = render()
  assert.equal(rail.tab, 'tasks')
  assert.match(opened, /class="cf-body wb-chat__body--tasks"/)
  assert.match(opened, /<nav class="cf-iconrail">.*data-testid="workbench-tasks-toggle".*<\/nav><main class="wb-tasks__main">/)
  assert.equal(opened.match(/data-testid="workbench-tasks-toggle"/g).length, 1)
  assert.match(opened, /class="wb-tasks__main"><p id="auth-notice">Auth notice<\/p>/)
  const panelId = taskButton(opened).match(/aria-controls="([^"]+)"/)[1]
  assert.ok(opened.includes(`<section id="${panelId}" class="wb-tasks" data-testid="workbench-tasks-panel"`))
  assert.doesNotMatch(opened, /<aside|cf-resizer--x|cf-conv__head|wb-chat__title|wb-chat__scope|data-chat-draft/)
  assert.deepEqual(f.calls.map(({ method }) => method), ['list'])
  window.innerWidth = 570
  opened = render()
  assert.match(opened, /<main class="wb-tasks__main">/)
  assert.doesNotMatch(opened, /<aside|cf-conv__head/)
  window.innerWidth = 1200
  rail.onTab('chats')
  const restored = render()
  assert.equal(rail.tab, 'chats')
  assert.equal(rail.listCollapsed, false)
  assert.match(restored, /<aside class="cf-rail"/)
  assert.match(restored, /data-active-chat="retained-chat"/)
  assert.match(restored, /data-chat-draft="retained draft"/)
  assert.doesNotMatch(restored, /workbench-tasks-panel/)
  assert.deepEqual(selectCalls, [])
  assert.deepEqual(draft.read(sid), { body: 'retained draft', quote: '' })
  assert.equal(f.calls[0].signal.aborted, true)
  pending.resolve(list())
  await Promise.resolve()
  assert.deepEqual(f.api.snapshot(), { open: false })
})

test('exact capability and wire receipts; paths, methods, bodies and CSRF are scoped', async () => {
  const signal = new AbortController().signal
  const steps = [
    ['GET', '/bootstrap', undefined, { ...boot, capabilities: { taskInspection: 'true' } }],
    ['GET', '/bootstrap', undefined, { ...boot, capabilities: { taskInspection: true } }],
    ['GET', '/tasks', undefined, list([{ ...summary(), prompt: 'ignored in the list', other: '/private/path' }])],
    ['GET', `/tasks/${a}`, undefined, detail()],
    ['POST', '/tasks/preview', input, preview],
    ['POST', '/tasks/preview', { schedule: once, locale: 'zh-CN', allowPast: true }, { ok: true, description: '已过去', nextRunAt: null }],
    ['PATCH', `/tasks/${a}/status`, { revision, status: 'paused' }, detail(task(a, { status: 'paused', pauseAllowed: false }), newer)]
  ]
  const root = createTransport(async (url, init) => {
    const [method, path, body, data] = steps.shift()
    assert.equal(url, `/api/v1${path}`)
    assert.equal(init.method, method)
    assert.deepEqual(init.body ? JSON.parse(init.body) : undefined, body)
    assert.equal(init.cache, 'no-store')
    assert.equal(init.credentials, 'same-origin')
    assert.equal(init.redirect, 'error')
    if (path !== '/bootstrap') assert.equal(init.signal, signal)
    if (method === 'GET') assert.equal(init.headers['x-deva-csrf'], undefined)
    else {
      assert.equal(init.headers['x-deva-csrf'], boot.csrf)
      assert.equal(init.headers['content-type'], 'application/json')
      assert.equal(init.referrerPolicy, 'same-origin')
    }
    return json(data)
  })
  assert.equal((await root.inspect()).bootstrap.capabilities?.taskInspection, undefined)
  assert.equal((await root.inspect()).bootstrap.capabilities?.taskInspection, true)
  const api = createTaskInspectionTransport(root, boot.csrf)
  assert.deepEqual(await api.list(signal), list([summary()]))
  assert.deepEqual(await api.detail(a, signal), detail())
  assert.deepEqual(await api.preview({ ...input, schedule: { ...recurring, at: 'discarded', prompt: 'private' } }, signal), preview)
  assert.deepEqual(await api.preview({ schedule: { ...once, cron: 'discarded' }, locale: 'zh-CN', allowPast: true }, signal),
    { ok: true, description: '已过去', nextRunAt: null })
  await api.pause(a, revision, signal)
  assert.deepEqual(steps, [])
})

test('rejects malformed receipt, mismatched detail and unsafe IDs with no route injection', async () => {
  const responses = [list([summary(), summary()]), { ...list(), revision: 'not-a-revision' }, { ...list(), execution: 'active' },
    detail(task(b)), detail(task(a, { runs: [{ firedAt: now, status: 'running' }] })), { ok: false, error: 'invalid-cron' },
    { ok: false, error: '<script>bad</script>' }]
  const api = createTaskInspectionTransport(createTransport(async () => json(responses.shift())), boot.csrf)
  const signal = new AbortController().signal
  const bad = /Invalid task inspection receipt/
  for (const id of ['..', 'a/b', `${a}?x=secret`, `${a}\n`, `${a}#hash`, '%2f']) await assert.rejects(api.detail(id, signal), bad)
  await assert.rejects(api.pause(a, 'bad', signal), bad)
  assert.equal(responses.length, 7)
  for (let i = 0; i < 3; i++) await assert.rejects(api.list(signal), bad)
  for (let i = 0; i < 2; i++) await assert.rejects(api.detail(a, signal), bad)
  assert.deepEqual(await api.preview(input, signal), { ok: false, error: 'invalid-cron' })
  await assert.rejects(api.preview(input, signal), bad)
  assert.deepEqual(responses, [])
})

test('only an open panel reads summaries; selection and preview are explicit and independent', async () => {
  const { api, calls } = fixture()
  await api.refresh()
  await api.select(a)
  await api.preview(input)
  api.askPause()
  await api.confirmPause()
  assert.deepEqual(calls, [])
  await api.open()
  assert.deepEqual(calls.map(({ method }) => method), ['list'])
  assert.equal(api.snapshot().detail, undefined)
  await api.preview(input)
  assert.equal(api.snapshot().preview.data.description, preview.description)
  await api.select(a)
  assert.equal(api.snapshot().preview, undefined)
  assert.deepEqual(api.snapshot().detail.data, detail())
  await api.refresh()
  assert.deepEqual(calls.map(({ method }) => method), ['list', 'preview', 'detail', 'list', 'detail'])
})

test('close, switch and draft changes abort stale reads, and only current 401 expires the session', async () => {
  const oldRead = deferred(), oldPreview = deferred(), pendingRead = deferred()
  let reads = 0
  const f = fixture({ detail: (id) => id === a ? oldRead.promise : ++reads === 1 ? detail(task(b)) : pendingRead.promise,
    preview: () => oldPreview.promise })
  await f.api.open()
  const pendingA = f.api.select(a)
  await f.api.select(b)
  assert.equal(f.calls[1].signal.aborted, true)
  oldRead.reject(new HttpFailure(401, 'auth'))
  await pendingA
  assert.equal(f.expired(), 0)
  assert.equal(f.api.snapshot().detail.data.task.id, b)
  const calculating = f.api.preview(input)
  f.api.clearPreview()
  assert.equal(f.calls.at(-1).signal.aborted, true)
  oldPreview.resolve(preview)
  await calculating
  assert.equal(f.api.snapshot().preview, undefined)
  const refreshing = f.api.refresh()
  await Promise.resolve()
  assert.equal(f.calls.at(-1).method, 'detail')
  f.api.close()
  assert.equal(f.calls.at(-1).signal.aborted, true)
  pendingRead.resolve(detail(task(b)))
  await refreshing
  assert.deepEqual(f.api.snapshot(), { open: false })
  for (const route of ['list', 'detail', 'preview', 'pause']) {
    const fail = async () => { throw new HttpFailure(401, 'auth') }
    const f = fixture({ [route]: fail })
    await f.api.open()
    if (route === 'detail' || route === 'pause') await f.api.select(a)
    if (route === 'preview') await f.api.preview(input)
    if (route === 'pause') { f.api.askPause(); await f.api.confirmPause() }
    assert.equal(f.expired(), 1, route)
    assert.deepEqual(f.api.snapshot(), { open: false }, route)
  }
})

test('cancel has no write; conflict blocks retry until refresh and success uses fresh observations', async () => {
  let pauses = 0, savedStatus = 'active', savedRevision = revision
  const f = fixture({
    list: async () => ({ ...list([summary(a, { status: savedStatus })]), revision: savedRevision }),
    detail: async () => detail(task(a, { status: savedStatus, pauseAllowed: savedStatus === 'active' }), savedRevision),
    pause: async (id, expected) => {
      assert.equal(id, a)
      if (++pauses === 1) { assert.equal(expected, revision); savedRevision = newer; throw new HttpFailure(409, 'task_conflict') }
      assert.equal(expected, newer)
      savedStatus = 'paused'
    }
  })
  await f.api.open(); await f.api.select(a)
  await f.api.confirmPause()
  f.api.askPause()
  assert.equal(f.api.snapshot().confirming, true)
  f.api.cancelPause(); await f.api.confirmPause()
  assert.equal(pauses, 0)
  f.api.askPause(); await f.api.confirmPause()
  assert.equal(f.api.snapshot().statusIssue, 'conflict')
  f.api.askPause(); await f.api.confirmPause()
  assert.deepEqual(f.calls.map(({ method }) => method), ['list', 'detail', 'pause'])
  await f.api.refresh()
  assert.equal(f.api.snapshot().statusIssue, undefined)
  f.api.askPause(); await f.api.confirmPause()
  assert.deepEqual(f.calls.map(({ method }) => method), ['list', 'detail', 'pause', 'list', 'detail', 'pause', 'list', 'detail'])
  assert.equal(f.api.snapshot().detail.data.task.status, 'paused')
  assert.equal(f.api.snapshot().detail.data.task.nextRunAt, now)
  assert.equal(f.api.snapshot().list.data.tasks[0].status, 'paused')
  f.api.askPause(); await f.api.confirmPause()
  assert.equal(pauses, 2)
})

test('unsupported/corrupt and busy are distinct; leaving before queued pause sends nothing', async () => {
  for (const [code, status, label] of [['task_file_unsupported', 409, 'unsupported'], ['task_storage_unconfirmed', 503, 'unconfirmed'],
    ['task_state', 409, 'stateChanged'], ['task_busy', 429, 'busy']]) {
    const f = fixture({ pause: async () => { throw new HttpFailure(status, code) } })
    await f.api.open(); await f.api.select(a)
    f.api.askPause(); await f.api.confirmPause(); await f.api.confirmPause()
    assert.equal(f.api.snapshot().statusIssue, label)
    assert.equal(f.calls.filter(({ method }) => method === 'pause').length, 1)
  }
  const beforeWrite = deferred()
  const f = fixture({}, () => beforeWrite.promise)
  await f.api.open(); await f.api.select(a)
  f.api.askPause()
  const saving = f.api.confirmPause()
  f.api.close()
  beforeWrite.resolve()
  await saving
  assert.deepEqual(f.calls.map(({ method }) => method), ['list', 'detail'])
  assert.deepEqual(f.api.snapshot(), { open: false })
})

test('a sent pause abandoned on selection changes never adopts a late acknowledgment or retries', async () => {
  const ack = deferred()
  const f = fixture({ pause: () => ack.promise })
  await f.api.open(); await f.api.select(a)
  f.api.askPause(); const saving = f.api.confirmPause()
  await Promise.resolve()
  const patch = f.calls.at(-1)
  assert.equal(patch.method, 'pause')
  await f.api.select(b)
  assert.equal(patch.signal.aborted, true)
  ack.resolve()
  await saving
  assert.equal(f.api.snapshot().statusIssue, 'pauseUnconfirmed')
  assert.equal(f.api.snapshot().detail.data.task.id, b)
  assert.deepEqual(f.calls.map(({ method }) => method), ['list', 'detail', 'pause', 'detail'])
})

test('the Web rail shares Desktop ordering: soonest, newest tie-break, then null', async () => {
  const rows = [summary('never', { nextRunAt: null, createdAt: now + 100 }), summary('last', { nextRunAt: now + 5 }),
    summary('older', { nextRunAt: now }), summary('newer', { nextRunAt: now, createdAt: now + 1 })]
  const expected = ['newer', 'older', 'last', 'never']
  const f = fixture({ list: async () => list(rows) })
  await f.api.open()
  const html = renderToStaticMarkup(React.createElement(TaskInspectionPanel, { api: f.api, view: f.api.snapshot(), close: f.api.close, id: 'tasks' }))
  assert.deepEqual([...html.matchAll(/data-task-id="([^"]+)"/g)].map(([, id]) => id), expected)
  assert.deepEqual([...rows].sort(parts.compareTaskRows).map(({ id }) => id), expected)
  assert.deepEqual(f.api.snapshot().list.data.tasks.map(({ id }) => id), ['never', 'last', 'older', 'newer'])
})

test('real Desktop row, detail, history and schedule editor render ordinary escaped text and zone-correct times', async () => {
  const f = fixture()
  const render = (view = f.api.snapshot()) => renderToStaticMarkup(React.createElement(TaskInspectionPanel, { api: f.api, view, close: f.api.close, id: 'tasks' }))
  await f.api.open()
  let html = render()
  assert.match(html, /Server execution inactive; these are recorded desktop schedules/)
  assert.match(html, /class="cf-trow"[^>]*data-testid="workbench-task-row"/)
  assert.match(html, /Native &lt;img src=x&gt; schedule/)
  assert.doesNotMatch(html, /workbench-task-detail|&lt;script&gt;/)
  assert.match(html, /class="sched__row"/)
  assert.match(html, /data-testid="workbench-task-preview-zone"/)
  assert.match(html, /data-testid="workbench-task-preview-allow-past"/)
  assert.deepEqual(f.calls.map(({ method }) => method), ['list'])
  await f.api.select(a)
  html = render()
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;\n\*\*plain\*\*/)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.match(html, /<time dateTime="2031-07-01T17:13:00.000Z">[^<]*01:13:00 PM EDT \[America\/New_York\]/)
  assert.match(html, /Saved next-run time/)
  assert.match(html, /workbench-task-pause/)
  assert.doesNotMatch(html, /workbench-task-pause-confirm|<script>|>Run now<|>Resume<|>Create task<|>Delete</i)
  f.api.askPause()
  assert.match(render(), /workbench-task-pause-confirm/)
  f.api.cancelPause()
  await f.api.preview(input)
  assert.match(render(), /workbench-task-preview-result.*Schedule calculation &lt;b&gt;only&lt;\/b&gt;/)
  assert.match(render(), /Calculated next occurrence: <time[^>]+>[^<]*\[UTC\]/)
  uiLocale = 'zh-CN'
  try { assert.match(render(), /IANA 时区/) } finally { uiLocale = 'en' }
  assert.match(render({ open: true, list: { data: list([]) } }), /No recorded desktop tasks/)
  assert.doesNotMatch(render({ open: true, list: { issue: 'unsupported' } }), /No recorded desktop tasks/)
  assert.equal(time.defaultPreviewSchedule('Asia/Shanghai', now).at, '2031-07-02T02:13')
  assert.equal(time.recordedScheduleText(once), '2031-07-01 13:13 [America/New_York]')
  assert.equal(desktopSchedule.parseRecur(recurring.cron).time, '13:17')
  const fields = (initial) => renderToStaticMarkup(React.createElement(editor.ScheduleEditor, { initial, tz: initial.tz, onChange: () => {} }))
  assert.match(fields(once), /type="date"[^>]*value="2031-07-01"/)
  assert.match(fields(once), /type="time"[^>]*value="13:13"/)
  assert.match(fields({ kind: 'recurring', cron: '17 13 1 JAN *', tz: 'UTC' }), /class="sched__ctl sched__cron"[^>]*value="17 13 1 JAN \*"/)
})
