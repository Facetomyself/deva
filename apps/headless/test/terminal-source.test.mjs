import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync,
  realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import test from 'node:test'
import { openWorkspaceCatalog } from '../src/business/workspace-catalog.mjs'
import { openWorkspaceFiles, workspaceTextRevision } from '../src/files/workspace-files.mjs'
import { openTerminalSource } from '../src/terminal/source.mjs'

const linux = { skip: process.platform !== 'linux' }
const fakeRevision = `r_${'0'.repeat(64)}`
const maxBytes = 64 * 1024, maxLines = 4096
const identity = info => [info.dev, info.ino]
const info = path => statSync(path, { bigint: true })
const problem = (status, suffix) => error => {
  const code = `terminal_${suffix}`
  assert.equal(error.message, code)
  assert.deepEqual({ ...error }, { status, code })
  assert.equal(error.path, undefined)
  assert.equal(error.cause, undefined)
  return true
}
const stale = problem(409, 'source_changed')

function setup(t) {
  const temp = realpathSync.native(tmpdir())
  const base = mkdtempSync(join(temp, 'deva-terminal-source-'))
  const original = lstatSync(base, { bigint: true })
  const root = join(base, 'granted'), project = join(root, 'alpha'), other = join(root, 'beta')
  const outside = join(base, 'outside')
  const sources = []
  let catalog
  t.after(() => {
    try {
      for (const source of sources) source.close()
    } finally {
      catalog?.close()
      const current = lstatSync(base, { bigint: true })
      assert.ok(isAbsolute(base) && dirname(base) === temp)
      assert.match(basename(base), /^deva-terminal-source-[A-Za-z0-9]{6}$/)
      assert.equal(realpathSync.native(base), base)
      assert.ok(current.isDirectory())
      assert.equal(current.uid, BigInt(process.geteuid()))
      assert.equal(current.mode & 0o077n, 0n)
      assert.deepEqual(identity(current), identity(original))
      rmSync(base, { recursive: true })
    }
  })
  for (const dir of [project, other, outside]) mkdirSync(dir, { recursive: true })
  catalog = openWorkspaceCatalog({ root, privateRoots: [outside] })
  const projects = new Map(catalog.list().map(({ name, id }) => [name, id]))
  const wid = projects.get('alpha'), otherId = projects.get('beta')
  const files = openWorkspaceFiles({ catalog })
  function open(path, revision, id = wid) {
    const source = openTerminalSource(catalog, id, path, revision)
    sources.push(source)
    return source
  }
  return { base, root, project, other, outside, wid, otherId, catalog, files, open,
    async revision(path) { return (await files.read(wid, path)).revision },
  }
}

test('terminal source preserves exact UTF-8 and accepts the empty and inclusive limits', linux, async t => {
  const f = setup(t)
  for (const [path, content] of [
    ['utf8.txt', '\ufeff蕃\r\nemoji: 🧭\nnext\r'], ['empty.txt', ''],
    ['byte-limit.txt', 'é'.repeat(maxBytes / 2)], ['line-limit.txt', 'x\n'.repeat(maxLines - 1) + 'last'],
  ]) {
    writeFileSync(join(f.project, path), content)
    const source = f.open(path, await f.revision(path))
    assert.equal(source.text, content)
    assert.doesNotThrow(source.verify)
    source.close()
  }
  for (const [path, content] of [
    ['over-bytes.txt', 'é'.repeat(maxBytes / 2) + 'x'], ['over-lines.txt', 'x\n'.repeat(maxLines)],
  ]) {
    writeFileSync(join(f.project, path), content)
    const revision = await f.revision(path)
    assert.throws(() => f.open(path, revision), problem(413, 'limit'))
  }
})

test('valid revisions still reject binary controls and malformed UTF-8', linux, async t => {
  const f = setup(t)
  for (const [path, bytes] of [
    ['binary.dat', Buffer.from([0x61, 0, 0x62])], ['bad-utf8.dat', Buffer.from([0xc3, 0x28])],
  ]) {
    const native = join(f.project, path)
    writeFileSync(native, bytes)
    assert.equal((await f.files.read(f.wid, path)).revision, null)
    const revision = workspaceTextRevision(path, info(native), bytes)
    assert.throws(() => f.open(path, revision), problem(422, 'unsupported'))
  }
})

