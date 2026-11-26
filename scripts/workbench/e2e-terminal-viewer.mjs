import { randomBytes } from 'node:crypto'
import { access, lstat, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requestControl } from '../../apps/headless/src/control/socket.mjs'
import { DEFAULT_WEB_DIR, startWorkbench } from '../../apps/headless/src/server.mjs'
import { initializeMasterKey } from '../../apps/headless/src/storage/vault.mjs'
import { createTerminalFixture, check, TerminalViewerCheckError } from './e2e-terminal-viewer-fixture.mjs'
import { verifyTerminalBrowser } from './e2e-terminal-viewer-browser.mjs'
import { startLocalWebDriver, WebDriverError } from './webdriver-local.mjs'

async function privateRoot() {
  const prefix = join(await realpath(tmpdir()), 'deva-wb-tty-')
  const path = await mkdtemp(prefix)
  const stat = await lstat(path)
  check(path.startsWith(prefix) && path.length > prefix.length && await realpath(path) === path &&
    stat.isDirectory() && stat.uid === process.geteuid() && (stat.mode & 0o777) === 0o700,
  'Expected a fresh absolute private terminal QA directory')
  return { path, async close() {
    const current = await lstat(path)
    check(current.isDirectory() && current.ino === stat.ino && current.dev === stat.dev && await realpath(path) === path,
      'Private terminal QA directory identity changed before cleanup')
    await rm(path, { recursive: true })
  } }
}

function fetchFixture(origin, path, signal, init = {}) {
  return fetch(`${origin}${path}`, { redirect: 'error', cache: 'no-store',
    signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]), ...init })
}

async function status(origin, path, signal, init) {
  const response = await fetchFixture(origin, path, signal, init)
  await response.body?.cancel()
  return response.status
}

async function claimAndRevoke(origin, runDir, signal) {
  check(await status(origin, '/api/v1/bootstrap', signal) === 401, 'Fresh Workbench allowed anonymous owner bootstrap')
  const { credential } = await requestControl({ runDir, op: 'claim' })
  check(typeof credential === 'string' && /^[A-Za-z0-9_-]{43}$/.test(credential), 'Private control did not issue claim metadata')
  const password = randomBytes(24).toString('base64url')
  const response = await fetchFixture(origin, '/api/v1/auth/claim', signal, { method: 'POST',
    headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ credential, password }) })
  check(response.status === 200, 'Private setup owner claim did not succeed')
  const cookie = response.headers.getSetCookie()[0]?.split(';', 1)[0]
  const { csrf } = await response.json()
  check(typeof cookie === 'string' && /^deva-workbench-local=[A-Za-z0-9_-]{43}$/.test(cookie) && typeof csrf === 'string' && csrf.length > 0,
    'Private setup claim did not establish the expected owner session')
  check((await requestControl({ runDir, op: 'status' })).claimed === true, 'Private control did not confirm the owner claim')
  const revoked = await status(origin, '/api/v1/auth/logout', signal, { method: 'POST', headers: { origin, cookie, 'x-deva-csrf': csrf } })
  check(revoked === 200 && await status(origin, '/api/v1/bootstrap', signal, { headers: { cookie } }) === 401,
    'Private setup cookie remained authorized before the browser login')
  return password
}

async function runLocal(resources, signal, mark) {
  check(process.platform === 'linux' && process.getuid?.() > 0 && process.geteuid?.() > 0,
    'Run the real terminal viewer test on Linux as a non-root user')
  mark('checking built headless and Workbench assets')
  await Promise.all(['provider', 'chat', 'library'].map(entry =>
    access(new URL(`../../apps/headless/dist/${entry}-core.mjs`, import.meta.url)))).catch(() => {
    throw new TerminalViewerCheckError('Build headless cores with pnpm --filter @deva/headless build')
  })
  await access(join(DEFAULT_WEB_DIR, 'index.html')).catch(() => {
    throw new TerminalViewerCheckError('Build the Workbench with pnpm workbench:build')
  })
  mark('starting the genuine Linux PTY worker on a private socket')
  const { startTerminalServer } = await import('../../apps/terminal-worker/src/server.mjs')
  const root = resources.temp.path
  const terminalRunDir = join(root, 'terminal'), runDir = join(root, 'control'), keyFile = join(root, 'master.key')
  resources.worker = await startTerminalServer({ runDir: terminalRunDir })
  mark('starting the real Workbench on private IPv4 loopback')
  await initializeMasterKey(keyFile)
  const workbench = resources.workbench = await startWorkbench({ runDir, keyFile, dataDir: join(root, 'data'),
    host: '127.0.0.1', port: 0, webDir: DEFAULT_WEB_DIR,
    businessOptions: { workspaceRoot: join(root, 'workspaces'), terminalRunDir } })
  const { origin } = workbench
  check(workbench.address.address === '127.0.0.1' && origin === `http://127.0.0.1:${workbench.address.port}` &&
    await status(origin, '/readyz', signal) === 200, 'The isolated Workbench is not ready on the assigned loopback origin')
  mark('claiming via the private control socket and revoking the setup cookie')
  const password = await claimAndRevoke(origin, runDir, signal)
  mark('starting a fresh sandboxed Chrome session')
  const browser = resources.browser = await startLocalWebDriver({ root, origin, profile: join(root, 'chrome-profile'), signal })
  mark('driving native terminal viewer actions in the real Workbench UI')
  await verifyTerminalBrowser({ browser, origin, password, signal, expected: resources.fixture.expected })
}

function detail(error) {
  return error instanceof TerminalViewerCheckError || error instanceof WebDriverError ? error.message : 'unexpected error (raw diagnostics withheld)'
}

async function run(fixtureOnly) {
  const stop = new AbortController()
  const abort = () => stop.abort()
  const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(150_000)])
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  const resources = {}
  let failed = false, stage = 'preparing the private read-only synthetic project'
  const mark = next => { stage = next; signal.throwIfAborted() }
  try {
    resources.temp = await privateRoot()
    resources.fixture = await createTerminalFixture(join(resources.temp.path, 'workspaces'))
    if (!fixtureOnly) await runLocal(resources, signal, mark)
  } catch (error) {
    failed = true
    console.error(`Workbench terminal viewer check failed while ${stage}: ${signal.aborted ? 'interrupted or timed out' : detail(error)}`)
  } finally {
    for (const [name, cleanup] of [
      ['Chrome shutdown', () => resources.browser?.close()], ['Workbench shutdown', () => resources.workbench?.close()],
      ['PTY worker shutdown', () => resources.worker?.close()], ['source integrity', () => resources.fixture?.assertUnchanged()],
      ['private root cleanup', () => resources.temp?.close()]
    ]) {
      try { await cleanup() } catch (error) {
        failed = true
        console.error(`Workbench terminal viewer ${name} failed: ${detail(error)}`)
      }
    }
    process.removeListener('SIGINT', abort)
    process.removeListener('SIGTERM', abort)
  }
  if (failed || signal.aborted) process.exitCode = 1
  else if (fixtureOnly) console.log('Workbench terminal viewer fixture passed: 44 read-only numbered ASCII/Unicode lines, unchanged digest, identity, and mtime.')
  else console.log('Workbench terminal viewer browser E2E passed: real owner UI, Linux PTY screens and input, native exit, dialog disposal, scoped routes, and unchanged read-only source.')
}

const args = process.argv.slice(2)
if (!args.length) await run(false)
else if (args.length === 1 && args[0] === '--fixture-only') await run(true)
else {
  console.error('Usage: node scripts/workbench/e2e-terminal-viewer.mjs [--fixture-only]')
  process.exitCode = 1
}
