import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync, renameSync, writeFileSync, mkdirSync } from 'node:fs'
import { chmod, lstat, link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openWorkspaceCatalog } from '../src/business/workspace-catalog.mjs'
import { openWorkspaceFiles } from '../src/files/workspace-files.mjs'

const fakeRevision = `r_${'0'.repeat(64)}`
const maxBytes = 2 * 1024 * 1024
const expectError = (code, status, hiddenPath = '') => error => {
  assert.equal(error.code, code.startsWith('ERR_') ? code : `ERR_WORKSPACE_FILE_${code}`)
  assert.equal(error.status, status)
  assert.equal(error.statusCode, status)
  if (hiddenPath) assert.equal(error.message.includes(hiddenPath), false)
  return true
}
async function setup(t) {
  const base = await mkdtemp(join(tmpdir(), 'deva-workspace-files-'))
  const root = join(base, 'granted'); const alpha = join(root, 'alpha'); const beta = join(root, 'beta')
  const outside = join(base, 'ungranted')
  await Promise.all([mkdir(alpha, { recursive: true }), mkdir(beta, { recursive: true }), mkdir(outside)])
  const catalog = openWorkspaceCatalog({ root, privateRoots: [outside] })
  const cleanup = []
  t.after(async () => {
    catalog.close()
    for (const prepare of cleanup) await prepare()
    await rm(base, { recursive: true, force: true })
  })
  const lookup = name => catalog.list().find(item => item.name === name).id
  return { base, root, alpha, beta, outside, catalog, lookup, cleanup, id: lookup('alpha'), other: lookup('beta'), files: openWorkspaceFiles({ catalog, writable: true }) }
}

// Real file operations run throughout. This wrapper schedules an external filesystem
// mutation exactly at an identity checkpoint without relying on timers or system load.
function atCheckpoint(catalog, trigger) {
  return openWorkspaceFiles({ writable: true, catalog: {
    pinProject(id) {
      const pinned = catalog.pinProject(id)
      let calls = 0
      return { ...pinned, assertCurrent() { trigger(++calls); pinned.assertCurrent() } }
    }
  } })
}

test('catalog grants isolate projects; listing is single-level, sorted and project-relative', async t => {
  const { files, id, other, alpha, beta, catalog, base } = await setup(t)
  await mkdir(join(alpha, 'nested'))
  await mkdir(join(alpha, 'b-dir'))
  for (const [where, data] of [[join(alpha, 'z.txt'), 'alpha'], [join(alpha, 'a.txt'), 'a'],
    [join(alpha, 'nested', 'readme'), 'hello'], [join(beta, 'z.txt'), 'beta'], [join(beta, 'unique'), 'beta only']]) await writeFile(where, data)
  assert.deepEqual(await files.list(id), { path: '', writable: true, entries: [
    { name: 'b-dir', path: 'b-dir', type: 'dir' }, { name: 'nested', path: 'nested', type: 'dir' },
    { name: 'a.txt', path: 'a.txt', type: 'file' }, { name: 'z.txt', path: 'z.txt', type: 'file' }
  ] })
  assert.deepEqual(await files.list(id, 'nested'), { path: 'nested', writable: true, entries: [{ name: 'readme', path: 'nested/readme', type: 'file' }] })
  assert.equal((await files.read(id, 'z.txt')).content, 'alpha')
  assert.equal((await files.read(other, 'z.txt')).content, 'beta')
  await assert.rejects(files.read(id, 'unique'), expectError('NOT_FOUND', 404, base))
  const alphaEdit = await files.read(id, 'z.txt')
  await assert.rejects(files.write(other, { path: 'z.txt', content: 'stale edit', revision: alphaEdit.revision }), expectError('CONFLICT', 409))
  assert.equal((await files.read(other, 'z.txt')).content, 'beta')
  await assert.rejects(files.list(`w_${'0'.repeat(32)}`), expectError('ERR_WORKSPACE_UNAVAILABLE', 404, base))
  await assert.rejects(openWorkspaceFiles({ catalog: openWorkspaceCatalog({}) }).list(id), expectError('ERR_WORKSPACE_UNAVAILABLE', 404))
  const readonly = openWorkspaceFiles({ catalog, writable: 'true' })
  assert.equal((await readonly.list(id)).writable, false)
})

