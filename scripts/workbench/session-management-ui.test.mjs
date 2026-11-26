import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))
const ts = require('typescript')
const root = new URL('../../apps/desktop/src/workbench/', import.meta.url)
async function compiled(name, imports = {}) {
  const source = await readFile(new URL(`${name}.ts`, root), 'utf8')
  let js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  for (const [from, to] of Object.entries(imports)) js = js.replaceAll(`'${from}'`, `'${to}'`)
  return `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
}
const transportUrl = await compiled('transport')
const { createTransport, HttpFailure } = await import(transportUrl)
const { createChatTransport, sameTurnDraft } = await import(await compiled('chat-transport'))
const { createPreferenceTransport, createSessionPreferences, matchesPreferences, projectSession } = await import(
  await compiled('session-preferences', { './transport': transportUrl }))
const { createListRefresh, sessionAfterRefresh } = await import(await compiled('session-list'))
const { createSessionsStream, parseSessionsFrame } = await import(await compiled('sessions-stream'))

const json = (data, status = 200) => new Response(JSON.stringify(data), { status })
const flush = () => new Promise((resolve) => setImmediate(resolve))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const snapshot = (revision, p = {}) => ({ revision, preferences: { title: 'First message', customTitle: null, archived: false, model: null, effort: null, ...p } })
const row = (id, extra = {}) => ({ id, title: 'First message', model: null, updatedAt: 100, writable: true, compatibility: 'text', ...extra })

function fakeTransport(fixtures) {
  const calls = []
  const transport = createTransport(async (url, init) => {
    const [method, path, body, response] = fixtures.shift() ?? []
    assert.equal(init.method, method)
    assert.equal(url, `/api/v1${path}`)
    assert.equal(init.credentials, 'same-origin')
    assert.equal(init.headers['x-deva-csrf'], method === 'GET' ? undefined : 'owner-csrf')
    assert.deepEqual(init.body ? JSON.parse(init.body) : undefined, body)
    calls.push({ method, path })
    return response
  })
  return { transport, calls }
}

test('only an exact bootstrap capability enables the new owner protocol; PATCH never opens a turn', async () => {
  const bootstrap = { protocol: 1, version: '1', platform: 'linux', config: {}, csrf: 'owner-csrf', expiresAt: 1900000000000 }
  const base = snapshot('r1')
  const pin = snapshot('r2', { model: 'enabled:qwen:8b' })
  const follow = snapshot('r3')
  const send = { clientRequestId: 'request-a', text: 'message', model: null }
  const fixtures = [
    ['GET', '/bootstrap', undefined, json({ ...bootstrap, capabilities: { sessionPreferences: 'true' } })],
    ['GET', '/bootstrap', undefined, json({ ...bootstrap, capabilities: { sessionPreferences: true } })],
    ['GET', '/chats', undefined, json({ sessions: [row('a'), row('b', { archived: true })] })],
    ['GET', '/chats/a/preferences', undefined, json(base)],
    ['PATCH', '/chats/a/preferences', { revision: 'r1', set: { model: 'enabled:qwen:8b' } }, json(pin)],
    ['PATCH', '/chats/a/preferences', { revision: 'r2', set: { model: null } }, json(follow)],
    ['POST', '/chats/a/turns', send, json({ turnId: 'turn-a', startedAt: 1, status: 'running', reason: null, duplicate: false }, 202)]
  ]
  const { transport, calls } = fakeTransport(fixtures)
  assert.equal((await transport.inspect()).bootstrap.capabilities, undefined)
  assert.deepEqual((await transport.inspect()).bootstrap.capabilities, { sessionPreferences: true })
  const chats = createChatTransport(transport, 'owner-csrf')
  assert.deepEqual((await chats.list()).map(r => r.archived === true), [false, true])
  const api = createPreferenceTransport(transport, 'owner-csrf')
  assert.deepEqual(await api.read('a'), base)
  assert.deepEqual(await api.patch('a', base.revision, { model: 'enabled:qwen:8b' }), pin)
  assert.deepEqual(await api.patch('a', pin.revision, { model: null }), follow)
  assert.ok(calls.every(c => c.method !== 'POST'))
  assert.equal((await chats.send('a', send)).turnId, 'turn-a')
  assert.equal(sameTurnDraft(send, { ...send }), true)
  assert.equal(sameTurnDraft(send, { ...send, model: pin.preferences.model }), false)
  await assert.rejects(api.read('../settings'), /Invalid chat id/)
  assert.deepEqual(fixtures, [])
})

test('stale title CAS retains the draft and latest acknowledged title for its session; reread is explicit', async () => {
  const early = snapshot('a1', { title: 'Existing custom', customTitle: 'Existing custom' })
  const external = snapshot('a2', { title: 'Changed elsewhere', customTitle: 'Changed elsewhere' })
  const finalized = snapshot('a3', { title: 'My updated title', customTitle: 'My updated title' })
  const aWrite = deferred()
  const seen = [], commits = [], blocked = []
  let aRead = early
  const c = createSessionPreferences({
    async read(sid) { seen.push(['read', sid]); return sid === 'a' ? aRead : snapshot('b1', { model: 'enabled:b' }) },
    async patch(sid, rev, set) { seen.push(['patch', sid, rev, set]); return rev === 'a1' ? aWrite.promise : finalized }
  }, { beforeWrite: async () => {}, expired: () => assert.fail('not expired'), committed: (...args) => commits.push(args), blocked: (...args) => blocked.push(args) })

  await c.read('a')
  c.beginRename('a')
  c.editRename('a', '  My\n updated  title  ')
  await c.read('b')
  assert.equal(c.get('b').draft, undefined)
  aRead = external
  await c.read('a') // Another tab's list invalidation observes the new title, but does not change our edit baseline.
  assert.equal(c.get('a').confirmed.revision, 'a2')
  assert.equal(c.get('a').draft.revision, 'a1')
  const writing = c.saveRename('a')
  assert.equal(projectSession(row('a', external.preferences), c.get('a').pending).title, 'My updated title')
  assert.equal(projectSession(row('b'), c.get('b').pending).title, 'First message')
  aWrite.reject(new HttpFailure(409, 'preferences_conflict'))
  assert.equal(await writing, false)
  assert.equal(c.get('a').pending, undefined)
  assert.equal(c.get('a').issue, 'conflict')
  assert.equal(c.get('a').draft.text, '  My\n updated  title  ')
  assert.equal(c.get('a').confirmed.preferences.title, 'Changed elsewhere')
  assert.equal(c.get('b').confirmed.preferences.model, 'enabled:b')
  assert.deepEqual(commits, [])
  assert.deepEqual(blocked, [['a', 'conflict']])
  await c.read('a')
  assert.equal(await c.saveRename('a'), false)
  assert.deepEqual(seen.at(-1), ['patch', 'a', 'a1', { customTitle: 'My updated title' }])
  await c.read('a', true)
  assert.deepEqual(c.get('a').draft, { text: '  My\n updated  title  ', initial: 'Changed elsewhere', revision: 'a2' })
  assert.equal(await c.saveRename('a'), true)
  assert.deepEqual(seen.at(-1), ['patch', 'a', 'a2', { customTitle: 'My updated title' }])
  assert.equal(c.get('a').draft, undefined)
  assert.deepEqual(commits, [['a', finalized.preferences]])
})

test('archive CAS rolls back the optimistic row and busy/readonly/storage/expiry responses stay distinct', async () => {
  const base = snapshot('r0')
  assert.equal(matchesPreferences(row('a'), base), true, 'the server omits archived:false')
  const archive = deferred()
  let next = () => archive.promise
  const blocked = [], commits = []
  let expired = 0
  const c = createSessionPreferences({ read: async () => base, async patch(_sid, rev, set) {
    assert.equal(rev, base.revision)
    return next(set)
  } }, { beforeWrite: async () => {}, expired: () => expired++, committed: (...args) => commits.push(args), blocked: (...args) => blocked.push(args) })
  await c.read('a')
  const writing = c.write('a', { archived: true })
  assert.equal(projectSession(row('a'), c.get('a').pending).archived, true)
  archive.reject(new HttpFailure(409, 'preferences_conflict'))
  assert.equal(await writing, false)
  assert.equal(projectSession(row('a'), c.get('a').pending).archived, undefined)
  assert.equal(c.get('a').needsRead, true)
  await c.read('a', true)
  for (const [status, code, issue] of [[409, 'turn_in_progress', 'busy'], [409, 'unsupported_history', 'readOnly'], [503, 'chat_storage_unconfirmed', 'storage']]) {
    next = () => { throw new HttpFailure(status, code) }
    assert.equal(await c.write('a', { archived: true }), false)
    assert.equal(c.get('a').issue, issue)
    if (issue !== 'busy') assert.equal(await c.write('a', { archived: true }), false, 'stale authorization requires rereading')
    await c.read('a', true)
  }
  assert.deepEqual(blocked, [['a', 'conflict'], ['a', 'busy'], ['a', 'readOnly'], ['a', 'storage']])
  assert.deepEqual(commits, [])
  next = set => { assert.deepEqual(set, { customTitle: null }); return snapshot('r1') }
  c.beginRename('a')
  c.editRename('a', '  \n ')
  assert.equal(await c.saveRename('a'), true)
  assert.equal(c.get('a').confirmed.preferences.title, 'First message')
  await c.read('b')
  next = () => { throw new HttpFailure(401, 'auth') }
  assert.equal(await c.write('b', { archived: true }), false)
  assert.equal(expired, 1)
  next = () => assert.fail('no calls after revocation')
  assert.equal(await c.write('b', { archived: true }), false)
})

function stream(invalidate, expire = () => assert.fail('not expired')) {
  const links = [], timers = []
  const s = createSessionsStream({ origin: 'https://workbench.invalid:4123', invalidate, expired: expire,
    open(url) {
      const ws = { url, closed: false, close() { this.closed = true },
        frame(data) { this.onmessage?.({ data: JSON.stringify(data) }) },
        drop(code, reason = '') { this.onclose?.({ code, reason }) } }
      links.push(ws)
      return ws
    }, schedule(fn, delay) {
      const pending = { fn, delay, cancelled: false }
      timers.push(pending)
      return () => { pending.cancelled = true }
    } })
  return { ...s, links, step() {
    const timer = timers.findLast(t => !t.cancelled)
    assert.ok(timer)
    timer.cancelled = true
    timer.fn()
    return timer.delay
  } }
}
const frame = (t, seq, generation = 'gen-a', epoch = 'epoch-a') => ({ t, cursor: { scope: 'sessions', epoch, generation, seq } })

test('a socket is independent of selection: fresh/reconnected/gapped watermarks invalidate GET, duplicates stay quiet', async () => {
  let reads = 0
  const first = deferred(), second = deferred(), third = deferred()
  const results = [], errors = []
  const active = createListRefresh(() => [first.promise, second.promise, third.promise][reads++], value => results.push(value), e => errors.push(e))
  const h = stream(active.request)
  assert.equal(h.links[0].url, 'wss://workbench.invalid:4123/api/v1/chats/stream')
  h.links[0].frame(frame('sessions-snapshot', 3))
  await flush()
  assert.equal(reads, 1)
  h.links[0].frame(frame('sessions-snapshot', 3))
  h.links[0].frame(frame('sessions-changed', 2))
  h.links[0].frame(frame('sessions-changed', 6)) // gap is one invalidation, not three reads
  h.links[0].frame(frame('sessions-changed', 6))
  h.links[0].frame(frame('sessions-changed', 10)) // coalesces with seq 6 while GET is pending
  await flush()
  assert.equal(reads, 1)
  first.resolve([row('a')])
  await flush()
  assert.equal(reads, 2)
  const external = [row('b'), row('a', { archived: true, title: 'Renamed externally' })]
  second.resolve(external)
  await flush()
  assert.equal(sessionAfterRefresh(results.at(-1), 'a', 'a', true), 'a')
  assert.equal(sessionAfterRefresh(results.at(-1), null, 'a', true), 'a')
  assert.equal(sessionAfterRefresh(results.at(-1), null, null, true), 'b')
  h.links[0].drop(1006)
  assert.equal(h.step(), 500)
  h.links[1].frame(frame('sessions-snapshot', 10)) // unchanged estimate still rereads on a new connection
  await flush()
  assert.equal(reads, 3)
  third.resolve(external)
  await flush()
  assert.deepEqual(errors, [])
  assert.equal(results.length, 3)
  h.close()
  active.close()
  assert.ok(h.links.every(ws => ws.closed))
})

test('unexpected generation or malformed envelope is recovered by GET, and auth close stops reconnecting', () => {
  let invalidations = 0, expired = 0
  const h = stream(() => invalidations++, () => expired++)
  h.links[0].frame(frame('sessions-snapshot', 0))
  h.links[0].frame(frame('sessions-changed', 1, 'new-gen'))
  assert.equal(invalidations, 2)
  assert.equal(h.links[0].closed, true)
  h.step()
  h.links[1].frame({ ...frame('sessions-snapshot', 0), unexpected: 'not a watermark' })
  assert.equal(invalidations, 3)
  h.step()
  h.links[2].frame(frame('sessions-snapshot', 0, 'new-gen', 'new-epoch'))
  assert.equal(invalidations, 4)
  h.links[2].drop(1008, 'auth')
  assert.equal(expired, 1)
  assert.throws(() => h.step())
  assert.equal(parseSessionsFrame(JSON.stringify({ t: 'sessions-changed', cursor: { ...frame('sessions-changed', 1).cursor, scope: 'chat:a' } })), null)
})

test('an acknowledged preference mutation suppresses a stale in-flight list result without reselecting', async () => {
  const stale = deferred(), fresh = deferred()
  const seen = []
  const outstanding = [stale, fresh]
  const refresh = createListRefresh(() => outstanding.shift().promise, value => seen.push(value), e => assert.fail(e.message))
  refresh.request()
  await flush()
  refresh.afterWrite()
  refresh.request()
  stale.resolve([row('a')])
  await flush()
  assert.deepEqual(seen, [])
  fresh.resolve([row('b'), row('a', { archived: true })])
  await flush()
  assert.equal(seen.length, 1)
  assert.equal(sessionAfterRefresh(seen[0], 'a', null, true), 'a')
  assert.equal(sessionAfterRefresh([row('b')], 'a', null, true), 'a')
  refresh.close()
})
