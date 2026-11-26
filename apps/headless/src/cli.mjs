#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { requestControl } from './control/socket.mjs'
import {
  DEFAULT_DATA_DIR, DEFAULT_HOST, DEFAULT_PORT, DEFAULT_WEB_DIR, startWorkbench, workbenchPath, workbenchPolicy
} from './server.mjs'
import { childPath, openDirectory, readPrivateFile } from './storage/private-files.mjs'
import { initializeMasterKey } from './storage/vault.mjs'

const help = `Usage: node apps/headless/src/cli.mjs <init-key|serve|claim|status> [options]

  init-key [--if-missing]  Provision a private 32-byte master key in an existing parent directory.
                           --if-missing verifies an existing key; a populated data directory
                           without its key requires recovery, rather than a newly generated key.
  serve                    Run the workbench HTTP listener and private Unix control channel.
  claim                    Print a short-lived claim URL to the calling terminal.
  status                   Print the local instance's claimed state as JSON.

Options override the environment:
  --home PATH             DEVA_HOME (default ~/.deva-headless; alias --data-dir)
  --master-key-file PATH  DEVA_MASTER_KEY_FILE (required for serve and init-key; alias --key-file)
  --run-dir PATH          DEVA_RUN_DIR (default <home>/run)
  --host IP               DEVA_HOST (default 127.0.0.1)
  --port NUMBER           DEVA_PORT (default 8787, or 0 for an ephemeral serve port)
  --public-url ORIGIN     DEVA_PUBLIC_URL (defaults to the HTTP loopback origin; required on non-loopback binds)
  --web-dir PATH          DEVA_WEB_DIR (default apps/desktop/out/workbench, relative to the project)
  --workspace-root PATH   DEVA_WORKSPACE_ROOT (optional mounted parent for registered projects; default none)
  --help                  Show this help.

DEVA_PROVIDER_ORIGINS is an optional comma-separated list of exact private model origins for serve.
`
const str = { type: 'string' }
const paths = { home: str, 'data-dir': str }
const key = { 'master-key-file': str, 'key-file': str }
const runtime = { 'run-dir': str }
const origin = { host: str, port: str, 'public-url': str }
const flags = Object.freeze({
  'init-key': { ...paths, ...key, 'if-missing': { type: 'boolean' } },
  serve: { ...paths, ...key, ...runtime, ...origin, 'web-dir': str, 'workspace-root': str },
  claim: { ...paths, ...runtime, ...origin },
  status: { ...paths, ...runtime }
})

function aliases(values, name, alias, fallback) {
  if (values[name] !== undefined && values[alias] !== undefined) throw Error('Supply only one name for an option and its alias')
  return values[name] ?? values[alias] ?? fallback
}

function configuration(command, values, env) {
  const dataDir = workbenchPath(aliases(values, 'home', 'data-dir', env.DEVA_HOME) ?? DEFAULT_DATA_DIR, 'Data directory')
  const config = { dataDir }
  if (command === 'serve' || command === 'init-key') {
    config.keyFile = workbenchPath(aliases(values, 'master-key-file', 'key-file', env.DEVA_MASTER_KEY_FILE), 'Master key file')
  }
  if (command !== 'init-key') {
    config.runDir = workbenchPath(values['run-dir'] ?? env.DEVA_RUN_DIR ?? join(dataDir, 'run'), 'Run directory')
  }
  if (command === 'serve' || command === 'claim') {
    config.host = values.host ?? env.DEVA_HOST ?? DEFAULT_HOST
    const port = values.port ?? env.DEVA_PORT ?? String(DEFAULT_PORT)
    if (!/^\d{1,5}$/.test(port) || Number(port) > 65535) throw Error('Port must be an integer from 0 to 65535')
    config.port = Number(port)
    config.publicUrl = values['public-url'] ?? env.DEVA_PUBLIC_URL
  }
  if (command === 'serve') {
    config.webDir = workbenchPath(values['web-dir'] ?? env.DEVA_WEB_DIR ?? DEFAULT_WEB_DIR, 'Web directory')
    const origins = env.DEVA_PROVIDER_ORIGINS?.trim()
    const workspaceRoot = values['workspace-root'] ?? env.DEVA_WORKSPACE_ROOT
    config.businessOptions = {
      ...(origins ? { allowedOrigins: origins.split(',').map(origin => origin.trim()) } : {}),
      ...(workspaceRoot ? { workspaceRoot: workbenchPath(workspaceRoot, 'Workspace root') } : {})
    }
  }
  return config
}

