import assert from 'node:assert/strict'
import test from 'node:test'
import { filterModelOutput, literalMatcher } from '../src/business/private-output.mjs'

test('known credential echoes never appear in either live deltas or reconstructed text, even between chunks', async () => {
  const secrets = ['super-api-key', 'abc', 'abcdef', 'bcdefg']
  const input = [ ['text_delta', 'Before su'], ['thinking_delta', 'Think super-'], ['text_delta', 'per-api-key then a'], ['text_delta', 'bcdefg after'], ['thinking_delta', 'api-key ok'] ]
  async function* source() { for (const [type,text] of input) yield { type,text }; yield { type:'error', error:{ kind:'auth', message:secrets[0], retryable:false } }; yield { type:'done', stopReason:'error' } }
  const events = []; for await (const ev of filterModelOutput(source(), secrets)) events.push(ev)
  const text = events.filter(e => e.type === 'text_delta').map(e => e.text).join('')
  const thinking = events.filter(e => e.type === 'thinking_delta').map(e => e.text).join('')
  assert.ok(text.startsWith('Before [redacted] then ')); assert.ok(text.endsWith(' after'))
  assert.ok(!text.includes('defg')); assert.equal(thinking, 'Think [redacted] ok')
  for (const secret of secrets) assert.ok(!JSON.stringify(events).includes(secret))
  assert.equal(events.at(-1).stopReason, 'error'); assert.equal(events.at(-2).error.kind, 'auth')
})

test('unrelated prose streams immediately; a long unfinished credential prefix is concealed at EOF', () => {
  const lane = literalMatcher(['protected-key-very-long'])()
  assert.equal(lane.next('hello '), 'hello '); assert.equal(lane.next('protected-k'), ''); assert.equal(lane.finish(), '[redacted]')
  assert.equal(lane.next('op'), 'o'); assert.equal(lane.finish(), 'p')
})
