import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, promises as fs } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { openSettings } from '../src/business/settings.mjs'
import { withSettingsDirectory } from '../src/business/settings-file.mjs'
import { HttpError } from '../src/http/policy.mjs'
import { openSkillLibrary } from '../src/skills/store.mjs'

const hex = /^[0-9a-f]{64}$/
const owner = () => true
const execution = 'inactive'
const err = (status, code) => ({ status, code, message: code })
const invalid = err(400, 'skill_invalid')
const conflict = err(409, 'skill_conflict')
const unconfirmed = err(503, 'skill_storage_unconfirmed')
const readOnly = err(403, 'skill_read_only')
const auth = err(401, 'auth')
const exec = promisify(execFile)

const builtin = Object.freeze({ id: 'create-skill', name: 'Create Skill', description: 'Built in', source: 'builtin', documentRevision: 'builtin-stamp' })
const alpha = Object.freeze({ id: 'alpha', name: 'Alpha', description: 'Native', source: 'custom', documentRevision: 'alpha-v1' })
const beta = Object.freeze({ id: 'beta', name: 'Beta', description: 'Native', source: 'custom', documentRevision: 'beta-v1' })
const details = { instructions: 'A native document body', trigger: 'When asked', license: 'MIT', compatibility: 'native',
  allowedTools: ['inspect'], metadata: { author: 'human' } }

async function fixture(t, text, mode = 0o600) {
  const parent = await fs.mkdtemp(join(tmpdir(), 'deva-skill-prefs-'))
  t.after(() => fs.rm(parent, { recursive: true, force: true }))
  const dataDir = join(parent, 'data')
  await fs.mkdir(dataDir, { mode: 0o700 })
  const path = join(dataDir, 'config.json')
  if (text !== undefined) await fs.writeFile(path, text, { mode })
  const records = new Map([builtin, alpha, beta].map(row => [row.id, { ...row, privatePath: '/fixture/private/SKILL.md' }]))
  let choices = [{ id: 'general', name: 'General', enabled: true, internalPrompt: 'hidden' },
    { id: 'chosen', name: 'Disabled but known', enabled: false }]
  const calls = { list: 0, get: 0, stamps: 0, stamp: 0 }
  const documents = {
    async list() { calls.list++; return [...records.values()].map(record => ({ ...record })) },
    async get(id) {
      calls.get++
      const raw = records.get(id)
      return raw ? { ...raw, ...(raw.source === 'custom' ? details : { privateBuiltinBody: 'hidden' }) } : null
    },
    async stamps() { calls.stamps++; return [...records.values()].map(({ id, documentRevision }) => ({ id, documentRevision })) },
    async stamp(id) { calls.stamp++; return records.get(id)?.documentRevision ?? null }
  }
  const options = { dataDir, documents, withRoleChoices: async callback => callback(choices) }
  function open(overrides) {
    const library = openSkillLibrary({ ...options, ...overrides })
    t.after(() => library.close())
    return library
  }
  return { parent, dataDir, path, records, calls, options, open, library: open(), setChoices: next => { choices = next } }
}

const revisionOf = async (library, id = 'alpha') => (await library.get(id)).skill.revision

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

