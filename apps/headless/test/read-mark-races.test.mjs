import assert from 'node:assert/strict'
import childProcess, { spawnSync } from 'node:child_process'
import fs, { chmodSync, existsSync, fstatSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { HttpError } from '../src/http/policy.mjs'
import { openReadMarkStore } from '../src/chat/read-mark-store.mjs'

const allow = () => true
const isError = (status, code) => error => error instanceof HttpError && error.status === status && error.code === code && error.message === code
const auth = isError(401, 'auth')
const readOnly = isError(403, 'read_state_read_only')
const conflict = isError(409, 'read_state_conflict')
const unsupported = isError(409, 'read_state_unsupported')
const unconfirmed = isError(503, 'read_state_unconfirmed')

function setup(t, initial) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'deva-read-mark-races-')))
  const dataDir = join(base, 'state')
  mkdirSync(dataDir, { mode: 0o700 })
  const file = join(dataDir, 'read-state.json')
  if (initial !== undefined) writeFileSync(file, initial, { mode: 0o600 })
  const store = openReadMarkStore({ dataDir })
  t.after(() => { store.close(); rmSync(base, { force: true, recursive: true }) })
  return { base, dataDir, file, store }
}

function externalReplace(dataDir, file, text) {
  const swap = join(dataDir, 'external-pending')
  writeFileSync(swap, text, { mode: 0o600 })
  renameSync(swap, file)
}

const inode = path => statSync(path, { bigint: true }).ino

test('fresh verify rejects async/false/unknown errors and preserves approved HttpError identities', t => {
  const { dataDir, file, store } = setup(t)
  const input = { id: 's', through: 1 }
  const stale = new HttpError(409, 'read_view_stale')
  const busy = new HttpError(409, 'read_view_busy')
  const revoked = new HttpError(401, 'auth')
  const disconnected = new HttpError(503, 'conversation_status_unavailable')
  const wrongCode = new HttpError(503, 'some_internal_detail')
  const wrongStatus = new HttpError(401, 'conversation_status_unavailable')
  for (const verify of [undefined, () => false, () => undefined, () => ({ then() { assert.fail() } }),
    async () => true, async () => { throw stale }, () => { throw Error(file) }, () => { throw wrongCode }, () => { throw wrongStatus }]) {
    assert.throws(() => store.advance(input, verify), auth)
    assert.deepEqual(readdirSync(dataDir), [])
  }
  for (const approved of [stale, busy, revoked, disconnected]) {
    for (const checkpoint of [1, 2]) {
      let checks = 0
      assert.throws(() => store.advance(input, () => {
        if (++checks === checkpoint) throw approved
        return true
      }), error => error === approved)
      assert.equal(checks, checkpoint)
      assert.deepEqual(readdirSync(dataDir), [])
    }
  }
})

test('revocation immediately before publish leaves original inode; revocation afterward leaves committed inode', t => {
  const { dataDir, file, store } = setup(t, '{"s":1}')
  const original = inode(file)
  const input = { id: 's', through: 3 }
  let checks = 0
  assert.throws(() => store.advance(input, () => {
    checks++
    assert.equal(inode(file), original)
    if (checks === 2) assert.equal(readdirSync(dataDir).some(name => name.startsWith('.read-state.json.')), true)
    return checks === 1
  }), auth)
  assert.equal(checks, 2)
  assert.equal(inode(file), original)
  checks = 0
  assert.throws(() => store.advance(input, () => {
    if (++checks !== 3) return true
    assert.notEqual(inode(file), original)
    assert.equal(readFileSync(file, 'utf8'), '{"s":3}')
    return false
  }), auth)
  assert.equal(checks, 3)
  assert.notEqual(inode(file), original)
  assert.deepEqual(store.snapshot(), new Map([['s', 3]]))
  assert.deepEqual(readdirSync(dataDir), ['read-state.json'])
  const postStale = new HttpError(409, 'read_view_stale')
  checks = 0
  assert.throws(() => store.advance({ id: 's', through: 4 }, () => {
    if (++checks === 3) throw postStale
    return true
  }), error => error === postStale)
  assert.equal(readFileSync(file, 'utf8'), '{"s":4}')
  const disconnected = new HttpError(503, 'conversation_status_unavailable')
  checks = 0
  assert.throws(() => store.advance({ id: 's', through: 5 }, () => {
    if (++checks === 3) throw disconnected
    return true
  }), error => error === disconnected)
  assert.equal(checks, 3)
  assert.equal(readFileSync(file, 'utf8'), '{"s":5}')
})

