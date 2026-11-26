import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import test from 'node:test'
import { deflateSync } from 'node:zlib'
import { createGitObjectReader } from '../src/git/objects.mjs'

const MiB = 1024 * 1024
const sha1 = bytes => createHash('sha1').update(bytes).digest()
const oidForBlob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
const loosePath = oid => `objects/${oid.slice(0, 2)}/${oid.slice(2)}`
const errorCode = code => error => error.code === code && error.message === code

function repo(t) {
  const tmp = resolve(tmpdir())
  const root = mkdtempSync(join(tmp, 'deva-git-objects-'))
  t.after(() => {
    assert.equal(dirname(root), tmp)
    assert.match(basename(root), /^deva-git-objects-/)
    rmSync(root, { recursive: true, force: true })
  })
  const metadata = join(root, '.git')
  const env = {
    PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Local QA', GIT_AUTHOR_EMAIL: 'qa@example.test',
    GIT_COMMITTER_NAME: 'Local QA', GIT_COMMITTER_EMAIL: 'qa@example.test',
    GIT_AUTHOR_DATE: '2025-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2025-01-01T00:00:00Z', LC_ALL: 'C'
  }
  const git = (args, input) => execFileSync('/usr/bin/git', ['-c', 'gc.auto=0', ...args], {
    cwd: root, env, input, maxBuffer: 8 * MiB, stdio: ['pipe', 'pipe', 'pipe']
  })
  git(['init', '--quiet', '--template=', '--object-format=sha1', '-b', 'main'])
  const text = (...args) => git(args).toString('utf8').trim()
  const readMeta = (rel, maxBytes) => {
    assert.match(rel, /^objects\/(?:[0-9a-f]{2}\/[0-9a-f]{38}|pack\/pack-[0-9a-f]{40}\.(?:idx|pack))$/)
    const path = join(metadata, rel)
    try {
      if (statSync(path).size > maxBytes) throw Object.assign(Error(path), { code: 'git_limit' })
      return readFileSync(path)
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }
  const listMeta = (rel, maxEntries) => {
    assert.equal(rel, 'objects/pack')
    const path = join(metadata, rel)
    try {
      const entries = readdirSync(path, { withFileTypes: true })
      if (entries.length > maxEntries) throw Object.assign(Error(path), { code: 'git_limit' })
      return entries.map(e => ({ name: e.name, type: e.isFile() ? 'file' : 'other' }))
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
  }
  return { root, metadata, git, text, io: { readMeta, listMeta } }
}

function relatedObjects(repository) {
  const { root, text } = repository
  const lines = Array.from({ length: 900 }, (_, i) => `Topic ${i}: ${sha1(Buffer.from(`ordinary record ${i}`)).toString('hex')}`)
  const records = []
  writeFileSync(join(root, 'empty.txt'), '')
  for (let i = 0; i < 10; i++) {
    lines[i * 73] = `Amended record ${i}: an ordinary local edit.`
    writeFileSync(join(root, 'notes.txt'), `${lines.join('\n')}\n`)
    text('add', '--', 'notes.txt', 'empty.txt')
    text('commit', '--quiet', '-m', `Revise notes ${i}`)
    records.push({ oid: text('rev-parse', 'HEAD'), type: 'commit' })
    records.push({ oid: text('rev-parse', 'HEAD^{tree}'), type: 'tree' })
    records.push({ oid: text('rev-parse', 'HEAD:notes.txt'), type: 'blob' })
  }
  text('tag', '-a', 'revision', '-m', 'Annotated local release')
  records.push({ oid: text('rev-parse', 'refs/tags/revision'), type: 'tag' })
  records.push({ oid: text('rev-parse', 'HEAD:empty.txt'), type: 'blob' })
  return records
}

function compareObjects(repository, records, reader) {
  for (const { oid, type } of records) {
    assert.equal(repository.text('cat-file', '-t', oid), type)
    assert.deepEqual(reader.get(oid), { type, bytes: repository.git(['cat-file', type, oid]) })
  }
}

function packEntries(repository, records, useOffsetDeltas) {
  repository.text('-c', `repack.useDeltaBaseOffset=${useOffsetDeltas}`, 'repack', '-adf', '--depth=50', '--window=20')
  const list = repository.io.listMeta('objects/pack', 128)
  const idx = list.find(({ name }) => name.endsWith('.idx')).name
  const packName = idx.replace(/\.idx$/, '.pack')
  const packBytes = repository.io.readMeta(`objects/pack/${packName}`, 24 * MiB)
  const report = repository.text('verify-pack', '-v', join(repository.metadata, 'objects', 'pack', idx))
  const deltas = report.split('\n').map(line => line.trim().split(/\s+/)).filter(parts => parts.length === 7 && parts[1] === 'blob')
  assert.ok(deltas.length >= 5, 'the fixture must contain real blob deltas')
  for (const [oid, , , , offset] of deltas) {
    assert.ok(records.some(record => record.oid === oid))
    assert.equal((packBytes[Number(offset)] >>> 4) & 7, useOffsetDeltas ? 6 : 7)
  }
  for (const { oid } of records) assert.equal(repository.io.readMeta(loosePath(oid), 4 * MiB), null)
  return { idx: `objects/pack/${idx}`, pack: `objects/pack/${packName}` }
}

test('loose SHA‑1 commits, trees, blobs and tags agree byte for byte with cat-file', t => {
  const repository = repo(t)
  const records = relatedObjects(repository)
  const reader = createGitObjectReader({ ...repository.io, listMeta() { throw Error('unexpected pack lookup') } })
  compareObjects(repository, records, reader)
  const [record] = records
  reader.get(record.oid).bytes.fill(0)
  compareObjects(repository, [record], reader)
})

for (const useOffsetDeltas of [true, false]) {
  test(`Git repack ${useOffsetDeltas ? 'OFS_DELTA' : 'REF_DELTA'} objects agree byte for byte with cat-file`, t => {
    const repository = repo(t)
    const records = relatedObjects(repository)
    packEntries(repository, records, useOffsetDeltas)
    let listed = 0
    const io = { ...repository.io, listMeta(...args) { listed++; return repository.io.listMeta(...args) } }
    const reader = createGitObjectReader(io)
    compareObjects(repository, records, reader)
    const [record] = records
    reader.get(record.oid).bytes.fill(0)
    compareObjects(repository, [record], reader)
    assert.throws(() => reader.get('0'.repeat(40)), errorCode('git_object_unavailable'))
    assert.equal(listed, 1)
  })
}

test('over-limit and malformed loose streams fail closed through the bounded IO interface', t => {
  const repository = repo(t)
  const oversized = repository.git(['hash-object', '-w', '--stdin'], Buffer.alloc(2 * MiB + 1, 0x78)).toString().trim()
  assert.throws(() => createGitObjectReader(repository.io).get(oversized), errorCode('git_limit'))

  const body = Buffer.from('ordinary')
  const oid = oidForBlob(body)
  const valid = deflateSync(Buffer.concat([Buffer.from('blob 8\0'), body]))
  for (const encoded of [
    valid.subarray(0, -2), Buffer.concat([valid, Buffer.from('trailing')]), Buffer.concat([valid, valid]),
    deflateSync(Buffer.from('blob 7\0ordinary')), deflateSync(Buffer.from('blob 08\0ordinary')),
    deflateSync(Buffer.from('blob 8\0Ordinary')), deflateSync(Buffer.from('item 8\0ordinary'))
  ]) {
    const io = { readMeta(rel) { assert.equal(rel, loosePath(oid)); return encoded }, listMeta() { return [] } }
    assert.throws(() => createGitObjectReader(io).get(oid), errorCode('git_corrupt'))
  }
  const lookup = createGitObjectReader({ readMeta() { throw Error('/workspace/private/path') }, listMeta() { return [] } })
  assert.throws(() => lookup.get(oid), errorCode('git_object_unavailable'))
  for (const code of ['git_stale', 'git_unsafe']) {
    const io = { readMeta() { throw Object.assign(Error('/workspace/private/path'), { code }) } }
    assert.throws(() => createGitObjectReader(io).get(oid), errorCode(code))
  }
  assert.throws(() => lookup.get(`${oid}\n`), errorCode('git_corrupt'))
  assert.throws(() => lookup.get('../objects/pack'), errorCode('git_corrupt'))
  assert.throws(() => lookup.get(oid.toUpperCase()), errorCode('git_corrupt'))
})

test('repeated reads charge one reader-wide byte budget', t => {
  t.mock.method(performance, 'now', () => 0)
  const body = Buffer.alloc(2 * MiB, 0x78)
  const oid = oidForBlob(body)
  const data = deflateSync(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body]))
  const reader = createGitObjectReader({ readMeta: () => data, listMeta: () => [] })
  for (let i = 0; i < 31; i++) assert.equal(reader.get(oid).bytes.length, body.length)
  assert.throws(() => reader.get(oid), errorCode('git_limit'))
})

