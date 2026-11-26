import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { checkManifest, manifestPath, preloadPath, root } from './check-parity.mjs'
import { extractInventory, inventoryCounts, loadTypeScript } from './preload-inventory.mjs'

const ts = loadTypeScript()
const extract = (source, filename = 'fixture.ts') => extractInventory(source, filename, ts)
const readRepo = (path) => readFileSync(resolve(root, path), 'utf8')
const manifest = JSON.parse(readRepo(manifestPath))
const inventory = extract(readRepo(preloadPath), preloadPath)
const withMethod = (method) => `const api = { platform: process.platform, chat: { ${method} } }`
const invoke = `send: () => ipcRenderer.invoke('chat:send')`
const subscribe = (removeChannel = 'chat:event', removeListener = 'fn') => `
  onEvent(cb: (p: unknown) => void) {
    const fn = (_event: unknown, p: unknown) => cb(p)
    ipcRenderer.on('chat:event', fn)
    return () => ipcRenderer.removeListener('${removeChannel}', ${removeListener})
  }
`

function byName(rows, name) {
  const row = rows.find((value) => value.name === name)
  assert.ok(row, name)
  return row
}

function methods(groups, name) {
  return byName(groups, name).methods
}

test('real desktop preload and Workbench manifest agree', () => {
  assert.deepEqual(checkManifest(manifest, inventory), [])
  assert.deepEqual(inventoryCounts(inventory), manifest.baseline)
  const platform = byName(manifest.values, 'platform')
  assert.equal(platform.expression, 'process.platform')
  assert.equal(platform.web.target, 'bootstrap')
  assert.equal(byName(methods(manifest.groups, 'git'), 'status').desktop.surface, 'ui')
  assert.equal(byName(methods(manifest.groups, 'git'), 'diff').desktop.surface, 'bridge-only')
  for (const row of methods(manifest.groups, 'terminal')) {
    assert.equal(row.desktop.surface, 'legacy-bridge')
    assert.notEqual(row.web.status, 'desktop-only')
  }
})

test('extracts property keys, IPC kinds, and subscriptions across formatting and type changes', () => {
  const before = extract(`const api = {
    platform: process.platform,
    chat: { ${invoke}, ${subscribe()} },
    config: { getSync: () => ipcRenderer.sendSync('config:get-sync') },
    terminal: { write: () => ipcRenderer.send('terminal:input') }
  }`)
  const after = extract(`type Contract = Record<string, unknown>
    import type { DTO } from '../shared/host-contract'
    const example = 'const api = { bogus: true }'
    function scoped() { const api = { ignored: 0 }; return api }
    const api: Contract = ({
      'platform': process.platform,
      ['chat']: {
        // ipcRenderer.invoke('fake')
        send: async ({ text, extra }: DTO) => (ipcRenderer['invoke'](\`chat:send\`, text, extra)),
        ${subscribe()}
      },
      config: { getSync() { return ipcRenderer.sendSync('config:get-sync') } },
      terminal: { write: function () { ipcRenderer.send('terminal:input') } }
    } satisfies Contract)
  `)
  assert.deepEqual(after, before)
  assert.deepEqual(before.groups.map(({ methods: rows }) => rows.map(({ kind }) => kind)), [
    ['invoke', 'subscription'], ['sendSync'], ['send']
  ])
})

test('reports new, removed, and renamed methods even when counts match', () => {
  const live = structuredClone(inventory)
  const chat = methods(live.groups, 'chat')
  byName(chat, 'send').name = 'sendMessage'
  const errors = checkManifest(manifest, live)
  assert.ok(errors.includes('missing manifest entry: chat.sendMessage'))
  assert.ok(errors.includes('stale manifest entry: chat.send'))
  assert.ok(!errors.some((error) => error.startsWith('baseline.')))
})

test('reports group and value additions and removals and count drift', () => {
  const live = structuredClone(inventory)
  live.groups = live.groups.filter(({ name }) => name !== 'terminal')
  live.groups.push({ name: 'notifications', methods: [{ name: 'get', kind: 'invoke', channel: 'notification:get' }] })
  live.values.push({ name: 'appVersion', expression: 'process.version' })
  const errors = checkManifest(manifest, live)
  for (const error of ['missing manifest entry: notifications', 'stale manifest entry: terminal', 'missing manifest entry: appVersion']) {
    assert.ok(errors.includes(error), error)
  }
  for (const key of ['methods', 'subscriptions', 'values']) {
    assert.ok(errors.some((error) => error.startsWith(`baseline.${key}:`)), key)
  }
})

test('reports method kind/channel and platform value-source edits', () => {
  const live = structuredClone(inventory)
  const fn = byName(methods(live.groups, 'chat'), 'send')
  fn.kind = 'send'
  fn.channel = 'chat:send-v2'
  live.values[0].expression = 'process.arch'
  const errors = checkManifest(manifest, live)
  for (const field of ['chat.send.kind', 'chat.send.channel', 'platform.expression']) {
    assert.ok(errors.some((error) => error.startsWith(`changed ${field}:`)), field)
  }
})

test('rejects duplicate rows, stale links and pending rows without evidence of purpose', () => {
  const damaged = structuredClone(manifest)
  const rows = methods(damaged.groups, 'chat')
  rows.push(structuredClone(byName(rows, 'send')))
  const receive = byName(rows, 'onEvent')
  receive.desktop.entry = '../../store/chat.tsx'
  receive.web.semantic = '  '
  damaged.flows[0].methods.push('absent.method')
  const errors = checkManifest(damaged, inventory)
  for (const field of ['chat.methods: duplicate send', 'chat.onEvent.desktop.entry:', 'chat.onEvent.web.semantic:', 'flows.bootstrap: unknown method absent.method']) {
    assert.ok(errors.some((error) => error.startsWith(field)), field)
  }
})