test('lazy factory, catalog/detail projections, stable restart receipts, protected builtins and missing native files', async t => {
  const { dataDir, library, open, calls } = await fixture(t)
  assert.deepEqual(calls, { list: 0, get: 0, stamps: 0, stamp: 0 })
  assert.deepEqual(await fs.readdir(dataDir), [])
  const catalog = await library.list()
  assert.equal(catalog.execution, execution)
  assert.match(catalog.revision, hex)
  assert.equal(await library.revision(), catalog.revision)
  assert.deepEqual(await open().list(), catalog)
  const [built, native, second] = catalog.skills
  assert.deepEqual(built, { id: builtin.id, name: builtin.name, description: builtin.description, source: 'builtin',
    enabled: true, roles: null, revision: built.revision, canConfigure: false })
  assert.deepEqual(native, { id: alpha.id, name: alpha.name, description: alpha.description, source: 'custom',
    enabled: true, roles: null, revision: native.revision, canConfigure: true })
  for (const view of [built, native, second]) assert.match(view.revision, hex)
  assert.notEqual(second.revision, native.revision)
  assert.deepEqual(await library.get('create-skill'), { skill: { ...built, detail: 'builtin' }, execution })
  assert.deepEqual(await library.get('alpha'), { skill: { ...native, detail: 'document', ...details }, execution })
  assert.deepEqual(await library.get('missing'), { skill: null, execution })
  assert.deepEqual(await library.roles(), { roles: [{ id: 'general', name: 'General', enabled: true },
    { id: 'chosen', name: 'Disabled but known', enabled: false }] })
  await assert.rejects(library.set(built.id, { revision: built.revision, enabled: true }, owner), err(409, 'skill_builtin'))
  await assert.rejects(library.set('missing', { revision: native.revision, enabled: false }, owner), err(404, 'skill_not_found'))
  assert.deepEqual(await library.set(native.id, { revision: native.revision, enabled: true }, owner), { skill: native, execution })
  assert.deepEqual(await fs.readdir(dataDir), [])
  const updated = await library.set(native.id, { revision: native.revision, enabled: false }, owner)
  assert.deepEqual(await fs.readdir(dataDir), ['config.json'])
  assert.equal((await fs.stat(join(dataDir, 'config.json'))).mode & 0o777, 0o600)
  assert.deepEqual(updated, { skill: { ...native, enabled: false, revision: await revisionOf(library) }, execution })
})

test('surgical edits preserve exact unrelated bytes, escaped keys, precision, BOM, and safe legacy permissions', async t => {
  const original = '\ufeff{\r\n' + String.raw`  "future": {"huge":123456789012345678909876543210,"negative":-0,"exp":3.310000e+31,"float":0.100000000000000009,"pair": ["}\\\"🙂", {"b":"\uD800"}]},
  "sk\u0069lls" : { "private":9999999999999999999990,"enabled" : { "\u0061lpha"   : true , "beta": false } , "other":[1, 2]  },
  "secret" : "fixture-personal", "z": "\u00E9" }` + '\r\n'
  const { path, dataDir, library } = await fixture(t, original, 0o644)
  const previous = await fs.stat(path)
  const before = await library.list()
  assert.equal(before.skills[1].canConfigure, true)
  assert.equal(before.skills[2].enabled, false)
  const result = await library.set('alpha', { revision: before.skills[1].revision, enabled: false }, owner)
  const expected = original.replace(': true , "beta"', ': false , "beta"')
  assert.equal(await fs.readFile(path, 'utf8'), expected)
  const saved = await fs.stat(path)
  assert.notEqual(saved.ino, previous.ino)
  assert.equal(saved.mode, previous.mode)
  assert.equal(saved.uid, previous.uid)
  assert.equal(saved.gid, previous.gid)
  assert.equal(result.skill.enabled, false)
  assert.equal(result.skill.revision, await revisionOf(library))
  assert.notEqual(before.revision, await library.revision())
  assert.ok(!JSON.stringify(await library.list()).includes('fixture-personal'))
  const digest = createHash('sha256').update(expected).digest('hex')
  assert.ok(!JSON.stringify(await library.list()).includes(digest))
  assert.deepEqual(await fs.readdir(dataDir), ['config.json'])
})

