import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildUploadedPart } from '../dist/chat-core.mjs'
import { openUploadStore, UPLOAD_MIME_LIMITS, validUploadId } from '../src/attachments/upload-store.mjs'
import { acquireWriterLock } from '../src/runtime/writer-lock.mjs'

const TEXT = { name: 'draft.txt', mime: 'text/plain' }
const PDF = Buffer.from('%PDF-1.7\r\n% fixture; header identification only\n')
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWNYZ/B3ncFfBggFADLGB23aTHV6AAAAAElFTkSuQmCC', 'base64')
const JPEG = Buffer.from('/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCMArpq/9k=', 'base64')
const WEBP = Buffer.from('UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAIAAUAmJaACdLoB+AADsAD+6mX//dk/2yf7ZP/eM/+cSx1O7tAAAAA=', 'base64')
const code = name => ({ code: `UPLOAD_${name}` })
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const defer = () => Promise.withResolvers()
const asBytes = value => typeof value === 'string' ? Buffer.from(value) : value
async function* stream(...items) { for (const item of items) yield asBytes(item) }

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'deva-upload-test-'))
  const drafts = join(dataDir, 'upload-drafts-v1')
  const release = acquireWriterLock(dataDir)
  const stores = []
  t.after(async () => {
    try { await Promise.all(stores.map(store => store.close())) }
    finally { release(); await rm(dataDir, { recursive: true, force: true }) }
  })
  async function reopen(overrides = {}) {
    const store = await openUploadStore({ dataDir, ...options, ...overrides })
    stores.push(store)
    return store
  }
  return { store: await reopen(), reopen, dataDir, drafts, path: id => join(drafts, `${id}.draft`) }
}

async function flipByte(path, position, value) {
  const handle = await open(path, 'r+')
  try { await handle.write(Buffer.from([value]), 0, 1, position) } finally { await handle.close() }
}

function blockedStream(first) {
  const entered = defer()
  const resume = defer()
  return { entered, resume, source: (async function* () { yield first; entered.resolve(); await resume.promise })() }
}

test('private on-disk publication is scoped, byte-exact, and independent from committed history', async t => {
  const { store, reopen, dataDir, drafts, path } = await fixture(t)
  const history = join(dataDir, 'native-history-copy')
  const raw = Buffer.from('héllo 👋\n再见\r\n')
  await writeFile(history, raw)
  const waiting = defer()
  const resume = defer()
  const stage = store.stage('s1', { name: 're\u0301sume\u0301.txt', mime: 'TEXT/PLAIN; charset=UTF-8', size: raw.length }, (async function* () {
    yield raw.subarray(0, 2)
    waiting.resolve()
    await resume.promise
    yield raw.subarray(2, 10)
    yield raw.subarray(10)
  })())
  await waiting.promise
  const [partial] = await readdir(drafts)
  const tentative = partial.slice(1, -8)
  assert.ok(validUploadId(tentative))
  assert.equal((await lstat(drafts)).mode & 0o777, 0o700)
  const partialStat = await lstat(join(drafts, partial))
  assert.equal(partialStat.mode & 0o777, 0o600)
  assert.equal(partialStat.size, 2)
  assert.equal(await store.describe('s1', tentative), null)
  await assert.rejects(store.read('s1', tentative), code('NOT_FOUND'))
  resume.resolve()
  const meta = await stage
  assert.deepEqual(meta, { id: tentative, name: 'résumé.txt', mime: 'text/plain', kind: 'text', size: raw.length, sha256: digest(raw) })
  assert.deepEqual(await readdir(drafts), [`${meta.id}.draft`])
  const final = await lstat(path(meta.id))
  assert.equal(final.ino, partialStat.ino)
  assert.equal(final.mode & 0o777, 0o600)
  assert.equal(final.nlink, 1)
  assert.equal(await store.describe('s2', meta.id), null)
  await assert.rejects(store.read('s2', meta.id), code('NOT_FOUND'))
  assert.equal(await store.remove('s2', meta.id), false)
  assert.equal(await store.describe('s1', '../native-history-copy'), null)
  const { bytes } = await store.read('s1', meta.id)
  assert.deepEqual(bytes, raw)
  bytes.fill(0)
  meta.name = 'mutated.txt'
  assert.equal((await store.describe('s1', tentative)).name, 'résumé.txt')
  assert.deepEqual((await store.read('s1', tentative)).bytes, raw)
  await assert.rejects(reopen(), code('IN_USE'))
  assert.equal(await store.remove('s1', tentative), true)
  assert.equal(await store.remove('s1', tentative), false)
  assert.deepEqual(await readdir(drafts), [])
  assert.deepEqual(await readFile(history), raw)
})

