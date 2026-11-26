import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chatScope, createEventJournal } from '../src/events/index.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const entry = 'apps/desktop/src/main/services/attachment-parts-core.ts'
const chatEntry = 'apps/headless/scripts/chat-core.ts'
const providerEntry = 'apps/desktop/src/main/providers/core.ts'
async function bundle(entryPoint) {
  const { outputFiles, metafile } = await build({
    absWorkingDir: root, entryPoints: [entryPoint], bundle: true, platform: 'node', format: 'esm',
    target: 'node22', metafile: true, write: false
  })
  const code = `${outputFiles[0].text}\n//# sourceURL=deva-fixture/${entryPoint}`
  const api = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
  return { api, metafile }
}
const [shared, chat, provider] = await Promise.all([bundle(entry), bundle(chatEntry), bundle(providerEntry)])
const {
  assetKind, isSupported, supportsAttachmentAdapter, maxUploadedAttachmentBytes, buildUploadedPart,
  uploadedAttachmentSnapshot, UploadedAttachmentError, ATTACH_TEXT_PREFIX, ATTACHMENTS_ONLY_QUESTION
} = chat.api

const fixture = (name, mime, bytes) => ({ meta: { name, mime, size: bytes.length }, bytes })
const from64 = data => Buffer.from(data, 'base64')
const TEXT = fixture('说明.txt', 'text/plain', Buffer.from('\uFEFF你好，Deva 🌟\r\n\t保留换行'))
const PNG = fixture('屏幕.PNG', 'image/png', from64('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWNYZ/B3ncFfBggFADLGB23aTHV6AAAAAElFTkSuQmCC'))
const JPEG = fixture('example.jpg', 'image/jpeg', from64('/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABv/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AI4B6Hv/2Q=='))
const WEBP = fixture('sample.webp', 'image/webp', from64('UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAIAAUAmJaACdLoB+AADsAD+6mX//dk/2yf7ZP/eM/+cSx1O7tAAAAA='))
function blankPdf() {
  let body = '%PDF-1.4\n'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Resources << >> >>'
  ]
  const offsets = objects.map((object, index) => {
    const offset = body.length
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
    return offset
  })
  const xref = `xref\n0 4\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  return Buffer.from(`${body}${xref}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${body.length}\n%%EOF\n`)
}
const PDF = fixture('说明.pdf', 'application/pdf', blankPdf())
const expectedText = `${ATTACH_TEXT_PREFIX}${TEXT.meta.name}\n\`\`\`\n${TEXT.bytes.toString('utf8')}\n\`\`\``
const question = { type: 'text', text: ATTACHMENTS_ONLY_QUESTION }
const upload = ({ meta, bytes }, adapter = 'anthropic') => buildUploadedPart(meta, bytes, adapter)
const expectCode = code => error => error instanceof UploadedAttachmentError && error.code === code

function reject(meta, bytes, code, adapter = 'anthropic') {
  assert.throws(() => buildUploadedPart(meta, bytes, adapter), expectCode(code))
}

test('pure core independently bundles for Node 22 without Electron, filesystem or provider runtime', () => {
  const { inputs, outputs } = shared.metafile
  assert.deepEqual(Object.keys(inputs).sort(), [entry, 'apps/desktop/src/main/services/avatar-image-core.ts'].sort())
  const [out] = Object.values(outputs)
  assert.equal(out.entryPoint, entry)
  assert.ok(out.imports.every(({ path, external }) => external && ['node:buffer', 'node:crypto', 'node:util'].includes(path)))
  assert.equal(shared.api.ATTACH_TEXT_PREFIX, ATTACH_TEXT_PREFIX)
  assert.equal(shared.api.ATTACHMENTS_ONLY_QUESTION, ATTACHMENTS_ONLY_QUESTION)
  assert.equal(ATTACH_TEXT_PREFIX, '[附件文件] ')
  assert.equal(ATTACHMENTS_ONLY_QUESTION, '请理解并处理上述附件。')
})

