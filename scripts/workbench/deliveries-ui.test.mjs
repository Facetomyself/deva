import assert from 'node:assert/strict'
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
const baseUrl = await moduleUrl('transport')
const { createTransport, HttpFailure } = await import(baseUrl)
const { createDeliveriesTransport } = await import(await moduleUrl('deliveries-transport'))
const { createDeliveriesController, eligibleDeliveryReplies } = await import(await moduleUrl('deliveries-controller', { './transport': baseUrl }))
const { createWorkspaceFiles } = await import(await moduleUrl('workspace-files', { './transport': baseUrl }))

const sid = 'conversation-1', otherSid = 'conversation-2', turnId = 'c1bd28a0-7058-4b38-b451-21bdb710960c'
const gid = `d_${'1'.repeat(32)}`, otherGid = `d_${'2'.repeat(32)}`, replyGid = `d_${'3'.repeat(32)}`
const revision = 'a'.repeat(64), otherRevision = 'b'.repeat(64), workspaceId = `w_${'1'.repeat(32)}`
const bootstrap = { protocol: 1, version: '1.0.0', platform: 'linux', config: {}, csrf: 'owner-csrf', expiresAt: 1900000000000 }
const bytes = Buffer.from('现有回复\r\n- **text**\n', 'utf8')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')
const text = { index: 3, name: '回复.md', size: bytes.length, kind: 'text', status: 'ready', revision, canDownload: true, canPreview: false, canLocate: true }
const image = { ...text, index: 7, name: 'pixel.png', size: png.length, kind: 'image', canPreview: true }
const first = { id: gid, origin: 'desktop', items: [text, image] }
const second = { id: otherGid, origin: 'desktop', items: [{ ...text, index: 0, status: 'missing', size: null, revision: null, canDownload: false, canLocate: false }] }
const reply = { id: replyGid, origin: 'reply', turnId, messageIndex: 1, items: [{ ...text, index: 0, canLocate: false }] }
const replyText = { ...reply, id: `d_${'4'.repeat(32)}`, items: [{ ...reply.items[0], name: '回复.txt' }] }
const candidate = { turnId, messageIndex: 1 }
const ref = { gid, index: text.index, revision }
const imageRef = { ...ref, index: image.index }
const page = (groups = [first], candidates = [candidate], nextCursor = null) => ({ groups, candidates, nextCursor })
const location = { workspaceId, path: 'project/outputs/回复.md' }
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
const binary = (body, kind, headers = {}, status = 200) => new Response(body, { status, headers: {
  'content-type': kind === 'preview' ? 'image/png' : 'text/markdown; charset=utf-8',
  'content-length': String(body.length), 'content-disposition': `${kind === 'preview' ? 'inline' : 'attachment'}; filename="file.md"`,
  etag: `"${revision}"`, ...headers
} })
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const tick = () => new Promise((resolve) => setImmediate(resolve))

