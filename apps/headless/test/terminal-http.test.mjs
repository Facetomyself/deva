import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { appendFile, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { startTerminalServer } from '../../terminal-worker/src/server.mjs'
import { requestControl } from '../src/control/socket.mjs'
import { startWorkbench } from '../src/server.mjs'
import { initializeMasterKey } from '../src/storage/vault.mjs'

const profiles = '/api/v1/terminal/profiles'
const api = '/api/v1/'
const lines = Array.from({ length: 44 }, (_, i) => `Line ${String(i + 1).padStart(2, '0')} | snapshot café · 中文`)
const text = lines.join('\n')
const viewerScript = fileURLToPath(new URL('../../terminal-worker/src/viewer.mjs', import.meta.url))
const statusOnly = { available: false, profiles: [] }
const unsupportedHost = process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)
const sameNode = (a, b) => Boolean(a && b && a.dev === b.dev && a.ino === b.ino)
const info = path => lstat(path, { bigint: true }).catch(error => {
  if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error
  return null
})

async function fixture(t) {
  const base = await realpath(tmpdir()), root = await mkdtemp(join(base, 'deva-http-terminal-'))
  const identity = await info(root)
  assert.ok(identity.isDirectory() && identity.uid === BigInt(process.geteuid()))
  assert.equal(identity.mode & 0o777n, 0o700n)
  assert.equal(dirname(root), base)
  assert.equal(await realpath(root), root)
  const workspaceRoot = join(root, 'workspaces'), terminalRunDir = join(root, 'terminal')
  const project = join(workspaceRoot, 'Alpha'), webDir = join(root, 'web')
  const options = { dataDir: join(root, 'data'), runDir: join(root, 'control'), keyFile: join(root, 'key'),
    webDir, host: '127.0.0.1', port: 0 }
  let app, worker
  t.after(async () => {
    try {
      try { await app?.close() } finally { await worker?.close() }
    } finally {
      const current = await info(root)
      assert.ok(sameNode(current, identity) && current.isDirectory() && current.uid === identity.uid && current.mode === identity.mode,
        'recursive cleanup is confined to the original private fixture')
      assert.equal(await realpath(root), root)
      await rm(root, { recursive: true })
    }
  })
  await Promise.all([
    mkdir(join(project, 'notes'), { recursive: true }), mkdir(join(workspaceRoot, 'Beta'), { recursive: true }),
    mkdir(webDir), mkdir(terminalRunDir, { mode: 0o700 }), initializeMasterKey(options.keyFile)
  ])
  const path = 'notes/guide.txt', file = join(project, path)
  await Promise.all([
    writeFile(file, text, { flag: 'wx', mode: 0o444 }),
    writeFile(join(project, 'changed.txt'), text, { flag: 'wx', mode: 0o600 }),
    writeFile(join(project, 'replaced.txt'), text, { flag: 'wx', mode: 0o600 }),
    writeFile(join(project, 'credentials.txt'), 'ineligible synthetic value', { flag: 'wx', mode: 0o600 }),
    writeFile(join(webDir, 'index.html'), '<!doctype html><title>Terminal HTTP fixture</title>'),
    writeFile(join(webDir, 'workbench.js'), 'export {}'),
    writeFile(join(webDir, 'manifest.json'), JSON.stringify({ entry: { file: 'workbench.js', isEntry: true } }))
  ])
  return {
    path, file, project, runDir: options.runDir, socketPath: join(terminalRunDir, 'viewer.sock'),
    async start(configured) {
      app = await startWorkbench({ ...options, businessOptions: { workspaceRoot, ...(configured ? { terminalRunDir } : {}) } })
      assert.equal(app.origin, `http://127.0.0.1:${app.address.port}`)
      return app
    },
    async mount() { worker = await startTerminalServer({ runDir: terminalRunDir }); return worker }
  }
}

function requests(app, login) {
  return async (path, { method = 'GET', body, raw, headers: overrides } = {}) => {
    const headers = new Headers(login ? { cookie: login.cookie } : {})
    if (method !== 'GET') {
      headers.set('origin', app.origin)
      headers.set('content-type', 'application/json')
      if (login) headers.set('x-deva-csrf', login.csrf)
    }
    for (const [name, value] of Object.entries(overrides ?? {})) {
      if (value === undefined) headers.delete(name)
      else headers.set(name, value)
    }
    const res = await fetch(app.origin + path, { method, headers, body: raw ?? JSON.stringify(body),
      redirect: 'error', signal: AbortSignal.timeout(6_000) })
    return { status: res.status, body: await res.json(), headers: res.headers }
  }
}
const post = (call, path, body, options) => call(path, { method: 'POST', body, ...options })