test('out-of-band replacements or in-place edits are observed before publish; a later older read never regresses', t => {
  const { dataDir, file, store } = setup(t, '{}')
  assert.equal(store.snapshot().size, 0)
  externalReplace(dataDir, file, '{"s":80}')
  const newest = inode(file)
  assert.deepEqual(store.advance({ id: 's', through: 40 }, allow), { changed: false, readAt: 80 })
  assert.equal(inode(file), newest)
  let checks = 0
  assert.throws(() => store.advance({ id: 's', through: 90 }, () => {
    if (++checks === 2) externalReplace(dataDir, file, '{"s":95,"out_of_band":1}')
    return true
  }), conflict)
  assert.equal(checks, 2)
  assert.equal(readFileSync(file, 'utf8'), '{"s":95,"out_of_band":1}')
  assert.deepEqual(store.advance({ id: 's', through: 90 }, allow), { changed: false, readAt: 95 })
  const race = inode(file)
  checks = 0
  assert.throws(() => store.advance({ id: 's', through: 94 }, () => {
    if (++checks === 2) writeFileSync(file, '{"s":96,"out_of_band":1}')
    return true
  }), conflict)
  assert.equal(inode(file), race)
  assert.equal(readFileSync(file, 'utf8'), '{"s":96,"out_of_band":1}')
  assert.deepEqual(readdirSync(dataDir), ['read-state.json'])
})

test('initial publication never overwrites a name that appears in the link syscall window', t => {
  const { dataDir, file, store } = setup(t)
  const originalLink = fs.linkSync
  t.after(() => { fs.linkSync = originalLink; syncBuiltinESMExports() })
  fs.linkSync = (temporary, destination) => {
    writeFileSync(file, '{"native_other":5}', { mode: 0o600, flag: 'wx' })
    return originalLink(temporary, destination)
  }
  syncBuiltinESMExports()
  assert.throws(() => store.advance({ id: 's', through: 1 }, allow), conflict)
  assert.equal(readFileSync(file, 'utf8'), '{"native_other":5}')
  assert.deepEqual(readdirSync(dataDir), ['read-state.json'])
})

test('a replaced staging name is neither published nor removed as local cleanup', t => {
  const { dataDir, file, store } = setup(t, '{"s":1}')
  let checks = 0
  let staged
  assert.throws(() => store.advance({ id: 's', through: 2 }, () => {
    if (++checks === 2) {
      staged = join(dataDir, readdirSync(dataDir).find(name => name.startsWith('.read-state.json.')))
      externalReplace(dataDir, staged, '{"external":3}')
    }
    return true
  }), conflict)
  assert.equal(checks, 2)
  assert.equal(readFileSync(file, 'utf8'), '{"s":1}')
  assert.equal(readFileSync(staged, 'utf8'), '{"external":3}')
})

test('post-publication replacement and ambiguous fsync/rename results never roll back external data', t => {
  const { dataDir, file, store } = setup(t, '{"s":1}')
  let checks = 0
  assert.throws(() => store.advance({ id: 's', through: 2 }, () => {
    if (++checks === 3) externalReplace(dataDir, file, '{"s":4}')
    return true
  }), unconfirmed)
  assert.equal(readFileSync(file, 'utf8'), '{"s":4}')
  const originalFsync = fs.fsyncSync
  const originalRename = fs.renameSync
  t.after(() => { fs.fsyncSync = originalFsync; fs.renameSync = originalRename; syncBuiltinESMExports() })
  fs.fsyncSync = fd => {
    if (!fstatSync(fd).isDirectory()) return originalFsync(fd)
    externalReplace(dataDir, file, '{"native_other":8}')
    throw Object.assign(Error('private fsync path information'), { code: 'EIO' })
  }
  syncBuiltinESMExports()
  assert.throws(() => store.advance({ id: 's', through: 5 }, allow), unconfirmed)
  assert.equal(readFileSync(file, 'utf8'), '{"native_other":8}')
  fs.fsyncSync = originalFsync
  fs.renameSync = (a, b) => {
    originalRename(a, b)
    throw Object.assign(Error('reported error after rename'), { code: 'EPERM' })
  }
  syncBuiltinESMExports()
  assert.throws(() => store.advance({ id: 's', through: 6 }, allow), unconfirmed)
  assert.equal(readFileSync(file, 'utf8'), '{"native_other":8,"s":6}')
  assert.deepEqual(readdirSync(dataDir), ['read-state.json'])
})