test('capability is strictly true; requests are same-origin, abortable, scoped to sid/revision and CSRF protected', async () => {
  const signal = new AbortController().signal
  const endpoint = `/chats/${sid}/deliveries`
  const calls = [
    ['GET', '/bootstrap', undefined, undefined, json({ ...bootstrap, capabilities: { deliveries: 'true' } })],
    ['GET', '/bootstrap', undefined, undefined, json({ ...bootstrap, capabilities: { deliveries: true } })],
    ['GET', endpoint, undefined, undefined, json(page([first], [candidate], 'Mg'))],
    ['GET', endpoint + '?cursor=Mg', undefined, undefined, json(page([second]))],
    ['POST', endpoint + '/reply', { turnId, format: 'md' }, undefined, json({ created: true, group: reply }, 201)],
    ['POST', endpoint + '/reply', { turnId, format: 'md' }, undefined, json({ created: false, group: reply })],
    ['POST', endpoint + '/reply', { turnId, format: 'txt' }, undefined, json({ created: true, group: replyText }, 201)],
    ['GET', `${endpoint}/${gid}/items/${text.index}/download`, undefined, `"${revision}"`, binary(bytes, 'download')],
    ['GET', `${endpoint}/${gid}/items/${image.index}/preview`, undefined, `"${revision}"`, binary(png, 'preview')],
    ['POST', `${endpoint}/${gid}/items/${text.index}/locate`, { revision }, undefined, json(location)]
  ]
  const base = createTransport(async (url, init) => {
    const [method, route, body, ifMatch, response] = calls.shift()
    assert.equal(url, `/api/v1${route}`)
    assert.equal(init.method, method)
    assert.equal(init.mode, 'same-origin')
    assert.equal(init.credentials, 'same-origin')
    assert.equal(init.redirect, 'error')
    assert.equal(init.cache, 'no-store')
    assert.equal(init.headers['if-match'], ifMatch)
    assert.equal(init.headers['x-deva-csrf'], body ? bootstrap.csrf : undefined)
    assert.deepEqual(init.body ? JSON.parse(init.body) : undefined, body)
    if (route !== '/bootstrap') assert.equal(init.signal, signal)
    return response
  })
  assert.equal((await base.inspect()).bootstrap.capabilities, undefined)
  assert.deepEqual((await base.inspect()).bootstrap.capabilities, { deliveries: true })
  const api = createDeliveriesTransport(base, bootstrap.csrf)
  assert.deepEqual(await api.list(sid, undefined, signal), page([first], [candidate], 'Mg'))
  assert.deepEqual(await api.list(sid, 'Mg', signal), page([second]))
  assert.deepEqual(await api.exportReply(sid, turnId, 'md', signal), { created: true, group: reply })
  assert.deepEqual(await api.exportReply(sid, turnId, 'md', signal), { created: false, group: reply })
  assert.deepEqual(await api.exportReply(sid, turnId, 'txt', signal), { created: true, group: replyText })
  const download = await api.download(sid, ref, text.size, signal)
  assert.equal(download.type, 'application/octet-stream')
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes)
  const preview = await api.preview(sid, imageRef, image.size, signal)
  assert.equal(preview.type, 'image/png')
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), png)
  assert.deepEqual(await api.locate(sid, ref, signal), location)
  assert.equal(calls.length, 0)
})

test('invalid aliases, forged metadata, unsafe locations and unauthenticated bytes never pass validation', async () => {
  const signal = new AbortController().signal
  const routes = []
  const responses = [
    json(page([{ ...first, id: '../forged' }])), json(page([{ ...first, items: [{ ...text, name: '/absolute/file' }] }])),
    json(page([{ ...first, items: [{ ...text, revision: null }] }])),
    json({ created: true, group: { ...reply, turnId: 'another-turn' } }, 201),
    json(location, 401), json({ error: 'delivery_changed' }, 409), json({ error: 'csrf_failed' }, 403),
    ...['/etc/passwd', '../escape', 'drive/C:/escape', 'https://host/x', '\\host\\shared', 'append/../elsewhere'].map((path) => json({ workspaceId, path })),
    json({ workspaceId: 'other', path: location.path }),
    binary(bytes, 'download', { etag: `"${otherRevision}"` }),
    binary(bytes, 'download', { 'content-disposition': 'inline' }),
    binary(bytes, 'download', { 'content-length': String(bytes.length + 1) }),
    binary(Buffer.concat([bytes, Buffer.from('x')]), 'download', { 'content-length': String(bytes.length) }),
    binary(png, 'preview', { 'content-type': 'image/svg+xml' }),
    binary(png, 'preview', { 'content-disposition': 'attachment' }),
    binary(Buffer.alloc(png.length, 0x78), 'preview')
  ]
  const api = createDeliveriesTransport(createTransport(async (url) => { routes.push(url); return responses.shift() }), bootstrap.csrf)
  const invalid = /Invalid delivery request or response/
  for (const alias of ['../other', '/other', '%2Fother', 'other\n', 'other?sid=3']) await assert.rejects(api.list(alias, undefined, signal), invalid)
  await assert.rejects(api.list(sid, '../other', signal), invalid)
  await assert.rejects(api.exportReply(sid, '../fake', 'md', signal), invalid)
  await assert.rejects(api.exportReply(sid, turnId, 'pdf', signal), invalid)
  for (const bad of [{ ...ref, gid: `${gid}\n` }, { ...ref, index: 20 }, { ...ref, revision: `"${revision}"` }]) {
    await assert.rejects(api.download(sid, bad, bytes.length, signal), invalid)
  }
  assert.equal(routes.length, 0)
  for (let i = 0; i < 3; i++) await assert.rejects(api.list(sid, undefined, signal), invalid)
  await assert.rejects(api.exportReply(sid, turnId, 'md', signal), invalid)
  await assert.rejects(api.download(sid, ref, bytes.length, signal), (e) => e instanceof HttpFailure && e.status === 401)
  await assert.rejects(api.download(sid, ref, bytes.length, signal), (e) => e.status === 409 && e.code === 'delivery_changed')
  await assert.rejects(api.locate(sid, ref, signal), (e) => e.status === 403 && e.code === 'csrf_failed')
  for (let i = 0; i < 7; i++) await assert.rejects(api.locate(sid, ref, signal), invalid)
  for (let i = 0; i < 4; i++) await assert.rejects(api.download(sid, ref, bytes.length, signal), invalid)
  for (let i = 0; i < 3; i++) await assert.rejects(api.preview(sid, imageRef, png.length, signal), invalid)
  assert.equal(responses.length, 0)
})

