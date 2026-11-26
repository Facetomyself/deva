import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'

// Use the pinned workspace compiler so the tests also run on Node 20 without a TS loader.
const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))
const ts = require('typescript')
const source = await readFile(new URL('../../apps/desktop/src/workbench/mount.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText
const { createMount } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)

test('installs the resolved host and synchronous snapshot before evaluating any renderer code', async () => {
  const target = {}
  const api = { config: { getSync: () => ({ locale: 'en', chatFontSize: 'lg' }) } }
  let loads = 0
  const mount = createMount(target, {
    workbench: async () => { loads++; assert.equal(target.deva, api); assert.equal(target.deva.config.getSync().locale, 'en') },
    browser: () => assert.fail('loaded other view')
  })
  const first = mount(api)
  assert.equal(first, mount(api, 'workbench'))
  assert.equal(Object.getOwnPropertyDescriptor(target, 'deva').writable, false)
  assert.throws(() => mount({}, 'workbench'), /different host/)
  assert.throws(() => mount(api, 'browser'), /different host/)
  await first
  assert.equal(loads, 1)
})

test('browser chrome loads separately; unexpected views and an existing preload are never replaced', async () => {
  let loads = 0
  const api = {}
  const mods = { workbench: () => assert.fail(), browser: () => { loads++ } }
  assert.throws(() => createMount(Object.create({ deva: {} }), mods)(api), /already has/)
  const target = {}
  const mount = createMount(target, mods)
  assert.throws(() => mount(api, 'other'), /Unknown/)
  assert.equal(Object.hasOwn(target, 'deva'), false)
  await mount(api, 'browser')
  assert.equal(loads, 1)
})

test('a renderer load failure stays observable; a later session cannot take over that document', async () => {
  const api = {}
  const mount = createMount({}, { workbench: async () => { throw Error('chunk unavailable') }, browser: () => assert.fail() })
  const failed = mount(api)
  await assert.rejects(failed, /chunk unavailable/)
  assert.equal(mount(api), failed)
  assert.throws(() => mount({}), /different host/)
})
