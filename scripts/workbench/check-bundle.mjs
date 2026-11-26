import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Verify the emitted graph, not just the Vite configuration: the web host must be able
// to import the bootstrap module before React evaluates any window.deva consumer.
const root = fileURLToPath(new URL('../../apps/desktop/out/workbench/', import.meta.url))
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'))
const entry = manifest['entry.ts']
const ui = ['../renderer/src/main.tsx', '../renderer/src/browser-main.tsx']
assert.equal(entry?.file, 'workbench.js')
assert.equal(entry?.isEntry, true)
assert.deepEqual([...(entry.dynamicImports ?? [])].sort(), [...ui].sort())
// Vite shares its generated lazy-CSS helper between both inputs. It is the only allowed
// eager dependency of the programmatic entry, itself with no eager or lazy dependencies.
function assertOnlyPreloadHelpers(imports) {
  for (const id of imports) {
    const chunk = manifest[id]
    assert.equal(chunk?.name, 'preload-helper', 'entry must have no eager renderer imports')
    assert.match(chunk.file, /^assets\/preload-helper-[\w-]+\.js$/)
    for (const field of ['imports', 'dynamicImports', 'css', 'assets']) assert.deepEqual(chunk[field] ?? [], [])
  }
}
assertOnlyPreloadHelpers(entry.imports ?? [])
for (const view of ui) {
  assert.equal(manifest[view]?.isDynamicEntry, true, view)
  assert.ok(manifest[view].css?.length > 0, `missing CSS for ${view}`)
}
for (const chunk of Object.values(manifest)) {
  for (const dependency of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])]) assert.ok(Object.hasOwn(manifest, dependency), dependency)
  for (const name of [chunk.file, ...(chunk.css ?? []), ...(chunk.assets ?? [])]) {
    const path = resolve(root, name)
    assert.ok(path.startsWith(resolve(root) + sep), `asset outside output: ${name}`)
    assert.ok((await stat(path)).isFile(), `missing asset: ${name}`)
  }
}
// There is intentionally no window/document here. An eager UI import would fail this probe.
const bootstrap = await import(pathToFileURL(resolve(root, entry.file)).href)
assert.equal(typeof bootstrap.mountWorkbench, 'function')

const html = await readFile(resolve(root, 'index.html'), 'utf8')
assert.match(html, /<div\s+id="root"/)
assert.match(html, /<meta\s+name="referrer"\s+content="no-referrer"/)
const byFile = new Map(Object.entries(manifest).map(([id, chunk]) => [chunk.file, id]))
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].map(([, attrs, body]) => {
  assert.equal(body.trim(), '', 'the initial page must not have inline scripts')
  assert.match(attrs, /\btype="module"/)
  const src = attrs.match(/\bsrc="\.\/(assets\/[\w.-]+\.js)"/)?.[1]
  const id = byFile.get(src)
  assert.ok(id, `HTML script not emitted in the manifest: ${src}`)
  return id
})
const bootstrapScripts = scripts.filter((id) => manifest[id].dynamicImports?.length)
assert.equal(bootstrapScripts.length, 1, 'HTML must load one real browser startup entry')
assertOnlyPreloadHelpers(scripts.filter((id) => id !== bootstrapScripts[0]))
const browser = manifest[bootstrapScripts[0]]
assertOnlyPreloadHelpers(browser.imports ?? [])
assert.equal(browser.dynamicImports.length, 1, 'React first use is loaded after taking the fragment')
const firstUse = manifest[browser.dynamicImports[0]]
assert.equal(firstUse.isDynamicEntry, true)
assert.ok(firstUse.css?.length > 0, 'missing first-use styling')
assert.deepEqual(firstUse.dynamicImports, ['desktop-settings.tsx'])
const settings = manifest['desktop-settings.tsx']
assert.equal(settings.isDynamicEntry, true)
const modelSettings = settings.imports?.find((id) => manifest[id]?.name === 'ModelSettings')
assert.ok(modelSettings && manifest[ui[0]].imports?.includes(modelSettings), 'first use and desktop must share the real ModelSettings bundle')
assert.ok(!firstUse.imports?.some((id) => id === modelSettings || ui.includes(id)), 'desktop settings and full shell must remain lazy')
console.log('Workbench bundle OK: browser index and ES mount entry, shared desktop ModelSettings, lazy renderer views, CSS and assets present.')
