// Native Linux/amd64 package gate for an ephemeral hosted runner. Build the Dockerfile's
// runtime target as deva-workbench:client-verify, then run this file as the nonroot CI user
// with matched Chrome/ChromeDriver (CHROME_BIN/CHROMEDRIVER_BIN per webdriver-local.mjs).
// Docker Engine 28+ with cgroup v2 is required. A default Docker bridge is used for the
// real browser-to-image path: only IPv4 loopback is published on the host; serve has networking.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { request } from 'node:http'
import { join } from 'node:path'
import { verifyBrowser } from './container-client-interactions-browser.mjs'
import { check, CheckFailure, choosePort, privateRoot, productionDocker } from './container-client-interactions-docker.mjs'
import { probes } from './container-client-interactions-probe.mjs'
import { startLocalWebDriver, waitFor, WebDriverError } from './webdriver-local.mjs'

const stop = new AbortController()
const abort = () => stop.abort()
const loopback = '127.0.0.1'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const responseLimit = 16 * 1024 * 1024
const json = res => JSON.parse(res.body.toString('utf8'))

function http(port, path, { method = 'GET', headers = {}, payload, signal = stop.signal } = {}) {
  const bytes = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload))
  return new Promise((resolve, reject) => {
    const req = request({ hostname: loopback, port, path, method, agent: false,
      signal: AbortSignal.any([signal, AbortSignal.timeout(4_000)]),
      headers: { ...headers, ...(bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}) }
    }, res => {
      const chunks = []
      let length = 0
      res.on('data', chunk => {
        length += chunk.length
        if (length > responseLimit) res.destroy(new CheckFailure('Loopback response exceeded its byte limit'))
        else chunks.push(chunk)
      })
      res.once('error', reject)
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.once('error', reject)
    req.end(bytes)
  })
}

async function verifyServedBundle(port, files) {
  const [html, js, unexpectedHost] = await Promise.all([
    http(port, '/'), http(port, '/workbench.js'), http(port, '/', { headers: { host: 'wrong.invalid' } })
  ])
  check(html.status===200 && js.status===200 && unexpectedHost.status===403,'CLI must serve only the exact loopback Host')
  check(/^text\/html\b/.test(html.headers['content-type']) && /^text\/javascript\b/.test(js.headers['content-type']),'Incorrect MIME of packaged HTML or API entry')
  check(html.headers['content-security-policy']?.includes("script-src 'self'") &&
    html.headers['permissions-policy'] === 'clipboard-read=(), clipboard-write=(self), fullscreen=(self)', 'Missing immutable page clipboard/fullscreen policy')
  check(digest(html.body)===files.html && digest(js.body)===files.js,'HTML or public entry differs from the actual image bytes')
  const names = [...html.body.toString('utf8').matchAll(/<script\b[^>]*\bsrc="\.\/(assets\/[\w.-]+\.js)"[^>]*><\/script>/g)].map(match=>match[1])
  check(names.length>0 && names.length<=6 && Array.isArray(files.htmlScripts) && names.length===files.htmlScripts.length,'Missing packaged browser startup scripts')
  for (const [i,name] of names.entries()) {
    check(files.htmlScripts[i]?.file===name && /^[0-9a-f]{64}$/.test(files.htmlScripts[i].sha),'HTML entry does not match the Vite manifest')
    const asset=await http(port,'/'+name)
    check(asset.status===200 && /^text\/javascript\b/.test(asset.headers['content-type']) && digest(asset.body)===files.htmlScripts[i].sha,'Actual browser JS differs from the static image bytes')
  }
}

async function claimVerifyAndLogout(docker, port, origin, password) {
  check((await http(port, '/api/v1/bootstrap')).status === 401, 'Fresh workbench allowed anonymous bootstrap')
  const { credential } = await docker.probe(probes.claim, 'Issue claim on private Unix control socket')
  check(/^[A-Za-z0-9_-]{43}$/.test(credential), 'Private control returned invalid claim metadata')
  const claimed = await http(port, '/api/v1/auth/claim', { method: 'POST', headers: { origin }, payload: { credential, password } })
  check(claimed.status === 200, 'The packaged CLI did not accept the private claim')
  const cookie = claimed.headers['set-cookie']?.[0]?.split(';', 1)[0]
  const { csrf } = json(claimed)
  check(/^deva-workbench-local=[A-Za-z0-9_-]{32,128}$/.test(cookie) && typeof csrf === 'string' && csrf.length > 0,
    'The packaged claim did not issue owner session metadata')
  // These deliberately non-Linux client hints never enter the browser; the server must
  // derive platform from its own runtime, and Chrome subsequently checks the rendered label.
  const bootstrap = await http(port, '/api/v1/bootstrap', { headers: { cookie, 'user-agent': 'Packaged QA (Macintosh)', 'sec-ch-ua-platform': '"macOS"' } })
  const boot = json(bootstrap)
  check(bootstrap.status === 200 && boot.protocol === 1 && boot.platform === 'linux' && boot.capabilities?.textChat === true &&
    boot.capabilities.taskInspection === true && boot.capabilities.browserPanel === false &&
    !Object.keys(boot.capabilities).some(key => /clipboard|fullscreen|command/i.test(key)),
  'Authenticated package bootstrap did not report the server’s Linux platform and expected capabilities')
  for (const path of ['/api/v1/clipboard', '/api/v1/fullscreen', '/api/v1/client/clipboard', '/api/v1/client/fullscreen', '/api/v1/commands/fullscreen', '/api/v1/commands']) {
    for (const method of ['GET', 'POST']) {
      const response = await http(port, path, { method, headers: { cookie, origin, 'x-deva-csrf': csrf },
        payload: method === 'POST' ? { command: 'fullscreen' } : undefined })
      check(response.status === 404 && json(response).error === 'not_found', 'A clipboard/fullscreen/command endpoint was exposed')
    }
  }
  const logout = await http(port, '/api/v1/auth/logout', { method: 'POST', headers: { cookie, origin, 'x-deva-csrf': csrf } })
  check(logout.status === 200 && (await http(port, '/api/v1/bootstrap', { headers: { cookie } })).status === 401,
    'The private setup owner session did not close before the real browser login')
}

