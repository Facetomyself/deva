#!/usr/bin/env node
import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseSites, probeEgress, startEgress } from './egress/index.mjs'
import { openWorkerClient } from './client.mjs'
import { startWorker } from './worker.mjs'

function absolute(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw Error(label)
  return value
}
async function deployedSites(file) {
  const p = absolute(file, 'configuration')
  const s = await lstat(p)
  // Deployment file is externally mounted read-only and contains no credentials.
  if (!s.isFile() || s.size > 128 * 1024) throw Error('configuration')
  return parseSites(await readFile(p, 'utf8'))
}

export async function launch(mode, env) {
  const control = absolute(env.DEVA_BROWSER_CONTROL_DIR || '/run/deva-browser-control', 'control')
  const egress = absolute(env.DEVA_BROWSER_EGRESS_DIR || '/run/deva-browser-egress', 'egress')
  if (mode === 'check-egress') return { ok: await probeEgress(join(egress, 'egress.sock')) }
  if (mode === 'check-worker') {
    const { state } = await openWorkerClient({ runDir: control }).status()
    return { ok: state === 'ready', state }
  }
  if (mode !== 'worker' && mode !== 'egress') throw Error('command')
  const sites = await deployedSites(env.DEVA_BROWSER_SITES_FILE || '/etc/deva-browser/sites.json')
  if (!sites.length) throw Error('configuration')
  if (mode === 'worker') {
    return startWorker({ runDir: control, egressSocket: join(egress, 'egress.sock'), sites,
      executablePath: absolute(env.DEVA_CHROMIUM_PATH || '/usr/bin/chromium', 'chromium') })
  }
  const privateOrigins = (env.DEVA_BROWSER_PRIVATE_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean)
  return startEgress({ runDir: egress, sites, privateOrigins })
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv.includes('--help')) console.log('Usage: node cli.mjs egress|worker|check-egress|check-worker')
  else {
    let resource, signalled = false, closing
    function stop() {
      signalled = true
      if (resource?.close) closing ??= Promise.resolve().then(() => resource.close()).catch(() => { process.exitCode = 1 })
    }
    process.on('SIGINT', stop); process.on('SIGTERM', stop)
    try {
      if (process.argv.length !== 3) throw Error('command')
      resource = await launch(process.argv[2], process.env)
      if ('ok' in resource) { console.log(resource.state ?? (resource.ok ? 'ready' : 'unavailable')); process.exitCode = resource.ok ? 0 : 1 }
      else if (signalled) { stop(); await closing }
      else console.log('Private browser component started')
    } catch { console.error('Private browser component unavailable; check its arguments, private socket mounts and site configuration.'); process.exitCode = 1 }
  }
}
