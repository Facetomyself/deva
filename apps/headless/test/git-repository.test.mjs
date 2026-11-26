import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync, fstatSync, linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { Worker } from 'node:worker_threads'
import { openWorkspaceCatalog } from '../src/business/workspace-catalog.mjs'
import { openGitIo } from '../src/git/repository.mjs'
import { readGitRefs } from '../src/git/refs.mjs'

const GIT = '/usr/bin/git'
const a = 'a'.repeat(40)
const b = 'b'.repeat(40)
const linux = { skip: process.platform !== 'linux' }

function fixture(t, init = true) {
  const base = mkdtempSync(join(tmpdir(), 'dsh-git-repository-'))
  const root = join(base, 'project')
  mkdirSync(root)
  const catalog = openWorkspaceCatalog({ root: base })
  const project = catalog.pinProject(catalog.list()[0].id)
  const views = []
  t.after(() => {
    for (const io of views) io.close()
    project.close()
    catalog.close()
    const path = resolve(base)
    assert.ok(path.startsWith(resolve(tmpdir()) + sep + 'dsh-git-repository-'))
    rmSync(path, { recursive: true, force: true })
  })
  const git = (...args) => execFileSync(GIT, ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LANG: 'C.UTF-8' },
  }).trim()
  const meta = rel => join(root, '.git', rel)
  const work = rel => join(root, rel)
  const open = () => {
    project.assertCurrent()
    const io = openGitIo(project)
    views.push(io)
    return io
  }
  if (init) git('init', '--quiet', '--initial-branch=main', '--object-format=sha1', '--template=')
  return { base, root, project, meta, work, open, git }
}

function commit(f, content) {
  writeFileSync(f.work('hello.txt'), content)
  f.git('add', '--', 'hello.txt')
  f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', content)
  return f.git('rev-parse', 'HEAD')
}

test('uses a real granted root; missing files and empty unborn HEAD remain distinct', linux, t => {
  const f = fixture(t, false)
  const nonRepo = f.open()
  assert.equal(nonRepo.state, 'not_repo')
  assert.equal(nonRepo.marker('MERGE_HEAD'), false)
  assert.equal(nonRepo.workFile('absent.txt', 3).state, 'missing')
  nonRepo.verify()
  nonRepo.close()

  f.git('init', '--quiet', '--initial-branch=main', '--object-format=sha1', '--template=')
  const io = f.open()
  assert.equal(io.state, 'ready')
  assert.equal(io.readMeta('index', 4), null)
  assert.equal(io.readMeta('refs/heads/nested/missing', 4), null)
  assert.deepEqual(io.listMeta('refs/remotes', 5), [])
  assert.throws(() => io.readMeta('HEAD', 1), { code: 'git_limit' })
  assert.deepEqual(readGitRefs(io), {
    branch: 'main', head: null, detached: false, unborn: true, mergeInProgress: false,
    branches: [], shallow: new Set(), limitations: [],
  })
  io.verify()
  io.close()
  rmSync(f.meta('HEAD'))
  assert.throws(() => readGitRefs(f.open()), { code: 'git_corrupt' })
})

test('merges real loose and packed SHA-1 refs with Unicode, remote aliases and detached HEAD', linux, t => {
  const f = fixture(t)
  const first = commit(f, 'initial')
  f.git('branch', '主题/équipe')
  f.git('update-ref', 'refs/remotes/origin/topic/deep', first)
  f.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/topic/deep')
  f.git('tag', 'unlisted')
  f.git('pack-refs', '--all')
  const second = commit(f, 'second')
  assert.notEqual(first, second)
  writeFileSync(f.meta('shallow'), `${first}\n`)
  writeFileSync(f.meta('MERGE_HEAD'), `${first}\n`)
  const io = f.open()
  assert.deepEqual(io.listMeta('refs/heads', 8), [{ name: 'main', type: 'file' }])
  assert.throws(() => io.listMeta('refs/heads', 0), { code: 'git_limit' })
  assert.ok(io.readMeta(`objects/${second.slice(0, 2)}/${second.slice(2)}`, 4096).length > 0)
  assert.match(io.readMeta('packed-refs', 4096).toString('utf8'), /refs\/heads\/主题\/équipe/u)
  assert.deepEqual(readGitRefs(io), {
    branch: 'main', head: second, detached: false, unborn: false, mergeInProgress: true,
    branches: [
      { name: 'main', current: true, remote: null },
      { name: '主题/équipe', current: false, remote: null },
      { name: 'origin/topic/deep', current: false, remote: 'origin' },
    ],
    shallow: new Set([first]), limitations: ['shallow'],
  })
  io.verify()
  writeFileSync(f.meta('HEAD'), `${first}\n`)
  assert.throws(() => io.verify(), { code: 'git_stale' })
  const detached = readGitRefs(f.open())
  assert.deepEqual([detached.branch, detached.head, detached.detached, detached.unborn], [null, first, true, false])
  assert.ok(detached.branches.every(ref => ref.current === false))
})

