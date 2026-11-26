import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { requestControl } from '../src/control/socket.mjs'
import { startWorkbench } from '../src/server.mjs'
import { initializeMasterKey } from '../src/storage/vault.mjs'

const builtins = ['create-agent', 'create-mcp', 'create-skill']
const skillId = 'native-skill-fixture'
const skillName = 'Skill Fixture Name 884add'
const description = 'Skill fixture summary 9d82e1'
const instruction = 'SKILL_BODY_MARKER_4e8cc1'
const privateMarker = 'PRIVATE_CONFIG_MARKER_d149cd'
const outsideMarker = 'OUTSIDE_RESOURCE_MARKER_78ba01'
const roleName = 'Fixture Editor'
const rolePrompt = 'Keep the reply concise.'
const pref = `skills/${skillId}/preferences`
const changes = 'skills/-/changes'
const hex = /^[0-9a-f]{64}$/
const summaryKeys = ['canConfigure', 'description', 'enabled', 'id', 'name', 'revision', 'roles', 'source']
const detailKeys = [...summaryKeys, 'allowedTools', 'compatibility', 'detail', 'instructions', 'license', 'metadata', 'trigger'].sort()
const noChange = Object.freeze({})
const encode = value => Buffer.from(`${JSON.stringify(value)}\n`)
const markdown = (name, marker) => `---\nname: ${name}\ndescription: ${description}\ntrigger: fixture cue\nallowed-tools: [read_file, run_command, skill]\nlicense: MIT\ncompatibility: fixture only\nmetadata:\n  flavor: mint\n---\n${marker}\n\nThis fixture has an optional helper at scripts/helper.mjs.\n`

function expectStatus(result, status, label) {
  assert.equal(result.status, status, `${label ?? result.method + ' ' + result.path}: ${JSON.stringify(result.body)}`)
  return result.body
}

function assertRevision(value) { assert.match(value, hex) }
function assertKeys(value, keys) { assert.deepEqual(Object.keys(value).sort(), keys) }
function assertClean(payload, ...markers) {
  const wire = JSON.stringify(payload)
  for (const marker of markers) assert.equal(wire.includes(marker), false, `unexpected response content: ${marker}`)
}

async function tempRoot() {
  const parent = await realpath(tmpdir())
  const root = await mkdtemp(join(parent, 'deva-skill-http-'))
  const identity = await lstat(root, { bigint: true })
  const assertIdentity = async () => {
    assert.ok(isAbsolute(root) && dirname(root) === parent && /^deva-skill-http-[A-Za-z0-9]{6}$/.test(basename(root)))
    assert.equal(await realpath(root), root)
    const current = await lstat(root, { bigint: true })
    assert.ok(current.isDirectory() && current.uid === BigInt(process.getuid()) && (current.mode & 0o077n) === 0n)
    assert.deepEqual([current.dev, current.ino], [identity.dev, identity.ino])
  }
  const cleanup = async () => { await assertIdentity(); await rm(root, { recursive: true }) }
  return { root, assertIdentity, cleanup }
}

// Observe real launch entrypoints in this dedicated Node test process. Node's required,
// startup-only flock remains real; ordinary HTTP, the disk watcher and the adapter are untouched.
function observeProcesses() {
  const attempts = []
  const methods = ['spawnSync', 'execSync', 'execFileSync']
  const originals = new Map(methods.map(name => [name, childProcess[name]]))
  const prototype = childProcess.ChildProcess.prototype
  const spawn = prototype.spawn
  const restore = () => {
    prototype.spawn = spawn
    for (const [name, original] of originals) childProcess[name] = original
    syncBuiltinESMExports()
  }
  prototype.spawn = function (options) {
    attempts.push(['spawn', options?.file])
    return Reflect.apply(spawn, this, arguments)
  }
  for (const [name, original] of originals) childProcess[name] = function (file) {
    attempts.push([name, file])
    return Reflect.apply(original, this, arguments)
  }
  syncBuiltinESMExports()
  return { attempts, restore }
}

