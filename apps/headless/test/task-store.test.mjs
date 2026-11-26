import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, chownSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { openTaskStore } from '../src/tasks/store.mjs'

const ID = '2a29ffa0-9778-4b4b-a3cb-cbce444b11f3'
const NOW = 1_795_715_400_001
const runAt = NOW - 1_000
const nextAt = NOW + 1_000
const authOwner = () => ({ role: 'owner', id: 'original-login' })
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

function nativeTask(overrides = {}) {
  return {
    id: ID, title: 'Daily report', prompt: 'Collect the report\r\n\u0000\u202e[local](file:///prompt-fixture) <b>as text</b>',
    schedule: { kind: 'recurring', cron: '30 8 * * 1-5', tz: 'Asia/Shanghai', scratchPath: '/private/schedule' },
    auth: { personaId: 'persona-1', modelRef: 'openrouter:example/model', allowedTools: ['irrelevant'], focusRoot: '/private/root' },
    sessionId: `task-${ID}`, ownerSessionId: 'sess_owner', originSessionId: 'sess_origin', status: 'active',
    createdAt: NOW - 20_000, updatedAt: NOW - 10_000, lastRunAt: runAt, nextRunAt: nextAt, consecutiveErrors: 2,
    runs: [
      { firedAt: runAt - 3_000, status: 'skipped', summary: 'One missed run' },
      { firedAt: runAt - 2_000, finishedAt: runAt - 1_500, status: 'ok', summary: 'Reporting complete ✅',
        handoff: { summary: 'Team notified', needsAction: true, extra: '/private/handoff' }, transcriptPath: '/private/run' },
      { firedAt: runAt - 1_000, status: 'aborted', summary: 'Stopped\r\nby owner' },
      { firedAt: runAt, finishedAt: runAt + 5, status: 'error', error: 'Network error' }
    ],
    privateNative: { config: '/private/native' }, ...overrides
  }
}

function fixture(t, now = () => NOW) {
  const parent = mkdtempSync(join(tmpdir(), 'deva-task-store-'))
  assert.equal(dirname(parent), tmpdir())
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const dataDir = join(parent, 'home')
  mkdirSync(dataDir, { mode: 0o700 })
  const path = join(dataDir, 'tasks.json')
  const store = openTaskStore({ dataDir, now })
  const put = (tasks, root = {}) => writeFileSync(path, JSON.stringify({ version: 1, tasks, ...root }), { mode: 0o600 })
  return { parent, dataDir, path, store, put }
}

const err = (status, code) => ({ status, code })

test('reports confirmed absence without materializing anything; ordinary native list and detail are typed allowlists', async t => {
  const { dataDir, path, store, put } = fixture(t)
  const missing = await store.list()
  assert.deepEqual(missing.tasks, [])
  assert.match(missing.revision, /^[0-9a-f]{64}$/)
  assert.equal(missing.execution, 'inactive')
  assert.deepEqual(readdirSync(dataDir), [])
  await assert.rejects(store.get(ID), err(404, 'task_not_found'))
  await assert.rejects(store.pause(ID, missing.revision, authOwner), err(404, 'task_not_found'))
  put([])
  assert.notEqual((await store.list()).revision, missing.revision)

  const task = nativeTask()
  const once = nativeTask({ id: 'task_once', sessionId: 'task-task_once', status: 'completed',
    schedule: { kind: 'once', at: '2026-11-26T20:00', tz: 'UTC', cron: 'private' }, lastRunAt: null, nextRunAt: null })
  put([task, once], { nativePrivate: '/private/root-file' })
  const summary = {
    id: ID, title: task.title, status: 'active', schedule: { kind: 'recurring', cron: '30 8 * * 1-5', tz: 'Asia/Shanghai' },
    createdAt: task.createdAt, updatedAt: task.updatedAt, lastRunAt: runAt, nextRunAt: nextAt, runCount: 4
  }
  const list = await store.list()
  assert.deepEqual(list, { tasks: [summary, { id: once.id, title: once.title, status: 'completed',
    schedule: { kind: 'once', at: '2026-11-26T20:00', tz: 'UTC' }, createdAt: once.createdAt, updatedAt: once.updatedAt,
    lastRunAt: null, nextRunAt: null, runCount: 4 }], revision: digest(readFileSync(path)), execution: 'inactive' })
  const detail = await store.get(ID)
  for (const projection of [list, detail]) {
    assert.doesNotMatch(JSON.stringify(projection), /\/private\/|allowedTools|scratchPath|focusRoot|transcriptPath|nativePrivate|privateNative/)
  }
  assert.deepEqual(detail, {
    task: { ...summary, prompt: 'Collect the report\n[local](file:///prompt-fixture) <b>as text</b>',
      auth: { personaId: 'persona-1', modelRef: 'openrouter:example/model' }, sessionId: task.sessionId,
      ownerSessionId: 'sess_owner', originSessionId: 'sess_origin', consecutiveErrors: 2, pauseAllowed: true,
      runs: [task.runs[0], { firedAt: task.runs[1].firedAt, finishedAt: task.runs[1].finishedAt, status: 'ok',
        summary: 'Reporting complete ✅', handoff: { summary: 'Team notified', needsAction: true } }, task.runs[2], task.runs[3]] },
    revision: list.revision, execution: 'inactive'
  })
  assert.equal((await store.get(once.id)).task.pauseAllowed, false)
  assert.deepEqual(Object.keys(store), ['list', 'get', 'pause'])
  assert.equal(store.resume, undefined)
  assert.equal(store.run, undefined)
  assert.equal(store.create, undefined)
})

