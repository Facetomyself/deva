import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { promises as fs } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { createChatStore } from '../dist/chat-core.mjs'
import { openUploadStore } from '../src/attachments/upload-store.mjs'
import { openWorkspaceCatalog } from '../src/business/workspace-catalog.mjs'
import { WORKSPACE_META } from '../src/chat/session-workspace.mjs'
import { createTextTurns } from '../src/chat/text-turns.mjs'
import { createEventJournal, SESSIONS_SCOPE } from '../src/events/index.mjs'
import { acquireWriterLock } from '../src/runtime/writer-lock.mjs'

const model = 'fixture:chat'
const pattern = /^[0-9a-f]{64}$/
const error = (status, code) => ({ status, code, message: code })
const storageError = error(503, 'chat_storage_unconfirmed')
const conflict = error(409, 'workspace_conflict')
const unavailable = error(404, 'workspace_unavailable')
const options = { timeout: 10_000 }
const sentinel = 'workspace file contents that must never reach the model'
const request = (sid, clientRequestId, extra) => ({ sid, clientRequestId, text: 'A plain question', model, ...extra })
const expected = (id, name, source) => ({ id, name, state: name === null ? 'unavailable' : 'available', source })
const withoutBinding = ({ focusRoot, [WORKSPACE_META]: _, ...rest }) => rest

function respond(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Fixture answer' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
}

async function fixture(t) {
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'deva-session-workspace-'))
  const dataDir = join(root, 'home')
  const mount = join(root, 'projects')
  const aRoot = join(mount, 'alpha')
  const bRoot = join(mount, 'beta')
  const chats = join(dataDir, 'data', 'chats')
  await fs.mkdir(aRoot, { recursive: true })
  await fs.mkdir(bRoot)
  await fs.writeFile(join(aRoot, 'scope-note.txt'), sentinel)
  const catalog = openWorkspaceCatalog({ root: mount, privateRoots: [dataDir] })
  const ids = () => Object.fromEntries(catalog.list().map(({ id, name }) => [name, id]))
  const { alpha: a, beta: b } = ids()
  const release = acquireWriterLock(dataDir)
  const failures = [], calls = [], reads = [], lookups = []
  const server = createServer((req, res) => { void (async () => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    calls.push(JSON.parse(Buffer.concat(chunks)))
    respond(res)
  })().catch(err => { failures.push(err); res.destroy() }) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  const role = { id: 'analyst', enabled: true, name: 'Analyst', prompt: 'Evidence-based presentation.', workspaceId: a }
  let beforeProvider, afterGrant
  const settings = { async getProvider(id) {
    reads.push(id)
    await beforeProvider?.()
    return { id, adapter: 'openai', apiHost: `${origin}/v1`, purpose: 'llm', enabled: true,
      models: [{ id: 'chat', enabled: true }] }
  } }
  function withWorkspace(id, action) {
    lookups.push(id)
    const row = catalog.list().find(item => item.id === id)
    if (!row) return undefined
    const pin = catalog.pinProject(row.id)
    try {
      const grant = Object.freeze({ id: row.id, name: row.name, root: join(mount, row.name) })
      const result = action(grant)
      pin.assertCurrent()
      afterGrant?.(grant)
      return result
    } finally { pin.close() }
  }
  const uploads = await openUploadStore({ dataDir })
  let journal, turns
  function open(withCatalog = true) {
    journal = createEventJournal()
    turns = createTextTurns({ dataDir, settings, journal, allowedOrigins: [origin], version: 'fixture', uploads, deliveries: true,
      resolveRole: id => id === role.id ? role : null, ...(withCatalog ? { withWorkspace } : {}) })
  }
  async function close() {
    await turns.close()
    journal.close()
  }
  t.after(async () => {
    await close()
    await uploads.close()
    release()
    catalog.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    assert.equal(await fs.realpath(root), root)
    assert.ok(root.startsWith(`${await fs.realpath(tmpdir())}/deva-session-workspace-`))
    await fs.rm(root, { recursive: true, force: true })
    assert.deepEqual(failures, [])
  })
  open()
  const native = sid => join(chats, `${sid}.json`)
  return {
    get turns() { return turns }, get seq() { return journal.snapshot(SESSIONS_SCOPE).cursor.seq },
    async restart(catalogEnabled) { await close(); open(catalogEnabled) },
    dataDir, chats, aRoot, bRoot, a, b, ids, mount, role, calls, reads, lookups, native, uploads,
    beforeProvider: action => { beforeProvider = action }, afterGrant: action => { afterGrant = action },
    disk: async sid => JSON.parse(await fs.readFile(native(sid), 'utf8'))
  }
}

