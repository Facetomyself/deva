import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { requestControl } from '../src/control/socket.mjs'
import { startWorkbench } from '../src/server.mjs'
import { initializeMasterKey } from '../src/storage/vault.mjs'

const limits={timeout:40_000}
const id='d724414e-05e0-4e96-9088-ca198e3072b3', other='42fa2490-808b-4660-ae2b-48951765c016'
const instant=Date.UTC(2026,0,15,9), secretMarker='synthetic-hidden-field-v1'
const hash=b=>createHash('sha256').update(b).digest('hex')
function record(id,status,title,prompt) {
  return {id,title,prompt,status,schedule:status==='active'?{kind:'recurring',cron:'17 13 * * *',tz:'UTC'}:{kind:'once',at:'2026-01-15T09:00',tz:'UTC'},
    auth:{personaId:null,modelRef:null,extension:secretMarker},sessionId:'task-'+id,createdAt:instant-86400_000,updatedAt:instant,
    lastRunAt:instant,nextRunAt:status==='active'?instant+86400_000:null,consecutiveErrors:0,
    runs:[{status:'ok',firedAt:instant,finishedAt:instant+100,summary:'Recorded result, not a new run.'}],extraNativeTag:secretMarker}
}
async function fixture(t) {
  const base=await realpath(tmpdir()),root=await mkdtemp(join(base,'deva-task-api-')),original=await lstat(root)
  const dataDir=join(root,'data'),keyFile=join(root,'keys','master.key'),runDir=join(root,'run'),file=join(dataDir,'tasks.json')
  const options={dataDir,keyFile,runDir,webDir:join(root,'web'),port:0}
  let app, a,b
  t.after(async()=>{try{await app?.close()}finally{
    const st=await lstat(root);assert.equal(dirname(root),base);assert.equal(await realpath(root),root);assert.equal(st.dev,original.dev);assert.equal(st.ino,original.ino);await rm(root,{recursive:true,force:false})
  }})
  await mkdir(dataDir,{mode:0o700});await mkdir(dirname(keyFile),{mode:0o700});await initializeMasterKey(keyFile)
  const data={version:1,extraAppField:secretMarker,tasks:[record(id,'active','Editorial check','Read <sample> literally.'),record(other,'completed','Index pass','Unrelated instruction.')]}
  await writeFile(file,JSON.stringify(data,null,2)+'\n',{mode:0o600,flag:'wx'})
  app=await startWorkbench(options)
  const password=randomBytes(24).toString('base64url')
  async function req(path,method='GET',body,login=a,headers={}) {
    const r=await fetch(app.origin+'/api/v1/'+path,{method,headers:{...(login?{cookie:login.cookie}:{}),
      ...(body===undefined?{}:{origin:app.origin,'content-type':'application/json',...(login?{'x-deva-csrf':login.csrf}:{})}),...headers},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(6500)})
    return {status:r.status,value:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0],cache:r.headers.get('cache-control')}
  }
  const signin=async(path,input)=>{const r=await req(path,'POST',input,null);assert.equal(r.status,200);return {cookie:r.cookie,csrf:r.value.csrf}}
  const {credential}=await requestControl({runDir,op:'claim'});a=await signin('auth/claim',{credential,password});b=await signin('auth/login',{password})
  async function ok(path,method,body,login){const r=await req(path,method,body,login);assert.equal(r.status,200,r.value?.error);assert.equal(r.cache,'no-store');return r.value}
  const state=async()=>({main:await readFile(file),stat:await lstat(file,{bigint:true})})
  const restart=async()=>{await app.close();app=await startWorkbench(options);assert.equal((await req('tasks','GET',undefined,a)).status,401);a=await signin('auth/login',{password})}
  return {req,ok,a,b,state,root,data,file,restart}
}