test('native role scopes preserve stale IDs, unset vs empty, and authoritative picked choices', async t => {
  const original = '{"skills":{"enabled":{"beta":false},"roles":{ "alpha" : ["retired"] , "beta" : ["retired-two"] },"x":3},"mcp":{"roles":{"alpha":["remote-role"]}}}'
  const { path, library, setChoices } = await fixture(t, original)
  const before = await library.get('alpha')
  assert.deepEqual(before.skill.roles, ['retired'])
  await assert.rejects(library.set('alpha', { revision: before.skill.revision, roles: ['retired', 'new-unknown'] }, owner), err(409, 'skill_unknown_role'))
  assert.equal(await fs.readFile(path, 'utf8'), original)
  const preserved = await library.set('alpha', { revision: before.skill.revision, roles: ['retired', 'general'] }, owner)
  assert.deepEqual(preserved.skill.roles, ['retired', 'general'])
  assert.equal(await fs.readFile(path, 'utf8'), original.replace('["retired"]', '["retired","general"]'))
  const none = await library.set('alpha', { revision: preserved.skill.revision, roles: [] }, owner)
  assert.deepEqual(none.skill.roles, [])
  assert.equal(await fs.readFile(path, 'utf8'), original.replace('["retired"]', '[]'))
  const picked = await library.set('alpha', { revision: none.skill.revision, roles: ['chosen', 'general'] }, owner)
  assert.deepEqual(picked.skill.roles, ['chosen', 'general'])
  const pickedText = original.replace('["retired"]', '["chosen","general"]')
  assert.equal(await fs.readFile(path, 'utf8'), pickedText)
  const current = await fs.stat(path)
  assert.deepEqual(await library.set('alpha', { revision: picked.skill.revision, roles: ['chosen', 'general'] }, owner), picked)
  assert.equal((await fs.stat(path)).ino, current.ino)
  setChoices([{ id: 'general', name: 'General', enabled: true }])
  assert.deepEqual((await library.get('alpha')).skill.roles, ['chosen', 'general'])
  await assert.rejects(library.set('alpha', { revision: picked.skill.revision, roles: ['chosen', 'retired'] }, owner), err(409, 'skill_unknown_role'))
  assert.deepEqual(await library.set('alpha', { revision: picked.skill.revision, roles: ['chosen', 'general'] }, owner), picked)
  const all = await library.set('alpha', { revision: picked.skill.revision, roles: null }, owner)
  assert.equal(all.skill.roles, null)
  assert.equal(await fs.readFile(path, 'utf8'), pickedText.replace('"alpha" : ["chosen","general"] ,', ' '))
  assert.deepEqual((await library.get('beta')).skill.roles, ['retired-two'])
})

test('strict config/ID-bound revisions reject old logins, replaced docs/config and no-op stale retries', async t => {
  const { dataDir, path, library, open, records } = await fixture(t, '{"future":"same bytes"}')
  const old = await revisionOf(library)
  const secondLogin = open()
  const different = await revisionOf(secondLogin, 'beta')
  await assert.rejects(secondLogin.set('alpha', { revision: different, enabled: true }, owner), conflict)
  const disabled = await secondLogin.set('alpha', { revision: old, enabled: false }, owner)
  await assert.rejects(library.set('alpha', { revision: old, enabled: false }, owner), conflict)
  const config = await fs.readFile(path)
  await fs.writeFile(join(dataDir, 'replacement'), config, { mode: 0o600 })
  await fs.rename(join(dataDir, 'replacement'), path)
  await assert.rejects(library.set('alpha', { revision: disabled.skill.revision, enabled: false }, owner), conflict)
  const current = await revisionOf(library)
  records.get('alpha').documentRevision = 'replacement-document'
  await assert.rejects(library.set('alpha', { revision: current, enabled: false }, owner), conflict)
  const restarted = await library.list()
  const moduleUrl = new URL('../src/skills/store.mjs', import.meta.url).href
  const { stdout } = await exec(process.execPath, ['--input-type=module', '--eval', `
    import { openSkillLibrary } from ${JSON.stringify(moduleUrl)}
    const rows = ${JSON.stringify([...records.values()])}
    const documents = { list: () => rows, stamps: () => rows, stamp: () => null, get: () => null }
    const library = openSkillLibrary({ dataDir: ${JSON.stringify(dataDir)}, documents, withRoleChoices: cb => cb([]) })
    console.log(JSON.stringify({ revision: await library.revision(), list: await library.list() }))
  `])
  assert.deepEqual(JSON.parse(stdout), { revision: restarted.revision, list: restarted })
})