function watch(turns, sid) {
  const done = Promise.withResolvers()
  const events = []
  const { subscription } = turns.attach(sid, { onEvent(item) { events.push(item); if (item.event.type === 'done') done.resolve(item) } })
  assert.equal(subscription.status, 'subscribed')
  return { done: done.promise, close: subscription.close, events }
}

async function turn(fx, request) {
  const w = watch(fx.turns, request.sid)
  try {
    const receipt = await fx.turns.send(request)
    assert.equal((await w.done).turnId, receipt.turnId)
    assert.equal(fx.turns.snapshot(request.sid).state.lastTurn.status, 'completed')
    return { receipt, events: w.events }
  } finally { w.close() }
}

function privateFree(value, fx) {
  const json = JSON.stringify(value)
  for (const field of ['focusRoot', WORKSPACE_META, fx.aRoot, fx.bRoot, sentinel]) assert.equal(json.includes(field), false, field)
}

test('binding is native, durable, path-free, quiet on no-op and preserves history, prefs, attachments and deliveries', options, async t => {
  const fx = await fixture(t)
  const { turns, a, b } = fx
  const created = turns.create()
  const sid = created.id
  assert.equal(Object.hasOwn(created, 'workspaceRevision'), false)
  const unattached = turns.getWorkspace(sid)
  assert.deepEqual(unattached, { workspace: null, revision: unattached.revision })
  assert.match(unattached.revision, pattern)
  const bytes = Buffer.from('An explicitly attached note')
  const file = await fx.uploads.stage(sid, { name: 'note.txt', mime: 'text/plain', size: bytes.length }, Readable.from([bytes]))
  const sent = request(sid, 'first', { attachments: [file.id] })
  const { receipt, events } = await turn(fx, sent)
  const prefs = await turns.patchPreferences(sid, { revision: turns.getPreferences(sid).revision, set: { customTitle: 'Mine', archived: true } })
  const delivery = turns.exportReplyDelivery(sid, { turnId: receipt.turnId, format: 'txt' })
  const before = await fx.disk(sid)
  const beforeDeliveries = turns.deliverySnapshot(sid)
  const seq = fx.seq
  const calls = fx.calls.length, reads = fx.reads.length
  const current = turns.setWorkspace(sid, { workspaceId: a, revision: unattached.revision }, seen => assert.equal(seen, sid))
  assert.deepEqual(current.workspace, expected(a, 'alpha', 'manual'))
  assert.notEqual(current.revision, unattached.revision)
  assert.match(current.revision, pattern)
  const disk = await fx.disk(sid)
  assert.deepEqual(withoutBinding(disk), withoutBinding(before))
  assert.equal(disk.focusRoot, fx.aRoot)
  const desktop = createChatStore({ dataDir: fx.dataDir })
  assert.equal(desktop.getSession(sid).focusRoot, fx.aRoot)
  assert.equal(desktop.listSessions().find(row => row.id === sid).focusRoot, fx.aRoot)
  assert.equal(fx.seq, seq + 1)
  assert.deepEqual(turns.setWorkspace(sid, { workspaceId: a, revision: current.revision }), current)
  assert.equal(fx.seq, seq + 1)
  assert.deepEqual(await fx.disk(sid), disk)
  assert.equal(turns.list()[0].workspaceRevision, current.revision)
  assert.deepEqual(turns.getPreferences(sid), prefs)
  assert.deepEqual(turns.deliverySnapshot(sid), beforeDeliveries)
  assert.equal(turns.readReplyDelivery(sid, delivery.record.id, 0).bytes.toString(), 'Fixture answer')
  assert.deepEqual(turns.readCommittedAttachment(sid, file.id).bytes, bytes)
  assert.equal(turns.hasBrowserSession(sid), true)
  assert.deepEqual(await turns.send(sent), { turnId: receipt.turnId, startedAt: receipt.startedAt, status: 'completed', reason: null, duplicate: true })
  assert.equal(fx.calls.length, calls)
  assert.equal(fx.reads.length, reads)
  privateFree([current, created, turns.list(), turns.snapshot(sid), events], fx)
  await fx.restart()
  assert.deepEqual(fx.turns.getWorkspace(sid), current)
  assert.equal(fx.turns.snapshot(sid).state.workspaceRevision, current.revision)
  assert.deepEqual(fx.turns.deliverySnapshot(sid), beforeDeliveries)
  const detached = fx.turns.setWorkspace(sid, { workspaceId: null, revision: current.revision })
  assert.equal(detached.workspace, null)
  assert.notEqual(detached.revision, unattached.revision)
  assert.equal(fx.turns.list()[0].workspaceRevision, detached.revision)
  assert.equal((await fx.disk(sid)).focusRoot, null)
  await fx.restart()
  assert.deepEqual(fx.turns.getWorkspace(sid), detached)
  const again = fx.turns.setWorkspace(sid, { workspaceId: b, revision: detached.revision })
  assert.deepEqual(again.workspace, expected(b, 'beta', 'manual'))
  assert.equal((await fx.disk(sid)).focusRoot, fx.bRoot)
  assert.deepEqual(withoutBinding(await fx.disk(sid)), withoutBinding(before))
})