async function openUpstream(syntheticResource) {
  const requests = []
  const server = createServer(async (req, res) => {
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const payload = JSON.parse(Buffer.concat(chunks))
      requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization, payload })
      if (req.url !== '/v1/chat/completions') return res.writeHead(404).end()
      // Even if a provider sends a tool invocation on its own, the text-only host rejects it.
      const rows = [
        { index: 0, delta: { tool_calls: [{ index: 0, id: 'call_local_fixture', type: 'function',
          function: { name: 'read_file', arguments: JSON.stringify({ path: syntheticResource }) } }] }, finish_reason: null },
        { index: 0, delta: {}, finish_reason: 'tool_calls' }
      ]
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`${rows.map(row => `data: ${JSON.stringify({ choices: [row] })}\n\n`).join('')}data: [DONE]\n\n`)
    } catch (error) {
      requests.push({ error: error.message })
      res.writeHead(400).end()
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    origin: `http://127.0.0.1:${server.address().port}`, requests,
    close: () => new Promise((resolveClose, reject) => {
      server.close(error => error ? reject(error) : resolveClose())
      server.closeAllConnections()
    })
  }
}

async function fixture(t) {
  const { root, assertIdentity, cleanup } = await tempRoot()
  let app, upstream, restoreProcesses
  t.after(async () => {
    try { await app?.close() }
    finally {
      try { await upstream?.close() }
      finally { restoreProcesses?.(); await cleanup() }
    }
  })
  await assertIdentity()
  const { attempts, restore } = observeProcesses()
  restoreProcesses = restore
  const dataDir = join(root, 'data'), keyFile = join(root, 'master.key'), runDir = join(root, 'run'), webDir = join(root, 'web')
  const config = join(dataDir, 'config.json'), skills = join(dataDir, 'skills'), folder = join(skills, skillId)
  const document = join(folder, 'SKILL.md'), helper = join(folder, 'scripts', 'helper.mjs')
  const reference = join(folder, 'references', 'synthetic.txt'), canary = join(folder, 'canary.txt')
  const outside = join(root, 'elsewhere'), outsideFile = join(outside, 'SKILL.md')
  const password = randomBytes(24).toString('hex')
  const upstreamKey = randomBytes(24).toString('hex')
  const seed = {
    locale: 'en', theme: 'dark',
    desktopOnly: { secret: privateMarker, preserve: '  café\t🧪\r\n  ', path: outsideFile, nested: [null, 0, false] },
    mcp: { privateExample: { enabled: true, note: privateMarker } },
    skills: {
      enabled: { [skillId]: false, 'uninstalled-example': true },
      roles: { [skillId]: ['general'], 'uninstalled-example': ['general'] },
      unrelated: { note: privateMarker, bytes: '  ✨\n  ' }
    }
  }
  upstream = await openUpstream(outsideFile)
  await Promise.all([mkdir(dataDir, { mode: 0o700 }), mkdir(webDir, { mode: 0o700 }), mkdir(outside, { mode: 0o700 })])
  await Promise.all([
    initializeMasterKey(keyFile), writeFile(config, encode(seed), { mode: 0o600 }),
    writeFile(join(webDir, 'index.html'), '<!doctype html><script type="module" src="/workbench.js"></script>\n'),
    writeFile(join(webDir, 'workbench.js'), 'export {};\n'),
    writeFile(join(webDir, 'manifest.json'), JSON.stringify({ workbench: { file: 'workbench.js', isEntry: true } })),
    writeFile(outsideFile, markdown(outsideMarker, outsideMarker), { mode: 0o600 })
  ])
  const options = { dataDir, keyFile, runDir, webDir, host: '127.0.0.1', port: 0, businessOptions: { allowedOrigins: [upstream.origin] } }
  const boot = async () => {
    app = await startWorkbench(options)
    assert.deepEqual(attempts.splice(0), [['spawnSync', '/usr/bin/flock']], 'expected only the native writer lock helper at startup')
  }
  await boot()

  // Use the raw request path so the client does not normalize traversal probes before the host sees them.
  function call(path, { method = 'GET', body, login, headers = noChange } = {}) {
    const mutation = method !== 'GET'
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    const wireHeaders = {
      ...(login ? { cookie: login.cookie } : {}),
      ...(mutation ? { origin: app.origin, 'content-type': 'application/json', ...(login ? { 'x-deva-csrf': login.csrf } : {}) } : {}),
      ...(bytes ? { 'content-length': bytes.length } : {}), ...headers
    }
    for (const [key, value] of Object.entries(wireHeaders)) if (value === null) delete wireHeaders[key]
    return new Promise((resolveCall, reject) => {
      const req = request({ host: app.address.address, port: app.address.port, agent: false, method,
        path: path.startsWith('/') ? path : '/api/v1/' + path, headers: wireHeaders, signal: AbortSignal.timeout(11_000) }, res => {
        const parts = []
        res.on('data', chunk => parts.push(chunk))
        res.on('error', reject)
        res.on('end', () => {
          const text = Buffer.concat(parts).toString('utf8')
          try { resolveCall({ status: res.statusCode, method, path, body: JSON.parse(text), cookie: res.headers['set-cookie']?.[0]?.split(';')[0] }) }
          catch (error) { reject(Error(`${method} ${path}: expected JSON (${res.statusCode})`, { cause: error })) }
        })
      })
      req.on('error', reject)
      req.end(bytes)
    })
  }
  async function signIn(claim = false) {
    const credentials = claim ? { password, credential: (await requestControl({ runDir, op: 'claim' })).credential } : { password }
    const response = await call(claim ? 'auth/claim' : 'auth/login', { method: 'POST', body: credentials })
    const { csrf } = expectStatus(response, 200)
    assert.ok(typeof csrf === 'string' && csrf.length > 0 && typeof response.cookie === 'string')
    return { csrf, cookie: response.cookie }
  }

  const owner = await signIn(true), peer = await signIn()
  assert.notEqual(peer.cookie, owner.cookie)
  assert.notEqual(peer.csrf, owner.csrf)
  const send = (path, method, body, headers, login = owner) => call(path, { method, body, headers, login })
  const role = expectStatus(await send('personas', 'POST', { name: roleName, prompt: rolePrompt, enabled: true }), 200).role
  const disabledRole = expectStatus(await send('personas', 'POST', { name: 'Disabled Fixture Role', prompt: privateMarker, enabled: false }), 200).role
  const first = expectStatus(await send('settings', 'GET'), 200)
  const provider = { id: 'skill-http-fixture', name: 'Local SSE fixture', kind: 'custom', purpose: 'llm', accent: '#123456', adapter: 'openai',
    apiHost: upstream.origin + '/v1', enabled: true, models: [{ id: 'local-text', name: 'Local text', enabled: true }] }
  const model = `${provider.id}:local-text`
  const settings = expectStatus(await send('settings', 'PATCH', { revision: first.revision,
    set: { models: { providers: [provider], activeModelId: model, activeEffort: 'default' } } }), 200)
  expectStatus(await send(`provider-keys/${provider.id}`, 'PUT', { value: upstreamKey, revision: settings.revision }), 200)
  // Use valid but deliberately non-canonical native JSON after the ordinary settings
  // setup. This catches lossy reserialization, not just loss of parsed fields.
  const sentinels = [seed.desktopOnly, seed.mcp, seed.skills.unrelated]
  const preservedBytes = sentinels.map(value => JSON.stringify(value, null, '\t').replace('café', 'caf\\u00e9'))
  let native = await readFile(config, 'utf8')
  for (const [i, sentinel] of sentinels.entries()) {
    const compact = JSON.stringify(sentinel)
    assert.ok(native.includes(compact))
    native = native.replace(compact, preservedBytes[i])
  }
  await writeFile(config, native)

  async function installDocument() {
    await Promise.all([mkdir(dirname(helper), { recursive: true, mode: 0o700 }), mkdir(dirname(reference), { recursive: true, mode: 0o700 })])
    await Promise.all([
      writeFile(document, markdown(skillName, instruction), { mode: 0o600 }),
      writeFile(helper, `import { writeFileSync } from 'node:fs';\nwriteFileSync(new URL('../canary.txt', import.meta.url), 'executed');\n`, { mode: 0o700 }),
      writeFile(reference, 'INERT_REFERENCE_MARKER_fdfa5b\n', { mode: 0o600 }),
      symlink(outsideFile, join(dirname(reference), 'outside-link.txt'), 'file')
    ])
  }

  async function rejectNativeLinks() {
    async function tracked(path, target) {
      await assertIdentity()
      assert.ok(isAbsolute(path) && relative(skills, path).split(sep).every(part => part && part !== '..'))
      assert.equal(await realpath(dirname(path)), dirname(path))
      assert.equal(await realpath(path), target ?? path)
      const info = await lstat(path, { bigint: true })
      assert.ok((target ? info.isSymbolicLink() : info.isDirectory()) && info.uid === BigInt(process.getuid()))
      return info
    }
    async function dispose(path, original, target) {
      const current = await tracked(path, target)
      assert.deepEqual([current.dev, current.ino], [original.dev, original.ino])
      await (target ? unlink(path) : rmdir(path))
    }
    const unsupported = async path => assert.deepEqual(expectStatus(await send(path, 'GET'), 409), { error: 'skill_unsupported' })
    const linkedSkill = join(skills, 'linked-skill')
    await symlink(outside, linkedSkill, 'dir')
    const linkedSkillInfo = await tracked(linkedSkill, outside)
    await unsupported('skills')
    await unsupported('skills/linked-skill')
    await dispose(linkedSkill, linkedSkillInfo, outside)

    const linkedFolder = join(skills, 'linked-document'), linkedFile = join(linkedFolder, 'SKILL.md')
    await mkdir(linkedFolder, { mode: 0o700 })
    const folderInfo = await tracked(linkedFolder)
    await symlink(outsideFile, linkedFile, 'file')
    const fileInfo = await tracked(linkedFile, outsideFile)
    await unsupported('skills')
    await unsupported('skills/linked-document')
    await dispose(linkedFile, fileInfo, outsideFile)
    await dispose(linkedFolder, folderInfo)

    const collision = join(skills, 'create-skill')
    await mkdir(collision, { mode: 0o700 })
    const collisionInfo = await tracked(collision)
    await unsupported('skills')
    const builtin = expectStatus(await send('skills/create-skill', 'GET'), 200)
    assert.equal(builtin.skill.source, 'builtin')
    await dispose(collision, collisionInfo)
  }

  async function replaceDocument(bytes) {
    await assertIdentity()
    const temp = join(folder, 'editor-replacement.md')
    assert.equal(relative(root, document), ['data', 'skills', skillId, 'SKILL.md'].join(sep))
    assert.ok(isAbsolute(temp) && dirname(temp) === dirname(document))
    await writeFile(temp, bytes, { mode: 0o600, flag: 'wx' })
    for (const path of [document, temp]) {
      assert.equal(await realpath(path), path)
      const flags = await lstat(path)
      assert.ok(flags.isFile() && flags.nlink === 1 && flags.uid === process.getuid())
    }
    await rename(temp, document)
  }

  return { root, skills, config, document, helper, reference, canary, outsideFile, attempts, upstream, upstreamKey, model,
    role, disabledRole, owner, peer, call, send, signIn, installDocument, replaceDocument, rejectNativeLinks, preservedBytes,
    restart: async () => { await app.close(); await boot() } }
}

