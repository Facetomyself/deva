import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { HttpError } from '../src/http/policy.mjs'
import { openProjectDocumentService } from '../src/files/project-document-service.mjs'

const WID = 'w_' + '1'.repeat(32), OTHER_WID = 'w_' + '2'.repeat(32)
const REV = 'r_' + 'a'.repeat(64)
const owner = n => Object.freeze({ role: 'owner', ownerId: 'same-owner', loginSessionId: `login-${n}` })
const A = owner(0), B = owner(1)
const ok = () => true
const doc = (name = 'note.md') => ({ directory: 'Notes', name })
const error = (status, code) => new HttpError(status, code)
const throws = (fn, status, code) => assert.throws(fn, e => e instanceof HttpError && e.status === status && e.code === code)

function fixture(t, options = {}) {
  const active = new Set(), listeners = new Set(), hooks = Object.create(null), files = new Map(), targets = []
  const stats = { opens: 0, absences: 0, publishes: 0, receipts: 0, closes: 0 }
  const auth = {
    isLoginActive: actor => actor.role === 'owner' && actor.ownerId === A.ownerId && active.has(actor.loginSessionId),
    onSessionRevoked(fn) { listeners.add(fn); return () => listeners.delete(fn) },
  }
  function activate(actor) { active.add(actor.loginSessionId) }
  function revoke(actor) {
    active.delete(actor.loginSessionId)
    for (const listener of listeners) listener(actor.loginSessionId)
  }
  activate(A); activate(B)
  const service = openProjectDocumentService({ auth, ...options, openTarget(wid, request) {
    stats.opens++
    const { directory, name } = request
    const path = directory === '' ? name : `${directory}/${name}`, key = `${wid}:${path}`
    let closed = false, receipt
    function live() { assert.equal(closed, false, 'bridge FD remained live until the callback unwound') }
    const target = { path,
      verifyAbsent() {
        live(); stats.absences++
        hooks.absent?.(target)
        live()
        if (files.has(key)) throw error(409, 'document_exists')
        return true
      },
      publish(bytes, verify) {
        live(); stats.publishes++
        assert.equal(verify(), true)
        hooks.beforeLink?.(target, verify)
        if (files.has(key)) throw error(409, 'document_exists')
        files.set(key, (receipt = { bytes, revision: REV }))
        hooks.afterLink?.(target, verify)
        live()
        assert.equal(verify(), true)
        return { revision: REV }
      },
      verifyReceipt(revision) {
        live(); stats.receipts++
        hooks.receipt?.(target)
        live()
        if (!receipt || files.get(key) !== receipt || revision !== receipt.revision) throw error(409, 'document_changed')
        return true
      },
      close() { assert.equal(closed, false); closed = true; stats.closes++; hooks.close?.(target) },
    }
    targets.push({ key, target })
    hooks.open?.(target)
    return target
  } })
  t.after(() => service.close())
  const prepare = (actor = A, workspace = WID, request = doc(), verify = ok) => service.prepare(actor, workspace, request, verify)
  const create = (id, content, verify = ok) => service.create(A, WID, id, { content }, verify)
  const status = (id, actor = A, workspace = WID) => service.status(actor, workspace, id, {}, ok)
  const cancel = (id, actor = A) => service.cancel(actor, WID, id, {}, ok)
  return { service, auth, listeners, active, activate, revoke, hooks, files, targets, stats, prepare, create, status, cancel }
}

test('fresh receipt requires synchronous native readback and identical retries only verify', t => {
  const f = fixture(t)
  assert.equal(f.stats.opens, 0)
  const prepared = f.prepare()
  assert.deepEqual(prepared, { id: prepared.id, path: 'Notes/note.md', ttlMs: 120_000 })
  assert.match(prepared.id, /^di_[a-f0-9]{32}$/)
  assert.deepEqual(f.status(prepared.id), { state: 'prepared', path: prepared.path, revision: null })
  const text = '\uFEFF项目\r\nSecond line\r\n'
  const receipt = f.create(prepared.id, text)
  assert.deepEqual(receipt, { created: true, path: prepared.path, revision: REV, replayed: false })
  assert.equal(f.stats.receipts, 1)
  assert.deepEqual(f.create(prepared.id, text), { ...receipt, replayed: true })
  assert.equal(f.stats.publishes, 1)
  assert.equal(f.stats.receipts, 2)
  throws(() => f.create(prepared.id, text.replaceAll('\r\n', '\n')), 409, 'document_conflict')
  assert.deepEqual(f.status(prepared.id), { state: 'created', path: prepared.path, revision: REV })
  assert.equal(f.stats.receipts, 3)
  assert.deepEqual(f.cancel(prepared.id), { closed: true })
  assert.equal(f.stats.closes, 1)
  assert.equal(f.files.get(f.targets[0].key).bytes, text)
  throws(() => f.status(prepared.id), 404, 'document_intent_missing')
})

