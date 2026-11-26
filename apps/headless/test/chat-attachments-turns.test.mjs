import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { promises as fs } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { ATTACHMENTS_ONLY_QUESTION, buildUploadedPart, createChatStore } from '../dist/chat-core.mjs'
import { openUploadStore } from '../src/attachments/upload-store.mjs'
import { createTextTurns } from '../src/chat/text-turns.mjs'
import { createEventJournal } from '../src/events/index.mjs'

const reserved = '_devaHeadlessTurnAttachments'
const MiB = 1024 * 1024
const options = { timeout: 15_000 }
const auth = 'test-upload-model-credential'
const modelId = 'chosen/attachment:model'
const ref = adapter => `${adapter}:${modelId}`
const send = (sid, clientRequestId, text, attachments, adapter = 'anthropic') => ({
  sid, clientRequestId, text, model: ref(adapter), ...(attachments === undefined ? {} : { attachments })
})
const show = ({ id, name, kind, mime, size }) => ({ id, name, kind, mime, size })
const error = (status, code) => ({ status, code })
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWNYZ/B3ncFfBggFADLGB23aTHV6AAAAAElFTkSuQmCC', 'base64')
const text = Buffer.from('\uFEFF正文绝不可出现在快照中 🍃\r\n')
const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
  '2 0 obj\n<< /Type /Pages /Count 0 /Kids [] >>\nendobj\n' +
  'xref\n0 3\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n' +
  'trailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n110\n%%EOF\n')

function respond(request, res) {
  const frames = request.url.endsWith('/messages') ? [
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Verified' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
  ] : request.url.endsWith('/responses') ? [
    { type: 'response.output_text.delta', delta: 'Verified' },
    { type: 'response.completed', response: {} }
  ] : [{ choices: [{ index: 0, delta: { content: 'Verified' }, finish_reason: 'stop' }] }, '[DONE]']
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end(frames.map(x => `data: ${typeof x === 'string' ? x : JSON.stringify(x)}\n\n`).join(''))
}

async function fixture(t, { onRequest = respond, resolveRole, uploadOptions, wrapUploads = x => x } = {}) {
  const dataDir = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'deva-chat-attachment-turns-'))
  const chats = join(dataDir, 'data', 'chats')
  const media = join(dataDir, 'data', 'media')
  const sessionPath = sid => join(chats, `${sid}.json`)
  const disk = async sid => JSON.parse(await fs.readFile(sessionPath(sid), 'utf8'))
  const failures = [], calls = [], providerReads = []
  const server = createServer((req, res) => {
    void (async () => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const request = { url: req.url, headers: req.headers, method: req.method, body: JSON.parse(Buffer.concat(chunks)) }
      calls.push(request)
      await onRequest(request, res)
    })().catch(err => { failures.push(err); res.destroy() })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  const settings = { async getProvider(id) {
    providerReads.push(id)
    return { id, adapter: id, apiHost: `${origin}/${id}${id === 'anthropic' ? '' : '/v1'}`, apiKey: auth, purpose: 'llm', enabled: true,
      models: [{ id: modelId, enabled: true }] }
  } }
  let turns, journal, uploads
  async function open(enableUploads = true) {
    uploads = enableUploads ? await openUploadStore({ dataDir, ...uploadOptions }) : undefined
    journal = createEventJournal()
    turns = createTextTurns({ dataDir, settings, journal, version: 'fixture', allowedOrigins: [origin], resolveRole,
      ...(uploads && { uploads: wrapUploads(uploads) }) })
  }
  async function close() {
    await turns?.close()
    journal?.close()
    await uploads?.close()
  }
  t.after(async () => {
    await close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await fs.rm(dataDir, { force: true, recursive: true })
    assert.deepEqual(failures, [])
  })
  await open()
  async function complete(req) {
    const { promise, resolve } = Promise.withResolvers()
    const { subscription } = turns.attach(req.sid, { onEvent: event => { if (event.event.type === 'done') resolve(event) } })
    try {
      const ack = await turns.send(req)
      assert.equal((await promise).turnId, ack.turnId)
      return turns.snapshot(req.sid).state.lastTurn
    } finally { subscription.close() }
  }
  const stage = (sid, name, mime, bytes) => uploads.stage(sid, { name, mime, size: bytes.length }, Readable.from([bytes]))
  return { dataDir, chats, media, sessionPath, disk, calls, providerReads, stage, complete, get turns() { return turns },
    get uploads() { return uploads }, async restart(enableUploads) { await close(); await open(enableUploads) } }
}