test('supported records share the native adapter metadata and raster checks', async t => {
  const { store } = await fixture(t)
  const cases = [
    ['pixel.PNG', 'image/png', 'image', PNG], ['pixel.jpeg', 'image/jpeg', 'image', JPEG],
    ['pixel.webp', 'image/webp', 'image', WEBP], ['document.pdf', 'application/pdf', 'document', PDF],
    ['notes.md', 'text/plain', 'text', Buffer.from('普通文本\t café\n')],
  ]
  assert.deepEqual(UPLOAD_MIME_LIMITS, {
    'text/plain': 512 * 1024, 'image/png': 2 * 1024 * 1024, 'image/jpeg': 2 * 1024 * 1024,
    'image/webp': 2 * 1024 * 1024, 'application/pdf': 20 * 1024 * 1024,
  })
  for (const [name, mime, kind, bytes] of cases) {
    const raw = new Uint8Array(bytes.length + 2)
    raw.set(bytes, 1)
    const meta = await store.stage('session', { name, mime }, stream(raw.subarray(1, 4), raw.subarray(4, bytes.length + 1)))
    assert.deepEqual(meta, { id: meta.id, name, mime, kind, size: bytes.length, sha256: digest(bytes) })
    const read = await store.read('session', meta.id)
    assert.deepEqual(read, { meta, bytes })
    const result = buildUploadedPart({ name, mime, size: meta.size }, read.bytes, 'responses')
    assert.deepEqual(result.display, { name, mime, kind, size: meta.size })
  }
})

test('rejects unsafe names, path or URL metadata, unsupported types and non-byte streams before authorization', async t => {
  const { store, drafts } = await fixture(t)
  let opened = 0
  const source = { async *[Symbol.asyncIterator]() { opened++; yield Buffer.from('text') } }
  const badNames = [
    '', 'x/y.txt', 'x\\y.txt', 'C:drive.txt', '../a.txt', '..', '.', '.draft.txt', 'space.txt ', 'end.txt.',
    'LPT1.txt', 'aux .txt', 'x\u0000.txt', 'x\u0085.txt', 'x\u202E.txt', 'x\ud800.txt', 'a#b.txt',
    'a&b.txt', 'x%2f.txt', 'x\u2028.txt', `${'字'.repeat(85)}.txt`,
  ]
  for (const name of badNames) await assert.rejects(store.stage('s', { ...TEXT, name }, source), code('INVALID'), name)
  for (const suffix of ['html', 'svg', 'gif', 'zip', 'docx', 'bat', 'ps1', 'exe']) {
    await assert.rejects(store.stage('s', { ...TEXT, name: `file.${suffix}` }, source), code('UNSUPPORTED'))
  }
  for (const mime of ['image/gif', 'image/svg+xml', 'text/html', 'application/octet-stream', 'text/plain; charset=latin1']) {
    await assert.rejects(store.stage('s', { ...TEXT, mime }, source), code('UNSUPPORTED'))
  }
  for (const extra of [{ path: '/tmp/host.txt' }, { url: 'https://example.invalid/a' }, { [Symbol('extra')]: true }]) {
    await assert.rejects(store.stage('s', { ...TEXT, ...extra }, source), code('INVALID'))
  }
  await assert.rejects(store.stage('s', { ...TEXT, get size() { assert.fail('metadata accessor ran') } }, source), code('INVALID'))
  await assert.rejects(store.stage('s', { ...TEXT, name: 'fake.pdf' }, source), code('INVALID'))
  await assert.rejects(store.stage('s', TEXT, '/tmp/user.txt'), code('INVALID'))
  await assert.rejects(store.stage('s', TEXT, ['string']), code('INVALID'))
  await assert.rejects(store.stage('s', TEXT, (async function* () { yield 'not bytes' })()), code('INVALID'))
  await assert.rejects(store.stage('s', TEXT, (async function* () { yield new Uint16Array([1]) })()), code('INVALID'))
  assert.equal(opened, 0)
  assert.deepEqual(await readdir(drafts), [])
})

