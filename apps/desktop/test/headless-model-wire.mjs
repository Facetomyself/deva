import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

const textBlock = text => ({ type: 'text', text })
function anthropicHistory(history) {
  const messages = []
  for (const { role, text } of history) {
    if (messages.at(-1)?.role === role) messages.at(-1).content.push(textBlock(text))
    else messages.push({ role, content: [textBlock(text)] })
  }
  return messages
}
export const protocols = {
  openai: {
    route: 'chat/completions',
    body: history => ({ messages: history.map(({ role, text }) => ({ role, content: text })),
      max_tokens: 4096, stream_options: { include_usage: true } })
  },
  responses: {
    route: 'responses',
    body: history => ({ input: history.map(({ role, text }) => ({ role,
      content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] })), max_output_tokens: 4096, store: false })
  },
  anthropic: {
    route: 'messages',
    body: history => ({ messages: anthropicHistory(history), max_tokens: 4096 })
  }
}
export const gateway = protocol => `/gw/${protocol}`
export const route = protocol => `${gateway(protocol)}/v1/${protocols[protocol].route}`
export function assertCall(call, protocol, model, key, history) {
  assert.equal(call.method, 'POST'); assert.equal(call.path, route(protocol))
  const { authorization, 'x-api-key': apiKey, 'anthropic-version': version, 'content-type': contentType,
    ...otherHeaders } = call.headers
  assert.deepEqual({ authorization, apiKey, version }, protocol === 'anthropic'
    ? { authorization: undefined, apiKey: key, version: '2023-06-01' }
    : { authorization: `Bearer ${key}`, apiKey: undefined, version: undefined })
  assert.match(contentType, /^application\/json\b/)
  for (const header of ['cookie', 'origin', 'referer', 'proxy-authorization']) assert.equal(otherHeaders[header], undefined, header)
  assert.ok(Object.values(otherHeaders).every(value => !String(value).includes(key)), 'provider key in auxiliary header')
  assert.deepEqual(call.body, { model, stream: true, ...protocols[protocol].body(history) })
}

