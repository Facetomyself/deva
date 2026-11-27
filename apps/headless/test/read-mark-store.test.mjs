import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { HttpError } from '../src/http/policy.mjs'
import { openReadMarkStore } from '../src/chat/read-mark-store.mjs'

const allow = () => true
const isError = (status, code) => error => error instanceof HttpError && error.status === status && error.code === code && error.message === code
const invalid = isError(400, 'invalid_read_state')
const limited = isError(413, 'read_state_limit')
const unavailable = isError(503, 'read_state_unconfirmed')

function setup(t, name) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'deva-read-mark-')))
  const dataDir = name ? join(base, name) : base
  const store = openReadMarkStore({ dataDir })
  const file = join(dataDir, 'read-state.json')
  t.after(() => { store.close(); rmSync(base, { force: true, recursive: true }) })
  return { base, dataDir, store, file }
}

function pins(path) {
  return readdirSync('/proc/self/fd').flatMap(name => {
    try { return readlinkSync(`/proc/self/fd/${name}`) === path ? [name] : [] }
    catch (error) { if (error.code !== 'ENOENT') throw error; return [] }
  })
}

function stamp(file) {
  const { ino, dev, mode, uid, gid, nlink, size, mtimeNs, ctimeNs } = statSync(file, { bigint: true })
  return { ino, dev, mode, uid, gid, nlink, size, mtimeNs, ctimeNs }
}

test('factory is lazy; absent snapshots create nothing; close releases the directory pin and is final', t => {
  const { base, dataDir, file, store } = setup(t, 'deva')
  assert.deepEqual(pins(dataDir), [])
  assert.deepEqual(store.snapshot(), new Map())
  assert.deepEqual(readdirSync(base), [])
  assert.throws(() => store.advance({ id: 'sessionA', through: 0 }, allow), isError(403, 'read_state_read_only'))
  assert.equal(existsSync(dataDir), false)
  mkdirSync(dataDir, { mode: 0o700 })
  const before = stamp(dataDir)
  assert.deepEqual(store.snapshot(), new Map())
  assert.equal(existsSync(file), false)
  assert.deepEqual(stamp(dataDir), before)
  assert.equal(pins(dataDir).length, 1)
  store.close()
  store.close()
  assert.deepEqual(pins(dataDir), [])
  assert.throws(() => store.snapshot(), unavailable)
  assert.throws(() => store.advance({ id: 'sessionA', through: 1 }, allow), unavailable)
  assert.deepEqual(pins(dataDir), [])
})

test('two owner sessions and restart see the same durable marks; no-op leaves the inode and mtime unchanged', t => {
  const { dataDir, file, store } = setup(t)
  const other = openReadMarkStore({ dataDir })
  t.after(() => other.close())
  assert.deepEqual(store.advance({ id: 'chat_1', through: 100_001 }, allow), { changed: true, readAt: 100_001 })
  assert.equal(readFileSync(file, 'utf8'), '{"chat_1":100001}')
  const first = stamp(file)
  assert.equal(first.uid, BigInt(process.geteuid()))
  assert.equal(first.mode & 0o7777n, 0o600n)
  assert.equal(first.nlink, 1n)
  const copied = other.snapshot()
  assert.deepEqual(copied, new Map([['chat_1', 100_001]]))
  copied.set('chat_1', 0)
  assert.deepEqual(other.snapshot(), new Map([['chat_1', 100_001]]))
  let checks = 0
  for (const through of [100_000, 100_001]) {
    assert.deepEqual(other.advance({ id: 'chat_1', through }, () => { checks++; return true }), { changed: false, readAt: 100_001 })
    assert.deepEqual(stamp(file), first)
  }
  assert.equal(checks, 4)
  assert.deepEqual(other.advance({ id: 'chat_1', through: 100_002 }, allow), { changed: true, readAt: 100_002 })
  assert.notEqual(stamp(file).ino, first.ino)
  assert.equal(stamp(file).nlink, 1n)
  assert.deepEqual(readdirSync(dataDir), ['read-state.json'])
  store.close()
  other.close()
  const restart = openReadMarkStore({ dataDir })
  t.after(() => restart.close())
  assert.deepEqual(restart.snapshot(), new Map([['chat_1', 100_002]]))
})

