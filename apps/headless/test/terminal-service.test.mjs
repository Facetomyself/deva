import assert from 'node:assert/strict'
import { setImmediate as tick, setTimeout as sleep } from 'node:timers/promises'
import test from 'node:test'
import { HttpError } from '../src/http/policy.mjs'
import { openTerminalService } from '../src/terminal/service.mjs'

const login = loginSessionId => ({ role: 'owner', ownerId: 'same-owner', loginSessionId })
const a = login('a'), b = login('b'), c = login('c')
const wid = 'w_' + 'a'.repeat(32), other = 'w_' + 'b'.repeat(32)
const revision = 'r_' + 'c'.repeat(64)
const target = Object.freeze({ profile: 'text-view', path: 'doc/readme.txt', revision, cols: 80, rows: 12 })
const viewExit = (code, signal, reason) => ({ code, signal, reason })
const disposed = viewExit(null, 15, 'disposed'), quit = viewExit(0, null, 'quit'), lost = viewExit(null, null, 'worker-lost')
const problem = (status, code) => ({ status, code: `terminal_${code}` })
const unknown = problem(404, 'not_found'), stale = problem(409, 'source_changed'), invalid = problem(400, 'invalid')
const sequence = problem(409, 'sequence'), busy = problem(429, 'busy'), unavailable = problem(503, 'unavailable')
const deferred = () => Promise.withResolvers()
const page = (text, cols = 80, rows = 12, top = 0) => ({ cols, rows, top, left: 0, totalLines: 100, lines: [text] })

function rig(t, controls = {}, options = {}) {
  const logins = new Set(['a', 'b', 'c']), listeners = new Set(), connections = [], pins = [], requests = []
  let current = true
  const auth = {
    isLoginActive: actor => actor.ownerId === a.ownerId && logins.has(actor.loginSessionId),
    onSessionRevoked(callback) { listeners.add(callback); return () => listeners.delete(callback) },
  }
  const revoke = actor => { logins.delete(actor.loginSessionId); for (const cb of listeners) cb(actor.loginSessionId) }
  const worker = {
    probe(options) { return controls.probe?.(options) ?? true },
    open(args) {
      requests.push(args)
      const { text, cols, rows, onScreen, onExit } = args
      const keys = [], sizes = []
      let disposedCount = 0
      const connection = {
        keys, sizes, onScreen, onExit,
        screen: controls.screen?.(args) ?? page(text, cols, rows),
        get disposedCount() { return disposedCount },
        input(key) { keys.push(key); return controls.input?.(key, connection) },
        resize(cols, rows) { sizes.push([cols, rows]); return controls.resize?.(cols, rows, connection) },
        dispose() {
          disposedCount++
          if (controls.dispose) return controls.dispose(connection)
          onExit(disposed)
          return disposed
        },
      }
      connections.push(connection)
      return controls.open ? controls.open(connection, args) : Promise.resolve(connection)
    },
  }
  const openSource = (workspace, path, rev) => {
    controls.openSource?.(workspace, path, rev)
    const pin = {
      workspace, path, rev, text: `private snapshot for ${path}`, checked: 0, closed: 0,
      verify() {
        this.checked++
        if (this.closed || !current) throw Error('/absolute/path and credentials must stay private')
        controls.verifySource?.(this)
      },
      close() { this.closed++ },
    }
    pins.push(pin)
    return pin
  }
  const service = openTerminalService({ auth, worker, openSource, ...options })
  t.after(() => service.close())
  return { service, auth, revoke, connections, requests, pins, listeners, replace: () => { current = false } }
}

async function until(ready) {
  for (let attempt = 0; attempt < 50; attempt++) { if (ready()) return; await tick() }
  assert.ok(ready(), 'worker call arrived')
}