test('rejects fake raster/container data, oversized dimensions, and binary or broken UTF-8 text', async t => {
  const { store, drafts } = await fixture(t)
  const wide = Buffer.from(PNG)
  wide.writeUInt32BE(4097, 16)
  const cases = [
    [{ name: 'file.png', mime: 'image/png' }, JPEG], [{ name: 'file.png', mime: 'image/png' }, PNG.subarray(0, -1)],
    [{ name: 'file.png', mime: 'image/png' }, wide], [{ name: 'file.jpeg', mime: 'image/jpeg' }, JPEG.subarray(0, -4)],
    [{ name: 'file.webp', mime: 'image/webp' }, WEBP.subarray(0, -1)],
    [{ name: 'file.pdf', mime: 'application/pdf' }, Buffer.from('%PDF-1.8\n')],
    [{ name: 'file.pdf', mime: 'application/pdf' }, Buffer.from('LATE%PDF-1.7\n')],
    [{ name: 'file.pdf', mime: 'application/pdf' }, Buffer.from('%PDF-1.7')],
    [TEXT, Buffer.from([0xc3])], [TEXT, Buffer.from([0xc3, 0x28])], [TEXT, Buffer.from('text\u0000')],
    [TEXT, Buffer.from('text\u009f')], [TEXT, PDF], [TEXT, Buffer.concat([Buffer.from([239, 187, 191]), PDF])],
  ]
  for (const [meta, bytes] of cases) {
    await assert.rejects(store.stage('s', meta, stream(bytes.subarray(0, 2), bytes.subarray(2))), code('INVALID'))
  }
  await assert.rejects(store.stage('s', TEXT, stream()), code('INVALID'))
  assert.deepEqual(await readdir(drafts), [])
})

test('enforces length and MIME byte limits on declared and rolling streams', async t => {
  const { store, drafts } = await fixture(t)
  const make = size => Buffer.alloc(size, 0x41)
  await assert.rejects(store.stage('s', { ...TEXT, size: 0 }, stream('x')), code('INVALID'))
  await assert.rejects(store.stage('s', { ...TEXT, size: 1 }, stream('xy')), code('INVALID'))
  await assert.rejects(store.stage('s', { ...TEXT, size: 2 }, stream('x')), code('INVALID'))
  await assert.rejects(store.stage('s', { ...TEXT, size: 512 * 1024 + 1 }, stream()), code('TOO_LARGE'))
  await assert.rejects(store.stage('s', TEXT, stream(make(512 * 1024), 'x')), code('TOO_LARGE'))
  await assert.rejects(store.stage('s', { name: 'pixel.png', mime: 'image/png', size: 2 * 1024 * 1024 + 1 }, stream()), code('TOO_LARGE'))
  assert.deepEqual(await readdir(drafts), [])
  const text = await store.stage('s', TEXT, stream(make(512 * 1024)))
  assert.equal(text.size, 512 * 1024)
  const size = 20 * 1024 * 1024
  const pdfMeta = { name: 'file.pdf', mime: 'application/pdf' }
  const pdf = await store.stage('s', { ...pdfMeta, size }, stream(PDF, make(size - PDF.length)))
  assert.equal(pdf.size, size)
  await assert.rejects(store.stage('rolling', pdfMeta, stream(PDF, make(size - PDF.length), 'x')), code('TOO_LARGE'))
  assert.equal((await readdir(drafts)).length, 2)
})

