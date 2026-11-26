import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { requestControl } from '../src/control/socket.mjs'
import { startWorkbench } from '../src/server.mjs'
import { initializeMasterKey } from '../src/storage/vault.mjs'

const options = { timeout: 45_000 }
const crc = /^[a-f0-9]{64}$/u
const rel = sid => `chats/${sid}/workspace`

async function fixture(t) {
  const parent = await realpath(tmpdir()), root = await mkdtemp(join(parent, 'deva-scope-http-'))
  const identity = await lstat(root), h = join(root,'data'), mount = join(root,'projects'), runDir = join(root,'run')
  assert.equal(dirname(root),parent)
  const keyFile = join(root,'key-file'), opts = {dataDir:h, keyFile, runDir, webDir:join(root,'no-assets'),port:0}
  let app
  t.after(async () => {
    try { await app?.close() } finally {
      const st=await lstat(root);assert.equal(st.dev,identity.dev);assert.equal(st.ino,identity.ino);assert.equal(await realpath(root),root)
      await rm(root,{recursive:true,force:true})
    }
  })
  await mkdir(join(mount,'Alpha'),{recursive:true});await mkdir(join(mount,'Beta'))
  await writeFile(join(mount,'Alpha','notes.txt'),'private Alpha fixture text\n',{mode:0o600});await initializeMasterKey(keyFile)
  async function boot(mounted=true) { app=await startWorkbench({...opts,businessOptions:mounted?{workspaceRoot:mount}:{}}) }
  await boot()
  const password=randomBytes(24).toString('base64url')
  function call(path,who,method='GET',body,headers={}) {
    return fetch(`${app.origin}/api/v1/${path}`,{method,headers:{...(who?{cookie:who.cookie}:{}),
      ...(body===undefined?{}:{origin:app.origin,'content-type':'application/json',...(who?{'x-deva-csrf':who.csrf}:{})}),...headers},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(6500)})
  }
  async function accept(req) { const r=await req;assert.equal(r.status,200);return {cookie:r.headers.get('set-cookie').split(';')[0],csrf:(await r.json()).csrf} }
  const {credential}=await requestControl({runDir,op:'claim'}), owner=await accept(call('auth/claim',null,'POST',{credential,password}))
  const login=()=>accept(call('auth/login',null,'POST',{password})), other=await login()
  async function get(path,who=owner,method='GET',body,status=200,extra) {
    const r=await call(path,who,method,body,extra),json=await r.json();assert.equal(r.status,status,`${method} ${path}: ${json.error??'unexpected reply'}`);return json
  }
  const projects=(await get('workspaces')).workspaces
  return {root,h,mount,owner,other,get,call,login,alpha:projects.find(x=>x.name==='Alpha').id,beta:projects.find(x=>x.name==='Beta').id,
    open:async(body,who=owner)=>(await get('chats',who,'POST',body)).session.id,
    disk:async sid=>JSON.parse(await readFile(join(h,'data','chats',`${sid}.json`),'utf8')),
    restart:async(mounted=true)=>{await app.close();await boot(mounted)} }
}

