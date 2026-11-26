import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { requestControl } from '../src/control/socket.mjs'
import { startWorkbench } from '../src/server.mjs'
import { initializeMasterKey } from '../src/storage/vault.mjs'

test('human file operations require a registered project, explicit writes, an owner session and the current revision', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'deva-wfiles-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const work = join(root, 'work'); const dataDir = join(root, 'data'); const keyFile = join(root, 'key')
  await mkdir(join(work,'Alpha','目录'),{recursive:true}); await mkdir(join(work,'Beta'),{recursive:true})
  const target = join(work,'Alpha','目录','笔记 1.txt'); const sibling = join(work,'Beta','笔记 1.txt')
  await writeFile(target, '\uFEFF初稿\r\n',{ mode: 0o640 }); await writeFile(sibling, 'other project\n'); await symlink(sibling, join(work,'Alpha','outside'))
  await initializeMasterKey(keyFile)
  const opts = { dataDir, keyFile, runDir:join(root,'run'), webDir:join(root,'web'),port:0,businessOptions:{workspaceRoot:work} }
  let app = await startWorkbench(opts); t.after(()=>app.close())
  let cookie,csrf; const password = randomBytes(24).toString('hex')
  async function call(route, method = 'GET', body, extra = {}) {
    const res = await fetch(`${app.origin}/api/v1/${route}`, {method,
      headers:{ ...(cookie?{cookie}:{}),...(method==='GET'?{}:{origin:app.origin,'content-type':'application/json',...(csrf?{'x-deva-csrf':csrf}:{})}),...extra },
      ...(body===undefined?{}:{body:JSON.stringify(body)}) })
    return {status:res.status,body:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]}
  }
  async function signin(first) {
    const credential=first?(await requestControl({runDir:opts.runDir,op:'claim'})).credential:undefined
    const r=await call('auth/'+(first?'claim':'login'),'POST',{password,...(first?{credential}:{})}); assert.equal(r.status,200);cookie=r.cookie;csrf=r.body.csrf
  }
  await signin(true)
  assert.equal((await call('bootstrap')).body.capabilities.workspaceFiles,true)
  const all=(await call('workspaces')).body.workspaces; assert.deepEqual(all.map(p=>p.name),['Alpha','Beta'])
  const route=`workspaces/${all[0].id}/`; const path='目录/笔记 1.txt'
  const rootListing=await call(route+'list','POST',{path:''}); assert.equal(rootListing.status,200); assert.deepEqual(rootListing.body.entries.map(f=>f.name),['目录'])
  const read=async()=>call(route+'read','POST',{path}); const initial=await read();assert.equal(initial.status,200);assert.equal(initial.body.content,'\uFEFF初稿\r\n');assert.equal(initial.body.writable,false)
  const put=(content,revision,extra)=>call(route+'file','PUT',{path,content,revision},extra)
  assert.deepEqual((await put('manual',initial.body.revision)).body,{error:'workspace_read_only'})
  assert.equal((await call(route+'read','POST',{path:'../Beta/笔记 1.txt'})).status,400)
  assert.equal((await call(route+'read','POST',{path:'outside'})).status,403)
  assert.equal((await call(route+'read','POST',{path},{'x-deva-csrf':'wrong'})).status,401)
  assert.equal((await call(route+'list','POST',{path:''},{origin:'https://foreign.example'})).status,403)
  await app.close();app=await startWorkbench({...opts,businessOptions:{workspaceRoot:work,workspaceWritable:true}})
  assert.equal((await read()).status,401);await signin(false)
  const enabled=await read();assert.equal(enabled.body.writable,true);const current=enabled.body.revision
  const writes=await Promise.all(['覆盖一\r\n','覆盖二\r\n'].map(s=>put(s,current)));assert.deepEqual(writes.map(r=>r.status).sort(),[200,409])
  const winner=writes.findIndex(r=>r.status===200), expected=['覆盖一\r\n','覆盖二\r\n'][winner]
  assert.equal(await readFile(target,'utf8'),expected); assert.equal(await readFile(sibling,'utf8'),'other project\n')
  const known=await read();await writeFile(target,'Changed by the owner outside the workbench.');assert.equal((await put('lost update',known.body.revision)).status,409)
  assert.equal(await readFile(target,'utf8'),'Changed by the owner outside the workbench.')
  await chmod(target,0o440);assert.equal((await read()).body.writable,false)
})
