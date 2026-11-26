import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { runInNewContext } from 'node:vm'
import { HEADER_MASK, openSettings } from '../src/business/settings.mjs'
import { initializeMasterKey, openVault } from '../src/storage/vault.mjs'

const exec = promisify(execFile)
const INVALID = { code: 'ERR_SETTINGS_INVALID' }
const REQUIRED = { code: 'ERR_SETTINGS_REVISION_REQUIRED' }
const CONFLICT = { code: 'ERR_SETTINGS_CONFLICT' }
const CORRUPT = { code: 'ERR_SETTINGS_CORRUPT' }
const READ_ONLY = { code: 'ERR_SETTINGS_READ_ONLY' }
const NOT_FOUND = { code: 'ERR_SETTINGS_PROVIDER_NOT_FOUND' }
const UNAVAILABLE = { code: 'ERR_SETTINGS_UNAVAILABLE' }
const MIGRATION = { code: 'ERR_SETTINGS_MIGRATION_REQUIRED' }
const vaultNamespace = 'settings:provider:'
const provider = (config, id) => config.models.providers.find(p => p.id === id)
const custom = (id = 'custom-123', overrides = {}) => ({
  id, name: id, kind: 'custom', purpose: 'llm', accent: '#8a8a94', adapter: 'openai',
  apiHost: 'https://example.test/v1', enabled: true, models: [], ...overrides
})

async function fixture(t, { dataDirExists = false } = {}) {
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'deva-settings-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const dataDir = join(root, 'data')
  if (dataDirExists) await fs.mkdir(dataDir, { mode: 0o700 })
  const keyFile = join(root, 'master.key')
  await initializeMasterKey(keyFile)
  return { dataDir, keyFile, configFile: join(dataDir, 'config.json'), vaultFile: join(dataDir, 'headless-vault.json') }
}

async function start(t) {
  const paths = await fixture(t)
  const vault = await openVault(paths)
  const settings = await openSettings({ ...paths, vault })
  return { ...paths, vault, settings }
}

async function replaceProviders(settings, providers, revision) {
  return settings.patch({ set: { models: { providers } }, revision })
}

function update(config, id, patch) {
  return config.models.providers.map(p => p.id === id ? { ...p, ...patch } : p)
}

async function readDisk(path) {
  return JSON.parse(await fs.readFile(path, 'utf8'))
}

async function assertNoPlaintext(paths, ...values) {
  for (const file of [paths.configFile, paths.vaultFile]) {
    const data = await fs.readFile(file, 'utf8')
    for (const value of values) assert.equal(data.includes(value), false)
  }
}

// Compare the actual renderer-side catalogue, not another handwritten seed fixture.
async function desktopSeeds() {
  const path = new URL('../../desktop/src/renderer/src/mock/models.ts', import.meta.url)
  const source = await fs.readFile(path, 'utf8')
  const literal = /^export const seedProviders: Provider\[\] = (\[[\s\S]*?^\])/m.exec(source)?.[1]
  assert.ok(literal)
  return JSON.parse(JSON.stringify(runInNewContext(literal, {}, { timeout: 100 })))
    .map(seed => ({ ...seed, purpose: seed.purpose ?? 'llm' }))
}

test('fresh settings mirror every desktop seed, including decision:jev and local Ollama', async t => {
  const { settings, configFile, vault } = await start(t)
  const snapshot = await settings.getPublicConfig()
  assert.match(snapshot.revision, /^[a-f0-9]{64}$/)
  assert.deepEqual(Object.keys(snapshot).sort(), ['models', 'revision'])
  assert.deepEqual(snapshot.models, { providers: await desktopSeeds(), activeModelId: null, activeEffort: 'default' })
  assert.deepEqual(await settings.getProvider('typesafe'), { ...provider(snapshot, 'typesafe'), apiKey: null })
  assert.equal(await settings.getProvider('missing'), null)
  assert.equal(await settings.available(), true)
  assert.deepEqual(await settings.listKeys(), [])
  assert.deepEqual(await vault.list(), [])
  assert.equal(await settings.hasKey('openai'), false)
  await assert.rejects(fs.stat(configFile), { code: 'ENOENT' })
  await assert.rejects(replaceProviders(settings, []), REQUIRED)
  await assert.rejects(settings.patch({ set: { models: { providers: [] } } }), REQUIRED)
})