test('desktop and upload capabilities are explicit and preserve desktop format/byte thresholds', () => {
  const { classifyAttachmentExtension, MAX_IMAGE, MAX_PDF, MAX_TEXT } = shared.api
  const desktopOnly = [
    ['movie.GIF', 'image/gif', 'image'], ['tree.svg', 'text/plain', 'text'],
    ['page.html', 'text/plain', 'text'], ['run.bat', 'text/plain', 'text'], ['run.ps1', 'text/plain', 'text']
  ]
  for (const [name, mime, kind] of desktopOnly) {
    const meta = { name, mime, size: 1 }
    assert.equal(classifyAttachmentExtension(name.slice(name.lastIndexOf('.'))), kind)
    assert.equal(assetKind(meta), 'unsupported')
    assert.equal(isSupported(meta, 'anthropic'), false)
    reject(meta, Buffer.from('a'), 'unsupported_attachment_type')
  }
  for (const name of ['deck.pptx', 'file.zip', 'bundle.tar.gz', 'README']) {
    reject({ name, mime: 'text/plain', size: 1 }, Buffer.from('a'), 'unsupported_attachment_type')
  }
  assert.equal(MAX_IMAGE, 5 * 1024 * 1024)
  for (const [source, kind, max] of [[PNG, 'image', 2 * 1024 * 1024], [TEXT, 'text', MAX_TEXT], [PDF, 'document', MAX_PDF]]) {
    assert.equal(assetKind(source.meta), kind)
    for (const adapter of ['anthropic', 'responses', 'openai']) {
      const compatible = kind !== 'document' || adapter !== 'openai'
      assert.equal(supportsAttachmentAdapter(kind, adapter), compatible)
      assert.equal(maxUploadedAttachmentBytes(kind, adapter), compatible ? max : 0)
      assert.equal(isSupported({ ...source.meta, size: max }, adapter), compatible)
      assert.equal(isSupported({ ...source.meta, size: max + 1 }, adapter), false)
    }
    reject({ ...source.meta, size: max + 1 }, source.bytes, 'attachment_too_large')
  }
  const exactText = fixture('boundary.txt', 'text/plain', Buffer.alloc(MAX_TEXT, 0x61))
  assert.equal(upload(exactText).display.size, MAX_TEXT)
})

test('UTF-8 and raster/PDF bytes yield normalized parts and canonical Base64', () => {
  // Only the typed-array view is used; the buffer on either side must stay out of the model part.
  const withPrivateNeighbors = Buffer.concat([Buffer.from('private-before'), TEXT.bytes, Buffer.from('private-after')])
  const view = new Uint8Array(withPrivateNeighbors.buffer, withPrivateNeighbors.byteOffset + 14, TEXT.bytes.length)
  assert.deepEqual(buildUploadedPart(TEXT.meta, view, 'openai'), {
    part: { type: 'text', text: expectedText }, display: { ...TEXT.meta, kind: 'text' }
  })
  for (const [source, kind] of [[PNG, 'image'], [JPEG, 'image'], [WEBP, 'image'], [PDF, 'document']]) {
    let built
    assert.doesNotThrow(() => { built = upload(source, 'responses') }, source.meta.name)
    const { part, display } = built
    assert.deepEqual(part, { type: kind, name: source.meta.name, mediaType: source.meta.mime, data: source.bytes.toString('base64') })
    assert.equal(part.data.length, 4 * Math.ceil(source.bytes.length / 3))
    assert.deepEqual(from64(part.data), source.bytes)
    assert.deepEqual(display, { ...source.meta, kind })
  }
  const script = fixture('snippet.js', 'text/plain', Buffer.from('globalThis.devaAttachmentFixture = "was executed"'))
  assert.match(upload(script).part.text, /globalThis\.devaAttachmentFixture/)
  assert.equal(globalThis.devaAttachmentFixture, undefined)
})