function userParts(call) {
  const parts = (call.body.messages ?? call.body.input).filter(m => m.role === 'user').at(-1).content
  return parts.map(({ cache_control: _, ...part }) => part)
}

test('real uploaded text/image history is committed before model I/O, safely projected and replayed after draft deletion and restart', options, async t => {
  let fx, sid, image, file
  const observed = []
  fx = await fixture(t, { async onRequest(req, res) {
    const stored = await fx.disk(sid)
    const { items } = stored[reserved].rows[0]
    observed.push({ stored, body: await fs.readFile(join(fx.media, items[0].blob)), png: await fs.readFile(join(fx.media, items[1].blob)) })
    respond(req, res)
  } })
  sid = fx.turns.create().id
  const other = fx.turns.create().id
  assert.equal(fx.turns.attachmentScope(randomUUID()), null)
  assert.deepEqual(fx.turns.attachmentScope(sid), { writable: true })
  file = await fx.stage(sid, 'notes.txt', 'text/plain', text)
  image = await fx.stage(sid, 'chart.png', 'image/png', png)
  assert.equal(fx.turns.readCommittedAttachment(sid, file.id), null)
  const first = send(sid, 'mixed', 'Describe them', [file.id, image.id])
  const terminal = await fx.complete(first)
  assert.equal(terminal.status, 'completed')
  assert.equal(fx.calls.length, 1)
  const [call] = fx.calls
  assert.equal(call.url, '/anthropic/v1/messages')
  assert.equal(call.method, 'POST')
  assert.equal(call.headers['x-api-key'], auth)
  assert.equal(call.body.model, modelId)
  assert.equal(call.body.tools?.length ?? 0, 0)
  const textPart = buildUploadedPart({ name: file.name, mime: file.mime, size: file.size }, text, 'anthropic').part
  assert.deepEqual(userParts(call), [textPart,
    { type: 'image', source: { type: 'base64', media_type: image.mime, data: png.toString('base64') } },
    { type: 'text', text: first.text }])
  const [proof] = observed
  assert.deepEqual(proof.body, text)
  assert.deepEqual(proof.png, png)
  assert.equal(proof.stored._devaHeadlessTextTurns.requests[0].status, 'running')
  assert.equal(proof.stored.messages[0].content.at(-1).text, first.text)
  assert.ok(!JSON.stringify(proof.stored).includes(png.toString('base64')))
  assert.ok(!JSON.stringify(proof.stored).includes(text.toString().trim()))
  const snapshot = fx.turns.snapshot(sid).state.messages
  assert.deepEqual(snapshot, [
    { role: 'user', content: first.text, attachments: [show(file), show(image)] }, { role: 'assistant', content: 'Verified' }
  ])
  assert.equal(fx.turns.readCommittedAttachment(other, file.id), null)
  assert.equal(fx.turns.readCommittedAttachment(sid, `../${file.id}`), null)
  assert.deepEqual(fx.turns.readCommittedAttachment(sid, file.id), { meta: file, bytes: text })
  assert.deepEqual(fx.turns.readCommittedAttachment(sid, image.id), { meta: image, bytes: png })
  assert.equal(await fx.uploads.describe(sid, file.id), null, 'committed items no longer occupy draft quotas')
  assert.equal(await fx.uploads.describe(sid, image.id), null)
  await fx.uploads.remove(sid, file.id)
  await fx.uploads.remove(sid, image.id)
  await fx.restart()
  assert.deepEqual(fx.turns.snapshot(sid).state.messages, snapshot)
  assert.deepEqual(fx.turns.readCommittedAttachment(sid, image.id), { meta: image, bytes: png })
  assert.deepEqual(await fx.turns.send(first), { ...terminal, duplicate: true })
  await assert.rejects(fx.turns.send({ ...first, attachments: [image.id, file.id] }), error(409, 'client_request_conflict'))
  await assert.rejects(fx.turns.send({ ...first, attachments: [] }), error(409, 'client_request_conflict'))
  assert.deepEqual(fx.providerReads, ['anthropic'])
  assert.equal(fx.calls.length, 1)
  const second = send(sid, 'after-restart', 'Use the earlier files.')
  assert.equal((await fx.complete(second)).status, 'completed')
  assert.deepEqual(fx.calls[1].body.messages[0].content, call.body.messages[0].content)
  const desktop = createChatStore({ dataDir: fx.dataDir })
  const loaded = desktop.getSession(sid)
  assert.deepEqual(loaded.messages[0].content, [textPart,
    { type: 'image', mediaType: 'image/png', data: png.toString('base64'), name: image.name }, { type: 'text', text: first.text }])
  await fx.turns.close()
  desktop.saveStrict(sid)
  assert.deepEqual((await fx.disk(sid)).messages[0].content, proof.stored.messages[0].content)
  await fx.restart(false)
  assert.equal(fx.turns.snapshot(sid).state.writable, false)
  assert.equal(fx.turns.attachmentScope(sid), null)
  assert.equal(fx.turns.readCommittedAttachment(sid, image.id), null)
})