test('hydrates saved providers in saved order, fills new seeds, and preserves unrelated desktop sections', async t => {
  const paths = await fixture(t)
  const vault = await openVault(paths)
  const unrelated = {
    git: { path: '/usr/bin/git' },
    mcp: { enabled: { example: true }, localDetail: 'fixture-private-mcp-value' },
    remote: { bots: [{ cookie: 'fixture-unrelated-cookie' }] },
    skills: { enabled: { example: true } },
    desktopFuture: { nested: ['retained', { devicePort: 8060 }] }
  }
  const rollup = custom('custom-legacy', { apiHost: 'http://127.0.0.1:3001/v1' })
  delete rollup.name
  delete rollup.purpose
  rollup.models = [{ id: 'qwen:8b', enabled: true }, { id: 'disabled', name: 'Disabled' }]
  rollup.token = 'fixture-discarded-model-token'
  const seeds = await desktopSeeds()
  const saved = {
    ...unrelated,
    models: { activeModelId: 'custom-legacy:qwen:8b', activeEffort: 'xhigh', providers: [rollup, {
      ...seeds.find(p => p.id === 'opencode-go'), name: 'My OpenCode', enabled: true,
      models: [{ id: 'vendor/qwen3:8b', name: 'Qwen', enabled: true, tags: ['视觉', '推理'],
        contextWindow: 131072, maxOutput: 16384 }]
    }] },
    theme: 'dark', locale: 'en', closeToTray: false, chatFontSize: 'lg',
    layout: { sidebarWidth: 312, sidebarCollapsed: false, composerHeight: 90 }
  }
  await fs.writeFile(paths.configFile, JSON.stringify(saved))
  const settings = await openSettings({ ...paths, vault })
  const initial = await settings.getPublicConfig()
  assert.deepEqual(Object.keys(initial).sort(), ['chatFontSize', 'closeToTray', 'layout', 'locale', 'models', 'revision', 'theme'])
  assert.equal(initial.models.activeModelId, 'custom-legacy:qwen:8b')
  assert.equal(initial.models.activeEffort, 'xhigh')
  assert.deepEqual(initial.models.providers.slice(0, 2).map(p => p.id), ['custom-legacy', 'opencode-go'])
  assert.equal(initial.models.providers.length, seeds.length + 1)
  assert.equal(provider(initial, 'custom-legacy').name, 'custom-legacy')
  assert.equal(provider(initial, 'custom-legacy').purpose, 'llm')
  assert.deepEqual(provider(initial, 'custom-legacy').models, [
    { id: 'qwen:8b', name: 'qwen:8b', enabled: true }, { id: 'disabled', name: 'Disabled', enabled: false }
  ])
  assert.equal(provider(initial, 'opencode-go').name, 'My OpenCode')
  assert.deepEqual(provider(initial, 'opencode-go').models, saved.models.providers[1].models)
  assert.equal(provider(initial, 'typesafe').threshold, 0.6)
  const publicJson = JSON.stringify(initial)
  for (const v of ['cookie', 'mcp', 'token', 'fixture-', 'desktopFuture', '_devaHeadlessSettings']) {
    assert.equal(publicJson.includes(v), false)
  }
  const after = await settings.patch({ set: { theme: 'system', layout: { sidebarCollapsed: true }, models: { activeEffort: 'max' } },
    unset: ['layout.composerHeight', 'closeToTray'] })
  assert.notEqual(after.revision, initial.revision)
  assert.deepEqual(after.layout, { sidebarWidth: 312, sidebarCollapsed: true })
  assert.equal(after.models.activeEffort, 'max')
  assert.equal(after.closeToTray, undefined)
  const disk = await readDisk(paths.configFile)
  for (const [k, v] of Object.entries(unrelated)) assert.deepEqual(disk[k], v)
  assert.equal(disk.models.providers.length, 2)
  assert.equal(Object.hasOwn(disk.models.providers[0], 'token'), false)
})

