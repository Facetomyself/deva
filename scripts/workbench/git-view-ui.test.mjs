import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))
const ts = require('typescript')
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
const gitTransport = await load('git-view-transport.ts')
const gitController = await load('git-view-controller.ts', { './transport': base, './git-view-transport': gitTransport })
const filesController = await load('workspace-files.ts', { './transport': base })
const { createTransport, HttpFailure } = base
const { createGitViewTransport } = gitTransport
const { bindWorkspaceGitView, createWorkspaceGitView } = gitController

const a = `w_${'a'.repeat(32)}`, b = `w_${'b'.repeat(32)}`, foreign = `w_${'c'.repeat(32)}`
const viewId = `v_${'1'.repeat(32)}`, nextViewId = `v_${'2'.repeat(32)}`, entryId = `e_${'3'.repeat(32)}`
const rel = 'docs/名字 <filename>.md'
const entry = { entryId, rel, staged: 'M', worktree: 'M', conflicted: false, diffSides: ['staged', 'worktree'] }
const head = { state: 'ready', branch: 'main', detached: false, unborn: false, limitations: ['tracked_only', 'upstream_unknown'] }
const status = (workspaceId = a, extra = {}) => ({ ...head, workspaceId, mergeInProgress: false, viewId, entries: [entry], ...extra })
const branches = { ...head, branches: [{ name: 'main', current: true, remote: null }, { name: 'origin/main', current: false, remote: 'origin' }] }
const oid = '0cb22ba9'.repeat(5)
const log = { state: 'ready', branch: 'main', commits: [{ oid, short: oid.slice(0, 7), subject: '<script>alert(1)</script>', timestamp: 1_701_234_567 }], traversal: 'first-parent', more: true, limitations: ['first_parent'] }
const diff = { state: 'ready', rel, side: 'worktree', lines: [{ type: 'hunk', text: '@@ -1,1 +1,2 @@' },
  { type: 'del', oldNo: 1, text: '<img src=x>' }, { type: 'add', newNo: 1, text: 'new <line>' }, { type: 'ctx', oldNo: 2, newNo: 2, text: 'ctx' }],
  truncated: true, limitations: ['git_limit'] }
const bootstrap = { protocol: 1, version: '1', platform: 'linux', config: {}, csrf: 'owner-csrf', expiresAt: 1_900_000_000_000 }
const json = (value, status = 200) => new Response(JSON.stringify(value), { status })
function deferred() {
  let resolve, reject
  const promise = new Promise((r, j) => { resolve = r; reject = j })
  return { promise, resolve, reject }
}

function fixture(overrides = {}) {
  const calls = []
  let expired = 0
  const requests = {
    status: async (id) => status(id), branches: async () => branches, log: async () => log,
    diff: async (_id, selection) => ({ ...diff, side: selection.side }), ...overrides
  }
  const transport = Object.fromEntries(Object.entries(requests).map(([method, run]) => [method, (...args) => {
    calls.push({ method, args, signal: args.at(-1) })
    return run(...args)
  }]))
  return { git: createWorkspaceGitView(transport, () => { expired++ }), calls, expired: () => expired }
}

test('strict bootstrap gating; each Git method uses the four same-origin POST projections only', async () => {
  const signal = new AbortController().signal
  const steps = [
    ['GET', '/bootstrap', undefined, { ...bootstrap, capabilities: { gitInspect: 'true', workspaceFiles: true } }],
    ['GET', '/bootstrap', undefined, { ...bootstrap, capabilities: { gitInspect: true, workspaceFiles: true } }],
    ['POST', `/workspaces/${a}/git/status`, {}, { ...status(), hostPath: '/host/hidden' }],
    ['POST', `/workspaces/${a}/git/branches`, {}, { ...branches, branches: branches.branches.map((branch) => ({ ...branch, upstream: 'hidden' })) }],
    ['POST', `/workspaces/${a}/git/log`, { limit: 20 }, log],
    ['POST', `/workspaces/${a}/git/diff`, { viewId, entryId, side: 'worktree' }, diff]
  ]
  const transport = createTransport(async (url, init) => {
    const [method, route, body, result] = steps.shift()
    assert.equal(url, `/api/v1${route}`)
    assert.equal(init.method, method)
    assert.deepEqual(init.body ? JSON.parse(init.body) : undefined, body)
    assert.equal(init.credentials, 'same-origin')
    assert.equal(init.mode, 'same-origin')
    assert.equal(init.redirect, 'error')
    assert.equal(init.cache, 'no-store')
    assert.equal(init.headers.accept, 'application/json')
    assert.ok(!url.includes(bootstrap.csrf))
    if (method === 'POST') {
      assert.equal(init.signal, signal)
      assert.equal(init.headers['x-deva-csrf'], bootstrap.csrf)
      assert.equal(init.headers['content-type'], 'application/json')
      assert.equal(init.referrerPolicy, 'same-origin')
      assert.equal(init.headers.origin, undefined) // Browser appends Origin, not script input.
    }
    return json(result)
  })
  assert.deepEqual((await transport.inspect()).bootstrap.capabilities, { workspaceFiles: true })
  assert.deepEqual((await transport.inspect()).bootstrap.capabilities, { workspaceFiles: true, gitInspect: true })
  const api = createGitViewTransport(transport, bootstrap.csrf)
  assert.deepEqual(await api.status(a, signal), status())
  assert.deepEqual(await api.branches(a, signal), branches)
  assert.deepEqual(await api.log(a, 20, signal), log)
  assert.deepEqual(await api.diff(a, { viewId, entryId, side: 'worktree', path: rel, ref: 'HEAD', oid, args: ['--all'] }, signal), diff)
  assert.deepEqual(steps, [])
})