test('validated shapes, request caps and unsupported native scopes fail closed', async t => {
  const { path, library } = await fixture(t, '{"skills":{"roles":{"alpha":[]}}}')
  const revision = await revisionOf(library)
  for (const change of [{ enabled: true }, { revision, enabled: 1 }, { revision, enabled: false, roles: null },
    { revision, roles: [null] }, { revision, roles: [''] }, { revision, roles: ['general', 'general'] },
    { revision, roles: new Array(1) }, { revision: revision + '\n', enabled: true }, { revision, roles: {} }]) {
    await assert.rejects(library.set('alpha', change, owner), invalid)
  }
  await assert.rejects(library.get('constructor'), invalid)
  await assert.rejects(library.get('alpha\n'), invalid)
  await assert.rejects(library.get('../alpha'), invalid)
  await assert.rejects(library.set('alpha', { revision, roles: Array.from({ length: 65 }, (_, i) => `id-${i}`) }, owner), err(413, 'skill_limit'))
  for (const native of ['{"skills":[],"password":"fixture-private"}', '{"skills":{"roles":{"alpha":[null]}}}',
    '{"skills":{"roles":{"alpha":null}}}', '{"skills":{},"sk\\u0069lls":{}}',
    '{"skills":{"roles":{"alpha":[],"\\u0061lpha":[]}}}', '{"skills":{},}']) {
    await fs.writeFile(path, native)
    await assert.rejects(library.get('alpha'), err(409, 'skill_unsupported'))
    assert.equal(await fs.readFile(path, 'utf8'), native)
  }
  const max = 4 * 1024 * 1024
  await fs.writeFile(path, '{}' + ' '.repeat(max - 1))
  await assert.rejects(library.get('alpha'), err(413, 'skill_limit'))
  await fs.writeFile(path, '{}' + ' '.repeat(max - 2))
  const atLimit = await revisionOf(library)
  await assert.rejects(library.set('alpha', { revision: atLimit, enabled: false }, owner), err(413, 'skill_limit'))
  assert.equal((await fs.stat(path)).size, max)
})

test('original owner is rechecked, vetoes both no-op and staged writes, and native exceptions stay private', async t => {
  const original = '{"private":"fixture-private"}'
  const { path, dataDir, library } = await fixture(t, original)
  const revision = await revisionOf(library)
  for (const verify of [undefined, () => false, async () => true, () => { throw Error('/native/private/path') }]) {
    await assert.rejects(library.set('alpha', { revision, enabled: false }, verify), auth)
  }
  for (const enabled of [true, false]) {
    let calls = 0
    await assert.rejects(library.set('alpha', { revision, enabled }, id => {
      assert.equal(id, 'alpha')
      if (++calls > 1) throw Error('original owner revoked, newer login active')
    }), auth)
    assert.equal(calls, 2)
    assert.equal(await fs.readFile(path, 'utf8'), original)
    assert.deepEqual(await fs.readdir(dataDir), ['config.json'])
  }
  let final = 0
  await assert.rejects(library.set('alpha', { revision, enabled: false }, () => ++final < 3), auth)
  assert.equal(final, 3)
  assert.equal(await fs.readFile(path, 'utf8'), original)
})

test('read-only mode remains inspectable, preserves exact bytes, and root replacement cannot publish', async t => {
  const original = '{"unrelated":true}'
  const { dataDir, parent, path, library } = await fixture(t, original, 0o400)
  const current = (await library.get('alpha')).skill
  assert.equal(current.canConfigure, false)
  await assert.rejects(library.set('alpha', { revision: current.revision, enabled: false }, owner), readOnly)
  assert.equal(await fs.readFile(path, 'utf8'), original)
  await fs.chmod(path, 0o600)
  await fs.chmod(dataDir, 0o500)
  const parentLocked = (await library.get('alpha')).skill
  assert.equal(parentLocked.canConfigure, false)
  await assert.rejects(library.set('alpha', { revision: parentLocked.revision, enabled: false }, owner), readOnly)
  await fs.chmod(dataDir, 0o700)
  await fs.rename(dataDir, join(parent, 'original-root'))
  await fs.mkdir(dataDir, { mode: 0o700 })
  await assert.rejects(library.set('alpha', { revision: parentLocked.revision, enabled: false }, owner), conflict)
  assert.deepEqual(await fs.readdir(dataDir), [])
})