test('headers and keys are private; masks preserve, replace, and delete only the selected rows', async t => {
  const paths = await start(t)
  const { settings, vault } = paths
  const f = await settings.getPublicConfig()
  const secretHeader = 'fixture-cookie-vault-private-1'
  const key = 'fixture-openai-vault-key example'
  const c = await replaceProviders(settings, update(f, 'openai', { headers: { Cookie: secretHeader, 'X-Example-Token': 'fixture-token-only' } }), f.revision)
  assert.deepEqual(provider(c, 'openai').headers, { cookie: HEADER_MASK, 'x-example-token': HEADER_MASK })
  const result = await settings.setKey('openai', key, c.revision)
  assert.deepEqual(result, { ok: true, available: true, revision: (await settings.getPublicConfig()).revision })
  assert.notEqual(result.revision, c.revision)
  assert.deepEqual(await settings.listKeys(), ['openai'])
  assert.equal(await settings.hasKey('openai-responses'), false)
  assert.equal(await settings.hasKey('openai'), true)
  const privateView = await settings.getProvider('openai')
  assert.equal(privateView.apiKey, key)
  assert.deepEqual(privateView.headers, { cookie: secretHeader, 'x-example-token': 'fixture-token-only' })
  const browser = await settings.getPublicConfig()
  assert.equal(JSON.stringify(browser).includes('fixture-'), false)
  assert.equal(Object.hasOwn(provider(browser, 'openai'), 'apiKey'), false)
  const persisted = await readDisk(paths.configFile)
  assert.equal(Object.hasOwn(provider(persisted, 'openai'), 'headers'), false)
  assert.deepEqual(Object.keys(persisted._devaHeadlessSettings.credentials), ['openai'])
  assert.match(persisted._devaHeadlessSettings.credentials.openai, /^[a-f0-9]{32}$/)
  await assertNoPlaintext(paths, HEADER_MASK, key, secretHeader, 'fixture-token-only')
  const otherHeader = 'fixture-custom-replacement'
  const updated = await replaceProviders(settings, update(browser, 'openai', {
    headers: { cookie: HEADER_MASK, 'X-Example-Token': '', 'X-Originator': otherHeader }
  }), browser.revision)
  assert.deepEqual(provider(updated, 'openai').headers, { cookie: HEADER_MASK, 'x-originator': HEADER_MASK })
  const newProvider = await settings.getProvider('openai')
  assert.deepEqual(newProvider.headers, { cookie: secretHeader, 'x-originator': otherHeader })
  assert.equal(newProvider.apiKey, key)
  assert.equal((await vault.list(vaultNamespace)).length, 1)
  const maskOnlyRoundTrip = await replaceProviders(settings, updated.models.providers, updated.revision)
  assert.deepEqual(maskOnlyRoundTrip, updated)
  await assert.rejects(replaceProviders(settings, update(browser, 'openai', { headers: { cookie: 'fixture-stale-edit' } }), browser.revision), CONFLICT)
  await assert.rejects(settings.deleteKey('openai', c.revision), CONFLICT)
  const keyDeleted = await settings.deleteKey('openai', updated.revision)
  assert.equal(await settings.hasKey('openai'), false)
  assert.deepEqual((await settings.getProvider('openai')).headers, newProvider.headers)
  const ref = await settings.getPublicConfig()
  assert.equal(ref.revision, keyDeleted.revision)
  const wiped = await replaceProviders(settings, update(ref, 'openai', { headers: {} }), ref.revision)
  assert.equal(provider(wiped, 'openai').headers, undefined)
  assert.deepEqual(await vault.list(vaultNamespace), [])
})

