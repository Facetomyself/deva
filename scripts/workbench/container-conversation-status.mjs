// Production Linux/amd64 container acceptance; independent of the Chrome and local HTTP gates.
import { execFile, spawn } from 'node:child_process'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CheckFailure, check, privateRoot } from './container-client-interactions-docker.mjs'
import { imageSha, productionGate } from './container-conversation-status-docker.mjs'
import { probe, startModel } from './container-conversation-status-probe.mjs'

const usage = 'Usage: node scripts/workbench/container-conversation-status.mjs [--fixture-only | --disposable-image sha256:<64 lowercase hex>]'
const app = fileURLToPath(new URL('../../apps/headless', import.meta.url))
const cli = join(app, 'src', 'cli.mjs')
function options(args) {
  if (!args.length) return {}
  if (args.length === 1 && args[0] === '--fixture-only') return { fixtureOnly: true }
  if (args.length === 2 && args[0] === '--disposable-image' && imageSha(args[1])) return { expectedImage: args[1] }
  throw new CheckFailure(usage)
}

function localCli(args, root, env) {
  return new Promise(resolve => execFile(process.execPath, [cli, ...args], { cwd: root, env, timeout: 5000, maxBuffer: 16384 },
    (error, stdout, stderr) => resolve([error?.code ?? 0, stdout, stderr])))
}

async function localServe(root, env, work) {
  const child = spawn(process.execPath, [cli, 'serve'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const closed = Promise.withResolvers(), ready = Promise.withResolvers()
  let stdout = '', stderr = ''
  child.once('error', () => { ready.resolve(false); closed.resolve(false) })
  child.once('close', code => { ready.resolve(false); closed.resolve(code === 0) })
  child.stdout.setEncoding('utf8').on('data', line => {
    stdout = (stdout + line).slice(0, 1024)
    const port = /^Workbench listening on 127\.0\.0\.1:(\d{1,5}) for http:\/\/127\.0\.0\.1:\1\n$/u.exec(stdout)?.[1]
    if (port && Number(port) > 0) ready.resolve(`http://127.0.0.1:${port}`)
  })
  child.stderr.setEncoding('utf8').on('data', line => { stderr = (stderr + line).slice(0, 1024) })
  const startup = setTimeout(() => ready.resolve(false), 10_000)
  try {
    const origin = await ready.promise
    check(origin, 'Local fixture CLI did not start')
    return await work(origin)
  } finally {
    clearTimeout(startup)
    child.kill('SIGTERM')
    const kill = setTimeout(() => child.kill('SIGKILL'), 5000)
    const clean = await closed.promise
    clearTimeout(kill)
    check(clean && stderr === '', 'Local fixture CLI shutdown unconfirmed')
  }
}

async function fixtureGate() {
  check(process.platform === 'linux', 'The native read-state fixture requires Linux')
  for (const core of ['provider', 'chat', 'library']) await access(join(app, 'dist', `${core}-core.mjs`)).catch(() => {
    throw new CheckFailure('Build headless cores with pnpm --filter @deva/headless build')
  })
  const root = await privateRoot(), keyFile = join(root.path, 'master.key')
  const [data, run, web] = ['data', 'run', 'web'].map(s => join(root.path, s))
  try {
    for (const dir of [data, run, web]) await mkdir(dir, { mode: 0o700 })
    for (const [file, bytes] of Object.entries({ 'index.html': '<!doctype html><title>Synthetic CLI fixture</title>',
      'workbench.js': '/* synthetic empty bundle */', 'manifest.json': JSON.stringify({ entry: { file: 'workbench.js', isEntry: true } }) })) {
      await writeFile(join(web, file), bytes, { mode: 0o600, flag: 'wx' })
    }
    const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: root.path, NODE_ENV: 'production', DEVA_HOME: data,
      DEVA_MASTER_KEY_FILE: keyFile, DEVA_RUN_DIR: run, DEVA_WEB_DIR: web, DEVA_HOST: '127.0.0.1', DEVA_PORT: '0' }
    const [invalid, , invalidError] = await localCli(['serve', '--unexpected'], root.path, env)
    check(invalid === 1 && invalidError === 'Invalid serve options; see --help\n', 'Local CLI parser did not reject unknown flags')
    const [code, keyMessage, keyError] = await localCli(['init-key'], root.path, env)
    check(code === 0 && keyMessage === 'Master key ready\n' && keyError === '', 'Local CLI key initialization failed')
    const model = await startModel(0)
    try {
      const runProbe = (phase, input) => localServe(root.path, { ...env, DEVA_PROVIDER_ORIGINS: model.origin }, async origin => {
        // A fresh call counter on restore is represented by the delta of the same local fixture server.
        const fixtureModel = phase === 'first' ? model : { ...model, expectCalls: count => model.expectCalls(1 + count) }
        try { return await probe({ phase, input, origin, data, keyFile, run, app, model: fixtureModel }) }
        catch (error) { throw new CheckFailure(`Local synthetic probe: ${error.message}`) }
      })
      const first = await runProbe('first', {}), second = await runProbe('second', first)
      check(second.verified === true && model.expectCalls(1), 'Local restore evidence is incomplete')
      return { measured: second.measured, estimate: first.estimate, readAt: second.readAt }
    } finally { await model.close() }
  } finally { await root.remove() }
}

let cleanupFailed = false
try {
  const { fixtureOnly, expectedImage } = options(process.argv.slice(2))
  if (fixtureOnly) {
    const { measured, estimate, readAt } = await fixtureGate()
    console.log(`PASS fixture-only (local synthetic CLI; zero Docker operations, no packaged evidence): measured=${measured} estimate=${estimate} readAt=${readAt}`)
  } else {
    const e = await productionGate(expectedImage, message => { cleanupFailed = true; console.error(message) })
    check(!cleanupFailed, 'Cleanup evidence is incomplete')
    console.log(`PASS production conversation status: ${e.image} (${e.bytes} bytes; Linux/amd64 Engine ${e.engine}; Node 22 UID 1000); init=${e.init} serve=${e.first} restore=${e.second}`)
    console.log(`One first-turn model call, zero restore calls; measured=${e.measured} estimate=${e.estimate} readAt=${e.readAt}; stale cookie=401 stale cursor after fresh login=409; chat-core SHA256=${e.core}, read-state SHA256=${e.readSha}; zero residual owned containers or volumes.`)
  }
} catch (error) {
  console.error(`Conversation status gate: ${error instanceof CheckFailure ? error.message : 'verification failed'}`)
  process.exitCode = 1
}