test('human reads and previews leave the desktop task store and agent sessions unchanged', limits, async t=>{
  const f=await fixture(t), before=await f.state();assert.equal((await f.ok('bootstrap')).capabilities.taskInspection,true)
  assert.equal((await f.req('tasks','GET',undefined,null)).status,401)
  assert.equal((await f.req('tasks?x=1')).status,400)
  const list=await f.ok('tasks');assert.equal(list.execution,'inactive');assert.equal(list.revision,hash(before.main));assert.equal(list.tasks.length,2)
  assert.ok(list.tasks.some(x=>x.id===id && x.status==='active' && x.runCount===1));assert.ok(!JSON.stringify(list).includes(secretMarker))
  for(const item of list.tasks)for(const k of ['prompt','auth','runs','sessionId'])assert.equal(Object.hasOwn(item,k),false,k)
  const detail=await f.ok('tasks/'+id);assert.equal(detail.task.prompt,'Read <sample> literally.');assert.equal(detail.task.pauseAllowed,true)
  assert.equal(detail.task.runs[0].summary,f.data.tasks[0].runs[0].summary);assert.ok(!JSON.stringify(detail).includes(secretMarker))
  assert.deepEqual(detail.task.auth,{personaId:null,modelRef:null})
  const preview={schedule:{kind:'once',at:'2088-05-12T08:15',tz:'Asia/Shanghai'},locale:'en',allowPast:false}
  const answer=await f.ok('tasks/preview','POST',preview);assert.equal(answer.ok,true);assert.equal(answer.nextRunAt,Date.UTC(2088,4,12,0,15));assert.ok(answer.description.length)
  assert.deepEqual(await f.ok('tasks/preview','POST',{...preview,schedule:{kind:'once',at:'2020-01-01T00:00',tz:'UTC'}}),{ok:false,error:'invalid-once'})
  assert.equal((await f.req('tasks/preview','POST',preview,f.a,{'x-deva-csrf':'bad'})).status,401)
  assert.equal((await f.req('tasks/preview','POST',preview,f.a,{origin:'https://other.invalid'})).status,403)
  for(const action of ['run','resume','delete'])assert.equal((await f.req(`tasks/${id}/${action}`,'POST',{})).status,404)
  assert.equal((await f.req('tasks','POST',{})).status,405)
  assert.deepEqual((await f.ok('chats')).sessions,[])
  const after=await f.state();assert.deepEqual(after.main,before.main);assert.equal(after.stat.mtimeNs,before.stat.mtimeNs)
})

test('only confirmed native pause is writable, survives recreation and rejects stale or foreign intents', limits, async t=>{
  const f=await fixture(t), initial=await f.ok('tasks'), path=`tasks/${id}/status`, pause={status:'paused',revision:initial.revision}
  for(const status of ['active','completed','error','run'])assert.equal((await f.req(path,'PATCH',{...pause,status})).status,400)
  assert.equal((await f.req(path,'PATCH',{...pause,cmd:'unexpected'})).status,400)
  assert.equal((await f.req(`tasks/${other}/status`,'PATCH',pause)).status,409)
  assert.equal((await f.req(path,'PATCH',pause,f.a,{'x-deva-csrf':'invalid'})).status,401)
  assert.equal((await f.req(path,'PATCH',pause,f.a,{origin:'https://other.invalid'})).status,403)
  const confirm=await f.ok(path,'PATCH',pause);assert.equal(confirm.task.status,'paused');assert.notEqual(confirm.revision,initial.revision)
  assert.equal(confirm.task.nextRunAt,f.data.tasks[0].nextRunAt);assert.equal(confirm.task.pauseAllowed,false)
  const old=await f.req(path,'PATCH',pause,f.b);assert.equal(old.status,409);assert.equal(old.value.error,'task_conflict')
  const bytes=await readFile(f.file), saved=JSON.parse(bytes);assert.equal(confirm.revision,hash(bytes))
  const expected=structuredClone(f.data);expected.tasks[0].status='paused';expected.tasks[0].updatedAt=saved.tasks[0].updatedAt
  assert.deepEqual(saved,expected);assert.ok(saved.tasks[0].updatedAt>f.data.tasks[0].updatedAt)
  const oldstat=await lstat(f.file,{bigint:true});await f.ok(path,'PATCH',{...pause,revision:confirm.revision});assert.equal((await lstat(f.file,{bigint:true})).mtimeNs,oldstat.mtimeNs)
  await f.restart();assert.equal((await f.ok('tasks/'+id)).task.status,'paused');assert.deepEqual((await f.ok('chats')).sessions,[])
  // A bad native task file is a truthful error from this view, not a blank task dashboard.
  await writeFile(f.file,'{"version":1,"tasks": [');await chmod(f.file,0o600)
  const corrupted=await f.req('tasks');assert.ok([409,503].includes(corrupted.status));assert.equal('tasks' in corrupted.value,false)
  assert.equal((await f.ok('bootstrap')).capabilities.textChat,true)
})
