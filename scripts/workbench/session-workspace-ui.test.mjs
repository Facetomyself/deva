import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))
const ts = require('typescript')
const src = new URL('../../apps/desktop/src/workbench/', import.meta.url)
async function load(name, dependencies = {}) {
  const text = await readFile(new URL(name, src), 'utf8')
  const js = ts.transpileModule(text, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX
  } }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', js)((id) => Object.hasOwn(dependencies, id) ? dependencies[id] : require(id), module, module.exports)
  return module.exports
}
const base = await load('transport.ts')
const chat = await load('chat-transport.ts')
const workspaceTransport = await load('session-workspace-transport.ts', { './transport': base, './chat-transport': chat })
const state = await load('session-workspace.ts', { './transport': base })
const ui = await load('session-workspace-ui.tsx', { './session-workspace': state, './session-workspace.css': {} })
const filesApi = await load('workspace-files.ts', { './transport': base })
const libraryApi = await load('library-transport.ts', { './transport': base, './chat-transport': chat })
const { createTransport, HttpFailure } = base
const { createSessionWorkspaceTransport } = workspaceTransport
const { createSessionWorkspace } = state
const { createWorkspaceFiles, openWorkspaceProject } = filesApi

const a = `w_${'a'.repeat(32)}`, b = `w_${'b'.repeat(32)}`
const r1 = '1'.repeat(64), r2 = '2'.repeat(64), r3 = '3'.repeat(64), r4 = '4'.repeat(64)
const projects = [{ id: a, name: 'Alpha' }, { id: b, name: 'Beta' }]
const bind = (id, revision, source = 'manual', available = true) => ({ revision, workspace: id ? {
  id, name: available ? projects.find((p) => p.id === id)?.name ?? null : null, state: available ? 'available' : 'unavailable', source
} : null })
const json = (value, status = 200) => new Response(JSON.stringify(value), { status })
const signal = () => new AbortController().signal
const tick = () => new Promise((resolve) => setImmediate(resolve))
const boot = { protocol: 1, version: '1', platform: 'linux', config: {}, csrf: 'owner-csrf', expiresAt: 1_900_000_000_000 }
const deferred = () => {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}

function fixture(initial, overrides = {}) {
  const records = new Map(Object.entries(initial))
  const calls = []
  let catalog = projects
  let expired = 0, commits = 0
  const api = {
    read(sid, signal) {
      calls.push({ method: 'read', sid, signal })
      return overrides.read ? overrides.read(sid, signal, records) : Promise.resolve(records.get(sid))
    },
    projects(signal) { calls.push({ method: 'projects', signal }); return Promise.resolve(catalog) },
    patch(sid, revision, id, signal) {
      calls.push({ method: 'patch', sid, revision, id, signal })
      if (overrides.patch) return overrides.patch(sid, revision, id, signal, records)
      const next = bind(id, r4)
      records.set(sid, next)
      return Promise.resolve(next)
    }
  }
  const ctl = createSessionWorkspace(api, { beforeWrite: overrides.beforeWrite ?? (async () => {}), expired: () => { expired++ }, committed: () => { commits++ } })
  return { ctl, view: ctl.snapshot, records, calls, setCatalog: (next) => { catalog = next }, expired: () => expired, commits: () => commits,
    observe: (sid, list, detail, writable = true) => { ctl.watch(sid, list, detail, writable); return tick() },
    reads: () => calls.filter(({ method }) => method === 'read').map(({ sid }) => sid), patches: () => calls.filter(({ method }) => method === 'patch') }
}

function element(node, id) {
  if (Array.isArray(node)) return node.map((item) => element(item, id)).find(Boolean)
  if (!node?.props) return undefined
  return node.props['data-testid'] === `workbench-session-workspace-${id}` ? node : element(node.props.children, id)
}
const controls = ({ ctl, view }, extra = {}) => ui.SessionWorkspaceControls({ controller: ctl, view: view(), locale: 'en', writable: true, ...extra })