async function list(f) {
  const result = expectStatus(await f.send('skills', 'GET'), 200)
  assertKeys(result, ['execution', 'revision', 'skills'])
  assert.equal(result.execution, 'inactive')
  assertRevision(result.revision)
  for (const summary of result.skills) {
    assertKeys(summary, summaryKeys)
    assertRevision(summary.revision)
  }
  assertClean(result, f.root, instruction, privateMarker, outsideMarker, 'instructions', 'allowedTools', 'INERT_REFERENCE_MARKER')
  return result
}

async function selected(f, id = skillId) { return expectStatus(await f.send(`skills/${id}`, 'GET'), 200) }
function poll(f, after, waitMs, login) { return f.send(changes, 'POST', { after, waitMs }, undefined, login) }
function checkedPoll(result, changed) {
  const body = expectStatus(result, 200)
  assertKeys(body, ['changed', 'revision'])
  assert.equal(body.changed, changed)
  assertRevision(body.revision)
  return body.revision
}
async function pending(promise) {
  const tick = Symbol('pending')
  assert.equal(await Promise.race([promise, delay(200, tick)]), tick, 'long poll returned before the inducing write')
}
async function woken(promise, signal = 'the change') {
  const controller = new AbortController()
  try {
    return await Promise.race([promise, delay(4500, undefined, { signal: controller.signal }).then(() => {
      assert.fail(`long poll did not wake promptly after ${signal}`)
    })])
  } finally { controller.abort() }
}