function controllerFixture(methods = {}, opts = {}) {
  const calls = [], urls = [], revoked = [], scheduled = new Set(), saved = [], copied = [], opened = []
  let expired = 0
  const api = Object.fromEntries(Object.entries({
    list: async () => page(), exportReply: async () => ({ created: true, group: reply }),
    download: async () => new Blob([bytes]), preview: async () => new Blob([png], { type: 'image/png' }), locate: async () => location,
    ...methods
  }).map(([name, fn]) => [name, (...args) => { calls.push([name, ...args]); return fn(...args) }]))
  const store = createDeliveriesController(api, {
    beforeWrite: async () => {}, expired: () => expired++,
    objectUrl: (blob) => { const url = `blob:fixture-${urls.length}`; urls.push([url, blob]); return url },
    revokeUrl: (url) => revoked.push(url), deferRelease: (fn) => { scheduled.add(fn); return () => scheduled.delete(fn) },
    saveDownload: (url, name) => saved.push([url, name]), copyName: async (name) => { copied.push(name) },
    openWorkspace: async (where, signal) => { opened.push([where, signal]); return true }, ...opts
  })
  return { store, calls, urls, revoked, scheduled, saved, copied, opened, expired: () => expired }
}

test('reentering reads persisted records; earlier sid results and expired auth responses cannot publish or save', async () => {
  const late = deferred(), lateDownload = deferred(), lateLocate = deferred()
  let counter = 0
  const f = controllerFixture({
    list: async (scope) => scope === sid && counter++ === 0 ? late.promise : page(scope === sid ? [first, reply] : [second]),
    download: async () => lateDownload.promise, locate: async () => lateLocate.promise
  })
  const { store } = f
  store.select(sid)
  const read = store.read('history:v1')
  const oldList = f.calls[0][3]
  store.select(otherSid)
  assert.equal(oldList.aborted, true)
  await store.read('history:v1')
  late.reject(new HttpFailure(401, 'auth'))
  await read
  assert.equal(f.expired(), 0)
  assert.deepEqual(store.snapshot().groups, [second])
  store.select(sid)
  await store.read('history:v2')
  assert.deepEqual(store.snapshot().groups, [first, reply])
  const download = store.runItem('download', gid, text.index)
  const oldDownload = f.calls.find(([action]) => action === 'download')[4]
  assert.deepEqual(f.calls.find(([action]) => action === 'download').slice(1, 3), [sid, ref])
  store.select(otherSid)
  assert.equal(oldDownload.aborted, true)
  lateDownload.resolve(new Blob([bytes]))
  await download
  assert.deepEqual(f.saved, [])
  assert.deepEqual(f.urls, [])
  store.select(sid)
  await store.read('ready')
  const locate = store.runItem('locate', gid, text.index)
  store.select(undefined)
  lateLocate.resolve(location)
  await locate
  assert.deepEqual(f.opened, [])
  assert.equal(store.snapshot().sid, undefined)
})

