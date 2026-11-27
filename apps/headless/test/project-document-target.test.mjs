import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync,
  renameSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openWorkspaceCatalog } from '../src/business/workspace-catalog.mjs'
import { openProjectDocumentTarget } from '../src/files/project-document-target.mjs'
import { openWorkspaceFiles, workspaceTextRevision } from '../src/files/workspace-files.mjs'
import { HttpError } from '../src/http/policy.mjs'

const MAX_BYTES = 2 * 1024 * 1024
const owner = () => true
const stageName = folder => readdirSync(folder).find(name => name.startsWith('.project-document-'))
const unavailableId = `w_${'0'.repeat(32)}`
const expect = (status, code) => error => {
  assert.ok(error instanceof HttpError)
  assert.equal(error.status, status)
  assert.equal(error.code, code)
  assert.equal(error.message, code)
  assert.equal(error.cause, undefined)
  return true
}

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'deva-project-document-'))
  const root = join(base, 'granted'); const project = join(root, 'alpha'); const outside = join(base, 'outside')
  mkdirSync(project, { recursive: true }); mkdirSync(outside)
  const catalog = openWorkspaceCatalog({ root, privateRoots: [outside] })
  const id = catalog.list()[0].id
  const leases = []
  t.after(() => {
    for (const lease of leases) lease.close()
    catalog.close()
    rmSync(base, { recursive: true, force: true })
  })
  const open = (name, directory = '', source = catalog) => {
    const lease = openProjectDocumentTarget(source, id, { directory, name })
    leases.push(lease)
    return lease
  }
  return { base, root, project, outside, catalog, id, open, files: openWorkspaceFiles({ catalog, writable: true }) }
}

test('native publish uses exact workspace revisions, mode, and bytes for BOM, CJK, mixed line endings and empty text', async t => {
  const { project, open, files, id } = fixture(t)
  const folder = join(project, '文档'); mkdirSync(folder)
  const content = '\ufeff中文 🧭\r\nLatin: café\t\nline break: \u0085\r'
  const lease = open('项目笔记.MD', '文档')
  assert.equal(lease.path, '文档/项目笔记.MD')
  assert.equal(lease.verifyAbsent(), true)
  let calls = 0
  const previousUmask = process.umask(0o777)
  let saved
  try {
    saved = lease.publish(content, () => {
      calls++
      if (calls === 1) assert.deepEqual(readdirSync(folder), [])
      if (calls === 2) assert.equal(lstatSync(join(folder, stageName(folder))).mode & 0o7777, 0o600)
      if (calls === 3) assert.ok(lstatSync(join(project, lease.path)).isFile())
      return true
    })
  } finally { process.umask(previousUmask) }
  assert.equal(calls, 3)
  assert.match(saved.revision, /^r_[0-9a-f]{64}$/)
  const installed = join(project, lease.path)
  const stat = lstatSync(installed, { bigint: true })
  assert.equal(stat.mode & 0o7777n, 0o600n)
  assert.equal(stat.nlink, 1n)
  assert.equal(stat.uid, BigInt(process.geteuid()))
  assert.deepEqual(readFileSync(installed), Buffer.from(content))
  assert.equal(saved.revision, workspaceTextRevision(lease.path, stat, Buffer.from(content)))
  assert.deepEqual(await files.read(id, lease.path), { path: lease.path, content, revision: saved.revision, writable: true })
  assert.equal(lease.verifyReceipt(saved.revision), true)
  assert.equal(lease.verifyReceipt(saved.revision), true)
  assert.deepEqual(readdirSync(folder), ['项目笔记.MD'])
  assert.throws(() => lease.publish(content, owner), expect(409, 'document_exists'))
  assert.throws(() => lease.verifyAbsent(), expect(409, 'document_exists'))
  assert.throws(() => lease.verifyReceipt(`r_${'0'.repeat(64)}`), expect(409, 'document_changed'))
  assert.deepEqual(lstatSync(installed, { bigint: true }).mtimeNs, stat.mtimeNs)
  lease.close(); lease.close()
  assert.throws(() => lease.verifyReceipt(saved.revision), expect(409, 'document_changed'))
  for (const fd of readdirSync('/proc/self/fd')) {
    let path
    try { path = readlinkSync(`/proc/self/fd/${fd}`) } catch (error) { if (error.code !== 'ENOENT') throw error }
    assert.notEqual(path, folder)
    assert.notEqual(path, installed)
  }
  const empty = open('README.md')
  const result = empty.publish('', owner)
  assert.equal((await files.read(id, 'README.md')).revision, result.revision)
  assert.equal((await files.read(id, 'README.md')).content, '')
})