async function projections(f) {
  assert.equal(expectStatus(await f.call('/readyz'), 200).status, 'ready')
  assert.equal(expectStatus(await f.send('bootstrap', 'GET'), 200).capabilities.skillLibrary, true)
  const before = await readFile(f.config)
  await assert.rejects(lstat(f.skills), { code: 'ENOENT' })
  for (const path of ['skills', `skills/${skillId}`, 'skills/-/roles']) expectStatus(await f.call(path), 401)
  const absent = await list(f)
  assert.deepEqual(absent.skills.map(s => s.id).sort(), builtins)
  assert.deepEqual(await selected(f), { skill: null, execution: 'inactive' })
  for (const row of absent.skills) {
    assert.equal(row.source, 'builtin')
    assert.equal(row.canConfigure, false)
    const detail = await selected(f, row.id)
    assert.deepEqual(detail, { skill: { ...row, detail: 'builtin' }, execution: 'inactive' })
  }
  await assert.rejects(lstat(f.skills), { code: 'ENOENT' })
  assert.deepEqual(await readFile(f.config), before)

  await f.installDocument()
  await f.rejectNativeLinks()
  const installed = await list(f)
  assert.deepEqual(installed.skills.map(s => s.id).sort(), [...builtins, skillId].sort())
  const custom = installed.skills.find(s => s.id === skillId)
  assert.deepEqual(custom, { id: skillId, name: skillName, description, source: 'custom', enabled: false, roles: ['general'],
    revision: custom.revision, canConfigure: true })
  const detail = await selected(f)
  assertKeys(detail, ['execution', 'skill'])
  assertKeys(detail.skill, detailKeys)
  assert.deepEqual(detail, { execution: 'inactive', skill: { ...custom, detail: 'document',
    instructions: markdown(skillName, instruction).split('---\n').at(-1).trim(), trigger: 'fixture cue',
    allowedTools: ['read_file', 'run_command', 'skill'], license: 'MIT', compatibility: 'fixture only', metadata: { flavor: 'mint' } } })
  assertClean(detail, f.root, privateMarker, outsideMarker, 'INERT_REFERENCE_MARKER')
  for (const id of ['linked-skill', 'linked-document', 'missing-skill']) assert.deepEqual(await selected(f, id), { skill: null, execution: 'inactive' })
  const roster = expectStatus(await f.send('skills/-/roles', 'GET'), 200)
  assertKeys(roster, ['roles'])
  assert.deepEqual([...roster.roles].sort((a, b) => a.id.localeCompare(b.id)), [
    { id: 'general', name: 'General', enabled: true },
    { id: f.role.id, name: roleName, enabled: true },
    { id: f.disabledRole.id, name: 'Disabled Fixture Role', enabled: false }
  ].sort((a, b) => a.id.localeCompare(b.id)))
  assert.ok(roster.roles.every(r => typeof r.name === 'string' && r.name.length > 0))
  assertClean(roster, rolePrompt, privateMarker, f.root)
  assert.deepEqual(await readFile(f.config), before)
  return installed
}

