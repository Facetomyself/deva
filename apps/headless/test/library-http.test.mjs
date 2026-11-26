import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { requestControl } from '../src/control/socket.mjs'
import { startWorkbench } from '../src/server.mjs'
import { initializeMasterKey } from '../src/storage/vault.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'deva-library-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dataDir = join(root, 'data'), keyFile = join(root, 'master.key'), work = join(root, 'projects')
  await initializeMasterKey(keyFile)
  await mkdir(join(work, 'Tiny project'), { recursive: true }); await symlink(dataDir, join(work, 'link-to-service-state'))
  const options = { dataDir, keyFile, runDir: join(root, 'run'), webDir: join(root, 'web'), port: 0, businessOptions: { workspaceRoot: work } }
  let host = await startWorkbench(options)
  t.after(() => host.close())
  let cookie, csrf
  async function call(path, method = 'GET', body, extra = {}) {
    const headers = { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { origin: host.origin, 'content-type': 'application/json', 'x-deva-csrf': csrf ?? '' } : {}), ...extra }
    const res = await fetch(host.origin + '/api/v1/' + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: res.status, body: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] }
  }
  const password = randomBytes(24).toString('hex')
  async function signIn(claim) {
    const args = { password }
    if (claim) Object.assign(args, { credential: (await requestControl({ runDir: options.runDir, op: 'claim' })).credential })
    const r = await call(claim ? 'auth/claim' : 'auth/login', 'POST', args)
    assert.equal(r.status, 200); cookie = r.cookie; csrf = r.body.csrf
  }
  return { root, dataDir, call, signIn, restart: async () => { await host.close(); host = await startWorkbench(options) } }
}

test('profile and role metadata use authenticated revisions; valid updates survive restart', { timeout: 30000 }, async t => {
  const { root, call, signIn, restart } = await fixture(t)
  for (const path of ['profile','personas','memory/global','workspaces']) assert.equal((await call(path)).status, 401)
  await signIn(true)
  assert.equal((await call('bootstrap')).body.capabilities.library, true)
  const first = (await call('profile')).body
  assert.equal(first.revision, (await call('settings')).body.revision)
  const spec = JSON.stringify({ background: '123456' })
  const body = { spec, revision: first.revision }
  assert.equal((await call('profile/avatar', 'PUT', body, { 'x-deva-csrf': 'wrong' })).status, 401)
  assert.equal((await call('profile/avatar', 'PUT', body, { origin: 'https://wrong.example' })).status, 403)
  assert.equal((await call('profile/avatar', 'PUT', body)).status, 200)
  assert.deepEqual((await call('profile/avatar', 'PUT', body)).body, { error: 'conflict' })
  assert.equal((await call('profile/avatar-image', 'PUT', { dataUri: 'file:///private', imageRevision: first.imageRevision })).status, 400)
  const ws = (await call('workspaces')).body.workspaces
  assert.equal(ws.length, 1); assert.deepEqual(Object.keys(ws[0]).sort(), ['id','name']); assert.equal(ws[0].name, 'Tiny project')
  const seeded = (await call('personas')).body
  assert.deepEqual(seeded.order, ['general']); assert.equal(seeded.roles[0].enabled, true)
  assert.equal((await call('personas/general', 'DELETE', { revision: seeded.roles[0].revision })).body.error, 'role_protected')
  const made = await call('personas', 'POST', { name: 'Editor', description: 'Edits ordinary prose', prompt: 'Keep sentences concise.', workspaceId: ws[0].id, enabled: true })
  assert.equal(made.status, 200); const role = made.body.role
  assert.equal(role.workspaceName, 'Tiny project'); assert.ok(!JSON.stringify(role).includes(root))
  const renamed = await call(`personas/${role.id}`, 'PATCH', { name: 'Copy editor', revision: role.revision })
  assert.equal(renamed.status, 200); assert.equal(renamed.body.role.prompt, role.prompt)
  assert.equal((await call(`personas/${role.id}/enabled`, 'PUT', { enabled:false, revision:role.revision })).body.error, 'conflict')
  assert.equal((await call(`personas/${role.id}`, 'PATCH', { workspace: root, revision:renamed.body.role.revision })).status, 400)
  const roster = (await call('personas')).body
  const ordered = await call('personas/order', 'PUT', { ids:[role.id,'general'],revision:roster.revision })
  assert.deepEqual(ordered.body.order,[role.id,'general'])
  await restart();assert.equal((await call('profile')).status,401);await signIn(false)
  assert.equal((await call('profile')).body.profile.avatar,spec)
  assert.deepEqual((await call('personas')).body.order,[role.id,'general'])
  const latest = (await call(`personas/${role.id}`)).body.role
  assert.equal((await call(`personas/${role.id}`,'DELETE',{revision:latest.revision})).status,200)
  assert.equal((await call(`personas/${role.id}`)).status,404)
})

