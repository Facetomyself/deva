import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))
const ts = require('typescript')
const src = new URL('../../apps/desktop/src/workbench/', import.meta.url)
const moduleUrl = async (name, imports = {}) => {
  const source = await readFile(new URL(`${name}.ts`, src), 'utf8')
  let js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  for (const [local, specifier] of Object.entries(imports)) js = js.replaceAll(`'./${local}'`, `'${specifier}'`)
  return `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
}
const transportUrl = await moduleUrl('transport')
const { createTransport, createSettingsBridge, HttpFailure } = await import(transportUrl)
const chatUrl = await moduleUrl('chat-transport')
const { createLibrary } = await import(await moduleUrl('library-transport', { transport: transportUrl, 'chat-transport': chatUrl }))
const { createChatTransport, parseChatFrame } = await import(chatUrl)

const session = { protocol: 1, version: '0.1.17', platform: 'linux', config: {}, csrf: 'fixture-csrf', expiresAt: 1900000000000, capabilities: { library: true, textChat: true } }
const oldConfig = { models: { providers: [] }, theme: 'light' }
const flags = { available: true, ids: [] }
const oldProfile = { avatar: '', avatarImage: '' }
const profileState = (profile, revision, imageRevision) => ({ profile, revision, imageRevision })
const shape = '{"shape":"circle"}'
const png = 'data:image/png;base64,aGVsbG8='
const role = { id: 'builder', name: 'Builder', description: '', model: '', avatar: '', prompt: '', workspaceId: '', workspaceName: '', enabled: true, protected: false, revision: 'role-0' }
const general = { ...role, id: 'general', name: 'General', protected: true }
const roster = (roles = [general, role], revision = 'order-0') => ({ roles, order: roles.map((item) => item.id), revision })
const blank = { entries: [], used: 0, budget: 2000, maxEntries: 100, maxTitle: 60, maxBody: 1500 }
const note = { id: 'user-1', type: 'user', title: 'Lunch preferences', body: 'Tuesdays', createdAt: 10, updatedAt: 10 }
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const settings = (revision, config = oldConfig) => ['GET /settings', { config, revision }]
const keys = ['GET /provider-keys', flags]

function fixture(steps, { bootstrap = false } = {}) {
  let cursor = 0
  const requests = []
  const failures = []
  const transport = createTransport(async (path, init) => {
    const step = steps[cursor++]
    const method = init.method
    const route = method + ' ' + path.replace(/^\/api\/v1/, '')
    const body = init.body === undefined ? undefined : JSON.parse(init.body)
    assert.equal(route, step?.[0])
    assert.equal(init.credentials, 'same-origin')
    assert.equal(init.mode, 'same-origin')
    assert.equal(init.redirect, 'error')
    assert.equal(init.cache, 'no-store')
    assert.equal(init.headers['x-deva-csrf'], method === 'GET' ? undefined : session.csrf)
    requests.push({ route, body })
    const value = typeof step[1] === 'function' ? await step[1](body) : step[1]
    return json(value, step[2])
  })
  const host = bootstrap ? undefined : createSettingsBridge({ transport, bootstrap: session, onFailure: (error) => failures.push(error), updateBrowserTheme() {} })
  return { transport, host, api: host && createLibrary(transport, host.libraryQueue), failures, requests, done: () => assert.equal(cursor, steps.length) }
}

test('library and text capabilities require literal true independently; role chat posts only the role ID', async () => {
  const personaId = 'Builder.Legacy_02'
  const summary = { id: 'ui-chat', personaId, title: '', writable: true, compatibility: 'text', model: 'provider:model', updatedAt: 2 }
  const f = fixture([
    ['GET /bootstrap', session], ['GET /bootstrap', { ...session, capabilities: { library: 'true', textChat: true } }],
    ['GET /bootstrap', { ...session, capabilities: { library: true, textChat: 1 } }],
    ['POST /chats', (body) => { assert.deepEqual(body, { sessionId: summary.id, personaId }); return { session: summary } }],
    ['GET /chats', { sessions: [summary] }]
  ], { bootstrap: true })
  const cap = async () => (await f.transport.inspect()).bootstrap.capabilities
  assert.deepEqual(await cap(), session.capabilities)
  assert.deepEqual(await cap(), { textChat: true })
  assert.deepEqual(await cap(), { library: true })
  const chat = createChatTransport(f.transport, session.csrf)
  for (const invalid of ['../desktop-path', 'Name..Legacy', 'Name.', 'CON.txt', 'General', 'constructor', 'Name\n']) {
    await assert.rejects(chat.create(summary.id, invalid), /Invalid role id/)
  }
  assert.deepEqual(await chat.create(summary.id, personaId), summary)
  const state = { ...summary, messages: [], active: null, lastTurn: null, writeBlockReason: null, turnLimit: 20 }
  const cursor = { epoch: 'epoch', scope: `chat:${summary.id}`, seq: 0, generation: 'generation' }
  assert.equal(parseChatFrame(JSON.stringify({ t: 'snapshot', cursor, state }), summary.id)?.state.personaId, personaId)
  assert.deepEqual(await chat.list(), [summary])
  f.done()
})

test('settings, avatar spec/image, role enable and later settings serialize on one authoritative revision queue', async () => {
  const enabled = { ...role, enabled: false, revision: 'role-1' }
  let finishAvatar
  let avatarStarted
  const seen = new Promise((resolve) => { avatarStarted = resolve })
  const waitAvatar = new Promise((resolve) => { finishAvatar = resolve })
  const f = fixture([
    settings('r0'), keys,
    ['PATCH /settings', { ok: true, revision: 'r1', config: { ...oldConfig, locale: 'en' } }],
    settings('r1', { locale: 'en', ...oldConfig }), ['GET /profile', profileState(oldProfile, 'r1', 'image-0')],
    ['PUT /profile/avatar', (body) => { avatarStarted(body); return waitAvatar }],
    ['PUT /profile/avatar-image', (body) => { assert.deepEqual(body, { dataUri: png, imageRevision: 'image-0' }); return { image: png, imageRevision: 'image-1' } }],
    ['GET /profile', profileState({ avatar: shape, avatarImage: png }, 'r2', 'image-1')],
    settings('r2', { ...oldConfig, locale: 'en' }), keys, settings('r2', { ...oldConfig, locale: 'en' }),
    settings('r2', { ...oldConfig, locale: 'en' }),
    ['PUT /personas/builder/enabled', (body) => { assert.deepEqual(body, { enabled: false, revision: 'role-0' }); return { role: enabled } }],
    ['GET /personas', roster([general, enabled])], settings('r3', { ...oldConfig, locale: 'en' }), keys, settings('r3', { ...oldConfig, locale: 'en' }),
    ['PATCH /settings', (body) => { assert.deepEqual(body, { set: { theme: 'dark' }, unset: [], revision: 'r3' }); return { ok: true, revision: 'r4' } }]
  ])
  const initial = f.host.api.config.set({ locale: 'en' })
  const save = f.api.saveProfile(profileState(oldProfile, 'r0', 'image-0'), shape, png)
  const disable = f.api.setEnabled(role, false)
  const dark = f.host.api.config.set({ theme: 'dark' })
  assert.deepEqual(await seen, { spec: shape, revision: 'r1' })
  assert.equal(f.requests.at(-1).route, 'PUT /profile/avatar')
  finishAvatar({ ok: true, revision: 'r2' })
  await initial
  assert.deepEqual(await save, profileState({ avatar: shape, avatarImage: png }, 'r2', 'image-1'))
  assert.deepEqual(await disable, { role: enabled, roster: roster([general, enabled]) })
  assert.deepEqual(await dark, { ok: true })
  assert.deepEqual(f.failures, [])
  f.done()
})

test('a different tab changes settings before a role write: block the cached document, never rebase or replay', async () => {
  const f = fixture([settings('r0'), keys, settings('foreign')])
  const start = f.api.createRole({ name: 'The role' })
  const queued = f.host.api.config.set({ theme: 'dark' })
  await assert.rejects(start, (error) => error instanceof HttpFailure && error.code === 'settings_changed')
  await assert.rejects(queued, /Reload settings before continuing/)
  assert.equal(f.failures[0].status, 409)
  assert.deepEqual(await f.host.api.config.get(), oldConfig)
  f.done()
})

test('a role write acknowledged while a foreign models table changed leaves the global editor locked', async () => {
  const f = fixture([settings('r0'), keys, settings('r0'), ['PUT /personas/order', roster([role, general], 'order-1')],
    settings('r2', { ...oldConfig, models: { providers: [{ id: 'external' }] } })])
  await assert.rejects(f.api.reorder([role.id, general.id], 'order-0'), (error) => error.code === 'settings_changed_after_write')
  await assert.rejects(f.host.api.config.set({ models: { providers: [] } }), /Reload settings/)
  assert.equal(f.failures.length, 1)
  f.done()
})

test('an independently changed avatar image marks the profile stale without clearing, overwriting or blocking unrelated settings', async () => {
  const f = fixture([settings('r0'), keys, settings('r0'), ['GET /profile', profileState({ ...oldProfile, avatarImage: png }, 'r0', 'image-1')],
    settings('r0'), ['PATCH /settings', { ok: true, revision: 'r1' }]])
  await assert.rejects(f.api.saveProfile(profileState(oldProfile, 'r0', 'image-0'), shape, ''), (error) => error.status === 409)
  await f.host.api.config.set({ theme: 'dark' })
  assert.deepEqual(f.failures, [])
  f.done()
})

test('scoped memory carries its displayed CAS, returns desktop errors, and is never replayed after stale', async () => {
  const global = { kind: 'global' }, project = { kind: 'project', id: 'w_catalog' }, scopedRole = { kind: 'role', id: role.id }
  const input = { type: note.type, title: note.title, body: note.body }
  const saved = { snapshot: { ...blank, entries: [note] }, revision: 'm1' }
  const f = fixture([settings('r0'), keys, ['GET /workspaces', { workspaces: [{ id: project.id, name: 'Approved' }] }],
    ['GET /memory/global', { snapshot: blank, revision: 'm0' }],
    ['POST /memory/global', (body) => { assert.deepEqual(body, { input, revision: 'm0' }); return { ok: true, ...saved } }],
    ['POST /memory/global', (body) => { assert.deepEqual(body, { id: note.id, input, revision: 'm1' }); return { ok: false, code: 'duplicate', revision: 'm1' } }],
    ['DELETE /memory/global', (body) => { assert.deepEqual(body, { id: note.id, revision: 'm1' }); return { error: 'conflict' } }, 409],
    ['GET /memory/role/builder', { snapshot: blank, revision: 'm-role' }],
    ['GET /memory/project/w_catalog', { snapshot: saved.snapshot, revision: 'm-project' }],
    ['DELETE /memory/project/w_catalog', (body) => { assert.deepEqual(body, { clear: true, revision: 'm-project' }); return { ok: true, snapshot: blank, revision: 'm2' } }]
  ])
  assert.deepEqual(await f.api.workspaces(), [{ id: project.id, name: 'Approved' }])
  await assert.rejects(f.api.memory({ kind: 'project', id: '/home/client/folder' }), /Invalid library identifier/)
  assert.equal((await f.api.memory(global)).revision, 'm0')
  assert.deepEqual(await f.api.writeMemory(global, input, 'm0'), { ok: true, ...saved })
  assert.deepEqual(await f.api.writeMemory(global, input, 'm1', note.id), { ok: false, code: 'duplicate', revision: 'm1' })
  await assert.rejects(f.api.deleteMemory(global, 'm1', note.id), (err) => err.code === 'conflict')
  assert.equal((await f.api.memory(scopedRole)).revision, 'm-role')
  assert.equal((await f.api.memory(project)).revision, 'm-project')
  assert.equal((await f.api.deleteMemory(project, 'm-project')).snapshot.entries.length, 0)
  assert.deepEqual(f.failures, [])
  f.done()
})

test('role deletion honors the protected default and resource reference conflict without replay', async () => {
  const f = fixture([settings('r0'), keys, settings('r0'), settings('r0'), settings('r0'),
    ['DELETE /personas/builder', (body) => { assert.deepEqual(body, { revision: 'role-0' }); return { code: 'role_referenced' } }, 409],
    settings('r0'), ['GET /personas/builder', { role }]])
  await assert.rejects(f.api.deleteRole(general), (error) => error.code === 'role_protected')
  await assert.rejects(f.api.deleteRole(role), (error) => error.code === 'role_referenced')
  assert.deepEqual(await f.api.role(role.id), role)
  assert.deepEqual(f.failures, [])
  f.done()
})

test('role avatar lazily reads and saves a dotted legacy ID, and clears with the acknowledged picture CAS', async () => {
  const legacy = { ...role, id: 'Builder.Legacy_02' }
  const empty = { image: '', revision: 'role-0', imageRevision: 'picture-0' }
  const uploaded = { ...empty, image: png, imageRevision: 'picture-1' }
  const cleared = { ...empty, imageRevision: 'picture-2' }
  const portraitPath = '/personas/Builder.Legacy_02/avatar-image'
  const f = fixture([settings('r0'), keys, ['GET /personas', roster([general, legacy])],
    ['GET /personas/Builder.Legacy_02', { role: legacy }], [`GET ${portraitPath}`, empty],
    [`PUT ${portraitPath}`, (body) => { assert.deepEqual(body, { dataUri: png, revision: 'role-0', imageRevision: 'picture-0' }); return uploaded }],
    [`PUT ${portraitPath}`, (body) => { assert.deepEqual(body, { dataUri: '', revision: 'role-0', imageRevision: 'picture-0' }); return { error: 'conflict' } }, 409],
    [`GET ${portraitPath}`, uploaded],
    [`PUT ${portraitPath}`, (body) => { assert.deepEqual(body, { dataUri: '', revision: 'role-0', imageRevision: 'picture-1' }); return cleared }],
    ['GET /memory/role/Builder.Legacy_02', { snapshot: blank, revision: 'mem-legacy' }],
    ['PATCH /settings', (body) => { assert.equal(body.revision, 'r0'); return { ok: true, revision: 'r1' } }]])
  assert.deepEqual(await f.api.roster(), roster([general, legacy]))
  await assert.rejects(f.api.roleImage('../unsafe'), /Invalid role id/)
  assert.deepEqual(await f.api.roleAvatar(legacy.id), { role: legacy, image: empty })
  assert.deepEqual(await f.api.setRoleImage(legacy, empty, png), uploaded)
  await assert.rejects(f.api.setRoleImage(legacy, empty, ''), (err) => err.code === 'conflict')
  assert.deepEqual(await f.api.roleImage(legacy.id), uploaded)
  assert.deepEqual(await f.api.setRoleImage(legacy, uploaded, ''), cleared)
  assert.equal((await f.api.memory({ kind: 'role', id: legacy.id })).revision, 'mem-legacy')
  await f.host.api.config.set({ theme: 'dark' })
  assert.deepEqual(f.failures, [])
  f.done()
})

test('a personal image CAS loss after the avatar spec commits pauses dependent config edits and does not replay either write', async () => {
  const f = fixture([settings('r0'), keys, settings('r0'), ['GET /profile', profileState(oldProfile, 'r0', 'before-image')],
    ['PUT /profile/avatar', { ok: true, revision: 'r1' }], ['PUT /profile/avatar-image', { error: 'conflict' }, 409]])
  await assert.rejects(f.api.saveProfile(profileState(oldProfile, 'r0', 'before-image'), shape, png), /image write not confirmed/)
  await assert.rejects(f.host.api.config.set({ theme: 'dark' }), /Reload settings/)
  assert.equal(f.failures.length, 1)
  f.done()
})

test('create role then edit only changed metadata; a stale portrait pair never becomes an edit baseline', async () => {
  const renamed = { ...role, name: 'Renamed builder', revision: 'role-1' }
  const fields = { name: role.name, enabled: true, workspaceId: 'w_upstream' }
  const f = fixture([settings('r0'), keys, settings('r0'),
    ['POST /personas', (body) => { assert.deepEqual(body, fields); return { role } }],
    ['GET /personas', roster()], settings('r1'), keys, settings('r1'),
    ['GET /personas/builder', { role }],
    ['GET /personas/builder/avatar-image', { image: '', revision: 'foreign-role', imageRevision: 'empty-picture' }],
    settings('r1'), ['PATCH /personas/builder', (body) => { assert.deepEqual(body, { name: renamed.name, revision: role.revision }); return { role: renamed } }],
    ['GET /personas', roster([general, renamed])], settings('r1'), keys, settings('r1')])
  assert.equal((await f.api.createRole(fields)).role.id, role.id)
  await assert.rejects(f.api.roleAvatar(role.id), (error) => error.code === 'conflict')
  assert.deepEqual((await f.api.updateRole(role, { name: renamed.name })).role, renamed)
  assert.deepEqual(f.failures, [])
  f.done()
})