test('create distinguishes role inheritance, explicit null, original override intent and current binding', options, async t => {
  const fx = await fixture(t)
  const { turns, role, a, b } = fx
  const inherited = turns.create({ sessionId: randomUUID() }, role)
  assert.deepEqual(turns.getWorkspace(inherited.id).workspace, expected(a, 'alpha', 'role'))
  const suppressed = turns.create({ workspaceId: null }, role)
  assert.equal(Object.hasOwn(suppressed, 'workspaceRevision'), false)
  assert.equal(turns.getWorkspace(suppressed.id).workspace, null)
  const explicit = turns.create({ workspaceId: b }, role)
  assert.deepEqual(turns.getWorkspace(explicit.id).workspace, expected(b, 'beta', 'manual'))
  assert.deepEqual(turns.getWorkspace(turns.create({ workspaceId: a }).id).workspace, expected(a, 'alpha', 'manual'))
  const previous = fx.seq
  role.workspaceId = b
  assert.deepEqual(turns.create({ sessionId: inherited.id }, role), inherited)
  assert.deepEqual(turns.create({ sessionId: inherited.id, workspaceId: a }, role), inherited)
  assert.throws(() => turns.create({ sessionId: inherited.id, workspaceId: b }, role), error(409, 'session_id_conflict'))
  assert.deepEqual(turns.create({ sessionId: suppressed.id }, role), suppressed)
  assert.deepEqual(turns.create({ sessionId: suppressed.id, workspaceId: null }, role), suppressed)
  assert.equal(fx.seq, previous)
  const rebound = turns.setWorkspace(inherited.id, { workspaceId: b, revision: inherited.workspaceRevision })
  assert.deepEqual(rebound.workspace, expected(b, 'beta', 'manual'))
  assert.equal(turns.create({ sessionId: inherited.id, workspaceId: a }, role).workspaceRevision, rebound.revision)
  assert.throws(() => turns.create({ sessionId: inherited.id, workspaceId: b }, role), error(409, 'session_id_conflict'))
  const cleared = turns.setWorkspace(explicit.id, { workspaceId: null, revision: explicit.workspaceRevision })
  await fx.restart()
  assert.equal(fx.turns.create({ sessionId: explicit.id }, role).workspaceRevision, cleared.revision)
  assert.equal(fx.turns.create({ sessionId: explicit.id, workspaceId: b }, role).workspaceRevision, cleared.revision)
  assert.throws(() => fx.turns.create({ sessionId: explicit.id, workspaceId: null }, role), error(409, 'session_id_conflict'))
  assert.deepEqual(fx.turns.getWorkspace(explicit.id), cleared)
  assert.equal(fx.calls.length, 0)
  assert.equal(fx.reads.length, 0)
})

