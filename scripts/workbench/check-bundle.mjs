import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// Verify the emitted graph, not just the Vite configuration: the web host must be able
// to import the bootstrap module before React evaluates any window.deva consumer.
const root = fileURLToPath(new URL('../../apps/desktop/out/workbench/', import.meta.url))
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'))
const entry = manifest['entry.ts']
const ui = ['../renderer/src/main.tsx', '../renderer/src/browser-main.tsx']
assert.equal(entry?.file, 'workbench.js')
assert.equal(entry?.isEntry, true)
assert.deepEqual([...(entry.dynamicImports ?? [])].sort(), [...ui].sort())
assert.deepEqual(entry.imports ?? [], [], 'bootstrap must have no eager renderer imports')
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
const output = await readFile(resolve(root, entry.file))
const bootstrap = await import(`data:text/javascript;base64,${output.toString('base64')}`)
assert.equal(typeof bootstrap.mountWorkbench, 'function')
console.log('Workbench bundle OK: free-standing ES module, both desktop views lazy, CSS and assets present.')