function expect(reply, status, detail) {
  assert.equal(reply.status, status, detail ?? JSON.stringify(reply.body))
  assert.equal(reply.headers.get('cache-control'), 'no-store')
  return reply.body
}
function denied(reply, status, error) {
  assert.deepEqual(expect(reply, status, error), { error })
}

async function owner(call, op, body) {
  const reply = await post(call, `${api}auth/${op}`, body)
  const { csrf } = expect(reply, 200, `owner ${op}`)
  const cookie = reply.headers.get('set-cookie')?.split(';', 1)[0]
  assert.match(cookie, /^deva-workbench-local=[A-Za-z0-9_-]{43}$/)
  assert.match(csrf, /^[A-Za-z0-9_-]{43}$/)
  return { cookie, csrf }
}

async function workspaces(call) {
  const { workspaces: projects } = expect(await call(`${api}workspaces`), 200)
  assert.deepEqual(projects.map(({ name }) => name), ['Alpha', 'Beta'])
  const [alpha, beta] = projects.map(({ id }) => id)
  assert.match(alpha, /^w_[a-f0-9]{32}$/)
  assert.match(beta, /^w_[a-f0-9]{32}$/)
  return { workspace: `${api}workspaces/${alpha}`, other: `${api}workspaces/${beta}` }
}

async function selection(call, workspace, path) {
  const { revision } = expect(await post(call, `${workspace}/read`, { path }), 200)
  assert.match(revision, /^r_[a-f0-9]{64}$/)
  return { profile: 'text-view', path, revision, cols: 80, rows: 12 }
}

const screen = (cols, rows, top) => ({ cols, rows, top, left: 0, totalLines: lines.length, lines: lines.slice(top, top + rows) })

async function open(call, workspace, body) {
  const opened = expect(await post(call, `${workspace}/terminals`, body), 201, 'open with the real locked native addon')
  assert.match(opened.id, /^pt_[a-f0-9]{32}$/)
  assert.deepEqual(opened, { id: opened.id, cursor: 1, sequence: 0, screen: screen(80, 12, 0), exit: null })
  return { root: `${workspace}/terminals/${opened.id}`, id: opened.id, cursor: opened.cursor }
}

async function activePoll(call, route, after) {
  const pending = post(call, `${route}/events`, { after, waitMs: 4_000 })
  void pending.catch(() => {})
  // Observe the occupied HTTP poll slot instead of assuming the request arrived after a sleep.
  for (let tries = 0; tries < 12; tries++) {
    const probe = await post(call, `${route}/events`, { after, waitMs: 0 })
    if (probe.status === 429) {
      denied(probe, 429, 'terminal_busy')
      return { pending }
    }
    assert.deepEqual(expect(probe, 200), { cursor: after, reset: false, events: [] })
    await delay(10)
  }
  assert.fail('the long poll never occupied the terminal HTTP poll slot')
}