test('pause preserves every other source byte, retains native scheduling/history, and retries with only the current revision', async t => {
  let clockReads = 0
  const { dataDir, path, store, put } = fixture(t, () => { clockReads++; return NOW })
  const other = nativeTask({ id: 'other', status: 'error', createdAt: 0 })
  put([nativeTask(), other])
  const compact = readFileSync(path, 'utf8')
  const before = `${compact.slice(0, -1)}, "opaque": { "unsafeNumber":9.007199254740993e15,"2":1,"1":2 } }\r\n`
    .replace('"status":"active"', '"st\\u0061tus" : "acti\\u0076e"')
  writeFileSync(path, before)
  const initial = await store.get(ID)
  const observed = []
  const paused = await store.pause(ID, initial.revision, id => { observed.push(id) })
  assert.deepEqual(observed, [ID, ID])
  assert.equal(clockReads, 1)
  const expected = before.replace('"acti\\u0076e"', '"paused"').replace(`"updatedAt":${NOW - 10_000}`, `"updatedAt":${NOW}`)
  assert.equal(readFileSync(path, 'utf8'), expected)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.deepEqual(readdirSync(dataDir), ['tasks.json'])
  assert.deepEqual(paused, { task: { ...initial.task, status: 'paused', updatedAt: NOW, pauseAllowed: false },
    revision: digest(expected), execution: 'inactive' })
  const inode = statSync(path).ino
  assert.deepEqual(await store.pause(ID, paused.revision, authOwner), paused)
  assert.equal(statSync(path).ino, inode)
  assert.equal(clockReads, 1)
  await assert.rejects(store.pause(ID, initial.revision, authOwner), err(409, 'task_conflict'))
  await assert.rejects(store.pause('missing', initial.revision, authOwner), err(409, 'task_conflict'))
  await assert.rejects(store.pause('other', paused.revision, authOwner), err(409, 'task_state'))
  await assert.rejects(store.pause(ID, paused.revision, false), err(401, 'unauthorized'))
  // Desktop list order is by creation time, even though the later task is first on disk.
  assert.deepEqual((await store.list()).tasks.map(task => task.id), [other.id, ID])
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).tasks.map(task => task.id), [ID, other.id])
})

test('publication reauthorizes the original owner and CAS detects edits to nonmatching records or bytes', async t => {
  const { dataDir, path, put, store } = fixture(t)
  put([nativeTask(), nativeTask({ id: 'other' })])
  const before = readFileSync(path)
  const initial = await store.list()
  let calls = 0
  await assert.rejects(store.pause(ID, initial.revision, () => ++calls === 1), err(401, 'unauthorized'))
  assert.equal(calls, 2)
  assert.deepEqual(readFileSync(path), before)
  assert.deepEqual(readdirSync(dataDir), ['tasks.json'])

  calls = 0
  await assert.rejects(store.pause(ID, initial.revision, () => {
    if (++calls === 2) throw Object.assign(new Error('expired'), { code: 'AUTH_FAILED' })
    return true
  }), err(401, 'auth'))
  assert.deepEqual(readFileSync(path), before)
  assert.deepEqual(readdirSync(dataDir), ['tasks.json'])

  calls = 0
  const external = Buffer.concat([before, Buffer.from('\n')])
  await assert.rejects(store.pause(ID, initial.revision, () => {
    if (++calls === 2) writeFileSync(path, external)
    return true
  }), err(409, 'task_conflict'))
  assert.deepEqual(readFileSync(path), external)
  assert.equal((await store.get(ID)).task.status, 'active')
  assert.deepEqual(readdirSync(dataDir), ['tasks.json'])

  const updated = await store.get(ID)
  await assert.rejects(store.pause(ID, updated.revision, async () => true), err(401, 'unauthorized'))
  assert.deepEqual(readFileSync(path), external)

  calls = 0
  await assert.rejects(store.pause(ID, updated.revision, () => {
    if (++calls === 2) {
      const tmp = readdirSync(dataDir).find(name => name.startsWith('.tasks.json.'))
      assert.ok(tmp)
      writeFileSync(join(dataDir, tmp), '{"version":1,"tasks":[]}')
    }
    return true
  }), err(503, 'task_storage_unconfirmed'))
  assert.deepEqual(readFileSync(path), external)
  assert.deepEqual(readdirSync(dataDir), ['tasks.json'])

  put([nativeTask({ status: 'completed' })])
  await assert.rejects(store.pause(ID, (await store.list()).revision, authOwner), err(409, 'task_state'))
  await assert.rejects(store.pause(ID, 'bad-revision', authOwner), err(400, 'invalid_task_revision'))
  await assert.rejects(store.pause(ID, `${initial.revision}\n`, authOwner), err(400, 'invalid_task_revision'))
})

