import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { initializeMasterKey, openVault } from '../src/storage/vault.mjs'

const exec = promisify(execFile)
const VAULT_NAME = 'headless-vault.json'
const MASTER_NAME = 'master.key'
const PURPOSE = Buffer.from('deva:headless-vault:v1', 'ascii')
const FORMAT = { code: 'ERR_VAULT_FORMAT' }
const AUTH = { code: 'ERR_VAULT_AUTH' }
const SIZE = { code: 'ERR_VAULT_SIZE' }
const UNSAFE = { code: 'ERR_VAULT_UNSAFE' }
const MISSING = { code: 'ENOENT' }
const EXISTS = { code: 'EEXIST' }

async function fixture(t, { provision = true } = {}) {
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'headless-vault-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const keyFile = join(root, 'keys', MASTER_NAME)
  const dataDir = join(root, 'data', 'profile')
  await fs.mkdir(join(root, 'keys'), { mode: 0o700 })
  if (provision) await initializeMasterKey(keyFile)
  return { root, dataDir, keyFile, vaultFile: join(dataDir, VAULT_NAME) }
}

async function fileMode(path) {
  return (await fs.stat(path)).mode & 0o7777
}

function sealFixture(payload, key, aad = PURPOSE) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  cipher.setAAD(aad)
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload))
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()])
  return { version: 1, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64') }
}

function unwrapFixture(envelope, key) {
  const nonce = Buffer.from(envelope.nonce, 'base64')
  const tag = Buffer.from(envelope.tag, 'base64')
  assert.equal(nonce.length, 12)
  assert.equal(tag.length, 16)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  decipher.setAAD(PURPOSE)
  decipher.setAuthTag(tag)
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]))
}

test('empty data directory is bootstrapped with an authenticated private envelope', async t => {
  const paths = await fixture(t)
  const vault = await openVault(paths)
  assert.equal(await vault.get('missing'), null)
  assert.equal(await vault.has('missing'), false)
  assert.deepEqual(await vault.list(), [])
  assert.equal(await vault.deletePrefix('missing:'), 0)
  assert.equal(await fileMode(paths.keyFile), 0o600)
  assert.equal(await fileMode(paths.vaultFile), 0o600)
  assert.deepEqual(await fs.readdir(paths.dataDir), [VAULT_NAME])
  const envelope = JSON.parse(await fs.readFile(paths.vaultFile, 'utf8'))
  assert.equal(envelope.version, 1)
  assert.deepEqual(unwrapFixture(envelope, await fs.readFile(paths.keyFile)), [])
  const otherKey = join(paths.root, 'other.key')
  await initializeMasterKey(otherKey)
  await assert.rejects(openVault({ ...paths, keyFile: otherKey }), AUTH)
})

test('whole-map authenticated writes have fresh nonces and expose no names or values on disk', async t => {
  const paths = await fixture(t)
  const vault = await openVault(paths)
  const copyValue = 'fixture-plain-value-私密-🔐'
  const name = 'fixture-private-entry-name'
  const initial = JSON.parse(await fs.readFile(paths.vaultFile, 'utf8'))
  await vault.set(name, copyValue)
  const disk = await fs.readFile(paths.vaultFile, 'utf8')
  const envelope = JSON.parse(disk)
  assert.deepEqual(Object.keys(envelope).sort(), ['ciphertext', 'nonce', 'tag', 'version'])
  assert.equal(envelope.version, 1)
  assert.notEqual(envelope.nonce, initial.nonce)
  assert.equal(disk.includes(copyValue), false)
  assert.equal(disk.includes(name), false)
  assert.equal(Buffer.from(envelope.ciphertext, 'base64').includes(Buffer.from(copyValue)), false)
  assert.equal(JSON.stringify(vault), '{}')
  assert.equal(await vault.get(name), copyValue)
  assert.equal(await vault.has(name), true)
  assert.deepEqual(await vault.list('fixture-'), [name])
  assert.deepEqual(unwrapFixture(envelope, await fs.readFile(paths.keyFile)), [[name, copyValue]])
  await vault.set('another', 'second value')
  assert.notEqual(JSON.parse(await fs.readFile(paths.vaultFile, 'utf8')).nonce, envelope.nonce)
  assert.deepEqual(await fs.readdir(paths.dataDir), [VAULT_NAME])
})