test('PDF-only Responses and Anthropic wire format, upload ownership and strict OpenAI Chat rejection', options, async t => {
  const fx = await fixture(t)
  const sid = fx.turns.create().id
  const other = fx.turns.create().id
  const document = await fx.stage(sid, 'guide.pdf', 'application/pdf', pdf)
  const remote = await fx.stage(other, 'preview.pdf', 'application/pdf', pdf)
  const request = send(sid, 'pdf-only', '', [document.id], 'openai')
  await assert.rejects(fx.turns.send(request), error(422, 'attachment_adapter_unsupported'))
  await assert.rejects(fx.turns.send({ ...request, attachments: [remote.id] }), error(404, 'attachment_not_found'))
  for (const attachments of [null, [{ id: document.id }], [document.id, document.id], [[document.id]],
    [`https://localhost/${document.id}`], [`/tmp/${document.id}`], [document.id, ...Array.from({ length: 4 }, randomUUID)]]) {
    await assert.rejects(fx.turns.send({ ...request, attachments }), error(400, 'invalid_attachments'))
  }
  await assert.rejects(fx.turns.send({ ...request, attachments: [] }), error(400, 'invalid_text'))
  assert.equal(fx.calls.length, 0)
  assert.deepEqual((await fx.disk(sid)).messages, [])
  const accepted = { ...request, model: ref('responses') }
  assert.equal((await fx.complete(accepted)).status, 'completed')
  const [wire] = fx.calls
  assert.equal(wire.url, '/responses/v1/responses')
  assert.equal(wire.headers.authorization, `Bearer ${auth}`)
  const encoded = pdf.toString('base64')
  assert.deepEqual(userParts(wire), [{ type: 'input_file', filename: document.name, file_data: `data:application/pdf;base64,${encoded}` },
    { type: 'input_text', text: ATTACHMENTS_ONLY_QUESTION }])
  assert.deepEqual(fx.turns.snapshot(sid).state.messages[0], { role: 'user', content: '', attachments: [show(document)] })
  assert.equal(fx.turns.readCommittedAttachment(sid, remote.id), null)
  assert.equal(fx.turns.readCommittedAttachment(other, document.id), null)
  const olderPDF = send(sid, 'switch', 'PDF from earlier', undefined, 'openai')
  await assert.rejects(fx.turns.send(olderPDF), error(422, 'attachment_adapter_unsupported'))
  assert.equal(fx.calls.length, 1)
  assert.equal((await fx.complete({ ...olderPDF, model: ref('anthropic') })).status, 'completed')
  assert.deepEqual(fx.calls[1].body.messages[0].content, [
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: encoded } },
    { type: 'text', text: ATTACHMENTS_ONLY_QUESTION }
  ])
})

