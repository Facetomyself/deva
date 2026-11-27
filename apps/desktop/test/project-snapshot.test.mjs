import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'
import { build } from 'vite'

const entry = fileURLToPath(new URL('../src/headless/project-snapshot.ts', import.meta.url))
const { output } = await build({ configFile: false, logLevel: 'silent', build: { ssr: entry, write: false,
  rollupOptions: { output: { format: 'es', inlineDynamicImports: true } } } })
const { validateProjectSnapshot: validate } = await import(`data:text/javascript;base64,${Buffer.from(output[0].code).toString('base64')}`)

const document = (name = 'Notes.MD', text = 'Hello') => ({ name, text })
const snapshot = (documents = [document()], project = 'Reading') => ({ version: 1, project, documents })
const json = (value = snapshot()) => Buffer.from(JSON.stringify(value))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const checked = raw => { const bytes = Buffer.from(raw); return validate(bytes, digest(bytes)) }
const invalid = (raw, codes = 'invalid_snapshot', label) => {
  assert.throws(() => checked(raw), error => [codes].flat().includes(error?.code), label)
}
const many = (n, text) => Array.from({ length: n }, (_, i) => document(`${i}.txt`, text))

test('matches the independently computed lowercase SHA-256 of the exact byte view', () => {
  const bytes = json(), expected = digest(bytes)
  const framed = Buffer.concat([Buffer.from([0xff, 0xef]), bytes, Buffer.from([0xfe])])
  assert.equal(validate(new Uint8Array(framed.buffer, framed.byteOffset + 2, bytes.length), expected).project, 'Reading')
  for (const malformed of [undefined, null, 1, '', expected.toUpperCase(), ` ${expected}`, `${expected}\n`, expected.slice(1), 'g'.repeat(64)]) {
    assert.throws(() => validate(bytes, malformed), { code: 'invalid_digest' })
  }
  for (const changed of [Buffer.concat([bytes, Buffer.from('\n')]), json(snapshot([document('Notes.MD', 'Hallo')]))]) {
    assert.throws(() => validate(changed, expected), { code: 'digest_mismatch' })
  }
})

test('preserves Unicode, BOM, CRLF and inert Markdown/JSON; freezes the whole result', () => {
  const name = 'Cafe\u0301.MD', project = '研修 😀'
  const text = '\uFEFF笔记\r\n```json\r\n{"name":"other.md","text":"/etc/example"}\r\n```\r\n\t[link](https://example.invalid/notes) 😀'
  const wire = `\t\r\n{ "documents" : [{"t\\u0065xt":${JSON.stringify(text).replace('😀', '\\uD83D\\uDE00')},"name":${JSON.stringify(name)}}],"project":${JSON.stringify(project)},"vers\\u0069on":1 }\r\n`
  const bytes = new Uint8Array(Buffer.from(wire)), result = validate(bytes, digest(bytes))
  const expected = { version: 1, project, documents: [{ name, text, bytes: Buffer.byteLength(text) }], totalTextBytes: Buffer.byteLength(text) }
  bytes.fill(0)
  assert.deepEqual(result, expected)
  for (const object of [result, result.documents, result.documents[0]]) assert.ok(Object.isFrozen(object))
  assert.throws(() => { result.project = 'Changed' }, TypeError)
  assert.throws(() => { result.documents[0].text = 'Changed' }, TypeError)
  assert.throws(() => { result.documents.push(document()) }, TypeError)
})

test('rejects malformed UTF-8, a file BOM, and non-JSON whitespace', () => {
  const wire = json()
  invalid(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), wire]), 'invalid_snapshot', 'initial BOM')
  invalid(`\u00a0${wire}`)
  invalid(`${wire}\v`)
  for (const raw of [[0xc3, 0x28], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf0, 0x9f, 0x92]]) {
    invalid(Buffer.concat([Buffer.from('{"version":1,"project":"x","documents":[{"name":"a.txt","text":"'),
      Buffer.from(raw), Buffer.from('"}]}')]), 'invalid_snapshot', `bad UTF-8 ${raw}`)
  }
})

test('requires exact shapes, unambiguous keys and the raw JSON number token 1', () => {
  const tail = '"project":"P","documents":[{"name":"a.txt","text":"x"}]'
  for (const token of ['false', '"1"', '0', '2', '-1', '+1', '01', '1.0', '1e0', '1E+0', '1.0000000000000001', '0.99999999999999999']) {
    invalid(`{"version":${token},${tail}}`, 'invalid_snapshot', token)
  }
  for (const raw of [
    'null', '[]', '{}', '{"version":1,"project":"P","documents":null}', `{"version":1,${tail},}`,
    `{"version":1,${tail},"grants":[]}`, `{"version":1,${tail},"path":"/project"}`, `{"version":1,${tail},"url":"https://example.invalid"}`,
    `{"version":1,"version":1,${tail}}`, `{"version":1,"vers\\u0069on":1,${tail}}`, `{"version":1,${tail},"pr\\u006fject":"P"}`,
    `{"version":1,${tail}}{}`, '{"project":"P","documents":[]}', '{"version":1,"documents":[]}',
    `{"version":1,"project":"P","documents":[${'['.repeat(10000)}0${']'.repeat(10000)}]}`,
    ...[null, [], { name: 'a.txt' }, { text: 'x' }, { name: 'a.txt', text: 'x', grant: {} }].map(doc => json(snapshot([doc]))),
    ...['"name":"a.txt","name":"a.txt","text":"x"', '"name":"a.txt","n\\u0061me":"a.txt","text":"x"',
      '"name":"a.txt","text":"x","te\\u0078t":"x"'].map(doc => `{"version":1,"project":"P","documents":[{${doc}}]}`),
  ]) invalid(raw, 'invalid_snapshot', String(raw))
})