async function preferences(f, installed) {
  const bytes = await readFile(f.config)
  const original = JSON.parse(bytes)
  const docs = await Promise.all([f.document, f.helper, f.reference, f.outsideFile].map(path => readFile(path)))
  let current = installed.skills.find(s => s.id === skillId)
  const revision = current.revision
  const turnOn = { revision, enabled: true }
  const patch = (edit, login, headers) => f.send(pref, 'PATCH', { revision: current.revision, ...edit }, headers, login)
  expectStatus(await f.call(pref, { method: 'PATCH', body: turnOn }), 401)
  expectStatus(await f.send(pref, 'PATCH', turnOn, { origin: 'http://127.0.0.1:1' }), 403)
  expectStatus(await f.send(pref, 'PATCH', turnOn, { origin: null }), 403)
  expectStatus(await f.send(pref, 'PATCH', turnOn, { 'x-deva-csrf': f.peer.csrf }), 401)
  expectStatus(await f.send(pref, 'PATCH', turnOn, { 'x-deva-csrf': null }), 401)
  for (const body of [
    { revision }, { revision, enabled: true, roles: null }, { revision, enabled: 'true' },
    { revision, enabled: true, path: '../elsewhere/SKILL.md' }, { revision, enabled: true, id: 'linked-skill' },
    { revision, roles: [17] }, { revision, roles: 'general' }, { revision: 'short', enabled: true }
  ]) expectStatus(await f.send(pref, 'PATCH', body), 400)
  for (const path of [
    '/api/v1/skills/%2e%2e/preferences', '/api/v1/skills/../preferences', '/api/v1/skills/native%2foutside/preferences'
  ]) expectStatus(await f.send(path, 'PATCH', turnOn), 400)
  const builtin = installed.skills.find(s => s.id === 'create-skill')
  assert.deepEqual(expectStatus(await f.send('skills/create-skill/preferences', 'PATCH', { revision: builtin.revision, enabled: false }), 409),
    { error: 'skill_builtin' })
  assert.deepEqual(expectStatus(await patch({ roles: ['not-a-roster-role'] }), 409), { error: 'skill_unknown_role' })
  for (const path of [`skills/${skillId}/resources/references/synthetic.txt`, `skills/${skillId}/references/synthetic.txt`,
    `skills/${skillId}/references/outside-link.txt`]) {
    assertClean(expectStatus(await f.send(path, 'GET'), 404), 'INERT_REFERENCE_MARKER', f.root)
  }
  expectStatus(await f.send(`skills/${skillId}/execute`, 'POST', {}), 404)
  expectStatus(await f.send(`skills/${skillId}`, 'DELETE'), 405)
  assert.deepEqual(await readFile(f.config), bytes, 'reading and rejected mutations made no config write')

  await chmod(f.config, 0o400)
  try {
    const ro = await selected(f)
    assert.equal(ro.skill.canConfigure, false)
    const deniedWrite = await f.send(pref, 'PATCH', { revision: ro.skill.revision, enabled: true })
    assert.deepEqual(expectStatus(deniedWrite, 403), { error: 'skill_read_only' })
    assert.deepEqual(await readFile(f.config), bytes)
  } finally { await chmod(f.config, 0o600) }
  current = (await selected(f)).skill
  const previous = current.revision
  const before = (await list(f)).revision
  assert.equal(checkedPoll(await poll(f, before, 0), false), before)
  const waiting = poll(f, before, 8000, f.peer)
  // Surface early transport rejection via pending(), and keep the promise observed on assertion failure.
  void waiting.catch(() => {})
  await pending(waiting)
  const apply = async (edit, expected) => {
    const updated = expectStatus(await patch(edit), 200)
    assertKeys(updated, ['execution', 'skill'])
    assertKeys(updated.skill, summaryKeys)
    assert.equal(updated.execution, 'inactive')
    assertRevision(updated.skill.revision)
    assert.notEqual(updated.skill.revision, current.revision)
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(updated.skill[key], value)
    current = updated.skill
    const stored = JSON.parse(await readFile(f.config))
    const native = structuredClone(original)
    native.skills.enabled[skillId] = current.enabled
    if (current.roles === null) delete native.skills.roles[skillId]
    else native.skills.roles[skillId] = current.roles
    assert.deepEqual(stored, native)
    const wire = await readFile(f.config)
    for (const sentinel of f.preservedBytes) {
      assert.ok(wire.includes(sentinel), 'unrelated config spelling, whitespace and bytes survived the write')
    }
    return updated.skill
  }
  await apply({ enabled: true }, { enabled: true, roles: ['general'] })
  const changed = checkedPoll(await woken(waiting, 'the preference write'), true)
  assert.notEqual(changed, before)
  assert.equal(changed, (await list(f)).revision)
  assert.deepEqual(expectStatus(await f.send(pref, 'PATCH', { revision: previous, enabled: false }, undefined, f.peer), 409), { error: 'skill_conflict' })
  await apply({ roles: null }, { enabled: true, roles: null })
  assert.equal((await selected(f)).skill.roles, null)
  await apply({ roles: [] }, { enabled: true, roles: [] })
  assert.deepEqual((await selected(f)).skill.roles, [])
  await apply({ roles: [f.role.id] }, { enabled: true, roles: [f.role.id] })
  assert.deepEqual(await Promise.all([f.document, f.helper, f.reference, f.outsideFile].map(path => readFile(path))), docs)
}