test('URL and ID changes retire credentials; equivalent URLs preserve them and stale tabs fail', async t => {
  const { settings, ...paths } = await start(t)
  const base = await settings.getPublicConfig()
  const privateKey = 'fixture-first-endpoint-only'
  const localProvider = custom('custom-local', { apiHost: 'http://[::1]:3421/v1', headers: { 'x-token': 'fixture-first-header' } })
  const added = await replaceProviders(settings, [...base.models.providers, localProvider], base.revision)
  const keyed = await settings.setKey(localProvider.id, privateKey, added.revision)
  const a = await settings.getPublicConfig()
  const sibling = await openSettings(paths)
  // Display text can change; the HTTP target and complete base path stay the same.
  const equivalent = await replaceProviders(settings, update(a, localProvider.id, { apiHost: 'http://[0:0::1]:3421/v1/' }), a.revision)
  assert.equal((await settings.getProvider(localProvider.id)).apiKey, privateKey)
  const newBase = 'http://[::1]:3421/v2'
  const changed = await replaceProviders(sibling, update(equivalent, localProvider.id, {
    apiHost: newBase, headers: { 'x-token': HEADER_MASK, 'x-replayed-literal': 'fixture-first-header' }
  }), equivalent.revision)
  assert.equal(provider(changed, localProvider.id).headers, undefined)
  assert.equal(await settings.hasKey(localProvider.id), false)
  assert.equal((await settings.getProvider(localProvider.id)).apiKey, null)
  await assert.rejects(settings.setKey(localProvider.id, privateKey, keyed.revision), CONFLICT)
  const newHeaders = await replaceProviders(settings, update(changed, localProvider.id, {
    headers: { 'x-token': 'fixture-explicit-new-header' }
  }), changed.revision)
  await settings.setKey(localProvider.id, 'fixture-new-endpoint-only', newHeaders.revision)
  assert.equal((await settings.getProvider(localProvider.id)).apiHost, newBase)
  const current = await settings.getPublicConfig()
  const gone = await replaceProviders(settings, current.models.providers.filter(p => p.id !== localProvider.id), current.revision)
  assert.deepEqual(await settings.deleteKey(localProvider.id, gone.revision), { ok: true, available: true, revision: gone.revision })
  await assert.rejects(settings.deleteKey(localProvider.id, current.revision), CONFLICT)
  await assert.rejects(settings.setKey(localProvider.id, 'fixture-missing-provider', gone.revision), NOT_FOUND)
  const reused = await replaceProviders(settings, [...gone.models.providers, custom(localProvider.id, { apiHost: newBase })], gone.revision)
  assert.equal(provider(reused, localProvider.id).headers, undefined)
  assert.equal((await settings.getProvider(localProvider.id)).apiKey, null)
})

test('independently opened instances serialize provider replacements by revision and merge disjoint patches', async t => {
  const { settings, ...paths } = await start(t)
  const other = await openSettings({ ...paths, vault: await openVault(paths) })
  const first = await settings.getPublicConfig()
  const results = await Promise.allSettled([
    replaceProviders(settings, update(first, 'openai', { name: 'Tab One' }), first.revision),
    replaceProviders(other, update(first, 'deepseek', { name: 'Tab Two' }), first.revision)
  ])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(results.find(r => r.status === 'rejected').reason.code, CONFLICT.code)
  const saved = await other.getPublicConfig()
  assert.notEqual(saved.revision, first.revision)
  const savedNames = [provider(saved, 'openai').name, provider(saved, 'deepseek').name]
  assert.ok([['Tab One', 'DeepSeek'], ['OpenAI', 'Tab Two']].some(names => names.every((n, i) => n === savedNames[i])))
  await Promise.all([
    settings.patch({ set: { layout: { sidebarWidth: 350 } } }),
    other.patch({ set: { layout: { composerHeight: 130 } } })
  ])
  assert.deepEqual((await other.getPublicConfig()).layout, { sidebarWidth: 350, composerHeight: 130 })
})