test('owner and role image updates independently reject stale pictures and survive restart', { timeout: 30000 }, async t => {
  const { call, signIn, restart } = await fixture(t)
  await signIn(true)
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWNYZ/B3ncFfBggFADLGB23aTHV6AAAAAElFTkSuQmCC'
  const owner = (await call('profile')).body
  const saved = await call('profile/avatar-image', 'PUT', { dataUri: png, imageRevision: owner.imageRevision })
  assert.equal(saved.status, 200); assert.equal(saved.body.image, png); assert.notEqual(saved.body.imageRevision, owner.imageRevision)
  assert.deepEqual((await call('profile/avatar-image', 'PUT', { dataUri: '', imageRevision: owner.imageRevision })).body, { error: 'conflict' })
  assert.equal((await call('profile')).body.revision, owner.revision)
  const made = (await call('personas', 'POST', { name: 'Composer' })).body.role
  const route = `personas/${made.id}/avatar-image`; const initial = (await call(route)).body
  assert.equal(initial.image, ''); assert.equal(initial.revision, made.revision)
  const installed = await call(route, 'PUT', { dataUri: png, revision: made.revision, imageRevision: initial.imageRevision })
  assert.equal(installed.status, 200); assert.equal(installed.body.image, png)
  assert.deepEqual((await call(route, 'PUT', { dataUri: '', revision: made.revision, imageRevision: initial.imageRevision })).body, { error: 'conflict' })
  assert.equal((await call(`personas/${made.id}`, 'DELETE', { revision: made.revision })).body.error, 'role_referenced')
  await restart(); await signIn(false)
  assert.deepEqual((await call(route)).body, installed.body)
  const cleared = await call(route, 'PUT', { dataUri: '', revision: made.revision, imageRevision: installed.body.imageRevision })
  assert.equal(cleared.status, 200); assert.equal(cleared.body.image, '')
  assert.equal((await call('profile')).body.profile.avatarImage, png)
  assert.equal((await call(`personas/${made.id}`, 'DELETE', { revision: made.revision })).status, 200)
})

test('global, authorized role and registered project memory remain separate with stale writes rejected', { timeout: 30000 }, async t => {
  const { call, signIn, restart } = await fixture(t); await signIn(true)
  const role = (await call('personas','POST',{name:'Proofreader', enabled:true})).body.role
  const workspace = (await call('workspaces')).body.workspaces[0]
  const scopes = ['global', `role/${role.id}`, `project/${workspace.id}`]; const ids = []
  for (const [i,scope] of scopes.entries()) {
    const p = 'memory/' + scope; const before = await call(p);assert.equal(before.status,200)
    const input = { type:'reference', title:`Note ${i}`, body:`Private to scope ${i}` }
    const stored = await call(p,'POST',{input,revision:before.body.revision});assert.equal(stored.status,200)
    assert.deepEqual(stored.body.snapshot.entries.map(r=>r.title),[input.title]);ids.push(stored.body.snapshot.entries[0].id)
    assert.equal((await call(p,'DELETE',{clear:true,revision:before.body.revision})).status,409)
  }
  assert.equal((await call('memory/role/absent')).status,404)
  assert.equal((await call('memory/project/w_'+'f'.repeat(32))).status,404)
  assert.equal((await call('memory/global','POST',{input:{title:'x'},root:'/data',revision:(await call('memory/global')).body.revision})).status,400)
  assert.equal((await call(`personas/${role.id}`,'DELETE',{revision:role.revision})).body.error,'role_referenced')
  await restart();await signIn(false)
  for (const [i,scope] of scopes.entries()) {
    const p='memory/'+scope; const state=(await call(p)).body;assert.deepEqual(state.snapshot.entries.map(r=>r.id),[ids[i]])
    const updated=await call(p,'POST',{id:ids[i],input:{title:'Revised'},revision:state.revision});assert.equal(updated.body.ok,true)
    const removed=await call(p,'DELETE',{id:ids[i],revision:updated.body.revision});assert.deepEqual(removed.body.snapshot.entries,[])
  }
  const latest=(await call(`personas/${role.id}`)).body.role
  assert.equal((await call(`personas/${role.id}`,'DELETE',{revision:latest.revision})).status,200)
})