test('literal bootstrap, active chat summary/detail revision, and same-origin workspace transport', async () => {
  const row = { id: 'first', title: 'First', updatedAt: 1, model: null, compatibility: 'text', writable: true, workspaceRevision: r1 }
  const detail = { cursor: { epoch: 'e', scope: 'chat:first', seq: 1, generation: 'g' }, state: { ...row,
    writeBlockReason: null, turnLimit: null, messages: [], active: null, lastTurn: null } }
  const pending = [
    ['GET', '/bootstrap', undefined, { ...boot, capabilities: { textChat: true, sessionWorkspaces: 'true' } }],
    ['GET', '/bootstrap', undefined, { ...boot, capabilities: { textChat: true, sessionWorkspaces: true } }],
    ['GET', '/chats', undefined, { sessions: [row] }],
    ['GET', '/chats/first', undefined, detail],
    ['GET', '/chats/first/workspace', undefined, { ...bind(a, r1, 'role'), workspace: { ...bind(a, r1, 'role').workspace, nativePath: '/private/path' } }],
    ['PATCH', '/chats/first/workspace', { revision: r1, workspaceId: b }, bind(b, r2)],
    ['PATCH', '/chats/first/workspace', { revision: r2, workspaceId: null }, bind(null, r3)],
    ['GET', '/workspaces', undefined, { workspaces: projects.map((p) => ({ ...p, root: '/private/path' })) }]
  ]
  const scoped = signal()
  const transport = createTransport(async (url, init) => {
    const [method, route, request, response] = pending.shift()
    assert.equal(url, `/api/v1${route}`)
    assert.equal(init.method, method)
    assert.equal(init.credentials, 'same-origin')
    assert.equal(init.mode, 'same-origin')
    assert.equal(init.redirect, 'error')
    assert.equal(init.cache, 'no-store')
    assert.equal(init.headers['x-deva-csrf'], method === 'PATCH' ? boot.csrf : undefined)
    assert.equal(init.headers['content-type'], method === 'PATCH' ? 'application/json' : undefined)
    assert.deepEqual(init.body ? JSON.parse(init.body) : undefined, request)
    if (route.endsWith('/workspace') || route === '/workspaces') {
      assert.equal(init.signal, scoped)
      assert.equal(init.referrerPolicy, 'same-origin')
      assert.equal(init.headers.origin, undefined)
    }
    return json(response)
  })
  assert.deepEqual((await transport.inspect()).bootstrap.capabilities, { textChat: true })
  assert.deepEqual((await transport.inspect()).bootstrap.capabilities, { textChat: true, sessionWorkspaces: true })
  const chats = chat.createChatTransport(transport, boot.csrf)
  const api = createSessionWorkspaceTransport(transport, boot.csrf)
  assert.equal((await chats.list())[0].workspaceRevision, r1)
  assert.equal((await chats.read('first')).state.workspaceRevision, r1)
  assert.deepEqual(await api.read('first', scoped), bind(a, r1, 'role'))
  assert.deepEqual(await api.patch('first', r1, b, scoped), bind(b, r2))
  assert.deepEqual(await api.patch('first', r2, null, scoped), bind(null, r3))
  assert.deepEqual(await api.projects(scoped), projects)
  assert.deepEqual(pending, [])
})

test('transport validates identifiers and does not trust mismatched acknowledgements', async () => {
  const invalid = [{source:'guessed'}, {state:'unavailable',name:'wrong label'}, {state:'available',name:null}, {name:'/host/path'}]
  const responses = [bind(b, 'invalid'), ...invalid.map(patch => ({ ...bind(b,r2), workspace: {...bind(b,r2).workspace,...patch} })), bind(a, r2), bind(b, r2)]
  const api = createSessionWorkspaceTransport(createTransport(async () => json(responses.shift())), boot.csrf)
  const scoped = signal()
  await assert.rejects(api.read('../first', scoped), /Invalid chat id/)
  for (const [rev, id] of [[r1, `${a}/list`], [r1, a.slice(0,-1)+'\n'], [`${r1}\n`, a], [r1, '/private/path']])
    await assert.rejects(api.patch('first', rev, id, scoped), /Invalid conversation workspace selection/)
  assert.equal(responses.length, invalid.length + 3)
  await assert.rejects(api.read('first', scoped), /Invalid conversation workspace revision/)
  for (const _ of invalid) await assert.rejects(api.read('first', scoped), /Invalid conversation workspace/)
  await assert.rejects(api.patch('first', r1, b, scoped), /change not confirmed/)
  await assert.rejects(api.patch('first', r1, null, scoped), /change not confirmed/)
})