test('legacy plaintext desktop headers require an explicit offline migration and stay encrypted after process restart', async t => {
  const paths = await fixture(t)
  const vault = await openVault(paths)
  const cookie = 'fixture-legacy-desktop-cookie'
  const raw = JSON.stringify({
    theme: 'dark', skills: { enabled: { example: true } },
    models: { providers: [custom('custom-legacy', { headers: { Cookie: cookie, 'X-Originator': 'fixture-legacy-origin' } })] }
  })
  await fs.writeFile(paths.configFile, raw)
  await assert.rejects(openSettings({ ...paths, vault }), MIGRATION)
  assert.equal(await fs.readFile(paths.configFile, 'utf8'), raw)
  assert.deepEqual(await vault.list(), [])
  await fs.chmod(paths.configFile, 0o400)
  await assert.rejects(openSettings({ ...paths, vault, migrateLegacyHeaders: true }), READ_ONLY)
  assert.equal(await fs.readFile(paths.configFile, 'utf8'), raw)
  assert.deepEqual(await vault.list(), [])
  await fs.chmod(paths.configFile, 0o600)
  const settings = await openSettings({ ...paths, vault, migrateLegacyHeaders: true })
  const first = await settings.getPublicConfig()
  assert.deepEqual(provider(first, 'custom-legacy').headers, { cookie: HEADER_MASK, 'x-originator': HEADER_MASK })
  const key = 'fixture-key-after-migration'
  const keyed = await settings.setKey('custom-legacy', key, first.revision)
  await assertNoPlaintext(paths, key, cookie, 'fixture-legacy-origin', HEADER_MASK)
  assert.deepEqual((await readDisk(paths.configFile)).skills, { enabled: { example: true } })
  const settingsModule = new URL('../src/business/settings.mjs', import.meta.url)
  const vaultModule = new URL('../src/storage/vault.mjs', import.meta.url)
  const fresh = await exec(process.execPath, ['--input-type=module', '-e', `
    import { openSettings } from ${JSON.stringify(settingsModule.href)};
    import { openVault } from ${JSON.stringify(vaultModule.href)};
    const [dataDir, keyFile] = process.argv.slice(1);
    const api = await openSettings({ vault: await openVault({ dataDir, keyFile }) });
    const snapshot = await api.getPublicConfig();
    const provider = await api.getProvider('custom-legacy');
    process.stdout.write(JSON.stringify({ revision: snapshot.revision, headers: snapshot.models.providers[0].headers,
      keys: await api.listKeys(), hasInternalCredential: provider.apiKey.startsWith('fixture-') && provider.headers.cookie.startsWith('fixture-') }));
  `, paths.dataDir, paths.keyFile], { env: { ...process.env, DEVA_HOME: paths.dataDir } })
  assert.deepEqual(JSON.parse(fresh.stdout), { revision: keyed.revision, headers: { cookie: HEADER_MASK, 'x-originator': HEADER_MASK },
    keys: ['custom-legacy'], hasInternalCredential: true })
})

test('failed publication after staging leaves the previous config and encrypted snapshot intact', async t => {
  const paths = await start(t)
  const { settings, vault, configFile } = paths
  const baseline = await settings.getPublicConfig()
  await settings.setKey('openai', 'fixture-original-atomic-key', baseline.revision)
  const rawBefore = await fs.readFile(configFile, 'utf8')
  const slotsBefore = await vault.list(vaultNamespace)
  let inject = true
  const interposed = {
    ...vault,
    async set(name, value) {
      await vault.set(name, value)
      // The real config snapshot changes after vault staging, outside the settings queue.
      if (value && inject) {
        inject = false
        await fs.chmod(configFile, 0o400)
      }
    }
  }
  const competing = await openSettings({ ...paths, vault: interposed })
  const snapshot = await competing.getPublicConfig()
  await assert.rejects(competing.setKey('openai', 'fixture-new-atomic-key', snapshot.revision), CONFLICT)
  assert.deepEqual(await vault.list(vaultNamespace), slotsBefore)
  assert.equal(await fs.readFile(configFile, 'utf8'), rawBefore)
  assert.equal((await settings.getProvider('openai')).apiKey, 'fixture-original-atomic-key')
  await assert.rejects(settings.patch({ set: { theme: 'dark' } }), READ_ONLY)
  await assert.rejects(settings.deleteKey('openai'), READ_ONLY)
  await fs.chmod(configFile, 0o600)
  const now = await settings.getPublicConfig()
  await settings.deleteKey('openai', now.revision)
  assert.equal(await settings.hasKey('openai'), false)
})

