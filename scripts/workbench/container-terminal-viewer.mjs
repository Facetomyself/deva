// Native Linux/amd64 integration QA for an ephemeral Docker Engine 28+ runner.
// Prebuild the runtime and terminal-viewer targets as deva-workbench:terminal-verify
// and deva-terminal-viewer:verify. Run with nonroot Chrome/ChromeDriver and Node 22:
//   node scripts/workbench/container-terminal-viewer.mjs
// Fixture-only validation requires neither Docker nor Chrome and is portable:
//   node scripts/workbench/container-terminal-viewer.mjs --fixture-only
import { createHash, randomBytes } from 'node:crypto'
import { chmod, lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { request } from 'node:http'
import { machine, release } from 'node:os'
import { dirname, join } from 'node:path'
import { appCli, control, terminalDocker, workbench, worker, workerCli } from './container-terminal-viewer-docker.mjs'
import { probes } from './container-terminal-viewer-probe.mjs'
import { CheckFailure, choosePort, privateRoot } from './container-client-interactions-docker.mjs'
import { check, createTerminalFixture, TerminalViewerCheckError } from './e2e-terminal-viewer-fixture.mjs'
import { startLocalWebDriver, waitFor, WebDriverError } from './webdriver-local.mjs'

const stop = new AbortController()
const abort = () => stop.abort()
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const loopback = '127.0.0.1'

function status(port, path, signal) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: loopback, port, path, agent: false,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(4_000)]) : AbortSignal.timeout(4_000) }, res => {
      res.once('error', reject)
      res.once('end', () => resolve(res.statusCode))
      res.resume()
    })
    req.once('error', reject)
    req.end()
  })
}

async function prepareFixture(root) {
  const workspace = join(root, 'projects')
  const { expected, filePath, assertUnchanged } = await createTerminalFixture(workspace)
  // The private host parent remains mode 0700; only this dedicated descendant is bound.
  const project = dirname(filePath)
  for (const directory of [workspace, project]) await chmod(directory, 0o755)
  const hash = sha(Buffer.from(`${expected.lines.join('\n')}\n`))
  async function snapshot() {
    check(workspace === await realpath(workspace) && project === await realpath(project) && filePath === await realpath(filePath) &&
      (await readdir(workspace)).join() === expected.project && (await readdir(project)).join() === expected.file,
    'The dedicated fixture tree acquired an unexpected entry or path')
    check(sha(await readFile(filePath)) === hash, 'The native fixture bytes differ from the shared browser fixture')
    return JSON.stringify(await Promise.all([workspace, project, filePath].map(async path => {
      const stat = await lstat(path, { bigint: true })
      return ['dev', 'ino', 'mode', 'uid', 'gid', 'size', 'nlink', 'ctimeNs', 'mtimeNs'].map(field => String(stat[field]))
    })))
  }
  const baseline = await snapshot()
  return { workspace, hash, expected, innerPath: `/workspaces/${expected.project}/${expected.file}`, async verify() {
    await assertUnchanged()
    check(await snapshot() === baseline, 'The native fixture tree metadata changed')
  } }
}

async function verifyUi(docker, browser, origin, password, expected) {
  const { verifyTerminalBrowser } = await import('./e2e-terminal-viewer-browser.mjs')
  const observed = []
  await verifyTerminalBrowser({ browser, origin, password, signal: stop.signal, expected, async onViewerOpened() {
    // Hold the displayed browser viewer open while the kernel independently confirms it.
    // Only the observed child PID/start time is retained to verify later reaping.
    const result = await docker.probe(worker, probes.children, 'Observe the live fixed viewer and its slave PTY', {
      input: { cli: workerCli, mode: 'active' }, timeout: 5_000, signal: stop.signal
    })
    check(result.liveTty === true, 'A live confined viewer with three real TTY descriptors was not observed')
    observed.push(result.identity)
  } })
  check(observed.length === 2 && new Set(observed.map(({ pid, start }) => `${pid}:${start}`)).size === 2,
    'The two browser openings did not produce independently observed native viewers')
  return observed
}

function safeReason(error) {
  return error instanceof CheckFailure || error instanceof TerminalViewerCheckError || error instanceof WebDriverError ?
    error.message : 'verification failed (raw diagnostics withheld)'
}