test('the cooperative deadline accumulates active time and excludes idle time', t => {
  let clock = 0, reads = 0
  t.mock.method(performance, 'now', () => clock)
  const body = Buffer.from('ordinary')
  const oid = oidForBlob(body)
  const data = deflateSync(Buffer.concat([Buffer.from('blob 8\0'), body]))
  const reader = createGitObjectReader({ readMeta() { reads++; clock += 450; return data } })
  assert.deepEqual(reader.get(oid).bytes, body)
  clock += 5000
  assert.deepEqual(reader.get(oid).bytes, body)
  assert.throws(() => reader.get(oid), errorCode('git_limit'))
  assert.throws(() => reader.get(oid), errorCode('git_limit'))
  assert.equal(reads, 3)
})

test('packed file checksums, count, fanout, offsets and paired files are enforced', t => {
  const repository = repo(t)
  const records = relatedObjects(repository)
  const filenames = packEntries(repository, records, true)
  const [{ oid }] = records
  const mutate = (which, change, code = 'git_corrupt') => {
    const io = { ...repository.io, readMeta(rel, cap) {
      const bytes = repository.io.readMeta(rel, cap)
      if (rel === filenames[which]) change(bytes)
      return bytes
    } }
    assert.throws(() => createGitObjectReader(io).get(oid), errorCode(code))
  }
  const patchIdx = change => mutate('idx', bytes => {
    change(bytes)
    sha1(bytes.subarray(0, -20)).copy(bytes, bytes.length - 20)
  })
  mutate('idx', bytes => { bytes[bytes.length - 1] ^= 1 })
  mutate('pack', bytes => { bytes[bytes.length - 1] ^= 1 })
  mutate('pack', bytes => bytes.writeUInt32BE(bytes.readUInt32BE(8) + 1, 8))
  patchIdx(bytes => bytes.writeUInt32BE(bytes.readUInt32BE(8 + 255 * 4) + 1, 8))
  patchIdx(bytes => {
    const n = bytes.readUInt32BE(8 + 255 * 4)
    bytes.writeUInt32BE(9, 8 + 256 * 4 + 24 * n)
  })
  patchIdx(bytes => {
    const n = bytes.readUInt32BE(8 + 255 * 4)
    const offsetTable = 8 + 256 * 4 + 24 * n
    bytes.writeUInt32BE(bytes.readUInt32BE(offsetTable + 4), offsetTable)
  })
  patchIdx(bytes => { bytes[8 + 256 * 4 + 20 * bytes.readUInt32BE(8 + 255 * 4)] ^= 1 })
  const io = { ...repository.io, listMeta(...args) { return repository.io.listMeta(...args).filter(e => e.name.endsWith('.idx')) } }
  assert.throws(() => createGitObjectReader(io).get(oid), errorCode('git_corrupt'))
})

