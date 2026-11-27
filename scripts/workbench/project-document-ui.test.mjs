import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))
const ts = require('typescript')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const src = new URL('../../apps/desktop/src/workbench/', import.meta.url)
async function load(name, deps = {}) {
  const js = ts.transpileModule(await readFile(new URL(name, src), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', js)((key) => Object.hasOwn(deps, key) ? deps[key] : require(key), module, module.exports)
  return module.exports
}
const transport = await load('transport.ts')
const workspace = await load('workspace-files.ts', { './transport': transport })
const project = await load('project-document-transport.ts')
const controller = await load('project-document-controller.ts', { './transport': transport, './workspace-files': workspace, './project-document-transport': project })
const { createTransport, HttpFailure } = transport
const { createWorkspaceFiles, openWorkspaceProject } = workspace
const { createProjectDocumentTransport, DOCUMENT_TTL, documentValidation, InvalidDocumentReceipt } = project
const { createProjectDocuments } = controller

const a = `w_${'a'.repeat(32)}`, b = `w_${'b'.repeat(32)}`
const id = `di_${'1'.repeat(32)}`, id2 = `di_${'2'.repeat(32)}`, revision = `r_${'c'.repeat(64)}`
const docs = '资料', nested = `${docs}/子 文件夹`, name = '说明.MD', path = `${nested}/${name}`
const original = `${nested}/原文.txt`, rootFile = '根.txt'
const content = '\uFEFF第一行\r\n第二行\r\n', prior = 'Before creating', dirty = 'Kept <draft>'
const boot = { protocol: 1, version: '1.0.0', platform: 'linux', config: {}, csrf: 'owner', expiresAt: 1900000000000 }
const json = (result, status = 200) => new Response(JSON.stringify(result), { status })
const listed = (path, entries, writable = true) => ({ path, entries, writable })
const entry = (path, type = 'file') => ({ path, name: path.split('/').at(-1), type })
const text = (path, content, writable = true) => ({ kind: 'text', path, content, revision, writable })
const intent = (directory, name, next = id) => ({ id: next, path: directory ? `${directory}/${name}` : name, ttlMs: DOCUMENT_TTL })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

test('literal bootstrap and owner transport fix request bodies, receipt statuses and exact Unicode scope', async () => {
  const base = `/api/v1/workspaces/${a}/document-intents`
  const steps = [
    ['/api/v1/bootstrap', undefined, { ...boot, capabilities: { workspaceDocumentCreate: 'true' } }],
    ['/api/v1/bootstrap', undefined, { ...boot, capabilities: { workspaceFiles: true, workspaceDocumentCreate: true } }],
    [base, { directory: '', name }, intent('', name), 201],
    [`${base}/${id}/create`, { content: '' }, { created: true, path: name, revision, replayed: false }, 201],
    [`${base}/${id}/create`, { content }, { created: true, path, revision, replayed: true }, 200],
    [`${base}/${id}/status`, {}, { state: 'created', path, revision }],
    [`${base}/${id}/status`, {}, { state: 'prepared', path, revision: null }],
    [`${base}/${id}/status`, {}, { state: 'unconfirmed', path, revision: null }],
    [`${base}/${id}/cancel`, {}, { closed: true }]
  ]
  const api = createTransport(async (url, init) => {
    const [expected, body, response, status] = steps.shift()
    assert.equal(url, expected)
    assert.equal(init.credentials, 'same-origin')
    assert.equal(init.mode, 'same-origin')
    assert.equal(init.redirect, 'error')
    assert.equal(init.cache, 'no-store')
    assert.equal(init.method, body ? 'POST' : 'GET')
    assert.equal(init.headers['x-deva-csrf'], body ? boot.csrf : undefined)
    assert.equal(init.referrerPolicy, body ? 'same-origin' : 'no-referrer')
    assert.deepEqual(init.body && JSON.parse(init.body), body)
    assert.equal(init.keepalive, url.endsWith('/cancel') ? true : undefined)
    return json(response, status)
  })
  assert.equal((await api.inspect()).bootstrap.capabilities, undefined)
  assert.equal((await api.inspect()).bootstrap.capabilities.workspaceDocumentCreate, true)
  const wire = createProjectDocumentTransport(api, boot.csrf)
  assert.deepEqual(await wire.prepare(a, '', name), intent('', name))
  assert.deepEqual(await wire.create(a, id, name, ''), { path: name, revision, replayed: false })
  assert.deepEqual(await wire.create(a, id, path, content), { path, revision, replayed: true })
  for (const state of ['created', 'prepared', 'unconfirmed']) {
    assert.deepEqual(await wire.status(a, id, path), { state, path, revision: state === 'created' ? revision : null })
  }
  await wire.cancel(a, id)
  assert.deepEqual(steps, [])
})

test('malformed document paths, request shapes and cross-target or false receipts fail closed', async () => {
  const steps = [
    [intent(nested, name), 200], [{ ...intent(nested, name), path: name }, 201], [{ ...intent(nested, name), ttlMs: 1 }, 201],
    [{ ...intent(nested, name), id: `${id}/` }, 201],
    [{ created: true, path, revision, replayed: false }, 200], [{ created: true, path, revision, replayed: true }, 201],
    [{ created: true, path: name, revision, replayed: false }, 201], [{ created: true, path, revision: 'r_1', replayed: false }, 201],
    [{ state: 'created', path, revision: null }, 200], [{ state: 'prepared', path, revision }, 200],
    [{ state: 'unconfirmed', path: name, revision: null }, 200], [{ closed: 'true' }, 200]
  ]
  const wire = createProjectDocumentTransport(createTransport(async () => json(...steps.shift())), boot.csrf)
  for (const bad of ['../outside', '/host', 'C:\\host', 'x//y', 'x/../y', 'x/.hidden', 'x/stop\u202e']) await assert.rejects(wire.prepare(a, bad, name), /Invalid project document/)
  for (const bad of ['.foo.md', 'foo .txt', '../x.txt', 'tool.exe', '  a.md', '字'.repeat(67) + '.md']) await assert.rejects(wire.prepare(a, nested, bad), /Invalid project document/)
  await assert.rejects(wire.prepare(`${a}\n`, nested, name), /Invalid project document/)
  await assert.rejects(wire.cancel(a, `${id}\n`), /Invalid project document/)
  await assert.rejects(wire.create(a, id, `/outside/${name}`, content), /Invalid project document/)
  await assert.rejects(wire.create(a, id, path, '中'.repeat(700000)), /Invalid project document/)
  await assert.rejects(wire.create(a, id, path, '\u0000'), /Invalid project document/)
  for (let i = 0; i < 4; i++) await assert.rejects(wire.prepare(a, nested, name), (error) => error instanceof InvalidDocumentReceipt && error.id === (i < 3 ? id : undefined))
  for (let i = 0; i < 4; i++) await assert.rejects(wire.create(a, id, path, content), /Unexpected HTTP status|Invalid document intent/)
  for (let i = 0; i < 3; i++) await assert.rejects(wire.status(a, id, path), /Invalid document intent/)
  await assert.rejects(wire.cancel(a, id), /Invalid document intent/)
  assert.equal(documentValidation('写作😀.txt', ''), undefined)
  assert.equal(documentValidation(name, content), undefined)
  assert.deepEqual(steps, [])
})

function fixture(t, { writable = true, files = {}, mutations = {}, now } = {}) {
  const calls = []
  const written = new Map()
  const catalog = [{ id: a, name: '甲' }, { id: b, name: '乙' }]
  const branches = new Map([
    ['', [entry(docs, 'dir'), entry(rootFile)]], [docs, [entry(nested, 'dir'), entry(`${docs}/只读`, 'dir')]],
    [nested, [entry(original)]], [`${docs}/只读`, []]
  ])
  const parentOf = (path) => path.slice(0, Math.max(0, path.lastIndexOf('/')))
  const defaults = {
    projects: async () => catalog,
    list: async (wid, path) => listed(path, wid === a ? [...(branches.get(path) ?? []), ...[...written.keys()].filter(key => parentOf(key) === path).map(key => entry(key))] : [], writable && !path.endsWith('只读')),
    read: async (wid, path) => text(path, (wid === a ? written.get(path) : undefined) ?? prior, writable),
    save: async () => revision,
    prepare: async (_wid, dir, name) => intent(dir, name),
    create: async (_wid, _id, path, content) => { written.set(path, content); return { path, revision, replayed: false } },
    status: async (_wid, _id, path) => ({ state: 'created', path, revision }),
    cancel: async () => {}
  }
  const spy = overrides => Object.fromEntries(Object.entries({ ...defaults, ...overrides }).map(([key, method]) => [key, (...args) => {
    calls.push([key, ...args]); return method(...args)
  }]))
  const workbench = createWorkspaceFiles(spy(files))
  const documents = createProjectDocuments(workbench, spy(mutations), now)
  t.after(() => documents.setOpen(false))
  const select = async (wid = a) => { await workbench.loadProjects(); await workbench.select(wid) }
  const browse = async () => { await workbench.toggle(docs); await workbench.toggle(nested) }
  const stage = (patch = { name, content }) => { documents.begin(); documents.update(patch) }
  const route = method => calls.filter(([key]) => key === method).map(([, ...args]) => args)
  return { workbench, documents, written, branches, calls, select, browse, stage, route }
}

test('explicit folder reveal proves the same project, expands listed ancestors and preserves the original dirty file and save behavior', async t => {
  const f = fixture(t)
  await f.select()
  await f.browse()
  await f.workbench.openFile(original)
  f.workbench.edit(dirty)
  await f.workbench.toggle(docs)
  assert.equal(f.workbench.snapshot().expanded.has(docs), false)
  const start = f.calls.length
  assert.equal(await f.workbench.revealContainingFolder(), true)
  assert.equal(f.workbench.snapshot().folder, nested)
  assert.ok(f.workbench.snapshot().folderFocus > 0)
  assert.deepEqual([...f.workbench.snapshot().expanded].sort(), [docs, nested].sort())
  assert.deepEqual(f.calls.slice(start), [['list', a, ''], ['list', a, docs], ['list', a, nested]])
  assert.equal(f.workbench.snapshot().file.text, dirty)
  assert.equal(f.workbench.snapshot().file.path, original)
  assert.equal(f.workbench.canSave(), true)
  await f.workbench.save()
  assert.deepEqual(f.route('save'), [[a, original, dirty, revision]])
  assert.equal(await f.workbench.revealFolder(b, nested), false)
  assert.equal(await f.workbench.revealFolder(a, '/host/private'), false)
  assert.equal(await f.workbench.revealFolder(a, `${docs}/not-listed/child`), false)
  assert.equal(f.workbench.snapshot().folderIssue, 'missing')
  assert.equal(f.route('list').some(([, path]) => path.includes('not-listed') || path.startsWith('/')), false)

  const ro = fixture(t, { writable: false })
  await ro.select()
  await ro.workbench.openFile(original)
  assert.equal(await ro.workbench.revealContainingFolder(), true)
  assert.deepEqual(ro.route('list'), [[a, ''], [a, ''], [a, docs], [a, nested]])
  assert.equal(ro.workbench.snapshot().file.text, prior)
  assert.equal(ro.workbench.snapshot().writable, false)
  assert.equal(await openWorkspaceProject(ro.workbench, a, new AbortController().signal), true)
  assert.equal(ro.workbench.snapshot().folder, '')
  assert.equal(ro.workbench.snapshot().file.path, original)
  ro.documents.setOpen(true)
  assert.equal(ro.documents.snapshot().canNew, false)
})

test('directory choices use only visible confirmed writable branches and staged draft/cancel sends no writes', async t => {
  const f = fixture(t)
  assert.equal(f.documents.snapshot().canNew, false)
  await f.select()
  assert.equal(f.documents.snapshot().canNew, false)
  f.documents.setOpen(true)
  assert.deepEqual(f.documents.snapshot().folders, [''])
  f.stage({ name, content })
  assert.equal(f.documents.snapshot().draft.directory, '')
  assert.equal(f.documents.snapshot().preview, name)
  f.documents.update({ directory: nested })
  assert.equal(f.documents.snapshot().draft.directory, '')
  await f.browse()
  await f.workbench.toggle(`${docs}/只读`)
  assert.deepEqual(f.documents.snapshot().folders, ['', docs, nested])
  f.documents.update({ directory: nested })
  assert.equal(f.documents.snapshot().preview, path)
  f.documents.update({ content: '' })
  assert.equal(f.documents.snapshot().canReview, true)
  f.documents.dismiss(true)
  assert.equal(f.documents.snapshot().focus.target, 'return')
  assert.deepEqual(f.calls.filter(([key]) => !['list', 'projects'].includes(key)), [])
})

test('Review and Create are independently explicit, repeated events dispatch one create and readback opens only the verified file', async t => {
  const reply = deferred(), listedAfter = deferred()
  let f
  f = fixture(t, {
    files: { list: async (_wid, directory) => f.written.has(path) ? listedAfter.promise : listed(directory, f.branches.get(directory) ?? []) },
    mutations: { create: async (_wid, _intent, destination, content) => { await reply.promise; f.written.set(destination, content); return { path, revision, replayed: false } } }
  })
  await f.select(); await f.browse(); await f.workbench.openFile(original)
  f.workbench.edit(dirty)
  f.documents.setOpen(true)
  f.stage()
  assert.equal(f.documents.snapshot().draft.directory, nested)
  await f.documents.create()
  assert.deepEqual(f.route('create'), [])
  const reviewing = f.documents.prepare()
  await f.documents.prepare()
  await reviewing
  assert.equal(f.documents.snapshot().phase, 'prepared')
  assert.deepEqual(f.route('prepare'), [[a, nested, name]])
  assert.equal(f.documents.snapshot().focus.target, 'status')
  assert.equal(f.written.size, 0)
  const creating = f.documents.create()
  await f.documents.create()
  await f.documents.verify()
  assert.deepEqual(f.route('create'), [[a, id, path, content]])
  assert.deepEqual(f.route('status'), [])
  assert.equal(f.workbench.snapshot().blockedDocumentPaths.has(path), true)
  await f.workbench.openFile(path)
  assert.equal(f.workbench.snapshot().file.path, original)
  reply.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.documents.snapshot().phase, 'verifying')
  assert.equal(f.workbench.snapshot().file.text, dirty)
  listedAfter.resolve(listed(nested, [entry(original), entry(path)]))
  await creating
  assert.deepEqual(f.route('read'), [[a, original], [a, path]])
  assert.deepEqual(f.route('cancel'), [[a, id]])
  assert.equal(f.documents.snapshot().phase, 'saved')
  assert.equal(f.documents.snapshot().savedPath, path)
  assert.equal(f.workbench.snapshot().folder, nested)
  assert.equal(f.workbench.snapshot().file.saved, true)
  assert.equal(f.workbench.snapshot().file.text, content)
  assert.deepEqual(f.workbench.snapshot().drafts, [original])
  await f.workbench.openFile(original)
  assert.equal(f.documents.snapshot().savedPath, undefined)
  assert.equal(f.workbench.snapshot().file.text, dirty)
  await f.workbench.openFile(path)
  assert.equal(f.documents.snapshot().savedPath, undefined)
  assert.equal(f.workbench.snapshot().file.saved, true)
})

test('stale preparation, project switch, modified confirmation and expired check release only the original pins', async t => {
  const first = deferred()
  let time = 10, n = 0
  const f = fixture(t, { now: () => time, mutations: { prepare: async (_wid, dir, name) => ++n === 1 ? first.promise : intent(dir, name, id2) } })
  await f.select(); f.documents.setOpen(true); f.stage()
  const pending = f.documents.prepare()
  await f.workbench.select(b)
  first.resolve(intent('', name))
  await pending
  assert.deepEqual(f.route('cancel'), [[a, id]])
  assert.equal(f.documents.snapshot().draft, undefined)
  f.documents.begin()
  assert.equal(f.documents.snapshot().draft.name, '')
  await f.workbench.select(a)
  f.documents.begin()
  assert.equal(f.documents.snapshot().draft.content, content)
  await f.documents.prepare()
  f.documents.update({ content: `${content}more` })
  await f.documents.create()
  assert.deepEqual(f.route('cancel'), [[a, id], [a, id2]])
  await f.documents.prepare()
  time += DOCUMENT_TTL
  await f.documents.create()
  assert.equal(f.documents.snapshot().issue, 'missing')
  assert.deepEqual(f.route('cancel'), [[a, id], [a, id2], [a, id2]])
  assert.deepEqual(f.route('create'), [])
})

test('an ambiguous mutation requires explicit status and exact readback; a mismatched file stays unavailable to the editor', async t => {
  let f, actual = 'A different file', checks = 0
  f = fixture(t, {
    files: { read: async (_wid, path) => text(path, path === original ? prior : actual) },
    mutations: {
      create: async (_wid, _id, path, content) => { f.written.set(path, content); throw new TypeError('Lost acknowledgement') },
      status: async () => { checks++; return { state: 'created', path, revision } }
    }
  })
  await f.select(); await f.browse(); await f.workbench.openFile(original)
  f.documents.setOpen(true); f.stage(); await f.documents.prepare(); await f.documents.create()
  assert.equal(f.documents.snapshot().canVerify, true)
  assert.equal(f.documents.snapshot().phase, 'unconfirmed')
  await f.documents.create()
  assert.deepEqual(f.route('status'), [])
  assert.equal(f.route('create').length, 1)
  assert.equal(f.route('read').length, 1)
  const checking = f.documents.verify()
  await f.documents.verify()
  await checking
  assert.equal(checks, 1)
  assert.equal(f.documents.snapshot().phase, 'unconfirmed')
  assert.equal(f.documents.snapshot().draft.content, content)
  await f.workbench.openFile(path)
  assert.equal(f.workbench.snapshot().file.path, original)
  actual = content
  await f.documents.verify()
  assert.equal(f.documents.snapshot().phase, 'saved')
  assert.equal(f.workbench.snapshot().file.path, path)
  assert.equal(f.route('create').length, 1)
  assert.deepEqual(f.route('status'), [[a, id, path], [a, id, path]])
})

test('acknowledged conflicts and expiry are distinct, and status reporting prepared retires the original intent without retrying', async t => {
  const errors = [[409, 'document_exists', 'exists'], [409, 'document_changed', 'changed'], [409, 'document_conflict', 'conflict'],
    [403, 'document_read_only', 'readonly'], [422, 'document_restricted', 'restricted'], [413, 'document_limit', 'limit'],
    [404, 'document_intent_missing', 'missing'], [401, 'auth', 'expired']]
  for (const [status, code, issue] of errors) {
    const f = fixture(t, { mutations: { create: async () => { throw new HttpFailure(status, code) } } })
    await f.select(); f.documents.setOpen(true); f.stage(); await f.documents.prepare(); await f.documents.create()
    assert.equal(f.documents.snapshot().issue, issue)
    assert.equal(f.documents.snapshot().draft.content, content)
    assert.equal(f.documents.snapshot().canCreate, false)
    assert.equal(f.documents.snapshot().canVerify, false)
    assert.deepEqual(f.route('read'), [])
    assert.deepEqual(f.route('cancel'), [[a, id]])
  }
  const lost = fixture(t, { mutations: {
    create: async () => { throw new HttpFailure(503, 'document_unconfirmed') },
    status: async () => ({ state: 'prepared', path: name, revision: null })
  } })
  await lost.select(); lost.documents.setOpen(true); lost.stage(); await lost.documents.prepare(); await lost.documents.create()
  assert.equal(lost.documents.snapshot().canVerify, true)
  await lost.documents.verify()
  await lost.documents.create()
  assert.equal(lost.documents.snapshot().issue, 'notCreated')
  assert.equal(lost.documents.snapshot().canReview, true)
  assert.deepEqual(lost.route('create'), [[a, id, name, content]])
  assert.deepEqual(lost.route('cancel'), [[a, id]])
})

test('fresh reveal does not focus cached directory data after an ancestor changes or the final list fails', async t => {
  let gone = false, denied = false
  const f = fixture(t, { files: { list: async (_wid, directory) => {
    if (gone && directory === docs) return listed(docs, [])
    if (denied && directory === nested) throw new HttpFailure(404, 'file_not_found')
    return listed(directory, f.branches.get(directory) ?? [])
  } } })
  await f.select(); await f.browse(); await f.workbench.openFile(original)
  f.workbench.edit(dirty)
  assert.equal(await f.workbench.revealContainingFolder(), true)
  const before = f.workbench.snapshot().folderFocus
  const at = f.calls.length
  denied = true
  assert.equal(await f.workbench.revealContainingFolder(), false)
  assert.deepEqual(f.calls.slice(at), [['list', a, ''], ['list', a, docs], ['list', a, nested]])
  assert.equal(f.workbench.snapshot().folder, undefined)
  assert.equal(f.workbench.snapshot().folderFocus, before)
  assert.equal(f.workbench.snapshot().directories.has(nested), false)
  assert.equal(f.workbench.snapshot().file.text, dirty)
  gone = true
  const after = f.calls.length
  assert.equal(await f.workbench.revealContainingFolder(), false)
  assert.deepEqual(f.calls.slice(after), [['list', a, ''], ['list', a, docs]])
  assert.equal(f.workbench.snapshot().folderFocus, before)
  assert.equal(f.workbench.snapshot().file.text, dirty)
})

test('a listed writable nested destination is eligible even when the project root is read-only', async t => {
  const f = fixture(t, { files: { list: async (_wid, directory) => listed(directory, f.branches.get(directory) ?? [], directory === nested) } })
  await f.select()
  f.documents.setOpen(true)
  assert.equal(f.documents.snapshot().canNew, false)
  await f.workbench.toggle(docs)
  assert.equal(f.documents.snapshot().canNew, false)
  await f.workbench.toggle(nested)
  assert.deepEqual(f.documents.snapshot().folders, [nested])
  assert.equal(f.documents.snapshot().canNew, true)
  f.stage()
  await f.documents.prepare()
  assert.deepEqual(f.route('prepare'), [[a, nested, name]])
})

test('an expired uncertain receipt preserves draft and cancellation releases normal browsing without retry', async t => {
  const f = fixture(t, { mutations: {
    create: async (_wid, _id, target) => { f.written.set(target, 'existing uncertain file'); throw new TypeError('Lost receipt') },
    status: async () => { throw new HttpFailure(404, 'document_intent_missing') }
  } })
  await f.select(); await f.browse(); await f.workbench.openFile(original)
  f.documents.setOpen(true); f.stage(); await f.documents.prepare(); await f.documents.create()
  await f.documents.verify()
  assert.equal(f.documents.snapshot().issue, 'missing')
  assert.equal(f.documents.snapshot().draft.content, content)
  assert.equal(f.documents.snapshot().canVerify, false)
  assert.equal(f.workbench.snapshot().blockedDocumentPaths.has(path), true)
  await f.documents.checkFolder()
  assert.equal(f.workbench.snapshot().folder, nested)
  await f.workbench.openFile(path)
  assert.equal(f.workbench.snapshot().file.path, original)
  f.documents.dismiss(true)
  assert.equal(f.workbench.snapshot().blockedDocumentPaths.has(path), false)
  await f.workbench.openFile(path)
  assert.equal(f.workbench.snapshot().file.text, 'existing uncertain file')
  assert.equal(f.workbench.snapshot().file.saved, undefined)
  f.documents.begin()
  assert.equal(f.documents.snapshot().draft.content, content)
  assert.equal(f.documents.snapshot().canReview, false)
  assert.deepEqual(f.route('create'), [[a, id, path, content]])
})

const documentUI = await load('project-document-ui.tsx', { './project-document.css': {} })
let locale = 'en'
const panel = await load('workspace-dialog.tsx', {
  '../renderer/src/i18n/i18n': { useI18n: () => ({ locale }) }, './workspace-dialog.css': {},
  './git-view-controller': {}, './git-view-panel': {}, './terminal-view-controller': {},
  './terminal-view-panel': { TerminalViewer: ({ children }) => children },
  './workspace-line-endings': await load('workspace-line-endings.ts'), './project-document-ui': documentUI
})
function render(workbench, documents, enabled = true) {
  const originalError = console.error
  console.error = (...args) => { if (!String(args[0]).includes('useLayoutEffect does nothing on the server')) originalError(...args) }
  try {
    return renderToStaticMarkup(React.createElement(panel.WorkspaceFilesPanel, {
      open: true, close() {}, controller: workbench, documents, documentActionsEnabled: enabled
    }))
  } finally { console.error = originalError }
}

function withTestId(element, id) {
  if (!React.isValidElement(element)) return
  if (element.props['data-testid'] === id) return element
  for (const child of React.Children.toArray(element.props.children)) {
    const found = withTestId(child, id)
    if (found) return found
  }
}

test('actual shared dialog renders the real folder row, bilingual draft and only trusted Review/Create events', async t => {
  const f = fixture(t)
  await f.select(); await f.browse(); await f.workbench.openFile(original)
  f.workbench.edit(dirty)
  await f.workbench.revealContainingFolder()
  f.documents.setOpen(true)
  locale = 'en'
  let markup = render(f.workbench, f.documents, false)
  assert.doesNotMatch(markup, /workbench-document-(new|draft)/)
  assert.match(markup, /workbench-folder-reveal[^>]*>Reveal containing folder</)
  assert.match(markup, /aria-current="location" data-testid="workbench-folder-active" data-path="资料\/子 文件夹"/)
  assert.match(markup, /workbench-folder-breadcrumb[^>]*>Current folder: <code>\/资料\/子 文件夹<\/code>/)
  assert.match(markup, /workbench-workspace-editor[^>]*>Kept &lt;draft&gt;<\/textarea>/)
  assert.match(render(f.workbench, f.documents), /workbench-document-new[^>]*>New document</)

  locale = 'zh-CN'
  f.stage()
  markup = render(f.workbench, f.documents)
  assert.equal([...markup.matchAll(/<dialog\b/g)].length, 1)
  assert.match(markup, /工作区文件/)
  assert.match(markup, /data-testid="workbench-document-draft"/)
  assert.match(markup, /<option value="">项目根目录 \(\/\)<\/option>/)
  assert.match(markup, /<option value="资料\/子 文件夹" selected="">\/资料\/子 文件夹<\/option>/)
  assert.match(markup, /目标路径: <code>\/资料\/子 文件夹\/说明.MD<\/code>/)
  assert.match(markup, /data-state="draft"/)
  assert.match(markup, /workbench-document-review[^>]*>核对目标</)
  assert.doesNotMatch(markup, /workbench-document-create/)
  assert.match(markup, /wb-document-pane" hidden="".*workbench-workspace-editor[^>]*>Kept &lt;draft&gt;<\/textarea>/s)

  const ui = (view, api) => documentUI.ProjectDocumentDraft({ view, api, locale })
  let clicks = 0
  let button = withTestId(ui(f.documents.snapshot(), { prepare: () => { clicks++ } }), 'workbench-document-review')
  button.props.onClick({ nativeEvent: { isTrusted: false } })
  button.props.onClick({ nativeEvent: { isTrusted: true } })
  assert.equal(clicks, 1)
  await f.documents.prepare()
  markup = render(f.workbench, f.documents)
  assert.match(markup, /data-state="prepared"[^>]*>目标已核对，文件尚未创建。/)
  assert.match(markup, /workbench-document-create[^>]*>创建文档</)
  assert.doesNotMatch(markup, /workbench-document-review/)
  button = withTestId(ui(f.documents.snapshot(), { create: () => { clicks++ } }), 'workbench-document-create')
  button.props.onClick({ nativeEvent: { isTrusted: false } })
  button.props.onClick({ nativeEvent: { isTrusted: true } })
  assert.equal(clicks, 2)

  f.documents.dismiss(true)
  await f.workbench.revealFolder(a, '')
  markup = render(f.workbench, f.documents)
  assert.match(markup, /data-testid="workbench-folder-active" data-path="" data-type="dir" aria-current="location"/)
  assert.match(markup, /workbench-folder-breadcrumb[^>]*>当前文件夹: <code>\/<\/code>/)
  assert.match(markup, /workbench-workspace-editor[^>]*>Kept &lt;draft&gt;<\/textarea>/)
  assert.doesNotMatch(markup, /data-testid="workbench-document-draft"/)
})