test('selecting a candidate is a draft; writes are explicit and independent of the other conversation', async () => {
  const f = fixture({ first: bind(null, r1), second: bind(b, r2, 'role') })
  await f.observe(undefined)
  assert.equal(controls(f), null)
  assert.deepEqual(f.calls, [])
  await f.observe('first', r1)
  assert.equal(controls(f).props['data-state'], 'unbound')
  const select = element(controls(f), 'chooser')
  assert.equal(select.props['aria-label'], 'Project to attach')
  select.props.onChange({ currentTarget: { value: a } })
  assert.equal(f.view().draft.workspaceId, a)
  assert.deepEqual(f.patches(), [])
  assert.equal(f.view().access, undefined)
  assert.equal(ui.AttachedWorkspaceLabel({ view: f.view(), locale: 'en' }), null)
  element(controls(f), 'bind').props.onClick()
  await tick()
  assert.deepEqual(f.view().confirmed, bind(a, r4))
  assert.deepEqual(f.patches().map(({ sid, revision, id }) => [sid, revision, id]), [['first', r1, a]])
  await f.observe('second', r2)
  assert.deepEqual(f.view().confirmed, bind(b, r2, 'role'))
  assert.equal(f.view().draft, undefined)
  const label = ui.AttachedWorkspaceLabel({ view: f.view(), locale: 'en' })
  assert.equal(label.props['data-state'], 'available')
  assert.equal(label.props['data-source'], 'role')
  f.ctl.choose('second', a)
  assert.equal(await f.ctl.change('second'), true)
  element(controls(f), 'release').props.onClick()
  await tick()
  assert.deepEqual(f.view().confirmed, bind(null, r4))
  assert.deepEqual(f.records.get('first'), bind(a, r4))
  assert.equal(f.commits(), 3)
  assert.equal(f.view().access, undefined)
})

test('recheck only active changed hints; stale CAS, busy and permission failures require manual review', async () => {
  const failures = [new HttpFailure(409, 'workspace_conflict'), new HttpFailure(409, 'turn_in_progress'), new HttpFailure(403, 'origin')]
  const f = fixture({ first: bind(a, r1), second: bind(b, r2, 'role') }, {
    patch: async (_sid, revision, id) => { if (failures.length) throw failures.shift(); assert.equal(revision, r3); return bind(id, r4) }
  })
  await f.observe('first', r1)
  await f.observe('first', r1, r1)
  await f.observe('first', r1, r1, false)
  await f.observe('first', r1, r1, true)
  f.ctl.choose('first', b)
  assert.deepEqual(f.reads(), ['first'])
  assert.equal(await f.ctl.change('first'), false)
  assert.equal(f.view().issue, 'conflict')
  f.records.set('first', bind(a, r3))
  await f.observe('first', r3, r1)
  assert.deepEqual(f.reads(), ['first', 'first'])
  assert.equal(f.view().draft.revision, r1)
  assert.equal(element(controls(f), 'bind').props.disabled, true)
  assert.equal(await f.ctl.change('first'), false)
  assert.equal(f.patches().length, 1)
  for (const issue of ['busy', 'permission']) {
    element(controls(f), 'refresh').props.onClick()
    await tick()
    assert.deepEqual(f.view().draft, { revision: r3, workspaceId: b })
    assert.equal(await f.ctl.change('first'), false)
    assert.equal(f.view().issue, issue)
    assert.equal(f.view().needsReview, true)
  }
  await f.ctl.refresh('first')
  assert.equal(await f.ctl.change('first'), true)
  assert.equal(f.view().confirmed.workspace.id, b)
  assert.ok(f.reads().every((sid) => sid === 'first'))
})

test('no-mounted-catalogue fallback shows only actual lost binding and supports detach', async () => {
  const emptyCatalog = createSessionWorkspaceTransport(createTransport(async () => json({ error: 'not_found' }, 404)), boot.csrf)
  assert.deepEqual(await emptyCatalog.projects(signal()), [])
  const f = fixture({ first: bind(a, r1, 'manual', false), second: bind(null, r2) })
  f.setCatalog([])
  await f.observe('first', r1)
  assert.equal(controls(f).props['data-state'], 'unavailable')
  assert.equal(element(controls(f), 'chooser'), undefined)
  assert.equal(element(controls(f, { openNotes() {} }), 'open-notes'), undefined)
  assert.equal(element(controls(f), 'status').props['data-status'], 'unavailable')
  assert.equal(ui.AttachedWorkspaceLabel({ view: f.view(), locale: 'en', open() {} }).props['data-state'], 'unavailable')
  assert.equal(await f.ctl.change('first', true), true)
  assert.equal(controls(f), null)
  await f.observe('second', r2)
  assert.equal(controls(f), null)
})

test('write and approval completions from prior conversations or logout are ignored', async () => {
  const old = deferred(), pending = deferred()
  const f = fixture({ first: bind(a, r1), second: bind(b, r2, 'role') }, {
    read: (sid, _signal, records) => sid === 'first' && records.get('first').revision === r3 ? old.promise : Promise.resolve(records.get(sid)),
    patch: () => pending.promise
  })
  await f.observe('first', r1)
  f.ctl.choose('first', b)
  const write = f.ctl.change('first')
  await tick()
  await f.observe('second', r2)
  assert.equal(f.patches()[0].signal.aborted, true)
  pending.reject(new HttpFailure(401))
  assert.equal(await write, false)
  assert.equal(f.expired(), 0)
  assert.equal(f.commits(), 0)
  assert.equal(f.view().confirmed.workspace.id, b)
  await f.observe('first', r1)
  assert.equal(f.view().draft.workspaceId, b)
  assert.equal(f.view().needsReview, true)
  await f.ctl.refresh('first')
  f.records.set('first', bind(a, r3))
  const open = f.ctl.open('first', 'notes')
  f.ctl.pause()
  old.resolve(bind(a, r3))
  assert.equal(await open, false)
  assert.equal(f.view().sid, undefined)
  assert.equal(f.view().access, undefined)
})