async function changesAndDisk(f) {
  const initial = (await list(f)).revision
  const valid = { after: initial, waitMs: 0 }
  expectStatus(await f.call(changes, { method: 'POST', body: valid }), 401)
  expectStatus(await f.send(changes, 'POST', valid, { origin: 'https://invalid.example' }), 403)
  expectStatus(await f.send(changes, 'POST', valid, { 'x-deva-csrf': null }), 401)
  for (const input of [{ after: initial }, { ...valid, extra: true }, { ...valid, after: 'g'.repeat(64) },
    { ...valid, waitMs: -1 }, { ...valid, waitMs: 8001 }, { ...valid, waitMs: 0.5 }, { ...valid, waitMs: '0' }]) {
    expectStatus(await f.send(changes, 'POST', input), 400)
  }
  assert.equal(checkedPoll(await poll(f, initial, 0), false), initial)
  const revoked = poll(f, initial, 8000, f.peer)
  const observing = poll(f, initial, 8000)
  void revoked.catch(() => {})
  void observing.catch(() => {})
  await Promise.all([pending(revoked), pending(observing)])
  expectStatus(await f.send('auth/logout', 'POST', undefined, undefined, f.peer), 200)
  expectStatus(await f.call('skills', { login: f.peer }), 401)
  const original = await readFile(f.config)
  const edited = markdown(skillName, 'EXTERNALLY_EDITED_BODY_2d630d')
  await writeFile(f.document, edited)
  assert.deepEqual(expectStatus(await woken(revoked, 'revocation'), 401), { error: 'auth' })
  const editedRevision = checkedPoll(await woken(observing, 'the external file edit'), true)
  assert.notEqual(editedRevision, initial)
  assert.equal((await selected(f)).skill.instructions.split('\n')[0], 'EXTERNALLY_EDITED_BODY_2d630d')
  assert.deepEqual(await readFile(f.document), Buffer.from(edited))
  assert.deepEqual(await readFile(f.config), original)

  // No refresh, Send, or other writer runs between arming the long poll and atomic editor replacement.
  const observingReplacement = poll(f, editedRevision, 8000)
  void observingReplacement.catch(() => {})
  await pending(observingReplacement)
  const replacedName = `${skillName} Replaced`
  const replacement = markdown(replacedName, 'ATOMIC_REPLACEMENT_BODY_415173')
  await f.replaceDocument(replacement)
  const replacementRevision = checkedPoll(await woken(observingReplacement, 'the atomic document replacement'), true)
  assert.notEqual(replacementRevision, editedRevision)
  const after = await list(f)
  assert.equal(after.revision, replacementRevision)
  assert.equal(after.skills.find(s => s.id === skillId).name, replacedName)
  assert.deepEqual(await readFile(f.document), Buffer.from(replacement))
  assert.deepEqual(await readFile(f.config), original, 'watcher did not rewrite native preferences')
  assert.equal(f.upstream.requests.length, 0, 'idle library operations initiated no model requests')
  assert.deepEqual(f.attempts, [], 'idle library operations spawned no processes')
}