test('sibling login, workspace, and malformed intent IDs see the same missing receipt', t => {
  const f = fixture(t)
  const { id } = f.prepare()
  for (const who of [B, { ...A, loginSessionId: 'new-session' }]) {
    f.activate(who)
    throws(() => f.status(id, who), 404, 'document_intent_missing')
    throws(() => f.service.create(who, WID, id, { content: 'same' }, ok), 404, 'document_intent_missing')
    throws(() => f.cancel(id, who), 404, 'document_intent_missing')
  }
  throws(() => f.status(id, A, OTHER_WID), 404, 'document_intent_missing')
  throws(() => f.status(`${id}\n`), 404, 'document_intent_missing')
  throws(() => f.prepare(A, `${WID}\n`), 404, 'workspace_unavailable')
  assert.equal(f.stats.closes, 0)
  f.revoke(A)
  assert.equal(f.stats.closes, 1)
  throws(() => f.status(id), 401, 'auth')
  throws(() => f.status(id, B), 404, 'document_intent_missing')
  assert.ok(f.prepare(B).id)
})

test('validates bodies without invoking getters, proxy traps, or coercion', t => {
  const f = fixture(t)
  const fail = () => assert.fail('request accessor or trap was invoked')
  const preparedBody = { directory: '', get name() { fail() } }
  const proxy = new Proxy(doc(), { ownKeys: fail, getPrototypeOf: fail, get: fail })
  for (const value of [preparedBody, proxy, null, [], 'string', { ...doc(), extra: '' }, { directory: 4, name: 'x.md' },
    { directory: '', name: { toString: fail } }, Object.create(doc())]) {
    throws(() => f.prepare(A, WID, value), 400, 'document_invalid')
  }
  assert.equal(f.stats.opens, 0)
  const { id } = f.prepare()
  for (const value of [null, [], { get content() { fail() } }, { content: '\ud800' }, { content: true }, { content: '', [Symbol()]: 1 }]) {
    throws(() => f.service.create(A, WID, id, value, ok), 400, 'document_invalid')
  }
  throws(() => f.create(id, 'é'.repeat(1024 * 1024 + 1)), 413, 'document_limit')
  throws(() => f.service.cancel(A, WID, id, { get content() { fail() } }, ok), 400, 'document_invalid')
  throws(() => f.service.status(A, WID, id, proxy, ok), 400, 'document_invalid')
  assert.equal(f.stats.publishes, 0)
  assert.equal(f.create(id, '').replayed, false)
})

test('requires current owner authority before acquisition and after every native call', t => {
  const f = fixture(t)
  for (const verify of [false, () => false, async () => true, () => Promise.reject(new Error('async denial')),
    () => ({ get then() { assert.fail('then getter') } }), () => { throw Error('auth denied') }]) {
    throws(() => f.prepare(A, WID, doc(), verify), 401, 'auth')
  }
  assert.equal(f.stats.opens, 0)
  f.hooks.open = () => f.revoke(A)
  throws(() => f.prepare(), 401, 'auth')
  assert.equal(f.stats.absences, 0)
  assert.equal(f.stats.closes, 1)
  f.hooks.open = undefined
  f.hooks.absent = () => f.revoke(B)
  throws(() => f.prepare(B), 401, 'auth')
  assert.equal(f.stats.closes, 2)
  f.activate(B)
  f.hooks.absent = undefined
  const { id } = f.prepare(B)
  f.hooks.close = () => f.revoke(B)
  throws(() => f.cancel(id, B), 401, 'auth')
  assert.equal(f.stats.closes, 3)
})