test('authorization, strict ID syntax, stale/cross-session revisions and same-SID races fail without side effects', options, async t => {
  const fx = await fixture(t)
  const { turns, a, b } = fx
  const sid = turns.create().id
  const other = turns.create().id
  const unseen = randomUUID()
  const revision = turns.getWorkspace(sid).revision
  const foreign = turns.getWorkspace(other).revision
  assert.notEqual(revision, foreign)
  const original = await fx.disk(sid)
  const seq = fx.seq
  for (const invalid of [fx.aRoot, 'alpha', `${a}\n`, a.toUpperCase(), [`${a}`], undefined]) {
    assert.throws(() => turns.setWorkspace(sid, { workspaceId: invalid, revision }), error(400, 'invalid_workspace_id'))
    assert.throws(() => turns.create({ workspaceId: invalid }), error(400, 'invalid_workspace_id'))
  }
  assert.throws(() => turns.setWorkspace(sid, { workspaceId: a, revision, focusRoot: fx.aRoot }), error(400, 'invalid_workspace'))
  assert.throws(() => turns.setWorkspace(sid, { workspaceId: a, revision: 'a'.repeat(65) }), error(400, 'invalid_workspace_revision'))
  assert.throws(() => turns.setWorkspace(sid, { workspaceId: a, revision: foreign }), conflict)
  assert.throws(() => turns.setWorkspace(sid, { workspaceId: a, revision }, () => false), error(401, 'unauthorized'))
  assert.throws(() => turns.setWorkspace(sid, { workspaceId: b, revision }, async () => true), error(401, 'unauthorized'))
  assert.equal(fx.lookups.length, 0)
  let authChecks = 0
  assert.throws(() => turns.setWorkspace(sid, { workspaceId: a, revision }, () => ++authChecks === 1), error(401, 'unauthorized'))
  assert.equal(authChecks, 2)
  assert.equal(fx.seq, seq)
  assert.deepEqual(await fx.disk(sid), original)
  const missing = 'w_' + '0'.repeat(32)
  assert.throws(() => turns.setWorkspace(sid, { workspaceId: missing, revision }), unavailable)
  assert.throws(() => turns.create({ sessionId: unseen, workspaceId: missing }), unavailable)
  await assert.rejects(fs.lstat(fx.native(unseen)), { code: 'ENOENT' })
  assert.deepEqual(await fx.disk(sid), original)
  assert.equal(fx.seq, seq)
  const raced = await Promise.allSettled([a, b].map(async workspaceId => turns.setWorkspace(sid, { workspaceId, revision })))
  assert.equal(raced.filter(x => x.status === 'fulfilled').length, 1)
  assert.deepEqual(raced[0].value, turns.getWorkspace(sid))
  assert.equal(raced[1].reason.code, conflict.code)
  assert.equal(fx.seq, seq + 1)
  const bound = raced[0].value
  const detached = turns.setWorkspace(sid, { workspaceId: null, revision: bound.revision })
  const rebound = turns.setWorkspace(sid, { workspaceId: a, revision: detached.revision })
  assert.equal(new Set([revision, bound.revision, detached.revision, rebound.revision]).size, 4)
  assert.throws(() => turns.setWorkspace(sid, { workspaceId: a, revision: bound.revision }), conflict)
  // The owner callback may reenter; the outer operation checks CAS only when it returns.
  assert.throws(() => turns.setWorkspace(sid, { workspaceId: null, revision: rebound.revision }, () => {
    turns.setWorkspace(sid, { workspaceId: b, revision: rebound.revision })
  }), conflict)
  const changed = turns.getWorkspace(sid)
  assert.deepEqual(changed.workspace, expected(b, 'beta', 'manual'))
  authChecks = 0
  const afterFirstReentry = fx.seq
  assert.throws(() => turns.setWorkspace(sid, { workspaceId: null, revision: changed.revision }, () => {
    if (++authChecks === 2) turns.setWorkspace(sid, { workspaceId: a, revision: changed.revision })
  }), conflict)
  assert.equal(authChecks, 2)
  assert.equal(fx.seq, afterFirstReentry + 1)
  assert.deepEqual(turns.getWorkspace(sid).workspace, expected(a, 'alpha', 'manual'))
  assert.deepEqual([fx.calls.length, fx.reads.length], [0, 0])
})