test('directory inode remains pinned even if path is rebound; detached staging is cleaned', t => {
  const { base, dataDir, file, store } = setup(t, '{"s":4}')
  const detached = join(base, 'away')
  assert.deepEqual(store.snapshot(), new Map([['s', 4]]))
  let checks = 0
  assert.throws(() => store.advance({ id: 's', through: 5 }, () => {
    if (++checks === 2) {
      renameSync(dataDir, detached)
      mkdirSync(dataDir, { mode: 0o700 })
      writeFileSync(file, '{"replacement":8}', { mode: 0o600 })
    }
    return true
  }), conflict)
  assert.equal(readFileSync(join(detached, 'read-state.json'), 'utf8'), '{"s":4}')
  assert.equal(readFileSync(file, 'utf8'), '{"replacement":8}')
  assert.deepEqual(readdirSync(detached), ['read-state.json'])
  assert.throws(() => store.snapshot(), conflict)
  const restart = openReadMarkStore({ dataDir })
  t.after(() => restart.close())
  assert.equal(restart.snapshot().get('replacement'), 8)
})

test('a pinned empty root conflicts after disappearance and remains pinned across recreation', t => {
  const { base, dataDir, file, store } = setup(t)
  assert.equal(Object.isFrozen(store), true)
  assert.deepEqual(store.snapshot(), new Map())
  renameSync(dataDir, join(base, 'renamed'))
  assert.throws(() => store.snapshot(), conflict)
  assert.throws(() => store.advance({ id: 's', through: 1 }, allow), conflict)
  mkdirSync(dataDir, { mode: 0o700 })
  writeFileSync(file, '{"replacement":8}', { mode: 0o600 })
  assert.throws(() => store.snapshot(), conflict)
  assert.throws(() => store.advance({ id: 's', through: 1 }, allow), conflict)
  assert.equal(readFileSync(file, 'utf8'), '{"replacement":8}')
})

test('cooperating writer locks across real processes, while snapshots and no-op start no helpers', t => {
  const { dataDir, file, store } = setup(t, '{"s":4}')
  const originalSpawn = childProcess.spawnSync
  const launched = []
  childProcess.spawnSync = (program, args, options) => {
    launched.push({ program, args, options })
    return originalSpawn(program, args, options)
  }
  syncBuiltinESMExports()
  t.after(() => { childProcess.spawnSync = originalSpawn; syncBuiltinESMExports() })
  assert.equal(store.snapshot().get('s'), 4)
  assert.deepEqual(store.advance({ id: 's', through: 4 }, allow), { changed: false, readAt: 4 })
  assert.deepEqual(launched, [])
  let checks = 0
  const module = new URL('../src/chat/read-mark-store.mjs', import.meta.url).href
  assert.deepEqual(store.advance({ id: 's', through: 5 }, () => {
    if (++checks !== 2) return true
    const child = originalSpawn(process.execPath, ['--input-type=module', '-e', `import { openReadMarkStore } from ${JSON.stringify(module)};
      const s = openReadMarkStore({ dataDir: process.argv[1] });
      try { s.advance({ id: 's', through: 99 }, () => true); process.exitCode = 2 }
      catch (e) { if (e?.code !== 'read_state_conflict') process.exitCode = 3 }
      finally { s.close() }`, dataDir], { timeout: 3000 })
    assert.equal(child.status, 0)
    assert.equal(readFileSync(file, 'utf8'), '{"s":4}')
    return true
  }), { changed: true, readAt: 5 })
  assert.equal(checks, 3)
  assert.deepEqual(launched.map(item => item.program), ['/usr/bin/flock', '/usr/bin/perl'])
  for (const { args, options } of launched) {
    assert.equal(args.some(arg => arg.includes(dataDir)), false)
    assert.deepEqual(options.env, {})
    assert.equal(options.timeout, 1000)
  }
})