test('name rules cover ordinary visible files, traversal, Windows aliases, controls and sensitive paths', t => {
  const { open, catalog, project } = fixture(t)
  const rejected = [undefined, 42, '', '.hidden.md', 'a/b.md', '../doc.txt', 'a\\b.md', 'C:doc.md', '\0.md', 'a\u0080.md',
    'a\u202e.md', 'a\u200b.md', 'a\u2028.md', 'a\ud800.md', 'a\ufe0f.md', 'a.md ', 'a.md.', ' a.md', 'a .md', 'a..md',
    'NUL.md', 'PRN.x.txt', 'con .md', 'CONIN$.md', 'LPT².txt', 'Part~1.md', 'team:a.txt', 'a*.md', 'a｜b.md', 'a／b.md',
    'report.markdown', 'report.text', 'script.md.exe']
  for (const name of rejected) assert.throws(() => open(name), expect(400, 'document_invalid'), String(name))
  for (const name of ['AGENTS.md', 'CLAUDE.txt', 'gemini.MD', 'SKILL.md', 'AGENTS.override.md', 'copilot-instructions.md',
    'Dockerfile.md', 'codeowners.txt', 'script.PS1.txt', 'run.ExE.notes.md', 'script.js.md', 'private-key.txt', 'id_rsa.md',
    'api_key.txt', 'access-token.md', 'Key.txt', 'notes.pem.txt', 'ＣＬＡＵＤＥ.md']) {
    assert.throws(() => open(name), expect(422, 'document_restricted'), name)
  }
  for (const directory of ['.', '..', '/var/tmp', '.git', '../alpha', 'a\\b', 'nested/']) {
    assert.throws(() => open('note.md', directory), expect(400, 'document_invalid'), directory)
  }
  for (const directory of ['credentials', 'notes/api_keys', 'u\u202er']) {
    assert.throws(() => open('note.md', directory), expect(422, 'document_restricted'), directory)
  }
  assert.throws(() => open('note.md', 'missing'), expect(404, 'workspace_unavailable'))
  assert.throws(() => open('note.md', Array(16).fill('x').join('/')), expect(413, 'document_limit'))
  assert.throws(() => open(`${'中'.repeat(66)}.md`), expect(413, 'document_limit'))
  assert.equal(open(`${'中'.repeat(65)}xy.md`).verifyAbsent(), true)
  assert.throws(() => openProjectDocumentTarget(catalog, unavailableId, { directory: '', name: 'note.md' }), expect(404, 'workspace_unavailable'))
  assert.throws(() => openProjectDocumentTarget(catalog, project, { directory: '', name: 'note.md' }), expect(404, 'workspace_unavailable'))
  assert.deepEqual(readdirSync(project), [])
})

test('byte cap and reader text validity precede stage creation; recognized credential material is restricted', async t => {
  const { open, project, files, id } = fixture(t)
  const target = open('content.txt')
  for (const content of [null, 17, Buffer.from('bytes'), '\ud800', '\udc00', 'zero\0byte', '\u0003', '\u001b', '\u007f', '\u009f']) {
    assert.throws(() => target.publish(content, () => assert.fail('unexpected authorization')), expect(400, 'document_invalid'))
  }
  for (const content of ['x'.repeat(MAX_BYTES + 1), 'é'.repeat(MAX_BYTES / 2 + 1)]) {
    assert.throws(() => target.publish(content, owner), expect(413, 'document_limit'))
  }
  for (const content of ['prefix\n-----BEGIN OPENSSH PRIVATE KEY-----\n', '{"client_secret":"example"}',
    `ghp_${'SampleToken'.repeat(4)}`, 'EXAMPLE_ACCESS_TOKEN=abcdefgh0123456789']) {
    assert.throws(() => target.publish(content, owner), expect(422, 'document_restricted'))
  }
  assert.deepEqual(readdirSync(project), [])
  const content = 'é'.repeat(MAX_BYTES / 2)
  assert.equal(Buffer.byteLength(content), MAX_BYTES)
  const { revision } = target.publish(content, owner)
  assert.equal((await files.read(id, target.path)).content, content)
  assert.equal(target.verifyReceipt(revision), true)
})