test('owner APIs keep project browsing distinct from a conditional, native session binding',options,async t=>{
  const f=await fixture(t), a=f.owner, b=f.other
  assert.equal((await f.get('bootstrap')).capabilities.sessionWorkspaces,true)
  const sid=await f.open({}), second=await f.open({})
  const initial=await f.get(rel(sid));assert.equal(initial.workspace,null);assert.match(initial.revision,crc)
  const unrelated=await f.get(rel(second));assert.notEqual(unrelated.revision,initial.revision)
  // Reading a human-authorized project never binds it to the current conversation.
  const listing=await f.get(`workspaces/${f.alpha}/list`,a,'POST',{path:''});assert.equal(listing.entries[0].name,'notes.txt')
  assert.deepEqual(await f.get(rel(sid)),initial)
  const set={workspaceId:f.alpha,revision:initial.revision}
  assert.equal((await f.call(rel(sid),null)).status,401)
  assert.equal((await f.call(rel(sid),a,'PATCH',set,{'x-deva-csrf':'wrong'})).status,401)
  assert.equal((await f.call(rel(sid),a,'PATCH',set,{origin:'https://elsewhere.invalid'})).status,403)
  assert.equal((await f.call(rel(sid)+'?path=foo',a)).status,400)
  assert.equal((await f.call(rel(sid),a,'PATCH',{...set,root:f.mount})).status,400)
  assert.equal((await f.call(rel(sid),a,'PATCH',{...set,workspaceId:f.mount})).status,400)
  assert.equal((await f.call(rel(sid),a,'PATCH',{...set,workspaceId:'w_'+'0'.repeat(32)})).status,404)
  assert.deepEqual(await f.get(rel(sid)),initial)
  const bound=await f.get(rel(sid),a,'PATCH',set)
  assert.deepEqual(bound.workspace,{id:f.alpha,name:'Alpha',state:'available',source:'manual'})
  assert.notEqual(bound.revision,initial.revision);assert.deepEqual(await f.get(rel(sid),b),bound)
  assert.equal((await f.disk(sid)).focusRoot,join(f.mount,'Alpha'))
  const state=(await f.get('chats/'+sid)).state
  assert.equal(state.workspaceRevision,bound.revision)
  const publicState=JSON.stringify([state,await f.get('chats'),bound]);assert.equal(publicState.includes(f.mount),false)
  assert.equal(publicState.includes('private Alpha fixture text'),false);assert.deepEqual(state.messages,[])
  assert.deepEqual(await f.get(rel(sid),b,'PATCH',{workspaceId:f.beta,revision:initial.revision},409),{error:'workspace_conflict'})
  assert.deepEqual(await f.get(rel(sid),b,'PATCH',{workspaceId:f.alpha,revision:bound.revision}),bound)
  assert.deepEqual(await f.get(rel(second)),unrelated)
  await f.restart(false);assert.equal((await f.call(rel(sid),a)).status,401);const recovered=await f.login()
  const unmounted=await f.get(rel(sid),recovered);assert.equal(unmounted.revision,bound.revision)
  assert.deepEqual(unmounted.workspace,{id:f.alpha,name:null,state:'unavailable',source:'manual'})
  const cleared=await f.get(rel(sid),recovered,'PATCH',{workspaceId:null,revision:unmounted.revision});assert.equal(cleared.workspace,null)
  await f.restart();const again=await f.login();assert.deepEqual(await f.get(rel(sid),again),cleared)
})

test('role defaults apply once while manual overrides, replay and replaced projects keep their identity',options,async t=>{
  const f=await fixture(t), owner=f.owner
  const {role}=await f.get('personas',owner,'POST',{name:'Editorial role',prompt:'Use a clear tone.',enabled:true,workspaceId:f.alpha})
  const first=randomUUID(), create={sessionId:first,personaId:role.id}
  assert.equal(await f.open(create),first)
  const bound=await f.get(rel(first));assert.deepEqual(bound.workspace,{id:f.alpha,name:'Alpha',state:'available',source:'role'})
  await f.get(`personas/${role.id}`,owner,'PATCH',{revision:role.revision,name:role.name,prompt:role.prompt,enabled:true,workspaceId:f.beta})
  assert.equal(await f.open(create),first);assert.deepEqual(await f.get(rel(first)),bound)
  const inherited=await f.open({personaId:role.id}), empty=await f.open({personaId:role.id,workspaceId:null}), explicit=await f.open({personaId:role.id,workspaceId:f.alpha})
  assert.deepEqual((await f.get(rel(inherited))).workspace,{id:f.beta,name:'Beta',state:'available',source:'role'})
  assert.equal((await f.get(rel(empty))).workspace,null);assert.equal((await f.get(rel(explicit))).workspace.source,'manual')
  assert.equal((await f.call('chats',owner,'POST',{...create,workspaceId:f.beta})).status,409)
  const before=await f.disk(first)
  await rename(join(f.mount,'Alpha'),join(f.root,'retired'));await mkdir(join(f.mount,'Alpha'))
  const nextId=(await f.get('workspaces')).workspaces.find(x=>x.name==='Alpha').id;assert.notEqual(nextId,f.alpha)
  const lost=await f.get(rel(first));assert.equal(lost.revision,bound.revision);assert.deepEqual(lost.workspace,{id:f.alpha,name:null,state:'unavailable',source:'role'})
  assert.deepEqual(await f.disk(first),before)
  const changed=await f.get(rel(first),owner,'PATCH',{revision:lost.revision,workspaceId:nextId});assert.equal(changed.workspace.id,nextId);assert.equal(changed.workspace.source,'manual')
  assert.equal((await f.get(rel(inherited))).workspace.id,f.beta)
  assert.equal(await f.open(create),first);assert.deepEqual(await f.get(rel(first)),changed)
})