test('path and ownership checks reject unsafe native targets while legacy owner mode permits inspection only', async t => {
  const { parent, path, dataDir, store, put } = fixture(t)
  const external = join(parent, 'outside.json')
  const bytes = JSON.stringify({ version: 1, tasks: [nativeTask()] })
  writeFileSync(external, bytes, { mode: 0o600 })
  for (const id of ['../outside', 'nested/path', 'nested\\path', '%2E%2E', '\u0000x', 'a\n', 'a'.repeat(129), {}, undefined]) {
    await assert.rejects(store.get(id), err(400, 'invalid_task_id'))
    await assert.rejects(store.pause(id, digest(bytes), authOwner), err(400, 'invalid_task_id'))
  }
  symlinkSync(external, path)
  await assert.rejects(store.list(), err(503, 'task_storage_unconfirmed'))
  assert.equal(readFileSync(external, 'utf8'), bytes)
  rmSync(path)
  linkSync(external, path)
  await assert.rejects(store.get(ID), err(503, 'task_storage_unconfirmed'))
  rmSync(path)
  mkdirSync(path, { mode: 0o700 })
  await assert.rejects(store.list(), err(503, 'task_storage_unconfirmed'))
  rmSync(path, { recursive: true })

  put([nativeTask()])
  const linkDir = join(parent, 'link')
  symlinkSync(dataDir, linkDir, 'dir')
  await assert.rejects(openTaskStore({ dataDir: linkDir }).list(), err(503, 'task_storage_unconfirmed'))
  const nested = join(dataDir, 'nested')
  mkdirSync(nested, { mode: 0o700 })
  writeFileSync(join(nested, 'tasks.json'), bytes, { mode: 0o600 })
  await assert.rejects(openTaskStore({ dataDir: join(linkDir, 'nested') }).list(), err(503, 'task_storage_unconfirmed'))
  await assert.rejects(openTaskStore({ dataDir: join(parent, 'absent-home') }).list(), err(503, 'task_storage_unconfirmed'))
  assert.equal(existsSync(join(parent, 'absent-home')), false)

  chmodSync(path, 0o644)
  const legacy = await store.get(ID)
  assert.equal(legacy.task.pauseAllowed, false)
  await assert.rejects(store.pause(ID, legacy.revision, authOwner), err(503, 'task_storage_unconfirmed'))
  assert.equal(statSync(path).mode & 0o777, 0o644)
  chmodSync(path, 0o664)
  await assert.rejects(store.list(), err(503, 'task_storage_unconfirmed'))
  chmodSync(path, 0o600)
  chmodSync(dataDir, 0o755)
  assert.equal((await store.get(ID)).task.pauseAllowed, false)
  await assert.rejects(store.pause(ID, legacy.revision, authOwner), err(503, 'task_storage_unconfirmed'))
  chmodSync(dataDir, 0o772)
  await assert.rejects(store.list(), err(503, 'task_storage_unconfirmed'))
  chmodSync(dataDir, 0o700)
  if (process.geteuid() === 0) {
    chownSync(path, 65_534, 65_534)
    await assert.rejects(store.list(), err(503, 'task_storage_unconfirmed'))
    chownSync(path, 0, 0)
    chownSync(dataDir, 65_534, 65_534)
    await assert.rejects(store.list(), err(503, 'task_storage_unconfirmed'))
  }
})

