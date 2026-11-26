import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { requestControl } from '../src/control/socket.mjs'
import { gitProjectNames } from '../src/git/access.mjs'
import { openGitService } from '../src/git/service.mjs'
import { startWorkbench } from '../src/server.mjs'
import { initializeMasterKey } from '../src/storage/vault.mjs'
import { makeGitViewRoot, seedGitViewFixture, headLine, stagedLine, worktreeLine } from '../../../scripts/workbench/e2e-git-view-fixture.mjs'

async function workbench(t, approved) {
  const root = await makeGitViewRoot()
  let app
  t.after(async () => { try { await app?.close() } finally { await root.close() } })
  const fixture = await seedGitViewFixture(root)
  const keyFile = join(root.root, 'master.key'), runDir = join(root.root, 'run')
  await initializeMasterKey(keyFile)
  app = await startWorkbench({dataDir:join(root.root,'data'), keyFile, runDir, webDir:join(root.root,'assets'), port:0,
    businessOptions:{workspaceRoot:fixture.workspaceRoot, gitProjects:approved}})
  const call=(path, method='GET', body, login, extra={})=>fetch(app.origin+'/api/v1/'+path, {method,
    headers:{...(login?{cookie:login.cookie}:{}), ...(body===undefined?{}:{origin:app.origin,'content-type':'application/json',...(login?{'x-deva-csrf':login.csrf}:{})}),...extra},
    ...(body===undefined?{}:{body:JSON.stringify(body)})})
  const login=async response=>{assert.equal(response.status,200);return {cookie:response.headers.get('set-cookie').split(';')[0],csrf:(await response.json()).csrf}}
  const password=randomBytes(24).toString('base64url'), {credential}=await requestControl({runDir,op:'claim'})
  const a=await login(await call('auth/claim','POST',{credential,password})), b=await login(await call('auth/login','POST',{password}))
  const projects=(await (await call('workspaces','GET',undefined,a)).json()).workspaces
  const alpha=projects.find(p=>p.name==='Alpha').id, beta=projects.find(p=>p.name==='Beta').id
  const api=(wid,op,body,who=a,extra)=>call(`workspaces/${wid}/git/${op}`,'POST',body,who,extra)
  async function ok(wid,op,body,who) {const r=await api(wid,op,body,who),v=await r.json();assert.equal(r.status,200,`${op}: ${v.error??''}`);return v}
  async function error(response,status,code) {const r=await response;assert.equal(r.status,status);assert.deepEqual(await r.json(),{error:code})}
  return { fixture,a,b,alpha,beta,call,api,ok,error }
}

test('a mounted workspace is not an implicit Git history grant', {timeout:20_000}, async t=>{
  const f=await workbench(t, undefined)
  const {capabilities}=await (await f.call('bootstrap','GET',undefined,f.a)).json()
  assert.equal(capabilities.workspaceFiles,true);assert.equal(capabilities.gitInspect,false)
  await f.error(f.api(f.alpha,'status',{}),403,'git_not_granted')
  await f.fixture.assertUnchanged()
  for(const names of ['["*"]','["../other"]','["Alpha","Alpha"]','[".keys"]',{},[null]]) assert.throws(()=>gitProjectNames(names))
})