test('excludes nonallowlisted metadata and reads pack names only in the fixed namespace', linux, t => {
  const f = fixture(t)
  const oid = commit(f, 'packed')
  f.git('repack', '-adq')
  const packed = f.open()
  const entries = packed.listMeta('objects/pack', 5)
  assert.equal(entries.length, 2)
  for (const { name, type } of entries) {
    assert.match(name, /^pack-[a-f0-9]{40}\.(?:idx|pack)$/u)
    assert.equal(type, 'file')
    assert.ok(packed.readMeta(`objects/pack/${name}`, 65536).length > 0)
  }
  packed.verify()
  packed.close()

  // These paths are rejected before any traversal or data open, even when they exist.
  for (const path of ['config', 'hooks', 'logs/HEAD', 'info/attributes', 'refs/tags/unlisted',
    '.gitmodules', 'objects/info/alternates', '../hello.txt', '/etc/passwd', 'refs/heads/a\\b',
    `objects/${oid.slice(0, 2)}/${oid.slice(2)}.bad`, `objects/pack/${entries[0].name}/extra`]) {
    assert.throws(() => packed.readMeta(path, 1024), { code: 'git_unsafe' })
    assert.throws(() => packed.listMeta(path, 10), { code: 'git_unsafe' })
  }
  assert.throws(() => packed.marker('config'), { code: 'git_unsafe' })
  assert.throws(() => packed.readMeta(`refs/heads/${Array(16).fill('nested').join('/')}`, 1024), { code: 'git_limit' })
  writeFileSync(f.meta('config'), 'not a parseable Git config\n')
  const io = f.open()
  assert.equal(readGitRefs(io).head, oid)
  io.verify()
})

test('unsupported layouts use type or existence and never follow links or pointer files', linux, t => {
  const f = fixture(t, false)
  const outside = join(f.base, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'HEAD'), `${a}\n`)
  for (const kind of ['gitfile', 'symlink', 'commondir', 'gitdir', 'reftable', 'objects/info/alternates',
    'objects/info/http-alternates', 'info/grafts', 'refs/replace', `objects/pack/pack-${a}.promisor`,
    `objects/pack/pack-${'f'.repeat(64)}.idx`]) {
    if (kind === 'gitfile') writeFileSync(f.work('.git'), `gitdir: ${outside}\n`)
    else if (kind === 'symlink') symlinkSync(outside, f.work('.git'))
    else {
      f.git('init', '--quiet', '--initial-branch=main', '--object-format=sha1', '--template=')
      if (['refs/replace', 'reftable'].includes(kind)) mkdirSync(f.meta(kind))
      else {
        mkdirSync(dirname(f.meta(kind)), { recursive: true })
        symlinkSync(outside, f.meta(kind))
      }
    }
    const io = f.open()
    assert.equal(io.state, 'unsupported_layout', kind)
    assert.throws(() => io.readMeta('HEAD', 64), { code: 'unsupported_git_layout' })
    io.verify()
    io.close()
    const path = resolve(f.work('.git'))
    assert.equal(path, f.root + sep + '.git')
    rmSync(path, { recursive: true, force: true })
  }
})

test('rejects replace refs and unsupported object formats stored in parseable metadata', linux, t => {
  const f = fixture(t)
  writeFileSync(f.meta('packed-refs'), `${b} refs/replace/${a}\n`)
  assert.throws(() => readGitRefs(f.open()), { code: 'unsupported_git_layout' })
  writeFileSync(f.meta('packed-refs'), `${b} refs/heads/valid\n${a} refs/heads/valid\n`)
  assert.throws(() => readGitRefs(f.open()), { code: 'git_corrupt' })
  writeFileSync(f.meta('HEAD'), `ref: refs/remotes/origin/main\n`)
  assert.throws(() => readGitRefs(f.open()), { code: 'unsupported_git_layout' })
  writeFileSync(f.meta('HEAD'), `${'9'.repeat(64)}\n`)
  assert.throws(() => readGitRefs(f.open()), { code: 'unsupported_git_layout' })
})