test('same-session revision replacement aborts old preview and clears URLs; valid locate and download use the original item index', async () => {
  const late = deferred()
  let version = 0, previewCalls = 0
  const refreshed = { ...first, items: [text, { ...image, revision: otherRevision }] }
  const f = controllerFixture({ list: async () => page([version ? refreshed : first]), preview: async () => previewCalls++ === 0 ? late.promise : new Blob([png]) })
  const { store } = f
  store.select(sid)
  await store.read('v1')
  const old = store.runItem('preview', gid, image.index)
  const oldPreviewCall = f.calls.find(([action]) => action === 'preview')
  assert.deepEqual(oldPreviewCall[2], imageRef)
  version++
  await store.read('v2')
  assert.equal(oldPreviewCall[4].aborted, true)
  late.resolve(new Blob([png]))
  await old
  assert.equal(store.snapshot().preview, undefined)
  assert.deepEqual(f.urls, [])
  await store.runItem('preview', gid, image.index)
  const preview = store.snapshot().preview
  assert.equal(preview.revision, otherRevision)
  store.closePreview(true, 'blob:obsolete')
  assert.equal(store.snapshot().preview, preview)
  store.closePreview()
  assert.deepEqual(f.revoked, [preview.url])
  await store.runItem('locate', gid, text.index)
  assert.deepEqual(f.opened[0][0], location)
  await store.runItem('download', gid, text.index)
  assert.deepEqual(f.saved, [['blob:fixture-1', text.name]])
  assert.equal(f.scheduled.size, 1)
  for (const release of f.scheduled) release()
  assert.deepEqual(f.revoked, [preview.url, 'blob:fixture-1'])
  assert.equal(f.scheduled.size, 0)
  await store.runItem('preview', gid, image.index)
  await store.runItem('download', gid, text.index)
  store.select(undefined)
  assert.deepEqual(f.revoked.slice(-2), ['blob:fixture-2', 'blob:fixture-3'])
  assert.equal(f.scheduled.size, 0)
})

test('authoritative candidates, idempotent exports, clipboard results, cursor resets and live permission failures', async () => {
  let created = true, reports = 0, expiredRead = false
  const f = controllerFixture({
    list: async (_sid, cursor) => {
      if (expiredRead) throw new HttpFailure(401, 'auth')
      if (cursor === 'Mw') throw new HttpFailure(409, 'deliveries_changed')
      return cursor === 'Mg' ? page([first, second], [candidate], 'Mw') : page([first], [candidate], 'Mg')
    },
    exportReply: async () => { const result = { created, group: reply }; created = false; return result }
  }, { copyName: async () => { if (!reports++) throw new Error('Clipboard not permitted') } })
  const { store } = f
  store.select(sid)
  await store.read('confirmed')
  await store.exportReply({ ...candidate, messageIndex: 2 }, 'md', 'confirmed')
  assert.equal(f.calls.filter(([action]) => action === 'exportReply').length, 0)
  assert.deepEqual(store.snapshot().feedback, { issue: 'notExportable' })
  await store.exportReply(candidate, 'md', 'confirmed')
  assert.deepEqual(store.snapshot().feedback, { success: 'created' })
  await store.exportReply(candidate, 'md', 'confirmed')
  assert.deepEqual(store.snapshot().feedback, { success: 'existing' })
  assert.equal(store.snapshot().groups.filter((group) => group.id === replyGid).length, 1)
  await store.runItem('copy', gid, text.index)
  assert.deepEqual(store.snapshot().feedback, { issue: 'clipboard' })
  await store.runItem('copy', gid, text.index)
  assert.deepEqual(store.snapshot().feedback, { success: 'copied' })
  await store.read('confirmed', true)
  assert.deepEqual(store.snapshot().groups, [first, reply, second])
  await store.read('confirmed', true)
  assert.deepEqual(store.snapshot().groups, [first])
  assert.equal(store.snapshot().issue, 'changed')
  assert.deepEqual(f.calls.filter(([action]) => action === 'list').map((call) => call[2]), [undefined, 'Mg', 'Mw', undefined])
  expiredRead = true
  await store.read('confirmed')
  assert.equal(f.expired(), 1)
  assert.equal(store.snapshot().issue, 'permission')
  assert.deepEqual(store.snapshot().groups, [])
  assert.deepEqual(store.snapshot().candidates, [])
  assert.equal(store.snapshot().nextCursor, null)
})