test('revoked and same-name replacement grant never retarget; turns stay plain and busy changes stay quiet', options, async t => {
  const fx = await fixture(t)
  const { turns, role, a, b } = fx
  const sid = turns.create({}, role).id
  const binding = turns.getWorkspace(sid)
  const initial = await fx.disk(sid)
  const parked = join(fx.mount, 'retired-alpha')
  assert.equal(await fs.realpath(fx.aRoot), fx.aRoot)
  await fs.rename(fx.aRoot, parked)
  await fs.mkdir(fx.aRoot)
  await fs.writeFile(join(fx.aRoot, 'new-scope-note.txt'), sentinel)
  const replacement = fx.ids().alpha
  assert.notEqual(replacement, a)
  const revoked = turns.getWorkspace(sid)
  assert.deepEqual(revoked, { workspace: expected(a, null, 'role'), revision: binding.revision })
  assert.deepEqual(turns.setWorkspace(sid, { workspaceId: a, revision: binding.revision }), revoked)
  assert.equal(turns.getWorkspace(turns.create({}, role).id).workspace, null)
  assert.throws(() => turns.create({ workspaceId: a }), unavailable)
  assert.deepEqual(await fx.disk(sid), initial)
  let readsBefore = fx.reads.length
  const scans = fx.lookups.length
  const gate = Promise.withResolvers()
  fx.beforeProvider(() => gate.promise)
  const w = watch(turns, sid)
  try {
    const pending = turns.send(request(sid, 'role-turn'))
    const seq = fx.seq
    assert.throws(() => turns.setWorkspace(sid, { workspaceId: b, revision: binding.revision }), error(409, 'turn_in_progress'))
    assert.throws(() => turns.setWorkspace(sid, { workspaceId: null, revision: binding.revision }), error(409, 'turn_in_progress'))
    assert.equal(fx.seq, seq)
    assert.equal(fx.calls.length, 0)
    assert.equal(turns.list().find(row => row.id === sid).workspaceRevision, binding.revision)
    assert.equal(fx.lookups.length, scans)
    gate.resolve()
    await pending
    await w.done
  } finally { gate.resolve(); w.close() }
  assert.equal(fx.calls.length, 1)
  assert.equal(fx.reads.length, readsBefore + 1)
  assert.equal(fx.lookups.length, scans)
  const body = fx.calls[0]
  assert.deepEqual(body.tools, [])
  assert.equal(body.messages.length, 2)
  assert.deepEqual(body.messages.map(({ role }) => role), ['system', 'user'])
  assert.match(body.messages[1].content, /A plain question/)
  privateFree(body, fx)
  assert.ok(!JSON.stringify(body).includes(a) && !JSON.stringify(body).includes(replacement))
  readsBefore = fx.reads.length
  const detached = turns.setWorkspace(sid, { workspaceId: null, revision: revoked.revision })
  assert.deepEqual(detached, turns.getWorkspace(sid))
  assert.equal(detached.workspace, null)
  assert.equal((await fx.disk(sid)).focusRoot, null)
  assert.equal(fx.calls.length, 1)
  assert.equal(fx.reads.length, readsBefore)
  await fx.restart(false)
  assert.deepEqual(fx.turns.getWorkspace(sid), detached)
  assert.equal(fx.turns.getWorkspace(fx.turns.create().id).workspace, null)
  assert.throws(() => fx.turns.create({ workspaceId: b }), unavailable)
})