test('profiles describe the single fixed native viewer, disabled and failed probes', async t => {
  const r = rig(t)
  assert.deepEqual(await r.service.profiles(a), { available: true, profiles: [{ id: 'text-view', label: 'Read-only text viewer' }], reason: null })
  const { service: disabled } = rig(t, {}, { worker: null })
  assert.deepEqual(await disabled.profiles(a), { available: false, profiles: [], reason: 'unconfigured' })
  await assert.rejects(disabled.start(a, wid, target), unavailable)
  const { service: offline, requests } = rig(t, { probe: () => false })
  assert.deepEqual(await offline.profiles(a), { available: false, profiles: [], reason: 'unavailable' })
  await assert.rejects(offline.start(a, wid, target), unavailable)
  assert.deepEqual(requests, [])
  await assert.rejects(r.service.profiles(a, () => false), unknown)
  const pending = deferred()
  const separate = rig(t, { probe: () => pending.promise })
  const result = assert.rejects(separate.service.profiles(a), unknown)
  separate.revoke(a); pending.resolve(true)
  await result
})

test('fresh viewer can only access its own project and login, and worker gets only snapshot content', async t => {
  const { service, pins, requests, revoke, connections } = rig(t)
  const v = await service.start(a, wid, target)
  const v2 = await service.start(b, wid, target)
  assert.match(v.id, /^pt_[a-f0-9]{32}$/u)
  assert.notEqual(v2.id, v.id)
  assert.deepEqual(v, { id: v.id, cursor: 1, sequence: 0, screen: page(`private snapshot for ${target.path}`), exit: null })
  assert.deepEqual(pins.map(({ workspace, path, rev }) => ({ workspace, path, rev })), [{ workspace: wid, path: target.path, rev: revision }, { workspace: wid, path: target.path, rev: revision }])
  assert.ok(pins.every(pin => pin.checked > 0))
  assert.deepEqual(Object.keys(requests[0]).sort(), ['cols', 'onExit', 'onScreen', 'rows', 'signal', 'text'])
  for (const [actor, project, id] of [[b, wid, v.id], [a, other, v.id], [a, wid, 'pt_' + '0'.repeat(32)], [a, wid, 'invalid']]) {
    await assert.rejects(service.events(actor, project, id, { after: 0, waitMs: 0 }), unknown)
    await assert.rejects(service.input(actor, project, id, { sequence: 1, key: 'down' }), unknown)
    await assert.rejects(service.resize(actor, project, id, { sequence: 1, cols: 30, rows: 4 }), unknown)
    await assert.rejects(service.dispose(actor, project, id), unknown)
  }
  revoke(a)
  assert.equal(connections[0].disposedCount, 1)
  assert.equal(pins[0].closed, 1)
  assert.equal(connections[1].disposedCount, 0)
  assert.equal(pins[1].closed, 0)
  assert.equal((await service.events(b, wid, v2.id, { after: 0, waitMs: 0 })).events[0].type, 'screen')
  await assert.rejects(service.events(a, wid, v.id, { after: 0, waitMs: 0 }), unknown)
})

test('strict shape and exact integer limits fence native input and window changes', async t => {
  const { service, connections } = rig(t)
  for (const sample of [null, [], { ...target, rows: '12' }, { ...target, rows: 51 }, { ...target, cols: 23 },
    { ...target, cols: 24.1 }, { ...target, cols: Infinity }, { ...target, path: '../escape' }, { ...target, path: '/etc/passwd' },
    { ...target, profile: 'shell' }, { ...target, revision: revision + '\n' }, { ...target, cwd: '/' }]) {
    await assert.rejects(service.start(a, wid, sample), invalid)
  }
  assert.equal(connections.length, 0)
  const { id } = await service.start(a, wid, { ...target, cols: 24, rows: 4 })
  for (const sample of [{ sequence: '1', key: 'up' }, { sequence: 0, key: 'up' }, { sequence: 1.5, key: 'up' },
    { sequence: 2 ** 53, key: 'up' }, { sequence: 1, key: '__proto__' }, { sequence: 1, key: '\x1b[A' },
    { sequence: 1, key: 'echo hi' }, { sequence: 1, key: 'up', data: 'arbitrary' },
    { sequence: 1, get key() { assert.fail('must not evaluate getters') } }]) {
    await assert.rejects(service.input(a, wid, id, sample), invalid)
  }
  for (const sample of [{ sequence: 1, cols: 24 }, { sequence: 1, cols: 161, rows: 4 }, { sequence: 1, cols: 24, rows: 0 },
    { sequence: 1, cols: 24, rows: 4, key: 'quit' }]) await assert.rejects(service.resize(a, wid, id, sample), invalid)
  for (const sample of [{ after: '0', waitMs: 1 }, { after: -1, waitMs: 0 }, { after: 2 ** 53, waitMs: 0 },
    { after: 0 }, { after: 0, waitMs: 5001 }, { after: 0, waitMs: 4.5 }, { after: 0, waitMs: 0, poll: true }]) {
    await assert.rejects(service.events(a, wid, id, sample), invalid)
  }
  assert.deepEqual(connections[0].keys, [])
  assert.deepEqual(connections[0].sizes, [])
  await assert.rejects(service.events(a, wid, id, { after: 2, waitMs: 0 }), sequence)
})