test('dot paths, traversal, invalid encodings and links/special files stay out of the file boundary', async t => {
  const { files, id, alpha, outside, base, cleanup } = await setup(t)
  const secret = join(outside, 'secret.txt')
  await writeFile(secret, 'private')
  await mkdir(join(alpha, '.git'))
  await writeFile(join(alpha, '.git', 'config'), 'private')
  await writeFile(join(alpha, '.env'), 'private')
  await writeFile(join(alpha, 'open.txt'), 'open')
  await writeFile(join(alpha, 'foo\u0085.txt'), 'private')
  await writeFile(Buffer.concat([Buffer.from(alpha + '/invalid-'), Buffer.from([0xff])]), 'private')
  await symlink(outside, join(alpha, 'escape'))
  await symlink(secret, join(alpha, 'symbolic.txt'))
  await symlink('open.txt', join(alpha, 'inside-link.txt'))
  await link(secret, join(alpha, 'hard.txt'))
  execFileSync('mkfifo', [join(alpha, 'pipe')])
  const socket = createServer()
  await new Promise((resolve, reject) => socket.once('error', reject).listen(join(alpha, 'socket'), resolve))
  cleanup.push(() => new Promise(resolve => socket.close(() => resolve())))
  assert.deepEqual((await files.list(id)).entries, [{ name: 'open.txt', path: 'open.txt', type: 'file' }])
  for (const badPath of [secret, '../ungranted/secret.txt', '.env', '.git/config', './open.txt', 'escape/../open.txt',
    'C:open.txt', 'nested/C:open.txt', 'a\\b', 'a//b', 'a/', 'a\0b', 'a\u0085b', 'a\ud800b', 'a'.repeat(256), Array(17).fill('a').join('/')]) {
    await assert.rejects(files.read(id, badPath), expectError('PATH', 400, base))
    await assert.rejects(files.write(id, { path: badPath, content: 'tamper', revision: fakeRevision }), expectError('PATH', 400, base))
  }
  for (const unsafe of ['escape/secret.txt', 'symbolic.txt', 'inside-link.txt', 'hard.txt', 'pipe', 'socket']) {
    await assert.rejects(files.read(id, unsafe), expectError('UNSAFE', 403, base))
    await assert.rejects(files.write(id, { path: unsafe, content: 'tamper', revision: fakeRevision }), expectError('UNSAFE', 403, base))
  }
  await assert.rejects(files.list(id, 'escape'), expectError('UNSAFE', 403, base))
  assert.equal(await readFile(secret, 'utf8'), 'private')
})