test('enforces project, #21 document-name, text and normalized duplicate-name rules', () => {
  for (const project of [null, 1, '', ' ', ' P', 'P ', '.', '..', 'a/b', 'a\\b', 'p:q', 'a\nb', 'a\rb', 'a\tb', 'a\0b', 'a\u0085b', 'a\u2028b', 'a\u202eb', 'x\ud800']) {
    invalid(json(snapshot([document()], project)), 'invalid_snapshot', JSON.stringify(project))
  }
  for (const name of [1, '', ' .md', '.hidden.md', 'a.md ', 'a.pdf', 'dir/a.md', 'dir\\a.txt', 'a:b.md', 'a?.md', 'a\0b.md', 'a\u2066b.md', 'a\udfff.md']) {
    invalid(json(snapshot([document(name)])), 'invalid_snapshot', JSON.stringify(name))
  }
  for (const text of [null, 1, {}, '', 'a\0b', 'a\u000bb', 'a\u007fb', 'a\u009fb', 'a\ud800b', 'a\udfffb']) {
    invalid(json(snapshot([document('a.txt', text)])), 'invalid_snapshot', JSON.stringify(text))
  }
  for (const names of [['a.txt', 'a.txt'], ['Notes.MD', 'notes.md'], ['Café.md', 'CAFE\u0301.MD']]) {
    invalid(json(snapshot(names.map(name => document(name)))), 'invalid_snapshot', names.join(', '))
  }
  const names = ['Alpha.md', 'Beta.md']
  assert.deepEqual(checked(json(snapshot(names.map(name => document(name, ' '))))).documents.map(doc => doc.name), names)
  assert.equal(checked(json(snapshot([document()], '书'))).project, '书')
})

test('counts exact and +1 boundaries in UTF-8 bytes, including raw JSON whitespace', () => {
  const name = 'é'.repeat(62) + '.txt', project = '书'.repeat(26) + 'ab', text = 'é'.repeat(16 * 1024)
  const stringSizeCode = ['invalid_snapshot', 'snapshot_limit']
  assert.equal(checked(json(snapshot([document(name)], project))).documents[0].name, name)
  assert.equal(checked(json(snapshot([document(name)], project))).project, project)
  invalid(json(snapshot([document(`x${name}`)])), stringSizeCode, '129-byte name')
  invalid(json(snapshot([document()], `${project}x`)), stringSizeCode, '81-byte project')
  invalid(json(snapshot([])), 'invalid_snapshot', '0 documents')
  assert.equal(checked(json()).documents.length, 1)
  assert.equal(checked(json(snapshot(many(32)))).documents.length, 32)
  invalid(json(snapshot(many(33))), 'snapshot_limit', '33 documents')
  assert.equal(checked(json(snapshot([document('a.txt', text)]))).documents[0].bytes, 32 * 1024)
  invalid(json(snapshot([document('a.txt', `${text}x`)])), 'snapshot_limit', '32 KiB + 1 text')
  assert.equal(checked(json(snapshot(many(8, text)))).totalTextBytes, 256 * 1024)
  invalid(json(snapshot([...many(8, text), document('extra.txt', 'x')])), 'snapshot_limit', '256 KiB + 1 aggregate')
  const raw = Buffer.alloc(2 * 1024 * 1024 + 1, 0x20)
  json().copy(raw)
  assert.equal(checked(raw.subarray(0, -1)).project, 'Reading')
  invalid(raw, 'snapshot_limit', '2 MiB + 1 raw')
})

test('rejects SharedArrayBuffer views when available and exposes only opaque late errors', () => {
  if (typeof SharedArrayBuffer === 'function') {
    const bytes = json(), view = new Uint8Array(new SharedArrayBuffer(bytes.length + 2), 1, bytes.length)
    view.set(bytes)
    assert.throws(() => validate(view, digest(bytes)), { code: 'invalid_snapshot' })
  }
  const first = document('opaque-first.md', 'opaque first document'), last = document('../opaque-last.md', 'opaque last document')
  const raw = json(snapshot([first, { ...last, path: '/opaque/path/project' }])), received = digest(raw), expected = 'f'.repeat(64)
  for (const [hash, code] of [[received, 'invalid_snapshot'], [expected, 'digest_mismatch']]) {
    assert.throws(() => validate(raw, hash), error => {
      assert.equal(error.code, code)
      const visible = inspect(error, { showHidden: true, customInspect: false })
      for (const value of [first.name, first.text, last.name, last.text, '/opaque/path/project', expected, received]) {
        assert.ok(!visible.includes(value), `error leaks ${value}`)
      }
      return true
    })
  }
})