test('changes wait for native ack, exclude competing changes, and replay only the exact last ack', async t => {
  const ack = deferred()
  const { service, connections } = rig(t, { input: () => ack.promise })
  const { id } = await service.start(a, wid, target)
  const input = { sequence: 1, key: 'down' }
  let done = false
  const pending = service.input(a, wid, id, input).then(value => { done = true; return value })
  await tick()
  assert.equal(done, false)
  await assert.rejects(service.input(a, wid, id, input), busy)
  await assert.rejects(service.resize(a, wid, id, { sequence: 1, cols: 90, rows: 20 }), busy)
  ack.resolve()
  assert.deepEqual(await pending, { sequence: 1 })
  assert.deepEqual(await service.input(a, wid, id, input), { sequence: 1 })
  await assert.rejects(service.input(a, wid, id, { ...input, key: 'up' }), sequence)
  const resize = { sequence: 2, cols: 160, rows: 50 }
  await assert.rejects(service.resize(a, wid, id, { ...resize, sequence: 3 }), sequence)
  assert.deepEqual(await service.resize(a, wid, id, resize), { sequence: 2 })
  assert.deepEqual(await service.resize(a, wid, id, resize), { sequence: 2 })
  await assert.rejects(service.input(a, wid, id, input), sequence)
  assert.deepEqual(connections[0].keys, ['down'])
  assert.deepEqual(connections[0].sizes, [[160, 50]])
})

test('one poll per view, no dummy timeout event, external cancellation, resync and observed native quit', async t => {
  const { service, connections } = rig(t)
  const { id } = await service.start(a, wid, target)
  const start = await service.events(a, wid, id, { after: 0, waitMs: 0 })
  assert.equal(start.events[0].seq, 1)
  const poll = service.events(a, wid, id, { after: 1, waitMs: 15 })
  await assert.rejects(service.events(a, wid, id, { after: 1, waitMs: 0 }), busy)
  assert.deepEqual(await poll, { cursor: 1, reset: false, events: [] })
  const abort = new AbortController()
  const aborted = assert.rejects(service.events(a, wid, id, { after: 1, waitMs: 5000 }, undefined, abort.signal), unavailable)
  abort.abort()
  await aborted
  const waited = service.events(a, wid, id, { after: 1, waitMs: 1000 })
  const native = connections[0]
  native.onScreen(page('new', 80, 12, 1))
  assert.deepEqual((await waited).events, [{ seq: 2, type: 'screen', screen: page('new', 80, 12, 1) }])
  for (let n = 2; n <= 12; n++) native.onScreen(page(`line ${n}`, 80, 12, n))
  let quitAck = false
  const expected = service.input(a, wid, id, { sequence: 1, key: 'quit' }).then(value => { quitAck = true; return value })
  await tick()
  assert.equal(quitAck, false)
  native.onExit(quit)
  native.onExit(disposed)
  assert.deepEqual(await expected, { sequence: 1 })
  assert.deepEqual(await service.input(a, wid, id, { sequence: 1, key: 'quit' }), { sequence: 1 })
  assert.deepEqual(native.keys, ['quit'])
  const result = await service.events(a, wid, id, { after: 0, waitMs: 0 })
  assert.deepEqual(result, { cursor: 14, reset: true, events: [
    { seq: 13, type: 'screen', screen: page('line 12', 80, 12, 12) }, { seq: 14, type: 'exit', exit: quit },
  ] })
  assert.deepEqual(await service.events(a, wid, id, { after: 14, waitMs: 5000 }), { cursor: 14, reset: false, events: [] })
})