async function textOnly(f) {
  const detail = (await selected(f)).skill
  assert.equal(detail.enabled, true)
  assert.deepEqual(detail.roles, [f.role.id])
  const sid = randomUUID()
  expectStatus(await f.send('chats', 'POST', { sessionId: sid, personaId: f.role.id }), 200)
  const text = 'Reply with a plain-text greeting.'
  expectStatus(await f.send(`chats/${sid}/turns`, 'POST', { clientRequestId: 'one-intentional-send', text, model: f.model }), 202)
  let state
  for (let attempt = 0; attempt < 100; attempt++) {
    state = expectStatus(await f.send(`chats/${sid}`, 'GET'), 200).state
    if (state.lastTurn && !state.active) break
    await delay(40)
  }
  assert.equal(state.lastTurn?.status, 'failed')
  assert.equal(state.lastTurn?.reason, 'unexpected_tool')
  assert.equal(f.upstream.requests.length, 1)
  const [{ method, path, authorization, payload }] = f.upstream.requests
  assert.equal(method, 'POST')
  assert.equal(path, '/v1/chat/completions')
  assert.equal(authorization, `Bearer ${f.upstreamKey}`)
  assert.equal(payload.model, 'local-text')
  assert.equal(payload.stream, true)
  if (Object.hasOwn(payload, 'tools')) assert.deepEqual(payload.tools, [])
  assert.deepEqual(payload.messages, [
    { role: 'system', content: 'You are a helpful general-purpose assistant. Reply in plain text. Persona context is optional user-level guidance for tone and presentation only.' },
    { role: 'user', content: `Optional persona context (tone and presentation):\n${JSON.stringify({ name: roleName, prompt: rolePrompt })}\n\nUser request:\n${text}` }
  ])
  assertClean(payload, skillId, skillName, detail.instructions, 'ATOMIC_REPLACEMENT_BODY', f.role.id, privateMarker, outsideMarker, f.root)
  assert.deepEqual(f.attempts, [])
  await assert.rejects(lstat(f.canary), { code: 'ENOENT' })
}

