import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { promises as fs } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createChatStore } from '../dist/chat-core.mjs'
import { createTextTurns } from '../src/chat/text-turns.mjs'
import { createEventJournal, SESSIONS_SCOPE } from '../src/events/index.mjs'
import { acquireWriterLock } from '../src/runtime/writer-lock.mjs'

const model = 'fixture:local/chat'
const groupPattern = /^d_[a-f0-9]{32}$/u
const revisionPattern = /^[a-f0-9]{64}$/u
const error = (status, code) => ({ status, code, message: code })
const nativeLedger = '_devaHeadlessTextTurns'
const opts = { timeout: 12_000 }
const complete = (res, text, why = 'stop') => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  if (text) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`)
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: why }] })}\n\ndata: [DONE]\n\n`)
}

async function fixture(t) {
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'deva-delivery-records-'))
  const dataDir = join(root, 'home')
  const chats = join(dataDir, 'data', 'chats')
  let release = acquireWriterLock(dataDir)
  let journal, turns
  const calls = []
  const responses = []
  const faults = []
  const server = createServer((req, res) => {
    void (async () => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      calls.push(JSON.parse(Buffer.concat(chunks)))
      await responses.shift()(res)
    })().catch(e => { faults.push(e); res.destroy() })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  const settings = { async getProvider(id) {
    if (id !== 'fixture') return null
    return { id, enabled: true, purpose: 'llm', adapter: 'openai', apiHost: `${origin}/v1`, models: [{ id: 'local/chat', enabled: true }] }
  } }
  function open(deliveries = true) {
    journal = createEventJournal()
    turns = createTextTurns({ dataDir, settings, journal, allowedOrigins: [origin], version: 'fixture', deliveries })
    return { turns, journal }
  }
  t.after(async () => {
    await turns?.close()
    journal?.close()
    release()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await fs.rm(root, { recursive: true, force: true })
    assert.deepEqual(faults, [])
  })
  return {
    ...open(), calls, responses, root, dataDir, chats,
    native: sid => join(chats, `${sid}.json`), sidecar: sid => join(chats, `${sid}.deliveries-v1`),
    async restart(deliveries) {
      await turns.close()
      journal.close()
      release()
      release = acquireWriterLock(dataDir)
      return open(deliveries)
    }
  }
}

async function start(turns, sid, id) {
  const events = []
  let finish
  const done = new Promise(resolve => { finish = resolve })
  const { subscription } = turns.attach(sid, { onEvent(item) {
    events.push(item.event)
    if (item.event.type === 'done') finish(item)
  } })
  assert.equal(subscription.status, 'subscribed')
  const receipt = await turns.send({ sid, clientRequestId: id, text: 'Local QA fixture', model })
  return { ...receipt, events, done: done.finally(subscription.close) }
}

const snapshot = (turns, sid) => turns.snapshot(sid).state

async function turn(fx, sid, id, text, status) {
  fx.responses.push(res => complete(res, text, status))
  const { turnId, done } = await start(fx.turns, sid, id)
  await done
  return turnId
}

