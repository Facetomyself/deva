import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { setImmediate as tick } from 'node:timers/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { chatScope, installDesktopEventBridge, SESSIONS_SCOPE } from '../src/events/index.mjs'

const busPath = new URL('../../desktop/src/main/services/chat-bus.ts', import.meta.url)
const [major, minor] = process.versions.node.split('.').map(Number)
// The supported Node 22 line gained flag-free TS loading in 22.18. Earlier 22.x can use the
// existing headless build dependency. Either path executes the actual desktop EventEmitter bus.
async function loadBus() {
  if (major > 22 || (major === 22 && minor >= 18)) return import(busPath.href)
  const { build } = createRequire(import.meta.url)('esbuild')
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(busPath)], bundle: true, platform: 'node', format: 'esm', write: false
  })
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`)
}

const desktop = await loadBus()
const timeout = { timeout: 2500 }
const scope = chatScope('sess_desktop')
const publish = (event) => desktop.publishChatEvent({ sessionId: 'sess_desktop', turnId: 'turn_1', event })

function trackRegistrations() {
  const installed = []; const received = []; const removed = []
  const source = Object.fromEntries(['onChatEvent', 'onSessionsChanged'].map((name) => [name, (listener) => {
    installed.push(name)
    const off = desktop[name]((event) => { received.push(name); listener(event) })
    return () => { removed.push(name); off() }
  }]))
  return { source, installed, received, removed }
}

test('installs and removes the two real desktop callbacks; scope delivery and epoch follow the bridge lifetime', timeout, async (t) => {
  const { source, installed, removed, received } = trackRegistrations()
  const { journal, uninstall } = installDesktopEventBridge(source)
  t.after(uninstall)
  assert.deepEqual(installed, ['onChatEvent', 'onSessionsChanged'])
  const events = []; const listChanges = []; const closed = []
  const first = journal.snapshotAndSubscribe(scope, () => null, {
    onEvent: (frame) => events.push(frame), onClose: (reason) => closed.push(reason)
  })
  journal.snapshotAndSubscribe(SESSIONS_SCOPE, () => [], { onEvent: (frame) => listChanges.push(frame.type) })
  publish({ type: 'text_delta', text: 'from desktop' })
  desktop.publishChatEvent({ sessionId: 'sess_other', turnId: 'turn_2', event: { type: 'text_delta', text: 'other scope' } })
  desktop.publishSessionsChanged()
  await tick()
  assert.deepEqual(events.map((frame) => frame.event.text), ['from desktop'])
  assert.deepEqual(listChanges, ['sessions_changed'])
  assert.deepEqual(received, ['onChatEvent', 'onChatEvent', 'onSessionsChanged'])
  uninstall()
  uninstall()
  publish({ type: 'text_delta', text: 'after unsubscribe' })
  desktop.publishSessionsChanged()
  await tick()
  assert.deepEqual(removed, ['onSessionsChanged', 'onChatEvent'])
  assert.equal(received.length, 3)
  assert.deepEqual(closed, ['journal_closed'])
  assert.equal(journal.stats().retainedEvents, 0)
  assert.equal(journal.stats().subscribers, 0)
  const next = installDesktopEventBridge(desktop)
  t.after(next.uninstall)
  assert.notEqual(next.journal.epoch, journal.epoch)
  assert.deepEqual(next.journal.subscribe(scope, first.snapshot.cursor, { onEvent() {} }), {
    status: 'fresh_snapshot', reason: 'epoch_mismatch'
  })
})

test('only the explicitly projected desktop fields can enter retained/replayed output', timeout, async (t) => {
  const { journal, uninstall } = installDesktopEventBridge(desktop)
  t.after(uninstall)
  const before = journal.snapshot(scope).cursor
  const fixture = 'never-store-this-fixture-PROVIDER-KEY-PTY-SCREENSHOT'
  const notJson = { apiKey: fixture, toJSON() { assert.fail('nested data reached JSON.stringify') } }
  const unprojected = [
    { type: 'provider_settings', headers: notJson }, { type: 'pty_data', bytes: fixture },
    { type: 'browser_screenshot', base64: fixture }, { type: 'thinking_delta', text: fixture },
    { type: 'tool_call', name: 'shell', args: notJson }, { type: 'tool_result', name: 'browser', summary: fixture },
    { type: 'insert', text: fixture }, { type: 'text_delta', text: notJson }
  ]
  for (const event of unprojected) publish(event)
  assert.equal(journal.stats().retainedEvents, 0)
  assert.equal(journal.snapshot(scope).cursor.seq, 0)
  publish({ type: 'turn_start', user: { text: fixture, attachments: [notJson] } })
  publish({ type: 'text_delta', text: 'public assistant prose', config: notJson, payload: Buffer.from(fixture) })
  publish({ type: 'error', kind: fixture, message: fixture })
  publish({ type: 'done', stopReason: 'end_turn', durationMs: 42, unsafe: notJson })
  desktop.publishChatEvent({ sessionId: 'sess_desktop', turnId: '', event: { type: 'member_report', detail: notJson } })
  desktop.publishSessionsChanged(notJson)
  const replay = []; const list = []
  journal.subscribe(scope, before, { onEvent: (frame) => replay.push(frame) })
  journal.subscribe(SESSIONS_SCOPE, { ...journal.snapshot(SESSIONS_SCOPE).cursor, seq: 0 }, {
    onEvent: (frame) => list.push(frame)
  })
  await tick()
  assert.deepEqual(replay.map((frame) => frame.event), [
    { type: 'turn_start' }, { type: 'text_delta', text: 'public assistant prose' },
    { type: 'error' }, { type: 'done', stopReason: 'end_turn', durationMs: 42 }, { type: 'member_report' }
  ])
  assert.deepEqual(replay.map((frame) => frame.cursor.seq), [1, 2, 3, 4, 5])
  assert.deepEqual(list.map(({ cursor, ...frame }) => [cursor.seq, frame]),
    [1, 2, 3, 4].map((seq) => [seq, { type: 'sessions_changed' }]))
  assert.ok(!JSON.stringify({ replay, list }).includes(fixture))
  assert.equal(journal.stats().retainedBytes, [...replay, ...list].reduce((sum, frame) =>
    sum + Buffer.byteLength(JSON.stringify(frame)), 0))
})

test('partial installation rolls back a real registration and malformed inputs leave other listeners intact', timeout, async (t) => {
  const { source, received, removed } = trackRegistrations()
  const broken = { ...source, onSessionsChanged() { throw new Error('registration fixture') } }
  assert.throws(() => installDesktopEventBridge(broken), /registration fixture/)
  publish({ type: 'text_delta', text: 'not observed by the rolled-back callback' })
  assert.deepEqual(removed, ['onChatEvent'])
  assert.deepEqual(received, [])

  const { journal, uninstall } = installDesktopEventBridge(desktop)
  t.after(uninstall)
  const business = []
  t.after(desktop.onChatEvent((payload) => business.push(payload.turnId)))
  const brokenEvent = { get type() { throw new Error('malformed event fixture') } }
  assert.doesNotThrow(() => publish(brokenEvent))
  publish({ type: 'text_delta', text: 'business continues' })
  assert.deepEqual(business, ['turn_1', 'turn_1'])
  assert.equal(journal.snapshot(scope).cursor.seq, 1)
})