function stageDescription(error) {
  return error instanceof CheckFailure || error instanceof WebDriverError ? error.message : 'verification failed (raw diagnostics withheld)'
}

async function main() {
  let local, docker, browser, failed = false, stage = 'validate native runner'
  const setStage = name => { stage = name; stop.signal.throwIfAborted() }
  process.on('SIGINT', abort)
  process.on('SIGTERM', abort)
  try {
    check(process.argv.length === 2 && process.platform === 'linux' && process.arch === 'x64' && Number(process.versions.node.split('.')[0]) === 22 &&
      process.getuid?.() > 0 && process.geteuid?.() > 0, 'Run on native Linux/amd64 as a nonroot user with Node 22')
    setStage('inspect pinned production image, create private resources')
    local = await privateRoot()
    docker = productionDocker(local.path)
    const img = await docker.init()
    console.log(`Packaged Workbench ${img.id} · linux/amd64 · ${img.bytes} bytes`)

    setStage('provision the isolated key and ordinary native clipboard fixture')
    const nonce = randomBytes(8).toString('hex')
    const fixture = { sid: randomUUID(), title: `Packaged QA ${nonce}`, word: `deva${nonce}` }
    const { digest: original } = await docker.prepare(probes.seed, fixture)
    check(/^[a-f0-9]{64}$/.test(original), 'Native seed digest missing')

    setStage('start packaged CLI with one host IPv4 loopback publication')
    const port = await choosePort(), origin = `http://${loopback}:${port}`
    await docker.serve(port)
    await waitFor(async () => {
      try { return (await http(port, '/readyz')).status === 200 } catch { return false }
    }, 'exact loopback origin served by the runtime image', { timeout: 24_000, signal: stop.signal })

    setStage('check kernel confinement, Unix control and shipped web bytes')
    const runtime = await docker.probe(probes.runtime, 'Inspect packaged CLI process and static assets')
    check(runtime.platform === 'linux' && runtime.arch === 'x64' && runtime.node === 22 && runtime.production && runtime.restricted &&
      runtime.privateControl && runtime.noClipboardIntegration && runtime.cgroupLimits,
    'Runtime CLI process, cgroup limits, socket or clipboard isolation failed')
    await verifyServedBundle(port, runtime)
    console.log(`Runtime: uid/gid 1000, RO root, cap-drop ALL, NNP, seccomp; 128 PIDs/512 MiB/2 CPUs; named data/RO keys; sole host publication ${origin} (default bridge).`)
    console.log(`Served HTML/entry match packaged SHA-256 ${runtime.html.slice(0, 12)}/${runtime.js.slice(0, 12)}.`)

    setStage('verify Linux bootstrap, absent server command routes and revoke private claim session')
    const password = randomBytes(32).toString('base64url')
    await claimVerifyAndLogout(docker, port, origin, password)

    setStage('start nonroot sandboxed Chrome with private profile')
    browser = await startLocalWebDriver({ root: local.path, profile: join(local.path, 'chrome-profile'), origin, signal: stop.signal })
    const freshId = await verifyBrowser({ browser, origin, password, fixture, signal: stop.signal, stage: setStage })
    setStage('verify native fixture stayed byte-identical and fresh draft stayed unsent')
    const native = await docker.probe(probes.native, 'Verify owned native fixture files and fresh session', { sid: fixture.sid, freshId, digest: original })
    check(native.fixtureUnchanged && native.onlyExpectedChats && native.freshEmpty, 'Native history was modified, a stray chat appeared, or paste wrote a turn')

    setStage('close real Chrome, stop production CLI gracefully and verify loopback listener gone')
    await browser.close()
    browser = undefined
    await docker.stop()
    const portClosed = await http(port, '/livez').then(() => false, error => error.code === 'ECONNREFUSED')
    check(portClosed, 'The previous published listener remained reachable or its closure was unconfirmed')
  } catch (error) {
    failed = true
    console.error(`Packaged Workbench client acceptance failed at ${stage}: ${stop.signal.aborted ? 'interrupted' : stageDescription(error)}`)
  } finally {
    for (const [name, cleanup] of [
      ['Chrome/ChromeDriver', () => browser?.close()], ['Docker containers and volumes', () => docker?.cleanup()],
      ['private test directory', () => local?.remove()]
    ]) {
      try { await cleanup() } catch (error) {
        failed = true
        console.error(`Packaged Workbench client cleanup (${name}): ${stageDescription(error)}`)
      }
    }
    process.off('SIGINT', abort)
    process.off('SIGTERM', abort)
  }
  if (failed || stop.signal.aborted) process.exitCode = 1
  else console.log('PASS packaged Linux Workbench: private claim; real sandboxed Chrome login/logout; one native fullscreen enter/exit; Ctrl+B collapse/restore; read-only selection Copy without Quote pasted into an unsent fresh chat; code header Copy pasted exact text into sidebar search then cleared. Linux bootstrap/settings, no clipboard/fullscreen command route, unchanged native history, no extra chats or active turns/tasks; Chrome, CLI, containers and volumes closed.')
}

await main()