test('transport rejects malformed scope, ids, pagination and cross-projection data', async () => {
  const signal = new AbortController().signal
  const responseQueue = [status(b), status(a, { viewId: 'host-file' }), status(a, { entries: [entry, entry] }),
    { ...log, traversal: 'all-parents' }, { ...log, commits: [{ ...log.commits[0], oid: 'a'.repeat(64) }] },
    { ...diff, side: 'staged' }, { ...diff, lines: [{ ...diff.lines[0], type: 'command' }] }]
  const api = createGitViewTransport(createTransport(async () => json(responseQueue.shift())), bootstrap.csrf)
  const error = /Invalid Git inspection/
  for (const value of ['other', '/x', `${a}\n`, `${a}?secret=x`, `${a}/../git`, `${a}%2f`, `${a}#hash`]) await assert.rejects(api.status(value, signal), error)
  for (const value of [0, -1, 1.5, 101, '20', undefined]) await assert.rejects(api.log(a, value, signal), error)
  for (const selection of [{ viewId: `${viewId}\n`, entryId, side: 'staged' }, { viewId, entryId: '../path', side: 'staged' }, { viewId, entryId, side: 'HEAD' }])
    await assert.rejects(api.diff(a, selection, signal), error)
  assert.equal(responseQueue.length, 7)
  for (let i = 0; i < 3; i++) await assert.rejects(api.status(a, signal), error)
  for (let i = 0; i < 2; i++) await assert.rejects(api.log(a, 20, signal), error)
  for (let i = 0; i < 2; i++) await assert.rejects(api.diff(a, { viewId, entryId, side: 'worktree' }, signal), error)
  assert.deepEqual(responseQueue, [])
})

test('the real workspace selector binds authorization without Git access on opening, selecting or locating files', async () => {
  const files = filesController.createWorkspaceFiles({
    projects: async () => [{ id: a, name: 'A' }, { id: b, name: 'B' }],
    list: async (_id, path) => ({ entries: path === '' ? [{ type: 'dir', path: 'docs', name: 'docs' }] :
      [{ type: 'file', path: rel, name: rel.split('/').at(-1) }], writable: false }),
    read: async () => ({ path: rel, kind: 'text', writable: false, content: 'A file', revision: 'old' })
  })
  const { git, calls } = fixture()
  const close = bindWorkspaceGitView(git, files)
  await git.open()
  await files.loadProjects()
  await files.select(foreign)
  assert.equal(git.snapshot().workspaceId, undefined)
  await files.select(a)
  assert.equal(git.snapshot().workspaceId, a)
  assert.deepEqual(calls, [])
  await git.open()
  assert.equal(git.snapshot().status.workspaceId, a)
  assert.equal(await files.reveal(a, rel, new AbortController().signal), true)
  await files.list('', true)
  await files.select(a)
  assert.deepEqual(calls.map(({ method }) => method), ['status'])
  assert.equal(await files.reveal(b, rel, new AbortController().signal), true)
  assert.equal(git.snapshot().open, false)
  assert.equal(git.snapshot().status, undefined)
  close()
  assert.equal(git.snapshot().workspaceId, undefined)
  assert.deepEqual(calls.map(({ method }) => method), ['status'])
})