test('secret names, marker contents, links, FIFO and malformed paths yield redacted errors', linux, async t => {
  const f = setup(t)
  mkdirSync(join(f.project, 'credentials'))
  for (const [path, content] of [
    ['backup.pem', 'synthetic sample'], ['credentials/readme.txt', 'synthetic sample'],
    ['key-example.txt', '# fixture\n-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic sample'],
    ['settings.json', '{"client_secret": "synthetic sample"}'],
  ]) {
    writeFileSync(join(f.project, path), content)
    const revision = await f.revision(path)
    assert.throws(() => f.open(path, revision), problem(403, 'source_denied'))
  }
  const privateFile = join(f.outside, 'private-note.txt')
  writeFileSync(privateFile, 'outside fixture')
  writeFileSync(join(f.project, 'note.txt'), 'inside fixture')
  symlinkSync(privateFile, join(f.project, 'outside-link.txt'))
  symlinkSync('note.txt', join(f.project, 'inside-link.txt'))
  symlinkSync(f.outside, join(f.project, 'linked-dir'))
  linkSync(privateFile, join(f.project, 'hardlink.txt'))
  execFileSync('mkfifo', [join(f.project, 'fifo')], { timeout: 5000 })
  const revision = await f.revision('note.txt')
  for (const path of ['outside-link.txt', 'inside-link.txt', 'linked-dir/private-note.txt', 'hardlink.txt', 'fifo']) {
    assert.throws(() => f.open(path, revision), problem(403, 'source_denied'))
  }
  for (const path of [privateFile, '../outside/private-note.txt', '.env', 'readme//note.txt', 'bad\\name', 'x\0y']) {
    assert.throws(() => f.open(path, revision), problem(400, 'invalid'))
  }
})

test('a source is bound to exactly one granted document and exposes only a text getter and lifecycle', linux, async t => {
  const f = setup(t)
  const text = 'private synthetic snapshot'
  for (const path of [join(f.project, 'note.txt'), join(f.project, 'sibling.txt'), join(f.other, 'note.txt')]) {
    writeFileSync(path, text)
  }
  const revision = await f.revision('note.txt')
  assert.throws(() => f.open('sibling.txt', revision), stale)
  assert.throws(() => f.open('note.txt', revision, f.otherId), stale)
  assert.throws(() => f.open('note.txt', revision, `w_${'0'.repeat(32)}`), problem(404, 'not_found'))
  assert.throws(() => f.open('note.txt', revision, `${f.wid}\n`), problem(400, 'invalid'))
  assert.throws(() => f.open('note.txt', `${revision}\n`), problem(400, 'invalid'))
  const source = f.open('note.txt', revision)
  assert.equal(Object.isFrozen(source), true)
  assert.deepEqual(Reflect.ownKeys(source).sort(), ['close', 'text', 'verify'])
  const { get, set } = Object.getOwnPropertyDescriptor(source, 'text')
  assert.equal(typeof get, 'function')
  assert.equal(set, undefined)
  assert.equal(get(), text)
  assert.equal(typeof source.verify, 'function')
  assert.equal(typeof source.close, 'function')
  f.catalog.close()
  assert.throws(source.verify, stale)
})

test('kernel inode pins reject real name, content version and grant changes', linux, async t => {
  for (const mutation of ['rename parent', 'replace parent', 'replace file', 'replace project', 'replace catalog root',
    'drop parent search permission', 'drift mtime']) {
    await t.test(mutation, async t => {
      const f = setup(t)
      const folder = join(f.project, 'docs'), path = 'docs/note.txt', native = join(f.project, path)
      const text = 'same bytes'; mkdirSync(folder); writeFileSync(native, text)
      const source = f.open(path, await f.revision(path))
      assert.doesNotThrow(source.verify)
      if (mutation === 'drop parent search permission') {
        chmodSync(folder, 0o600)
        try { assert.throws(source.verify, stale) } finally { chmodSync(folder, 0o700) }
        return
      }
      if (mutation === 'drift mtime') {
        const previous = info(native)
        utimesSync(native, Number(previous.atimeMs) / 1000, Number(previous.mtimeMs) / 1000 - 60)
        assert.deepEqual(identity(info(native)), identity(previous))
        assert.ok(info(native).mtimeNs < previous.mtimeNs)
      } else {
        const target = {
          'rename parent': folder, 'replace parent': folder, 'replace file': native,
          'replace project': f.project, 'replace catalog root': f.root,
        }[mutation]
        const previous = info(target), retired = join(f.base, 'retired')
        renameSync(target, retired)
        assert.deepEqual(identity(info(retired)), identity(previous))
        if (mutation !== 'rename parent') {
          if (target !== native) mkdirSync(folder, { recursive: true })
          writeFileSync(native, text)
          assert.equal(info(target).dev, previous.dev)
          assert.notEqual(info(target).ino, previous.ino)
        }
      }
      assert.throws(source.verify, stale)
    })
  }
})

