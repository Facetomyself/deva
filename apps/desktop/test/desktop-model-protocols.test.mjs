import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

// Exercise the existing rich path with an injected transport, not an Electron shim or a live model.
test('desktop adapters retain thinking, tool declarations and usage when textOnly is not set', async () => {
  const entry = fileURLToPath(new URL('../src/main/providers/adapters.ts', import.meta.url))
  const { output } = await build({ configFile: false, logLevel: 'silent', build: { ssr: entry, write: false,
    rollupOptions: { output: { format: 'es', inlineDynamicImports: true } } } })
  const { modelAdapters } = await import(`data:text/javascript;base64,${Buffer.from(output[0].code).toString('base64')}`)
  const text = 'desktop reply', thinking = 'desktop progress', tool = { name: 'display_label', description: 'Fixture', inputSchema: { type: 'object' } }
  for (const protocol of ['anthropic', 'responses']) {
    const anthropic = protocol === 'anthropic'
    const frames = anthropic ? [
      { type: 'message_start', message: { content: [], usage: { input_tokens: 7, cache_creation_input_tokens: 3, cache_read_input_tokens: 5 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } }, { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } }, { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'stop_sequence' }, usage: { output_tokens: 2 } }, { type: 'message_stop' }
    ] : [
      { type: 'response.reasoning_summary_text.delta', delta: thinking }, { type: 'response.output_text.delta', delta: text },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 15, output_tokens: 2, input_tokens_details: { cached_tokens: 5 } } } }
    ]
    const stream = modelAdapters[protocol]({ baseURL: 'https://example.invalid', apiKey: '' }, {
      model: 'fixture', messages: [{ role: 'user', content: 'hello' }], tools: [tool]
    }, { describeNetError: () => 'fixture', async fetchModel(_url, init) {
      assert.deepEqual(JSON.parse(init.body).tools, anthropic ? [{ name: tool.name, description: tool.description, input_schema: tool.inputSchema }] :
        [{ type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false }])
      return new Response(frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join(''))
    } })
    const events = []; for await (const event of stream) events.push(event)
    assert.deepEqual(events, [{ type: 'thinking_delta', text: thinking }, { type: 'text_delta', text },
      { type: 'usage', input: 15, output: 2, cacheRead: 5, ...(anthropic && { cacheWrite: 3 }) },
      { type: 'done', stopReason: anthropic ? 'stop' : 'end_turn' }])
  }
})