test('revoke during launch aborts and closes source; a worker that arrives late is disposed once', async t => {
  const open = deferred()
  const { service, revoke, requests, pins, connections } = rig(t, { open: () => open.promise })
  const opening = assert.rejects(service.start(a, wid, target), unknown)
  await until(() => requests.length === 1)
  revoke(a)
  assert.equal(requests[0].signal.aborted, true)
  assert.equal(pins[0].closed, 1)
  await opening
  open.resolve(connections[0])
  await until(() => connections[0].disposedCount === 1)
  assert.equal(pins[0].closed, 1)
})

test('revocation clears pending action, long poll and tombstones for the revoked login only', async t => {
  const ack = deferred()
  const { service, revoke, connections, pins } = rig(t, { input: () => ack.promise })
  const { id } = await service.start(a, wid, target)
  const secondary = await service.start(b, wid, target)
  const action = assert.rejects(service.input(a, wid, id, { sequence: 1, key: 'end' }), unknown)
  const poll = assert.rejects(service.events(a, wid, id, { after: 1, waitMs: 5000 }), unknown)
  revoke(a)
  assert.equal(pins[0].closed, 1)
  assert.equal(connections[0].disposedCount, 1)
  connections[0].onScreen(page('buffered bytes must stay private'))
  ack.resolve()
  await Promise.all([action, poll])
  assert.equal(pins[1].closed, 0)
  assert.deepEqual(await service.dispose(b, wid, secondary.id), { closed: true, exit: disposed })
  assert.equal(pins[1].closed, 1)
  assert.deepEqual(await service.dispose(b, wid, secondary.id), { closed: true, exit: disposed })
  revoke(b)
  await assert.rejects(service.dispose(b, wid, secondary.id), unknown)
})

test('replacement during open or a native action defeats even a successful worker result', async t => {
  const open = deferred()
  const opening = rig(t, { open: () => open.promise })
  const ready = assert.rejects(opening.service.start(a, wid, target), stale)
  await until(() => opening.connections.length === 1)
  opening.replace()
  open.resolve(opening.connections[0])
  await ready
  assert.equal(opening.connections[0].disposedCount, 1)
  assert.equal(opening.pins[0].closed, 1)
  const ack = deferred()
  const action = rig(t, { input: () => ack.promise })
  const { id } = await action.service.start(a, wid, target)
  const input = assert.rejects(action.service.input(a, wid, id, { sequence: 1, key: 'right' }), stale)
  action.replace()
  ack.resolve()
  await input
  await assert.rejects(action.service.events(a, wid, id, { after: 0, waitMs: 0 }), stale)
  assert.equal(action.connections[0].disposedCount, 1)
  assert.equal(action.pins[0].closed, 1)
})

test('replacement during poll and after native exit clears buffered content', async t => {
  const live = rig(t)
  const v = await live.service.start(a, wid, target)
  const waited = assert.rejects(live.service.events(a, wid, v.id, { after: 1, waitMs: 5000 }), stale)
  live.replace()
  live.connections[0].onScreen(page('must not be delivered'))
  await waited
  await assert.rejects(live.service.events(a, wid, v.id, { after: 0, waitMs: 0 }), stale)
  const ended = rig(t)
  const v2 = await ended.service.start(a, wid, target)
  ended.connections[0].onExit(quit)
  ended.replace()
  await assert.rejects(ended.service.events(a, wid, v2.id, { after: 0, waitMs: 0 }), stale)
  assert.equal(ended.pins[0].closed, 1)
})

test('source watcher interrupts a hung action even when the worker emits nothing', async t => {
  const never = deferred()
  const { service, replace, connections } = rig(t, { input: () => never.promise }, { sweepMs: 5 })
  const { id } = await service.start(a, wid, target)
  const pending = assert.rejects(service.input(a, wid, id, { sequence: 1, key: 'up' }), stale)
  replace()
  await pending
  assert.equal(connections[0].disposedCount, 1)
})