async function keyExists(keyFile) {
  const { directory } = await openDirectory(dirname(keyFile))
  try {
    const name = basename(keyFile)
    if (name === 'headless-vault.json' || name === 'secrets.json') throw Error('Reserved master key filename')
    const result = await readPrivateFile(childPath(directory, name), { minSize: 32, maxSize: 32, singleLink: true, absent: true })
    if (!result) return false
    result.bytes.fill(0)
    return true
  } finally {
    await directory.close()
  }
}

async function hasPersistedData(dataDir) {
  let directory
  try {
    ;({ directory } = await openDirectory(dataDir))
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
  try {
    // A failed serve may have created the inode for flock without creating instance data.
    // Any other entry could hold persistent state; treat it conservatively, even on a RO volume.
    return (await readdir(childPath(directory, '.'))).some(name => name !== '.workbench-writer.lock')
  } finally {
    await directory.close()
  }
}

async function provisionKey({ dataDir, keyFile }, ifMissing, stdout) {
  if (await keyExists(keyFile)) {
    if (!ifMissing) throw Error('Master key already exists; use --if-missing to verify it')
  } else {
    if (await hasPersistedData(dataDir)) throw Error('Data directory has existing state; restore its master key')
    try {
      await initializeMasterKey(keyFile)
    } catch (error) {
      if (!ifMissing || error.code !== 'EEXIST' || !await keyExists(keyFile)) throw error
    }
  }
  stdout.write('Master key ready\n')
}

async function serve(config, stdout, stderr) {
  let running, stopping
  let signalled = false
  function removeSignals() {
    process.off('SIGTERM', stop)
    process.off('SIGINT', stop)
  }
  function stop() {
    signalled = true
    if (running) {
      stopping ??= running.close().catch(() => {
        stderr.write('Workbench shutdown failed\n')
        process.exitCode = 1
      }).finally(removeSignals)
    }
    return stopping
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  try {
    running = await startWorkbench(config)
    if (signalled) await stop()
    else stdout.write(`Workbench listening on ${running.address.address}:${running.address.port} for ${running.origin}\n`)
  } catch (error) {
    removeSignals()
    // startWorkbench uses fixed lifecycle names and keeps the original cause off the terminal.
    const message = /^Workbench startup failed \([a-z ]+\)$/.test(error.message) ? error.message : 'Invalid workbench service configuration'
    stderr.write(`${message}\n`)
    process.exitCode = 1
  }
}

async function main(argv, env, stdout, stderr) {
  const [command, ...args] = argv
  if (!command || command === '--help' || command === '-h') { stdout.write(help); return }
  if (!Object.hasOwn(flags, command)) { stderr.write('Unknown workbench command; see --help\n'); process.exitCode = 1; return }
  let values
  try {
    ;({ values } = parseArgs({ args, options: { ...flags[command], help: { type: 'boolean', short: 'h' } } }))
  } catch {
    stderr.write(`Invalid ${command} options; see --help\n`)
    process.exitCode = 1
    return
  }
  if (values.help) { stdout.write(help); return }
  let config
  try {
    config = configuration(command, values, env)
  } catch (error) {
    stderr.write(`${error.message}\n`)
    process.exitCode = 1
    return
  }
  if (command === 'serve') { await serve(config, stdout, stderr); return }
  try {
    if (command === 'init-key') {
      await provisionKey(config, values['if-missing'], stdout)
    } else if (command === 'status') {
      const status = await requestControl({ runDir: config.runDir, op: 'status' })
      stdout.write(`${JSON.stringify(status)}\n`)
    } else {
      if (!stdout.isTTY) throw Error('Claim output requires an interactive terminal')
      if (config.port === 0 && config.publicUrl === undefined) throw Error('Claim requires --public-url for an ephemeral listen port')
      const policy = workbenchPolicy(config.publicUrl, config.host, config.port)
      const { credential } = await requestControl({ runDir: config.runDir, op: 'claim' })
      const url = new URL('/', policy.origin)
      url.hash = `claim=${credential}`
      stdout.write(`${url.href}\n`)
    }
  } catch (error) {
    const helpful = new Set([
      'Master key already exists; use --if-missing to verify it',
      'Data directory has existing state; restore its master key',
      'Claim output requires an interactive terminal',
      'Claim requires --public-url for an ephemeral listen port'
    ])
    stderr.write(`${helpful.has(error.message) ? error.message : {
      'init-key': 'Master key setup failed; check the key path, size and private permissions',
      status: 'Local workbench status failed',
      claim: 'Local workbench claim failed; check the public URL and private control channel'
    }[command]}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2), process.env, process.stdout, process.stderr)
}
