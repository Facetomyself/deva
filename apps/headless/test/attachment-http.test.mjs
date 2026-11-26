import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { startWorkbench } from '../src/server.mjs'
import { requestControl } from '../src/control/socket.mjs'
import { initializeMasterKey } from '../src/storage/vault.mjs'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWNYZ/B3ncFfBggFADLGB23aTHV6AAAAAElFTkSuQmCC','base64')

test('raw uploads require owner, CSRF and an existing session; a preview is private, raster-only, and revocable', {timeout:30000}, async t => {
  const tmp = await mkdtemp(join(tmpdir(),'deva-attachments-route-')); t.after(()=>rm(tmp,{recursive:true,force:true}))
  const opts = {dataDir:join(tmp,'data'),keyFile:join(tmp,'master.key'),runDir:join(tmp,'run'),webDir:join(tmp,'web'),port:0}
  await initializeMasterKey(opts.keyFile); const app=await startWorkbench(opts); t.after(()=>app.close())
  const { credential }=await requestControl({runDir:opts.runDir,op:'claim'}); let cookie,csrf
  const api=(path,init={})=>fetch(app.origin+'/api/v1/'+path,init)
  const post=(path,body)=>api(path,{method:'POST',headers:{origin:app.origin,'content-type':'application/json',...(cookie?{cookie,'x-deva-csrf':csrf}:{})},body:JSON.stringify(body)})
  const claim=await post('auth/claim',{credential,password:randomBytes(24).toString('base64url')});assert.equal(claim.status,200)
  cookie=claim.headers.get('set-cookie').split(';')[0];csrf=(await claim.json()).csrf
  assert.equal((await(await api('bootstrap',{headers:{cookie}})).json()).capabilities.attachments,true)
  const sid=(await(await post('chats',{})).json()).session.id;const other=(await(await post('chats',{})).json()).session.id
  const url=(s,id)=>`chats/${s}/attachments`+(id?`/${id}`:'')
  const upload=(s,name,type,bytes,extra={})=>api(url(s),{method:'POST',headers:{origin:app.origin,cookie,'x-deva-csrf':csrf,'content-type':'application/octet-stream','x-deva-file-name':Buffer.from(name).toString('base64url'),'x-deva-file-type':type,...extra},body:bytes})
  assert.equal((await upload(sid,'notes.txt','text/plain','hi',{'x-deva-csrf':'wrong'})).status,401)
  assert.equal((await upload(sid,'notes.txt','text/plain','hi',{origin:'https://other.example'})).status,403)
  assert.equal((await upload('unknown','notes.txt','text/plain','hi')).status,404)
  assert.equal((await upload(sid,'../../notes.txt','text/plain','hi')).status,400)
  assert.equal((await upload(sid,'sample.svg','image/svg+xml','<svg/>')).status,415)
  assert.equal((await upload(sid,'pic.png','image/png',Buffer.from('not a picture'))).status,400)
  const text=await upload(sid,'笔记.txt','text/plain',Buffer.from('Only selected, not sent.'));assert.equal(text.status,201)
  const td=(await text.json()).attachment;assert.equal(td.kind,'text');assert.deepEqual(Object.keys(td).sort(),['id','kind','mime','name','size'])
  assert.equal((await api(url(sid,td.id)+'/preview',{headers:{cookie}})).status,415)
  const p=await upload(sid,'pixel.png','image/png',png);assert.equal(p.status,201);const img=(await p.json()).attachment
  assert.equal((await api(url(sid,img.id)+'/preview')).status,401)
  const preview=await api(url(sid,img.id)+'/preview',{headers:{cookie}});assert.equal(preview.status,200)
  assert.equal(preview.headers.get('content-type'),'image/png');assert.equal(preview.headers.get('x-content-type-options'),'nosniff');assert.equal(preview.headers.get('cache-control'),'no-store');assert.deepEqual(Buffer.from(await preview.arrayBuffer()),png)
  assert.equal((await api(url(other,img.id)+'/preview',{headers:{cookie}})).status,404)
  const draftSession=(await(await api('chats/'+sid,{headers:{cookie}})).json()).state;assert.deepEqual(draftSession.messages,[]);assert.equal(draftSession.lastTurn,null)
  const drop=()=>api(url(sid,img.id),{method:'DELETE',headers:{cookie,origin:app.origin,'x-deva-csrf':csrf}})
  assert.equal((await drop()).status,200);assert.equal((await drop()).status,200)
  assert.equal((await api(url(sid,img.id)+'/preview',{headers:{cookie}})).status,404)
})