test('declared concurrent reservations enforce per-session count and global byte budgets before opening a stream', async t => {
  const { store, drafts } = await fixture(t, { maxSessionCount: 1, maxGlobalCount: 3, maxSessionBytes: 5, maxGlobalBytes: 7 })
  const wait = blockedStream(Buffer.from('abc'))
  const a = store.stage('a', { ...TEXT, size: 5 }, wait.source)
  const failed = assert.rejects(a, code('INVALID'))
  await wait.entered.promise
  const source = { [Symbol.asyncIterator]() { assert.fail('opened a quota-rejected source') } }
  await assert.rejects(store.stage('a', { ...TEXT, size: 1 }, source), code('QUOTA'))
  await assert.rejects(store.stage('b', { ...TEXT, size: 3 }, source), code('QUOTA'))
  assert.equal((await readdir(drafts)).length, 1)
  const b = await store.stage('b', { ...TEXT, size: 2 }, stream('zz'))
  wait.resume.resolve()
  await failed
  const c = await store.stage('a', { ...TEXT, size: 5 }, stream('12345'))
  assert.equal(c.size, 5)
  assert.equal(await store.remove('a', b.id), false)
  assert.deepEqual((await store.read('b', b.id)).bytes, Buffer.from('zz'))
})

test('rolling concurrent reservations enforce same-session bytes and cross-session entry count', async t => {
  const { store, drafts } = await fixture(t, { maxSessionCount: 3, maxGlobalCount: 2, maxSessionBytes: 6, maxGlobalBytes: 12 })
  const wait = blockedStream(Buffer.from('abcd'))
  const a = store.stage('a', TEXT, wait.source)
  await wait.entered.promise
  await assert.rejects(store.stage('a', TEXT, stream('xx', 'y')), code('QUOTA'))
  assert.equal((await readdir(drafts)).length, 1)
  const b = await store.stage('b', TEXT, stream('m'))
  await assert.rejects(store.stage('c', TEXT, stream('n')), code('QUOTA'))
  wait.resume.resolve()
  const staged = await a
  const second = await store.read('b', b.id)
  assert.deepEqual(second.bytes, Buffer.from('m'))
  assert.equal(await store.remove('a', staged.id), true)
  assert.equal((await store.stage('c', TEXT, stream('n'))).size, 1)
})

test('abort and close promptly cancel blocked pulls, clear partials, and preserve successful records', { timeout: 8000 }, async t => {
  const { store, reopen, drafts } = await fixture(t, { maxGlobalCount: 2, maxGlobalBytes: 10 })
  const saved = await store.stage('keep', TEXT, stream('keep'))
  const controller = new AbortController()
  const started = defer()
  let pulls = 0
  let returned = 0
  const forever = new Promise(() => {})
  const source = {
    [Symbol.asyncIterator]() { return this },
    next() {
      if (!pulls++) return { done: false, value: Buffer.from('other') }
      started.resolve()
      return forever
    },
    return() { returned++; return forever },
  }
  const upload = store.stage('s', { ...TEXT, size: 6 }, source, { signal: controller.signal })
  const interrupted = assert.rejects(upload, { name: 'AbortError' })
  await started.promise
  controller.abort()
  await interrupted
  assert.equal(returned, 1)
  assert.deepEqual(await readdir(drafts), [`${saved.id}.draft`])
  await assert.rejects(store.stage('s', TEXT, stream('x'), { signal: controller.signal }), { name: 'AbortError' })
  const hanging = blockedStream(Buffer.from('bytes'))
  const cancelled = assert.rejects(store.stage('s', TEXT, hanging.source), code('CLOSED'))
  await hanging.entered.promise
  const closing = store.close()
  assert.equal(store.close(), closing)
  await closing
  await cancelled
  hanging.resume.resolve()
  assert.deepEqual(await readdir(drafts), [`${saved.id}.draft`])
  await assert.rejects(store.read('keep', saved.id), code('CLOSED'))
  const fresh = await reopen()
  assert.deepEqual((await fresh.read('keep', saved.id)).bytes, Buffer.from('keep'))
})