test('old plain, complex, incomplete, unsigned and ambiguous native files are never promoted', options, async t => {
  const fx = await fixture(t)
  const { turns, a, aRoot, dataDir } = fx
  const native = createChatStore({ dataDir })
  const legacy = native.ensureSession('legacy')
  legacy.messages.push({ role: 'user', content: 'Desktop history' })
  native.saveStrict(legacy.id)
  const focused = native.ensureSession('legacy-focused', { focusRoot: aRoot })
  native.saveStrict(focused.id)
  const complex = native.ensureSession('legacy-complex')
  complex.members = [{ sessionId: 'member' }]
  native.saveStrict(complex.id)
  const partial = native.ensureSession('legacy-incomplete')
  native.saveStrict(partial.id)
  const partialDisk = { ...await fx.disk(partial.id), compacted: { file: `${partial.id}.compacted-missing.jsonl`, count: 1 } }
  await fs.writeFile(fx.native(partial.id), JSON.stringify(partialDisk))
  const signed = turns.create({ workspaceId: a }).id
  const signedDisk = await fx.disk(signed)
  const unsigned = randomUUID()
  await fs.writeFile(fx.native(unsigned), JSON.stringify({ ...withoutBinding(signedDisk), id: unsigned, focusRoot: aRoot }), { mode: 0o600 })
  const copied = randomUUID()
  await fs.writeFile(fx.native(copied), JSON.stringify({ ...signedDisk, id: copied }), { mode: 0o600 })
  const ambiguous = randomUUID()
  await fs.writeFile(fx.native(ambiguous), `{\"id\":\"${ambiguous}\",\"focusRoot\":\"/wrong\",${JSON.stringify({ ...withoutBinding(signedDisk), id: ambiguous, focusRoot: null }).slice(1)}`, { mode: 0o600 })
  const seq = fx.seq
  for (const [sid, problem] of [[legacy.id, error(409, 'read_only_session')], ...[focused.id, complex.id, partial.id, unsigned, copied].map(id => [id, error(409, 'unsupported_history')]), [ambiguous, storageError]]) {
    const original = await fs.readFile(fx.native(sid), 'utf8')
    assert.throws(() => turns.getWorkspace(sid), problem)
    assert.throws(() => turns.setWorkspace(sid, { workspaceId: a, revision: 'a'.repeat(64) }), problem)
    assert.equal(await fs.readFile(fx.native(sid), 'utf8'), original)
  }
  assert.equal(fx.seq, seq)
  // A warm compatibility WeakMap entry must not allow a stale or changed native path.
  const stamp = turns.getWorkspace(signed).revision
  assert.equal(turns.list().find(row => row.id === signed).writable, true)
  await fs.writeFile(fx.native(signed), JSON.stringify({ ...signedDisk, focusRoot: fx.bRoot }))
  assert.throws(() => turns.setWorkspace(signed, { workspaceId: null, revision: stamp }), conflict)
  assert.equal(turns.snapshot(signed).state.writable, false)
  await assert.rejects(turns.send(request(signed, 'not-admitted')), error(409, 'unsupported_history'))
  assert.throws(() => turns.getWorkspace(signed), storageError)
  assert.equal(fx.seq, seq)
  assert.deepEqual([fx.calls.length, fx.reads.length], [0, 0])
  await fx.restart()
  assert.equal(fx.turns.snapshot(signed).state.compatibility, 'unsupported')
  assert.throws(() => fx.turns.getWorkspace(signed), error(409, 'unsupported_history'))
})

test('strict writer and pin confirmation failures quarantine without announcing a binding', options, async t => {
  const fx = await fixture(t)
  const { turns, a, b } = fx
  const sid = turns.create().id
  const before = turns.getWorkspace(sid)
  const seq = fx.seq
  const pending = join(fx.chats, '_index.pending')
  await fs.mkdir(pending)
  assert.throws(() => turns.setWorkspace(sid, { workspaceId: a, revision: before.revision }), storageError)
  assert.throws(() => turns.getWorkspace(sid), storageError)
  assert.throws(() => turns.setWorkspace(sid, { workspaceId: b, revision: before.revision }), storageError)
  assert.equal(turns.hasBrowserSession(sid), false)
  const failed = randomUUID()
  assert.throws(() => turns.create({ sessionId: failed, workspaceId: a }), storageError)
  await assert.rejects(fs.stat(fx.native(failed)), { code: 'ENOENT' })
  assert.equal(turns.list().some(row => row.id === failed), false)
  assert.equal(fx.seq, seq)
  assert.equal((await fx.disk(sid)).focusRoot, null)
  assert.equal(await fs.realpath(pending), pending)
  await fs.rmdir(pending)
  await fx.restart()
  const halfway = fx.seq
  fx.afterGrant(() => { throw new Error('fixture projects pin invalidated after callback') })
  assert.throws(() => fx.turns.setWorkspace(sid, { workspaceId: a, revision: before.revision }), storageError)
  assert.throws(() => fx.turns.getWorkspace(sid), storageError)
  assert.equal(fx.turns.hasBrowserSession(sid), false)
  assert.equal(fx.turns.snapshot(sid).state.workspaceRevision, undefined)
  assert.equal(fx.seq, halfway)
  assert.deepEqual([fx.calls.length, fx.reads.length], [0, 0])
})