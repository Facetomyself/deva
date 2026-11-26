// Run only on an ephemeral native linux/amd64 CI runner, after building this exact tag.
// No host ports, Docker socket mount, workspace writes or live vendor account.
import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const image = 'deva-workbench:focus-verify'
const probe = fileURLToPath(new URL('./container-focus-probe.mjs',import.meta.url))
const tag = 'deva-focus-ci-' + randomBytes(10).toString('hex'), labelName = 'deva.workbench.focus-ci'
const label = `${labelName}=${tag}`
const data = `${tag}-data`, keys = `${tag}-keys`
const vols = new Set(), containers = new Set()
let root, parent, identity, stage = 'validation'
function check(condition) { if (!condition) throw Error('fixed QA assertion failed') }
function docker(args, input, timeout = 45_000) {
  return new Promise((ok, fail) => {
    const child = execFile('docker', args, {encoding:'utf8',timeout,maxBuffer:2*1024*1024}, (err, out, stderr) => {
      if (!err) return ok(out.trim())
      const reason = /session-workspace-container: ([a-z-]{1,48}) failed/u.exec(stderr)?.[1]
      // Never log raw docker args, claim links, passwords, cookies, file contents or upstream output.
      fail(Error(reason ? `container assertion: ${reason}` : `docker ${args[0]} failed`))
    })
    child.stdin.on('error',()=>{}); child.stdin.end(input === undefined ? undefined : JSON.stringify(input))
  })
}
async function inspect(kind, name) {
  const value=JSON.parse(await docker([kind,'inspect',name]))
  check(value.length===1)
  return value[0]
}
async function verifyLabel(kind, name) {
  const value=await inspect(kind,name), key = kind==='container' ? value.Config.Labels : value.Labels
  check(key?.[labelName]===tag && (kind==='container' ? value.Name === '/'+name : value.Name === name))
  return value
}
async function removeContainer(name) {
  const original=await verifyLabel('container',name)
  if (original.State.Running) await docker(['stop','--time','12',name])
  const stopped=await verifyLabel('container',name)
  check(original.Id===stopped.Id && stopped.State.Running===false)
  await docker(['rm',name]); containers.delete(name)
}
async function clean() {
  let error = false
  for (const name of [...containers]) { try { await removeContainer(name) } catch { error=true } }
  for (const name of [...vols]) {
    try { await verifyLabel('volume',name); await docker(['volume','rm',name]); vols.delete(name) } catch { error=true }
  }
  if (root && identity && !containers.size) {
    try {
      const current=await lstat(root)
      check(current.isDirectory() && current.dev===identity.dev && current.ino===identity.ino && dirname(root)===parent && await realpath(root)===root)
      await rm(root,{recursive:true,force:false})
    } catch { error=true }
  }
  check(!error && !vols.size && !containers.size)
}
function restrictions(name) {
  return ['--name',name,'--label',label,'--user','1000:1000','--network','none','--read-only','--cap-drop','ALL',
    '--security-opt','no-new-privileges:true','--pids-limit','128','--memory','512m','--cpus','2',
    '--tmpfs','/tmp:rw,nosuid,nodev,noexec,mode=1777,size=64m','--tmpfs','/run/deva:rw,nosuid,nodev,noexec,mode=0700,uid=1000,gid=1000']
}
async function createVolume(name) {
  check(!(await docker(['volume','ls','-q','--filter',`name=^${name}$`])))
  await docker(['volume','create','--label',label,name]);vols.add(name);await verifyLabel('volume',name)
}
async function runPhase(phase,input) {
  const name=tag+'-'+phase
  check(!(await docker(['ps','-aq','--filter',`name=^/${name}$`])))
  const sources=['--mount',`type=volume,src=${data},dst=/data`,'--mount',`type=volume,src=${keys},dst=/keys,readonly`,
    '--mount',`type=bind,src=${probe},dst=/opt/deva/ci-focus.mjs,readonly`]
  if (phase!=='unmounted') sources.push('--mount',`type=bind,src=${join(root,'projects')},dst=/workspaces,readonly`,'-e','DEVA_WORKSPACE_ROOT=/workspaces')
  const cid=await docker(['run','-d','--init',...restrictions(name),...sources,image,'serve'])
  containers.add(name)
  const info=await verifyLabel('container',name)
  check(info.Id===cid && info.HostConfig.NetworkMode==='none' && info.HostConfig.ReadonlyRootfs && info.HostConfig.Privileged===false &&
    info.Config.User==='1000:1000' && info.HostConfig.CapDrop.includes('ALL') && Object.values(info.NetworkSettings.Ports??{}).every(x=>!x?.length))
  check(info.Mounts.find(m=>m.Destination==='/keys')?.RW===false && info.Mounts.find(m=>m.Destination==='/data')?.RW===true)
  check(phase==='unmounted' ? !info.Mounts.some(m=>m.Destination==='/workspaces') : info.Mounts.find(m=>m.Destination==='/workspaces')?.RW===false)
  const answer=JSON.parse(await docker(['exec','-i',name,'node','/opt/deva/ci-focus.mjs',phase],input))
  await removeContainer(name)
  return answer
}
async function main() {
  check(process.argv.length===2 && process.platform==='linux' && process.arch==='x64')
  const built=await inspect('image',image);check(built.Architecture==='amd64' && built.Os==='linux')
  console.log(`Workbench image ${built.Id} · linux/amd64 · ${built.Size} bytes`)
  parent=await realpath(tmpdir());root=await mkdtemp(join(parent,'deva-focus-image-'));identity=await lstat(root)
  check(root.startsWith(join(parent,'deva-focus-image-')) && dirname(root)===parent && (identity.mode&0o777)===0o700 && !probe.includes(',') && !root.includes(','))
  const projects=join(root,'projects');await mkdir(projects,{mode:0o755});await chmod(projects,0o755)
  for(const n of ['Alpha','Beta']){const dir=join(projects,n);await mkdir(dir,{mode:0o755});await chmod(dir,0o755);const doc=join(dir,'readme.txt');await writeFile(doc,'Synthetic project fixture\n',{mode:0o644,flag:'wx'});await chmod(doc,0o644)}
  await createVolume(data);await createVolume(keys)
  stage='provision-key';const init=tag+'-init';check(!(await docker(['ps','-aq','--filter',`name=^/${init}$`])))
  await docker(['run','--rm',...restrictions(init),'--mount',`type=volume,src=${data},dst=/data,readonly`,'--mount',`type=volume,src=${keys},dst=/keys`,image,'init-key','--if-missing'])
  const args={password:randomBytes(24).toString('base64url'),sid:randomUUID(),roleSid:randomUUID()}
  stage='seed';const seeded=await runPhase('seed',args)
  stage='recreate';const newLogin=await runPhase('recreate',{...args,...seeded})
  stage='unmounted';const last=await runPhase('unmounted',{...args,...seeded,...newLogin});check(last.ok===true)
}
let passed=false
try { await main(); passed=true } catch(error) { console.error(`Workbench image session workspaces failed (${stage}): ${error.message.startsWith('container assertion:')?error.message:'verification failed'}`) }
try { await clean() } catch { passed=false;console.error('Image QA cleanup was not confirmed') }
if (passed) console.log('PASS: native amd64 packaged CLI, non-root, no network or ports; explicit and inherited bindings, persistence across recreation, revoked mount and detachment; QA resources removed.')
else process.exitCode=1
