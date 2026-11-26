import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const services = 'apps/desktop/src/main/services'
const consumerEntry = `${services}/model-step-stream.ts`

async function bundle(entry, assertDependencies = () => {}) {
  const result = await build({
    absWorkingDir: root, entryPoints: [entry], bundle: true, format: 'esm',
    platform: 'node', target: 'node22', write: false, metafile: true
  })
  assertDependencies(result.metafile)
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`)
}

const { consumeModelStep } = await bundle(consumerEntry, metafile => {
  assert.deepEqual(Object.keys(metafile.inputs).sort(), [consumerEntry, `${services}/repetition.ts`])
  for (const output of Object.values(metafile.outputs)) assert.deepEqual(output.imports, [])
})
const { createProviderCore } = await bundle('apps/desktop/src/main/providers/core.ts')

const text = text => ({ type: 'text_delta', text })
const thinking = text => ({ type: 'thinking_delta', text })
const done = stopReason => ({ type: 'done', stopReason })
const sse = data => `data: ${JSON.stringify(data)}\n\n`
const choice = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] })
const sseHeaders = { 'content-type': 'text/event-stream' }

function streamChat(httpFetch, signal) {
  const provider = createProviderCore({
    httpFetch, describeNetError: String, getAppVersion: () => 'test',
    getSecret: () => '', providerCustomHeaders: () => ({})
  })
  return provider.streamChat(
    { adapter: 'openai', providerId: 'fixture', baseURL: 'https://provider.example/v1' },
    { model: 'fixture-model', messages: [{ role: 'user', content: 'hello' }], signal }
  )
}

async function* eventStream(...events) {
  yield* events
}

const toolCall = { type: 'tool_call', id: 'c1', name: 'example_lookup', args: { query: 'a' }, signature: 'sig' }
const truncatedCall = {
  type: 'tool_call_truncated', id: 'c2', name: 'example_lookup', partialArgs: '{', cause: 'max_tokens'
}

test('text-only callbacks consume a real provider protocol stream and report its usage', async () => {
  const upstream = [
    sse(choice({ reasoning_content: 'first thought' })),
    sse(choice({ content: 'one' })),
    sse(choice({ reasoning_content: ', then another' })),
    sse(choice({ content: ' two' })),
    sse(choice({}, 'stop')),
    sse({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } } }),
    'data: [DONE]\n\n'
  ].join('')
  const calls = []
  const usage = { type: 'usage', input: 11, output: 3, cacheRead: 4 }
  const result = await consumeModelStep(streamChat(async () => new Response(upstream, { headers: sseHeaders })), {
    onTextDelta: delta => calls.push(['text', delta]),
    onThinkingDelta: delta => calls.push(['thinking', delta]),
    onUsage: event => calls.push(['usage', event])
  })
  assert.deepEqual(calls, [
    ['thinking', 'first thought'], ['text', 'one'], ['thinking', ', then another'], ['text', ' two'], ['usage', usage]
  ])
  assert.deepEqual(result, {
    assistantText: 'one two', thinkingText: 'first thought, then another', stopReason: 'end_turn', usage,
    error: null, aborted: false, repetition: null, rejectedToolCall: null
  })
})

test('desktop-style callbacks stage distinct tool requests, offsets, and usage in stream order', async () => {
  const order = []
  const staged = []
  const usage1 = { type: 'usage', input: 10, output: 1, cacheWrite: 2 }
  const usage2 = { type: 'usage', input: 10, output: 5, cacheWrite: 2 }
  const result = await consumeModelStep(eventStream(
    thinking('idea'), text('a'), usage1, toolCall, text(' bc'), truncatedCall, usage2, done('max_tokens')
  ), {
    onTextDelta: delta => order.push(['text', delta]),
    onThinkingDelta: delta => order.push(['thinking', delta]),
    onUsage: usage => order.push(['usage', usage]),
    onToolCall(event, offsets) {
      order.push(['tool', offsets])
      staged.push(event)
    },
    onTruncatedToolCall(event, offsets) {
      order.push(['truncated', offsets])
      staged.push(event)
    }
  })
  assert.deepEqual(order, [
    ['thinking', 'idea'], ['text', 'a'], ['usage', usage1], ['tool', { text: 1, thinking: 4 }],
    ['text', ' bc'], ['truncated', { text: 4, thinking: 4 }], ['usage', usage2]
  ])
  assert.deepEqual(staged, [toolCall, truncatedCall])
  assert.equal(result.assistantText, 'a bc')
  assert.equal(result.thinkingText, 'idea')
  assert.equal(result.stopReason, 'max_tokens')
  assert.equal(result.usage, usage2)
  assert.equal(result.rejectedToolCall, null)
})

test('a text-only caller can reject tools explicitly; omitted tool callbacks also close the stream', async () => {
  const seen = []
  for (const [request, options] of [
    [toolCall, { onToolCall: (event, offsets) => { seen.push([event, offsets]); return 'reject' } }],
    [truncatedCall, {}]
  ]) {
    let closed = false
    async function* events() {
      try {
        yield thinking('idea')
        yield text('before')
        yield request
        assert.fail('the consumer pulled past a rejected tool request')
      } finally {
        await Promise.resolve()
        closed = true
      }
    }
    const result = await consumeModelStep(events(), options)
    assert.equal(closed, true, 'the result waits for generator cleanup')
    assert.equal(result.assistantText, 'before')
    assert.equal(result.rejectedToolCall, request)
  }
  assert.deepEqual(seen, [[toolCall, { text: 6, thinking: 4 }]])
})

test('a shared abort signal stops a real provider request and preserves partial text', async () => {
  const controller = new AbortController()
  const received = []
  let transportSignal
  const events = streamChat(async (_url, { signal }) => {
    transportSignal = signal
    const body = new ReadableStream({
      start(stream) {
        stream.enqueue(new TextEncoder().encode(sse(choice({ content: 'partial' }))))
        signal.addEventListener('abort', () => stream.error(signal.reason), { once: true })
      }
    })
    return new Response(body, { headers: sseHeaders })
  }, controller.signal)
  const result = await consumeModelStep(events, {
    signal: controller.signal,
    onTextDelta(delta) {
      received.push(delta)
      controller.abort()
    }
  })
  assert.deepEqual(received, ['partial'])
  assert.equal(transportSignal.reason, controller.signal.reason)
  assert.equal(result.assistantText, 'partial')
  assert.equal(result.stopReason, 'aborted')
  assert.equal(result.aborted, true)
  assert.equal(result.error, null)
  assert.equal((await consumeModelStep(eventStream(done('aborted')))).aborted, true)
  assert.equal((await consumeModelStep(eventStream(), { signal: controller.signal })).aborted, true)
})

test('protocol errors preserve partial output, metadata, and the following done signal', async () => {
  const drops = []
  const retryable = { kind: 'network', message: 'drop', retryable: true, retryAfterMs: 47 }
  const fatal = { kind: 'context_length', message: 'too long', retryable: false, limit: 200 }
  const result = await consumeModelStep(eventStream(
    text('part'), { type: 'error', error: retryable }, { type: 'error', error: fatal }, done('error')
  ), { onError: error => drops.push(error) })
  assert.deepEqual(drops, [retryable, fatal])
  assert.equal(result.error, fatal)
  assert.equal(result.assistantText, 'part')
  assert.equal(result.stopReason, 'error')
  assert.equal(result.aborted, false)

  const thrown = Error('unexpected iterator failure')
  async function* throws() {
    yield text('part')
    throw thrown
  }
  await assert.rejects(consumeModelStep(throws()), error => error === thrown)
})

for (const [channel, delta, other] of [['text', text, thinking], ['thinking', thinking, text]]) {
  test(`${channel} repetition dispatches the triggering delta before closing the iterator`, async () => {
    const piece = 'abc'.repeat(38)
    const received = []
    async function* events() {
      try {
        yield delta(piece)
        yield other('independent')
        yield delta(piece)
        assert.fail('the consumer pulled past the repetition break')
      } finally {
        received.push(['closed'])
      }
    }
    const result = await consumeModelStep(events(), {
      onTextDelta: text => received.push(['text', text]),
      onThinkingDelta: text => received.push(['thinking', text])
    })
    const otherChannel = channel === 'text' ? 'thinking' : 'text'
    assert.deepEqual(received, [[channel, piece], [otherChannel, 'independent'], [channel, piece], ['closed']])
    assert.deepEqual(result.repetition, { channel, period: 3 })
    assert.equal(result[channel === 'text' ? 'assistantText' : 'thinkingText'], piece + piece)
  })
}
