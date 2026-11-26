import { build } from 'esbuild'
import { isBuiltin } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const dest = new URL('../dist/', import.meta.url)
async function compile(name, entry) {
  const result = await build({
    absWorkingDir: root, entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', target: 'node22',
    metafile: true, write: false, logLevel: 'silent', plugins: [{ name: 'reject-desktop-runtime', setup(b) {
      b.onResolve({ filter: /^(?:electron(?:\/|$)|@electron-toolkit\/|electron-updater$)/ }, a => ({ errors: [{ text: `Desktop dependency in ${name}: ${a.path}` }] }))
    } }]
  })
  for (const out of Object.values(result.metafile.outputs)) for (const dep of out.imports) {
    if (dep.external && !isBuiltin(dep.path)) throw Error(`Unexpected external dependency: ${dep.path}`)
  }
  await writeFile(new URL(`${name}.mjs`, dest), result.outputFiles[0].contents)
  console.log(`Built headless ${name} from shared desktop modules (${Object.keys(result.metafile.inputs).length} inputs)`)
}
await mkdir(dest, { recursive: true })
await compile('provider-core', 'apps/desktop/src/main/providers/core.ts')
await compile('chat-core', 'apps/headless/scripts/chat-core.ts')
await compile('library-core', 'apps/headless/scripts/library-core.ts')