test('detects corrupt existing config and vault, bad references, crossed URL bindings, and external disappearance', async t => {
  const paths = await start(t)
  const { settings, vault, configFile, vaultFile } = paths
  for (const bad of ['{', 'null', '[]', '{"models":[]}', '{"theme":"arbitrary"}', '{"__proto__":{"settingsPolluted":true}}']) {
    await fs.writeFile(configFile, bad)
    await assert.rejects(openSettings(paths), CORRUPT)
    await assert.rejects(settings.patch({ set: { theme: 'light' } }), CORRUPT)
    assert.equal(await fs.readFile(configFile, 'utf8'), bad)
  }
  await fs.writeFile(configFile, '{}')
  const first = await settings.getPublicConfig()
  const init = await replaceProviders(settings, update(first, 'openai', { headers: { cookie: 'fixture-original-cookie' } }), first.revision)
  await settings.setKey('openai', 'fixture-original-key', init.revision)
  const config = await readDisk(configFile)
  const oldRef = config._devaHeadlessSettings.credentials.openai
  config.models.providers.find(p => p.id === 'openai').apiHost = 'https://alternate.example.test/v1'
  await fs.writeFile(configFile, JSON.stringify(config))
  const edited = await settings.getPublicConfig()
  assert.equal(provider(edited, 'openai').headers, undefined)
  assert.equal((await settings.getProvider('openai')).apiKey, null)
  const reverted = await replaceProviders(settings, update(edited, 'openai', { apiHost: 'https://api.openai.com/v1' }), edited.revision)
  assert.equal(provider(reverted, 'openai').headers, undefined)
  assert.equal(await settings.hasKey('openai'), false)
  assert.deepEqual(await vault.list(vaultNamespace), [])
  // A syntactically valid, unavailable reference must never become an empty credential.
  config._devaHeadlessSettings.credentials.openai = oldRef
  await fs.writeFile(configFile, JSON.stringify(config))
  await assert.rejects(openSettings(paths), CORRUPT)
  await assert.rejects(settings.getPublicConfig(), CORRUPT)
  await fs.writeFile(configFile, '{}')
  const originalVault = await fs.readFile(vaultFile)
  await fs.writeFile(vaultFile, '{invalid ciphertext')
  await assert.rejects(settings.available(), CORRUPT)
  await assert.rejects(settings.patch({ set: { theme: 'dark' } }), CORRUPT)
  assert.equal(await fs.readFile(configFile, 'utf8'), '{}')
  await fs.writeFile(vaultFile, originalVault)
  await settings.getPublicConfig()
  // configFile is the fixed config.json inside the test's verified mkdtemp fixture.
  await fs.unlink(configFile)
  await assert.rejects(settings.getPublicConfig(), CORRUPT)
  await assert.rejects(settings.patch({ set: { theme: 'dark' } }), CORRUPT)
})