test('request-specific authorization is reasserted before exposing a waiter result', async t => {
  const { service, connections, pins } = rig(t)
  const { id } = await service.start(a, wid, target)
  let authorized = true
  const verify = () => { if (!authorized) throw Error('private authorization detail') }
  const result = assert.rejects(service.events(a, wid, id, { after: 1, waitMs: 1000 }, verify), unknown)
  connections[0].onScreen(page('already buffered'))
  authorized = false
  await result
  assert.equal(pins[0].closed, 1)
  await assert.rejects(service.events(a, wid, id, { after: 0, waitMs: 0 }), unknown)
})

test('an armed poll sees the observed dispose exit before the source is released', async t => {
  const { service, pins } = rig(t)
  const { id } = await service.start(a, wid, target)
  const exitPoll = service.events(a, wid, id, { after: 1, waitMs: 5000 })
  const closing = service.dispose(a, wid, id)
  assert.deepEqual(await exitPoll, { cursor: 2, reset: false, events: [{ seq: 2, type: 'exit', exit: disposed }] })
  assert.deepEqual(await closing, { closed: true, exit: disposed })
  assert.equal(pins[0].closed, 1)
  await assert.rejects(service.events(a, wid, id, { after: 0, waitMs: 0 }), unknown)
})

test('system and login caps include launches awaiting a worker', async t => {
  const held = deferred()
  const { service, requests, connections } = rig(t, { open: connection => held.promise.then(() => connection) })
  const starts = [service.start(a, wid, target), service.start(a, other, target), service.start(b, wid, target), service.start(b, other, target)]
  await until(() => requests.length === 4)
  await assert.rejects(service.start(a, wid, target), busy)
  await assert.rejects(service.start(c, wid, target), busy)
  held.resolve()
  const [first] = await Promise.all(starts)
  await service.dispose(a, wid, first.id)
  await service.start(c, wid, target)
  assert.equal(connections.length, 5)
})

test('a canceled noncooperative launch retains its capacity slot until late cleanup', async t => {
  const held = deferred()
  const { service, requests, connections, revoke } = rig(t, { open: connection => held.promise.then(() => connection) })
  const old = assert.rejects(service.start(a, wid, target), unknown)
  const remaining = [service.start(b, wid, target), service.start(b, other, target), service.start(c, wid, target)]
  await until(() => requests.length === 4)
  revoke(a)
  await old
  await assert.rejects(service.start(c, other, target), busy)
  held.resolve()
  await Promise.all(remaining)
  assert.equal(connections[0].disposedCount, 1)
  await service.start(c, other, target)
})

test('per-view rate ignores exact replays; idle and absolute lifetimes free worker slots', async t => {
  let clock = 0
  const { service, connections, pins } = rig(t, {}, { now: () => clock, idleMs: 30, maxLifetimeMs: 65, inputBurst: 1, inputRefillMs: 10 })
  const { id } = await service.start(a, wid, target)
  await service.input(a, wid, id, { sequence: 1, key: 'up' })
  assert.deepEqual(await service.input(a, wid, id, { sequence: 1, key: 'up' }), { sequence: 1 })
  await assert.rejects(service.input(a, wid, id, { sequence: 2, key: 'up' }), busy)
  clock = 10
  await service.input(a, wid, id, { sequence: 2, key: 'up' })
  for (clock of [15, 20, 25, 30, 35, 39]) await service.events(a, wid, id, { after: 1, waitMs: 0 })
  clock = 40 // Automatic event polls did not renew the idle lease.
  await assert.rejects(service.events(a, wid, id, { after: 1, waitMs: 0 }), unknown)
  assert.equal(pins[0].closed, 1)
  assert.equal(connections[0].disposedCount, 1)
  const next = await service.start(a, wid, target)
  for (const [index, time] of [60, 80, 100].entries()) {
    clock = time
    await service.input(a, wid, next.id, { sequence: index + 1, key: 'up' })
  }
  clock = 105 // Even active input did not renew the absolute lifetime.
  await assert.rejects(service.events(a, wid, next.id, { after: 1, waitMs: 0 }), unknown)
  assert.equal(pins[1].closed, 1)
  assert.equal(connections[1].disposedCount, 1)
})

