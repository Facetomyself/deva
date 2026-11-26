import assert from 'node:assert/strict'
import { setImmediate as tick, setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { chatScope, createEventJournal, SESSIONS_SCOPE } from '../src/events/index.mjs'

const timeout = { timeout: 2500 }
const A = chatScope('sess_a')
const B = chatScope('sess_b')
const C = chatScope('sess_c')
const text = (journal, sessionId, value) =>
  journal.publishChat({ sessionId, turnId: 'turn_1', event: { type: 'text_delta', text: value } })

function setup(t, limits) {
  const journal = createEventJournal(limits)
  t.after(() => journal.close())
  return journal
}

const fresh = (reason) => ({ status: 'fresh_snapshot', reason })

test('snapshot and synchronous attach replay a gap-free ordered scope, including a reentrant publish', timeout, async (t) => {
  const j = setup(t)
  const events = []; const list = []
  text(j, 'sess_a', 'in snapshot')
  const { cursor, state } = j.snapshot(A, () => ({ text: 'in snapshot' }))
  assert.deepEqual(state, { text: 'in snapshot' })
  assert.equal(cursor.seq, 1)
  text(j, 'sess_a', 'in between')
  const sub = j.subscribe(A, cursor, {
    onEvent(frame) {
      events.push([frame.cursor.seq, frame.event.text])
      if (frame.cursor.seq === 2) text(j, 'sess_a', 'from callback')
    }
  })
  const initial = j.snapshotAndSubscribe(SESSIONS_SCOPE, () => [], { onEvent: (frame) => list.push(frame) })
  assert.deepEqual(initial.snapshot.state, [])
  assert.equal(initial.subscription.status, 'subscribed')
  assert.equal(sub.status, 'subscribed')
  text(j, 'sess_b', 'private to B')
  text(j, 'sess_a', 'live')
  j.publishSessionsChanged()
  assert.deepEqual(events, []) // A Node publisher doesn't run user callbacks on its stack.
  await tick()
  assert.deepEqual(events, [[2, 'in between'], [3, 'live'], [4, 'from callback']])
  assert.deepEqual(list, [{ cursor: { ...initial.snapshot.cursor, seq: 1 }, type: 'sessions_changed' }])
  sub.close()
  sub.close()
  text(j, 'sess_a', 'after close')
  await tick()
  assert.equal(events.length, 3)
})

test('snapshot reader must be synchronous and a same-scope write invalidates its result', timeout, async (t) => {
  const j = setup(t)
  assert.throws(() => j.snapshot(A, async () => { throw new Error('fixture') }), /must be synchronous/)
  assert.throws(() => j.snapshot(A, () => text(j, 'sess_a', 'during read')), { code: 'SNAPSHOT_CHANGED' })
  assert.equal(j.snapshot(A).cursor.seq, 1)
  assert.throws(() => chatScope('sess_a\n'), /Invalid chat session id/)
  assert.throws(() => j.snapshot('chat:../other'), /Invalid event scope/)
})

test('resumes from the last applied cursor and distinguishes all fresh-snapshot conditions', timeout, async (t) => {
  const j = setup(t, { maxEventsPerScope: 2 })
  const other = setup(t)
  const got = []; const callbacks = { onEvent: (frame) => got.push(frame.cursor.seq) }
  const initial = j.snapshot(A).cursor
  const first = text(j, 'sess_a', 'first').cursor
  text(j, 'sess_a', 'second')
  text(j, 'sess_a', 'third')
  assert.equal(j.stats().retainedEvents, 2)
  assert.deepEqual(j.subscribe(A, initial, callbacks), fresh('history_lost'))
  assert.deepEqual(j.subscribe(A, other.snapshot(A).cursor, callbacks), fresh('epoch_mismatch'))
  assert.deepEqual(j.subscribe(B, first, callbacks), fresh('scope_mismatch'))
  assert.deepEqual(j.subscribe(A, { ...first, seq: 9 }, callbacks), fresh('future_cursor'))
  assert.deepEqual(j.subscribe(A, { ...first, seq: -1 }, callbacks), fresh('invalid_cursor'))
  assert.equal(j.subscribe(A, JSON.parse(JSON.stringify(first)), callbacks).status, 'subscribed')
  await tick()
  assert.deepEqual(got, [2, 3])
})

test('aggregate UTF-8 bytes cap retention across scopes and session LRU fences evicted cursors', timeout, async (t) => {
  const j = setup(t, { maxChatStreams: 2, maxBytes: 500 })
  const initialA = j.snapshot(A).cursor
  const first = text(j, 'sess_a', '🙂'.repeat(25))
  const encodedA = j.stats().retainedBytes
  assert.equal(first.status, 'published')
  const closed = Promise.withResolvers()
  j.subscribe(A, first.cursor, { onEvent() {}, onClose: closed.resolve })
  const initialB = j.snapshot(B).cursor
  text(j, 'sess_b', '🙂'.repeat(25))
  assert.equal(j.stats().retainedBytes, encodedA)
  assert.equal(j.stats().retainedEvents, 1)
  assert.deepEqual(j.subscribe(A, initialA, { onEvent() {} }), fresh('history_lost'))
  const list = j.publishSessionsChanged()
  assert.equal(j.stats().retainedEvents, 2)
  assert.ok(j.stats().retainedBytes <= 500)
  const initialC = j.snapshot(C).cursor
  assert.equal(await closed.promise, 'scope_evicted')
  assert.equal(j.stats().chatStreams, 2)
  assert.equal(j.snapshot(SESSIONS_SCOPE).cursor.generation, list.cursor.generation)
  assert.equal(j.snapshot(B).cursor.generation, initialB.generation)
  const newA = j.snapshot(A).cursor
  assert.notEqual(newA.generation, initialA.generation)
  assert.equal(newA.epoch, initialA.epoch)
  assert.equal(newA.seq, 0)
  assert.deepEqual(j.subscribe(A, first.cursor, { onEvent() {} }), fresh('history_lost'))
  assert.deepEqual(j.subscribe(C, initialC, { onEvent() {} }), fresh('history_lost'))
})

test('an oversized output is a replay barrier, including JSON escaping overhead', timeout, async (t) => {
  const j = setup(t, { maxBytes: 600, maxEventBytes: 350 })
  const { cursor } = j.snapshot(A)
  const lost = []; const got = []
  j.subscribe(A, cursor, { onEvent: (frame) => got.push(frame), onClose: (reason) => lost.push(reason) })
  assert.equal(text(j, 'sess_a', 'normal').status, 'published')
  const oversized = text(j, 'sess_a', '\n'.repeat(200))
  assert.equal(oversized.status, 'snapshot_required')
  assert.equal(oversized.cursor.seq, 2)
  assert.equal(j.stats().retainedBytes, 0)
  assert.equal(text(j, 'sess_a', 'another').status, 'published')
  await tick()
  assert.deepEqual(got, [])
  assert.deepEqual(lost, ['history_lost'])
  assert.deepEqual(j.subscribe(A, cursor, { onEvent() {} }), fresh('history_lost'))
  const reset = j.snapshotAndSubscribe(A, () => ({ text: 'full state' }), { onEvent: (frame) => got.push(frame) })
  assert.equal(reset.snapshot.cursor.seq, 3)
  text(j, 'sess_a', 'after fresh snapshot')
  await tick()
  assert.deepEqual(got.map((frame) => frame.cursor.seq), [4])
})

test('stalled consumer holds at most one frame and is cut off when overtaken', timeout, async (t) => {
  const j = setup(t, { maxEventsPerScope: 2, maxSubscribers: 2 })
  const cursor = j.snapshot(A).cursor
  const blocked = Promise.withResolvers()
  const slow = []; const fast = []; const closed = []
  j.subscribe(A, cursor, {
    onEvent(frame) { slow.push(frame.cursor.seq); return blocked.promise },
    onClose: (reason) => closed.push(reason)
  })
  j.subscribe(A, cursor, { onEvent: (frame) => fast.push(frame.cursor.seq) })
  const overflow = j.subscribe(A, cursor, { onEvent() {} })
  assert.deepEqual(overflow, { status: 'busy' })
  for (let i = 1; i <= 5; i++) {
    text(j, 'sess_a', `frame ${i}`)
    await tick()
  }
  assert.deepEqual(slow, [1])
  assert.deepEqual(fast, [1, 2, 3, 4, 5])
  assert.deepEqual(closed, ['history_lost'])
  assert.equal(j.stats().subscribers, 1)
  assert.equal(j.stats().retainedEvents, 2)
  blocked.reject(new Error('late rejection after detach'))
  await tick()
})

test('async sink resumes strictly in order and false or throw isolates the affected subscriber', timeout, async (t) => {
  const j = setup(t)
  const applied = []; const closed = []; const gated = Promise.withResolvers()
  const { cursor } = j.snapshot(A)
  j.subscribe(A, cursor, {
    onEvent(frame) {
      applied.push(frame.event.text)
      if (frame.cursor.seq === 1) return gated.promise
      if (frame.cursor.seq === 3) return false
    },
    onClose(reason) { closed.push(reason); throw new Error('onClose fixture') }
  })
  j.subscribe(A, cursor, {
    onEvent() { throw new Error('onEvent fixture') },
    async onClose(reason) { closed.push(reason); throw new Error('async onClose fixture') }
  })
  j.subscribe(A, cursor, {
    async onEvent() { throw new Error('async onEvent fixture') },
    onClose: (reason) => closed.push(reason)
  })
  const clean = []
  j.subscribe(A, cursor, { onEvent: (frame) => clean.push(frame.event.text) })
  for (const value of ['one', 'two', 'three', 'four']) text(j, 'sess_a', value)
  await tick()
  assert.deepEqual(closed, ['consumer_error', 'consumer_error'])
  assert.deepEqual(applied, ['one'])
  assert.deepEqual(clean, ['one', 'two', 'three', 'four'])
  gated.resolve()
  await tick() // settle is a microtask that schedules a subsequent immediate
  await tick()
  assert.deepEqual(applied, ['one', 'two', 'three'])
  assert.deepEqual(closed, ['consumer_error', 'consumer_error', 'backpressure'])
  assert.equal(j.stats().subscribers, 1)
})

test('idle slow delivery expires; journal close cleans up all scopes even with in-flight delivery', timeout, async (t) => {
  const j = setup(t, { deliveryTimeoutMs: 20 })
  const never = new Promise(() => {})
  const timedOut = Promise.withResolvers()
  const closed = Promise.withResolvers()
  j.snapshotAndSubscribe(A, () => null, { onEvent: () => never, onClose: timedOut.resolve })
  text(j, 'sess_a', 'one')
  const [reason] = await Promise.all([timedOut.promise, delay(30)]) // the production delivery timer is unref'd
  assert.equal(reason, 'delivery_timeout')
  assert.equal(j.stats().subscribers, 0)
  const { snapshot: { cursor } } = j.snapshotAndSubscribe(B, () => null, { onEvent: () => never, onClose: closed.resolve })
  text(j, 'sess_b', 'one')
  await tick()
  j.close()
  j.close()
  assert.equal(await closed.promise, 'journal_closed')
  assert.deepEqual(j.stats(), { retainedBytes: 0, retainedEvents: 0, chatStreams: 0, subscribers: 0 })
  assert.deepEqual(j.subscribe(B, cursor, { onEvent() {} }), { status: 'closed' })
  assert.deepEqual(j.publishSessionsChanged(), { status: 'closed' })
  assert.throws(() => j.snapshot(B), /closed/)
})