test('rejects prototype keys, hostile JSON-like objects, secret fields, excesses, and unsafe URL syntax atomically', async t => {
  const { settings, vault } = await start(t)
  const good = await settings.patch({ set: { theme: 'light' } })
  const reset = () => settings.getPublicConfig()
  const reject = async body => {
    await assert.rejects(settings.patch(body), INVALID)
    assert.equal((await reset()).revision, good.revision)
  }
  for (const body of [
    null, [], { revision: 42 }, { revision: 'bogus' }, { action: 'edit' },
    { set: { theme: 'automatic' } }, { set: { locale: 'en-US' } }, { set: { chatFontSize: 'huge' } },
    { set: { layout: { sidebarWidth: 481 } } }, { set: { layout: { composerHeight: 43 } } },
    { set: { locale: 'en', apiKey: 'fixture-attempted-secret' } }, { set: { config: {} } },
    { set: { models: { activeEffort: 'wild' } } }, { set: { models: { activeModelId: 'invalid' } } },
    { set: { models: { vault: {} } } }, { set: { mcp: {} } }, { unset: ['layout.undefined'] },
    { unset: ['models', 'models.activeModelId'], revision: good.revision }, { unset: ['mcp'] },
    { unset: ['theme', 'theme'] }, { set: { theme: 'system' }, unset: ['theme'] },
    JSON.parse('{"set":{"__proto__":{"settingsPolluted":true}}}'),
    JSON.parse('{"set":{"models":{"constructor":{"prototype":{"settingsPolluted":true}}}}}'),
    { set: Object.create({ tema: 'dark' }) },
    { set: Object.defineProperty({}, 'theme', { enumerable: true, get: () => assert.fail('accessor evaluated') }) }
  ]) await reject(body)
  const one = custom()
  for (const changes of [
    { id: '__proto__' }, { id: 'constructor' }, { id: 'namespace:other' }, { id: 'a'.repeat(97) },
    { enabled: 'true' }, { accent: 'url(https://example.test)' }, { purpose: 'llm', adapter: 'jev' },
    { purpose: 'decision', adapter: 'jev', threshold: 1.1 }, { apiKey: 'fixture-attempted-secret' }, { token: 'fixture-attempted-secret' },
    { apiHost: 'file:///etc/example' }, { apiHost: 'https://user:private@example.test/v1' },
    { apiHost: 'https://@example.test/v1' }, { apiHost: 'https://example.test/v1?token=private' },
    { apiHost: 'https://example.test/v1#private' }, { docUrl: 'javascript:example' },
    { headers: { Host: 'example.test' } }, { headers: { AUTHORIZATION: 'fixture-private' } },
    { headers: { 'X-Token': 'x', 'x-token': 'duplicate' } }, { headers: { 'X-Token': HEADER_MASK } },
    { headers: JSON.parse('{"__proto__":"fixture-attempted-secret"}') },
    { headers: { 'x-invalid': 'valid\r\nCookie: added' } }, { headers: { 'x-big': 'x'.repeat(8193) } },
    { headers: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`x-row-${i}`, 'fixture-many'])) },
    { headers: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`x-row-${i}`, 'x'.repeat(8192)])) },
    { models: [{ id: 'foo', name: 'foo', enabled: true, maxOutput: 255 }] },
    { models: [{ id: 'foo', name: 'foo', enabled: true, contextWindow: 20_000_001 }] },
    { models: [{ id: 'foo', name: 'foo', enabled: true, token: 'fixture-attempted-secret' }] },
    { models: [{ id: 'foo', name: 'foo', enabled: true }, { id: 'foo', name: 'duplicate', enabled: false }] }
  ]) await reject({ set: { models: { providers: [{ ...one, ...changes }] } }, revision: good.revision })
  await reject({ set: { models: { providers: [one, one] } }, revision: good.revision })
  assert.deepEqual(await vault.list(), [])
  assert.equal(Object.prototype.settingsPolluted, undefined)
})

test('draft base URL, explicit nested unsets, and vault-unavailable mode match the renderer workflow', async t => {
  const paths = await fixture(t)
  const noVault = await openSettings({ dataDir: paths.dataDir })
  assert.equal(await noVault.available(), false)
  assert.deepEqual(await noVault.listKeys(), [])
  await assert.rejects(noVault.setKey('openai', 'fixture-unavailable'), UNAVAILABLE)
  const plain = await noVault.patch({ set: { layout: { composerHeight: 80 } } })
  const saved = await noVault.patch({ unset: ['layout.composerHeight'] })
  assert.deepEqual(saved.layout, {})
  assert.notEqual(saved.revision, plain.revision)
  const vault = await openVault(paths)
  const settings = await openSettings({ ...paths, vault })
  const base = await settings.getPublicConfig()
  const draft = custom('custom-draft', { apiHost: 'https://', enabled: false, headers: { 'x-demo': 'fixture-draft-header' } })
  const added = await replaceProviders(settings, [draft], base.revision)
  assert.deepEqual(provider(added, draft.id).headers, { 'x-demo': HEADER_MASK })
  assert.equal((await settings.getProvider(draft.id)).headers, undefined)
  await assert.rejects(settings.setKey(draft.id, 'fixture-draft-key', added.revision), INVALID)
  const unset = await settings.patch({ unset: ['models.providers'], revision: added.revision })
  assert.equal(provider(unset, draft.id), undefined)
  assert.deepEqual(await vault.list(), [])
})