test('role serial is outermost; stale authoritative roster and document/env mutations veto writes', { timeout: 5000 }, async t => {
  const original = '{"unrelated":true}'
  const { dataDir, path, open, records } = await fixture(t, original)
  const library = open({ async withRoleChoices(action) {
    const choices = await withSettingsDirectory(dataDir, null, async () => [{ id: 'general', name: 'General', enabled: true }])
    return action(choices, () => { throw new HttpError(409, 'skill_conflict') })
  } })
  const revision = await revisionOf(library)
  await assert.rejects(library.set('alpha', { revision, roles: ['general'] }, owner), conflict)
  assert.equal(await fs.readFile(path, 'utf8'), original)
  assert.deepEqual(await fs.readdir(dataDir), ['config.json'])
  let authCalls = 0
  await assert.rejects(library.set('alpha', { revision, enabled: false }, () => {
    if (++authCalls === 2) records.get('alpha').documentRevision = 'new-native-document'
    return true
  }), conflict)
  assert.equal(await fs.readFile(path, 'utf8'), original)
  const newRev = await revisionOf(library)
  const replace = fs.rename.bind(fs)
  t.mock.method(fs, 'rename', async (from, to) => {
    await replace(from, to)
    if (from.includes('.config.')) records.get('alpha').documentRevision = 'changed-after-publish'
  })
  await assert.rejects(library.set('alpha', { revision: newRev, enabled: false }, owner), unconfirmed)
  assert.equal(JSON.parse(await fs.readFile(path, 'utf8')).skills.enabled.alpha, false)
  assert.deepEqual(await fs.readdir(dataDir), ['config.json'])
})

test('checks roster changes and the original owner again before confirming a visible publication', async t => {
  const { path, open, library } = await fixture(t, '{"other":true}')
  let verifies = 0
  const roles = open({ async withRoleChoices(action) {
    return action([{ id: 'general', name: 'General', enabled: true }], () => {
      if (++verifies === 2) throw new HttpError(409, 'skill_conflict')
    })
  } })
  const revision = await revisionOf(roles)
  await assert.rejects(roles.set('alpha', { revision, roles: ['general'] }, owner), unconfirmed)
  assert.equal(verifies, 2)
  assert.deepEqual(JSON.parse(await fs.readFile(path, 'utf8')).skills.roles.alpha, ['general'])
  let authChecks = 0
  await assert.rejects(library.set('alpha', { revision: await revisionOf(library), enabled: false }, () => ++authChecks < 4), auth)
  assert.equal(authChecks, 4)
  assert.equal(JSON.parse(await fs.readFile(path, 'utf8')).skills.enabled.alpha, false)
})

test('shared settings inode queue serializes edits and sibling preferences survive', { timeout: 5000 }, async t => {
  const { dataDir, path, open, options } = await fixture(t, '{"skills":{"roles":{"alpha":["general"]},"enabled":{"beta":false}},"mcp":{"ready":true}}')
  const hold = deferred(), release = deferred()
  const readList = options.documents.list.bind(options.documents)
  let pause = false
  options.documents.list = async () => {
    if (pause) { hold.resolve(); await release.promise }
    return readList()
  }
  const library = open()
  const settings = await openSettings({ dataDir })
  const revision = await revisionOf(library)
  pause = true
  const skillWrite = library.set('alpha', { revision, enabled: false }, owner)
  await hold.promise
  const siblingWrite = settings.patch({ set: { theme: 'dark' } })
  release.resolve()
  assert.equal((await skillWrite).skill.enabled, false)
  assert.equal((await siblingWrite).theme, 'dark')
  const current = JSON.parse(await fs.readFile(path, 'utf8'))
  assert.deepEqual(current, { theme: 'dark', skills: { roles: { alpha: ['general'] }, enabled: { beta: false, alpha: false } }, mcp: { ready: true } })
  assert.equal((await library.get('beta')).skill.enabled, false)
})