test('all existing entry types and common spelling aliases are non-adoptable', t => {
  const { outside, project, open } = fixture(t)
  const protectedFile = join(outside, 'kept.txt'); writeFileSync(protectedFile, 'outside')
  writeFileSync(join(project, 'existing.md'), 'same')
  writeFileSync(join(project, 'Café.txt'), 'alias')
  writeFileSync(join(project, 'x.txt. '), 'Windows alias')
  mkdirSync(join(project, 'directory.md'))
  symlinkSync(protectedFile, join(project, 'linked.md'))
  symlinkSync('missing', join(project, 'dangling.md'))
  symlinkSync(outside, join(project, 'directory-link'))
  linkSync(protectedFile, join(project, 'hard.txt'))
  execFileSync('mkfifo', [join(project, 'pipe.md')])
  for (const name of ['existing.md', 'EXISTING.MD', 'cafe\u0301.TXT', 'x.txt']) {
    const target = open(name)
    assert.throws(() => target.verifyAbsent(), expect(409, 'document_exists'))
    assert.throws(() => target.publish('same', owner), expect(409, 'document_exists'))
  }
  for (const name of ['directory.md', 'linked.md', 'dangling.md', 'hard.txt', 'PIPE.md']) {
    const target = open(name)
    assert.throws(() => target.verifyAbsent(), expect(403, 'document_unsafe'))
    assert.throws(() => target.publish('same', owner), expect(403, 'document_unsafe'))
  }
  assert.throws(() => open('note.md', 'directory-link'), expect(403, 'document_unsafe'))
  assert.throws(() => open('note.md', 'existing.md'), expect(403, 'document_unsafe'))
  assert.equal(readFileSync(protectedFile, 'utf8'), 'outside')
  assert.equal(stageName(project), undefined)
})

test('permissions and owner checkpoints run before staging and again before the visible link', t => {
  const { open, project } = fixture(t)
  const dir = join(project, 'editable'); mkdirSync(dir)
  const target = open('gate.md', 'editable')
  for (const guard of [undefined, () => false, () => { throw Error(project) }, async () => { throw Error(project) }]) {
    assert.throws(() => target.publish('text', guard), expect(401, 'auth'))
  }
  assert.deepEqual(readdirSync(dir), [])
  let calls = 0
  assert.throws(() => target.publish('text', () => ++calls < 2), expect(401, 'auth'))
  assert.equal(calls, 2)
  assert.deepEqual(readdirSync(dir), [])
  for (const mode of [0o555, 0o300, 0o600, 0o377]) {
    chmodSync(dir, mode)
    try { assert.throws(() => target.publish('text', owner), expect(403, 'document_read_only')) }
    finally { chmodSync(dir, 0o700) }
  }
  calls = 0
  assert.throws(() => target.publish('text', () => {
    if (++calls === 2) chmodSync(dir, 0o500)
    return true
  }), expect(403, 'document_read_only'))
  chmodSync(dir, 0o700)
  const remaining = readdirSync(dir)
  assert.ok(remaining.every(name => name.startsWith('.project-document-')))
  assert.equal(target.verifyAbsent(), true)
  const closing = open('closed.md', 'editable')
  assert.throws(() => closing.publish('text', () => { closing.close(); return true }), expect(409, 'document_changed'))
  assert.deepEqual(readdirSync(dir), remaining)
})

// Node exposes no POSIX ACL API; use Linux's xattr interface when available.
const aclScript = `
import errno, os, struct, sys
path, kind, owner = sys.argv[1:]
uid = 65533 if os.geteuid() == 65534 else 65534
entries = [(1, int(owner), 0xffffffff), (2, 7, uid), (4, 7, 0xffffffff),
           (16, 7, 0xffffffff), (32, 7, 0xffffffff)]
acl = struct.pack('<I', 2) + b''.join(struct.pack('<HHI', *entry) for entry in entries)
try:
    os.setxattr(path, 'system.posix_acl_' + kind, acl)
except OSError as exc:
    if exc.errno == errno.EOPNOTSUPP:
        sys.exit(77)
    raise
`
function setAcl(dir, kind, ownerMode) {
  const result = spawnSync('python3', ['-c', aclScript, dir, kind, String(ownerMode)], { timeout: 5000, encoding: 'utf8' })
  if (result.error?.code === 'ENOENT' || result.status === 77) return false
  if (result.error) throw result.error
  assert.equal(result.status, 0, result.stderr)
  return true
}