test('working file states enforce names, content signatures, type, links and permission', linux, t => {
  const f = fixture(t)
  const outside = join(f.base, 'other.txt')
  writeFileSync(outside, 'outside')
  chmodSync(f.work('.git'), 0o700)
  symlinkSync(outside, f.work('symlink.txt'))
  symlinkSync(f.base, f.work('outside-dir'))
  linkSync(outside, f.work('hardlink.txt'))
  linkSync(outside, f.meta('index'))
  writeFileSync(f.work('credentials.json'), '{}')
  writeFileSync(f.work('.env'), 'sensitive name')
  writeFileSync(f.work('sample.txt'), 'comment\n-----BEGIN OPENSSH PRIVATE KEY-----\n')
  writeFileSync(f.work('denied.txt'), 'unreadable', { mode: 0 })
  mkdirSync(f.work('locked'))
  writeFileSync(f.work('locked/document.txt'), 'unsearchable')
  writeFileSync(f.work('public.txt'), 'hello', { mode: 0o755 })
  writeFileSync(f.work('group-execute.txt'), 'hello')
  chmodSync(f.work('group-execute.txt'), 0o654)
  chmodSync(f.work('locked'), 0o600)
  try {
    const io = f.open()
    assert.deepEqual(io.workFile('public.txt', 5), { state: 'regular', bytes: Buffer.from('hello'), executable: true })
    assert.deepEqual(io.workFile('group-execute.txt', 5), { state: 'regular', bytes: Buffer.from('hello'), executable: false })
    assert.deepEqual(io.workFile('public.txt', 4), { state: 'too_large' })
    assert.deepEqual(io.workFile('missing', 4), { state: 'missing' })
    for (const path of ['public.txt/no', '../other.txt', '/etc/passwd', 'symlink.txt', 'outside-dir/other.txt',
      'hardlink.txt', 'credentials.json', '.env', 'sample.txt', 'denied.txt', 'locked/document.txt', '.git/HEAD']) {
      assert.deepEqual(io.workFile(path, 4096), { state: 'unsafe' }, path)
    }
    assert.throws(() => io.readMeta('index', 25), { code: 'git_unsafe' })
    io.verify()
  } finally { chmodSync(f.work('locked'), 0o700) }
})

test('pins special file types without opening them for data', linux, async t => {
  const f = fixture(t)
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(f.work('special.sock'), resolve)
  })
  try {
    symlinkSync(f.work('special.sock'), f.meta('shallow'))
    const io = f.open()
    assert.deepEqual(io.workFile('special.sock', 4096), { state: 'unsafe' })
    assert.throws(() => io.readMeta('shallow', 4096), { code: 'git_unsafe' })
    io.verify()
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('enforces cumulative read budget across metadata and work files', linux, t => {
  const f = fixture(t)
  writeFileSync(f.meta('index'), '')
  writeFileSync(f.work('large.bin'), '')
  truncateSync(f.meta('index'), 32 * 1024 * 1024)
  truncateSync(f.work('large.bin'), 33 * 1024 * 1024)
  const io = f.open()
  assert.equal(io.readMeta('index', 64 * 1024 * 1024).length, 32 * 1024 * 1024)
  assert.throws(() => io.workFile('large.bin', 64 * 1024 * 1024), { code: 'git_limit' })
  assert.throws(() => io.readMeta('index', -1), { code: 'git_limit' })
  io.verify()
})

test('detects changes to nested observed leaves and a replaced granted directory', linux, t => {
  const f = fixture(t)
  mkdirSync(f.work('docs'))
  writeFileSync(f.work('docs/file.txt'), 'one')
  const io = f.open()
  assert.equal(io.workFile('docs/file.txt', 100).bytes.toString(), 'one')
  assert.deepEqual(io.workFile('docs/absent.txt', 100), { state: 'missing' })
  writeFileSync(f.work('docs/file.txt'), 'two')
  assert.throws(() => io.verify(), { code: 'git_stale' })
  assert.throws(() => io.workFile('docs/file.txt', 100), { code: 'git_stale' })
  const fresh = f.open()
  const old = resolve(f.root)
  assert.equal(old, f.base + sep + 'project')
  renameSync(old, join(f.base, 'previous'))
  mkdirSync(f.root)
  assert.throws(() => fresh.verify(), { code: 'git_stale' })
  assert.throws(() => f.project.assertCurrent(), { code: 'ERR_WORKSPACE_UNAVAILABLE' })
})

test('worker thread owns its copied pin; wrong mount and closed views fail with domain codes', linux, async t => {
  const f = fixture(t)
  assert.throws(() => openGitIo({ fd: f.project.fd, mount: '0' }), { code: 'git_stale' })
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const fs = require('node:fs');
    import(workerData.module).then(({openGitIo}) => {
      const native = fs.fstatSync;
      fs.fstatSync = function(fd, options) {
        const stat = native(fd, options);
        if (options?.bigint && stat.isDirectory()) stat.birthtimeNs = process.hrtime.bigint();
        return stat;
      };
      require('node:module').syncBuiltinESMExports();
      const io = openGitIo(workerData);
      const state = io.state;
      io.verify();
      io.close(); io.close();
      try { io.verify(); } catch (error) { parentPort.postMessage([state, error.code]); }
    }).catch(error => { throw error; });
  `, { eval: true, workerData: { module: new URL('../src/git/repository.mjs', import.meta.url).href,
    fd: f.project.fd, mount: f.project.mount } })
  const result = await new Promise((res, rej) => {
    worker.once('message', res)
    worker.once('error', rej)
    worker.once('exit', code => rej(new Error(`worker exit ${code}`)))
  })
  assert.deepEqual(result, ['ready', 'git_stale'])
  assert.ok(fstatSync(f.project.fd).isDirectory())
  f.project.assertCurrent()
})
