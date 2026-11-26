import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))
const ts = require('typescript')
const root = new URL('../../apps/desktop/src/workbench/', import.meta.url)
async function compiled(name, imports = {}) {
  const source = await readFile(new URL(`${name}.ts`, root), 'utf8')
  let js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText
  for (const [from, to] of Object.entries(imports)) js = js.replaceAll(`'${from}'`, `'${to}'`)
  return `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
}
const chatUrl = await compiled('chat-transport')
const { createChatTransport, attachmentPreviewUrl, parseChatFrame, sameTurnDraft } = await import(chatUrl)
const { createTransport, HttpFailure } = await import(await compiled('transport'))
const { applyChatFrame } = await import(await compiled('chat-stream', { './chat-transport': chatUrl }))
const { browserFiles, checkBrowserFile, createAttachmentDrafts, readyAttachmentIds, attachmentTurnIssue } =
  await import(await compiled('attachment-drafts', { './chat-transport': chatUrl }))

const a = '11111111-0000-4000-8000-000000000001'
const b = 'a1111111-0000-4000-8000-000000000002'
const sid = 'selected_chat-1'
const path = `/api/v1/chats/${sid}`
const csrf = 'csrf-fixture'
const boot = { protocol: 1, version: '0.1.17', platform: 'linux', config: {}, expiresAt: 1000, csrf }
const image = (patch = {}) => ({ id: a, name: '图🦊.png', size: 4, kind: 'image', mime: 'image/png', ...patch })
const text = (patch = {}) => ({ id: b, name: 'note.txt', size: 4, kind: 'text', mime: 'text/plain', ...patch })
const mockTurn = { turnId: 'turn-1', startedAt: 123, status: 'running', reason: null, duplicate: false }
const response = (data, status = 200) => new Response(JSON.stringify(data), { status })
const files = (...items) => ({ files: items, issues: [] })
const file = (name, value = '1234', type = '') => new File([value], name, { type })
const tick = () => new Promise((resolve) => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise((resolveIt) => { resolve = resolveIt }); return { promise, resolve } }

function snapshot(messages, active = null) {
  return { cursor: { epoch: 'epoch', scope: `chat:${sid}`, seq: 1, generation: 'one' },
    state: { id: sid, title: 'Thread', model: 'p:m', compatibility: 'text', writable: true, writeBlockReason: null,
      turnLimit: 256, messages, active, lastTurn: null } }
}

test('bootstrap enables uploads only for literal true, independently of other capabilities', async () => {
  for (const [capabilities, expected] of [
    [undefined, undefined], [{ textChat: true }, { textChat: true }], [{ attachments: true }, { attachments: true }],
    [{ attachments: 'true', workspaceFiles: true }, { workspaceFiles: true }], [{ attachments: 1 }, undefined]
  ]) {
    const api = createTransport(async () => response({ ...boot, capabilities }))
    assert.deepEqual((await api.inspect()).bootstrap.capabilities, expected)
  }
})

test('uploads the exact File bytes with a UTF-8 name and uses scoped CSRF writes; ordinary turns omit attachment fields', async () => {
  const source = file(image().name, new Uint8Array([0, 0xff, 1, 0x80]))
  const calls = []
  const replies = [response({ attachment: image() }, 201), response(mockTurn, 202), response(mockTurn, 202), response({ ok: true })]
  const transport = createTransport(async (url, init) => { calls.push({ url, ...init }); return replies.shift() })
  const api = createChatTransport(transport, csrf)
  assert.deepEqual(await api.uploadAttachment(sid, source, 'image/png'), image())
  await api.send(sid, { clientRequestId: 'request-a', text: '', model: 'p:m', attachments: [a] })
  await api.send(sid, { clientRequestId: 'request-b', text: 'text only', model: 'p:m' })
  await api.removeAttachment(sid, a)
  assert.deepEqual(calls.map(({ method, url }) => [method, url]), [['POST', path + '/attachments'], ['POST', path + '/turns'],
    ['POST', path + '/turns'], ['DELETE', path + `/attachments/${a}`]])
  const [upload, attached, plain, removed] = calls
  for (const call of calls) {
    assert.equal(call.credentials, 'same-origin')
    assert.equal(call.mode, 'same-origin')
    assert.equal(call.redirect, 'error')
    assert.equal(call.referrerPolicy, 'no-referrer')
    assert.equal(call.headers['x-deva-csrf'], csrf)
  }
  assert.equal(upload.headers['content-type'], 'application/octet-stream')
  assert.equal(upload.headers['x-deva-file-type'], 'image/png')
  assert.match(upload.headers['x-deva-file-name'], /^[A-Za-z0-9_-]+$/)
  assert.equal(Buffer.from(upload.headers['x-deva-file-name'], 'base64url').toString('utf8'), source.name)
  assert.equal(upload.body, source)
  assert.deepEqual(new Uint8Array(await upload.body.arrayBuffer()), new Uint8Array([0, 0xff, 1, 0x80]))
  assert.deepEqual(JSON.parse(attached.body), { clientRequestId: 'request-a', text: '', model: 'p:m', attachments: [a] })
  assert.deepEqual(JSON.parse(plain.body), { clientRequestId: 'request-b', text: 'text only', model: 'p:m' })
  assert.equal(removed.body, undefined)
  assert.equal(attachmentPreviewUrl(sid, a), `${path}/attachments/${a}/preview`)
})

test('rejects untrusted resource IDs, duplicate attachments, and non-metadata acknowledgements before the UI uses them', async () => {
  let calls = 0
  const api = createChatTransport(createTransport(async () => {
    calls++
    return response({ attachment: image({ body: 'secret', path: '/home/user/picture.png' }) }, 201)
  }), csrf)
  const source = file(image().name)
  for (const invalid of ['../other', 'other?x', 'other\n', '//different-host.test', 'a%2fb']) {
    assert.throws(() => attachmentPreviewUrl(invalid, a))
    await assert.rejects(api.uploadAttachment(invalid, source, 'image/png'))
  }
  for (const invalid of ['../other', b.toUpperCase(), `${a}\n`, a + '?token=x', a.replace('-4000-', '-3000-')]) {
    assert.throws(() => attachmentPreviewUrl(sid, invalid))
    await assert.rejects(api.removeAttachment(sid, invalid))
    await assert.rejects(api.send(sid, { clientRequestId: 'request-a', text: '', model: 'p:m', attachments: [invalid] }))
  }
  await assert.rejects(api.send(sid, { clientRequestId: 'request-a', text: '', model: 'p:m', attachments: [a, a] }))
  assert.equal(calls, 0)
  await assert.rejects(api.uploadAttachment(sid, source, 'image/png'), /Invalid attachment acknowledgement/)
  assert.equal(calls, 1)
})

test('history and reconnect snapshots keep metadata on the same message; text deltas preserve cards without duplicating them', async () => {
  const question = { role: 'user', content: '', attachments: [image(), text()] }
  const previous = { role: 'user', content: 'Prior text-only message' }
  const current = snapshot([previous, question], { text: 'Hello', startedAt: 123, turnId: 'turn-1' })
  const api = createChatTransport(createTransport(async () => response(current)), csrf)
  assert.deepEqual((await api.read(sid)).state.messages, [previous, question])
  const ws = parseChatFrame(JSON.stringify({ t: 'snapshot', ...current }), sid)
  assert.deepEqual(applyChatFrame(undefined, ws), current)
  const delta = parseChatFrame(JSON.stringify({ t: 'event', cursor: { ...current.cursor, seq: 2 }, turnId: 'turn-1',
    sessionId: sid, type: 'chat', event: { type: 'text_delta', text: ' world' } }), sid)
  const applied = applyChatFrame(current, delta)
  assert.equal(applied.state.active.text, 'Hello world')
  assert.strictEqual(applied.state.messages, current.state.messages)
  assert.strictEqual(applyChatFrame(applied, delta), applied)
  for (const metadata of [image({ mime: 'image/gif' }), image({ mime: 'text/html' }), image({ path: 'hidden' }), image({ data: 'base64' })]) {
    assert.equal(parseChatFrame(JSON.stringify({ t: 'snapshot', ...snapshot([{ ...question, attachments: [metadata] }]) }), sid), null)
  }
})

test('fallback MIME stays on the upload allowlist; folders, disabled formats, unsafe names and excess bytes are explicit', () => {
  assert.deepEqual(checkBrowserFile(file('A.JPEG')), { kind: 'image', mime: 'image/jpeg' })
  assert.deepEqual(checkBrowserFile(file('notes.pdf', 'raw', 'application/octet-stream')), { kind: 'document', mime: 'application/pdf' })
  assert.deepEqual(checkBrowserFile(file('note.json', '{}', 'application/json')), { kind: 'text', mime: 'text/plain' })
  assert.deepEqual(checkBrowserFile(file('note.ts', 'code', 'video/mp2t')), { kind: 'text', mime: 'text/plain' })
  for (const name of ['animated.gif', 'index.html', 'pic.svg', 'unsafe.ps1', 'archive.zip', 'without-extension']) {
    assert.deepEqual(checkBrowserFile(file(name)), { code: 'unsupported', name })
  }
  assert.equal(checkBrowserFile(file('wrong.pdf', 'raw', 'image/png')).code, 'unsupported')
  for (const name of ['../text.txt', 'C:\\text.txt', 'CON.txt', '.env.txt']) assert.equal(checkBrowserFile(file(name)).code, 'name')
  assert.equal(checkBrowserFile(file('empty.txt', '')).code, 'empty')
  assert.deepEqual(checkBrowserFile(file('huge.txt', new Uint8Array(512 * 1024 + 1))), { code: 'large', name: 'huge.txt', kind: 'text' })
  assert.equal(checkBrowserFile(file('huge.png', new Uint8Array(2 * 1024 * 1024 + 1))).code, 'large')
  assert.equal(checkBrowserFile(file('huge.pdf', new Uint8Array(20 * 1024 * 1024 + 1))).code, 'large')
  const clip = file('paste.png')
  const drop = browserFiles({ types: ['Files', 'text/plain'], files: [clip], items: [
    { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true, name: 'folder' }), getAsFile: () => assert.fail('directory must never read') },
    { kind: 'file', getAsFile: () => clip },
    { kind: 'string', type: 'text/plain', getAsFile: () => assert.fail('plain text must not become an attachment') }
  ] })
  assert.deepEqual(drop, { files: [clip], issues: [{ code: 'directory', name: 'folder' }] })
  assert.deepEqual(browserFiles({ types: ['text/plain'], files: [], items: [] }), files())
  assert.deepEqual(browserFiles({ types: ['Files'], files: [clip], items: [] }), files(clip))
})

test('reserves at most 4 ordered drafts, sends no turn on upload, and isolates a late upload and its cancellation to the original chat', async () => {
  const first = deferred()
  const calls = []
  const drafts = createAttachmentDrafts({
    uploadAttachment(s, data, mime) {
      calls.push(['upload', s, data.name, mime])
      return s === 'first-chat' ? first.promise : Promise.resolve(text({ name: data.name }))
    },
    async removeAttachment(s, id) { calls.push(['delete', s, id]) }
  }, () => assert.fail('unexpected expiry'))
  drafts.add('first-chat', files(file('first.png'), file('later.txt')))
  assert.equal(readyAttachmentIds(drafts.get('first-chat')), undefined)
  assert.deepEqual(drafts.get('second-chat').entries, [])
  await tick()
  assert.deepEqual(calls, [['upload', 'first-chat', 'first.png', 'image/png']])
  drafts.add('second-chat', files(file('second.txt')))
  for (const row of drafts.get('first-chat').entries) await drafts.remove('first-chat', row.key)
  first.resolve(image({ name: 'first.png' }))
  await tick()
  assert.deepEqual(calls, [['upload', 'first-chat', 'first.png', 'image/png'], ['upload', 'second-chat', 'second.txt', 'text/plain'],
    ['delete', 'first-chat', a]])
  assert.deepEqual(readyAttachmentIds(drafts.get('first-chat')), [])
  assert.deepEqual(readyAttachmentIds(drafts.get('second-chat')), [b])
  drafts.committed('second-chat', [b])
  assert.deepEqual(readyAttachmentIds(drafts.get('second-chat')), [])
  assert.equal(calls.length, 3, 'a committed draft clears locally and never deletes the committed card')

  const count = createAttachmentDrafts({ uploadAttachment: async (_, data) => text({ id: crypto.randomUUID(), name: data.name }),
    removeAttachment: async () => {} }, () => {})
  count.add(sid, files(...Array.from({ length: 5 }, (_, i) => file(`${i}.txt`))))
  assert.equal(count.get(sid).entries.length, 4)
  assert.deepEqual(count.get(sid).issues, [{ code: 'limit' }])
  await tick()
  assert.deepEqual(count.get(sid).entries.map(({ name }) => name), ['0.txt', '1.txt', '2.txt', '3.txt'])
  assert.equal(readyAttachmentIds(count.get(sid)).length, 4)
})

test('cancellation while waiting on the settings barrier sends no file bytes', async () => {
  const barrier = deferred()
  let uploadCalls = 0
  const drafts = createAttachmentDrafts({
    async uploadAttachment() { uploadCalls++; return text() },
    async removeAttachment() { assert.fail('there was no confirmed attachment to remove') }
  }, () => assert.fail('unexpected expiry'), () => barrier.promise)
  drafts.add(sid, files(file('note.txt')))
  await tick()
  await drafts.remove(sid, drafts.get(sid).entries[0].key)
  barrier.resolve()
  await tick()
  assert.equal(uploadCalls, 0)
  assert.deepEqual(drafts.get(sid).entries, [])
})

test('keeps unavailable drafts out of sends after expiry or an unconfirmed DELETE and reports quota and adapter errors distinctly', async () => {
  let attempts = 0
  let sessionExpired = false
  const uploadNames = []
  const drafts = createAttachmentDrafts({
    async uploadAttachment(_, data) {
      uploadNames.push(data.name)
      if (data.name === 'quota.txt') throw new HttpFailure(429, 'attachment_quota')
      if (data.name === 'auth.txt') throw new HttpFailure(401, 'auth')
      return text({ name: data.name })
    },
    async removeAttachment() { if (++attempts === 1) throw new TypeError('lost response'); throw new HttpFailure(404, 'attachment_not_found') }
  }, () => { sessionExpired = true })
  drafts.add(sid, files(file('note.txt'), file('quota.txt')))
  await tick()
  assert.deepEqual(readyAttachmentIds(drafts.get(sid)), [b])
  assert.equal(drafts.get(sid).issues.at(-1).code, 'quota')
  const expired = attachmentTurnIssue(new HttpFailure(404, 'attachment_not_found'))
  assert.equal(expired, 'expired')
  assert.equal(attachmentTurnIssue(new HttpFailure(422, 'attachment_adapter_unsupported')), 'adapter')
  assert.equal(attachmentTurnIssue(new HttpFailure(422, 'invalid_attachment_content')), 'invalidContent')
  assert.equal(attachmentTurnIssue(new HttpFailure(413, 'attachment_turn_limit')), 'turnLimit')
  const [{ key }] = drafts.get(sid).entries
  drafts.reportTurn(sid, [b], expired)
  assert.equal(readyAttachmentIds(drafts.get(sid)), undefined)
  assert.equal(drafts.get(sid).entries[0].status, 'expired')
  await drafts.remove(sid, key)
  assert.equal(readyAttachmentIds(drafts.get(sid)), undefined)
  assert.equal(drafts.get(sid).issues.at(-1).code, 'removeFailed')
  await drafts.remove(sid, key)
  assert.deepEqual(readyAttachmentIds(drafts.get(sid)), [])
  drafts.add(sid, files(file('auth.txt'), file('queued.txt')))
  await tick()
  assert.equal(sessionExpired, true)
  assert.deepEqual(uploadNames, ['note.txt', 'quota.txt', 'auth.txt'])
})

test('manual retries reuse a request only for identical text, model and ordered attachment IDs', () => {
  const draft = { text: '', model: 'p:m', attachments: [a, b] }
  assert.equal(sameTurnDraft(draft, { ...draft, attachments: [a, b] }), true)
  for (const changed of [{ attachments: [b, a] }, { attachments: [a] }, { attachments: [] }, { text: 'now with text' }, { model: 'p:m2' }])
    assert.equal(sameTurnDraft(draft, { ...draft, ...changed }), false)
  assert.equal(sameTurnDraft(undefined, draft), false)
  assert.equal(sameTurnDraft({ text: 'same', model: 'p:m' }, { text: 'same', model: 'p:m', attachments: [] }), true)
})