// Node has no xattr API; use the Linux POSIX ACL xattr through Python where available.
const aclScript = `
import errno, os, struct, sys
uid = 65533 if os.geteuid() == 65534 else 65534
entries = [(1, int(sys.argv[2]), 0xffffffff), (2, 0, uid), (4, 0, 0xffffffff),
           (16, 0, 0xffffffff), (32, 0, 0xffffffff)]
acl = struct.pack('<I', 2) + b''.join(struct.pack('<HHI', *entry) for entry in entries)
try:
    os.setxattr(sys.argv[1], 'system.posix_acl_access', acl)
except OSError as exc:
    if exc.errno == errno.EOPNOTSUPP:
        sys.exit(77)
    raise
`
function setAcl(path, permissions) {
  const result = spawnSync('python3', ['-c', aclScript, path, String(permissions)], { timeout: 5000, encoding: 'utf8' })
  if (result.error?.code === 'ENOENT' || result.status === 77) return false
  if (result.error) throw result.error
  assert.equal(result.status, 0, result.stderr)
  return true
}

test('revoking a Linux parent search ACL invalidates the pinned document', linux, async t => {
  const f = setup(t)
  const dir = join(f.project, 'docs'), path = 'docs/note.txt'
  mkdirSync(dir); writeFileSync(join(f.project, path), 'pinned fixture')
  if (!setAcl(dir, 7)) { t.skip('Python or the filesystem POSIX ACL interface is unavailable'); return }
  const source = f.open(path, await f.revision(path))
  try {
    assert.equal(setAcl(dir, 6), true)
    assert.throws(source.verify, stale)
  } finally { chmodSync(dir, 0o700) }
})

function fixtureDescriptors(base) {
  const proc = '/proc/self/fd'
  return readdirSync(proc).flatMap(fd => {
    // readdir may list its own descriptor, which is closed by the time readlink runs.
    try {
      const target = readlinkSync(join(proc, fd))
      return target === base || target.startsWith(`${base}/`) ? [target] : []
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
  }).sort()
}

test('sibling mutations preserve the source; close and failed opens release file and directory fds',
  { ...linux, timeout: 5000 }, async t => {
    const f = setup(t)
    const dir = join(f.project, 'docs'), nested = join(dir, 'nested'), path = 'docs/nested/note.txt'
    mkdirSync(nested, { recursive: true }); writeFileSync(join(f.project, path), 'pinned fixture')
    const revision = await f.revision(path)
    const baseline = fixtureDescriptors(f.base)
    assert.deepEqual(baseline, [f.root])
    for (let i = 0; i < 12; i++) {
      const source = f.open(path, revision)
      const held = fixtureDescriptors(f.base)
      for (const pin of [f.project, dir, nested, join(f.project, path)]) assert.ok(held.includes(pin), pin)
      writeFileSync(join(nested, 'sibling.txt'), `sibling ${i}`)
      renameSync(join(nested, 'sibling.txt'), join(nested, 'sibling-moved.txt'))
      assert.doesNotThrow(source.verify)
      assert.equal(source.text, 'pinned fixture')
      source.close()
      source.close()
      assert.throws(() => source.text, stale)
      assert.throws(source.verify, stale)
      assert.throws(() => f.open(path, fakeRevision), stale)
      assert.deepEqual(fixtureDescriptors(f.base), baseline)
    }
  })