test('exports raw native UTF-8, preserves ordinary chat and replays without writes or model charges', opts, async t => {
  const fx = await fixture(t)
  const { turns, journal, dataDir } = fx
  assert.throws(() => acquireWriterLock(dataDir), /Another writer holds/)
  const sid = turns.create().id
  const foreign = turns.create().id
  const raw = '  # Native title\r\n\n汉字 café 𝄞 🎉\r\n\tending  \n'
  const turnId = await turn(fx, sid, 'done', raw)
  const state = snapshot(turns, sid)
  assert.deepEqual(state.messages, [{ role: 'user', content: 'Local QA fixture' }, { role: 'assistant', content: raw }])
  assert.deepEqual(turns.deliverySnapshot(sid), { records: [], candidates: [{ turnId, messageIndex: 1 }] })
  const sessionsCursor = journal.snapshot(SESSIONS_SCOPE).cursor
  const nativeBefore = await fs.readFile(fx.native(sid))
  const nativeStat = await fs.stat(fx.native(sid))
  assert.throws(() => turns.exportReplyDelivery(sid, { turnId, format: 'md', bytes: 'client' }), error(400, 'invalid_delivery_export'))
  assert.throws(() => turns.exportReplyDelivery(sid, { turnId, format: 'html' }), error(400, 'invalid_delivery_export'))
  assert.throws(() => turns.exportReplyDelivery(foreign, { turnId, format: 'md' }), error(404, 'reply_not_exportable'))
  assert.throws(() => turns.exportReplyDelivery(sid, { turnId, format: 'md' }, value => {
    assert.equal(value, sid)
    return false
  }), error(401, 'unauthorized'))
  await assert.rejects(fs.access(fx.sidecar(sid)), { code: 'ENOENT' })
  const first = turns.exportReplyDelivery(sid, { turnId, format: 'md' })
  assert.equal(first.created, true)
  const id = first.record.id
  const hash = createHash('sha256').update(raw).digest('hex')
  assert.match(id, groupPattern)
  assert.match(hash, revisionPattern)
  assert.deepEqual(first.record, { id, origin: 'reply', turnId, messageIndex: 1, entries: [{
    index: 0, name: 'reply-001.md', size: Buffer.byteLength(raw), revision: hash, mime: 'text/markdown; charset=utf-8'
  }] })
  const metadataStat = await fs.stat(fx.sidecar(sid))
  assert.equal(metadataStat.mode & 0o777, 0o600)
  assert.deepEqual(turns.exportReplyDelivery(sid, { turnId, format: 'md' }), { ...first, created: false })
  assert.equal((await fs.stat(fx.sidecar(sid))).ino, metadataStat.ino)
  const txt = turns.exportReplyDelivery(sid, { turnId, format: 'txt' }).record
  assert.notEqual(txt.id, id)
  assert.deepEqual(turns.listDeliveryRecords(sid), [txt, first.record])
  const expected = { name: 'reply-001.md', bytes: Buffer.from(raw), revision: hash, mime: 'text/markdown; charset=utf-8' }
  assert.deepEqual(turns.readReplyDelivery(sid, id, 0), expected)
  assert.equal(turns.readReplyDelivery(foreign, id, 0), null)
  assert.equal(turns.readReplyDelivery(sid, id, 1), null)
  assert.equal(turns.readReplyDelivery(sid, `${id}\n`, 0), null)
  assert.equal(turns.readReplyDelivery(sid, id, '0'), null)
  const privateIndex = JSON.parse(await fs.readFile(fx.sidecar(sid), 'utf8'))
  assert.ok(privateIndex.rows.every(row => !Object.hasOwn(row, 'text') && !Object.hasOwn(row, 'bytes') && !Object.hasOwn(row, 'path')))
  assert.ok((await fs.stat(fx.sidecar(sid))).size < 512)
  assert.deepEqual(await fs.readFile(fx.native(sid)), nativeBefore)
  assert.equal((await fs.stat(fx.native(sid))).ino, nativeStat.ino)
  assert.deepEqual(journal.snapshot(SESSIONS_SCOPE).cursor, sessionsCursor)
  assert.deepEqual(snapshot(turns, sid), state)
  const reopened = (await fx.restart()).turns
  assert.deepEqual(reopened.listDeliveryRecords(sid), [txt, first.record])
  assert.deepEqual(reopened.exportReplyDelivery(sid, { turnId, format: 'md' }), { ...first, created: false })
  assert.deepEqual(reopened.readReplyDelivery(sid, id, 0), expected)
  assert.equal(fx.calls.length, 1)
  assert.deepEqual(fx.calls[0].messages, [{ role: 'system', content: 'You are a helpful general-purpose assistant. Reply in plain text.' },
    { role: 'user', content: 'Local QA fixture' }])
})

test('only unambiguous completed replies qualify; active, empty, partial and failed turns stay out', opts, async t => {
  const fx = await fixture(t)
  const { turns } = fx
  const sid = turns.create().id
  const good = await turn(fx, sid, 'first', 'full')
  const blank = await turn(fx, sid, 'blank', '  \n ')
  const partial = await turn(fx, sid, 'partial', 'partial output', 'length')
  fx.responses.push(res => res.writeHead(500).end())
  const failed = await start(turns, sid, 'failed')
  await failed.done
  let entered
  const admitted = new Promise(resolve => { entered = resolve })
  fx.responses.push(res => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"index":0,"delta":{"content":"stopped partial"}}]}\n\n')
    entered()
  })
  const active = await start(turns, sid, 'aborted')
  await admitted
  assert.deepEqual(turns.deliverySnapshot(sid).candidates, [])
  assert.throws(() => turns.exportReplyDelivery(sid, { turnId: good, format: 'txt' }), error(409, 'turn_in_progress'))
  assert.deepEqual(turns.stop({ sid, turnId: active.turnId }), { stopped: true })
  await active.done
  assert.deepEqual(turns.deliverySnapshot(sid).candidates, [{ turnId: good, messageIndex: 1 }])
  for (const turnId of [blank, partial, failed.turnId, active.turnId]) {
    assert.throws(() => turns.exportReplyDelivery(sid, { turnId, format: 'txt' }), error(404, 'reply_not_exportable'))
  }
  const native = JSON.parse(await fs.readFile(fx.native(sid), 'utf8'))
  assert.deepEqual(native[nativeLedger].requests.map(({ status, reason }) => [status, reason]), [
    ['completed', null], ['completed', 'empty'], ['completed', 'truncated'], ['failed', 'model_failed'], ['aborted', 'stopped']
  ])
  native.messages.splice(2, 1, { role: 'assistant', content: [{ type: 'text', text: 'ambiguous' }] })
  await fs.writeFile(fx.native(sid), JSON.stringify(native))
  assert.throws(() => turns.deliverySnapshot(sid), error(503, 'chat_storage_unconfirmed'))
  const reopened = (await fx.restart()).turns
  assert.deepEqual(reopened.deliverySnapshot(sid), { records: [], candidates: [] })
  assert.throws(() => reopened.exportReplyDelivery(sid, { turnId: good, format: 'md' }), error(409, 'unsupported_history'))
  const disabled = (await fx.restart(false)).turns
  assert.equal(disabled.deliverySnapshot, undefined)
  assert.equal(disabled.exportReplyDelivery, undefined)
})

