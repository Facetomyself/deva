// QA-only file mounted read-only in the production image; never shipped or served by the app.
// This process talks to the actual CLI server over loopback and its private claim socket.
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { requestControl } from '/opt/deva/apps/headless/src/control/socket.mjs'

const origin = 'http://127.0.0.1:8787'
const opaque = /^w_[0-9a-f]{32}$/u, revision = /^[0-9a-f]{64}$/u
let stage = 'startup'
function check(value) { if (!value) throw Error('verification failed') }
async function fromInput() {
  const chunks = []; let size = 0
  for await (const chunk of process.stdin) { size += chunk.length; check(size < 8192); chunks.push(chunk) }
  return JSON.parse(Buffer.concat(chunks).toString())
}
async function main() {
  const [phase] = process.argv.slice(2), input = await fromInput()
  check(['seed','recreate','unmounted'].includes(phase))
  check(process.getuid() === 1000 && process.arch === 'x64' && process.versions.node.split('.')[0] === '22')
  const status = await readFile('/proc/self/status','utf8')
  check(/^NoNewPrivs:\s+1$/m.test(status) && /^CapEff:\s+0+$/m.test(status))
  let ready = false
  for (let tries = 0; tries < 90 && !ready; tries++) {
    try { const r = await fetch(origin + '/readyz',{signal:AbortSignal.timeout(1000)}); ready = r.status === 200; await r.body?.cancel() }
    catch { /* A just-started image may not yet own its socket. */ }
    if (!ready) await delay(150)
  }
  check(ready)
  let cookie, csrf
  async function req(path, method = 'GET', body, extra = {}, expected = 200) {
    const r = await fetch(origin + '/api/v1/' + path, {method, redirect:'error', headers:{...(cookie ? {cookie}:{}),
      ...(body === undefined ? {} : {origin,'content-type':'application/json', ...(csrf ? {'x-deva-csrf':csrf}:{})}), ...extra},
      ...(body === undefined ? {} : {body:JSON.stringify(body)}), signal:AbortSignal.timeout(5000)})
    const value = await r.json(); check(r.status === expected)
    return {value, cookie:r.headers.get('set-cookie')?.split(';',1)[0]}
  }
  stage = 'owner-session'
  let auth
  if (phase === 'seed') {
    const {credential} = await requestControl({runDir:'/run/deva',op:'claim'})
    auth = await req('auth/claim','POST',{credential,password:input.password})
  } else {
    const stale = await req('bootstrap','GET',undefined,{cookie:input.oldCookie},401); check(stale.value.error === 'auth')
    auth = await req('auth/login','POST',{password:input.password})
  }
  cookie = auth.cookie; csrf = auth.value.csrf; check(!!cookie && !!csrf)
  stage = 'catalog-and-bootstrap'
  const {capabilities} = (await req('bootstrap')).value
  check(capabilities.sessionWorkspaces && capabilities.workspaceFiles === (phase !== 'unmounted') && !capabilities.gitInspect)
  const projects = (await req('workspaces')).value.workspaces
  const read = async sid => (await req('chats/'+sid+'/workspace')).value
  const patch = async (sid,rev,id,status=200) => (await req('chats/'+sid+'/workspace','PATCH',{revision:rev,workspaceId:id},{},status)).value
  const native = async sid => JSON.parse(await readFile('/data/data/chats/'+sid+'.json','utf8'))
  let result
  if (phase === 'seed') {
    check(projects.length === 2)
    const a = projects.find(s=>s.name==='Alpha')?.id, b = projects.find(s=>s.name==='Beta')?.id
    check(opaque.test(a) && opaque.test(b) && a !== b)
    stage = 'manual-binding'
    await req('chats','POST',{sessionId:input.sid}); const before = await read(input.sid)
    check(before.workspace === null && revision.test(before.revision))
    await req(`workspaces/${a}/list`,'POST',{path:''}); check((await read(input.sid)).revision === before.revision)
    const changed = await patch(input.sid,before.revision,a)
    check(changed.workspace.id === a && changed.workspace.name === 'Alpha' && changed.workspace.state === 'available' && changed.workspace.source === 'manual')
    check((await patch(input.sid,before.revision,b,409)).error === 'workspace_conflict')
    check((await native(input.sid)).focusRoot === '/workspaces/Alpha')
    stage = 'role-inheritance'
    const {role}=(await req('personas','POST',{name:'Fixture editor',prompt:'Write clearly.',enabled:true,workspaceId:b})).value
    await req('chats','POST',{sessionId:input.roleSid,personaId:role.id})
    const scoped = await read(input.roleSid)
    check(scoped.workspace.id === b && scoped.workspace.name === 'Beta' && scoped.workspace.source === 'role')
    check((await native(input.roleSid)).focusRoot === '/workspaces/Beta')
    result = {oldCookie:cookie, a, b, rev:changed.revision, roleRev:scoped.revision}
  } else if (phase === 'recreate') {
    stage = 'durable-mounted-scopes'
    const a = await read(input.sid), b = await read(input.roleSid)
    check(projects.length === 2 && a.revision === input.rev && b.revision === input.roleRev)
    check(a.workspace.id === input.a && a.workspace.name === 'Alpha' && a.workspace.source === 'manual' && a.workspace.state === 'available')
    check(b.workspace.id === input.b && b.workspace.name === 'Beta' && b.workspace.source === 'role' && b.workspace.state === 'available')
    const restored = (await req('chats/'+input.sid)).value.state
    check(restored.workspaceRevision === input.rev && restored.messages.length === 0 && restored.lastTurn === null)
    check(!JSON.stringify([restored,a,b]).includes('/workspaces/'))
    result = {oldCookie:cookie}
  } else {
    stage = 'unmounted-scope-and-detach'
    const lost = await read(input.sid); check(!projects.length && lost.workspace.id === input.a && lost.workspace.state === 'unavailable' && lost.workspace.name === null)
    const cleared = await patch(input.sid,lost.revision,null); check(cleared.workspace === null && cleared.revision !== lost.revision)
    check((await native(input.sid)).focusRoot === null)
    const b = await read(input.roleSid); check(b.workspace.id === input.b && b.workspace.state === 'unavailable' && b.revision === input.roleRev)
    result = {ok:true}
  }
  // The parent captures stdout privately and uses it only for the next phase; the CI log never receives it.
  process.stdout.write(JSON.stringify(result))
}
main().catch(()=>{ console.error(`session-workspace-container: ${stage} failed`); process.exitCode=1 })
