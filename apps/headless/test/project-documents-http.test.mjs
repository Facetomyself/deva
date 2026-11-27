import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { request as requestHttp } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { requestControl } from '../src/control/socket.mjs'
import { startWorkbench } from '../src/server.mjs'
import { initializeMasterKey } from '../src/storage/vault.mjs'

const native = { skip: process.platform !== 'linux', timeout: 45_000 }
const intentId = /^di_[a-f0-9]{32}$/u
const revision = /^r_[a-f0-9]{64}$/u
const missingWorkspace = 'w_' + '0'.repeat(32)
const fullText = '\uFEFF项目文档\r\n第二行\r\n'
const existingText = 'original draft\n'
const directory = 'Notes'
const route = wid => `workspaces/${wid}/document-intents`
const action = (wid, intent, verb) => `${route(wid)}/${intent.id}/${verb}`

async function fixture(t) {
  const parent = await realpath(tmpdir()), root = await mkdtemp(join(parent, 'deva-doc-http-'))
  const original = await lstat(root)
  const opts = { dataDir: join(root, 'data'), runDir: join(root, 'run'), keyFile: join(root, 'master.key'), webDir: join(root, 'no-web'), port: 0 }
  const mount = join(root, 'projects'), notes = join(mount, 'Alpha', directory), beta = join(mount, 'Beta')
  const password = randomBytes(24).toString('base64url')
  let app
  t.after(async () => {
    try { await app?.close() } finally {
      const now = await lstat(root)
      assert.equal(dirname(root), parent)
      assert.equal(await realpath(root), root)
      assert.deepEqual([now.dev, now.ino], [original.dev, original.ino])
      await rm(root, { recursive: true })
    }
  })
  await mkdir(notes, { recursive: true, mode: 0o700 })
  await mkdir(beta, { mode: 0o700 })
  await writeFile(join(notes, 'original.txt'), existingText, { mode: 0o600 })
  await writeFile(join(beta, 'outside.txt'), 'sibling project\n', { mode: 0o600 })
  await symlink(beta, join(mount, 'Alpha', 'outside'))
  await initializeMasterKey(opts.keyFile)

  async function boot(businessOptions = {}, observe) {
    await app?.close()
    const opened=observe && (await import('../src/business/handlers.mjs')).openBusiness
    app = await startWorkbench({ ...opts, businessOptions, ...(observe ? {businessFactory:async options=>{
      const business=await opened(options)
      return {...business,handle(req,res,context){observe(req.method,req.url);return business.handle(req,res,context)}}
    }} : {}) })
  }
  async function request(path, { who, method = 'POST', body = {}, headers, raw } = {}) {
    const r = await fetch(`${app.origin}/api/v1/${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(8_000),
      headers: { ...(who ? { cookie: who.cookie, 'x-deva-csrf': who.csrf } : {}),
        ...(method === 'GET' ? {} : { origin: app.origin, 'content-type': 'application/json' }), ...headers },
      body: method === 'GET' ? undefined : raw ?? JSON.stringify(body),
    })
    assert.match(r.headers.get('content-type') ?? '', /^application\/json\b/u)
    return { status: r.status, body: await r.json(), cookie: r.headers.get('set-cookie')?.split(';', 1)[0] }
  }
  async function signedIn(claim = false) {
    const body = claim ? { password, credential: (await requestControl({ runDir: opts.runDir, op: 'claim' })).credential } : { password }
    const reply = await request(claim ? 'auth/claim' : 'auth/login', { body })
    assert.equal(reply.status, 200)
    assert.match(reply.cookie, /^deva-workbench-local=[A-Za-z0-9_-]{43}$/u)
    assert.equal(typeof reply.body.csrf, 'string')
    return { cookie: reply.cookie, csrf: reply.body.csrf }
  }
  async function get(path, who) {
    return want(request(path, { who, method: 'GET' }), 200)
  }
  return { opts, mount, notes, beta, boot, request, signedIn, get, get origin(){return app.origin} }
}

async function want(pending, status, exact) {
  const r = await pending
  assert.equal(r.status, status, r.body?.error ?? 'unexpected HTTP status')
  if (exact !== undefined) assert.deepEqual(r.body, exact)
  return r.body
}

async function ids(f, login) {
  const { workspaces } = await f.get('workspaces', login)
  assert.deepEqual(workspaces.map(row => row.name), ['Alpha', 'Beta'])
  return workspaces.map(row => row.id)
}

function documents(f, who, wid) {
  const post = (path, body = {}, extra) => f.request(path, { who, body, ...extra })
  return {
    post,
    async prepare(name, dir = directory) {
      const receipt = await want(post(route(wid), { directory: dir, name }), 201)
      assert.deepEqual(Object.keys(receipt).sort(), ['id', 'path', 'ttlMs'])
      assert.match(receipt.id, intentId)
      assert.equal(receipt.path, dir ? `${dir}/${name}` : name)
      assert.ok(Number.isSafeInteger(receipt.ttlMs) && receipt.ttlMs > 0)
      return receipt
    },
    invoke: (intent, verb, body, extra) => post(action(wid, intent, verb), body, extra),
    status: (intent, state, rev = null) => want(post(action(wid, intent, 'status')), 200, { state, path: intent.path, revision: rev }),
    read: path => post(`workspaces/${wid}/read`, { path }),
  }
}

async function created(doc, intent, content) {
  const value = await want(doc.invoke(intent, 'create', { content }), 201)
  assert.match(value.revision, revision)
  assert.deepEqual(value, { created: true, path: intent.path, revision: value.revision, replayed: false })
  return value
}

async function assertSafeFile(path, text) {
  const metadata = await lstat(path)
  assert.equal(metadata.isFile(), true)
  assert.equal(metadata.nlink, 1)
  assert.equal(metadata.mode & 0o7111, 0)
  assert.deepEqual(await readFile(path), Buffer.from(text))
}

const readOnly = { error: 'document_read_only' }
const notFound = { error: 'document_intent_missing' }
const authError = { error: 'auth' }

test('HTTP creation has a separate, default-off grant from registered browse and edit', native, async t => {
  const f = await fixture(t)
  await f.boot()
  let who = await f.signedIn(true)
  assert.deepEqual(await f.get('workspaces', who), { workspaces: [] })
  let boot = await f.get('bootstrap', who)
  assert.equal(boot.capabilities.workspaceFiles, false)
  assert.equal(boot.capabilities.workspaceDocumentCreate, false)
  const prepare = wid => f.request(route(wid), { who, body: { directory, name: 'denied.md' } })
  await want(prepare(missingWorkspace), 403, readOnly)
  for (const writable of [false, true]) {
    await f.boot({ workspaceRoot: f.mount, workspaceWritable: writable })
    who = await f.signedIn()
    const [alpha] = await ids(f, who)
    boot = await f.get('bootstrap', who)
    assert.equal(boot.capabilities.workspaceFiles, true)
    assert.equal(boot.capabilities.workspaceDocumentCreate, false)
    const doc = documents(f, who, alpha)
    const current = await want(doc.read('Notes/original.txt'), 200)
    assert.equal(current.writable, writable)
    const content = 'edit-only fixture\n'
    const saved = await doc.post(`workspaces/${alpha}/file`, { path: 'Notes/original.txt', content, revision: current.revision }, { method: 'PUT' })
    assert.equal(saved.status, writable ? 200 : 403)
    await assertSafeFile(join(f.notes, 'original.txt'), writable ? content : existingText)
    await want(prepare(alpha), 403, readOnly)
    for (const verb of ['status', 'create', 'cancel']) {
      await want(doc.invoke({ id: `di_${'0'.repeat(32)}` }, verb, verb === 'create' ? { content } : {}), 403, readOnly)
    }
    assert.deepEqual(await readdir(f.notes), ['original.txt'])
  }
  const untouched = { ...f.opts, dataDir: join(dirname(f.opts.dataDir), 'unopened-data'), runDir: join(dirname(f.opts.runDir), 'unopened-run') }
  for (const businessOptions of [{ workspaceCreate: true, workspaceWritable: true }, { workspaceCreate: true, workspaceRoot: f.mount }]) {
    await assert.rejects(async () => {
      const unexpected = await startWorkbench({ ...untouched, businessOptions })
      await unexpected.close()
    }, /Document creation requires an explicit writable workspace root/u)
    await assert.rejects(lstat(untouched.dataDir), { code: 'ENOENT' })
    await assert.rejects(lstat(untouched.runDir), { code: 'ENOENT' })
  }
})

test('native create intents bind login, workspace, request shape and verified filesystem revision', native, async t => {
  const f = await fixture(t)
  await f.boot({ workspaceRoot: f.mount, workspaceWritable: true, workspaceCreate: true })
  const a = await f.signedIn(true), b = await f.signedIn()
  assert.notEqual(a.cookie, b.cookie)
  assert.notEqual(a.csrf, b.csrf)
  const [alpha, beta] = await ids(f, a)
  assert.equal((await f.get('bootstrap', a)).capabilities.workspaceDocumentCreate, true)
  const doc = documents(f, a, alpha), other = documents(f, b, alpha)
  const prep = { directory, name: '项目笔记.md' }
  const start = extra => doc.post(route(alpha), prep, extra)
  await want(start({ who: undefined }), 401, authError)
  await want(start({ headers: { 'x-deva-csrf': b.csrf } }), 401, authError)
  await want(start({ headers: { origin: 'https://other.invalid' } }), 403, { error: 'origin' })
  await want(start({ headers: { origin: '' } }), 403, { error: 'origin' })
  await want(doc.post(route(missingWorkspace), prep), 404, { error: 'workspace_unavailable' })
  await want(doc.post(`${route(alpha)}?version=1`, prep), 400)
  await want(start({ method: 'GET' }), 405)
  await want(start({ raw: '{broken' }), 400)
  for (const raw of [
    '{"directory":"Notes","name":"unused.md","na\\u006de":"different.md"}',
    '{"directory":{"other":"private"},"directory":"Notes","name":"unwanted.md"}',
  ]) await want(start({raw}),400,{error:'invalid_json'})
  for (const extra of [{ root: f.mount }, { path: 'Notes/original.txt' }, { revision: `r_${'1'.repeat(64)}` }, { version: 1 }, { grant: beta }]) {
    await want(doc.post(route(alpha), { ...prep, ...extra }), 400)
  }
  for (const name of ['../n.md', '/n.md', 'a/b.md', 'a\\b.md', '.concealed.md', 'script.sh', 'setup.exe', 'n.md\u0000']) {
    await want(other.post(route(alpha), { directory, name }), 400, { error: 'document_invalid' })
  }
  for (const dir of ['../Beta', f.notes, 'Notes/../Notes']) {
    await want(other.post(route(alpha), { directory: dir, name: 'denied.md' }), 400, { error: 'document_invalid' })
  }
  await want(doc.post(route(alpha), { directory: 'Missing/Child', name: 'denied.md' }), 404, { error: 'workspace_unavailable' })
  await want(doc.post(route(alpha), { directory: 'outside', name: 'denied.md' }), 403, { error: 'document_unsafe' })
  await want(doc.post(route(alpha), { directory, name: 'original.txt' }), 409, { error: 'document_exists' })
  await symlink(join(f.beta, 'outside.txt'), join(f.notes, 'symlink.md'))
  await want(doc.post(route(alpha), { directory, name: 'symlink.md' }), 403, { error: 'document_unsafe' })
  await chmod(join(f.notes, 'original.txt'), 0o700)
  await want(doc.post(route(alpha), { directory, name: 'original.txt' }), 409, { error: 'document_exists' })
  await chmod(join(f.notes, 'original.txt'), 0o600)

  const { session } = await want(doc.post('chats'), 200)
  const scope = `chats/${session.id}/workspace`, prefs = `chats/${session.id}/preferences`
  const baseline = await Promise.all([f.get(scope, a), f.get(prefs, a), f.get('settings', a)])
  assert.equal(baseline[0].workspace, null)
  const intent = await doc.prepare(prep.name)
  await doc.status(intent, 'prepared')
  await assert.rejects(lstat(join(f.notes, prep.name)), { code: 'ENOENT' })
  for (const verb of ['status', 'cancel', 'create']) {
    const body = verb === 'create' ? { content: 'other login' } : {}
    await want(doc.invoke(intent, verb, body, { who: undefined }), 401, authError)
    await want(doc.invoke(intent, verb, body, { who: b }), 404, notFound)
    await want(doc.invoke(intent, verb, body, { headers: { 'x-deva-csrf': b.csrf } }), 401, authError)
    await want(doc.invoke(intent, verb, body, { headers: { origin: 'https://other.invalid' } }), 403, { error: 'origin' })
    await want(doc.post(action(beta, intent, verb), body), 404, notFound)
    await want(doc.invoke(intent, verb, { ...body, revision: 'caller-controlled' }), 400)
  }
  await want(doc.invoke(intent,'create',{}, {raw:'{"content":"not approved","con\\u0074ent":"replacement"}'}),400,{error:'invalid_json'})
  await want(doc.invoke(intent, 'create', { content: null }), 400)
  await want(doc.invoke(intent, 'create', { content: fullText, path: 'Notes/original.txt' }), 400, { error: 'document_invalid' })
  await want(doc.invoke(intent, 'create', { content: 'binary\u0000' }), 400)
  await want(doc.invoke(intent, 'create', { content: '字'.repeat(700_000) }), 413, { error: 'document_limit' })
  await want(doc.post(action(alpha, intent, 'create'), { content: fullText }, { method: 'DELETE' }), 405)
  await doc.status(intent, 'prepared')
  const receipt = await created(doc, intent, fullText)
  const disk = join(f.notes, prep.name)
  await assertSafeFile(disk, fullText)
  const read = await want(doc.read(intent.path), 200)
  assert.equal(read.content, fullText)
  assert.equal(read.revision, receipt.revision)
  await doc.status(intent, 'created', receipt.revision)
  await want(doc.invoke(intent, 'create', { content: fullText }), 200, { ...receipt, replayed: true })
  await want(doc.invoke(intent, 'create', { content: 'attempted overwrite' }), 409)
  await assertSafeFile(disk, fullText)
  await want(doc.post(`workspaces/${alpha}/file`, { path: intent.path }, { method: 'DELETE' }), 405)
  await want(doc.post(`workspaces/${alpha}/mkdir`, { path: 'new-directory' }), 404)
  await want(doc.post(`workspaces/${alpha}/file`, { path: 'Notes/no-intent.txt', content: 'not created', revision: receipt.revision }, { method: 'PUT' }), 409, { error: 'conflict' })

  // Replacing a receipt's native entry with *identical bytes* still invalidates the original receipt.
  await rename(disk, join(f.notes, 'retired.md'))
  await writeFile(disk, fullText, { flag: 'wx', mode: 0o600 })
  await want(doc.invoke(intent, 'status'), 409, { error: 'document_changed' })
  await want(doc.invoke(intent, 'create', { content: fullText }), 409, { error: 'document_changed' })
  assert.notEqual((await want(doc.read(intent.path), 200)).revision, receipt.revision)
  await assertSafeFile(disk, fullText)

  const empty = await doc.prepare('empty.txt', '')
  const emptyReceipt = await created(doc, empty, '')
  await assertSafeFile(join(f.mount, 'Alpha', 'empty.txt'), '')
  assert.equal((await want(doc.read(empty.path), 200)).revision, emptyReceipt.revision)
  await want(doc.invoke(empty, 'cancel'), 200, { closed: true })
  await assertSafeFile(join(f.mount, 'Alpha', 'empty.txt'), '')
  const canceled = await doc.prepare('abandoned.md')
  await want(doc.invoke(canceled, 'cancel'), 200, { closed: true })
  await want(doc.invoke(canceled, 'status'), 404, notFound)
  await want(doc.invoke(canceled, 'create', { content: 'canceled' }), 404, notFound)
  await assert.rejects(lstat(join(f.notes, 'abandoned.md')), { code: 'ENOENT' })

  // Document operations did not grant model/tool or workspace-binding authority to the conversation.
  await want(doc.post(`chats/${session.id}/turns`, { clientRequestId: randomUUID(), text: 'Create a file.', model: null,
    tools: [{ name: 'workspaceDocumentCreate', intent: intent.id }] }), 400, { error: 'invalid_send' })
  assert.deepEqual(await Promise.all([f.get(scope, a), f.get(prefs, a), f.get('settings', a)]), baseline)
  assert.deepEqual((await f.get(`chats/${session.id}`, a)).state.messages, [])
  assert.deepEqual(await readdir(f.beta), ['outside.txt'])
  assert.deepEqual(await readFile(join(f.beta, 'outside.txt')), Buffer.from('sibling project\n'))
  assert.deepEqual((await readdir(f.notes)).sort(), ['original.txt', 'retired.md', 'symlink.md', prep.name].sort())

  // Restoring the original project inode after a binding change does not revive a stale receipt.
  const lost = await doc.prepare('moved-project.txt')
  await created(doc, lost, 'durable data')
  const project = join(f.mount, 'Alpha'), moved = join(f.mount, 'Alpha-moved')
  await rename(project, moved)
  try {
    await want(doc.invoke(lost, 'status'), 409, { error: 'document_changed' })
  } finally { await rename(moved, project) }
  await want(doc.invoke(lost, 'create', { content: 'durable data' }), 409, { error: 'document_changed' })
  await assertSafeFile(join(f.notes, 'moved-project.txt'), 'durable data')
  await want(doc.invoke(lost, 'cancel'), 200, { closed: true })

  const revoked = await doc.prepare('logged-out.md')
  await want(doc.post('auth/logout'), 200, { ok: true })
  await want(doc.invoke(revoked, 'create', { content: 'stale login' }), 401, authError)
  await want(doc.invoke(revoked, 'status', {}, { who: b }), 404, notFound)
  await want(doc.invoke(revoked, 'cancel', {}, { who: await f.signedIn() }), 404, notFound)
  await assert.rejects(lstat(join(f.notes, 'logged-out.md')), { code: 'ENOENT' })
})

test('revoking the original login while the create body is still arriving leaves the project untouched', native, async t => {
  const f=await fixture(t), started=Promise.withResolvers();let watched
  await f.boot({workspaceRoot:f.mount,workspaceWritable:true,workspaceCreate:true},(method,url)=>{
    if (method==='POST' && url===watched) started.resolve()
  })
  const owner=await f.signedIn(true),peer=await f.signedIn(),[wid]=await ids(f,owner), doc=documents(f,owner,wid)
  const intent=await doc.prepare('slow.txt');watched='/api/v1/'+action(wid,intent,'create')
  const response=Promise.withResolvers()
  const req=requestHttp(f.origin+watched,{method:'POST',agent:false,signal:AbortSignal.timeout(9000),headers:{
    cookie:owner.cookie,origin:f.origin,'content-type':'application/json','x-deva-csrf':owner.csrf,
  }},res=>{
    const chunks=[];res.on('data',b=>chunks.push(b));res.once('error',response.reject)
    res.once('end',()=>response.resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks))}))
  });req.once('error',response.reject);t.after(()=>req.destroy());void response.promise.catch(()=>{})
  req.write('{"content":"first')
  await Promise.race([started.promise,response.promise.then(()=>assert.fail('create answered before the body was complete'))])
  await want(doc.post('auth/logout'),200,{ok:true})
  req.end(' second"}')
  assert.deepEqual(await response.promise,{status:401,body:{error:'auth'}})
  await want(doc.invoke(intent,'status',{}, {who:peer}),404,notFound)
  assert.deepEqual(await readdir(f.notes),['original.txt'])
})

test('Linux native publication fences canonical collisions, directory replacement and lost permission', native, async t => {
  const f = await fixture(t)
  await f.boot({ workspaceRoot: f.mount, workspaceWritable: true, workspaceCreate: true })
  const a = await f.signedIn(true), b = await f.signedIn(), [alpha] = await ids(f, a)
  const doc = documents(f, a, alpha), other = documents(f, b, alpha)
  for (const [name, alternate] of [['same.md', 'same.md'], ['Case.txt', 'case.txt'], ['Café.md', 'Cafe\u0301.md']]) {
    const first = await doc.prepare(name), second = await other.prepare(alternate)
    assert.notEqual(first.id, second.id)
    await Promise.all([doc.status(first, 'prepared'), other.status(second, 'prepared')])
    const submissions = [[doc, first, 'first\r\n'], [other, second, 'second\n']]
    const results = await Promise.all(submissions.map(([owner, intent, content]) => owner.invoke(intent, 'create', { content })))
    assert.deepEqual(results.map(value => value.status).sort(), [201, 409])
    const winner = results.findIndex(value => value.status === 201)
    const [owner, intent, text] = submissions[winner]
    const committed = results[winner].body
    assert.match(committed.revision, revision)
    await owner.status(intent, 'created', committed.revision)
    assert.deepEqual(results[1 - winner].body, { error: 'document_exists' })
    for (const [owner, prepared] of submissions) await want(owner.invoke(prepared, 'cancel'), 200, { closed: true })
    await assertSafeFile(join(f.notes, winner === 0 ? name : alternate), text)
    if (name !== alternate) await assert.rejects(lstat(join(f.notes, winner === 0 ? alternate : name)), { code: 'ENOENT' })
  }
  const occupied = await doc.prepare('late.md')
  await writeFile(join(f.notes, 'late.md'), 'native publisher first\n', { flag: 'wx', mode: 0o600 })
  await want(doc.invoke(occupied, 'create', { content: 'never replace' }), 409, { error: 'document_exists' })
  await assertSafeFile(join(f.notes, 'late.md'), 'native publisher first\n')
  await want(doc.invoke(occupied, 'cancel'), 200, { closed: true })

  const oldNotes = join(f.mount, 'Alpha', 'Moved')
  const originalEntries = (await readdir(f.notes)).sort()
  const swapped = await doc.prepare('swapped.md')
  const renamed = await doc.prepare('renamed.md')
  await rename(f.notes, oldNotes)
  await want(doc.invoke(renamed, 'create', { content: 'wrong directory' }), 409, { error: 'document_changed' })
  await mkdir(f.notes, { mode: 0o700 })
  await want(doc.invoke(swapped, 'create', { content: 'wrong inode' }), 409, { error: 'document_changed' })
  assert.deepEqual(await readdir(f.notes), [])
  assert.deepEqual((await readdir(oldNotes)).sort(), originalEntries)

  const chmodded = await doc.prepare('private.txt')
  await chmod(f.notes, 0o500)
  try {
    await want(doc.invoke(chmodded, 'create', { content: 'chmod in between' }), 403, readOnly)
    await want(doc.post(route(alpha), { directory, name: 'blocked.txt' }), 403, readOnly)
    assert.deepEqual(await readdir(f.notes), [])
  } finally { await chmod(f.notes, 0o700) }
})