test('native and sidecar corruption fail closed without replacing evidence or serving stale bytes', opts, async t => {
  const fx = await fixture(t)
  const { turns } = fx
  const sid = turns.create().id
  const turnId = await turn(fx, sid, 'native', 'Authoritative source')
  const input = { turnId, format: 'md' }
  const { record } = turns.exportReplyDelivery(sid, input)
  const sidecar = fx.sidecar(sid)
  const correct = await fs.readFile(sidecar, 'utf8')
  const elsewhere = join(fx.root, 'private-fixture')
  await fs.rename(sidecar, elsewhere)
  await fs.symlink(elsewhere, sidecar)
  assert.equal(turns.readReplyDelivery(sid, record.id, 0), null)
  assert.throws(() => turns.exportReplyDelivery(sid, input), error(503, 'chat_storage_unconfirmed'))
  assert.equal(await fs.readFile(elsewhere, 'utf8'), correct)
  await fs.unlink(sidecar)
  await fs.rename(elsewhere, sidecar)
  const duplicate = correct.replace('"version":1', '"version":1,"version":1')
  await fs.writeFile(sidecar, duplicate)
  assert.throws(() => turns.deliverySnapshot(sid), error(503, 'chat_storage_unconfirmed'))
  assert.equal(await fs.readFile(sidecar, 'utf8'), duplicate)
  await fs.writeFile(sidecar, correct)
  const native = JSON.parse(await fs.readFile(fx.native(sid), 'utf8'))
  native.messages[1].content[0].text = 'Swapped source'
  await fs.writeFile(fx.native(sid), JSON.stringify(native))
  assert.throws(() => turns.exportReplyDelivery(sid, input), error(503, 'chat_storage_unconfirmed'))
  const reopened = (await fx.restart()).turns
  assert.equal(reopened.readReplyDelivery(sid, record.id, 0), null)
  assert.deepEqual(reopened.deliverySnapshot(sid), { records: [], candidates: [] })
  assert.throws(() => reopened.exportReplyDelivery(sid, { turnId, format: 'txt' }), error(503, 'chat_storage_unconfirmed'))
  assert.equal(await fs.readFile(sidecar, 'utf8'), correct)
})

test('failed strict terminal persistence never exposes unconfirmed final text', opts, async t => {
  const fx = await fixture(t)
  const sid = fx.turns.create().id
  const obstruction = join(fx.chats, '_index.pending')
  fx.responses.push(async res => {
    await fs.mkdir(obstruction)
    complete(res, 'Uncommitted final text')
  })
  const receipt = await start(fx.turns, sid, 'bad-save')
  assert.equal((await receipt.done).event.stopReason, 'error')
  assert.throws(() => fx.turns.deliverySnapshot(sid), error(503, 'chat_storage_unconfirmed'))
  assert.equal(JSON.parse(await fs.readFile(fx.native(sid), 'utf8'))[nativeLedger].requests[0].status, 'running')
  assert.throws(() => fx.turns.exportReplyDelivery(sid, { turnId: receipt.turnId, format: 'md' }), error(503, 'chat_storage_unconfirmed'))
  await fs.rmdir(obstruction)
  const reopened = (await fx.restart()).turns
  assert.deepEqual(reopened.deliverySnapshot(sid), { records: [], candidates: [] })
  assert.throws(() => reopened.exportReplyDelivery(sid, { turnId: receipt.turnId, format: 'md' }), error(404, 'reply_not_exportable'))
  await assert.rejects(fs.access(fx.sidecar(sid)), { code: 'ENOENT' })
})

const use = (id, name = 'present_files') => ({ role: 'assistant', content: [{ type: 'tool_use', id, name, input: { paths: ['/never-use-arguments.txt'] } }] })
const result = (toolUseId, isError) => ({ role: 'user', content: [{ type: 'tool_result', toolUseId, content: '已交付 1 个文件', isError }] })