async function checkBoundary(call, app, workspace, other, selected, view, secondLogin) {
  const start = `${workspace}/terminals`, { root, id, cursor } = view
  const alternate = requests(app, secondLogin), events = { after: cursor, waitMs: 0 }
  denied(await requests(app)(profiles), 401, 'auth')
  denied(await call(profiles, { headers: { origin: 'https://foreign.invalid' } }), 403, 'origin')
  const wrongProfileMethod = await post(call, profiles, {})
  denied(wrongProfileMethod, 405, 'method')
  assert.equal(wrongProfileMethod.headers.get('allow'), 'GET')
  denied(await call(`${profiles}?extra=1`), 400, 'unexpected_query')
  denied(await post(call, start, selected, { headers: { origin: undefined } }), 403, 'origin')
  denied(await post(call, start, selected, { headers: { 'x-deva-csrf': secondLogin.csrf } }), 401, 'auth')
  denied(await post(call, `${start}?extra=1`, selected), 400, 'unexpected_query')
  denied(await post(call, `${root}/events?extra=1`, events), 400, 'unexpected_query')
  denied(await post(call, start, undefined, { raw: '{' }), 400, 'invalid_json')
  denied(await post(call, start, []), 400, 'invalid_json')
  denied(await post(call, start, selected, { headers: { 'content-type': 'text/plain' } }), 415, 'json_required')
  denied(await post(call, start, { ...selected, path: '' }), 400, 'terminal_invalid')
  denied(await post(call, start, { ...selected, revision: null }), 400, 'terminal_invalid')
  for (const [field, value] of Object.entries({ command: 'echo fixture', cwd: '.', env: {} })) {
    denied(await post(call, start, { ...selected, [field]: value }), 400, 'terminal_invalid')
  }
  const ineligible = await selection(call, workspace, 'credentials.txt')
  denied(await post(call, start, ineligible), 403, 'terminal_source_denied')
  denied(await post(call, `${root}/shell`, {}), 404, 'not_found')

  for (const [op, body] of Object.entries({ input: { sequence: 1, key: 'page-down' },
    resize: { sequence: 1, cols: 64, rows: 8 }, events, dispose: {} })) {
    const endpoint = `${root}/${op}`
    const wrongMethod = await call(endpoint)
    denied(wrongMethod, 405, 'method')
    assert.equal(wrongMethod.headers.get('allow'), 'POST')
    denied(await post(call, endpoint, body, { headers: { 'x-deva-csrf': undefined } }), 401, 'auth')
    denied(await post(call, endpoint, body, { headers: { origin: 'https://foreign.invalid' } }), 403, 'origin')
    denied(await post(alternate, endpoint, body), 404, 'terminal_not_found')
    denied(await post(call, `${other}/terminals/${id}/${op}`, body), 404, 'terminal_not_found')
  }
  denied(await post(call, `${root}/input`, { sequence: 1, key: '\x1b[A' }), 400, 'terminal_invalid')
  denied(await post(call, `${root}/input`, { sequence: 1, data: 'echo fixture' }), 400, 'terminal_invalid')
  denied(await post(call, `${root}/resize`, { sequence: 1, cols: '64', rows: 8 }), 400, 'terminal_invalid')
  denied(await post(call, `${root}/events`, { ...events, waitMs: 5_001 }), 400, 'terminal_invalid')
  denied(await post(call, `${root}/dispose`, { force: true }), 400, 'terminal_invalid')
}

async function useViewer(call, { root, cursor }) {
  const action = async (op, body) => expect(await post(call, `${root}/${op}`, body), 200)
  const events = async (after = 0) => expect(await post(call, `${root}/events`, { after, waitMs: 0 }), 200)
  const event = (seq, contents) => ({ seq, type: 'screen', screen: contents })
  const page = { sequence: 1, key: 'page-down' }
  const receipt = await action('input', page)
  assert.deepEqual(receipt, { sequence: 1 })
  assert.deepEqual(await action('input', page), receipt)
  denied(await post(call, `${root}/input`, { ...page, key: 'up' }), 409, 'terminal_sequence')
  assert.deepEqual(await events(cursor), { cursor: 2, reset: false, events: [event(2, screen(80, 12, 12))] })
  assert.deepEqual(await action('resize', { sequence: 2, cols: 64, rows: 8 }), { sequence: 2 })
  assert.deepEqual(await events(2), { cursor: 3, reset: false, events: [event(3, screen(64, 8, 12))] })
  const quit = { sequence: 3, key: 'quit' }
  assert.deepEqual(await action('input', quit), { sequence: 3 })
  assert.deepEqual(await action('input', quit), { sequence: 3 })
  const exit = { code: 0, signal: null, reason: 'quit' }
  const final = { seq: 4, type: 'exit', exit }
  const replay = { cursor: 4, reset: false, events: [event(1, screen(80, 12, 0)), event(2, screen(80, 12, 12)),
    event(3, screen(64, 8, 12)), final] }
  assert.deepEqual(await events(3), { cursor: 4, reset: false, events: [final] })
  assert.deepEqual(await events(), replay)
  assert.deepEqual(await events(), replay)
  assert.deepEqual(await events(4), { cursor: 4, reset: false, events: [] })
  assert.deepEqual(await action('dispose', {}), { closed: true, exit })
  assert.deepEqual(await action('dispose', {}), { closed: true, exit })
  denied(await post(call, `${root}/events`, { after: 0, waitMs: 0 }), 404, 'terminal_not_found')
}

async function checkSourceLoss(call, workspace, name, mutate) {
  const selected = await selection(call, workspace, name)
  const { root, cursor } = await open(call, workspace, selected)
  const { pending } = await activePoll(call, root, cursor)
  await mutate()
  denied(await pending, 409, 'terminal_source_changed')
  denied(await post(call, `${root}/events`, { after: 0, waitMs: 0 }), 409, 'terminal_source_changed')
  denied(await post(call, `${workspace}/terminals`, selected), 409, 'terminal_source_changed')
}

