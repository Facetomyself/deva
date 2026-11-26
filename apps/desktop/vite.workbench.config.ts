import { builtinModules } from 'node:module'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import pkg from './package.json'

const desktopOnly = new Set(['electron', ...builtinModules])

function checkBrowserImports(): Plugin {
  return {
    name: 'deva-workbench-browser-boundary',
    enforce: 'pre',
    resolveId(id) {
      // 跟随真实 Rollup 导入图：不要让 Vite 把 Node 权限静默变成 browser-external 空模块。
      if (id.startsWith('node:') || id.startsWith('electron/') || desktopOnly.has(id))
        this.error(`Desktop-only import in workbench renderer: ${id}`)
      return null
    }
  }
}

export default defineConfig({
  root: resolve(__dirname, 'src/workbench'),
  base: './',
  publicDir: false,
  plugins: [checkBrowserImports(), react()],
  resolve: { alias: { '@renderer': resolve(__dirname, 'src/renderer/src') } },
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: {
    outDir: resolve(__dirname, 'out/workbench'),
    emptyOutDir: true,
    manifest: 'manifest.json',
    target: 'es2020',
    rollupOptions: {
      input: { workbench: resolve(__dirname, 'src/workbench/entry.ts') },
      preserveEntrySignatures: 'strict',
      output: { entryFileNames: '[name].js' }
    }
  }
})