test('stream failures and staged payload corruption remove only the failed partial and restore capacity', async t => {
  const { store, drafts } = await fixture(t, { maxSessionCount: 1 })
  const unrelated = await store.stage('other', TEXT, stream('other'))
  const failure = Error('broken stream')
  async function* broken() { yield Buffer.from('abc'); throw failure }
  await assert.rejects(store.stage('s', TEXT, broken()), error => error === failure)
  const held = blockedStream(Buffer.from('123'))
  const staged = store.stage('s', TEXT, held.source)
  const failureCheck = assert.rejects(staged, code('CORRUPT'))
  await held.entered.promise
  const partial = (await readdir(drafts)).find(file => file.endsWith('.partial'))
  await flipByte(join(drafts, partial), 0, 0x41)
  held.resume.resolve()
  await failureCheck
  assert.deepEqual(await readdir(drafts), [`${unrelated.id}.draft`])
  assert.deepEqual((await store.read('other', unrelated.id)).bytes, Buffer.from('other'))
  assert.equal((await store.stage('s', TEXT, stream('yes'))).size, 3)
})

test('restart finds private drafts and quota, recovers orphan partials and only sweeps the expired scope', async t => {
  let now = 1000
  const { store, reopen, drafts, path, dataDir } = await fixture(t, { now: () => now, draftTtlMs: 50, maxGlobalBytes: 5 })
  const old = await store.stage('a', TEXT, stream('ab'))
  now = 1030
  const fresh = await store.stage('b', TEXT, stream('xyz'))
  const unrelated = join(dataDir, 'native-history')
  await writeFile(unrelated, 'xyz')
  await store.close()
  const orphan = join(drafts, `.${randomUUID()}.partial`)
  const unknown = join(drafts, 'unrecognized-file')
  await writeFile(orphan, 'left-over after crash', { mode: 0o600 })
  await writeFile(unknown, 'untouched', { mode: 0o600 })
  const second = await reopen()
  await assert.rejects(lstat(orphan), { code: 'ENOENT' })
  assert.equal(await readFile(unknown, 'utf8'), 'untouched')
  await assert.rejects(second.stage('c', TEXT, stream('y')), code('QUOTA'))
  assert.deepEqual(await second.describe('a', old.id), old)
  now = 1050
  assert.equal(await second.describe('a', old.id), null)
  await assert.rejects(second.read('a', old.id), code('NOT_FOUND'))
  await lstat(path(old.id))
  assert.equal(await second.sweep(), 1)
  assert.equal(await second.sweep(), 0)
  await assert.rejects(lstat(path(old.id)), { code: 'ENOENT' })
  assert.deepEqual((await second.read('b', fresh.id)).bytes, Buffer.from('xyz'))
  await second.close()
  now = 1080
  const third = await reopen()
  assert.equal(await third.describe('b', fresh.id), null)
  await assert.rejects(lstat(path(fresh.id)), { code: 'ENOENT' })
  assert.equal(await readFile(unrelated, 'utf8'), 'xyz')
  assert.equal(await readFile(unknown, 'utf8'), 'untouched')
})

test('a long-lived open store reclaims expired quota when staging the next draft', async t => {
  let now = 100
  const { store, path } = await fixture(t, { now: () => now, draftTtlMs: 5, maxGlobalCount: 1 })
  const a = await store.stage('a', TEXT, stream('a'))
  now = 104
  await assert.rejects(store.stage('b', TEXT, stream('b')), code('QUOTA'))
  now = 105
  const b = await store.stage('b', TEXT, stream('b'))
  await assert.rejects(lstat(path(a.id)), { code: 'ENOENT' })
  assert.deepEqual((await store.read('b', b.id)).bytes, Buffer.from('b'))
})

