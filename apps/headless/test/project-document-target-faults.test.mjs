import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openWorkspaceCatalog } from '../src/business/workspace-catalog.mjs'
import { openProjectDocumentTarget } from '../src/files/project-document-target.mjs'
import { openWorkspaceFiles } from '../src/files/workspace-files.mjs'
import { HttpError } from '../src/http/policy.mjs'

const owner = () => true
const code = (status, value) => error => error instanceof HttpError && error.status === status && error.code === value && error.message === value
const lost = code(503, 'document_unconfirmed')
const syntheticRevision = `r_${'0'.repeat(64)}`
const io = () => Object.assign(Error('Injected error carrying an absolute pathname and secret'), { code: 'EIO' })
function patch(t, key, override) {
  const original = fs[key]
  fs[key] = override(original)
  syncBuiltinESMExports()
  t.after(() => { fs[key] = original; syncBuiltinESMExports() })
}
function fixture(t, name = 'note.md') {
  const base = fs.mkdtempSync(join(tmpdir(), 'deva-project-document-faults-'))
  const root = join(base, 'root'); const project = join(root, 'project'); const dir = join(project, 'nested')
  fs.mkdirSync(dir, { recursive: true })
  const catalog = openWorkspaceCatalog({ root })
  const id = catalog.list()[0].id
  const target = openProjectDocumentTarget(catalog, id, { directory: 'nested', name })
  t.after(() => { target.close(); catalog.close(); fs.rmSync(base, { recursive: true, force: true }) })
  return { base, root, dir, target, catalog, id, filename: join(dir, name) }
}

test('kernel no-overwrite preserves an equal-byte final created immediately before link', t => {
  const { dir, filename, target } = fixture(t)
  let existing
  patch(t, 'linkSync', native => (source, destination) => {
    fs.writeFileSync(filename, 'same', { mode: 0o644, flag: 'wx' })
    existing = fs.lstatSync(filename, { bigint: true })
    native(source, destination)
  })
  assert.throws(() => target.publish('same', owner), code(409, 'document_exists'))
  assert.deepEqual(fs.readdirSync(dir), ['note.md'])
  const retained = fs.lstatSync(filename, { bigint: true })
  assert.equal(retained.ino, existing.ino)
  assert.equal(retained.ctimeNs, existing.ctimeNs)
  assert.equal(retained.mode & 0o777n, 0o644n & ~BigInt(process.umask()))
  assert.throws(() => target.verifyReceipt(syntheticRevision), code(409, 'document_changed'))
})

test('stage fsync failure is not reported as a save and removes only the owned private stage', t => {
  const { dir, target } = fixture(t)
  let syncs = 0
  patch(t, 'fsyncSync', native => fd => {
    if (++syncs === 1) throw io()
    native(fd)
  })
  assert.throws(() => target.publish('text', owner), lost)
  assert.deepEqual(fs.readdirSync(dir), [])
  assert.equal(target.verifyAbsent(), true)
  const { revision } = target.publish('retry', owner)
  assert.equal(target.verifyReceipt(revision), true)
})

test('parent fsync and ambiguous link errors preserve committed targets without receipts', t => {
  const parentSync = fixture(t, 'fsync.md')
  const lateLink = fixture(t, 'link.md')
  const order = []
  patch(t, 'fsyncSync', native => fd => {
    if (fs.fstatSync(fd).isDirectory() && fs.readlinkSync(`/proc/self/fd/${fd}`) === parentSync.dir) {
      order.push('parent-sync')
      throw io()
    }
    native(fd)
  })
  patch(t, 'linkSync', native => (source, destination) => {
    native(source, destination)
    if (destination.endsWith('/link.md')) throw io()
    order.push('link')
  })
  for (const { target, dir, filename } of [parentSync, lateLink]) {
    assert.throws(() => target.publish('left in place', owner), lost)
    const installed = fs.lstatSync(filename)
    assert.equal(installed.nlink, 1)
    assert.equal(fs.readFileSync(filename, 'utf8'), 'left in place')
    assert.throws(() => target.verifyReceipt(syntheticRevision), lost)
    assert.throws(() => target.publish('retry', owner), lost)
    assert.deepEqual(fs.readdirSync(dir), [target.path.split('/').at(-1)])
    assert.equal(fs.lstatSync(filename).ino, installed.ino)
  }
  assert.deepEqual(order, ['link', 'parent-sync'])
})

test('owner expiry during the final pre-link alias scan prevents any visible target', t => {
  const { target, dir, filename } = fixture(t)
  let active = true, calls = 0, expiredDuringScan = false
  patch(t, 'opendirSync', native => (path, options) => {
    const directory = native(path, options)
    if (fs.realpathSync.native(path) === dir && fs.readdirSync(dir).some(name => name.startsWith('.project-document-'))) {
      const read = directory.readSync.bind(directory)
      directory.readSync = () => {
        expiredDuringScan = true
        active = false
        return read()
      }
    }
    return directory
  })
  assert.throws(() => target.publish('no commit', () => { calls++; return active }), code(401, 'auth'))
  assert.equal(expiredDuringScan, true)
  assert.equal(calls, 2)
  assert.equal(fs.existsSync(filename), false)
  assert.deepEqual(fs.readdirSync(dir), [])
})