test('each trusted control reads its own projection; the change list emits no Git reads of its own', async () => {
  const { git, calls } = fixture()
  git.selectWorkspace(a)
  await git.refresh()
  await git.branches()
  await git.history()
  await git.diff(entryId, 'staged')
  assert.deepEqual(calls, [])
  await git.open()
  await git.open()
  await git.branches()
  assert.deepEqual(git.snapshot().branches, branches)
  await git.history()
  await git.history(true)
  assert.equal(git.snapshot().limit, 40)
  await git.diff(entryId, 'staged') // Wrong tab; no request.
  git.changes()
  await git.diff(`e_${'f'.repeat(32)}`, 'worktree')
  await git.diff(entryId, 'HEAD')
  await git.diff(entryId, 'staged')
  assert.deepEqual(git.snapshot().diff, { ...diff, side: 'staged' })
  await git.diff(entryId, 'worktree')
  assert.deepEqual(git.snapshot().diff, diff)
  await git.refresh()
  assert.equal(git.snapshot().selection, undefined)
  assert.equal(git.snapshot().log, undefined)
  assert.deepEqual(calls.map(({ method, args }) => [method, ...args.slice(0, -1)]), [
    ['status', a], ['branches', a], ['log', a, 20], ['log', a, 40],
    ['diff', a, { viewId, entryId, side: 'staged' }], ['diff', a, { viewId, entryId, side: 'worktree' }], ['status', a]
  ])
  await git.history()
  for (let i = 0; i < 8; i++) await git.history(true)
  assert.deepEqual(calls.filter(({ method }) => method === 'log').slice(2).map(({ args }) => args[1]), [20, 40, 60, 80, 100])
})

test('switches, departure and latest views abort immediately and discard late data or auth errors', async () => {
  const old = deferred(), pendingBranches = deferred(), pendingDiff = deferred(), pendingLog = deferred()
  const f = fixture({ status: async (id) => id === a ? old.promise : status(b),
    branches: async () => pendingBranches.promise, diff: async () => pendingDiff.promise, log: async () => pendingLog.promise })
  f.git.selectWorkspace(a)
  const first = f.git.open()
  f.git.selectWorkspace(b)
  assert.equal(f.calls[0].signal.aborted, true)
  await f.git.open()
  old.resolve(status(a))
  await first
  assert.equal(f.git.snapshot().status.workspaceId, b)
  const readingBranches = f.git.branches()
  const readingLog = f.git.history()
  assert.equal(f.calls[2].signal.aborted, true)
  pendingBranches.reject(new HttpFailure(401, 'auth'))
  await readingBranches
  assert.equal(f.expired(), 0)
  assert.equal(f.git.snapshot().tab, 'history')
  pendingLog.resolve(log)
  await readingLog
  f.git.changes()
  const readingDiff = f.git.diff(entryId, 'worktree')
  f.git.selectWorkspace(undefined) // same reset as logout, capability/authority loss or modal departure
  assert.equal(f.calls.at(-1).signal.aborted, true)
  pendingDiff.resolve(diff)
  await readingDiff
  assert.equal(f.git.snapshot().workspaceId, undefined)
  assert.equal(f.git.snapshot().diff, undefined)
  assert.equal(f.git.snapshot().status, undefined)
  assert.equal(f.git.snapshot().open, false)
})

test('an expired view invalidates exact diff authority and only a manual refresh issues a new status request', async () => {
  let states = 0, diffs = 0
  const { git, calls } = fixture({ status: async () => status(a, { viewId: ++states === 1 ? viewId : nextViewId }),
    diff: async () => { if (++diffs === 1) throw new HttpFailure(409, 'git_stale'); return diff } })
  git.selectWorkspace(a)
  await git.open()
  await git.diff(entryId, 'worktree')
  assert.equal(git.snapshot().issue, 'stale')
  assert.equal(git.snapshot().diff, undefined)
  assert.equal(git.snapshot().status.viewId, null)
  await git.diff(entryId, 'worktree')
  await git.branches()
  assert.deepEqual(calls.map(({ method }) => method), ['status', 'diff'])
  await git.refresh()
  assert.equal(git.snapshot().issue, undefined)
  assert.equal(git.snapshot().diff, undefined)
  assert.deepEqual(calls.map(({ method }) => method), ['status', 'diff', 'status'])
  await git.diff(entryId, 'worktree')
  assert.equal(calls.at(-1).args[1].viewId, nextViewId)
  assert.deepEqual(git.snapshot().diff, diff)
})

test('origin, authentication, grant, repository conditions, resource limits and busy are distinct', async () => {
  for (const [statusCode, code, issue, expires] of [[401, 'auth', 'auth', 1], [403, 'origin', 'origin', 0], [403, 'csrf_failed', 'csrf', 0],
    [403, 'git_not_granted', 'not_granted', 0], [404, 'workspace_unavailable', 'workspace_unavailable', 0], [403, 'git_unsafe', 'unsafe', 0],
    [413, 'git_limit', 'budget', 0], [503, 'git_timeout', 'budget', 0], [409, 'git_busy', 'busy', 0],
    [422, 'unsupported_git_layout', 'unsupported_layout', 0], [422, 'git_corrupt', 'incomplete', 0], [503, 'git_unavailable', 'unavailable', 0]]) {
    const f = fixture({ diff: async () => { throw new HttpFailure(statusCode, code) } })
    f.git.selectWorkspace(a)
    await f.git.open()
    await f.git.diff(entryId, 'worktree')
    assert.equal(f.git.snapshot().issue, issue)
    assert.equal(f.expired(), expires)
    assert.equal(f.git.snapshot().diff, undefined)
    assert.equal(f.git.snapshot().status?.viewId, statusCode < 409 ? undefined : viewId)
    assert.deepEqual(f.calls.map(({ method }) => method), ['status', 'diff'])
  }
  for (const state of ['not_repo', 'unsupported_layout', 'unavailable']) {
    const { git, calls } = fixture({ status: async () => status(a, { state, entries: [], viewId: null }) })
    git.selectWorkspace(a)
    await git.open()
    assert.equal(git.snapshot().status.state, state)
    await git.branches()
    await git.history()
    await git.diff(entryId, 'staged')
    assert.deepEqual(calls.map(({ method }) => method), ['status'])
  }
})