test('attachment admission is abortable after ACK without losing previews; role guidance is transient', options, async t => {
  const role = { id: 'attachment-editor', name: 'Editor', prompt: 'Private role preference.', enabled: true }
  const fx = await fixture(t, { resolveRole: async () => role })
  const sid = fx.turns.create({}, role).id
  const file = await fx.stage(sid, 'notes.txt', 'text/plain', text)
  const req = send(sid, 'stop-after-commit', '', [file.id])
  const { promise, resolve } = Promise.withResolvers()
  const { subscription } = fx.turns.attach(sid, { onEvent(item) { if (item.event.type === 'done') resolve() } })
  t.after(subscription.close)
  const ack = await fx.turns.send(req)
  assert.deepEqual(fx.turns.stop({ sid, turnId: ack.turnId }), { stopped: true })
  await promise
  assert.equal(fx.calls.length, 0)
  assert.equal(fx.turns.snapshot(sid).state.lastTurn.status, 'aborted')
  assert.deepEqual(fx.turns.readCommittedAttachment(sid, file.id), { meta: file, bytes: text })
  const next = await fx.stage(sid, 'chart.png', 'image/png', png)
  assert.equal((await fx.complete(send(sid, 'persona', 'Question', [next.id]))).status, 'completed')
  const [wire] = fx.calls
  const latest = userParts(wire).slice(-3) // Anthropic coalesces consecutive same-role messages after an abort.
  assert.match(latest[0].text, /Private role preference/)
  assert.equal(latest[1].type, 'image')
  assert.equal(latest[2].text, 'Question')
  assert.ok(!JSON.stringify(await fx.disk(sid)).includes(role.prompt))
})

test('expired, changed, and unconfirmed uploads and lost history fail before upstream I/O', options, async t => {
  let now = 1000, tamper = false
  const fx = await fixture(t, {
    uploadOptions: { now: () => now, draftTtlMs: 10 },
    wrapUploads: real => ({ async read(sid, id) {
      const data = await real.read(sid, id)
      if (tamper) data.bytes[0] ^= 1
      return data
    } })
  })
  const sid = fx.turns.create().id
  const expired = await fx.stage(sid, 'expired.txt', 'text/plain', Buffer.from('old'))
  now += 10
  await assert.rejects(fx.turns.send(send(sid, 'a', '', [expired.id])), error(404, 'attachment_not_found'))
  const file = await fx.stage(sid, 'notes.txt', 'text/plain', text)
  const first = send(sid, 'a', '', [file.id])
  tamper = true
  await assert.rejects(fx.turns.send(first), error(422, 'invalid_attachment_content'))
  tamper = false
  await fs.writeFile(fx.media, 'not a directory')
  await assert.rejects(fx.turns.send(first), error(503, 'chat_storage_unconfirmed'))
  assert.equal(fx.calls.length, 0)
  assert.deepEqual((await fx.disk(sid)).messages, [])
  await fs.unlink(fx.media)
  const outcome = await fx.complete(first)
  const stored = await fx.disk(sid)
  const location = join(fx.media, stored[reserved].rows[0].items[0].blob)
  await fs.writeFile(location, Buffer.alloc(text.length, 0x61)) // same size; strength comes from the digest
  assert.equal(fx.turns.readCommittedAttachment(sid, file.id), null)
  assert.deepEqual(fx.turns.attachmentScope(sid), { writable: false })
  await assert.rejects(fx.turns.send(send(sid, 'new', 'Continue')), error(409, 'unsupported_history'))
  await fs.unlink(location)
  await fx.restart()
  assert.deepEqual(fx.turns.attachmentScope(sid), { writable: false })
  assert.equal(fx.turns.list().find(s => s.id === sid).writeBlockReason, 'unsupported_history')
  assert.equal(fx.turns.snapshot(sid).state.messages, null)
  assert.deepEqual(await fx.turns.send(first), { ...outcome, duplicate: true })
  assert.deepEqual(await fx.disk(sid), stored)
  assert.equal(fx.calls.length, 1)
})

