import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { promises as fs } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildUploadedPart, createChatStore, estimateTokens } from '../dist/chat-core.mjs'
import { withConversationFiles } from '../src/chat/conversation-context-storage.mjs'
import { USAGE_META } from '../src/chat/conversation-usage.mjs'
import { createTextTurns } from '../src/chat/text-turns.mjs'
import { chatScope, createEventJournal } from '../src/events/index.mjs'

const fixtureKey = 'usage-fixture-private-key'
const unavailable = { modelRef: null, usage: null, source: 'unavailable', compaction: 'inactive' }
const ref = (adapter, modelId = 'mini:latest') => `${adapter}:${modelId}`
const error = (status, code) => ({ status, code })
const ok = () => true
const usage = (modelRef, source, used, window = 128_000) => ({
  modelRef, source, usage: { used, estimated: source === 'estimate', window, trigger: null }, compaction: 'inactive'
})
const timeout = { timeout: 10_000 }
const textPart = text => ({ type: 'text', text })

function respond(adapter, res, input) {
  const optional = fields => input === undefined ? {} : fields
  let frames
  if (adapter === 'anthropic') frames = [
    { type: 'message_start', message: { usage: optional({ input_tokens: input, cache_creation_input_tokens: 5, cache_read_input_tokens: 9 }) } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Completed answer' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }, { type: 'message_stop' }
  ]
  else if (adapter === 'responses') frames = [
    { type: 'response.output_text.delta', delta: 'Completed answer' },
    { type: 'response.completed', response: { usage: optional({ input_tokens: input, output_tokens: 7, input_tokens_details: { cached_tokens: 6 } }) } }
  ]
  else frames = [
    { choices: [{ index: 0, delta: { content: 'Completed answer' }, finish_reason: 'stop' }] },
    { choices: [], usage: optional({ prompt_tokens: input, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 6 } }) }, '[DONE]'
  ]
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end(frames.map(frame => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`).join(''))
}

async function fixture(t, { onUsageEvent, journalOptions, resolveRole, uploads, readWatermark } = {}) {
  const dataDir = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'deva-context-'))
  const chats = join(dataDir, 'data', 'chats')
  const sessionPath = sid => join(chats, `${sid}.json`)
  const disk = async sid => JSON.parse(await fs.readFile(sessionPath(sid), 'utf8'))
  const upstream = [], failures = [], sent = [], providerReads = [], modelReads = []
  let input = 113, getProviderGate, nextReplyGate
  const server = createServer((req, res) => {
    void (async () => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks))
      upstream.push({ url: req.url, body })
      if (nextReplyGate) { const gate = nextReplyGate; nextReplyGate = null; await gate }
      respond(req.url.split('/')[1], res, input)
    })().catch(err => { failures.push(err); res.destroy() })
  })
  await once(server.listen(0, '127.0.0.1'), 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  let defaultRef = ref('openai')
  let getContextGate
  const getContextModel = modelRef => {
    modelReads.push(modelRef)
    modelRef ??= defaultRef
    const colon = modelRef?.indexOf(':') ?? -1
    const adapter = modelRef?.slice(0, colon)
    const modelId = modelRef?.slice(colon + 1)
    if (!['openai', 'anthropic', 'responses'].includes(adapter) || !['mini:latest', 'other'].includes(modelId)) return null
    const result = { modelRef, adapter, modelId, contextWindow: 128_000, extraPrivateConfig: fixtureKey }
    return getContextGate ? getContextGate.then(() => result) : result
  }
  const settings = {
    getContextModel,
    getPublicConfig() { return { models: { activeModelId: defaultRef } } },
    async getProvider(id) {
      providerReads.push(id)
      if (getProviderGate) await getProviderGate
      return { id, adapter: id, purpose: 'llm', apiHost: `${origin}/${id}/v1`, apiKey: fixtureKey, enabled: true,
        models: ['mini:latest', 'other'].map(id => ({ id, enabled: true })) }
    }
  }
  let journal, turns
  function open() {
    journal = createEventJournal(journalOptions)
    const observed = { ...journal, publishChat(payload) {
      sent.push(payload)
      if (payload.event.type === 'context_changed') onUsageEvent?.(turns, payload)
      return journal.publishChat(payload)
    } }
    turns = createTextTurns({ dataDir, settings, journal: observed, version: 'fixture', allowedOrigins: [origin], resolveRole, uploads, readWatermark })
  }
  open()
  t.after(async () => {
    await turns.close()
    journal.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await fs.rm(dataDir, { force: true, recursive: true })
    assert.deepEqual(failures, [])
  })
  function send(sid, clientRequestId, model = ref('openai'), extra = {}) {
    return turns.send({ sid, clientRequestId, model, text: `private prompt ${clientRequestId}`, ...extra })
  }
  function waitDone(sid) {
    const { promise, resolve } = Promise.withResolvers()
    const published = []
    const { subscription } = turns.attach(sid, { onEvent(event) {
      published.push(event)
      if (event.event.type === 'done') { subscription.close(); resolve(published) }
    } })
    assert.equal(subscription.status, 'subscribed')
    return promise
  }
  return { dataDir, chats, sessionPath, disk, sent, upstream, providerReads, modelReads, settings, send, waitDone,
    get turns() { return turns }, get journal() { return journal },
    setUsage(value) { input = value }, setDefault(value) { defaultRef = value }, setContextGate(value) { getContextGate = value },
    setProviderGate(value) { getProviderGate = value }, setReplyGate(value) { nextReplyGate = value },
    async restart() { await turns.close(); journal.close(); open() }
  }
}

for (const adapter of ['openai', 'anthropic', 'responses']) test(`${adapter} reports one scoped normalized live and durable input reading`, timeout, async t => {
  let live
  const fx = await fixture(t, { onUsageEvent(turns, payload) { live = turns.contextUsage(payload.sessionId, { model: null }, ok) } })
  const sid = fx.turns.create().id
  const other = fx.turns.create().id
  const before = await fx.turns.contextUsage(sid, { model: null }, ok)
  assert.deepEqual(before, usage(ref('openai'), 'none', null))
  assert.deepEqual(fx.providerReads, [])
  assert.deepEqual(fx.upstream, [])
  const done = fx.waitDone(sid)
  const ack = await fx.send(sid, 'measurement', ref(adapter))
  const events = await done
  const input = adapter === 'anthropic' ? 127 : 113
  assert.deepEqual(fx.sent.filter(({ event }) => event.type === 'context_changed'), [{ sessionId: sid, turnId: ack.turnId, event: { type: 'context_changed' } }])
  assert.deepEqual(events.filter(({ event }) => event.type === 'context_changed').map(({ event }) => event), [{ type: 'context_changed' }])
  assert.deepEqual(await live, usage(ref(adapter), 'live', input))
  assert.deepEqual(await fx.turns.contextUsage(sid, { model: ref(adapter) }, ok), usage(ref(adapter), 'measured', input))
  assert.deepEqual(await fx.turns.contextUsage(other, { model: null }, ok), usage(ref('openai'), 'none', null))
  assert.deepEqual(await fx.turns.contextUsage(sid, { model: ref(adapter, 'other') }, ok), unavailable)
  const stored = await fx.disk(sid)
  assert.equal(stored.lastInputTokens, input)
  assert.deepEqual(stored[USAGE_META], { version: 1, sessionId: sid, turnId: ack.turnId, adapter,
    modelRef: ref(adapter), updatedAt: stored.updatedAt, inputTokens: input, digest: stored[USAGE_META].digest })
  assert.match(stored[USAGE_META].digest, /^[0-9a-f]{64}$/)
  assert.ok(!JSON.stringify([stored[USAGE_META], events]).includes('private prompt'))
  assert.ok(!JSON.stringify([stored[USAGE_META], events]).includes(fixtureKey))
  await fx.restart()
  assert.deepEqual(await fx.turns.contextUsage(sid, { model: null }, ok), usage(ref(adapter), 'measured', input))
  assert.equal(fx.upstream.length, 1)
  assert.deepEqual(fx.providerReads, [adapter])
})

test('new turns and invalid provider input never pass an earlier receipt as exact', timeout, async t => {
  const fx = await fixture(t)
  const sid = fx.turns.create().id
  let done = fx.waitDone(sid)
  await fx.send(sid, 'first')
  await done
  const previousReading = (await fx.disk(sid))[USAGE_META]
  for (const [n, invalid] of [undefined, 0, -1, 4.5, Number.MAX_SAFE_INTEGER + 1, '88'].entries()) {
    fx.setUsage(invalid)
    done = fx.waitDone(sid)
    const gate = Promise.withResolvers()
    if (n === 0) fx.setReplyGate(gate.promise)
    try {
      await fx.send(sid, `turn-${n}`)
      if (n === 0) {
        const live = await fx.turns.contextUsage(sid, { model: null }, ok)
        assert.equal(live.source, 'estimate')
      }
    } finally { gate.resolve() }
    await done
    const d = await fx.disk(sid)
    assert.equal(d.lastInputTokens, previousReading.inputTokens)
    assert.deepEqual(d[USAGE_META], previousReading)
    assert.deepEqual(await fx.turns.contextUsage(sid, { model: null }, ok), usage(ref('openai'), 'estimate', estimateTokens(d.messages)))
  }
  assert.equal(fx.sent.filter(({ event }) => event.type === 'context_changed').length, 1)
  const pref = fx.turns.getPreferences(sid)
  await fx.turns.patchPreferences(sid, { revision: pref.revision, set: { model: ref('openai', 'other') } }, ok)
  assert.deepEqual(await fx.turns.contextUsage(sid, { model: ref('openai') }, ok), unavailable)
  assert.equal((await fx.turns.contextUsage(sid, { model: null }, ok)).source, 'estimate')
})

test('context resolution observes the owner after asynchronous lookups and uses the trusted pin, role, or default', timeout, async t => {
  let role = { id: 'reader', enabled: true, name: 'Private role', prompt: 'private role content', model: ref('anthropic') }
  let roleReadCount = 0
  const fx = await fixture(t, { resolveRole(id) { assert.equal(id, 'reader'); roleReadCount++; return role } })
  const sid = fx.turns.create().id
  const pinned = fx.turns.create({}, role).id
  const unpinned = fx.turns.create({}, { ...role, model: undefined }).id
  assert.deepEqual(await fx.turns.contextUsage(pinned, { model: null }, ok), usage(ref('anthropic'), 'none', null))
  assert.equal(roleReadCount, 0)
  assert.deepEqual(await fx.turns.contextUsage(unpinned, { model: null }, ok), usage(ref('anthropic'), 'none', null))
  assert.equal(roleReadCount, 1)
  role = { ...role, model: ref('anthropic', 'disabled') }
  assert.deepEqual(await fx.turns.contextUsage(unpinned, { model: null }, ok), unavailable)
  fx.setDefault(null)
  assert.deepEqual(await fx.turns.contextUsage(sid, { model: null }, ok), unavailable)
  fx.setDefault(ref('openai'))
  assert.deepEqual(await fx.turns.contextUsage(sid, { model: ref('openai', 'other') }, ok), unavailable)
  let authCalls = 0, current = true
  const gate = Promise.withResolvers()
  fx.setContextGate(gate.promise)
  const pending = fx.turns.contextUsage(sid, { model: null }, observedSid => { assert.equal(observedSid, sid); authCalls++; return current })
  current = false
  gate.resolve()
  await assert.rejects(pending, error(401, 'auth'))
  assert.ok(authCalls >= 2)
  await assert.rejects(fx.turns.contextUsage(sid, { model: null }, () => Promise.resolve(true)), error(401, 'auth'))
  delete fx.settings.getContextModel
  assert.deepEqual(await fx.turns.contextUsage(sid, { model: null }, ok), unavailable)
  assert.deepEqual(fx.upstream, [])
  assert.deepEqual(fx.providerReads, [])
})

test('read observations name the original journal snapshot and reject busy, seq, generation and file changes', timeout, async t => {
  const fx = await fixture(t, { journalOptions: { maxChatStreams: 2 } })
  const { id: sid, updatedAt } = fx.turns.create()
  const empty = fx.turns.readObservation(sid)
  assert.deepEqual({ ...empty, verify: undefined }, { id: sid, updatedAt, cursor: fx.turns.snapshot(sid).cursor, eligible: false, verify: undefined })
  assert.equal(empty.verify(), true)
  assert.deepEqual(fx.turns.readCandidates(), [])
  t.mock.method(Date, 'now', () => updatedAt)
  const wanted = fx.waitDone(sid)
  const gate = Promise.withResolvers()
  fx.setProviderGate(gate.promise)
  const send = fx.send(sid, 'same-clock')
  try {
    assert.throws(() => fx.turns.readObservation(sid), error(409, 'read_view_busy'))
    assert.throws(() => empty.verify(), error(409, 'read_view_busy'))
    assert.deepEqual(fx.turns.readCandidates(), [])
  } finally { gate.resolve() }
  const ack = await send
  assert.equal(ack.startedAt, updatedAt)
  const events = await wanted
  assert.equal(events.at(-1).turnId, ack.turnId)
  assert.equal(events.at(-1).event.durationMs, 0)
  const observed = fx.turns.readObservation(sid)
  assert.equal(observed.updatedAt, updatedAt + 2)
  assert.equal(observed.eligible, true)
  assert.deepEqual(observed.cursor, fx.turns.snapshot(sid).cursor)
  assert.throws(() => empty.verify(), error(409, 'read_view_stale'))
  assert.deepEqual(fx.turns.readCandidates(), [{ id: sid, updatedAt: updatedAt + 2 }])
  fx.journal.publishChat({ sessionId: sid, turnId: ack.turnId, event: { type: 'stream_reset' } })
  assert.throws(() => observed.verify(), error(409, 'read_view_stale'))
  const sequenced = fx.turns.readObservation(sid)
  fx.journal.snapshot(chatScope('other-a'))
  fx.journal.snapshot(chatScope('other-b'))
  assert.throws(() => sequenced.verify(), error(409, 'read_view_stale'))
  const named = fx.turns.readObservation(sid)
  await fs.writeFile(`${fx.sessionPath(sid)}.swap`, await fs.readFile(fx.sessionPath(sid)), { mode: 0o600 })
  assert.equal(`${fx.sessionPath(sid)}.swap`, join(fx.chats, `${sid}.json.swap`))
  await fs.rename(`${fx.sessionPath(sid)}.swap`, fx.sessionPath(sid))
  assert.throws(() => named.verify(), error(409, 'read_view_stale'))
  assert.equal(fx.turns.readObservation(sid).verify(), true)
  const changed = await fx.disk(sid)
  changed.messages[0].content[0].text = 'changed without updatedAt'
  await fs.writeFile(fx.sessionPath(sid), JSON.stringify(changed))
  assert.throws(() => fx.turns.readObservation(sid), error(409, 'read_unavailable'))
  assert.deepEqual(fx.turns.readCandidates(), [])
})

test('legacy information is read only; hidden, compacted, missing, and unowned layouts fail closed', timeout, async t => {
  const fx = await fixture(t)
  const desktop = createChatStore({ dataDir: fx.dataDir })
  const ordinary = desktop.ensureSession('sess_ordinary_1')
  ordinary.messages.push({ role: 'user', content: '可见的历史' }, { role: 'assistant', content: [textPart('visible reply')] })
  ordinary.lastInputTokens = 999
  desktop.saveStrict(ordinary.id)
  const compacted = desktop.ensureSession('sess_compact_1')
  compacted.messages.push({ role: 'user', content: 'Hidden prefix' }, { role: 'user', content: '⟦deva:compaction⟧ summary' })
  desktop.saveStrict(compacted.id)
  assert.ok((await fx.disk(compacted.id)).compacted)
  const tool = desktop.ensureSession('sess_tool_1')
  tool.messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'tool', input: {} }] })
  desktop.saveStrict(tool.id)
  const orphan = join(fx.chats, `${ordinary.id}.compacted-orphan.jsonl`)
  await fs.writeFile(orphan, 'preserve orphan', { mode: 0o600 })
  const outsider = join(fx.dataDir, 'outside.json')
  await fs.writeFile(outsider, JSON.stringify({ ...ordinary, id: 'naked' }), { mode: 0o600 })
  await fs.symlink(outsider, fx.sessionPath('naked'))
  const before = await fs.readdir(fx.chats)
  assert.deepEqual(await fx.turns.contextUsage(ordinary.id, { model: null }, ok), usage(ref('openai'), 'estimate', estimateTokens(ordinary.messages)))
  assert.equal(fx.turns.readObservation(ordinary.id).eligible, true)
  assert.deepEqual(fx.turns.readCandidates(), [{ id: ordinary.id, updatedAt: ordinary.updatedAt }])
  for (const [id, status, code] of [[compacted.id, 409, 'unsupported_history'], [tool.id, 409, 'unsupported_history'],
    ['naked', 409, 'read_unavailable'], ['missing', 404, 'session_not_found']]) {
    await assert.rejects(fx.turns.contextUsage(id, { model: null }, ok), error(status, code))
    assert.throws(() => fx.turns.readObservation(id), error(status, code))
  }
  assert.deepEqual(await fs.readdir(fx.chats), before)
  assert.equal(await fs.readFile(orphan, 'utf8'), 'preserve orphan')
  assert.equal((await fx.disk(ordinary.id)).lastInputTokens, 999)
  await fx.turns.close()
  await assert.rejects(fx.turns.contextUsage(ordinary.id, { model: null }, ok), error(503, 'chat_closed'))
  assert.throws(() => fx.turns.readObservation(ordinary.id), error(503, 'chat_closed'))
  assert.deepEqual(fx.turns.readCandidates(), [])
})

test('metadata never confuses IDs or credits a changed transcript, even after restart', timeout, async t => {
  const fx = await fixture(t)
  const sid = fx.turns.create().id
  const other = fx.turns.create().id
  const done = fx.waitDone(sid)
  await fx.send(sid, 'usage-correspondence')
  await done
  const source = await fx.disk(sid)
  const changed = structuredClone(source)
  changed.messages.at(-1).content[0].text = 'Modified reply with the same timestamp'
  await fs.writeFile(fx.sessionPath(sid), JSON.stringify(changed))
  await fs.writeFile(fx.sessionPath(other), JSON.stringify({ ...source, id: other }))
  await fx.restart()
  assert.deepEqual(await fx.turns.contextUsage(sid, { model: null }, ok), usage(ref('openai'), 'estimate', estimateTokens(changed.messages)))
  assert.deepEqual(await fx.turns.contextUsage(other, { model: null }, ok), usage(ref('openai'), 'estimate', estimateTokens(source.messages)))
})

test('normalized input never becomes durable on a failed pre-publication save', timeout, async t => {
  const fx = await fixture(t)
  const sid = fx.turns.create().id
  const gate = Promise.withResolvers()
  fx.setReplyGate(gate.promise)
  const done = fx.waitDone(sid)
  await fx.send(sid, 'failed-save')
  try { await fs.mkdir(join(fx.chats, '_index.pending')) }
  finally { gate.resolve() }
  assert.equal((await done).at(-1).event.stopReason, 'error')
  assert.equal((await fx.disk(sid)).lastInputTokens, undefined)
  assert.equal((await fx.disk(sid))[USAGE_META], undefined)
  await assert.rejects(fx.turns.contextUsage(sid, { model: null }, ok), error(409, 'read_unavailable'))
  assert.throws(() => fx.turns.readObservation(sid), error(409, 'read_unavailable'))
  assert.deepEqual(fx.turns.readCandidates(), [])
})

test('attachment estimates use shared part costs and text byte counts without opening media', timeout, async t => {
  const items = [
    { name: 'notes.txt', mime: 'text/plain', kind: 'text', bytes: Buffer.from('a'.repeat(14_000)) },
    { name: 'chart.png', mime: 'image/png', kind: 'image', bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWNYZ/B3ncFfBggFADLGB23aTHV6AAAAAElFTkSuQmCC', 'base64') }
  ].map(({ bytes, ...entry }) => ({ bytes, meta: { ...entry, id: randomUUID(), size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }))
  const fx = await fixture(t, { uploads: { read(_sid, id) { return items.find(x => x.meta.id === id) } } })
  fx.setUsage(undefined)
  const sid = fx.turns.create().id
  const done = fx.waitDone(sid)
  await fx.send(sid, 'multimodal-reading', ref('openai'), { attachments: items.map(x => x.meta.id) })
  await done
  const stored = await fx.disk(sid)
  const parts = items.map(({ bytes, meta: { name, mime, size } }) => buildUploadedPart({ name, mime, size }, bytes, 'openai').part)
  const expected = estimateTokens([{ role: 'user', content: [...parts, stored.messages[0].content.at(-1)] }, stored.messages[1]])
  const media = join(fx.dataDir, 'data', 'media')
  await fs.rename(media, `${media}-saved`)
  assert.deepEqual(await fx.turns.contextUsage(sid, { model: null }, ok), usage(ref('openai'), 'estimate', expected))
  assert.equal(fx.turns.snapshot(sid).state.messages, null)
  assert.throws(() => fx.turns.readObservation(sid), error(409, 'unsupported_history'))
  assert.deepEqual(fx.turns.readCandidates(), [])
})

test('a missing directory is empty but unsafe roots and scan overflow explicitly fail', timeout, async t => {
  const fx = await fixture(t)
  assert.deepEqual(fx.turns.readCandidates(), [])
  fx.turns.create()
  fx.turns.create()
  assert.throws(() => withConversationFiles(fx.dataDir, files => [...files.scan(1)]), error(413, 'read_state_limit'))
  await fs.chmod(fx.chats, 0o777)
  assert.throws(() => fx.turns.readCandidates(), error(409, 'read_unavailable'))
})

test('legacy future read timestamps cannot swallow new content or replace real receipt time', timeout, async t => {
  let sid, watermark
  const fx = await fixture(t, { readWatermark(id) { assert.equal(id, sid); return watermark } })
  const created = fx.turns.create()
  sid = created.id
  const wall = created.updatedAt
  t.mock.method(Date, 'now', () => wall)
  watermark = wall + 10_000
  let done = fx.waitDone(sid)
  const gate = Promise.withResolvers()
  fx.setReplyGate(gate.promise)
  try {
    const ack = await fx.send(sid, 'watermark')
    assert.equal(ack.startedAt, wall)
    assert.equal((await fx.disk(sid)).updatedAt, watermark + 1)
  } finally { gate.resolve() }
  await done
  assert.equal(fx.turns.readObservation(sid).updatedAt, watermark + 2)
  watermark = Number.MAX_SAFE_INTEGER
  done = fx.waitDone(sid)
  assert.equal((await fx.send(sid, 'impossible-legacy-mark')).startedAt, wall)
  await done
  assert.equal(fx.turns.readObservation(sid).updatedAt, wall + 10_004)
})