test('export controls use only the current server candidate on a completed, nonempty assistant message', () => {
  const state = { compatibility: 'text', messages: [{ role: 'user', content: 'request' }, { role: 'assistant', content: 'complete' }],
    active: null, lastTurn: { turnId, status: 'completed', reason: null } }
  const deliveries = { ...page([], [candidate]), sid, authority: 'confirmed' }
  assert.deepEqual([...eligibleDeliveryReplies(state, false, 'confirmed', deliveries)], [[1, candidate]])
  const none = (next = state, pending = false, authority = 'confirmed', view = deliveries) =>
    assert.equal(eligibleDeliveryReplies(next, pending, authority, view).size, 0)
  none({ ...state, compatibility: 'unsupported', messages: null })
  none({ ...state, active: { turnId, text: 'delta' } })
  none({ ...state, lastTurn: { ...state.lastTurn, reason: 'truncated' } })
  none({ ...state, lastTurn: { ...state.lastTurn, status: 'stopped' } })
  none({ ...state, messages: [...state.messages.slice(0, 1), { role: 'assistant', content: '\n ' }] })
  none(state, true)
  none(state, false, 'future')
  none(state, false, 'confirmed', { ...deliveries, loading: 'first' })
  none(state, false, 'confirmed', { ...deliveries, issue: 'permission' })
  none(state, false, 'confirmed', { ...deliveries, candidates: [{ ...candidate, messageIndex: 0 }] })
  none(state, false, 'confirmed', { ...deliveries, candidates: [{ ...candidate, messageIndex: 2 }] })
})

test('switching during beforeWrite prevents a queued export from reaching a prior sid', async () => {
  const preflight = deferred()
  const f = controllerFixture({}, { beforeWrite: () => preflight.promise })
  f.store.select(sid)
  await f.store.read('confirmed')
  const task = f.store.exportReply(candidate, 'md', 'confirmed')
  await tick()
  f.store.select(otherSid)
  preflight.resolve()
  await task
  assert.equal(f.calls.filter(([action]) => action === 'exportReply').length, 0)
  assert.equal(f.store.snapshot().feedback, undefined)
})

test('workspace locate uses the manual file panel tree and reads only the listed project-relative file', async () => {
  const reads = []
  const workspace = createWorkspaceFiles({
    projects: async () => [{ id: workspaceId, name: 'workspace' }],
    list: async (id, path) => {
      assert.equal(id, workspaceId)
      const entries = path === '' ? [{ name: 'project', path: 'project', type: 'dir' }] : path === 'project'
        ? [{ name: 'outputs', path: 'project/outputs', type: 'dir' }] : [{ name: text.name, path: location.path, type: 'file' }]
      return { path, entries, writable: false }
    },
    read: async (id, path) => { reads.push([id, path]); return { path, kind: 'text', content: 'current file', writable: false, revision } }
  })
  assert.equal(await workspace.reveal(workspaceId, location.path, new AbortController().signal), true)
  assert.deepEqual([...workspace.snapshot().expanded], ['project', 'project/outputs'])
  assert.equal(workspace.snapshot().file.path, location.path)
  assert.equal(await workspace.reveal(workspaceId, 'project/outputs/elsewhere', new AbortController().signal), false)
  assert.equal(await workspace.reveal(workspaceId, location.path, AbortSignal.abort()), false)
  assert.deepEqual(reads, [[workspaceId, location.path]])
})

test('both hosts mount the same card/file-row view; browser publishes stable download selectors', async () => {
  const renderer = new URL('../renderer/src/features/chat/', src)
  const desktop = await readFile(new URL('DeliverablesCard.tsx', renderer), 'utf8')
  const common = await readFile(new URL('DeliverablesView.tsx', renderer), 'utf8')
  const web = await readFile(new URL('deliveries-ui.tsx', src), 'utf8')
  assert.match(desktop, /from '\.\/DeliverablesView'/)
  assert.match(web, /from '..\/renderer\/src\/features\/chat\/DeliverablesView'/)
  assert.match(desktop, /<DeliverablesView/)
  assert.match(web, /<DeliverablesView/)
  assert.match(common, /data-testid="deliverables-file-row"/)
  assert.match(common, /data-testid="deliverables-card-toggle"/)
  assert.match(web, /id: 'download'/)
  assert.match(web, /data-testid="workbench-export-md"/)
  assert.match(web, /data-testid="workbench-export-txt"/)
})