test('requires handler/test evidence before declaring a Workbench method implemented', () => {
  const changed = structuredClone(manifest)
  const row = byName(methods(changed.groups, 'chat'), 'respondPlan')
  row.web.status = 'implemented'
  delete row.web.implementation
  assert.deepEqual(checkManifest(changed, inventory).filter((e) => e.includes('respondPlan')), [
    'chat.respondPlan.web.implementation.handler: expected a repo-relative path to an existing file',
    'chat.respondPlan.web.implementation.test: expected a repo-relative path to an existing file'
  ])
  row.web.implementation = { handler: 'future/handler.ts', test: 'future/handler.test.ts' }
  assert.deepEqual(checkManifest(changed, inventory, () => true), [])
  row.web.implementation.test = row.web.implementation.handler
  assert.ok(checkManifest(changed, inventory, () => true).includes('chat.respondPlan.web.implementation: handler and test must be distinct files'))
})

test('partial text support cannot be counted as full desktop parity', () => {
  const changed = structuredClone(manifest)
  const row = byName(methods(changed.groups, 'chat'), 'send')
  assert.ok(row.web.partial.scope)
  row.web.partial.remaining = ''
  row.web.partial.test = '../outside.test.mjs'
  row.web.status = 'implemented'
  const errors = checkManifest(changed, inventory)
  assert.ok(errors.some(e => e.startsWith('chat.send.web.partial:')))
  assert.ok(errors.some(e => e.startsWith('chat.send.web.partial.test:')))
})

test('a historical desktop bridge remains a traced Web behavior, not an exclusion', () => {
  const changed = structuredClone(manifest)
  const pty = byName(methods(changed.groups, 'terminal'), 'create')
  delete pty.web.implementation
  Object.assign(pty.web, { status: 'desktop-only', target: 'desktop' })
  assert.ok(checkManifest(changed, inventory).includes('terminal.create: historical desktop use is not evidence for a Web exclusion'))
})

test('fails closed on uninspectable API syntax', () => {
  const cases = [
    [withMethod('...chatMethods'), /explicit properties or methods/],
    [withMethod('[dynamic]: () => ipcRenderer.invoke("chat:send")'), /static identifier-like key/],
    [withMethod(`${invoke}, ${invoke}`), /duplicate api member send/],
    [withMethod(`get send() { return () => ipcRenderer.invoke('chat:send') }`), /explicit properties or methods/],
    [withMethod('send: sharedSend'), /inline method implementation/],
    [withMethod('send: () => ipcRenderer.invoke(channel)'), /nonliteral channel/],
    [withMethod(`send: () => ipcRenderer.postMessage('chat:send')`), /unsupported IPC operation/],
    [withMethod(`send: () => ipcRenderer?.invoke('chat:send')`), /unsupported IPC operation/],
    [withMethod(`send() { const dormant = () => ipcRenderer.invoke('chat:send'); return true }`), /returned or sent directly/],
    [withMethod(`send: () => ipcRenderer.invoke('chat:send'), broken: ( =>`), /fixture\.ts:\d+:\d+:/],
    ['let api = {}', /expected top-level const api/]
  ]
  for (const [source, expected] of cases) assert.throws(() => extract(source), expected)
})

test('rejects mismatched or missing unsubscribe and checks the disposer is returned', () => {
  for (const method of [subscribe('chat:other'), subscribe('chat:event', 'other'), subscribe().replace(/return.*removeListener.*/, '')]) {
    assert.throws(() => extract(withMethod(method)), /matching channel\/listener cleanup/)
  }
  assert.throws(() => extract(withMethod(subscribe().replace('return () =>', 'const dispose = () =>'))), /return matching cleanup as a disposer/)
})

test('CLI uses checkout-relative inputs from another cwd and prints machine-readable extraction', () => {
  const script = resolve(root, 'scripts/workbench/check-parity.mjs')
  const invokeCli = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: tmpdir(), encoding: 'utf8' })
  const result = invokeCli()
  assert.equal(result.status, 0, result.stderr)
  const { groups, methods, subscriptions, values } = manifest.baseline
  const implemented = manifest.groups.flatMap((group) => group.methods)
    .filter(({ web }) => web.status === 'implemented').length
  assert.ok(result.stdout.includes(`${groups} groups / ${methods} methods (${subscriptions} subscriptions) / ${values} value`))
  assert.ok(result.stdout.includes(`implemented=${implemented},`))
  assert.ok(result.stdout.includes(`platform=${byName(manifest.values, 'platform').web.status}`))
  const reported = invokeCli('--coverage')
  assert.equal(reported.status, 0, reported.stderr)
  const report = JSON.parse(reported.stdout)
  assert.equal(report.groups.length, groups)
  assert.equal(report.totals.implemented, implemented)
  assert.equal(report.totals.partial, manifest.groups.flatMap(group => group.methods).filter(row => row.web.partial).length)
  assert.equal(Object.values(report.totals).reduce((a,b) => a+b, 0), methods)
  assert.deepEqual(report.values, Object.fromEntries(manifest.values.map(({name,web}) => [name,web.status])))
  assert.ok(result.stdout.includes(`${report.totals.partial} partial, ${report.totals.pendingWithoutScope} without a recorded scope`))
  const extracted = invokeCli('--extract')
  assert.equal(extracted.status, 0, extracted.stderr)
  assert.deepEqual(JSON.parse(extracted.stdout), { baseline: manifest.baseline, ...inventory })
  const invalid = invokeCli('--not-a-flag')
  assert.equal(invalid.status, 2)
  assert.match(invalid.stderr, /Usage:/)
})