test('unsafe symlinks, FIFOs, extra links and modes fail closed; owner-read-only files stay readable', t => {
  const { base, dataDir, file, store } = setup(t)
  const sensitive = join(base, 'external')
  writeFileSync(sensitive, '{"native":7}', { mode: 0o600 })
  symlinkSync(sensitive, file)
  assert.throws(() => store.snapshot(), unsupported)
  assert.throws(() => store.advance({ id: 's', through: 2 }, allow), unsupported)
  rmSync(file)
  linkSync(sensitive, file)
  assert.throws(() => store.snapshot(), unsupported)
  assert.equal(statSync(sensitive).nlink, 2)
  rmSync(file)
  assert.equal(spawnSync('/usr/bin/mkfifo', [file], { timeout: 1000 }).status, 0)
  assert.throws(() => store.snapshot(), unsupported)
  assert.throws(() => store.advance({ id: 's', through: 2 }, allow), unsupported)
  rmSync(file)
  mkdirSync(file, { mode: 0o700 })
  assert.throws(() => store.snapshot(), unsupported)
  rmSync(file, { recursive: true })
  writeFileSync(file, '{}', { mode: 0o600 })
  for (const mode of [0o666, 0o620, 0o701, 0o4600]) {
    chmodSync(file, mode)
    assert.throws(() => store.snapshot(), unsupported)
    assert.throws(() => store.advance({ id: 's', through: 2 }, allow), unsupported)
  }
  chmodSync(file, 0o000)
  assert.throws(() => store.snapshot(), readOnly)
  chmodSync(file, 0o400)
  assert.equal(store.snapshot().size, 0)
  assert.throws(() => store.advance({ id: 's', through: 2 }, allow), readOnly)
  chmodSync(file, 0o600)
  chmodSync(dataDir, 0o550)
  assert.equal(store.snapshot().size, 0)
  assert.throws(() => store.advance({ id: 's', through: 2 }, allow), readOnly)
  chmodSync(dataDir, 0o700)
  assert.equal(readFileSync(sensitive, 'utf8'), '{"native":7}')
  assert.equal(readFileSync(file, 'utf8'), '{}')
  assert.deepEqual(readdirSync(dataDir), ['read-state.json'])
  const alias = join(base, 'alias')
  symlinkSync(dataDir, alias)
  const aliased = openReadMarkStore({ dataDir: alias })
  t.after(() => aliased.close())
  assert.throws(() => aliased.snapshot(), unsupported)
})

test('mutations fail closed on native xattrs and POSIX ACLs without dropping metadata', t => {
  const { dataDir, file, store } = setup(t, '{"s":1}')
  const script = `import os, sys, struct
path, mode = sys.argv[1:]
if mode == 'xattr': os.setxattr(path, 'user.read_mark_test', b'retain')
else:
    acl = struct.pack('<I', 2) + b''.join(struct.pack('<HHI', *x) for x in [(1, 7, 4294967295), (2, 4, 12345), (4, 0, 4294967295), (16, 4, 4294967295), (32, 0, 4294967295)])
    os.setxattr(path, 'system.posix_acl_default', acl)
`
  const probe = (path, mode) => spawnSync('/usr/bin/python3', ['-c', script, path, mode], { timeout: 1000 })
  if (probe(file, 'xattr').status !== 0) return t.skip('xattr test setup requires Python and a filesystem supporting user xattrs')
  const before = inode(file)
  assert.equal(store.snapshot().get('s'), 1)
  assert.throws(() => store.advance({ id: 's', through: 2 }, allow), readOnly)
  assert.equal(inode(file), before)
  assert.equal(readFileSync(file, 'utf8'), '{"s":1}')
  assert.deepEqual(readdirSync(dataDir), ['read-state.json'])
  // A clean new inode is still blocked when the directory would inherit an extended ACL.
  externalReplace(dataDir, file, '{"s":3}')
  const acl = probe(dataDir, 'acl')
  if (acl.status !== 0) { t.diagnostic('POSIX default ACL test setup is unavailable; verified native xattrs'); return }
  const real = inode(file)
  assert.throws(() => store.advance({ id: 's', through: 4 }, allow), readOnly)
  assert.equal(inode(file), real)
  assert.equal(readFileSync(file, 'utf8'), '{"s":3}')
  assert.deepEqual(readdirSync(dataDir), ['read-state.json'])
})

test('an unconfirmed metadata probe leaves the native file read-only and reveals no helper details', t => {
  const { dataDir, file, store } = setup(t, '{"s":1}')
  const originalSpawn = childProcess.spawnSync
  childProcess.spawnSync = (program, ...args) => program === '/usr/bin/perl'
    ? { status: null, error: Object.assign(Error('private infrastructure details'), { code: 'ETIMEDOUT' }) }
    : originalSpawn(program, ...args)
  syncBuiltinESMExports()
  t.after(() => { childProcess.spawnSync = originalSpawn; syncBuiltinESMExports() })
  const before = inode(file)
  assert.equal(store.snapshot().get('s'), 1)
  assert.throws(() => store.advance({ id: 's', through: 2 }, allow), readOnly)
  assert.equal(inode(file), before)
  assert.deepEqual(readdirSync(dataDir), ['read-state.json'])
})

test('reentrant close neither leaks staged bytes nor allows the store to resurrect', t => {
  const { dataDir, file, store } = setup(t)
  let checks = 0
  assert.throws(() => store.advance({ id: 's', through: 10 }, () => {
    if (++checks === 2) store.close()
    return true
  }), unconfirmed)
  assert.equal(checks, 2)
  assert.equal(existsSync(file), false)
  assert.deepEqual(readdirSync(dataDir), [])
  assert.throws(() => store.snapshot(), unconfirmed)
})