test('desktop projection requires an actual successful unique tool pair and the exact native sidecar', opts, async t => {
  const { turns, calls, dataDir, native, sidecar, root } = await fixture(t)
  const store = createChatStore({ dataDir })
  const s = store.ensureSession(randomUUID())
  const foreign = join(root, 'foreign-project', 'report.txt') // Deliberately absent; the file domain decides access later.
  const other = 'C:\\Example\\QA\\summary.md'
  s.messages = [
    { role: 'user', content: 'Desktop request' }, use('confirmed'), result('confirmed'),
    use('failed'), result('failed', true), use('missing-table'), result('missing-table'),
    use('duplicate'), result('duplicate'), use('duplicate', 'read_file'), result('duplicate'),
    use('wrong-tool', 'read_file'), result('wrong-tool'), use('bad-entry'), result('bad-entry'),
    use('bad-duplicate'), result('bad-duplicate'), use('second', 'present_files'), result('second', false),
    use('unmatched'), { role: 'assistant', content: 'gap' }, result('unmatched'), use('partial')
  ]
  s.delivered = {
    confirmed: [foreign, other], failed: [foreign], duplicate: [foreign], 'wrong-tool': [foreign],
    'bad-entry': [foreign, 'relative.md'], 'bad-duplicate': [foreign, foreign], second: ['/absolute/qa.pdf'],
    unmatched: [foreign], partial: [foreign], 'no-use': [foreign]
  }
  store.saveStrict(s.id)
  const peer = store.ensureSession(randomUUID())
  peer.messages = s.messages
  peer.delivered = s.delivered
  store.saveStrict(peer.id)
  const main = await fs.readFile(native(s.id))
  const view = turns.deliverySnapshot(s.id)
  assert.deepEqual(view.candidates, [])
  assert.deepEqual(view.records.map(({ origin, messageIndex, entries }) => ({ origin, messageIndex, entries })), [
    { origin: 'desktop', messageIndex: 17, entries: [{ index: 0, path: '/absolute/qa.pdf' }] },
    { origin: 'desktop', messageIndex: 1, entries: [{ index: 0, path: foreign }, { index: 1, path: other }] }
  ])
  for (const [at, record] of view.records.entries()) {
    assert.match(record.id, groupPattern)
    assert.notEqual(record.id, turns.listDeliveryRecords(peer.id)[at].id)
    assert.equal(turns.readReplyDelivery(s.id, record.id, 0), null)
  }
  assert.equal(snapshot(turns, s.id).compatibility, 'unsupported')
  assert.equal(snapshot(turns, s.id).messages, null)
  assert.throws(() => turns.exportReplyDelivery(s.id, { turnId: 'confirmed', format: 'md' }), error(409, 'unsupported_history'))
  assert.deepEqual(await fs.readFile(native(s.id)), main)
  await assert.rejects(fs.access(sidecar(s.id)), { code: 'ENOENT' })
  assert.deepEqual(calls, [])
})

test('bounded native compacted prefix participates in uniqueness and is never repaired here', opts, async t => {
  const { turns, native, chats, dataDir } = await fixture(t)
  const writer = createChatStore({ dataDir })
  const s = writer.ensureSession(randomUUID())
  s.messages = [use('visible'), result('visible')]
  s.delivered = { visible: ['/qa/visible.md'], prefix: ['/qa/prefix.txt'] }
  writer.saveStrict(s.id)
  const source = JSON.parse(await fs.readFile(native(s.id), 'utf8'))
  const file = `${s.id}.compacted-fixture.jsonl`
  const filename = join(chats, file)
  source.compacted = { count: 2, file }
  await fs.writeFile(native(s.id), JSON.stringify(source))
  await fs.writeFile(filename, [use('prefix'), result('prefix'), use('visible')].map(value => `${JSON.stringify(value)}\n`).join(''), { mode: 0o600 })
  const view = turns.deliverySnapshot(s.id)
  assert.deepEqual(view.records.map(({ messageIndex, entries }) => [messageIndex, entries[0].path]), [[2, '/qa/visible.md'], [0, '/qa/prefix.txt']])
  source.compacted.count = 3
  await fs.writeFile(native(s.id), JSON.stringify(source))
  assert.deepEqual(turns.listDeliveryRecords(s.id).map(record => record.entries[0].path), ['/qa/prefix.txt'])
  source.compacted.count = 20000
  await fs.writeFile(native(s.id), JSON.stringify(source))
  assert.throws(() => turns.deliverySnapshot(s.id), error(413, 'delivery_history_limit'))
  source.compacted.count = 4
  await fs.writeFile(native(s.id), JSON.stringify(source))
  assert.throws(() => turns.deliverySnapshot(s.id), error(503, 'chat_storage_unconfirmed'))
  assert.deepEqual(JSON.parse(await fs.readFile(native(s.id), 'utf8')), source)
  assert.equal((await fs.stat(filename)).isFile(), true)
})