test('malformed name, MIME, size and bytes fail without echoing private input', () => {
  for (const name of ['/private/host.txt', 'C:\\Host\\secret.txt', '../secret.txt', '\\\\host\\share.txt',
    'https://host/asset.txt?secret=fixture', 'asset%2Fhost.txt', 'asset.txt?sig=fixture', '.secret.txt',
    'file\n.txt', 'file\u202e.txt', 'file\uD800.txt', 'e\u0301.txt', 'CON.txt', ' leading.txt', '中'.repeat(100) + '.txt']) {
    assert.equal(assetKind({ ...TEXT.meta, name }), 'unsupported', name)
    reject({ ...TEXT.meta, name }, TEXT.bytes, 'invalid_attachment_name')
  }
  for (const mime of ['text/plain; charset=utf-8', 'TEXT/PLAIN', 'text/html', 'image/png', 'application/octet-stream', '', null]) {
    reject({ ...TEXT.meta, mime }, TEXT.bytes, 'invalid_attachment_mime')
  }
  for (const size of [0, -1, 1.5, Infinity, NaN, 2 ** 53, String(TEXT.meta.size)]) {
    reject({ ...TEXT.meta, size }, TEXT.bytes, 'invalid_attachment_size')
  }
  const tainted = { ...TEXT.meta, path: '/private/host.txt', signature: 'secret-fixture' }
  assert.throws(() => buildUploadedPart(tainted, TEXT.bytes, 'anthropic'), error => {
    assert.equal(error.code, 'invalid_attachment_metadata')
    assert.doesNotMatch(JSON.stringify([error, error.message]), /private|secret-fixture/)
    return true
  })
  reject({ ...TEXT.meta, get name() { throw Error('accessor called') } }, TEXT.bytes, 'invalid_attachment_metadata')
  reject(TEXT.meta, TEXT.bytes.subarray(1), 'attachment_size_mismatch')
  for (const bytes of [PNG.bytes.toString('base64'), `data:image/png;base64,${PNG.bytes.toString('base64')}`,
    new Uint16Array(PNG.meta.size), PNG.bytes.buffer, Object.create(Uint8Array.prototype)]) {
    reject(PNG.meta, bytes, 'invalid_attachment_bytes')
  }
  const spoofed = new Uint8Array(256)
  Object.defineProperty(spoofed, 'byteLength', { value: TEXT.meta.size })
  reject(TEXT.meta, spoofed, 'attachment_size_mismatch')
  for (const bytes of [Buffer.from([0xc0, 0xaf]), Buffer.from('prefix\x00suffix'), Buffer.from('text\x1bshell')]) {
    reject({ ...TEXT.meta, size: bytes.length }, bytes, 'invalid_attachment_text')
  }
  for (const bytes of [PDF.bytes, Buffer.from('\uFEFF%PDF-'), Buffer.from('%PDF-not-a-text-attachment')]) {
    reject({ ...TEXT.meta, size: bytes.length }, bytes, 'attachment_content_mismatch')
  }
  reject({ ...PDF.meta, size: TEXT.bytes.length }, TEXT.bytes, 'attachment_content_mismatch')
  reject({ ...PNG.meta, size: JPEG.bytes.length }, JPEG.bytes, 'attachment_content_mismatch')
  const resizedHeader = Buffer.from(PNG.bytes)
  resizedHeader.writeUInt32BE(4097, 16)
  reject(PNG.meta, resizedHeader, 'attachment_content_mismatch')
  const malformedMarkup = Buffer.from(PNG.bytes)
  malformedMarkup.write('acTL', 37)
  reject(PNG.meta, malformedMarkup, 'attachment_content_mismatch')
  reject({ ...PNG.meta, size: 8 }, PNG.bytes.subarray(0, 8), 'attachment_content_mismatch')
})

