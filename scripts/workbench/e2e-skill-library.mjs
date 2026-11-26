import { randomBytes } from 'node:crypto'
import { access, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { requestControl } from '../../apps/headless/src/control/socket.mjs'
import { DEFAULT_WEB_DIR, startWorkbench } from '../../apps/headless/src/server.mjs'
import { initializeMasterKey } from '../../apps/headless/src/storage/vault.mjs'
import { runSkillBrowser } from './e2e-skill-library-browser.mjs'
import { check, createSkillFixture, privateRoot, SkillCheckError } from './e2e-skill-library-fixture.mjs'
import { startLocalWebDriver, WebDriverError } from './webdriver-local.mjs'

// Observe the real dispatcher without altering request bodies, response bodies or authorization.
// Capturing from request arrival also sees in-flight polls excluded from Resource Timing.
function observeBusiness(rows, openBusiness, disconnect) {
  let firstLogin, recoveryGate
  const firstPolls=new Set()
  disconnect.resume = () => { recoveryGate?.resolve(); recoveryGate=undefined }
  // Truncate an actual in-flight response *after headers*. A pooled socket dropped
  // before headers may be retried transparently inside Chrome and never reach the UI.
  // Hold the next catalog read until the browser observes its frozen, scrubbed state.
  disconnect.once = () => {
    for (const peer of firstPolls) if (!peer.res.destroyed && !peer.res.headersSent && performance.now()-peer.since>120) {
      firstPolls.delete(peer)
      recoveryGate=Promise.withResolvers()
      const timer=setTimeout(disconnect.resume,9000); recoveryGate.promise.then(()=>clearTimeout(timer))
      peer.res.writeHead(200,{'content-type':'application/json','content-length':'160','cache-control':'no-store',connection:'close'})
      peer.res.write('{"changed":',()=>peer.res.destroy())
      return true
    }
    return false
  }
  return async options => {
    const business = await openBusiness(options)
    return { ...business, async handle(req, res, context) {
      const [path, query] = (req.url ?? '').split('?', 2)
      const row = { method: req.method, path, query: query !== undefined, authenticated: !!req.headers.cookie, status: 0 }
      rows.push(row)
      if (path === '/api/v1/skills/-/changes' && req.method === 'POST') {
        const actor=context.auth.identify(context.policy.cookie(req),req.headers['x-deva-csrf'])
        firstLogin??=actor.loginSessionId
        if(actor.loginSessionId===firstLogin){
          const peer={res,since:performance.now()};firstPolls.add(peer)
          res.once('close',()=>firstPolls.delete(peer))
        }
      }
      res.once('finish', () => { row.status = res.statusCode })
      if (recoveryGate && path==='/api/v1/skills' && req.method==='GET' &&
          context.auth.identify(context.policy.cookie(req)).loginSessionId===firstLogin) await recoveryGate.promise
      return business.handle(req, res, context)
    } }
  }
}

function assertOnlyAcceptedTraffic(rows) {
  const reads = new Set(['settings', 'provider-keys', 'chats', 'personas', 'profile', 'workspaces', 'skills',
    'skills/-/roles', 'skills/editorial-guide', 'skills/create-agent', 'skills/create-skill', 'skills/create-mcp'])
  for (const row of rows) {
    const name = row.path.slice('/api/v1/'.length)
    check(row.path.startsWith('/api/v1/') && !row.query && row.authenticated &&
      ((row.method === 'GET' && reads.has(name)) || (row.method === 'POST' && name === 'skills/-/changes') ||
        (row.method === 'PATCH' && name === 'skills/editorial-guide/preferences')),
    'Unexpected non-auth owner request (model, chat, write, resource, unselected skill, or query)')
  }
}

async function run({ fixtureOnly }) {
  const stop = new AbortController()
  const abort = () => stop.abort()
  const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(150_000)])
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  const rows = [], browsers = [], disconnect={}
  let temp, server, failed, stage = 'prepare private native fixture'
  const mark = next => { stage = next; signal.throwIfAborted() }
  try {
    check(process.platform === 'linux' && process.getuid?.() > 0 && process.geteuid?.() > 0, 'Run the skill library gate on Linux as a nonroot user')
    await access(new URL('../../apps/headless/dist/library-core.mjs', import.meta.url)).catch(() => {
      throw new SkillCheckError('Build the headless library core with pnpm --filter @deva/headless build')
    })
    temp = await privateRoot()
    const fixture = await createSkillFixture(temp.root)
    await fixture.assertNative(true, null)
    if (fixtureOnly) {
      await fixture.reviseGuide()
      await fixture.assertNative(true, null)
    } else {
      mark('start the built Workbench on a private IPv4 loopback origin')
      await access(join(DEFAULT_WEB_DIR, 'index.html')).catch(() => { throw new SkillCheckError('Run pnpm workbench:build first') })
      const keyFile = join(temp.root, 'master.key'), runDir = join(temp.root, 'run'), workspaceRoot = join(temp.root, 'workspaces')
      await mkdir(workspaceRoot, { mode: 0o700 })
      await initializeMasterKey(keyFile)
      const { openBusiness } = await import('../../apps/headless/src/business/handlers.mjs')
      server = await startWorkbench({ dataDir: fixture.dataDir, keyFile, runDir, host: '127.0.0.1', port: 0,
        businessFactory: observeBusiness(rows, openBusiness, disconnect), businessOptions: { workspaceRoot } })
      const { origin, address } = server
      check(address.address === '127.0.0.1' && origin === `http://127.0.0.1:${address.port}`, 'Expected the assigned private IPv4 origin')
      const ready = await fetch(`${origin}/readyz`, { signal, redirect: 'error' })
      await ready.body?.cancel()
      check(ready.status === 200, 'The isolated Workbench is not ready')
      const password = randomBytes(24).toString('base64url')
      const openBrowser = async name => {
        const root = join(temp.root, name)
        await mkdir(root, { mode: 0o700 })
        const browser = await startLocalWebDriver({ root, profile: join(root, 'profile'), origin, signal })
        browsers.push(browser)
        return browser
      }
      await runSkillBrowser({ fixture, rows, origin, password, openBrowser, signal, mark, dropChanges:disconnect.once, resumeChanges:disconnect.resume,
        claim: () => requestControl({ runDir, op: 'claim' }), ownerClaimed: async () => (await requestControl({ runDir, op: 'status' })).claimed })
      assertOnlyAcceptedTraffic(rows)
    }
  } catch (error) {
    failed = true
    const detail = error instanceof SkillCheckError || error instanceof WebDriverError ? error.message : 'unexpected error (raw diagnostics withheld)'
    console.error(`Workbench Skill Library E2E failed while ${stage}: ${signal.aborted ? 'interrupted or timed out' : detail}`)
  } finally {
    for (const [name, cleanup] of [['browser close', () => Promise.all(browsers.map(browser => browser.close()))],
      ['server shutdown', () => server?.close()], ['private fixture cleanup', () => temp?.close()]]) {
      try { await cleanup() } catch { failed = true; console.error(`Workbench Skill Library E2E: ${name} failed`) }
    }
    process.removeListener('SIGINT', abort)
    process.removeListener('SIGTERM', abort)
  }
  if (failed || signal.aborted) process.exitCode = 1
  else if (fixtureOnly) console.log('Workbench Skill Library fixture passed: native settings, two editorial documents and one ordinary added role.')
  else console.log('Workbench Skill Library browser E2E passed: isolated owner claim/login, native skill preferences, cross-owner and external invalidation, and inactive execution.')
}

const args = process.argv.slice(2)
if (!args.length || (args.length === 1 && args[0] === '--fixture-only')) await run({ fixtureOnly: args.length === 1 })
else {
  console.error('Usage: node scripts/workbench/e2e-skill-library.mjs [--fixture-only]')
  process.exitCode = 1
}