test('a foreign file with matching content cannot be acknowledged, even in a publish race', t => {
  const f = fixture(t)
  const draft = doc('draft.txt')
  const foreign = { bytes: 'same', revision: REV }
  f.files.set(`${WID}:Notes/${draft.name}`, foreign)
  throws(() => f.prepare(A, WID, draft), 409, 'document_exists')
  assert.equal(f.stats.closes, 1)
  const { id } = f.prepare()
  const { key } = f.targets.at(-1)
  f.hooks.beforeLink = () => f.files.set(key, foreign)
  throws(() => f.create(id, foreign.bytes), 409, 'document_exists')
  assert.equal(f.files.get(key), foreign)
  assert.equal(f.stats.receipts, 0)
  f.files.delete(key)
  throws(() => f.create(id, foreign.bytes), 409, 'document_exists')
  assert.equal(f.stats.publishes, 1)
})

test('two logins can prepare the same empty slot; the first publication wins', t => {
  const f = fixture(t)
  const winner = f.prepare(A)
  const second = f.prepare(B)
  assert.notEqual(winner.id, second.id)
  assert.equal(winner.path, second.path)
  const receipt = f.create(winner.id, 'same bytes')
  throws(() => f.service.create(B, WID, second.id, { content: 'same bytes' }, ok), 409, 'document_exists')
  throws(() => f.status(second.id, B), 409, 'document_exists')
  assert.deepEqual(f.create(winner.id, 'same bytes'), { ...receipt, replayed: true })
  assert.equal(f.stats.publishes, 1)
  assert.equal(f.files.get(f.targets[0].key).bytes, 'same bytes')
})

test('both replacement and disappearance fence an acquired receipt; lost project becomes changed', t => {
  const f = fixture(t)
  const { id } = f.prepare()
  const { key } = f.targets[0]
  f.create(id, 'original')
  const installed = f.files.get(key)
  f.files.set(key, { ...installed })
  throws(() => f.status(id), 409, 'document_changed')
  f.files.set(key, installed)
  throws(() => f.create(id, 'original'), 409, 'document_changed')
  assert.equal(f.stats.publishes, 1)
  const { id: other } = f.prepare(A, WID, doc('other.md'))
  f.hooks.absent = () => { throw error(404, 'workspace_unavailable') }
  throws(() => f.status(other), 409, 'document_changed')
})

test('ambiguous publication or fresh readback quarantines: status has no revision and no retry writes', t => {
  const f = fixture(t)
  const { id, path } = f.prepare()
  const { key } = f.targets[0]
  f.hooks.afterLink = () => { throw Error('untrusted native diagnostics') }
  throws(() => f.create(id, 'landed'), 503, 'document_unconfirmed')
  assert.deepEqual(f.status(id), { state: 'unconfirmed', path, revision: null })
  assert.equal(f.files.get(key).bytes, 'landed')
  f.files.delete(key)
  assert.deepEqual(f.status(id), { state: 'unconfirmed', path, revision: null })
  throws(() => f.create(id, 'landed'), 503, 'document_unconfirmed')
  throws(() => f.create(id, 'different'), 503, 'document_unconfirmed')
  assert.equal(f.stats.publishes, 1)
  f.hooks.afterLink = undefined
  const second = f.prepare(A, WID, doc('readback.md'))
  f.hooks.receipt = () => { throw Error('read interrupted') }
  throws(() => f.create(second.id, 'landed'), 503, 'document_unconfirmed')
  f.hooks.receipt = undefined
  assert.deepEqual(f.status(second.id), { state: 'unconfirmed', path: second.path, revision: null })
  assert.equal(f.stats.publishes, 2)
  f.hooks.absent = () => { throw error(409, 'document_changed') }
  throws(() => f.status(second.id), 409, 'document_changed')
})

test('a revoke after visibility yields no receipt and does not delete the file', t => {
  const f = fixture(t)
  const { id } = f.prepare()
  const { key } = f.targets[0]
  f.hooks.afterLink = () => {
    f.revoke(A)
    assert.equal(f.stats.closes, 0, 'avoid closing a descriptor still in use')
  }
  throws(() => f.create(id, 'landed'), 401, 'auth')
  assert.equal(f.files.get(key).bytes, 'landed')
  assert.equal(f.stats.closes, 1)
  assert.equal(f.stats.receipts, 0)
  throws(() => f.status(id, B), 404, 'document_intent_missing')
  throws(() => f.prepare(B), 409, 'document_exists')
})