test('UTF-8/BOM/line endings survive round trips; binary and oversized reads are explicit', async t => {
  const { files, id, alpha } = await setup(t)
  const content = '\ufeff蕃\r\nemoji: 🧭\nnext line:\u0085trailing\r'
  await Promise.all([
    writeFile(join(alpha, 'utf8.txt'), content), writeFile(join(alpha, 'bad-utf8'), Buffer.from([0xc3, 0x28])),
    writeFile(join(alpha, 'binary'), Buffer.from([0x61, 0x00, 0x62])), writeFile(join(alpha, 'empty'), ''),
    writeFile(join(alpha, 'boundary'), Buffer.alloc(maxBytes, 0x61)), writeFile(join(alpha, 'large'), Buffer.alloc(maxBytes + 1, 0x61))
  ])
  const first = await files.read(id, 'utf8.txt')
  assert.equal(first.content, content)
  assert.match(first.revision, /^r_[0-9a-f]{64}$/)
  const next = await files.write(id, { path: first.path, revision: first.revision, content })
  assert.notEqual(next.revision, first.revision)
  assert.equal((await files.read(id, 'utf8.txt')).revision, next.revision)
  assert.deepEqual(await readFile(join(alpha, 'utf8.txt')), Buffer.from(content))
  assert.equal((await files.read(id, 'empty')).content, '')
  assert.equal((await files.read(id, 'boundary')).content.length, maxBytes)
  for (const path of ['binary', 'bad-utf8']) assert.deepEqual(await files.read(id, path), { path, content: null, binary: true, revision: null, writable: false })
  assert.deepEqual(await files.read(id, 'large'), { path: 'large', content: null, tooLarge: true, revision: null, writable: false })
  await assert.rejects(files.write(id, { path: first.path, revision: next.revision, content: 'é'.repeat(maxBytes / 2 + 1) }), expectError('LIMIT', 413))
  await assert.rejects(files.write(id, { path: first.path, revision: next.revision, content: '\ud800' }), expectError('PATH', 400))
})

test('operator opt-in and Unix permissions are enforced; replacement preserves mode and ownership', async t => {
  const { catalog, files, id, alpha, cleanup } = await setup(t)
  await mkdir(join(alpha, 'ro'))
  for (const name of ['mutable', 'mode-ro', 'no-read', 'ro/nested']) await writeFile(join(alpha, name), 'one')
  await chmod(join(alpha, 'mutable'), 0o640)
  await chmod(join(alpha, 'mode-ro'), 0o444)
  await chmod(join(alpha, 'no-read'), 0o200)
  await chmod(join(alpha, 'ro'), 0o555)
  cleanup.push(() => chmod(join(alpha, 'ro'), 0o755))
  const readonly = openWorkspaceFiles({ catalog })
  const fromReadonly = await readonly.read(id, 'mutable')
  assert.equal(fromReadonly.writable, false)
  await assert.rejects(readonly.write(id, { ...fromReadonly, content: 'two' }), expectError('READ_ONLY', 403))
  assert.equal((await files.list(id, 'ro')).writable, false)
  for (const name of ['mode-ro', 'ro/nested']) {
    const entry = await files.read(id, name)
    assert.equal(entry.writable, false)
    await assert.rejects(files.write(id, { ...entry, content: 'two' }), expectError('READ_ONLY', 403))
  }
  await assert.rejects(files.read(id, 'no-read'), expectError('UNSAFE', 403))
  const before = await lstat(join(alpha, 'mutable'))
  assert.equal((await files.read(id, 'mutable')).writable, true)
  const saved = await files.write(id, { ...fromReadonly, content: 'two' })
  const after = await lstat(join(alpha, 'mutable'))
  assert.notEqual(after.ino, before.ino)
  assert.deepEqual([after.mode, after.uid, after.gid], [before.mode, before.uid, before.gid])
  assert.equal((await files.read(id, 'mutable')).revision, saved.revision)
  assert.deepEqual((await readdir(alpha)).filter(name => name.startsWith('.workspace-file-')), [])
})

test('two tabs with the same revision race; external replacements and edits cause explicit conflict', async t => {
  const { files, id, alpha } = await setup(t)
  const file = join(alpha, 'doc')
  await writeFile(file, 'initial')
  const one = await files.read(id, 'doc'); const two = await files.read(id, 'doc')
  assert.equal(one.revision, two.revision)
  const attempts = await Promise.allSettled([files.write(id, { ...one, content: 'first tab' }), files.write(id, { ...two, content: 'second tab' })])
  assert.equal(attempts[0].status, 'fulfilled')
  assert.equal(attempts[1].status, 'rejected')
  expectError('CONFLICT', 409)(attempts[1].reason)
  assert.equal(await readFile(file, 'utf8'), 'first tab')
  const prior = await files.read(id, 'doc')
  await writeFile(file, 'externally changed')
  await assert.rejects(files.write(id, { ...prior, content: 'attempt' }), expectError('CONFLICT', 409))
  const newPrior = await files.read(id, 'doc')
  await rename(file, join(alpha, '.saved'))
  await writeFile(file, newPrior.content)
  await assert.rejects(files.write(id, { ...newPrior, content: 'attempt' }), expectError('CONFLICT', 409))
  await rm(file)
  await assert.rejects(files.write(id, { ...newPrior, content: 'attempt' }), expectError('CONFLICT', 409))
  await assert.rejects(files.read(id, 'doc'), expectError('NOT_FOUND', 404))
})