test('two owner logins get scoped, read-only projections of a real packed repository', {timeout:30_000}, async t=>{
  const f=await workbench(t, ['Alpha'])
  const {capabilities}=await (await f.call('bootstrap','GET',undefined,f.a)).json();assert.equal(capabilities.gitInspect,true)
  assert.deepEqual(await f.ok(f.alpha,'available',{}), {available:true,mode:'read-only',workspaceId:f.alpha})
  await f.error(f.api(f.beta,'available',{}),403,'git_not_granted')
  await f.error(f.api(f.alpha,'status',{},f.a,{'x-deva-csrf':''}),401,'auth')
  await f.error(f.api(f.alpha,'status',{},f.a,{origin:'https://elsewhere.invalid'}),403,'origin')
  await f.error(f.api(f.beta,'status',{}),403,'git_not_granted')
  await f.error(f.api(f.alpha,'log',{limit:101}),400,'invalid_git_request')
  await f.error(f.api(f.alpha,'log',{limit:2,ref:'qa-main'}),400,'invalid_git_request')
  const names=await f.ok(f.alpha,'branches',{})
  assert.equal(names.state,'ready');assert.deepEqual(names.branches,[{name:'qa-main',current:true,remote:null},{name:'qa-review',current:false,remote:null}])
  const history=await f.ok(f.alpha,'log',{limit:2})
  assert.equal(history.traversal,'first-parent');assert.deepEqual(history.commits.map(c=>c.oid),[f.fixture.head,f.fixture.first]); assert.equal(history.more,false)
  const s=await f.ok(f.alpha,'status',{});assert.equal(s.state,'ready');assert.equal(s.workspaceId,f.alpha);assert.ok(s.limitations.includes('tracked_only'))
  assert.match(s.viewId,/^v_[a-f0-9]{32}$/); const [entry]=s.entries
  assert.deepEqual([entry.rel,entry.staged,entry.worktree,entry.conflicted],['notes.txt','M','M',false]);assert.match(entry.entryId,/^e_[a-f0-9]{32}$/)
  const req={viewId:s.viewId,entryId:entry.entryId,side:'staged'}
  await f.error(f.api(f.alpha,'diff',{...req,path:'notes.txt'}),400,'invalid_git_request')
  await f.error(f.api(f.alpha,'diff',req,f.b),409,'git_stale')
  const staged=await f.ok(f.alpha,'diff',req), work=await f.ok(f.alpha,'diff',{...req,side:'worktree'})
  const contains=(d,k,v)=>d.lines.some(l=>l.type===k&&l.text===v)
  assert.ok(contains(staged,'del',headLine));assert.ok(contains(staged,'add',stagedLine));assert.ok(contains(work,'del',stagedLine));assert.ok(contains(work,'add',worktreeLine))
  for(const data of [s,names,history,staged,work]) for(const marker of f.fixture.privateMarkers) assert.equal(JSON.stringify(data).includes(marker),false)
  await f.fixture.assertUnchanged()
  await writeFile(join(f.fixture.workspaceRoot,'Alpha','notes.txt'),'explicit synthetic external edit\n')
  await f.error(f.api(f.alpha,'diff',req),409,'git_stale')
  const newer=await f.ok(f.alpha,'status',{}); assert.notEqual(newer.viewId,s.viewId)
  await f.error(f.api(f.alpha,'diff',req),409,'git_stale')
  await f.call('auth/logout','POST',{},f.a);await f.error(f.api(f.alpha,'status',{}),401,'auth')
  assert.equal((await f.ok(f.alpha,'status',{},f.b)).state,'ready')
  const alpha=join(f.fixture.workspaceRoot,'Alpha')
  await rename(alpha,join(f.fixture.workspaceRoot,'retired'));await mkdir(alpha,{mode:0o700})
  await f.error(f.api(f.alpha,'branches',{},f.b),404,'workspace_unavailable')
  const fresh=(await (await f.call('workspaces','GET',undefined,f.b)).json()).workspaces.find(p=>p.name==='Alpha')
  assert.notEqual(fresh.id,f.alpha);await f.error(f.api(fresh.id,'branches',{},f.b),403,'git_not_granted')
})

test('a diff is bound to its allowed comparison side, project and short-lived view', async()=>{
  let clock=0, reads=0
  const actor={role:'owner',ownerId:'owner',loginSessionId:'binding'}
  const grants={enabled:true,pin:()=>({fd:1,mount:'1',assertCurrent(){},close(){}})}
  const service=openGitService({grants,auth:{isLoginActive:()=>true,onSessionRevoked:()=>()=>{}},now:()=>clock,
    run:async()=>{reads++; return {state:'ready',branch:'main',detached:false,unborn:false,mergeInProgress:false,limitations:['tracked_only'],
      fingerprint:'a'.repeat(64),entries:[{rel:'doc.txt',staged:'A',worktree:null,conflicted:false,diffSides:['staged']}]}}})
  try {
    const view=await service.inspect(actor,'wid','status',{}), request={viewId:view.viewId,entryId:view.entries[0].entryId,side:'staged'}
    await assert.rejects(service.inspect(actor,'other-project','diff',request),{status:409,code:'git_stale'})
    await assert.rejects(service.inspect(actor,'wid','diff',{...request,side:'worktree'}),{status:409,code:'git_stale'})
    clock=60_000;await assert.rejects(service.inspect(actor,'wid','diff',request),{status:409,code:'git_stale'});assert.equal(reads,1)
  } finally { await service.close() }
})

test('explicit Git work is cancelled on revocation, and shutdown drains borrowed project handles', async()=>{
  const actor={role:'owner',ownerId:'owner',loginSessionId:'one'}
  let active=true,listener,resolve,closed=0,signal
  const auth={isLoginActive:()=>active,onSessionRevoked(cb){listener=cb;return ()=>{}}}
  const grants={enabled:true,pin:()=>({fd:1,mount:'1',assertCurrent(){},close(){closed++}})}
  const service=openGitService({grants,auth,run(pin,job,s){signal=s;return new Promise(yes=>{resolve=yes})}})
  const ab=new AbortController(), pending=service.inspect(actor,'wid','status',{},ab.signal)
  await assert.rejects(service.inspect(actor,'wid','status',{},ab.signal),{status:409,code:'git_busy'})
  active=false;listener('one');assert.equal(signal.aborted,true)
  let done=false;const close=service.close().then(()=>{done=true});await Promise.resolve();assert.equal(closed,0);assert.equal(done,false)
  resolve({});await assert.rejects(pending);await close;assert.equal(closed,1);assert.equal(done,true)
})