test('late request-only shutdown keeps a returned receipt retryable if login is still active', t => {
  const f = fixture(t)
  const { id } = f.prepare()
  let responseFailed = false
  f.hooks.receipt = () => { responseFailed = true }
  throws(() => f.create(id, 'once', () => { if (responseFailed) throw error(503, 'document_unavailable'); return true }), 503, 'document_unavailable')
  f.hooks.receipt = undefined
  assert.equal(f.create(id, 'once').replayed, true)
  assert.equal(f.stats.publishes, 1)
  assert.equal(f.stats.closes, 0)
})

test('in-flight intent operations are exclusive and shutdown closes once after unwind', t => {
  const f = fixture(t)
  const { id } = f.prepare()
  f.hooks.beforeLink = (_, verify) => {
    throws(() => f.create(id, 'claim'), 429, 'document_busy')
    throws(() => f.cancel(id), 429, 'document_busy')
    throws(() => f.status(id, B), 404, 'document_intent_missing')
    assert.equal(typeof verify, 'function')
    f.service.close()
    assert.equal(f.stats.closes, 0)
    assert.equal(f.listeners.size, 0)
    verify()
  }
  throws(() => f.create(id, 'claim'), 503, 'document_unavailable')
  assert.equal(f.stats.publishes, 1)
  assert.equal(f.stats.closes, 1)
  assert.equal(f.files.size, 0)
  f.service.close()
  assert.equal(f.stats.closes, 1)
  throws(() => f.prepare(), 503, 'document_unavailable')
})

test('expiry releases an idle pin by timer and neither status nor replay renews TTL', { timeout: 3000 }, async t => {
  const f = fixture(t, { ttlMs: 20 })
  const { id } = f.prepare()
  const abort = new AbortController()
  const expired = new Promise(resolve => { f.hooks.close = resolve })
  try { await Promise.race([expired, delay(2000, undefined, { signal: abort.signal }).then(() => { throw Error('idle pin leaked') })]) }
  finally { abort.abort() }
  assert.equal(f.stats.closes, 1)
  throws(() => f.status(id), 404, 'document_intent_missing')

  let now = 0
  const g = fixture(t, { now: () => now, ttlMs: 120_000 })
  const pending = g.prepare()
  now = 110_000
  g.status(pending.id)
  g.create(pending.id, 'x')
  now = 119_999
  assert.equal(g.create(pending.id, 'x').replayed, true)
  now++
  throws(() => g.status(pending.id), 404, 'document_intent_missing')
  assert.equal(g.stats.closes, 1)
  assert.equal(g.files.size, 1)
})

test('active quota, issuance rate, and identity release have independent bounds', t => {
  let now = 0
  const f = fixture(t, { now: () => now })
  const actors = Array.from({ length: 6 }, (_, i) => owner(i))
  actors.forEach(f.activate)
  for (const actor of actors.slice(0, 4)) {
    for (let i = 0; i < 4; i++) f.prepare(actor)
    throws(() => f.prepare(actor, OTHER_WID), 429, 'document_busy')
  }
  throws(() => f.prepare(actors[4]), 429, 'document_busy')
  assert.equal(f.stats.opens, 16)
  f.revoke(B)
  assert.equal(f.stats.closes, 4)
  assert.ok(f.prepare(actors[4]).id)
  f.service.close()
  assert.equal(f.stats.closes, 17)
  assert.equal(f.listeners.size, 0)

  const g = fixture(t, { now: () => now })
  for (let i = 0; i < 12; i++) g.cancel(g.prepare().id)
  throws(() => g.prepare(), 429, 'document_busy')
  for (const actor of actors.slice(1, 4)) {
    g.activate(actor)
    for (let i = 0; i < 12; i++) g.cancel(g.prepare(actor).id, actor)
  }
  g.activate(actors[4])
  g.revoke(B)
  throws(() => g.prepare(actors[4]), 429, 'document_busy')
  now = 10_000
  assert.ok(g.prepare().id)
})
