import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync,
  renameSync, rmSync, symlinkSync, writeFileSync
} from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const requireDesktop = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = createRequire(requireDesktop.resolve('vite/package.json'))('esbuild')
const root = fileURLToPath(new URL('../../../', import.meta.url))
const services = 'apps/desktop/src/main/services'
const entry = `${services}/memory-core.ts`
const sharedBuild = { absWorkingDir: root, bundle: true, platform: 'node', format: 'esm', target: 'node20', write: false }
const importBundle = ({ outputFiles }) => import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`)
const bundle = await build({ ...sharedBuild, entryPoints: [entry], metafile: true })
const { createMemoryService, MemoryServiceError, memoryUsage, projectMemoryKey } = await importBundle(bundle)

const globalScope = { kind: 'global' }
const role = (personaId = 'role.one') => ({ kind: 'role', personaId })
const project = (workspaceId = 'wk-1') => ({ kind: 'project', workspaceId })
const note = (title, body = '') => ({ type: 'reference', title, body })
const json = (path) => JSON.parse(readFileSync(path, 'utf8'))
const memoryError = (code) => (error) => error instanceof MemoryServiceError && error.code === code
const keys = (dir) => readdirSync(dir).sort()
const oldEntry = (id, title) => ({ id, type: 'user', title, body: '', createdAt: 10, updatedAt: 20 })

function fixture(t, label = 'case') {
  const temp = realpathSync.native(tmpdir())
  const home = mkdtempSync(join(temp, `deva-memory-${label}-`))
  t.after(() => {
    assert.equal(dirname(home), temp)
    rmSync(home, { recursive: true, force: true })
  })
  const dataDir = join(home, 'profile')
  const workspace = join(home, 'work')
  mkdirSync(workspace)
  const workspaceRoots = new Map([['wk-1', workspace]])
  return {
    home, dataDir, workspace, workspaceRoots,
    globalFile: join(dataDir, 'memory.json'),
    backups: join(dataDir, 'memory-backups'),
    roleFile: (id = 'role.one') => join(dataDir, 'personas', 'memory', `${id}.json`),
    projectFile: (path = workspace) => join(dataDir, 'projects', projectMemoryKey(path), 'memory.json'),
    open: (options = {}) => createMemoryService({ dataDir, resolveWorkspaceRoot: (id) => workspaceRoots.get(id), ...options })
  }
}

function writeFixture(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, value)
}

const operations = (service, scope) => [
  () => service.listMemories(scope),
  () => service.snapshot(scope),
  () => service.writeMemory(note('fresh'), undefined, scope),
  () => service.deleteMemory('m_1', scope),
  () => service.clearMemories(scope)
]
const allFail = (service, scope, code) => {
  for (const operation of operations(service, scope)) assert.throws(operation, memoryError(code))
}

test('the production Node bundle uses shared memory code and only Node builtin imports', () => {
  const [output] = Object.values(bundle.metafile.outputs)
  assert.equal(output.entryPoint, entry)
  assert.deepEqual(Object.keys(bundle.metafile.inputs).sort(), [
    `${services}/memory-core-shared.ts`, `${services}/memory-core-storage.ts`, entry
  ])
  assert.ok(output.imports.every(({ path, external }) => external && isBuiltin(path)))
})

test('profiles and all three scopes are isolated, using the same desktop project hash', (t) => {
  const a = fixture(t, 'left'), b = fixture(t, 'right')
  const left = a.open(), right = b.open()
  const link = join(a.home, 'work-alias')
  symlinkSync(a.workspace, link, 'dir')
  a.workspaceRoots.set('wk-alias', realpathSync.native(link))
  b.workspaceRoots.set('wk-1', a.workspace)
  const expectedHash = createHash('sha1').update(a.workspace).digest('hex').slice(0, 24)
  assert.equal(projectMemoryKey(`${link}/`), expectedHash)
  assert.equal(projectMemoryKey(`${a.workspace}/`), expectedHash)
  const scopes = [globalScope, role(), project()]
  assert.equal(existsSync(a.dataDir), false)
  for (const [index, scope] of scopes.entries()) {
    assert.deepEqual(left.listMemories(scope), [])
    assert.deepEqual(right.listMemories(scope), [])
    assert.match(left.writeMemory(note(`left ${index}`), undefined, scope).entry.id, [/^m_/, /^r_/, /^p_/][index])
    assert.deepEqual(right.listMemories(scope), [])
    assert.equal(right.writeMemory(note(`right ${index}`), undefined, scope).ok, true)
    assert.equal(a.open().snapshot(scope).entries[0].title, `left ${index}`)
    assert.equal(b.open().snapshot(scope).entries[0].title, `right ${index}`)
  }
  assert.deepEqual(left.listMemories(project('wk-alias')), left.listMemories(project()))
  assert.deepEqual(left.listMemories(role('another')), [])
  assert.equal(json(a.globalFile).version, 2)
  assert.equal(json(a.roleFile()).personaId, 'role.one')
  assert.equal(json(a.projectFile()).root, a.workspace)
  assert.deepEqual(keys(join(a.dataDir, 'projects')), [expectedHash])
  assert.deepEqual(keys(a.workspace), [], 'project memories stay under dataDir')
})

test('strict CRUD keeps typed entries, partial updates, deduplication and snapshot quotas', (t) => {
  const f = fixture(t)
  const service = f.open()
  const create = service.writeMemory(note('  首行\n名字  ', ' 一 \r\n\r\n\r\n二 '), undefined, globalScope)
  assert.equal(create.ok && create.created, true)
  const orig = create.entry
  assert.match(orig.id, /^m_[a-f0-9]{8}$/)
  assert.equal(orig.title, '首行 名字')
  assert.equal(orig.body, '一\n\n二')
  assert.equal(orig.type, 'reference')
  const second = service.writeMemory({ type: 'feedback', title: 'Other' }, undefined, globalScope).entry
  const same = service.writeMemory(note(orig.title, orig.body), undefined, globalScope)
  assert.deepEqual(same, { ok: true, created: false, entry: orig })
  assert.equal(service.writeMemory(note(orig.title, 'different'), undefined, globalScope).code, 'duplicate')
  assert.equal(service.writeMemory({ title: 'other' }, orig.id, globalScope).code, 'duplicate')
  assert.equal(service.writeMemory({ title: 'other' }, 'missing', globalScope).code, 'notFound')
  assert.equal(service.writeMemory({ title: 'x' }, undefined, globalScope).code, 'badType')
  assert.equal(service.writeMemory(note(' '), undefined, globalScope).code, 'empty')
  assert.equal(service.writeMemory(note('x'.repeat(61)), undefined, globalScope).code, 'tooLong')
  assert.equal(service.writeMemory(note('long', 'x'.repeat(1501)), undefined, globalScope).code, 'tooLong')
  const changed = service.writeMemory({ body: 'new', type: 'project' }, orig.id, globalScope)
  assert.equal(changed.ok && !changed.created, true)
  assert.deepEqual(changed.entry, { ...orig, updatedAt: changed.entry.updatedAt, body: 'new', type: 'project' })
  assert.ok(changed.entry.updatedAt >= orig.updatedAt)
  const reopened = f.open()
  assert.deepEqual(reopened.snapshot(globalScope), {
    entries: [changed.entry, second], used: memoryUsage([changed.entry, second]),
    budget: 4000, maxEntries: 100, maxTitle: 60, maxBody: 1500
  })
  assert.deepEqual(reopened.deleteMemory(orig.id, globalScope), changed.entry)
  assert.equal(reopened.deleteMemory(orig.id, globalScope), null)
  assert.deepEqual(f.open().listMemories(globalScope), [second])
  assert.equal(reopened.clearMemories(globalScope), undefined)
  assert.deepEqual(f.open().listMemories(globalScope), [])
  assert.deepEqual(json(f.globalFile), { version: 2, entries: [] })
})

test('count and line budgets are independent per scope; shrinking old over-budget entries remains valid', (t) => {
  const f = fixture(t)
  const service = f.open()
  for (const [scope, count, budget] of [[globalScope, 100, 4000], [project(), 60, 3000]]) {
    for (let i = 0; i < count; i++) assert.equal(service.writeMemory(note(`${i}`), undefined, scope).ok, true)
    assert.equal(service.writeMemory(note('extra'), undefined, scope).code, 'full')
    const read = service.snapshot(scope)
    assert.equal(read.entries.length, count)
    assert.equal(read.maxEntries, count)
    assert.equal(read.budget, budget)
    assert.ok(read.used < budget)
  }
  let n = 0
  while (n < 100 && service.writeMemory(note(`${n}`.padEnd(60, 'x')), undefined, role()).ok) n++
  assert.ok(n > 0 && n < 100)
  assert.equal(service.writeMemory(note('y'.repeat(60)), undefined, role()).code, 'budget')
  const tooLarge = Array.from({ length: 60 }, (_, i) => oldEntry(`p_${i}`, `Old ${i}`.padEnd(i ? 60 : 10, '-')))
  writeFixture(f.projectFile(), JSON.stringify({ version: 2, entries: tooLarge }))
  assert.ok(service.snapshot(project()).used > 3000)
  assert.equal(service.writeMemory({ title: 'a little longer' }, 'p_0', project()).code, 'budget')
  assert.equal(service.writeMemory({ title: 'shorter' }, 'p_0', project()).ok, true)
  assert.equal(service.deleteMemory('p_1', project()).title, tooLarge[1].title)
  assert.equal(service.snapshot(globalScope).entries.length, 100)
})

test('v1 strict reads are side-effect free; mutation and clear back up original bytes before publishing v2', (t) => {
  const f = fixture(t)
  const legacy = { id: 'm_5f3c8012', content: '保留旧正文。 第二句。', createdAt: 11, updatedAt: 22 }
  const source = Buffer.from(`${JSON.stringify({ version: 1, entries: [legacy] }, null, 4)}\r\n`)
  writeFixture(f.globalFile, source)
  const service = f.open()
  const expected = { id: legacy.id, title: '保留旧正文', type: 'user', body: legacy.content, createdAt: 11, updatedAt: 22 }
  assert.deepEqual(service.listMemories(globalScope), [expected])
  assert.deepEqual(service.snapshot(globalScope).entries, [expected])
  assert.equal(service.writeMemory({ title: 'unused' }, 'missing', globalScope).code, 'notFound')
  assert.deepEqual(service.writeMemory({ type: 'user', title: expected.title, body: expected.body }, undefined, globalScope),
    { ok: true, entry: expected, created: false })
  assert.equal(service.deleteMemory('missing', globalScope), null)
  assert.equal(existsSync(f.backups), false)
  assert.deepEqual(readFileSync(f.globalFile), source)
  const update = service.writeMemory({ type: 'feedback', title: '已更新' }, legacy.id, globalScope).entry
  assert.deepEqual(f.open().listMemories(globalScope), [update])
  assert.deepEqual(json(f.globalFile), { version: 2, tidy: 'pending', entries: [update] })
  const [backup] = keys(f.backups)
  assert.match(backup, /^memory-v1-.*\.json$/)
  assert.deepEqual(readFileSync(join(f.backups, backup)), source)
  const v1Project = Buffer.from(JSON.stringify({ version: 1, root: f.workspace, entries: [{ ...legacy, id: 'p_01' }] }))
  writeFixture(f.projectFile(), v1Project)
  service.clearMemories(project())
  assert.deepEqual(json(f.projectFile()), { version: 2, root: f.workspace, entries: [] })
  const projectBackup = join(dirname(f.projectFile()), 'memory-backups')
  assert.deepEqual(readFileSync(join(projectBackup, keys(projectBackup)[0])), v1Project)
})

test('desktop IPC and strict core read back each other’s v1/v2 files through real shared code', async (t) => {
  const desktop = await importBundle(await build({
    ...sharedBuild,
    stdin: {
      resolveDir: join(root, services),
      contents: "export * from './memory'; export { ipcHandlers } from 'electron'; export { setHome } from './config';"
    },
    plugins: [{ name: 'desktop-adapter-fixture', setup(esbuild) {
      esbuild.onResolve({ filter: /^(?:electron|\.\/config)$/ }, ({ path }) => ({ path, namespace: 'memory-fixture' }))
      esbuild.onLoad({ filter: /.*/, namespace: 'memory-fixture' }, ({ path }) => ({ contents: path === 'electron'
        ? 'export const ipcHandlers = new Map(); export const ipcMain = { handle: (...args) => ipcHandlers.set(...args) };'
        : 'let home; export const getDevaHome = () => home; export const setHome = (path) => { home = path; };' }))
    } }]
  }))
  const f = fixture(t)
  const service = f.open()
  desktop.setHome(f.dataDir)
  desktop.registerMemoryIpc()
  const ipc = (name, ...args) => desktop.ipcHandlers.get(`memory:${name}`)(null, ...args)
  const legacy = { version: 1, entries: [{ id: 'm_3ac2561b', content: 'Desktop v1', createdAt: 1, updatedAt: 2 }] }
  writeFixture(f.globalFile, JSON.stringify(legacy))
  const read = service.snapshot(globalScope)
  assert.deepEqual(ipc('list'), read)
  assert.equal(json(f.globalFile).version, 2, 'desktop still migrates eagerly on read')
  assert.equal(desktop.memoryTidyState(desktop.GLOBAL_SCOPE).pending, true)
  assert.deepEqual(json(join(f.backups, keys(f.backups)[0])), legacy)
  assert.equal(ipc('write', note('Desktop creates role'), undefined, { personaId: 'role.one' }).ok, true)
  const roleRead = service.snapshot(role())
  const roleId = roleRead.entries[0].id
  assert.deepEqual(ipc('list', { personaId: 'role.one' }), roleRead)
  assert.equal(service.writeMemory({ body: 'Web edits role' }, roleId, role()).ok, true)
  assert.equal(desktop.listMemories(role())[0].body, 'Web edits role')
  assert.equal(ipc('delete', roleId, { personaId: 'role.one' }).ok, true)
  assert.deepEqual(service.listMemories(role()), [])
  const p = service.writeMemory(note('Web creates project'), undefined, project()).entry
  assert.equal(ipc('list', f.workspace).entries[0].id, p.id)
  assert.deepEqual(ipc('write', note('Web creates project'), undefined, f.workspace), { ok: false, code: 'duplicate' })
  assert.equal(ipc('clear', f.workspace).ok, true)
  assert.deepEqual(service.listMemories(project()), [])
  assert.throws(() => ipc('clear', { kind: 'made-up' }), /invalid scope/)
  assert.deepEqual(service.snapshot(globalScope), read)
})

test('all strict entries reject malformed scopes, prototype keys and unregistered projects before mutation', (t) => {
  const f = fixture(t)
  let lookups = 0
  const service = f.open({ resolveWorkspaceRoot(id) { lookups++; return f.workspaceRoots.get(id) } })
  assert.equal(service.writeMemory(note('keep'), undefined, globalScope).ok, true)
  const before = readFileSync(f.globalFile)
  const invalid = [undefined, null, '', [], f.workspace, {}, { kind: 'other' }, { kind: 'global', workspaceId: 'wk-1' },
    Object.create({ kind: 'global' }), Object.defineProperty({}, 'kind', { get() { throw Error('getter called') } }),
    JSON.parse('{"kind":"global","__proto__":{}}'), JSON.parse('{"kind":"global","constructor":{}}'),
    { kind: 'role', personaId: 42 }, ...['..', '../profile', '/absolute', 'a/b', 'a\\b', 'role\n', 'a\0b', ' role',
      'trailing.', 'é', 'r'.repeat(65), '__proto__', 'constructor', 'prototype', 'ToString', 'hasOwnProperty', 'nul.txt'].map(role),
    { kind: 'project', root: f.workspace }, { kind: 'project', root: f.workspace, workspaceId: 'wk-1' },
    ...[f.workspace, '../work', 'a/b', '__proto__', 'constructor', 'valueOf', 'wk-1\n'].map(project)]
  for (const scope of invalid) allFail(service, scope, 'invalidScope')
  assert.equal(lookups, 0)
  allFail(service, project('unregistered'), 'workspaceUnavailable')
  allFail(createMemoryService({ dataDir: f.dataDir }), project(), 'workspaceUnavailable')
  assert.equal(lookups, 5)
  assert.throws(() => service.writeMemory(JSON.parse('{"title":"x","__proto__":{}}'), undefined, globalScope), memoryError('invalidInput'))
  assert.throws(() => service.writeMemory({ title: 1 }, undefined, globalScope), memoryError('invalidInput'))
  assert.throws(() => service.writeMemory(note('fresh'), '', globalScope), memoryError('invalidInput'))
  assert.throws(() => service.deleteMemory('constructor', globalScope), memoryError('invalidInput'))
  assert.deepEqual(readFileSync(f.globalFile), before)
  assert.deepEqual(keys(f.dataDir), ['memory.json'])
})

test('authorized workspace roots must still be real directories and retain their canonical path', (t) => {
  const f = fixture(t)
  const service = f.open()
  const alias = join(f.home, 'alias')
  const regular = join(f.home, 'regular')
  writeFileSync(regular, '')
  symlinkSync(f.workspace, alias, 'dir')
  for (const [id, path] of [['alias', alias], ['regular', regular], ['missing', join(f.home, 'missing')], ['relative', 'work']]) {
    f.workspaceRoots.set(id, path)
    allFail(service, project(id), 'workspaceUnavailable')
  }
  assert.equal(service.writeMemory(note('persist'), undefined, project()).ok, true)
  const before = readFileSync(f.projectFile())
  const old = join(f.home, 'original-work')
  renameSync(f.workspace, old)
  symlinkSync(old, f.workspace, 'dir')
  allFail(service, project(), 'workspaceUnavailable')
  const originalHash = createHash('sha1').update(f.workspace).digest('hex').slice(0, 24)
  assert.deepEqual(readFileSync(join(f.dataDir, 'projects', originalHash, 'memory.json')), before)
})

test('corruption, invalid schema and permission failures are surfaced, never replaced by a write or clear', (t) => {
  const f = fixture(t)
  const service = f.open()
  const validEntry = oldEntry('m_1', 'original')
  for (const raw of [Buffer.from([0xff]), '{broken', 'null', '{"entries":{}}',
    JSON.stringify({ version: 3, entries: [] }), JSON.stringify({ version: 2, entries: [validEntry, { ...validEntry }] }),
    JSON.stringify({ version: 2, entries: [validEntry, { ...validEntry, id: 'm_2', type: 'wrong' }] }),
    JSON.stringify({ version: 1, entries: [validEntry] }), '{"entries":[],"__proto__":{}}']) {
    const bytes = Buffer.from(raw)
    writeFixture(f.globalFile, bytes)
    allFail(service, globalScope, 'corruptStorage')
    assert.deepEqual(readFileSync(f.globalFile), bytes)
  }
  const before = Buffer.from(JSON.stringify({ version: 2, entries: [validEntry] }))
  writeFixture(f.globalFile, before)
  chmodSync(f.globalFile, 0o000)
  try { allFail(service, globalScope, 'storageIO') } finally { chmodSync(f.globalFile, 0o600) }
  assert.deepEqual(readFileSync(f.globalFile), before)
  chmodSync(f.globalFile, 0o400)
  try {
    assert.deepEqual(service.listMemories(globalScope), [validEntry])
    for (const op of operations(service, globalScope).slice(2)) assert.throws(op, memoryError('storageIO'))
  } finally { chmodSync(f.globalFile, 0o600) }
  assert.deepEqual(readFileSync(f.globalFile), before)
  chmodSync(f.dataDir, 0o500)
  try {
    assert.throws(() => service.clearMemories(role()), memoryError('storageIO'))
    assert.equal(existsSync(join(f.dataDir, 'personas')), false)
  } finally { chmodSync(f.dataDir, 0o700) }
  assert.deepEqual(keys(f.dataDir), ['memory.json'])
})

test('strict I/O rejects profile, scope directory, file, hard and backup links without touching their targets', (t) => {
  const f = fixture(t)
  const foreign = join(f.home, 'foreign')
  const foreignFile = join(foreign, 'memory.json')
  const original = Buffer.from('{"version":2,"entries":[]}')
  writeFixture(foreignFile, original)
  const service = f.open()
  symlinkSync(foreign, f.dataDir, 'dir')
  allFail(service, globalScope, 'unsafeStorage')
  allFail(f.open({ dataDir: join(f.dataDir, 'nested') }), globalScope, 'unsafeStorage')
  rmSync(f.dataDir)
  mkdirSync(f.dataDir)
  symlinkSync(foreignFile, f.globalFile)
  allFail(service, globalScope, 'unsafeStorage')
  rmSync(f.globalFile)
  linkSync(foreignFile, f.globalFile)
  allFail(service, globalScope, 'unsafeStorage')
  rmSync(f.globalFile)
  symlinkSync(foreign, join(f.dataDir, 'personas'), 'dir')
  allFail(service, role(), 'unsafeStorage')
  mkdirSync(dirname(dirname(f.projectFile())))
  symlinkSync(foreign, dirname(f.projectFile()), 'dir')
  allFail(service, project(), 'unsafeStorage')
  assert.deepEqual(keys(foreign), ['memory.json'])
  assert.deepEqual(readFileSync(foreignFile), original)
  const legacy = Buffer.from('{"version":1,"entries":[{"id":"m_1","content":"preserve","createdAt":1,"updatedAt":2}]}')
  writeFixture(f.globalFile, legacy)
  symlinkSync(foreign, f.backups, 'dir')
  assert.equal(service.snapshot(globalScope).entries[0].body, 'preserve')
  for (const op of operations(service, globalScope).slice(2)) assert.throws(op, memoryError('unsafeStorage'))
  assert.deepEqual(keys(foreign), ['memory.json'])
  assert.deepEqual(readFileSync(f.globalFile), legacy)
  rmSync(f.backups)
  mkdirSync(f.backups, { mode: 0o500 })
  try {
    assert.throws(() => service.clearMemories(globalScope), memoryError('storageIO'))
    assert.deepEqual(keys(f.backups), [])
  } finally { chmodSync(f.backups, 0o700) }
  assert.deepEqual(readFileSync(f.globalFile), legacy)
})