export function modelStream(res, protocol, model) {
  let text = '', sequence_number = 0, started = false
  // An additive gateway trace has no effect on the projected content or terminal type.
  const event = (type, fields = {}, tag = type) => `event: ${tag}\r\ndata: ${JSON.stringify({ type, trace: 'fixture', ...fields })}\r\n\r\n`
  const write = (type, fields) => res.write(event(type, fields))
  const responses = fields => ({ sequence_number: sequence_number++, ...fields })
  const send = (type, fields) => write(type, responses(fields))
  const chat = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'chatcmpl_fixture',
    object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason }] })}\r\n\r\n`
  const coordinates = { item_id: 'msg_fixture', output_index: 0, content_index: 0 }
  const part = value => ({ type: 'output_text', text: value, annotations: [], logprobs: [] })
  const item = (status, content) => ({ type: 'message', id: coordinates.item_id, status, role: 'assistant', content })
  const response = (status, output = [], incomplete_details = null) => ({ id: 'resp_fixture', object: 'response',
    created_at: 1, model, status, output, incomplete_details, error: null, parallel_tool_calls: false,
    temperature: 1, top_p: 1, tools: [], tool_choice: 'auto', usage: null })
  const start = () => {
    if (protocol === 'responses') {
      send('response.created', { response: response('in_progress') })
      send('response.in_progress', { response: response('in_progress') })
    } else if (protocol === 'anthropic') {
      write('message_start', { message: { id: 'msg_fixture', type: 'message', role: 'assistant', model, content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 1 } } })
    }
  }
  const endBlock = limited => {
    const output = item(limited ? 'incomplete' : 'completed', [part(text)])
    if (protocol === 'responses') {
      send('response.output_text.done', { ...coordinates, text, logprobs: [] })
      send('response.content_part.done', { ...coordinates, part: part(text) })
      send('response.output_item.done', { output_index: 0, item: output })
    } else if (protocol === 'anthropic') write('content_block_stop', { index: 0 })
    return output
  }
  const stop = stop_reason => {
    write('message_delta', { delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 2 } })
    write('message_stop')
  }
  const done = () => res.write('data: [DONE]\r\n\r\n')
  return {
    async delta(delta, split = false) {
      if (!started) {
        start()
        if (protocol === 'responses') {
          send('response.output_item.added', { output_index: 0, item: item('in_progress', []) })
          send('response.content_part.added', { ...coordinates, part: part('') })
        } else if (protocol === 'anthropic') write('content_block_start', { index: 0, content_block: textBlock('') })
      }
      const frame = protocol === 'openai' ? chat(started ? { content: delta } : { role: 'assistant', content: delta })
        : protocol === 'responses' ? event('response.output_text.delta', responses({ ...coordinates, delta, logprobs: [] }))
          : event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: delta } })
      started = true; text += delta
      if (!split) { res.write(frame); return }
      const bytes = Buffer.from(frame), utf8 = bytes.indexOf('🙂') + 2
      assert.ok(utf8 > 2)
      res.write(bytes.subarray(0, utf8)); await delay(20)
      res.write(bytes.subarray(utf8, -1)); await delay(20) // Split both a UTF-8 code point and CRLF.
      res.write(bytes.subarray(-1))
    },
    done,
    terminal(limited = false) {
      if (protocol === 'openai') { res.write(chat({}, 'stop')); done(); return }
      const output = [endBlock(limited)]
      if (protocol === 'anthropic') stop(limited ? 'max_tokens' : 'end_turn')
      else if (limited) send('response.incomplete', { response: response('incomplete', output, { reason: 'max_output_tokens' }) })
      else send('response.completed', { response: response('completed', output) })
    },
    mismatchedTerminal() {
      const output = [endBlock(false)]
      if (protocol === 'responses') res.write(event('response.completed', { response: response('completed', output) }, 'message_stop'))
      else {
        write('message_delta', { delta: { stop_reason: 'end_turn' } })
        res.write(event('message_stop', {}, 'response.completed'))
      }
    },
    inconsistent() {
      endBlock(false)
      if (protocol === 'anthropic') write('message_stop') // No authoritative stop_reason.
      else send('response.completed', { response: response('completed', [item('incomplete', [part(text)])]) })
    },
    finalAction() {
      const output = [endBlock(false), { type: 'function_call', name: 'inert_fixture_marker', arguments: '{}' }]
      send('response.completed', { response: response('completed', output) })
    },
    tool() {
      const name = 'inert_fixture_marker', output = endBlock(false)
      if (protocol === 'anthropic') {
        write('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_fixture', name, input: {} } })
        write('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } })
        write('content_block_stop', { index: 1 }); stop('tool_use')
      } else {
        const call = { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name }
        send('response.output_item.added', { output_index: 1, item: { ...call, status: 'in_progress', arguments: '' } })
        const complete = { ...call, status: 'completed', arguments: '{}' }
        send('response.function_call_arguments.done', { item_id: call.id, output_index: 1, name, arguments: '{}' })
        send('response.output_item.done', { output_index: 1, item: complete })
        send('response.completed', { response: response('completed', [output, complete]) })
      }
    },
    error(message) {
      write('error', protocol === 'anthropic' ? { error: { type: 'api_error', message } }
        : responses({ code: 'server_error', message, param: null }))
    },
    thought(thinking) {
      start()
      if (protocol === 'anthropic') {
        write('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } })
        write('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking } })
        write('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'fixture' } })
        write('content_block_stop', { index: 0 }); stop('end_turn')
      } else {
        const reasoning = { type: 'reasoning', id: 'rs_fixture' }, indices = { item_id: reasoning.id, output_index: 0, summary_index: 0 }
        const summary = { type: 'summary_text', text: thinking }
        send('response.output_item.added', { output_index: 0, item: { ...reasoning, summary: [] } })
        send('response.reasoning_summary_part.added', { ...indices, part: { ...summary, text: '' } })
        send('response.reasoning_summary_text.delta', { ...indices, delta: thinking })
        send('response.reasoning_summary_text.done', { ...indices, text: thinking })
        send('response.reasoning_summary_part.done', { ...indices, part: summary })
        const output = { ...reasoning, summary: [summary] }
        send('response.output_item.done', { output_index: 0, item: output })
        send('response.completed', { response: response('completed', [output]) })
      }
    }
  }
}
