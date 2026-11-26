import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { createChatStore } from '../dist/chat-core.mjs'
import { requestControl } from '../src/control/socket.mjs'
import { createDeliveries } from '../src/deliveries/service.mjs'
import { startWorkbench } from '../src/server.mjs'
import { initializeMasterKey } from '../src/storage/vault.mjs'
import { officeDeliveryFixture } from './fixtures/delivery-office-fixtures.mjs'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWNYZ/B3ncFfBggFADLGB23aTHV6AAAAAElFTkSuQmCC', 'base64')
const rawReply = '# 交付清单\r\n\r\n原样保留 café 🪴\n'
const nativeName = '交付 一览.txt'
const officeFormats = [['.docx', 'wordprocessingml.document'], ['.xlsx', 'spreadsheetml.sheet'], ['.pptx', 'presentationml.presentation']]
const nativeText = Buffer.from('\uFEFF中文\r\nLine two\r\n')
const quoted = tag => ({ 'if-match': `"${tag}"` })
const region = (sid, group, i, op) => `chats/${sid}/deliveries` + (group ? `/${group}/items/${i}/${op}` : '')

async function fixture(t) {
  const tmp = await realpath(tmpdir()), root = await mkdtemp(join(tmp, 'deva-delivery-http-'))
  assert.equal(dirname(root), tmp)
  const initial = await lstat(root)
  const home = join(root, 'data'), projects = join(root, 'projects'), alpha = join(projects, 'Alpha')
  const file = join(alpha, nativeName), outsideName = 'outside-private-qa.txt'
  const outside = join(root, outsideName), secret = join(alpha, '.hidden')
  const keyFile = join(root, 'master.key'), runDir = join(root, 'run')
  const password = randomBytes(24).toString('base64url'), vendorKey = randomBytes(24).toString('hex')
  const sid = randomUUID(), tool = 'native_delivery_qa', calls = []
  let app, cookie, csrf
  const vendor = createServer((req, res) => {
    calls.push({ url: req.url, authorized: req.headers.authorization === `Bearer ${vendorKey}`, noCookie: !req.headers.cookie })
    req.resume(); res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify({choices:[{index:0,delta:{content:rawReply},finish_reason:null}]})}\n\ndata: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`)
  })
  t.after(async () => {
    try { await app?.close() } finally {
      vendor.closeAllConnections(); if (vendor.listening) await new Promise(r => vendor.close(r))
      const now = await lstat(root); assert.equal(now.dev, initial.dev); assert.equal(now.ino, initial.ino)
      assert.equal(await realpath(root), root); await rm(root, { recursive: true, force: true })
    }
  })
  await Promise.all([mkdir(home, {mode:0o700}), mkdir(alpha, {recursive:true, mode:0o700})]); await initializeMasterKey(keyFile)
  const pic = join(alpha, 'pixel.png'), missing = join(alpha, 'later.txt'), link = join(alpha, 'alias.txt')
  await Promise.all([writeFile(file, nativeText), writeFile(pic, png), writeFile(outside, 'private'), writeFile(secret, 'private')]); await symlink(outside, link)
  const native = createChatStore({ dataDir: home }); const legacy = native.ensureSession(sid)
  const paths = [outside, file, pic, missing, secret, link]
  for (const [ext] of officeFormats) {
    const path = join(alpha, 'Report' + ext); await writeFile(path, officeDeliveryFixture(ext)); paths.push(path)
  }
  const rejected = join(alpha, 'wrong-type.xlsx'); await writeFile(rejected, 'ordinary text with a mismatched filename'); paths.push(rejected)
  legacy.title = 'Native test delivery'; legacy.messages = [
    { role:'assistant', content:[{type:'tool_use', id:tool, name:'present_files', input:{paths}}] },
    { role:'user', content:[{type:'tool_result', toolUseId:tool, content:'Delivered.'}] }
  ]; legacy.delivered = { [tool]: paths }; native.saveStrict(sid)
  vendor.listen(0, '127.0.0.1'); await once(vendor, 'listening')
  const origin = `http://127.0.0.1:${vendor.address().port}`
  const opts = { dataDir:home, keyFile, runDir, webDir:join(root,'assets'), port:0, businessOptions:{workspaceRoot:projects,allowedOrigins:[origin]} }
  const start = async () => { app=await startWorkbench(opts) }; await start()
  function call(path, method = 'GET', body, headers = {}) {
    return fetch(`${app.origin}/api/v1/${path}`, { method, headers:{ ...(cookie?{cookie}:{}),
      ...(body===undefined?{}:{'content-type':'application/json',origin:app.origin,...(csrf?{'x-deva-csrf':csrf}:{})}), ...headers },
      ...(body===undefined?{}:{body:JSON.stringify(body)}) })
  }
  async function data(path, method, body, status = 200) {
    const res = await call(path, method, body); const value = await res.json(); assert.equal(res.status,status,`HTTP ${status} expected; ${value.error ?? 'unexpected response'}`); return value
  }
  async function accept(response) {
    assert.equal(response.status,200); cookie=response.headers.get('set-cookie').split(';')[0]; csrf=(await response.json()).csrf
  }
  const { credential } = await requestControl({runDir,op:'claim'});await accept(await call('auth/claim','POST',{credential,password}))
  return { sid, home, file, root, outsideName, calls, call, data,
    async configure() {
      const provider = {id:'fixture-delivery',name:'Fixture delivery',kind:'custom',purpose:'llm',accent:'#205680',adapter:'openai',apiHost:origin+'/v1',enabled:true,models:[{id:'docs',name:'Docs',enabled:true}]}
      const current = await data('settings'); const saved = await data('settings','PATCH',{revision:current.revision,set:{models:{providers:[provider],activeModelId:'fixture-delivery:docs'}}})
      await data('provider-keys/'+provider.id,'PUT',{revision:saved.revision,value:vendorKey})
    },
    async restart() {
      await app.close(); await start(); assert.equal((await call('bootstrap')).status,401)
      cookie=csrf=undefined; await accept(await call('auth/login','POST',{password}))
    } }
}

test('deliveries authorize the actual native group and preserve item indices while hiding ungranted paths', { timeout:30_000 }, async t => {
  const f=await fixture(t), collection=region(f.sid)
  assert.equal((await f.data('bootstrap')).capabilities.deliveries,true)
  assert.equal((await f.call(collection,'GET',undefined,{cookie:''})).status,401)
  assert.equal((await f.call(collection+'?path=guessed')).status,400)
  const before=await readFile(join(f.home,'data','chats',f.sid+'.json'))
  const page=await f.data(collection);assert.equal(page.nextCursor,null);assert.deepEqual(page.candidates,[])
  assert.equal(page.groups.length,1)
  assert.ok(!JSON.stringify(page).includes(f.root)); assert.ok(!JSON.stringify(page).includes(f.outsideName)); assert.ok(!JSON.stringify(page).includes('.hidden'))
  const [g]=page.groups;assert.equal(g.origin,'desktop');assert.match(g.id,/^d_[a-f0-9]{32}$/)
  assert.deepEqual(g.items.map(x=>[x.index,x.name,x.status]),[[1,nativeName,'ready'],[2,'pixel.png','ready'],[3,'later.txt','missing'],
    ...officeFormats.map(([ext], i) => [i+6, 'Report'+ext, 'ready']), [9, 'wrong-type.xlsx', 'unsupported']])
  for (const [i,[ext,subtype]] of officeFormats.entries()) {
    const item = g.items.find(row => row.index === i+6)
    assert.equal(item.canDownload,true); assert.equal(item.canPreview,false)
    const reply = await f.call(region(f.sid,g.id,item.index,'download'),'GET',undefined,quoted(item.revision))
    assert.equal(reply.status,200); assert.equal(reply.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.'+subtype)
    assert.match(reply.headers.get('content-disposition'), /^attachment;/); assert.deepEqual(Buffer.from(await reply.arrayBuffer()), officeDeliveryFixture(ext))
    assert.equal((await f.call(region(f.sid,g.id,item.index,'preview'),'GET',undefined,quoted(item.revision))).status,415)
  }
  const [doc,pic]=g.items, url=region(f.sid,g.id,doc.index,'download')
  assert.match(doc.revision,/^[a-f0-9]{64}$/);assert.equal(doc.size,nativeText.length)
  assert.equal((await f.call(url)).status,428);assert.equal((await f.call(url,'GET',undefined,{'if-match':'*'})).status,400)
  // Creating an unrelated sibling must not invalidate the pinned project's file revision.
  await writeFile(join(dirname(f.file),'another.txt'),'another approved project file')
  const down=await f.call(url,'GET',undefined,quoted(doc.revision));assert.equal(down.status,200)
  assert.deepEqual(Buffer.from(await down.arrayBuffer()),nativeText);assert.match(down.headers.get('content-disposition'),/^attachment; .*filename\*=UTF-8''%E4%BA%A4/)
  assert.equal(down.headers.get('etag'),`"${doc.revision}"`);assert.equal(down.headers.get('x-content-type-options'),'nosniff');assert.equal(down.headers.get('cache-control'),'no-store')
  assert.equal((await f.call(region(f.sid,g.id,1,'preview'),'GET',undefined,quoted(doc.revision))).status,415)
  const preview=await f.call(region(f.sid,g.id,2,'preview'),'GET',undefined,quoted(pic.revision));assert.equal(preview.status,200)
  assert.match(preview.headers.get('content-disposition'),/^inline;/);assert.equal(preview.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await preview.arrayBuffer()),png)
  const {workspaces:[workspace]}=await f.data('workspaces');const locate=region(f.sid,g.id,1,'locate')
  assert.equal((await f.call(locate,'POST',{revision:doc.revision},{'x-deva-csrf':'wrong'})).status,401)
  assert.deepEqual(await f.data(locate,'POST',{revision:doc.revision}),{workspaceId:workspace.id,path:nativeName})
  const other=(await f.data('chats','POST',{})).session.id
  assert.equal((await f.call(region(other,g.id,1,'download'),'GET',undefined,quoted(doc.revision))).status,404)
  assert.equal((await f.call(region(f.sid,g.id,0,'download'),'GET',undefined,quoted(doc.revision))).status,404)
  await writeFile(f.file,'changed on disk');assert.equal((await f.call(url,'GET',undefined,quoted(doc.revision))).status,409)
  assert.deepEqual(await readFile(join(f.home,'data','chats',f.sid+'.json')),before); assert.equal(f.calls.length,0)
})

test('explicit reply export downloads the original confirmed text, is idempotent and survives a new owner login', { timeout:30_000 }, async t => {
  const f=await fixture(t); await f.configure(); const sid=(await f.data('chats','POST',{})).session.id
  const sent=await f.data(`chats/${sid}/turns`,'POST',{clientRequestId:'first',model:'fixture-delivery:docs',text:'Prepare the short document'},202)
  const collection=region(sid); let candidates
  for(let step=0;step<100;step++){ candidates=(await f.data(collection)).candidates;if(candidates.length)break;await delay(15) }
  assert.deepEqual(candidates,[{turnId:sent.turnId,messageIndex:1}]);const body={turnId:sent.turnId,format:'md'}
  assert.equal((await f.call(collection+'/reply','POST',body,{origin:'https://other.invalid'})).status,403)
  assert.equal((await f.call(collection+'/reply','POST',{...body,content:'client data'})).status,400)
  const first=await f.data(collection+'/reply','POST',body,201),dup=await f.data(collection+'/reply','POST',body)
  assert.equal(first.created,true);assert.equal(dup.created,false);assert.deepEqual(dup.group,first.group)
  const [info]=first.group.items;assert.equal(info.name,'reply-001.md');assert.equal(info.size,Buffer.byteLength(rawReply));assert.equal(first.group.turnId,sent.turnId);assert.equal(first.group.messageIndex,1)
  const url=region(sid,first.group.id,0,'download')
  const head=await f.call(url,'HEAD',undefined,quoted(info.revision));assert.equal(head.status,200);assert.equal(+head.headers.get('content-length'),info.size);assert.equal(await head.text(),'')
  await f.restart();const page=await f.data(collection);assert.deepEqual(page.groups,[first.group]);assert.ok(!JSON.stringify(page).includes('café'))
  const get=await f.call(url,'GET',undefined,quoted(info.revision));assert.equal(get.status,200);assert.equal(await get.text(),rawReply)
  assert.equal((await f.call(region(f.sid,first.group.id,0,'download'),'GET',undefined,quoted(info.revision))).status,404)
  assert.deepEqual(f.calls,[{url:'/v1/chat/completions',authorized:true,noCookie:true}])
})

test('list pages bound cold file inspections and reject stale or cross-session cursors', async () => {
  let inspected=0
  let records=Array.from({length:4},(_,i)=>({id:'d_'+`${i+1}`.padStart(32,'0'),origin:'desktop',entries:Array.from({length:9},(_,index)=>({index,path:'fixture'}))}))
  const api=createDeliveries({turns:{deliverySnapshot(){return {records,candidates:[]}}},files:{async inspect(){inspected++;return {name:'doc.txt',kind:'text',size:1,status:'ready',revision:'r_'+'1'.repeat(64),canPreview:false,canLocate:true,canDownload:true}}}})
  const first=await api.list('A',null);assert.equal(first.groups.length,2);assert.equal(inspected,18);assert.ok(first.nextCursor)
  const last=await api.list('A',first.nextCursor);assert.equal(last.groups.length,2);assert.equal(last.nextCursor,null);assert.equal(inspected,36)
  await assert.rejects(api.list('B',first.nextCursor),{status:409});records=records.slice(1);await assert.rejects(api.list('A',first.nextCursor),{status:409})
})