test('key and envelope copies work from different paths in a new process', async t => {
  const paths = await fixture(t)
  const vault = await openVault(paths)
  await vault.set('portable', 'fixture-portable-value')
  const copyDir = join(paths.root, 'other-data')
  const keyCopy = join(paths.root, 'other-raw.key')
  await fs.mkdir(copyDir, { mode: 0o700 })
  await fs.copyFile(paths.keyFile, keyCopy)
  await fs.copyFile(paths.vaultFile, join(copyDir, VAULT_NAME))
  const moduleUrl = new URL('../src/storage/vault.mjs', import.meta.url).href
  await exec(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { openVault } from ${JSON.stringify(moduleUrl)};
    const [dataDir, keyFile] = process.argv.slice(1);
    const vault = await openVault({ dataDir, keyFile });
    assert.equal(await vault.get('portable') === 'fixture-portable-value', true);
    await vault.set('from-restarted-process', 'new value');
  `, copyDir, keyCopy])
  assert.equal(await (await openVault({ dataDir: copyDir, keyFile: keyCopy })).has('from-restarted-process'), true)
  assert.equal(await vault.has('from-restarted-process'), false)
})

test('master key creation is explicit, exclusive and permission-restricted', async t => {
  const paths = await fixture(t, { provision: false })
  await assert.rejects(openVault(paths), MISSING)
  await assert.rejects(fs.stat(paths.dataDir), MISSING)
  await assert.rejects(initializeMasterKey('relative.key'), TypeError)
  await assert.rejects(initializeMasterKey(`${paths.keyFile}/.`), TypeError)
  await assert.rejects(openVault({ ...paths, keyFile: 'relative.key' }), TypeError)
  await assert.rejects(initializeMasterKey(join(paths.root, 'secrets.json')), TypeError)
  await assert.rejects(initializeMasterKey(paths.vaultFile), TypeError)
  const races = await Promise.allSettled([initializeMasterKey(paths.keyFile), initializeMasterKey(paths.keyFile)])
  assert.equal(races.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(races.find(result => result.status === 'rejected').reason.code, EXISTS.code)
  const key = await fs.readFile(paths.keyFile)
  assert.equal(key.length, 32)
  await assert.rejects(initializeMasterKey(paths.keyFile), EXISTS)
  assert.deepEqual(await fs.readFile(paths.keyFile), key)
  await fs.chmod(paths.keyFile, 0o400)
  assert.deepEqual(await (await openVault(paths)).list(), [])
  for (const mode of [0o640, 0o644, 0o700, 0o1600]) {
    await fs.chmod(paths.keyFile, mode)
    await assert.rejects(openVault(paths), UNSAFE)
  }
  await fs.chmod(paths.keyFile, 0o600)
  for (const size of [0, 31, 33, 44]) {
    await fs.writeFile(paths.keyFile, Buffer.alloc(size))
    await assert.rejects(openVault(paths), SIZE)
  }
  await fs.writeFile(paths.keyFile, key)
  assert.deepEqual(await (await openVault(paths)).list(), [])
})

test('symlinks, unsafe directory or vault modes and nonregular files fail closed', async t => {
  const paths = await fixture(t)
  const vault = await openVault(paths)
  await vault.set('saved', 'keep me')
  const keyLink = join(paths.root, 'key-symlink')
  await fs.symlink(paths.keyFile, keyLink)
  await assert.rejects(openVault({ ...paths, keyFile: keyLink }), { code: 'ELOOP' })
  await assert.rejects(initializeMasterKey(keyLink), EXISTS)
  const hardLink = join(paths.root, 'key-hardlink')
  await fs.link(paths.keyFile, hardLink)
  await assert.rejects(openVault({ ...paths, keyFile: hardLink }), UNSAFE)
  await fs.unlink(hardLink)
  const dirLink = join(paths.root, 'dir-symlink')
  await fs.symlink(paths.dataDir, dirLink)
  await assert.rejects(openVault({ ...paths, dataDir: dirLink }))
  await assert.rejects(openVault({ ...paths, dataDir: join(dirLink, 'child') }))
  await assert.rejects(fs.stat(join(paths.dataDir, 'child')), MISSING)
  const keyDirLink = join(paths.root, 'key-dir-symlink')
  await fs.symlink(join(paths.root, 'keys'), keyDirLink)
  await assert.rejects(openVault({ ...paths, keyFile: join(keyDirLink, MASTER_NAME) }))
  const keyAsDirectory = join(paths.root, 'key-as-folder')
  await fs.mkdir(keyAsDirectory, { mode: 0o700 })
  await assert.rejects(openVault({ ...paths, keyFile: keyAsDirectory }), UNSAFE)

  await fs.chmod(paths.dataDir, 0o720)
  await assert.rejects(openVault(paths), UNSAFE)
  await assert.rejects(vault.set('new', 'check folder'), UNSAFE)
  await fs.chmod(paths.dataDir, 0o700)
  await fs.chmod(paths.vaultFile, 0o644)
  await assert.rejects(openVault(paths), UNSAFE)
  await fs.chmod(paths.vaultFile, 0o600)
  const backup = join(paths.dataDir, 'backup')
  await fs.rename(paths.vaultFile, backup)
  await fs.symlink(backup, paths.vaultFile)
  await assert.rejects(openVault(paths), { code: 'ELOOP' })
  await assert.rejects(vault.set('new', 'check link'), { code: 'ELOOP' })
  await fs.unlink(paths.vaultFile)
  await fs.mkdir(paths.vaultFile, { mode: 0o700 })
  await assert.rejects(openVault(paths), UNSAFE)
  await fs.rmdir(paths.vaultFile)
  await fs.rename(backup, paths.vaultFile)
  assert.equal(await vault.get('saved'), 'keep me')
  assert.equal(await vault.has('new'), false)
})

test('desktop secrets.json coexists and an independent envelope never falls back to desktop data', async t => {
  const paths = await fixture(t)
  await fs.mkdir(paths.dataDir, { recursive: true, mode: 0o755 })
  const desktop = join(paths.dataDir, 'secrets.json')
  const desktopBytes = Buffer.from('{"desktop-field":"fixture-desktop-ciphertext"}\n')
  await fs.writeFile(desktop, desktopBytes, { mode: 0o600 })
  const vault = await openVault(paths)
  assert.deepEqual(await vault.list(), [])
  await vault.set('server-field', 'server value')
  assert.deepEqual(await fs.readFile(desktop), desktopBytes)
  await fs.writeFile(paths.vaultFile, desktopBytes)
  await assert.rejects(openVault(paths), FORMAT)
  await assert.rejects(vault.deletePrefix('server-'), FORMAT)
  assert.deepEqual(await fs.readFile(paths.vaultFile), desktopBytes)
  assert.deepEqual(await fs.readFile(desktop), desktopBytes)
})

test('malformed envelopes or authenticated malformed maps are rejected without rewriting the file', async t => {
  const paths = await fixture(t)
  const vault = await openVault(paths)
  await vault.set('saved', 'keep me')
  const good = await fs.readFile(paths.vaultFile)
  const envelope = JSON.parse(good)
  const rawKey = await fs.readFile(paths.keyFile)
  const wrongKey = join(paths.root, 'wrong.key')
  await initializeMasterKey(wrongKey)
  await assert.rejects(openVault({ ...paths, keyFile: wrongKey }), AUTH)
  assert.deepEqual(await fs.readFile(paths.vaultFile), good)
  const damaged = Buffer.from(envelope.ciphertext, 'base64')
  damaged[0] ^= 1
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const paddingIndex = envelope.tag.length - 3
  const wrongPadding = envelope.tag.slice(0, paddingIndex) +
    alphabet[alphabet.indexOf(envelope.tag[paddingIndex]) ^ 1] + envelope.tag.slice(paddingIndex + 1)
  const cases = [
    ['invalid JSON', Buffer.from('broken'), FORMAT],
    ['invalid UTF-8', Buffer.from([0xff]), FORMAT],
    ['unknown version', { ...envelope, version: 2 }, FORMAT],
    ['extra field', { ...envelope, added: true }, FORMAT],
    ['missing field', { version: 1, nonce: envelope.nonce, tag: envelope.tag }, FORMAT],
    ['duplicate field', Buffer.from(`{"version":1,${good.toString().slice(1)}`), FORMAT],
    ['short nonce', { ...envelope, nonce: 'AAAA' }, FORMAT],
    ['short tag', { ...envelope, tag: 'AAAA' }, FORMAT],
    ['noncanonical padding bits', { ...envelope, tag: wrongPadding }, FORMAT],
    ['missing padding', { ...envelope, tag: envelope.tag.replace(/=+$/, '') }, FORMAT],
    ['whitespace in Base64', { ...envelope, nonce: ` ${envelope.nonce}` }, FORMAT],
    ['base64url alphabet', { ...envelope, nonce: `_${envelope.nonce.slice(1)}` }, FORMAT],
    ['oversized envelope', Buffer.alloc(1_400_000, 'a'), SIZE],
    ['oversized ciphertext inside envelope limit', sealFixture(Buffer.alloc(1_048_577), rawKey), FORMAT],
    ['altered ciphertext', { ...envelope, ciphertext: damaged.toString('base64') }, AUTH],
    ['wrong AAD', sealFixture([['saved', 'value']], rawKey, Buffer.from('another purpose')), AUTH],
    ['object instead of entries', sealFixture({ saved: 'value' }, rawKey), FORMAT],
    ['nonstrings', sealFixture([['saved', { secret: 'value' }]], rawKey), FORMAT],
    ['wrong pair length', sealFixture([['saved', 'value', 'extra']], rawKey), FORMAT],
    ['duplicate key', sealFixture([['saved', 'first'], ['saved', 'second']], rawKey), FORMAT],
    ['empty secret', sealFixture([['saved', '']], rawKey), FORMAT],
    ['oversized name', sealFixture([['名'.repeat(171), 'value']], rawKey), FORMAT],
    ['too many entries', sealFixture(Array.from({ length: 4097 }, (_, i) => [String(i), 'v']), rawKey), FORMAT],
    ['invalid decrypted UTF-8', sealFixture(Buffer.from([0xff, 0xff]), rawKey), FORMAT]
  ]
  for (const [name, payload, error] of cases) {
    await t.test(name, async () => {
      const contents = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload))
      await fs.writeFile(paths.vaultFile, contents)
      await assert.rejects(openVault(paths), error)
      await assert.rejects(vault.set('new', 'never written'), error)
      assert.deepEqual(await fs.readFile(paths.vaultFile), contents)
    })
  }
  await fs.writeFile(paths.vaultFile, good)
  assert.equal(await (await openVault(paths)).get('saved'), 'keep me')
})

test('validation limits are checked before publication and an oversized mutation leaves the old map intact', async t => {
  const paths = await fixture(t)
  const vault = await openVault(paths)
  await assert.rejects(vault.set('', 'value'), TypeError)
  await assert.rejects(vault.set('name', 123), TypeError)
  await assert.rejects(vault.set('name', 'a'.repeat(65537)), TypeError)
  await assert.rejects(vault.set('名'.repeat(171), 'value'), TypeError)
  for (let i = 0; i < 15; i++) await vault.set(`entry:${i}`, 'a'.repeat(65536))
  const saved = await fs.readFile(paths.vaultFile)
  await assert.rejects(vault.set('too-big', 'a'.repeat(65536)), SIZE)
  assert.deepEqual(await fs.readFile(paths.vaultFile), saved)
  assert.equal(await vault.has('too-big'), false)
  assert.equal((await vault.list()).length, 15)
  assert.equal(await vault.deletePrefix('entry:'), 15)
})

test('prefix deletion and exact empty-value deletion handle constructor and prototype-like names', async t => {
  const paths = await fixture(t)
  const vault = await openVault(paths)
  for (const name of ['__proto__', '__proto__:x', 'constructor', 'prototype', 'toString', 'mcp:one:a', 'mcp:two:b']) {
    await vault.set(name, `value:${name}`)
  }
  assert.equal(await vault.get('__proto__'), 'value:__proto__')
  assert.equal(await vault.get('constructor'), 'value:constructor')
  assert.equal(await vault.deletePrefix('__proto__'), 2)
  assert.equal(await vault.deletePrefix('mcp:one:'), 1)
  assert.equal(await vault.deletePrefix('mcp:one:'), 0)
  await assert.rejects(vault.deletePrefix(''), TypeError)
  await vault.set('constructor', '')
  const restarted = await openVault(paths)
  assert.deepEqual(await restarted.list(), ['mcp:two:b', 'prototype', 'toString'])
  assert.equal(await restarted.get('constructor'), null)
  assert.equal(Object.hasOwn(Object.prototype, 'mcp:one:a'), false)
})

test('parallel mutations serialize across independently opened handles in one process', async t => {
  const paths = await fixture(t)
  const [a, b] = await Promise.all([openVault(paths), openVault(paths)])
  await Promise.all(Array.from({ length: 48 }, (_, i) => (i % 2 ? a : b).set(`key:${i}`, `value:${i}`)))
  const deletion = a.deletePrefix('key:1')
  const lastWrite = b.set('key:1:after', 'last')
  const names = b.list('key:1')
  assert.equal(await deletion, 11)
  await lastWrite
  assert.deepEqual(await names, ['key:1:after'])
  const restored = await openVault(paths)
  assert.equal((await restored.list()).length, 38)
  assert.equal(await restored.get('key:47'), 'value:47')
})

test('a failed atomic rename preserves the original and the queue recovers', async t => {
  const paths = await fixture(t)
  const vault = await openVault(paths)
  await vault.set('saved', 'before')
  const original = await fs.readFile(paths.vaultFile)
  const failRename = t.mock.method(fs, 'rename', async () => {
    throw Object.assign(new Error('injected permanent I/O failure'), { code: 'EIO' })
  })
  await assert.rejects(vault.set('saved', 'after'), { code: 'EIO' })
  assert.deepEqual(await fs.readFile(paths.vaultFile), original)
  assert.deepEqual(await fs.readdir(paths.dataDir), [VAULT_NAME])
  assert.equal(await vault.get('saved'), 'before')
  failRename.mock.restore()
  await vault.set('saved', 'recovered')
  assert.equal(await (await openVault(paths)).get('saved'), 'recovered')
})

test('an external file change between authentication and publication stays intact', async t => {
  const paths = await fixture(t)
  const vault = await openVault(paths)
  await vault.set('saved', 'before')
  const latest = Buffer.from(JSON.stringify(sealFixture([['saved', 'externally replaced']], await fs.readFile(paths.keyFile))))
  const lstat = fs.lstat.bind(fs)
  const changeFile = t.mock.method(fs, 'lstat', async (path, options) => {
    if (path.endsWith(`/${VAULT_NAME}`)) await fs.writeFile(path, latest)
    return lstat(path, options)
  })
  await assert.rejects(vault.set('saved', 'stale mutation'), { code: 'ERR_VAULT_CHANGED' })
  changeFile.mock.restore()
  assert.deepEqual(await fs.readFile(paths.vaultFile), latest)
  assert.deepEqual(await fs.readdir(paths.dataDir), [VAULT_NAME])
  assert.equal(await vault.get('saved'), 'externally replaced')
})

test('exclusive first install preserves a newly appearing target', async t => {
  const paths = await fixture(t)
  const actualLink = fs.link.bind(fs)
  const previous = Buffer.from('independent target')
  t.mock.method(fs, 'link', async (source, target) => {
    await fs.writeFile(target, previous, { flag: 'wx', mode: 0o600 })
    return actualLink(source, target)
  })
  await assert.rejects(openVault(paths), EXISTS)
  assert.deepEqual(await fs.readFile(paths.vaultFile), previous)
  assert.deepEqual(await fs.readdir(paths.dataDir), [VAULT_NAME])
})

test('an open handle fails on missing contents or a replaced directory and can read a restored backup', async t => {
  const paths = await fixture(t)
  const vault = await openVault(paths)
  await vault.set('saved', 'keep me')
  const backup = join(paths.root, 'backup.bin')
  await fs.rename(paths.vaultFile, backup)
  await assert.rejects(vault.get('saved'), MISSING)
  await assert.rejects(vault.set('replacement', 'never created'), MISSING)
  assert.deepEqual(await fs.readdir(paths.dataDir), [])
  await fs.rename(backup, paths.vaultFile)
  assert.equal(await vault.get('saved'), 'keep me')
  const originalDir = join(paths.root, 'original-dir')
  await fs.rename(paths.dataDir, originalDir)
  await fs.mkdir(paths.dataDir, { mode: 0o700 })
  await assert.rejects(vault.list(), { code: 'ERR_VAULT_CHANGED' })
  assert.deepEqual(await fs.readdir(paths.dataDir), [])
  await fs.rmdir(paths.dataDir)
  await fs.rename(originalDir, paths.dataDir)
  assert.equal(await (await openVault(paths)).get('saved'), 'keep me')
})