async function main() {
  let local, docker, browser, failed = false, stage = 'validate runner'
  const setStage = next => { stage = next; stop.signal.throwIfAborted() }
  const fixtureOnly = process.argv.length === 3 && process.argv[2] === '--fixture-only'
  process.on('SIGINT', abort)
  process.on('SIGTERM', abort)
  try {
    check(fixtureOnly || (process.argv.length === 2 && process.platform === 'linux' && process.arch === 'x64' && machine() === 'x86_64' &&
      process.getuid?.() > 0 && process.geteuid?.() > 0 && process.versions.node.startsWith('22.')),
    'Run on an ephemeral native Linux/amd64 Docker runner as a nonroot browser user with Node 22, or use --fixture-only')
    setStage('create the dedicated synthetic fixture')
    local = await privateRoot()
    const fixture = await prepareFixture(local.path)
    await fixture.verify()
    if (!fixtureOnly) {
      setStage('resolve checked-in Compose and inspect both prepared images')
      const port = await choosePort(), origin = `http://${loopback}:${port}`
      docker = terminalDocker({ root: local.path, fixture: fixture.workspace, port, origin })
      const images = await docker.initialize()
      console.log(`Native Workbench image ${images[workbench]}, terminal worker image ${images[worker]} (linux/amd64).`)
      setStage('start verified Compose services and wait for packaged healthchecks')
      await docker.start()
      await waitFor(async () => {
        if (!await docker.running()) return false
        return status(port, '/healthz', stop.signal).then(code => code === 200, () => false)
      }, 'actual Workbench and worker healthy at the exact IPv4 loopback endpoint', { timeout: 100_000, interval: 1_000, signal: stop.signal })
      const inspect = service => docker.probe(service, probes.runtime, `Verify native ${service} kernel, mount and runtime context`, {
        input: { control, cli: service === worker ? workerCli : appCli, worker: service === worker,
          fixture: fixture.innerPath, kernel: release() }, signal: stop.signal
      })
      const idle = async (observed = []) => (await docker.probe(worker, probes.children, 'Check viewer children and staging are gone', {
        input: { cli: workerCli, mode: 'idle', observed }, signal: stop.signal
      })).idle === true
      setStage('check real CLI, worker confinement, shared socket and original bind bytes')
      const [appBefore, workerBefore] = await Promise.all([inspect(workbench), inspect(worker)])
      check(appBefore.fixtureHash === fixture.hash && appBefore.socket === workerBefore.socket,
        'Initial workspace bytes or shared socket inode validation failed')
      await waitFor(() => idle(), 'no residual worker child or staging after health probe', { signal: stop.signal })
      setStage('enroll a fresh owner over the private Unix socket and revoke enrollment session')
      const password = randomBytes(32).toString('base64url')
      check((await docker.probe(workbench, probes.owner, 'Enroll the owner through the packaged local control channel', {
        input: { origin, password }, signal: stop.signal
      })).enrolled, 'Owner enrollment was not confirmed')
      setStage('run fresh sandboxed Chrome login, workspace selection, native PTY keys, resize, quit, close and logout')
      browser = await startLocalWebDriver({ root: local.path, profile: join(local.path, 'chrome-profile'), origin, signal: stop.signal })
      const observed = await verifyUi(docker, browser, origin, password, fixture.expected)
      await browser.close()
      browser = undefined
      setStage('verify idle worker, healthy services, unchanged mount tables and ordinary native fixture bytes')
      await waitFor(() => idle(observed), 'observed viewers reaped; no worker child or staging remains', { signal: stop.signal })
      check(await docker.running() && await status(port, '/healthz', stop.signal) === 200, 'Packaged services are not healthy after browser logout')
      const [appAfter, workerAfter] = await Promise.all([inspect(workbench), inspect(worker)])
      check(JSON.stringify(appBefore) === JSON.stringify(appAfter) && JSON.stringify(workerBefore) === JSON.stringify(workerAfter),
        'Mounted scopes, socket inode or fixture contents changed during the browser workflow')
      await fixture.verify()
      setStage('observe graceful worker and workbench shutdown and close the test port')
      await docker.stop()
      await waitFor(() => status(port, '/healthz', stop.signal).then(() => false, error => error.code === 'ECONNREFUSED'),
        'published local listener closed', { signal: stop.signal })
      await fixture.verify()
    }
  } catch (error) {
    failed = true
    console.error(`Packaged terminal viewer QA failed at ${stage}: ${stop.signal.aborted ? 'interrupted' : safeReason(error)}`)
  } finally {
    let dockerClean = true
    for (const [name, cleanup] of [['Chrome', () => browser?.close()], ['exact Compose resources', async () => {
      try { await docker?.cleanup() } catch (error) { dockerClean = false; throw error }
    }], ['private fixture directory', () => {
      check(dockerClean, 'Preserved the private fixture because Docker resource removal was unconfirmed')
      return local?.remove()
    }]]) {
      try { await cleanup() } catch (error) {
        failed = true
        console.error(`Packaged terminal viewer cleanup (${name}): ${safeReason(error)}`)
      }
    }
    process.off('SIGINT', abort)
    process.off('SIGTERM', abort)
  }
  if (failed || stop.signal.aborted) process.exitCode = 1
  else console.log(fixtureOnly ? 'PASS synthetic terminal viewer fixture: exact native UTF-8 bytes and verified cleanup.' :
    'PASS packaged terminal viewer: normal owner login/logout in real Chrome, fixed native PTY with key and resize input, quit and close, no children or mount changes, healthy services, graceful and scoped cleanup.')
}

await main()