test('legacy mode and bytes of unrelated native rows survive replacement and insertion', t => {
  const { file, store } = setup(t)
  const raw = '\ufeff\n { "n\\u0061tive_other" \t: 7.20e+2 ,\r\n\t"foo\\u002d1": 1.00E3, "zero": -0.000e9, "big": 900719925474099100e-2 \t }\r\n'
  writeFileSync(file, raw)
  chmodSync(file, 0o644)
  const before = stamp(file)
  assert.deepEqual(store.snapshot(), new Map([['native_other', 720], ['foo-1', 1000], ['zero', 0], ['big', Number.MAX_SAFE_INTEGER]]))
  assert.deepEqual(store.advance({ id: 'foo-1', through: 1001 }, allow), { changed: true, readAt: 1001 })
  const next = raw.replace('1.00E3', '1001')
  assert.equal(readFileSync(file, 'utf8'), next)
  const updated = stamp(file)
  assert.notEqual(updated.ino, before.ino)
  assert.deepEqual(store.advance({ id: 'new_chat', through: 2000 }, allow), { changed: true, readAt: 2000 })
  assert.equal(readFileSync(file, 'utf8'), next.replace('e-2 \t }', 'e-2,"new_chat":2000 \t }'))
  const after = stamp(file)
  assert.notEqual(after.ino, updated.ino)
  for (const key of ['uid', 'gid', 'mode', 'nlink']) assert.equal(after[key], before[key])
})

test('one durable number bounded to [0, MAX_SAFE_INTEGER]; duplicate keys and rounded decimals fail closed', t => {
  const { file, store } = setup(t)
  for (const id of ['', 'with/slash', 'green\n', 'a'.repeat(129)]) {
    assert.throws(() => store.advance({ id, through: 1 }, allow), invalid)
  }
  for (const through of [-1, 1.01, Infinity, NaN, '123', null, undefined, new Date(123), 9007199254740992, 1n]) {
    assert.throws(() => store.advance({ id: 's', through }, allow), invalid)
  }
  assert.equal(existsSync(file), false)
  for (const raw of [
    '', '{', '[]', 'null', 'false', '{}\v', '{"a":1,}', '{"a":1,"a":2}', '{"a":1,"\\u0061":2}',
    '{"s":true}', '{"s":null}', '{"s":"1"}', '{"s":[]}', '{"s":{}}', '{"s":-10}', '{"s":1e99999}',
    '{"s":9007199254740992}', '{"s":9007199254740991.1}', '{"s":1.00000000000000000000001}', '{"s":1e-99999}',
    '{"s":1.2}', '{"s":01}', '{"../s":1}', '{"\\uD800":1}', Buffer.from([0x7b, 0x80, 0x7d])
  ]) {
    writeFileSync(file, raw, { mode: 0o600 })
    const before = stamp(file)
    assert.throws(() => store.snapshot(), invalid)
    assert.throws(() => store.advance({ id: 's', through: 100 }, allow), invalid)
    assert.deepEqual(stamp(file), before)
  }
  writeFileSync(file, '{"zero":0e99999999, "half_scaled":0.50e1, "max":9007199254740991}')
  assert.deepEqual(store.snapshot(), new Map([['zero', 0], ['half_scaled', 5], ['max', Number.MAX_SAFE_INTEGER]]))
})

test('limit is exactly 1 MiB and 8192 rows; hitting an output cap leaves the file unchanged', t => {
  const { file, store } = setup(t)
  const maxBytes = 1024 * 1024
  writeFileSync(file, '{"s":9}' + ' '.repeat(maxBytes - 7), { mode: 0o600 })
  assert.equal(store.snapshot().get('s'), 9)
  const before = stamp(file)
  assert.throws(() => store.advance({ id: 's', through: 10 }, allow), limited)
  assert.deepEqual(stamp(file), before)
  writeFileSync(file, '{}'.padEnd(maxBytes + 1, ' '))
  assert.throws(() => store.snapshot(), limited)
  const allIds = Object.fromEntries(Array.from({ length: 8192 }, (_, i) => [`id${i}`, i]))
  writeFileSync(file, JSON.stringify(allIds))
  assert.equal(store.snapshot().size, 8192)
  assert.throws(() => store.advance({ id: 'some_other_id', through: 10 }, allow), limited)
  assert.deepEqual(store.advance({ id: 'id7711', through: 9000 }, allow), { changed: true, readAt: 9000 })
  writeFileSync(file, JSON.stringify({ ...allIds, too_many: 1 }))
  assert.throws(() => store.snapshot(), limited)
})