test('post-link auth failure retains final inode and emits only the authorization error', t => {
  const { target, dir, filename } = fixture(t)
  let calls = 0, inode
  assert.throws(() => target.publish('published', () => {
    if (++calls !== 3) return true
    inode = fs.lstatSync(filename).ino
    throw Error(filename)
  }), code(401, 'auth'))
  assert.equal(calls, 3)
  assert.equal(fs.lstatSync(filename).ino, inode)
  assert.equal(fs.readFileSync(filename, 'utf8'), 'published')
  assert.deepEqual(fs.readdirSync(dir), ['note.md'])
  assert.throws(() => target.verifyReceipt(syntheticRevision), lost)
})

test('a replaced private stage is preserved, including when the replacement occurs before the link', t => {
  const { target, dir, filename } = fixture(t)
  let calls = 0, stagePath, decoyInode
  assert.throws(() => target.publish('original', () => {
    if (++calls === 2) {
      stagePath = join(dir, fs.readdirSync(dir).find(name => name.startsWith('.project-document-')))
      fs.renameSync(stagePath, `${stagePath}.moved`)
      fs.writeFileSync(stagePath, 'unknown', { flag: 'wx' })
      decoyInode = fs.lstatSync(stagePath).ino
    }
    return true
  }), code(409, 'document_changed'))
  assert.ok(!fs.existsSync(filename))
  assert.equal(fs.lstatSync(stagePath).ino, decoyInode)
  assert.equal(fs.readFileSync(stagePath, 'utf8'), 'unknown')
  assert.equal(fs.readFileSync(`${stagePath}.moved`, 'utf8'), 'original')
})

test('after-link pathname substitutions are neither blessed nor destroyed', t => {
  const { target, dir, filename } = fixture(t)
  let stagePath, installed, decoy, unknown, calls = 0
  assert.throws(() => target.publish('same bytes', () => {
    if (++calls === 3) {
      stagePath = join(dir, fs.readdirSync(dir).find(name => name.startsWith('.project-document-')))
      installed = fs.lstatSync(filename).ino
      fs.renameSync(filename, `${filename}.moved`)
      fs.writeFileSync(filename, 'same bytes', { mode: 0o600, flag: 'wx' })
      decoy = fs.lstatSync(filename).ino
      fs.renameSync(stagePath, `${stagePath}.moved`)
      fs.symlinkSync('note.md', stagePath)
      unknown = fs.lstatSync(stagePath).ino
    }
    return true
  }), lost)
  assert.equal(fs.lstatSync(`${filename}.moved`).ino, installed)
  assert.equal(fs.lstatSync(`${stagePath}.moved`).ino, installed)
  assert.equal(fs.lstatSync(filename).ino, decoy)
  assert.equal(fs.lstatSync(stagePath).ino, unknown)
  assert.equal(fs.readlinkSync(stagePath), 'note.md')
  assert.equal(fs.readFileSync(filename, 'utf8'), 'same bytes')
  assert.throws(() => target.verifyReceipt(syntheticRevision), lost)
})

test('case and normalization aliases appearing across link prevent confirmation without deleting either entry', t => {
  const { target, dir, filename } = fixture(t, 'Café.txt')
  const alias = join(dir, 'cafe\u0301.TXT')
  patch(t, 'linkSync', native => (source, destination) => {
    native(source, destination)
    fs.writeFileSync(alias, 'external', { flag: 'wx' })
  })
  assert.throws(() => target.publish('user text', owner), lost)
  assert.equal(fs.readFileSync(filename, 'utf8'), 'user text')
  assert.equal(fs.readFileSync(alias, 'utf8'), 'external')
  assert.throws(() => target.verifyReceipt(syntheticRevision), lost)
  assert.deepEqual(fs.readdirSync(dir).sort(), ['Café.txt', 'cafe\u0301.TXT'].sort())
})

test('post-link catalog-root replacement yields unconfirmed and never touches new tree', t => {
  const { target, base, root, dir, filename } = fixture(t)
  const moved = join(base, 'root-old')
  let calls = 0
  assert.throws(() => target.publish('in pinned tree', () => {
    if (++calls === 3) {
      fs.renameSync(root, moved)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(filename, 'in replacement tree')
    }
    return true
  }), lost)
  assert.equal(fs.readFileSync(filename, 'utf8'), 'in replacement tree')
  const original = join(moved, 'project', target.path)
  assert.equal(fs.readFileSync(original, 'utf8'), 'in pinned tree')
  assert.deepEqual(fs.readdirSync(join(moved, 'project', 'nested')), ['note.md'])
  assert.throws(() => target.verifyReceipt(syntheticRevision), lost)
})

test('synthesized birth time matches fresh workspace read after hard-link/unlink ctime changes', async t => {
  const { target, catalog, id } = fixture(t)
  patch(t, 'fstatSync', native => (fd, opts) => {
    const info = native(fd, opts)
    if (opts?.bigint) info.birthtimeNs = info.ctimeNs
    return info
  })
  const { revision } = target.publish('synthesized', owner)
  assert.equal((await openWorkspaceFiles({ catalog }).read(id, target.path)).revision, revision)
  assert.equal(target.verifyReceipt(revision), true)
})