test('ordinary Git packed blobs at and beyond the object limit', t => {
  const repository = repo(t)
  writeFileSync(join(repository.root, 'at-limit.txt'), Buffer.alloc(2 * MiB, 0x61))
  writeFileSync(join(repository.root, 'over-limit.txt'), Buffer.alloc(2 * MiB + 1, 0x62))
  repository.text('add', '--', 'at-limit.txt', 'over-limit.txt')
  repository.text('commit', '--quiet', '-m', 'Large ordinary text')
  const atLimit = repository.text('rev-parse', 'HEAD:at-limit.txt')
  const overLimit = repository.text('rev-parse', 'HEAD:over-limit.txt')
  const head = repository.text('rev-parse', 'HEAD')
  repository.text('repack', '-adf', '--window=0')
  for (const oid of [head, atLimit, overLimit]) assert.equal(repository.io.readMeta(loosePath(oid), 4 * MiB), null)
  const reader = createGitObjectReader(repository.io)
  compareObjects(repository, [{ oid: head, type: 'commit' }, { oid: atLimit, type: 'blob' }], reader)
  assert.throws(() => reader.get(overLimit), errorCode('git_limit'))
})

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

test('PACK v3 uses normal entry framing; generic padding after a zlib stream is corrupt', t => {
  const repository = repo(t)
  const records = relatedObjects(repository)
  const paths = packEntries(repository, records, false)
  const v2 = repository.io.readMeta(paths.pack, 24 * MiB)
  const index = repository.io.readMeta(paths.idx, MiB)
  const count = index.readUInt32BE(8 + 255 * 4)
  const crcStart = 8 + 256 * 4 + count * 20
  const offsetStart = crcStart + count * 4
  let lastIndex = 0, lastOffset = 0
  for (let i = 0; i < count; i++) {
    const offset = index.readUInt32BE(offsetStart + i * 4)
    if (offset > lastOffset) { lastOffset = offset; lastIndex = i }
  }
  const idStart = 8 + 256 * 4 + lastIndex * 20
  const lastOid = index.toString('hex', idStart, idStart + 20)
  const last = records.find(({ oid }) => oid === lastOid)
  assert.ok(last)
  const fixture = (version, trailingBytes = Buffer.alloc(0)) => {
    const raw = Buffer.concat([v2.subarray(0, -20), trailingBytes])
    raw.writeUInt32BE(version, 4)
    const packHash = sha1(raw)
    const idx = Buffer.from(index)
    idx.writeUInt32BE(crc32(raw.subarray(lastOffset)), crcStart + lastIndex * 4)
    packHash.copy(idx, idx.length - 40)
    sha1(idx.subarray(0, -20)).copy(idx, idx.length - 20)
    return {
      listMeta: repository.io.listMeta,
      readMeta(path, cap) {
        if (path === paths.pack) return Buffer.concat([raw, packHash])
        if (path === paths.idx) return idx
        return repository.io.readMeta(path, cap)
      }
    }
  }
  compareObjects(repository, [last], createGitObjectReader(fixture(3)))
  assert.throws(() => createGitObjectReader(fixture(4)).get(lastOid), errorCode('unsupported_git_layout'))
  assert.throws(() => createGitObjectReader(fixture(3, Buffer.from('padding'))).get(lastOid), errorCode('git_corrupt'))
})

test('pack listing limits apply before metadata files are read', () => {
  const oid = '0'.repeat(40)
  const entries = Array.from({ length: 17 }, (_, i) => {
    const prefix = `pack-${i.toString(16).padStart(40, '0')}`
    return [{ name: `${prefix}.idx`, type: 'file' }, { name: `${prefix}.pack`, type: 'file' }]
  }).flat()
  const io = { readMeta(rel) { assert.equal(rel, loosePath(oid)); return null }, listMeta() { return entries } }
  assert.throws(() => createGitObjectReader(io).get(oid), errorCode('git_limit'))
  entries[0].type = 'symlink'
  assert.throws(() => createGitObjectReader(io).get(oid), errorCode('unsupported_git_layout'))
})
