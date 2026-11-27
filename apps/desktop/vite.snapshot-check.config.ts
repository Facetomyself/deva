import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// An explicitly built operator tool, separate from out/headless (which goes in the Web image).
export default defineConfig({
  publicDir: false,
  build: {
    ssr: resolve(__dirname, 'src/headless/snapshot-check.ts'),
    target: 'node22', outDir: resolve(__dirname, 'out/snapshot-check'), emptyOutDir: true,
    rollupOptions: { output: { format: 'es', inlineDynamicImports: true, entryFileNames: 'check.mjs' } }
  }
})
