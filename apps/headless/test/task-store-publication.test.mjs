import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { openTaskStore } from '../src/tasks/store.mjs'

const initial = '{"version":1,"tasks":[{"id":"test-1","title":"fixture","prompt":"Inspect only","schedule":{"kind":"once",' +
  '"at":"2026-12-01T17:00","tz":"UTC"},"sessionId":"task-test-1","status":"active","createdAt":10,"updatedAt":11}]}'
const authorize = () => true

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'deva-task-publication-'))
  assert.equal(dirname(root), tmpdir())
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dataDir = join(root, 'data')
  fs.mkdirSync(dataDir, { mode: 0o700 })
  const path = join(dataDir, 'tasks.json')
  fs.writeFileSync(path, initial, { mode: 0o600 })
  return { root, path, dataDir, store: openTaskStore({ dataDir, now: () => 12 }) }
}

function mockFs(t, name, wrap) {
  t.mock.method(fs, name, wrap(fs[name]))
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
}

const unconfirmed = { status: 503, code: 'task_storage_unconfirmed' }

test('confirms disk after a rename failure without trusting staged bytes', async t => {
  const { path, dataDir, store } = fixture(t)
  const { revision } = await store.list()
  let failed = false
  let readback = ''
  mockFs(t, 'renameSync', original => (from, to) => {
    if (!from.includes('.tasks.json.')) return original(from, to)
    failed = true
    throw Object.assign(new Error('fixture rename failure'), { code: 'EIO' })
  })
  mockFs(t, 'readSync', original => (fd, buffer, offset, length, ...args) => {
    const count = original(fd, buffer, offset, length, ...args)
    if (failed) readback += buffer.toString('utf8', offset, offset + count)
    return count
  })
  await assert.rejects(store.pause('test-1', revision, authorize), unconfirmed)
  assert.equal(readback, initial)
  assert.equal(fs.readFileSync(path, 'utf8'), initial)
  assert.deepEqual(fs.readdirSync(dataDir), ['tasks.json'])
})

test('even exact bytes are unconfirmed after failed directory fsync or replacement by another inode', async t => {
  await t.test('directory fsync failure', async t => {
    const { path, store } = fixture(t)
    const { revision } = await store.list()
    let failed = false
    let readback = ''
    mockFs(t, 'fsyncSync', original => fd => {
      if (!fs.fstatSync(fd).isDirectory()) return original(fd)
      failed = true
      throw Object.assign(new Error('fixture directory sync failure'), { code: 'EIO' })
    })
    mockFs(t, 'readSync', original => (fd, buffer, offset, length, ...args) => {
      const count = original(fd, buffer, offset, length, ...args)
      if (failed) readback += buffer.toString('utf8', offset, offset + count)
      return count
    })
    await assert.rejects(store.pause('test-1', revision, authorize), unconfirmed)
    assert.equal(readback, initial.replace('"active"', '"paused"').replace('"updatedAt":11', '"updatedAt":12'))
    assert.equal(readback, fs.readFileSync(path, 'utf8'))
  })

  await t.test('foreign equivalent write', async t => {
    const { root, path, store } = fixture(t)
    const { revision } = await store.list()
    let stagedInode
    mockFs(t, 'renameSync', original => (from, to) => {
      original(from, to)
      if (from.includes('.tasks.json.')) {
        stagedInode = fs.statSync(to).ino
        const replacement = join(root, 'external-temporary')
        fs.writeFileSync(replacement, fs.readFileSync(to), { mode: 0o600 })
        original(replacement, to)
      }
    })
    await assert.rejects(store.pause('test-1', revision, authorize), unconfirmed)
    assert.ok(stagedInode)
    assert.notEqual(fs.statSync(path).ino, stagedInode)
    const bytes = fs.readFileSync(path)
    assert.equal(bytes.toString(), initial.replace('"active"', '"paused"').replace('"updatedAt":11', '"updatedAt":12'))
    assert.equal((await store.get('test-1')).revision, createHash('sha256').update(bytes).digest('hex'))
  })
})