test('idle revision reads config metadata only, ignores root ctime churn, and safely rejects nonregular nodes', async t => {
  const { dataDir, path, calls, library } = await fixture(t, '{"private":"exact bytes"}')
  const saved = join(dataDir, 'saved-config')
  const open = fs.open.bind(fs)
  let payloads = 0
  t.mock.method(fs, 'open', async (name, flags, ...rest) => {
    if (flags === (constants.O_RDONLY | constants.O_NONBLOCK) && /^\/proc\/self\/fd\/\d+$/.test(name)) payloads++
    return open(name, flags, ...rest)
  })
  const baseline = await library.revision()
  assert.equal(payloads, 0)
  assert.deepEqual(calls, { list: 0, get: 0, stamps: 1, stamp: 0 })
  const { revision } = await library.list()
  assert.equal(revision, baseline)
  assert.equal(payloads, 1)
  await fs.mkdir(join(dataDir, 'unrelated-role-sibling'))
  assert.equal(await library.revision(), baseline)
  assert.equal(payloads, 1)

  await fs.rename(path, saved)
  await fs.symlink(saved, path)
  await assert.rejects(library.revision(), err(409, 'skill_unsupported'))
  await assert.rejects(library.list(), err(409, 'skill_unsupported'))
  await fs.unlink(path)
  const socket = createServer()
  t.after(() => { socket.close() })
  await new Promise((resolve, reject) => socket.once('error', reject).listen(path, resolve))
  await assert.rejects(library.revision(), err(409, 'skill_unsupported'))
  await assert.rejects(library.list(), err(409, 'skill_unsupported'))
  assert.equal(payloads, 1)
  library.close()
  library.close()
  await assert.rejects(library.revision(), unconfirmed)
})

test('publication only confirms durable readback of the inode it actually staged', async t => {
  await t.test('directory fsync failed after rename', async t => {
    const { path, dataDir, library } = await fixture(t, '{"future":true}')
    const revision = await revisionOf(library)
    const nativeRename = fs.rename.bind(fs), nativeOpen = fs.open.bind(fs)
    let renamed = false, postRead = false
    t.mock.method(fs, 'rename', async (from, to) => {
      await nativeRename(from, to)
      if (from.includes('.config.')) renamed = true
    })
    t.mock.method(fs, 'open', async (path, flags, ...rest) => {
      const file = await nativeOpen(path, flags, ...rest)
      if (flags === (constants.O_RDONLY | constants.O_NONBLOCK) && renamed) postRead = true
      if (flags & constants.O_DIRECTORY) {
        const sync = file.sync.bind(file)
        file.sync = async () => {
          if (renamed) throw Object.assign(new Error('fixture directory failure'), { code: 'EIO' })
          return sync()
        }
      }
      return file
    })
    await assert.rejects(library.set('alpha', { revision, enabled: false }, owner), unconfirmed)
    assert.equal(renamed, true)
    assert.equal(postRead, true)
    assert.equal(JSON.parse(await fs.readFile(path, 'utf8')).skills.enabled.alpha, false)
    assert.deepEqual(await fs.readdir(dataDir), ['config.json'])
  })

  await t.test('equivalent bytes on foreign inode', async t => {
    const { path, dataDir, library } = await fixture(t, '{"future":true}')
    const revision = await revisionOf(library)
    const nativeRename = fs.rename.bind(fs)
    let swapped = false
    t.mock.method(fs, 'rename', async (from, to) => {
      await nativeRename(from, to)
      if (!from.includes('.config.')) return
      const alternative = join(dataDir, 'foreign')
      await fs.writeFile(alternative, await fs.readFile(path), { mode: 0o600 })
      await nativeRename(alternative, path)
      swapped = true
    })
    await assert.rejects(library.set('alpha', { revision, enabled: false }, owner), unconfirmed)
    assert.equal(swapped, true)
    assert.equal(JSON.parse(await fs.readFile(path, 'utf8')).skills.enabled.alpha, false)
    assert.deepEqual(await fs.readdir(dataDir), ['config.json'])
  })
})