test('real provider adapters encode text, image and PDF; Chat Completions errors before HTTP', async () => {
  const calls = []
  const core = provider.api.createProviderCore({
    httpFetch: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) })
      return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    },
    describeNetError: () => 'fixture network error', getAppVersion: () => '1.0.0',
    getSecret: async () => 'fixture-key', providerCustomHeaders: () => ({}), isEn: () => true
  })
  async function send(adapter, attachments) {
    const content = [...attachments.map(source => upload(source, adapter).part), question]
    for await (const _ of core.streamChat({ adapter, providerId: 'fixture', baseURL: 'https://fixture.invalid/v1' }, {
      model: 'fixture-model', maxTokens: 64, messages: [{ role: 'user', content }]
    })) { /* The test captures the exact outgoing request, not the fixture's response. */ }
  }
  const img64 = PNG.bytes.toString('base64')
  const pdf64 = PDF.bytes.toString('base64')
  await send('anthropic', [TEXT, PNG, PDF])
  await send('responses', [TEXT, PNG, PDF])
  await send('openai', [TEXT, PNG])
  await assert.rejects(send('openai', [TEXT, PNG, PDF]), error => {
    assert.ok(expectCode('attachment_adapter_unsupported')(error))
    return /PDF.*Anthropic.*OpenAI Responses.*Chat Completions/.test(error.message)
  })
  assert.equal(calls.length, 3)
  assert.ok(calls[0].url.endsWith('/messages'))
  assert.deepEqual(calls[0].body.messages, [{ role: 'user', content: [
    { type: 'text', text: expectedText },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: img64 } },
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf64 } }, question
  ] }])
  assert.ok(calls[1].url.endsWith('/responses'))
  assert.deepEqual(calls[1].body.input, [{ role: 'user', content: [
    { type: 'input_text', text: expectedText },
    { type: 'input_image', image_url: `data:image/png;base64,${img64}` },
    { type: 'input_file', filename: PDF.meta.name, file_data: `data:application/pdf;base64,${pdf64}` },
    { type: 'input_text', text: question.text }
  ] }])
  assert.ok(calls[2].url.endsWith('/chat/completions'))
  assert.deepEqual(calls[2].body.messages, [{ role: 'user', content: [
    { type: 'text', text: `${expectedText}\n${question.text}` }, { type: 'image_url', image_url: { url: `data:image/png;base64,${img64}` } }
  ] }])
})

test('authorized attachments are model-readable after reload, but the journal snapshot has only persisted display metadata', t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'deva-attachment-parts-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const journal = createEventJournal()
  t.after(() => journal.close())
  const id = 'attachment_test'
  const store = chat.api.createChatStore({ dataDir })
  const built = [TEXT, PNG, PDF].map(source => upload(source))
  const parts = [...built.map(x => x.part), question]
  const session = store.ensureSession(id)
  session.messages.push({ role: 'user', content: parts })
  // Exercise store/reload without introducing a storage field or changing a route in production.
  session.fixtureDisplayAttachments = built.map(x => x.display)
  store.saveStrict(id)
  const restored = chat.api.createChatStore({ dataDir }).getSession(id)
  assert.deepEqual(restored.messages[0].content, parts)
  const snapshot = journal.snapshot(chatScope(id), () => ({ messages: [{
    role: 'user', text: '', attachments: restored.fixtureDisplayAttachments.map(uploadedAttachmentSnapshot)
  }] }))
  assert.deepEqual(snapshot.state.messages[0].attachments, built.map(x => x.display))
  const body = JSON.stringify(snapshot)
  assert.doesNotMatch(body, /base64|data:|"path"|"signature"|"part"|"blob"|"data"/)
  for (const value of [PNG.bytes.toString('base64'), PDF.bytes.toString('base64'), '你好，Deva', ATTACHMENTS_ONLY_QUESTION]) {
    assert.equal(body.includes(value), false)
  }
  for (const record of [built[1].part, { ...built[1].display, data: built[1].part.data },
    { ...built[1].display, kind: 'text' }, { ...built[1].display, path: '/private/host.png' }]) {
    assert.throws(() => uploadedAttachmentSnapshot(record), expectCode('invalid_attachment_display'))
  }
})