test('dispose preempts an unfinished action, reports the real exit, and has small expiring same-login tombstones', async t => {
  const never = deferred()
  let clock = 0
  const { service, connections, pins } = rig(t, { input: () => never.promise }, { now: () => clock, tombstoneMs: 15 })
  const { id } = await service.start(a, wid, target)
  const pending = assert.rejects(service.input(a, wid, id, { sequence: 1, key: 'up' }), unavailable)
  assert.deepEqual(await service.dispose(a, wid, id), { closed: true, exit: disposed })
  await pending
  assert.equal(connections[0].disposedCount, 1)
  assert.equal(pins[0].closed, 1)
  await assert.rejects(service.dispose(b, wid, id), unknown)
  assert.deepEqual(await service.dispose(a, wid, id), { closed: true, exit: disposed })
  for (let i = 0; i < 17; i++) {
    const next = await service.start(a, wid, target)
    await service.dispose(a, wid, next.id)
  }
  await assert.rejects(service.dispose(a, wid, id), unknown)
  const last = await service.start(a, wid, target)
  connections.at(-1).onExit(quit)
  clock = 15
  await assert.rejects(service.dispose(a, wid, last.id), unknown)
  assert.equal(pins.at(-1).closed, 1)
})

test('fault paths project only approved public errors and a bounded lost exit', async t => {
  const error = Error('/absolute/path and credentials must stay private')
  const aborted = rig(t, { open: () => Promise.reject(error) })
  await assert.rejects(aborted.service.start(a, wid, target), unavailable)
  const malformed = rig(t, { screen: () => page('\u001b[31m') })
  await assert.rejects(malformed.service.start(a, wid, target), unavailable)
  assert.equal(malformed.connections[0].disposedCount, 1)
  for (const [status, code] of [[404, 'not_found'], [403, 'source_denied'], [409, 'source_changed'], [413, 'limit'], [422, 'unsupported']]) {
    const expected = problem(status, code)
    const r = rig(t, { openSource() { throw new HttpError(status, expected.code) } })
    await assert.rejects(r.service.start(a, wid, target), expected)
  }
  const never = deferred()
  const { service, connections, pins, requests } = rig(t, { dispose: () => never.promise }, { disposeTimeoutMs: 15 })
  const { id } = await service.start(a, wid, target)
  assert.deepEqual(await service.dispose(a, wid, id), { closed: true, exit: lost })
  assert.equal(requests[0].signal.aborted, true)
  assert.equal(connections[0].disposedCount, 1)
  assert.equal(pins[0].closed, 1)
  never.resolve()
})

test('close stops all waiters, is idempotent and does not await a hung or late launch forever', async t => {
  const open = deferred(), unsupported = deferred()
  const { service, connections, requests, pins, listeners } = rig(t, { open: connection => connections.length > 1 ? open.promise : connection,
    input: () => unsupported.promise, dispose: () => unsupported.promise }, { disposeTimeoutMs: 15 })
  const { id } = await service.start(a, wid, target)
  const pendingOpen = assert.rejects(service.start(b, wid, target), unavailable)
  const action = assert.rejects(service.input(a, wid, id, { sequence: 1, key: 'end' }), unavailable)
  const poll = assert.rejects(service.events(a, wid, id, { after: 1, waitMs: 5000 }), unavailable)
  await until(() => requests.length === 2)
  const closing = service.close()
  assert.equal(service.close(), closing)
  assert.ok(requests.every(({ signal }) => signal.aborted))
  assert.ok(pins.every(({ closed }) => closed === 1))
  assert.equal(listeners.size, 0)
  await Promise.all([closing, pendingOpen, action, poll])
  await assert.rejects(service.profiles(a), unavailable)
  open.resolve(connections[1]); await until(() => connections[1].disposedCount === 1)
  unsupported.resolve()
})

test('open deadline returns a stable error and cleans up a late resolved connection', async t => {
  const open = deferred()
  const { service, connections, requests, pins } = rig(t, { open: () => open.promise }, { openTimeoutMs: 15 })
  await assert.rejects(service.start(a, wid, target), unavailable)
  assert.equal(requests[0].signal.aborted, true)
  assert.equal(pins[0].closed, 1)
  open.resolve(connections[0]); await sleep(5)
  assert.equal(connections[0].disposedCount, 1)
})