test('symlinks, hard links, and unsafe file modes are rejected without changing foreign bytes', async t => {
  const { store, reopen, dataDir, path } = await fixture(t)
  const a = await store.stage('a', TEXT, stream('abc'))
  const b = await store.stage('b', TEXT, stream('def'))
  const outside = join(dataDir, 'protected-native-copy')
  await writeFile(outside, 'protected', { mode: 0o600 })
  await rm(path(a.id))
  await symlink(outside, path(a.id))
  await assert.rejects(store.describe('a', a.id), code('CORRUPT'))
  await assert.rejects(store.read('a', a.id), code('CORRUPT'))
  await assert.rejects(store.remove('a', a.id), code('CORRUPT'))
  assert.equal(await store.describe('b', a.id), null)
  await rm(path(a.id))
  await link(outside, path(a.id))
  await assert.rejects(store.read('a', a.id), code('CORRUPT'))
  assert.equal((await lstat(outside)).nlink, 2)
  await chmod(path(b.id), 0o644)
  await assert.rejects(store.read('b', b.id), code('CORRUPT'))
  await chmod(path(b.id), 0o600)
  assert.deepEqual((await store.read('b', b.id)).bytes, Buffer.from('def'))
  await store.close()
  await assert.rejects(reopen(), code('CORRUPT'))
  assert.equal(await readFile(outside, 'utf8'), 'protected')
})

test('a replaced draft directory is never entered or used for cleanup', async t => {
  const { store, dataDir, drafts } = await fixture(t)
  const saved = await store.stage('a', TEXT, stream('safe'))
  const wait = blockedStream(Buffer.from('bytes'))
  const staged = store.stage('b', TEXT, wait.source)
  const rejected = assert.rejects(staged, code('CORRUPT'))
  await wait.entered.promise
  const original = join(dataDir, 'old-draft-directory')
  await rename(drafts, original)
  await mkdir(drafts, { mode: 0o700 })
  const foreignPath = join(drafts, `${saved.id}.draft`)
  await writeFile(foreignPath, 'foreign', { mode: 0o600 })
  await assert.rejects(store.read('a', saved.id), code('CORRUPT'))
  await assert.rejects(store.remove('a', saved.id), code('CORRUPT'))
  wait.resume.resolve()
  await rejected
  assert.equal(await readFile(foreignPath, 'utf8'), 'foreign')
  assert.deepEqual(await readdir(original), [`${saved.id}.draft`])
  await rm(drafts, { recursive: true })
  await rename(original, drafts)
  assert.deepEqual((await store.read('a', saved.id)).bytes, Buffer.from('safe'))
})

test('corrupted payload is blocked after restart and corrupted metadata fails index recovery', async t => {
  const { store, reopen, path } = await fixture(t)
  const a = await store.stage('a', TEXT, stream('first'))
  const b = await store.stage('b', TEXT, stream('second'))
  const keptB = await readFile(path(b.id))
  await flipByte(path(a.id), 0, 0x41)
  await assert.rejects(store.read('a', a.id), code('CORRUPT'))
  assert.deepEqual((await store.read('b', b.id)).bytes, Buffer.from('second'))
  await store.close()
  const second = await reopen()
  assert.deepEqual(await second.describe('a', a.id), a)
  await assert.rejects(second.read('a', a.id), code('CORRUPT'))
  assert.deepEqual((await second.read('b', b.id)).bytes, Buffer.from('second'))
  await second.close()
  await flipByte(path(a.id), a.size + 1, 0x5a)
  await assert.rejects(reopen(), code('CORRUPT'))
  assert.deepEqual(await readFile(path(b.id)), keptB)
})
