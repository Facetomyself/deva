// Run inside the shipped, resource-limited native worker image on ephemeral QA machines.
// This program opens only synthetic documents in the fixed viewer. It does not run a shell.
import assert from 'node:assert/strict'
import { lstat, mkdtemp, readFile, realpath, rmdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { startTerminalServer } from '../src/server.mjs'
import { createTerminalClient } from '../src/client.mjs'

const group='/sys/fs/cgroup/', root='/run/deva-pty-control'
const field=async file=>(await readFile(group+file,'utf8')).trim()
const stats=async()=>Object.fromEntries((await field('memory.events')).split('\n').map(row=>row.split(/\s+/)))
let stage='verify confinement',dir,identity,server,failed=false
const clients=[]
try {
  assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');assert.equal(process.geteuid(),1000)
  assert.equal(await field('memory.max'),String(128*1024*1024));assert.equal(await field('pids.max'),'64')
  const [quota,period]=(await field('cpu.max')).split(/\s+/).map(Number);assert.ok(period>0 && quota===period)
  const base=await stats();assert.equal(await realpath(root),root)
  dir=await mkdtemp(join(root,'load-'));identity=await lstat(dir);assert.equal(dirname(dir),root)
  server=await startTerminalServer({runDir:dir});const worker=createTerminalClient({runDir:dir});assert.equal(await worker.probe(),true)
  stage='open four genuine native PTYs'
  for(let i=0;i<4;i++) {
    const banner=`Synthetic checklist ${i}`
    // Close to the source budget; different real bytes and hundreds of real pages per viewer.
    const text=[banner,...Array.from({length:1300},(_,n)=>`Row ${String(n+1).padStart(4,'0')} | 0123456789012345678901234567890`)].join('\n')
    assert.ok(Buffer.byteLength(text)>50*1024 && Buffer.byteLength(text)<=65536)
    const frames=[], exits=[]
    const v=await worker.open({text,cols:80,rows:12,onScreen:s=>frames.push(s),onExit:e=>exits.push(e)})
    clients.push({v,frames,exits});assert.equal(v.screen.lines[0],banner)
  }
  stage='reject overflow and keep four active viewers usable'
  await assert.rejects(worker.open({text:'no fifth child',cols:80,rows:12,onScreen(){},onExit(){}}))
  await Promise.all(clients.map(async ({v,frames,exits})=>{
    await v.input('page-down');assert.equal(frames.at(-1).top,12)
    await v.resize(64,8);assert.deepEqual([frames.at(-1).cols,frames.at(-1).rows],[64,8]);assert.deepEqual(exits,[])
  }))
  const peak=Number(await field('memory.peak'));assert.ok(Number.isFinite(peak) && peak>0)
  const pids=await field('pids.current');assert.ok(Number(pids)>=5 && Number(pids)<=64)
  stage='observe four real exits and reclaim native capacity'
  await Promise.all(clients.map(async ({v,exits})=>{await v.input('quit');assert.deepEqual(exits,[{code:0,signal:null,reason:'quit'}])}))
  assert.equal(await worker.probe(),true);const after=await stats();assert.equal(after.oom_kill,base.oom_kill);assert.equal(after.oom,base.oom)
  console.log(`PASS native PTY capacity: four isolated text snapshots, fifth refused, four confirmed kernel resizes and exits, capacity restored; cgroup peak ${peak} bytes, ${pids} tasks (threads included), no OOM.`)
} catch {failed=true;console.error(`Native PTY capacity check failed at ${stage}`)}
finally {
  try {
    await Promise.allSettled(clients.map(({v})=>v.dispose()));await server?.close()
    if(dir){const current=await lstat(dir);assert.equal(current.dev,identity.dev);assert.equal(current.ino,identity.ino);assert.equal(await realpath(dir),dir);assert.equal(dirname(dir),root);await rmdir(dir)}
  } catch {failed=true;console.error('Native PTY capacity cleanup was not confirmed')}
}
if(failed)process.exitCode=1
