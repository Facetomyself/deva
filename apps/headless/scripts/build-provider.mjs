import { build } from 'esbuild'
import { isBuiltin } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const dest = new URL('../dist/', import.meta.url)
const result = await build({
  absWorkingDir: root, entryPoints: ['apps/desktop/src/main/providers/core.ts'], bundle: true,
  platform: 'node', format: 'esm', target: 'node22', metafile: true, write: false, logLevel: 'silent',
  plugins: [{ name: 'reject-desktop-runtime', setup(b) {
    b.onResolve({ filter: /^(?:electron(?:\/|$)|@electron-toolkit\/|electron-updater$)/ }, (a) => ({ errors: [{ text: `Desktop dependency in headless provider: ${a.path}` }] }))
  } }]
})
for (const out of Object.values(result.metafile.outputs)) for (const dep of out.imports) {
  if (dep.external && !isBuiltin(dep.path)) throw Error(`Unexpected external dependency: ${dep.path}`)
}
await mkdir(dest, { recursive: true })
await writeFile(new URL('provider-core.mjs', dest), result.outputFiles[0].contents)
console.log(`Built headless provider bundle from the desktop protocols (${Object.keys(result.metafile.inputs).length} inputs)`)