async function ownNativeViewers() {
  const children = (await readFile(`/proc/self/task/${process.pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean)
  const viewers = []
  for (const pid of children) {
    const proc = `/proc/${pid}`
    try {
      const procNode = await info(proc)
      const argv = (await readFile(`${proc}/cmdline`, 'utf8')).split('\0')
      if (argv[2] !== viewerScript) continue
      assert.deepEqual(argv, [process.execPath, '--no-addons', viewerScript, ''])
      const cwd = await readlink(`${proc}/cwd`)
      const cwdNode = await info(cwd)
      assert.match(cwd, /^\/dev\/shm\/deva-terminal-viewer-[^/]+$/)
      if (!sameNode(await info(proc), procNode) || !cwdNode) continue
      assert.ok(cwdNode.isDirectory() && cwdNode.uid === BigInt(process.geteuid()) && (cwdNode.mode & 0o777n) === 0o700n)
      viewers.push({ proc, procNode, cwd, cwdNode })
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error
    }
  }
  return viewers
}

async function checkShutdown(app, worker, socketPath, call, workspace, selected) {
  for (let tries = 0; tries < 100 && (await ownNativeViewers()).length; tries++) await delay(10)
  assert.deepEqual(await ownNativeViewers(), [], 'earlier terminal operations released every native child')
  const { root, cursor } = await open(call, workspace, selected)
  const { pending } = await activePoll(call, root, cursor)
  const viewers = await ownNativeViewers()
  assert.equal(viewers.length, 1)
  const { proc, procNode, cwd, cwdNode } = viewers[0]
  assert.ok(sameNode(await info(cwd), cwdNode))
  const socket = await info(socketPath), control = await info(app.controlPath)
  assert.ok(socket.isSocket() && socket.uid === BigInt(process.geteuid()) && (socket.mode & 0o777n) === 0o600n)
  assert.ok(control.isSocket() && control.uid === socket.uid)

  await app.close()
  denied(await pending, 503, 'terminal_unavailable')
  assert.equal(await info(app.controlPath), null)
  assert.ok(sameNode(await info(socketPath), socket), 'Workbench closes its viewer without taking down the worker listener')
  // Workbench aborts the Unix peer; the worker can reap the child asynchronously.
  for (let tries = 0; tries < 100 && (sameNode(await info(proc), procNode) || await info(cwd)); tries++) await delay(10)
  assert.equal(sameNode(await info(proc), procNode), false, 'the fixture PTY child was reaped')
  assert.equal(await info(cwd), null, 'the exact native staging directory was removed')
  await worker.close()
  assert.equal(await info(socketPath), null)
}

test('worker interruption reports an unknown exit and a fresh worker never inherits the old PTY', {
  timeout: 24_000, skip: unsupportedHost && 'native Linux PTY required'
}, async t => {
  const f = await fixture(t), worker = await f.mount(), app = await f.start(true)
  const anonymous = requests(app), { credential } = await requestControl({ runDir:f.runDir, op:'claim' })
  const auth = await owner(anonymous,'claim',{credential,password:randomBytes(24).toString('base64url')})
  const call = requests(app,auth), { workspace } = await workspaces(call), selected = await selection(call,workspace,f.path)
  const view = await open(call,workspace,selected), wait = await activePoll(call,view.root,view.cursor)
  await worker.close()
  const ended = expect(await wait.pending,200)
  assert.deepEqual(ended.events,[{seq:2,type:'exit',exit:{code:null,signal:null,reason:'worker-lost'}}])
  assert.deepEqual(expect(await post(call,`${view.root}/events`,{after:ended.cursor,waitMs:0}),200).events,[])
  assert.deepEqual(expect(await call(profiles),200),{...statusOnly,reason:'unavailable'})
  assert.deepEqual(expect(await call('/readyz'),200),{status:'ready'})
  await f.mount();const fresh=await open(call,workspace,selected)
  assert.notEqual(fresh.id,view.id)
  assert.deepEqual(expect(await post(call,`${view.root}/dispose`,{}),200),{closed:true,exit:{code:null,signal:null,reason:'worker-lost'}})
  assert.deepEqual(expect(await post(call,`${fresh.root}/input`,{sequence:1,key:'quit'}),200),{sequence:1})
  assert.deepEqual(expect(await post(call,`${fresh.root}/events`,{after:1,waitMs:0}),200).events,[{seq:2,type:'exit',exit:{code:0,signal:null,reason:'quit'}}])
  assert.deepEqual(expect(await call(`${api}chats`),200),{sessions:[]})
})

test('optional terminal HTTP stays isolated and serves a real login-scoped read-only PTY', {
  timeout: 25_000, skip: unsupportedHost && 'the locked native viewer requires Linux x64 or arm64'
}, async t => {
  const fixturePaths = await fixture(t)
  const { path, file, project, runDir, socketPath } = fixturePaths
  const before = await info(file), bytes = await readFile(file)
  let app = await fixturePaths.start(false)
  let anonymous = requests(app)
  assert.deepEqual(expect(await anonymous(`${api}auth/state`), 200), { claimed: false })
  denied(await anonymous(profiles), 401, 'auth')
  const password = randomBytes(24).toString('base64url')
  const { credential } = await requestControl({ runDir, op: 'claim' })
  const claim = await owner(anonymous, 'claim', { credential, password })
  let call = requests(app, claim)
  const boot = expect(await call(`${api}bootstrap`), 200).capabilities
  assert.equal(boot.terminalViewer, false)
  assert.equal(boot.textChat, true)
  assert.deepEqual(expect(await call(profiles), 200), { ...statusOnly, reason: 'unconfigured' })
  assert.deepEqual(expect(await call('/readyz'), 200), { status: 'ready' })
  assert.deepEqual(expect(await call(`${api}chats`), 200), { sessions: [] })
  const unconfigured = await workspaces(call)
  denied(await post(call, `${unconfigured.workspace}/terminals`, await selection(call, unconfigured.workspace, path)),
    503, 'terminal_unavailable')
  await app.close()

  // Same claimed installation, initially with the private runtime directory but no worker socket.
  app = await fixturePaths.start(true)
  anonymous = requests(app)
  assert.equal(await info(socketPath), null)
  denied(await requests(app, claim)(`${api}bootstrap`), 401, 'auth')
  const first = await owner(anonymous, 'login', { password })
  call = requests(app, first)
  const [offline, ready, authState, projects, chats] = await Promise.all([
    call(profiles), anonymous('/readyz'), anonymous(`${api}auth/state`), workspaces(call), call(`${api}chats`)
  ])
  assert.deepEqual(expect(offline, 200), { ...statusOnly, reason: 'unavailable' })
  assert.deepEqual(expect(ready, 200), { status: 'ready' })
  assert.deepEqual(expect(authState, 200), { claimed: true })
  assert.deepEqual(expect(chats, 200), { sessions: [] })
  const { workspace, other } = projects
  const selected = await selection(call, workspace, path)
  denied(await post(call, `${workspace}/terminals`, selected), 503, 'terminal_unavailable')

  const worker = await fixturePaths.mount()
  const second = await owner(anonymous, 'login', { password })
  assert.ok(first.cookie !== second.cookie && first.csrf !== second.csrf, 'independent owner logins')
  const alternate = requests(app, second)
  assert.equal(expect(await call(`${api}bootstrap`), 200).capabilities.terminalViewer, true)
  const available = { available: true, profiles: [{ id: 'text-view', label: 'Read-only text viewer' }], reason: null }
  assert.deepEqual(expect(await call(profiles), 200), available)
  assert.deepEqual(expect(await alternate(profiles), 200), available)
  const view = await open(call, workspace, selected)
  await checkBoundary(call, app, workspace, other, selected, view, second)
  await useViewer(call, view)
  await checkSourceLoss(call, workspace, 'changed.txt', () => appendFile(join(project, 'changed.txt'), '\nowner edit'))
  await checkSourceLoss(call, workspace, 'replaced.txt', async () => {
    const target = join(project, 'replaced.txt'), replacement = join(project, 'new.txt')
    const original = await info(target)
    await writeFile(replacement, await readFile(target), { flag: 'wx', mode: 0o600 })
    assert.ok(!sameNode(await info(replacement), original))
    assert.equal(dirname(target), project)
    assert.ok(sameNode(await info(target), original))
    await rename(replacement, target)
  })

  const revoked = await open(alternate, workspace, selected)
  const { pending } = await activePoll(alternate, revoked.root, revoked.cursor)
  assert.deepEqual(expect(await post(alternate, `${api}auth/logout`, {}), 200), { ok: true })
  denied(await pending, 404, 'terminal_not_found')
  denied(await post(alternate, `${revoked.root}/events`, { after: 0, waitMs: 0 }), 401, 'auth')
  denied(await post(call, `${revoked.root}/events`, { after: 0, waitMs: 0 }), 404, 'terminal_not_found')
  assert.deepEqual(expect(await call(`${api}chats`), 200), { sessions: [] })
  await checkShutdown(app, worker, socketPath, call, workspace, selected)
  const after = await info(file)
  assert.ok(sameNode(after, before))
  assert.equal(after.mode, before.mode)
  assert.equal(after.mtimeNs, before.mtimeNs)
  assert.deepEqual(await readFile(file), bytes)
})