test('notes are opened only by the explicit button and revoke on binding change', async () => {
  const f = fixture({ first: bind(a, r1), second: bind(b, r2, 'role') })
  await f.observe('first', r1)
  const notes = element(controls(f, { openNotes: () => void f.ctl.open('first', 'notes') }), 'open-notes')
  assert.equal(notes.props.children, 'Open project notes')
  assert.equal(f.view().access, undefined)
  assert.deepEqual(f.reads(), ['first'])
  notes.props.onClick()
  await tick()
  assert.deepEqual(f.reads(), ['first', 'first'])
  const previous = f.view().access
  assert.equal(previous.kind, 'notes')
  assert.equal(previous.workspace.id, a)
  f.records.set('first', bind(b, r3))
  await f.observe('first', r3, r1)
  assert.equal(previous.signal.aborted, true)
  assert.equal(f.view().access, undefined)
  assert.equal(f.view().issue, 'conflict')
  await f.ctl.refresh('first')
  f.records.set('first', bind(b, r3, 'manual', false))
  assert.equal(await f.ctl.open('first', 'notes'), false)
  assert.equal(f.view().confirmed.workspace.state, 'unavailable')
  assert.equal(f.view().access, undefined)
})

test('approved notes use only their own scope and skip requests queued after it is revoked', async () => {
  const paths = []
  let waiting = Promise.resolve()
  let response = () => json({ snapshot: { entries: [], used: 0, budget: 1, maxEntries: 2, maxTitle: 3, maxBody: 4 }, revision: r1 })
  const library = libraryApi.createLibrary(createTransport(async (url, init) => {
    paths.push([url, init.signal])
    return response()
  }), (_kind, op) => waiting.then(() => op(boot.csrf, r1)).then(({ value }) => value))
  const access = new AbortController()
  const scope = { kind: 'project', id: a, signal: access.signal }
  await library.memory(scope)
  assert.deepEqual(paths, [[`/api/v1/memory/project/${a}`, access.signal]])
  const deferredQueue = deferred()
  waiting = deferredQueue.promise
  const next = library.memory(scope)
  access.abort()
  deferredQueue.resolve()
  await assert.rejects(next, /Project view closed/)
  assert.equal(paths.length, 1)
  const deferredResponse = deferred(), second = new AbortController()
  response = () => deferredResponse.promise
  const late = library.memory({ kind: 'project', id: b, signal: second.signal })
  await tick()
  second.abort()
  deferredResponse.resolve(json({ error: 'auth' }, 401))
  await assert.rejects(late, (error) => !(error instanceof HttpFailure) && error.message === 'Project view closed')
})

test('explicit bound files select the right project only while the open is current', async () => {
  const catalogue = deferred(), alphaRoot = deferred()
  const reads = []
  const files = createWorkspaceFiles({ projects: () => catalogue.promise, list: async (id, path) => {
    reads.push([id, path]); return id === a ? alphaRoot.promise : { entries: [], writable: false, path }
  } })
  const f = fixture({ first: bind(a, r1), second: bind(b, r2, 'role') })
  await f.observe('first', r1)
  assert.equal(files.snapshot().projectId, '')
  const prepare = ({ workspace, signal }) => openWorkspaceProject(files, workspace.id, signal)
  const stale = f.ctl.open('first', 'files', prepare)
  await tick()
  await f.observe('second', r2)
  catalogue.resolve(projects)
  assert.equal(await stale, false)
  assert.deepEqual(reads, [])
  await f.observe('first', r1)
  const oldRoot = f.ctl.open('first', 'files', prepare)
  await tick()
  assert.equal(files.snapshot().projectId, a)
  await f.observe('second', r2)
  assert.equal(files.snapshot().projectId, '')
  assert.equal(await f.ctl.open('second', 'files', prepare), true)
  alphaRoot.reject(new HttpFailure(401))
  assert.equal(await oldRoot, false)
  assert.equal(files.snapshot().projectId, b)
  assert.equal(files.snapshot().issue, undefined)
  assert.equal(f.expired(), 0)
  assert.deepEqual(reads, [[a, ''], [b, '']])
  f.ctl.closeProject()
  assert.equal(files.snapshot().projectId, '')
})