test('default POSIX ACL cannot expand the new file mode, and access ACL revocation prevents a write', t => {
  const { open, project } = fixture(t)
  const dir = join(project, 'acl'); mkdirSync(dir)
  if (!setAcl(dir, 'default', 7)) return t.skip('Python or the filesystem POSIX ACL interface is unavailable')
  const target = open('note.txt', 'acl')
  const { revision } = target.publish('test', owner)
  assert.equal(lstatSync(join(dir, 'note.txt')).mode & 0o7777, 0o600)
  const blocked = open('another.md', 'acl')
  assert.equal(setAcl(dir, 'access', 5), true)
  assert.equal(target.verifyReceipt(revision), true)
  assert.throws(() => blocked.publish('text', owner), expect(403, 'document_read_only'))
  assert.deepEqual(readdirSync(dir), ['note.txt'])
  chmodSync(dir, 0o700)
})

test('pinned parent, project and catalog-root swaps fail before touching a substitute', t => {
  const { base, root, project, open } = fixture(t)
  const dir = join(project, 'nested'); mkdirSync(dir)
  const moved = join(project, 'old-nested')
  const lease = open('note.md', 'nested')
  let calls = 0
  assert.throws(() => lease.publish('first', () => {
    if (++calls === 2) {
      renameSync(dir, moved); mkdirSync(dir)
      writeFileSync(join(dir, 'note.md'), 'decoy')
    }
    return true
  }), expect(409, 'document_changed'))
  assert.deepEqual(readdirSync(moved), [])
  assert.equal(readFileSync(join(dir, 'note.md'), 'utf8'), 'decoy')
  const atProject = open('project.md')
  renameSync(project, join(root, 'old-alpha')); mkdirSync(project)
  assert.throws(() => atProject.verifyAbsent(), expect(404, 'workspace_unavailable'))
  assert.throws(() => atProject.publish('second', owner), expect(404, 'workspace_unavailable'))
  assert.deepEqual(readdirSync(project), [])
  renameSync(root, join(base, 'old-root')); mkdirSync(project, { recursive: true })
  assert.throws(() => atProject.publish('third', owner), expect(404, 'workspace_unavailable'))
  assert.deepEqual(readdirSync(project), [])
})

test('receipt rejects external metadata changes, writes, aliases and equal-byte inode substitutions', t => {
  const { project, open } = fixture(t)
  for (const [name, mutate] of [
    ['mtime.md', path => utimesSync(path, 1000, 1000)],
    ['bytes.md', path => writeFileSync(path, 'evil')],
    ['alias.md', () => writeFileSync(join(project, 'ALIAS.MD'), 'decoy')],
    ['equal.md', path => {
      const existing = lstatSync(path)
      renameSync(path, `${path}.old`)
      writeFileSync(path, 'same', { mode: 0o600 }); utimesSync(path, existing.atime, existing.mtime)
      assert.notEqual(lstatSync(path).ino, existing.ino)
    }],
  ]) {
    const target = open(name)
    const { revision } = target.publish('same', owner)
    mutate(join(project, name))
    assert.throws(() => target.verifyReceipt(revision), expect(409, 'document_changed'), name)
  }
  assert.equal(readFileSync(join(project, 'equal.md'), 'utf8'), 'same')
  assert.equal(readFileSync(join(project, 'ALIAS.MD'), 'utf8'), 'decoy')
})

test('directory scan caps cover hidden entries and do not leave a stage', async t => {
  const { project, open, files, id } = fixture(t)
  const floor = join(project, 'many'); mkdirSync(floor)
  for (let i = 0; i < 4095; i++) writeFileSync(join(floor, `.other-${i}`), '')
  const within = open('last.md', 'many')
  const { revision } = within.publish('', owner)
  assert.equal(within.verifyReceipt(revision), true)
  const list = await files.list(id, 'many')
  assert.deepEqual(list.entries, [{ name: 'last.md', path: 'many/last.md', type: 'file' }])
  const beyond = open('overflow.md', 'many')
  assert.throws(() => beyond.verifyAbsent(), expect(413, 'document_limit'))
  assert.throws(() => beyond.publish('', owner), expect(413, 'document_limit'))
  assert.equal(stageName(floor), undefined)
})
