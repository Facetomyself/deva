import assert from 'node:assert/strict'
import test from 'node:test'
import { openTerminalJournal } from '../src/terminal/journal.mjs'
import { checkedExit, checkedScreen, lostExit } from '../src/terminal/validation.mjs'

const exit = Object.freeze({ code: 0, signal: null, reason: 'quit' })
const screen = (top = 0, lines = [String(top)]) => ({ cols: 160, rows: 50, top, left: 0, totalLines: 123, lines })

test('journal delivers ordered events, latest screen on gap, and one final exit per cursor', () => {
  const ring = openTerminalJournal()
  for (let i = 0; i < 10; i++) ring.screen(screen(i))
  assert.deepEqual(ring.read(1), { cursor: 10, reset: true, events: [{ seq: 10, type: 'screen', screen: screen(9) }] })
  assert.deepEqual(ring.read(8).events.map(({ seq }) => seq), [9, 10])
  ring.finish(exit)
  ring.finish({ code: 99, signal: null, reason: 'fault' })
  ring.screen(screen(10))
  const final = { seq: 11, type: 'exit', exit }
  assert.deepEqual(ring.read(10), { cursor: 11, reset: false, events: [final] })
  assert.deepEqual(ring.read(0), { cursor: 11, reset: true, events: [{ seq: 10, type: 'screen', screen: screen(9) }, final] })
  assert.deepEqual(ring.read(11), { cursor: 11, reset: false, events: [] })
  assert.throws(() => ring.read(12), { status: 409, code: 'terminal_sequence' })
  ring.clear()
  assert.deepEqual(ring.read(0).events, [])
})

test('journal limits serialized event replies even for JSON-heavy screens', () => {
  const ring = openTerminalJournal()
  const escaped = '\\"'.repeat(79)
  const lines = Array(50).fill(`${escaped}x `)
  lines[0] = `${escaped}x${'\u0301'.repeat(45_152)} `
  assert.equal(Buffer.byteLength(lines.join('')), 96 * 1024)
  assert.ok(Buffer.byteLength(JSON.stringify(lines)) > 96 * 1024 + 7_900)
  for (let i = 0; i < 9; i++) {
    const checked = checkedScreen(screen(i, lines))
    assert.ok(checked)
    ring.screen(checked)
  }
  ring.finish(exit)
  assert.equal(ring.read(6).reset, true)
  assert.deepEqual(ring.read(7).events.map(({ seq }) => seq), [8, 9, 10])
  for (let after = 0; after <= 10; after++) {
    const result = ring.read(after)
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 256 * 1024)
    assert.equal(result.cursor, 10)
    if (after < 10) assert.deepEqual(result.events.at(-1), { seq: 10, type: 'exit', exit })
  }
})

test('screen projection is immutable and rejects terminal controls, bidi control, and malformed rows', () => {
  const raw = screen(0, ['👩‍💻', '晴'])
  const checked = checkedScreen(raw)
  raw.lines[0] = 'changed'
  assert.equal(checked.lines[0], '👩‍💻')
  assert.ok(Object.isFrozen(checked) && Object.isFrozen(checked.lines))
  for (const text of ['\x1b[31msecret', '\u009b31msecret', 'hello\nworld', 'hello\u202eworld', '\ud800']) {
    assert.equal(checkedScreen(screen(0, [text])), null)
  }
  const edge = { ...screen(), totalLines: 4096, top: 4095, left: 524_288 - 160, lines: [''] }
  assert.deepEqual(checkedScreen(edge), edge)
  for (const bad of [{ cols: 161 }, { rows: 3 }, { extra: true }, { totalLines: 0 }, { totalLines: 4097 },
    { top: -1 }, { top: 123 }, { top: Infinity }, { left: Infinity }, { left: 524_288 - 160 + 1 },
    { lines: [] }, { lines: Array(2) }, { lines: Array(51).fill('x') }, { top: 122, lines: ['x', 'y'] }]) {
    assert.equal(checkedScreen({ ...screen(), ...bad }), null)
  }
  const line = `x${'\u0301'.repeat(24_575)} `
  assert.equal(Buffer.byteLength(line + line), 96 * 1024)
  assert.ok(checkedScreen(screen(0, [line, line])))
  assert.equal(checkedScreen(screen(0, [line, `${line}x`])), null)
})

test('domain exit projection keeps real status and requires two nulls for worker loss', () => {
  assert.equal(checkedExit({ ...lostExit }), lostExit)
  assert.equal(checkedExit({ ...lostExit, code: 0 }), null)
  assert.equal(checkedExit({ ...lostExit, signal: 9 }), null)
  const fault = { code: 17, signal: 9, reason: 'fault' }
  assert.deepEqual(checkedExit(fault), fault)
  assert.deepEqual(checkedExit({ ...fault, code: null }), { ...fault, code: null })
})
