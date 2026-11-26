import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync,
  symlinkSync, writeFileSync
} from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Use the existing Vite dependency. No aliases, externals, environment overrides or Electron shims.
const requireDesktop = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = createRequire(requireDesktop.resolve('vite/package.json'))('esbuild')
const entry = 'apps/desktop/src/main/services/chat-store-core.ts'
const { metafile, outputFiles } = await build({
  absWorkingDir: fileURLToPath(new URL('../../../', import.meta.url)),
  entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', target: 'node20', metafile: true, write: false
})
const api = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`)
const { createChatStore, isValidSessionId } = api

const msg = (role, content) => ({ role, content })
const user = (content) => msg('user', content)
const reply = (content) => msg('assistant', content)
const summary = (letter) => user(`⟦deva:compaction⟧ ${letter}`)
const json = (path) => JSON.parse(readFileSync(path, 'utf8'))
const ls = (path) => readdirSync(path).sort()
const jsonl = (messages) => messages.map((m) => `${JSON.stringify(m)}\n`).join('')
const meta = (id, updatedAt = 2) => ({ id, title: id, createdAt: 1, updatedAt })
const binary = (type, mediaType, value, name) => ({ type, mediaType, data: Buffer.from(value).toString('base64'), ...(name && { name }) })
const hash = (part) => createHash('sha256').update(part.data).digest('hex')

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'deva-chat-store-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const chats = join(home, 'data', 'chats')
  return {
    home, chats, index: join(chats, '_index.json'), pending: join(chats, '_index.pending'), media: join(home, 'data', 'media'),
    path: (id) => join(chats, `${id}.json`),
    open: (options = {}) => createChatStore({ dataDir: home, onWarning() {}, ...options })
  }
}

function writeFixture(path, value) {
  writeFileSync(path, JSON.stringify(value), { flag: 'wx' })
}

test('independent Node bundle has only Node builtin imports and one shared compaction/media implementation', () => {
  const [output] = Object.values(metafile.outputs)
  assert.equal(output.entryPoint, entry)
  assert.deepEqual(Object.keys(metafile.inputs).sort(), [entry,
    'apps/desktop/src/main/services/media-store-core.ts',
    'apps/desktop/src/main/services/model-view.ts'
  ])
  assert.ok(output.imports.length > 0)
  assert.ok(output.imports.every(({ path, external }) => external && isBuiltin(path)))
})

test('reads desktop JSON, JSONL, attachment refs, inline data and sidecars; saves/restarts in the same format', (t) => {
  const f = fixture(t)
  mkdirSync(f.chats, { recursive: true })
  mkdirSync(f.media)
  const image = binary('image', 'image/png', 'legacy image')
  const pdf = binary('document', 'application/pdf', 'legacy PDF', 'example.pdf')
  const ref = { type: image.type, mediaType: image.mediaType, blob: hash(image) }
  writeFileSync(join(f.media, ref.blob), Buffer.from(image.data, 'base64'))
  const id = 'desktop_01'
  const compacted = { file: `${id}.compacted-m0k68loegqrs.jsonl`, count: 2 }
  const older = [user([ref]), reply('旧回复')]
  // A main JSON that only committed two lines ignores any uncommitted third line.
  writeFileSync(join(f.chats, compacted.file), jsonl(older) + 'partial third line')
  const notices = [{ after: 4, kind: 'notice', code: 'aborted' }]
  const record = { ...meta(id), bucket: 'old bucket', personaId: 'persona', model: 'local:model', effort: 'high',
    compacted, notices, asks: { tool: { answers: ['yes'] } }, messages: [summary('old'), user([pdf])] }
  writeFixture(f.path(id), record)
  writeFixture(f.index, [{ ...meta(id), personaId: record.personaId, model: record.model }])
  const store = f.open()
  assert.deepEqual(store.listSessions().map(({ id, focusRoot }) => [id, focusRoot]), [[id, null]])
  const s = store.getSession(id)
  assert.deepEqual(s.messages, [user([image]), older[1], ...record.messages])
  assert.deepEqual(s.asks, record.asks)
  assert.deepEqual(s.notices, notices)
  assert.equal(store.ensureSession(id, { personaId: 'ignored', focusRoot: '/work', model: '' }), s)
  assert.equal(s.personaId, 'persona')
  assert.equal(s.model, '')
  s.messages.push(reply('new reply'))
  store.saveStrict(id)
  const disk = json(f.path(id))
  assert.equal(disk.compacted.count, 2)
  assert.notEqual(disk.compacted.file, compacted.file, 'interrupted append tail is replaced safely')
  assert.equal(disk.messages[1].content[0].blob, hash(pdf))
  assert.deepEqual(readFileSync(join(f.media, hash(pdf))), Buffer.from(pdf.data, 'base64'))
  assert.equal(existsSync(join(f.chats, compacted.file)), false)
  const restarted = f.open().getSession(id)
  assert.deepEqual(restarted.messages, s.messages)
  assert.equal(restarted.focusRoot, '/work')
  assert.deepEqual(restarted.notices, notices)
})

test('explicit roots isolate session, index, prefix and attachment caches; archive preserves order', (t) => {
  const a = fixture(t), b = fixture(t)
  const left = a.open(), right = b.open()
  const sameAttachmentObject = user([binary('image', 'image/png', 'shared payload')])
  const waiting = left.ensureSession('draft')
  waiting.updatedAt = 999
  assert.equal(left.setSessionArchived('draft', true), false)
  assert.deepEqual(left.listSessions(), [])
  assert.equal(existsSync(a.chats), false)
  for (const [i, store] of [left, right].entries()) {
    const s = store.ensureSession('same')
    s.title = `root ${i}`
    s.updatedAt = 10
    s.messages.push(sameAttachmentObject, reply('旧'), summary('current'), user(`from ${i}`))
    store.saveStrict('same')
  }
  left.ensureSession('newer').updatedAt = 40
  left.save('newer')
  assert.deepEqual(left.listSessions().map(({ id }) => id), ['newer', 'same'])
  assert.equal(left.setSessionArchived('same', true), true)
  assert.equal(left.setSessionArchived('same', true), true)
  assert.equal(left.listSessions()[1].updatedAt, 10)
  assert.equal(a.open().getSession('same').archived, true)
  assert.equal(left.setSessionArchivedStrict('same', false), true)
  assert.equal(a.open().getSession('same').archived, undefined)
  assert.equal(right.getSession('same').archived, undefined)
  assert.equal(b.open().getSession('same').title, 'root 1')
  assert.deepEqual(right.listSessions().map(({ id }) => id), ['same'])
  assert.deepEqual(json(a.index).map(({ id }) => id).sort(), ['newer', 'same'])
  assert.equal(a.open().getSession('draft'), undefined)
  for (const [i, f] of [a, b].entries()) {
    assert.deepEqual(f.open().getSession('same').messages, [sameAttachmentObject, reply('旧'), summary('current'), user(`from ${i}`)])
    assert.deepEqual(ls(f.media), [hash(sameAttachmentObject.content[0])])
  }
})

test('rejects ambiguous IDs before I/O, and missing sessions do not write or clean unrelated sidecars', (t) => {
  const f = fixture(t)
  const cleanup = []
  const store = f.open({ removeToolResults: (id) => cleanup.push(id) })
  for (const id of ['', ' abc', 'abc ', 'a\nb', 'abc\n', '../abc', 'x/y', 'x\\y', 'x%2Fy', '_index', '_INDEX', 'CON', '.', 'é', 'a'.repeat(201), null, 12]) {
    assert.equal(isValidSessionId(id), false, JSON.stringify(id))
    for (const run of [store.getSession, store.ensureSession, store.save, store.saveStrict, store.setSessionArchived, store.deleteSession]) {
      assert.throws(() => run(id, true), /Invalid chat session ID/)
    }
  }
  assert.equal(isValidSessionId('2abC_a-1'), true)
  assert.equal(store.getSession('missing'), undefined)
  assert.equal(store.setSessionArchived('missing', true), false)
  assert.throws(() => store.saveStrict('missing'), /does not exist/)
  store.save('missing')
  store.deleteSession('missing')
  assert.deepEqual(cleanup, [])
  assert.equal(existsSync(f.chats), false)
  mkdirSync(f.chats, { recursive: true })
  const orphan = join(f.chats, 'missing.compacted-orphan.jsonl')
  writeFileSync(orphan, 'orphan')
  store.deleteSession('missing')
  assert.equal(existsSync(orphan), true)
  store.ensureSession('real')
  store.saveStrict('real')
  store.deleteSession('real')
  assert.deepEqual(cleanup, ['real'])
  assert.deepEqual(f.open().listSessions(), [])
  assert.equal(existsSync(f.path('real')), false)
  assert.equal(existsSync(orphan), true)
})

test('repairs missing/stale/damaged indexes from canonical main files and preserves corrupt inputs', (t) => {
  const f = fixture(t)
  mkdirSync(f.chats, { recursive: true })
  writeFixture(f.path('long'), { ...meta('long', 55), messages: [user('one')] })
  writeFixture(f.path('short'), { ...meta('short', 5), messages: [] })
  writeFixture(f.path('mismatch'), { ...meta('lies'), messages: [] })
  writeFixture(f.path('malformed'), { ...meta('malformed'), messages: [null] })
  writeFileSync(f.path('broken'), '{broken')
  for (const badIndex of [undefined, '{broken', JSON.stringify([meta('_INDEX'), meta('ghost'), meta('long')]),
    JSON.stringify([meta('long', -2), meta('ghost')])]) {
    if (badIndex !== undefined) writeFileSync(f.index, badIndex)
    const store = f.open()
    assert.deepEqual(store.listSessions().map(({ id }) => id), ['long', 'short'])
    assert.deepEqual(json(f.index).map(({ id }) => id).sort(), ['long', 'short'])
    for (const id of ['broken', 'malformed', 'mismatch']) {
      assert.equal(store.getSession(id), undefined)
      assert.throws(() => store.ensureSession(id))
      assert.throws(() => store.setSessionArchived(id, true))
    }
    assert.equal(readFileSync(f.path('broken'), 'utf8'), '{broken')
  }
})

test('untrusted compacted metadata stays within the current SID; bad history keeps the live suffix', (t) => {
  const f = fixture(t)
  mkdirSync(f.chats, { recursive: true })
  const secret = jsonl([user('other data')])
  const outside = join(f.home, 'outside.jsonl')
  writeFileSync(outside, secret)
  writeFileSync(join(f.chats, 'other.compacted-real.jsonl'), secret)
  symlinkSync(outside, join(f.chats, 'c4.compacted-symlink.jsonl'))
  linkSync(outside, join(f.chats, 'c5.compacted-hardlink.jsonl'))
  writeFileSync(join(f.chats, 'c6.compacted-broken.jsonl'), '{non-json}\n')
  writeFileSync(join(f.chats, 'c7.compacted-short.jsonl'), '')
  const paths = ['other.compacted-real.jsonl', outside, '../../outside.jsonl', 'c3.compacted-..\\outside.jsonl',
    'c4.compacted-symlink.jsonl', 'c5.compacted-hardlink.jsonl', 'c6.compacted-broken.jsonl', 'c7.compacted-short.jsonl']
  const warnings = []
  const store = f.open({ onWarning: (text) => warnings.push(text) })
  paths.forEach((file, i) => {
    const id = `c${i}`
    const keep = user('live')
    const notice = { after: 2, kind: 'notice', code: 'empty' }
    writeFixture(f.path(id), { ...meta(id), compacted: { file, count: 1 }, messages: [keep],
      notices: [{ ...notice, after: 0 }, notice] })
    const s = store.getSession(id)
    assert.deepEqual(s.messages, [keep], file)
    assert.deepEqual(s.notices, [{ ...notice, after: 1 }])
    assert.equal(s.compacted, undefined)
  })
  assert.equal(warnings.length, paths.length)
  assert.equal(readFileSync(outside, 'utf8'), secret)
  assert.equal(readFileSync(join(f.chats, 'other.compacted-real.jsonl'), 'utf8'), secret)
  assert.equal(existsSync(join(f.chats, 'c6.compacted-broken.jsonl')), true, 'broken history is retained for recovery')
  assert.equal(existsSync(f.index), false)
})

test('appends stable history, rewrites modified prefixes, and never commits new JSONL rows before main JSON', (t) => {
  const f = fixture(t)
  let failMain = false
  const store = f.open({ media: {
    hydrateMessages() {}, mediaReplacer(key, value) {
      if (failMain && key === '' && value.id === 'ordered') throw Error('injected main write failure')
      return value
    }
  } })
  const session = store.ensureSession('ordered')
  session.messages.push(user('较早'), reply('old'), summary('a'), user('current'))
  store.saveStrict(session.id)
  const firstFile = session.compacted.file
  const firstPath = join(f.chats, firstFile)
  session.messages.push(reply('another'), summary('b'), user('newer'))
  store.saveStrict(session.id)
  assert.equal(session.compacted.file, firstFile)
  assert.equal(session.compacted.count, 5)
  assert.equal(readFileSync(firstPath, 'utf8'), jsonl(session.messages.slice(0, 5)))
  const committed = structuredClone(session.messages)
  session.messages.push(reply('tail'), summary('c'), user('newest'))
  failMain = true
  assert.throws(() => store.saveStrict(session.id), /injected main write failure/)
  assert.equal(session.compacted.count, 5)
  assert.equal(json(f.path(session.id)).compacted.count, 5)
  assert.equal(readFileSync(firstPath, 'utf8'), jsonl(session.messages.slice(0, 8)))
  assert.deepEqual(f.open().getSession(session.id).messages, committed)
  failMain = false
  store.saveStrict(session.id)
  const retriedFile = session.compacted.file
  assert.notEqual(retriedFile, firstFile)
  assert.equal(existsSync(firstPath), false)
  assert.equal(readFileSync(join(f.chats, retriedFile), 'utf8'), jsonl(session.messages.slice(0, 8)))
  assert.deepEqual(f.open().getSession(session.id).messages, session.messages)
  session.messages[0] = user('edited prefix')
  store.saveStrict(session.id)
  assert.notEqual(session.compacted.file, retriedFile)
  assert.equal(existsSync(join(f.chats, retriedFile)), false)
  assert.deepEqual(f.open().getSession(session.id).messages, session.messages)
  session.messages = [user('roll back to pre-compaction'), reply('okay')]
  store.saveStrict(session.id)
  assert.equal(session.compacted, undefined)
  assert.deepEqual(ls(f.chats), ['_index.json', 'ordered.json'])
})

test('strict writes surface primary/index failures; index failure after commit is repaired on restart and retry', (t) => {
  const f = fixture(t)
  const store = f.open()
  const s = store.ensureSession('strict')
  mkdirSync(f.path(s.id), { recursive: true })
  assert.throws(() => store.saveStrict(s.id), { code: 'EISDIR' })
  assert.doesNotThrow(() => store.save(s.id))
  assert.deepEqual(store.listSessions(), [])
  assert.equal(store.setSessionArchived(s.id, true), false)
  rmdirSync(f.path(s.id))
  store.saveStrict(s.id)
  assert.equal(existsSync(f.pending), false)

  const backup = join(f.home, 'old-index.json')
  renameSync(f.index, backup)
  mkdirSync(f.index)
  assert.throws(() => store.setSessionArchived(s.id, true), { code: 'EISDIR' })
  assert.equal(json(f.path(s.id)).archived, true)
  assert.equal(existsSync(f.pending), true)
  assert.throws(() => store.setSessionArchived(s.id, true), { code: 'EISDIR' })
  rmdirSync(f.index)
  renameSync(backup, f.index)
  assert.equal(json(f.index)[0].archived, undefined, 'simulate old index still present on restart')
  assert.equal(f.open().listSessions()[0].archived, true)
  assert.equal(existsSync(f.pending), false)
  assert.equal(store.setSessionArchived(s.id, true), true)
  assert.equal(json(f.index)[0].archived, true)

  let failArchive = false
  const other = f.open({ media: {
    hydrateMessages() {}, mediaReplacer(key, value) {
      if (failArchive && key === '' && value.id === s.id) throw Error('simulated archive main failure')
      return value
    }
  } })
  const cached = other.getSession(s.id)
  failArchive = true
  assert.throws(() => other.setSessionArchived(s.id, false), /simulated archive main failure/)
  assert.equal(cached.archived, true)
  assert.equal(json(f.path(s.id)).archived, true)
})