test('an ambiguous session save never starts a model; restart finds the durable receipt and media', options, async t => {
  const fx = await fixture(t)
  const sid = fx.turns.create().id
  const image = await fx.stage(sid, 'chart.png', 'image/png', png)
  const indexPath = join(fx.chats, '_index.json')
  await fs.unlink(indexPath)
  await fs.mkdir(indexPath) // Main JSON can be published; renaming its derived index will fail.
  const req = send(sid, 'index-failure', 'Describe the image', [image.id])
  await assert.rejects(fx.turns.send(req), error(503, 'chat_storage_unconfirmed'))
  await assert.rejects(fx.turns.send(req), error(503, 'chat_storage_unconfirmed'))
  assert.deepEqual(fx.turns.attachmentScope(sid), { writable: false })
  assert.equal(fx.turns.readCommittedAttachment(sid, image.id), null)
  assert.equal(fx.calls.length, 0)
  await fx.uploads.remove(sid, image.id)
  await fs.rmdir(indexPath)
  await fx.restart()
  const receipt = await fx.turns.send(req)
  assert.equal(receipt.duplicate, true)
  assert.equal(receipt.status, 'interrupted')
  assert.deepEqual(fx.turns.readCommittedAttachment(sid, image.id), { meta: image, bytes: png })
  assert.equal(fx.calls.length, 0)
})

test('20 MiB turn and 48 MiB session caps apply before a model call and persist across restart', { timeout: 40_000 }, async t => {
  const fx = await fixture(t)
  const sid = fx.turns.create().id
  async function stagePdf(size) {
    const payload = Buffer.alloc(size, 0x70)
    payload.write('%PDF-1.4\n%', 0)
    payload.write('\n%%EOF\n', size - 7)
    return fx.stage(sid, `asset-${size}.pdf`, 'application/pdf', payload)
  }
  const first = await stagePdf(20 * MiB)
  const second = await stagePdf(20 * MiB)
  const invalid = send(sid, 'quota', '', [first.id, second.id], 'responses')
  await assert.rejects(fx.turns.send(invalid), error(413, 'attachment_turn_limit'))
  assert.equal(fx.calls.length, 0)
  for (const [i, asset] of [first, second].entries()) {
    assert.equal((await fx.complete(send(sid, `budget-${i}`, '', [asset.id], 'responses'))).status, 'completed')
    await fx.uploads.remove(sid, asset.id)
    fx.calls.length = 0 // Don't retain the authorized full requests beyond their assertions.
  }
  await fx.restart()
  const overflow = await stagePdf(8 * MiB + 1)
  await assert.rejects(fx.turns.send(send(sid, 'overflow', '', [overflow.id], 'responses')), error(413, 'attachment_session_limit'))
  assert.equal(fx.calls.length, 0)
  const boundary = await stagePdf(8 * MiB)
  assert.equal((await fx.complete(send(sid, 'full', '', [boundary.id], 'responses'))).status, 'completed')
  assert.deepEqual(fx.turns.attachmentScope(sid), { writable: false })
  assert.equal(fx.turns.snapshot(sid).state.writable, true) // The cap does not close ordinary text chat.
  assert.deepEqual(fx.turns.snapshot(sid).state.messages.filter(m => m.role === 'user').map(m => m.attachments[0]), [first, second, boundary].map(show))
})