test('directory replacement between owner checks fails closed and cleans only the pinned staging directory', async t => {
  const { parent, path, dataDir, store, put } = fixture(t)
  put([nativeTask()])
  const before = readFileSync(path)
  const { revision } = await store.list()
  const displaced = join(parent, 'displaced-home')
  const external = '{"version":1,"tasks":[]}'
  let calls = 0
  await assert.rejects(store.pause(ID, revision, () => {
    if (++calls === 2) {
      renameSync(dataDir, displaced)
      mkdirSync(dataDir, { mode: 0o700 })
      writeFileSync(path, external, { mode: 0o600 })
    }
    return true
  }), err(503, 'task_storage_unconfirmed'))
  assert.equal(readFileSync(path, 'utf8'), external)
  assert.deepEqual(readFileSync(join(displaced, 'tasks.json')), before)
  assert.deepEqual(readdirSync(displaced), ['tasks.json'])
  assert.deepEqual((await store.list()).tasks, [])
})

test('fails closed on unsupported data, and bounds the whole file and every record without skipping rows', async t => {
  const { path, store, put } = fixture(t)
  for (const malformed of ['', '{', Buffer.from([255]), '{"version":2,"tasks":[]}',
    '{"version":1,"version":1,"tasks":[]}', '{"version":1,"tasks":{}}',
    '{"version":1,"tasks":[],"opaque":{"x":1,"\\u0078":2}}']) {
    writeFileSync(path, malformed, { mode: 0o600 })
    await assert.rejects(store.list(), err(409, 'task_file_unsupported'))
  }
  for (const bad of [null, {}, nativeTask({ status: 'running' }), nativeTask({ runs: [{}] }),
    nativeTask({ auth: { personaId: ['private'] } }), nativeTask({ updatedAt: '1234' }),
    nativeTask({ nextRunAt: 8_640_000_000_000_001 }), nativeTask({ lastRunAt: 1.25 }),
    nativeTask({ sessionId: '../somewhere' }), nativeTask({ schedule: { kind: 'recurring', tz: 'UTC' } })]) {
    put([nativeTask(), bad])
    await assert.rejects(store.get(ID), err(409, 'task_file_unsupported'))
    await assert.rejects(store.list(), err(409, 'task_file_unsupported'))
  }
  const maxRun = { firedAt: 12, finishedAt: 19, status: 'ok', summary: 'done' }
  const maxRows = Array.from({ length: 128 }, (_, index) => nativeTask({ id: `task-${index}`, runs: Array(50).fill(maxRun) }))
  put(maxRows)
  assert.equal((await store.list()).tasks.length, 128)
  assert.equal((await store.get('task-127')).task.runs.length, 50)
  put([...maxRows, nativeTask()])
  await assert.rejects(store.list(), err(413, 'task_limit'))
  put([nativeTask({ runs: Array(51).fill(maxRun) })])
  await assert.rejects(store.list(), err(413, 'task_limit'))
  put([nativeTask({ title: '中'.repeat(200) })])
  await assert.rejects(store.list(), err(413, 'task_limit'))
  put([nativeTask({ prompt: 'a'.repeat(65_537) })])
  await assert.rejects(store.list(), err(413, 'task_limit'))
  put([nativeTask({ runs: [{ ...maxRun, summary: 'a'.repeat(16_385) }] })])
  await assert.rejects(store.get(ID), err(413, 'task_limit'))
  writeFileSync(path, Buffer.alloc(1_048_577, 32))
  await assert.rejects(store.get(ID), err(413, 'task_limit'))

  put([nativeTask({ auth: undefined, lastRunAt: undefined, nextRunAt: undefined, runs: undefined,
    consecutiveErrors: undefined, ownerSessionId: undefined, originSessionId: undefined })])
  const legacy = (await store.get(ID)).task
  assert.deepEqual(legacy.auth, { personaId: null, modelRef: null })
  assert.equal(legacy.lastRunAt, null)
  assert.equal(legacy.nextRunAt, null)
  assert.equal(legacy.runCount, 0)
  assert.equal(legacy.consecutiveErrors, 0)
  assert.equal(legacy.ownerSessionId, null)
  assert.equal(legacy.originSessionId, null)
})

test('a clock outside the representable Date range leaves the fully readable original untouched', async t => {
  const { dataDir, path, store, put } = fixture(t, () => 8_640_000_000_000_001)
  put([nativeTask({ lastRunAt: -8_640_000_000_000_000, nextRunAt: 8_640_000_000_000_000 })])
  const before = readFileSync(path)
  const { revision } = await store.list()
  await assert.rejects(store.pause(ID, revision, authOwner), err(503, 'task_storage_unconfirmed'))
  assert.deepEqual(readFileSync(path), before)
  assert.deepEqual(readdirSync(dataDir), ['tasks.json'])
})