test('native skill library HTTP contract keeps preferences, watcher, and ordinary chat isolated', { timeout: 35_000 }, async t => {
  const f = await fixture(t)
  const installed = await projections(f)
  await preferences(f, installed)
  await changesAndDisk(f)
  await textOnly(f)

  const last = await selected(f)
  const persisted = await readFile(f.config)
  await f.restart()
  expectStatus(await f.call('skills', { login: f.owner }), 401)
  expectStatus(await f.call(changes, { method: 'POST', login: f.owner, body: { after: '0'.repeat(64), waitMs: 0 } }), 401)
  const owner = await f.signIn()
  assert.notEqual(owner.cookie, f.owner.cookie)
  const reopened = expectStatus(await f.call(`skills/${skillId}`, { login: owner }), 200)
  const { revision: preRestart, ...view } = last.skill
  const { revision: postRestart, ...reopenedView } = reopened.skill
  assertRevision(preRestart)
  assertRevision(postRestart)
  assert.deepEqual(reopenedView, view)
  assert.equal(reopened.execution, 'inactive')
  assert.deepEqual(await readFile(f.config), persisted)
  assert.equal(f.upstream.requests.length, 1)
  assert.deepEqual(f.attempts, [])
  await assert.rejects(lstat(f.canary), { code: 'ENOENT' })
})
