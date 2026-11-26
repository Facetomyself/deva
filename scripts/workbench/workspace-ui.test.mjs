import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))
const ts = require('typescript')
const source = new URL('../../apps/desktop/src/workbench/', import.meta.url)
async function compiled(name, imports = {}) {
  let js = ts.transpileModule(await readFile(new URL(`${name}.ts`, source), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext }
  }).outputText
  for (const [from, to] of Object.entries(imports)) js = js.replaceAll(`'${from}'`, `'${to}'`)
  return `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
}
const transportUrl = await compiled('transport')
const { createTransport, HttpFailure } = await import(transportUrl)
const { createWorkspaceTransport } = await import(await compiled('workspace-transport'))
const { createWorkspaceFiles } = await import(await compiled('workspace-files', { './transport': transportUrl }))
const a = 'w_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const b = 'w_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const projects = [{ id: a, name: '项目 一' }, { id: b, name: '项目 二' }]
const folder = '中文 目录'
const file = '中文 文件.txt'
const nested = `${folder}/${file}`
const occurrence = (path, type = 'file') => ({ path, name: path.split('/').at(-1), type })
const listing = (entries, writable = true, path = '') => ({ path, entries, writable })
const doc = (path, content, revision = 'r1', writable = true) => ({ path, kind: 'text', content, revision, writable })
const json = (value, status = 200) => new Response(JSON.stringify(value), { status })
const deferred = () => {
  let resolve, reject
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

const bootstrap = { protocol: 1, version: '1.0.0', platform: 'linux', config: {}, csrf: 'owner-token', expiresAt: 1900000000000 }

test('workspaceFiles capability is explicit and owner fetch uses relative paths, body-only Unicode and CSRF', async () => {
  const steps = [
    ['GET', '/bootstrap', undefined, { ...bootstrap, capabilities: { workspaceFiles: 'true' } }],
    ['GET', '/bootstrap', undefined, { ...bootstrap, capabilities: { textChat: true, workspaceFiles: true } }],
    ['GET', '/workspaces', undefined, { workspaces: projects }],
    ['POST', `/workspaces/${a}/list`, { path: '' }, listing([occurrence(folder, 'dir')])],
    ['POST', `/workspaces/${a}/list`, { path: folder }, listing([occurrence(nested)], true, folder)],
    ['POST', `/workspaces/${a}/read`, { path: nested }, { path: nested, content: '你好', revision: 'r1', writable: true }],
    ['PUT', `/workspaces/${a}/file`, { path: nested, content: '另 中文', revision: 'r1' }, { ok: true, revision: 'r2' }],
    ['POST', `/workspaces/${b}/read`, { path: file }, { error: 'auth' }, 401]
  ]
  const base = createTransport(async (url, init) => {
    const [method, path, body, response, status] = steps.shift()
    assert.equal(url, `/api/v1${path}`)
    assert.equal(init.method, method)
    assert.deepEqual(init.body ? JSON.parse(init.body) : undefined, body)
    assert.equal(init.headers['x-deva-csrf'], method === 'GET' ? undefined : bootstrap.csrf)
    assert.equal(init.credentials, 'same-origin')
    assert.equal(init.mode, 'same-origin')
    return json(response, status)
  })
  assert.equal((await base.inspect()).bootstrap.capabilities, undefined)
  assert.deepEqual((await base.inspect()).bootstrap.capabilities, { textChat: true, workspaceFiles: true })
  const api = createWorkspaceTransport(base, bootstrap.csrf)
  assert.deepEqual(await api.projects(), projects)
  assert.deepEqual((await api.list(a, '')).entries, [occurrence(folder, 'dir')])
  assert.deepEqual((await api.list(a, folder)).entries, [occurrence(nested)])
  assert.deepEqual(await api.read(a, nested), doc(nested, '你好'))
  assert.equal(await api.save(a, nested, '另 中文', 'r1'), 'r2')
  await assert.rejects(api.read(b, file), { status: 401, code: 'auth' })
  assert.deepEqual(steps, [])
  for (const path of ['/tmp/file', 'C:\\temp\\file', 'C:/tmp/file', '../file', 'dir/../file', 'dir/./file', 'dir//child', 'dir/', '']) {
    await assert.rejects(api.read(a, path), /Invalid workspace/)
    await assert.rejects(api.save(a, path, '', 'r1'), /Invalid workspace/)
  }
  await assert.rejects(api.list('../host', ''), /Invalid workspace/)
})

test('rejects foreign or recursive list entries, mismatched reads and false save responses; read-only is the default', async () => {
  const steps = [
    { path: '', entries: [] },
    { path: file, content: 'only text', revision: 'r1' },
    { path: file, content: null, binary: true, revision: null, writable: false },
    { path: file, content: null, tooLarge: true, revision: null, writable: false },
    listing([occurrence(nested)]),
    listing([{ ...occurrence(file), path: `/host/${file}` }]),
    listing([], true, folder),
    { path: '/host/private', content: 'bad', revision: 'r1', writable: true },
    { ok: false, revision: 'r2' },
    { ok: true }
  ]
  const api = createWorkspaceTransport(createTransport(async () => json(steps.shift())), bootstrap.csrf)
  assert.equal((await api.list(a, '')).writable, false)
  assert.equal((await api.read(a, file)).writable, false)
  assert.deepEqual(await api.read(a, file), { path: file, kind: 'binary', writable: false })
  assert.deepEqual(await api.read(a, file), { path: file, kind: 'tooLarge', writable: false })
  for (let i = 0; i < 3; i++) await assert.rejects(api.list(a, ''), /Invalid workspace/)
  await assert.rejects(api.read(a, file), /Invalid workspace/)
  await assert.rejects(api.save(a, file, 'draft', 'r1'), /Invalid workspace/)
  await assert.rejects(api.save(a, file, 'draft', 'r1'), /Invalid workspace/)
  assert.deepEqual(steps, [])
})

function fake(overrides = {}) {
  const calls = []
  const methods = {
    projects: async () => projects,
    list: async (_id, path) => path ? listing([occurrence(nested)], true, path) : listing([occurrence(folder, 'dir'), occurrence(file), occurrence('other.txt')]),
    read: async (id, path) => doc(path, `${id}/${path}`),
    save: async () => 'r2', ...overrides
  }
  const api = createWorkspaceFiles(Object.fromEntries(Object.entries(methods).map(([key, method]) => [key, (...args) => {
    calls.push([key, ...args]); return method(...args)
  }])))
  return { api, calls }
}

test('only manual open enumerates projects; lazy directories list project-relative cwd, and pending reads cannot change selection', async () => {
  const late = deferred()
  const { api, calls } = fake({ read: (id, path) => id === a && path === nested ? late.promise : Promise.resolve(doc(path, id)) })
  assert.deepEqual(calls, [])
  await api.loadProjects()
  assert.deepEqual(calls, [['projects']])
  await api.select(a)
  assert.deepEqual(calls.at(-1), ['list', a, ''])
  await api.toggle(folder)
  assert.deepEqual(calls.at(-1), ['list', a, folder])
  await api.toggle(folder)
  await api.toggle(folder)
  assert.equal(calls.filter(([action, , path]) => action === 'list' && path === folder).length, 1)
  const pending = api.openFile(nested)
  await api.openFile(file)
  await api.select(b)
  await api.openFile(file)
  late.resolve(doc(nested, 'old read'))
  await pending
  assert.equal(api.snapshot().file.path, file)
  assert.equal(api.snapshot().file.text, b)
  assert.deepEqual(calls.slice(-4), [['read', a, nested], ['read', a, file], ['list', b, ''], ['read', b, file]])
})

test('out-of-order directory responses stay inside the selected project', async () => {
  const late = deferred()
  const { api } = fake({ list: (id, path) => id === a
    ? late.promise : Promise.resolve(listing([occurrence(file)], true, path)) })
  await api.loadProjects()
  const pending = api.select(a)
  await api.select(b)
  late.resolve(listing([occurrence('first-only.txt')]))
  await pending
  assert.equal(api.snapshot().projectId, b)
  assert.deepEqual(api.snapshot().directories.get('').data.entries, [occurrence(file)])
})

test('drafts stay separate across workspace switches; save receipt updates only the requested project/file and revision', async () => {
  const late = deferred()
  const { api, calls } = fake({ save: (id) => id === a ? late.promise : Promise.resolve('b-r2') })
  await api.loadProjects()
  await api.select(a)
  await api.openFile(file)
  api.edit('first draft')
  const saving = api.save()
  api.edit('edit while saving')
  await api.openFile('other.txt')
  assert.notEqual(api.snapshot().file.text, 'first draft')
  await api.select(b)
  await api.openFile(file)
  api.edit('second draft')
  late.resolve('a-r2')
  await saving
  assert.equal(api.snapshot().file.text, 'second draft')
  assert.equal(api.snapshot().file.disk.revision, 'r1')
  assert.equal(api.snapshot().dirty, true)
  await api.select(a)
  await api.openFile(file)
  assert.equal(api.snapshot().file.text, 'edit while saving')
  assert.equal(api.snapshot().file.disk.revision, 'a-r2')
  assert.equal(api.snapshot().file.disk.content, 'first draft')
  assert.equal(api.snapshot().dirty, true)
  assert.deepEqual(calls.filter(([action]) => action === 'save'), [['save', a, file, 'first draft', 'r1']])
})

test('conflict keeps the draft; explicit reload shows latest disk/text, and write resumes only after review', async () => {
  let disk = doc(file, 'original')
  const { api, calls } = fake({
    read: async () => disk,
    save: async (_id, _path, _content, revision) => {
      if (revision !== 'r2') throw new HttpFailure(409, 'conflict')
      return 'r3'
    }
  })
  await api.loadProjects()
  await api.select(a)
  await api.openFile(file)
  api.edit('my unsaved text')
  disk = doc(file, 'external change', 'r2')
  await api.save()
  assert.equal(api.snapshot().file.issue, 'conflict')
  assert.equal(api.snapshot().file.text, 'my unsaved text')
  assert.equal(api.snapshot().dirty, true)
  assert.equal(api.canSave(), false)
  assert.equal(calls.filter(([action]) => action === 'read').length, 1)
  await api.reload()
  assert.equal(api.snapshot().file.disk.content, 'external change')
  assert.equal(api.snapshot().file.text, 'my unsaved text')
  assert.equal(api.snapshot().file.review, true)
  assert.equal(api.canSave(), false)
  api.review(false)
  await api.save()
  assert.equal(api.snapshot().file.saved, true)
  assert.equal(api.snapshot().dirty, false)
  assert.deepEqual(calls.at(-1), ['save', a, file, 'my unsaved text', 'r2'])
})

test('expired owner session freezes requests and preserves drafts without reporting save success', async () => {
  const { api, calls } = fake({ save: async () => { throw new HttpFailure(401, 'auth') } })
  await api.loadProjects()
  await api.select(a)
  await api.openFile(file)
  api.edit('keep on expiry')
  await api.save()
  const count = calls.length
  assert.equal(api.snapshot().issue, 'expired')
  assert.equal(api.snapshot().file.text, 'keep on expiry')
  assert.equal(api.snapshot().dirty, true)
  assert.equal(api.canSave(), false)
  await api.reload()
  await api.save()
  await api.select(b)
  await api.select(a)
  assert.equal(calls.length, count)
  assert.equal(api.snapshot().file.text, 'keep on expiry')
})

test('a replaced workspace cannot send its drafts to a different project or reauthorize the same id', async () => {
  const lateSave = deferred()
  const { api, calls } = fake({ save: () => lateSave.promise })
  await api.loadProjects()
  await api.select(a)
  await api.openFile(file)
  api.edit('original grant draft')
  const pending = api.save()
  await api.select(b)
  await api.openFile(file)
  lateSave.reject(new HttpFailure(404, 'workspace_unavailable'))
  await pending
  assert.equal(api.snapshot().issue, undefined)
  assert.equal(api.snapshot().file.text, `${b}/${file}`)
  const before = calls.length
  await api.select(a)
  assert.equal(api.snapshot().issue, 'replaced')
  assert.equal(api.snapshot().directories.size, 0)
  assert.deepEqual(api.snapshot().drafts, [file])
  assert.equal(api.snapshot().file.text, 'original grant draft')
  assert.equal(api.canSave(), false)
  await api.reload()
  await api.save()
  assert.equal(calls.length, before)
})

test('read-only listing or file permission blocks mutation; a denied or failed save stays dirty', async () => {
  let mode = 'read-file'
  const { api, calls } = fake({
    list: async () => listing([occurrence(file)], mode !== 'read-tree'),
    read: async () => doc(file, 'baseline', 'r1', mode !== 'read-file'),
    save: async () => { throw mode === 'write-denied' ? new HttpFailure(403, 'workspace_read_only') : new Error('unconfirmed') }
  })
  await api.loadProjects()
  await api.select(a)
  await api.openFile(file)
  api.edit('blocked')
  assert.equal(api.snapshot().file.text, 'baseline')
  assert.equal(api.canSave(), false)
  mode = 'read-tree'
  await api.select(b)
  await api.openFile(file)
  assert.equal(api.snapshot().writable, false)
  await api.save()
  assert.equal(calls.filter(([action]) => action === 'save').length, 0)
  mode = 'broken'
  await api.select(a)
  await api.reload()
  api.edit('changed')
  await api.save()
  assert.equal(api.snapshot().file.issue, 'saveFailure')
  assert.equal(api.snapshot().file.saved, false)
  assert.equal(api.snapshot().dirty, true)
  mode = 'write-denied'
  await api.save()
  assert.equal(api.snapshot().file.issue, 'readonly')
  assert.equal(api.snapshot().writable, false)
  assert.equal(api.snapshot().dirty, true)
  assert.equal(api.snapshot().file.text, 'changed')
})
