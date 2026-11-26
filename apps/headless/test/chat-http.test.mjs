import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { promises as fs } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import WebSocket from 'ws'
import { initializeMasterKey } from '../src/storage/vault.mjs'
import { requestControl } from '../src/control/socket.mjs'
import { startWorkbench } from '../src/server.mjs'

const until = (promise, label) => {
  let timer
  return Promise.race([promise, new Promise((_,reject) => { timer = setTimeout(() => reject(Error(label)), 6500); timer.unref() })]).finally(() => clearTimeout(timer))
}

test('one authenticated host drives real HTTP text turns, read-only output, stop, retry and restart', { timeout: 30000 }, async t => {
  const tmp = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'deva-chat-http-')); t.after(() => fs.rm(tmp,{recursive:true,force:true}))
  const keyFile = join(tmp,'master.key'); await initializeMasterKey(keyFile)
  const password = randomBytes(24).toString('base64url'), key = randomBytes(24).toString('hex')
  let requests = 0, closed
  const fixture = createServer(async (req,res) => {
    const parts=[]; for await (const ch of req) parts.push(ch)
    const payload=JSON.parse(Buffer.concat(parts)); requests++
    if(req.url !== '/v1/chat/completions' || payload.model !== 'wb-text' || req.headers.authorization !== `Bearer ${key}` || (payload.tools?.length ?? 0)>0){res.writeHead(400).end();return}
    closed=once(res,'close')
    res.writeHead(200,{'content-type':'text/event-stream'}); res.write(`data: ${JSON.stringify({choices:[{index:0,delta:{content:'integrated output.'},finish_reason:null}]})}\n\n`)
  });fixture.listen(0,'127.0.0.1');await once(fixture,'listening');t.after(async()=>{fixture.closeAllConnections();await new Promise(ok=>fixture.close(ok))})
  const origin=`http://127.0.0.1:${fixture.address().port}`
  const opts={dataDir:join(tmp,'data'),keyFile,runDir:join(tmp,'run'),webDir:join(tmp,'assets'),port:0,businessOptions:{allowedOrigins:[origin]}}
  let app=await startWorkbench(opts); t.after(()=>app.close()); let cookie,csrf
  const call=(path,method='GET',body,overrides={})=>fetch(app.origin+'/api/v1/'+path,{method,headers:{...(method==='GET'?{}:{origin:app.origin,'content-type':'application/json'}),...(csrf?{'x-deva-csrf':csrf}:{}),...(cookie?{cookie}:{}),...overrides},...(body===undefined?{}:{body:JSON.stringify(body)})})
  async function signIn(r){assert.equal(r.status,200); cookie=r.headers.get('set-cookie').split(';')[0];csrf=(await r.json()).csrf}
  assert.equal((await call('chats')).status,401)
  const {credential}=await requestControl({runDir:opts.runDir,op:'claim'});await signIn(await call('auth/claim','POST',{credential,password}))
  assert.equal((await(await call('bootstrap')).json()).capabilities.textChat,true)
  const sid=randomUUID(); const url=`chats/${sid}`
  assert.equal((await call('chats','POST',{sessionId:sid},{'x-deva-csrf':'wrong'})).status,401)
  for(let i=0;i<2;i++)assert.equal((await(await call('chats','POST',{sessionId:sid})).json()).session.id,sid)
  assert.deepEqual((await(await call('chats')).json()).sessions.map(s=>s.id),[sid]); assert.equal((await call(url+'?any=x')).status,400)
  const first=await(await call('settings')).json(); const p={id:'wb-qa',name:'Fixture',kind:'custom',purpose:'llm',accent:'#123456',adapter:'openai',apiHost:origin+'/v1',enabled:true,models:[{id:'wb-text',name:'Fixture',enabled:true}]}
  const saved=await(await call('settings','PATCH',{revision:first.revision,set:{models:{providers:[p],activeModelId:'wb-qa:wb-text',activeEffort:'default'}}})).json()
  assert.equal((await call('provider-keys/wb-qa','PUT',{value:key,revision:saved.revision})).status,200)
  const denied=await call(url+'/turns','POST',{sid,clientRequestId:'one',text:'hi',model:'wb-qa:wb-text'});assert.equal(denied.status,400)
  const ws=new WebSocket(app.origin.replace(/^http/,'ws')+'/api/v1/'+url+'/stream',{headers:{origin:app.origin,cookie}})
  t.after(()=>ws.terminate())
  const queue=[];const waiters=[];ws.on('message',data=>{const f=JSON.parse(data); const waiter=waiters.shift();if(waiter)waiter(f);else queue.push(f)})
  const next=()=>until(queue.length?Promise.resolve(queue.shift()):new Promise(ok=>waiters.push(ok)),'missing WebSocket frame')
  assert.equal((await next()).t,'snapshot')
  const body={clientRequestId:'one',text:'Hello.',model:'wb-qa:wb-text'}
  const admission=await call(url+'/turns','POST',body); assert.equal(admission.status,202);const ack=await admission.json();assert.equal(ack.duplicate,false)
  let frame;do{frame=await next()}while(frame.event?.type!=='text_delta');assert.equal(frame.event.text,'integrated output.')
  const active=(await(await call(url)).json()).state.active;assert.equal(active.turnId,ack.turnId);assert.equal(active.text,'integrated output.')
  const duplicate=await call(url+'/turns','POST',body);assert.equal(duplicate.status,200);assert.equal((await duplicate.json()).duplicate,true)
  assert.deepEqual(await(await call(url+'/stop','POST',{turnId:ack.turnId})).json(),{stopped:true})
  do{frame=await next()}while(frame.event?.type!=='done');assert.equal(frame.event.stopReason,'aborted');await until(closed,'model stream did not close')
  assert.equal(requests,1); ws.close();await until(once(ws,'close'),'client close')
  await app.close();app=await startWorkbench(opts);assert.equal((await call(url)).status,401);await signIn(await call('auth/login','POST',{password}))
  const after=(await(await call(url)).json()).state;assert.equal(after.active,null);assert.equal(after.lastTurn.status,'aborted');assert.deepEqual(after.messages.map(m=>m.content),['Hello.','integrated output.'])
  assert.equal((await(await call(url+'/turns','POST',body)).json()).duplicate,true);assert.equal(requests,1)
})