const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const { WorkspaceGitPanel } = await load('git-view-panel.tsx', {
  '../renderer/src/i18n/i18n': { useI18n: () => ({ locale: 'en', t: (key) => key }) },
  '../renderer/src/redesign/GitBranchPill': await load('../renderer/src/redesign/GitBranchPill.tsx'),
  './git-view-copy': await load('git-view-copy.ts'), './git-view-controller': gitController, './git-view-transport': gitTransport,
  './git-view.css': {}
})
const render = (controller, workspaceId = a) => renderToStaticMarkup(React.createElement(WorkspaceGitPanel, { workspaceId, controller }))

test('the real panel renders scoped read-only text, repository states, and escaped desktop-style results', async () => {
  const { git } = fixture()
  git.selectWorkspace(a)
  assert.match(render(git), /class="cf-gitchip wb-git__toggle"/)
  assert.doesNotMatch(render(git), /workspace-git-panel/)
  assert.equal(render(git, b), '')
  await git.open()
  assert.match(render(git), /Git · Read-only.*SHA-1.*tracked changes only.*first parents.*local cache.*unknown/s)
  assert.match(render(git), new RegExp(`data-testid="workspace-git-entry-${entryId}"`))
  await git.branches()
  assert.match(render(git), /Cached locally/)
  assert.match(render(git), /aria-current="true".*main/s)
  await git.history()
  assert.match(render(git), /workspace-git-load-more/)
  assert.match(render(git), /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  git.changes()
  await git.diff(entryId, 'worktree')
  assert.match(render(git), /diffview__line (hunk|del|add|ctx)/)
  assert.match(render(git), /&lt;img src=x&gt;/)
  assert.match(render(git), /The diff was truncated/)
  assert.doesNotMatch(render(git), /<img src=x>|<script>/)
  for (const [state, limitations, copy] of [['ready', ['tracked_only', 'shallow'], /No tracked changes/],
    ['ready', ['excluded_paths', '/secret/path'], /incomplete/], ['partial', ['git_limit'], /incomplete/],
    ['not_repo', ['not_repo'], /not a Git repository/], ['unsupported_layout', [], /outside the supported scope/], ['unavailable', [], /unavailable/]]) {
    const { git } = fixture({ status: async () => status(a, { state, entries: [], viewId: null, limitations }) })
    git.selectWorkspace(a)
    await git.open()
    const html = render(git)
    assert.match(html, copy)
    assert.doesNotMatch(html, /\/secret\/path/)
    if (limitations[0] !== 'tracked_only') assert.doesNotMatch(html, /No tracked changes\./)
  }
})

test('the workbench mounts inside the authorized project selector and leaves chat/focus flows outside Git', async () => {
  const [entry, workspace, panel, desktop] = await Promise.all([
    'text-workbench.tsx', 'workspace-dialog.tsx', 'git-view-panel.tsx', '../renderer/src/redesign/GitWidget.tsx'
  ].map((name) => readFile(new URL(name, src), 'utf8')))
  assert.match(entry, /filesEnabled && bootstrap\.capabilities\?\.gitInspect === true/)
  assert.match(entry, /<WorkspaceFilesPanel[\s\S]*git=\{locked \? undefined : git\}/)
  assert.match(workspace, /open && git \? bindWorkspaceGitView\(git, controller\)/)
  assert.match(workspace, /workspace__project-picker[\s\S]*workbench-workspace-select[\s\S]*<WorkspaceGitPanel/)
  assert.match(desktop, /<GitBranchPill/)
  for (const selector of ['toggle', 'panel', 'status', 'refresh', 'branches', 'history', 'load-more', 'diff'])
    assert.ok(panel.includes(`data-testid="workspace-git-${selector}"`), selector)
  assert.doesNotMatch(panel, /useEffect|window\.deva|clipboard|dangerouslySetInnerHTML|location\.|\bfetch\(/)
  assert.match(panel, /event\.nativeEvent\.isTrusted/)
})