test('directory, file and project swaps during a pinned operation are surfaced without writing to substitutes', async t => {
  const { catalog, files, id, lookup, alpha, root, base } = await setup(t)
  const folder = join(alpha, 'nested'); const moved = join(base, 'moved-out')
  await mkdir(folder)
  await writeFile(join(folder, 'doc'), 'original')
  const original = await files.read(id, 'nested/doc')
  const onRead = atCheckpoint(catalog, calls => {
    if (calls !== 5) return
    renameSync(join(folder, 'doc'), join(folder, '.old'))
    writeFileSync(join(folder, 'doc'), 'replacement')
  })
  await assert.rejects(onRead.read(id, original.path), expectError('CONFLICT', 409, base))
  const current = await files.read(id, original.path)
  let movedDuringWrite = false
  const onWrite = atCheckpoint(catalog, () => {
    if (movedDuringWrite || !readdirSync(folder).some(name => name.startsWith('.workspace-file-'))) return
    movedDuringWrite = true
    renameSync(folder, moved)
    mkdirSync(folder)
    writeFileSync(join(folder, 'doc'), 'decoy')
  })
  await assert.rejects(onWrite.write(id, { ...current, content: 'attempt' }), expectError('CONFLICT', 409, base))
  assert.equal(movedDuringWrite, true)
  assert.equal(await readFile(join(moved, 'doc'), 'utf8'), 'replacement')
  assert.equal(await readFile(join(folder, 'doc'), 'utf8'), 'decoy')
  assert.deepEqual((await readdir(moved)).sort(), ['.old', 'doc'])
  const lease = catalog.pinProject(id)
  try {
    await rename(alpha, join(root, '.retired'))
    await mkdir(alpha)
    assert.throws(() => lease.assertCurrent(), expectError('ERR_WORKSPACE_UNAVAILABLE', 404, base))
  } finally { lease.close() }
  await assert.rejects(files.read(id, original.path), expectError('ERR_WORKSPACE_UNAVAILABLE', 404, base))
  const currentId = lookup('alpha')
  assert.notEqual(currentId, id)
  await rename(root, join(base, '.retired-root'))
  await mkdir(root)
  await assert.rejects(files.list(currentId), expectError('ERR_WORKSPACE_UNAVAILABLE', 404, base))
})

test('private root aliases and symlinked catalog-root ancestors are excluded', async t => {
  const { alpha, base, root } = await setup(t)
  const privateAlias = join(base, 'private-alias')
  await symlink(alpha, privateAlias)
  assert.throws(() => openWorkspaceCatalog({ root, privateRoots: [privateAlias] }), expectError('ERR_WORKSPACE_UNAVAILABLE', 404, base))
  const rootAlias = join(base, 'root-alias')
  await symlink(root, rootAlias)
  assert.throws(() => openWorkspaceCatalog({ root: join(rootAlias, 'alpha') }), expectError('ERR_WORKSPACE_UNAVAILABLE', 404, base))
})

test('large directory scans stop at the cap and return no partial listing', async t => {
  const { files, id, alpha } = await setup(t)
  for (let i = 0; i <= 4096; i++) writeFileSync(join(alpha, `.hidden-${i}`), '')
  await assert.rejects(files.list(id), expectError('LIMIT', 413))
})
