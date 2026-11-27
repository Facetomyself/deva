import { randomBytes } from 'node:crypto'
import { access, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { authenticate, controls, verifyInChrome } from './e2e-project-documents-browser.mjs'
import { check, checkFixture, makePrivateRoot, ProjectDocumentsFailure, seedDocuments } from './e2e-project-documents-fixture.mjs'
import { observeDocumentWire } from './e2e-project-documents-wire.mjs'
import { startLocalWebDriver, WebDriverError } from './webdriver-local.mjs'

async function assertBuilds(webDir) {
  await Promise.all(['provider', 'chat', 'library'].map(name =>
    access(new URL(`../../apps/headless/dist/${name}-core.mjs`, import.meta.url)))).catch(() => {
    throw new ProjectDocumentsFailure('Build headless cores with pnpm --filter @deva/headless build')
  })
  await access(join(webDir, 'index.html')).catch(() => {
    throw new ProjectDocumentsFailure('Build the Workbench assets with pnpm workbench:build')
  })
}

async function configureModel({ dataDir, keyFile }, mock) {
  const [{ openVault }, { openSettings }] = await Promise.all([
    import('../../apps/headless/src/storage/vault.mjs'), import('../../apps/headless/src/business/settings.mjs')
  ])
  const settings = await openSettings({ dataDir, vault: await openVault({ dataDir, keyFile }) })
  const { revision } = await settings.getPublicConfig()
  const id = 'document-acceptance-fixture', model = 'document-fixture-model'
  const provider = { id, name: 'Synthetic document fixture', kind: 'custom', purpose: 'llm', adapter: 'openai',
    apiHost: `${mock.origin}/v1`, accent: '#345678', enabled: true, models: [{ id: model, name: model, enabled: true }] }
  const update = await settings.patch({ revision, unset: [], set: {
    locale: 'en', models: { providers: [provider], activeModelId: `${id}:${model}`, activeEffort: 'default' }
  } })
  check((await settings.setKey(id, mock.key, update.revision)).available, 'Synthetic loopback model canary was not configured')
}

async function runInRealWorkbench(resources, fixture, signal, stage) {
  stage('check native nonroot Linux and built Workbench assets')
  check(process.platform === 'linux' && process.getuid?.() > 0 && process.geteuid?.() > 0,
    'Run the browser acceptance on native Linux as a non-root user')
  const [{ DEFAULT_WEB_DIR, startWorkbench }, { requestControl }, { startInteractionModel }] = await Promise.all([
    import('../../apps/headless/src/server.mjs'), import('../../apps/headless/src/control/socket.mjs'),
    import('./e2e-client-interactions-fixture.mjs')
  ])
  await assertBuilds(DEFAULT_WEB_DIR)
  stage('start the authentic scoped Workbench and loopback model canary')
  resources.model = await startInteractionModel()
  await configureModel(fixture, resources.model)
  const { dataDir, keyFile, runDir, workspaceRoot, root } = fixture
  const app = resources.app = await startWorkbench({ host: '127.0.0.1', port: 0, webDir: DEFAULT_WEB_DIR,
    dataDir, keyFile, runDir, businessOptions: { workspaceRoot, workspaceWritable: true, workspaceCreate: true,
      allowedOrigins: [resources.model.origin] } })
  const { origin, address } = app
  check(address.address === '127.0.0.1' && origin === `http://127.0.0.1:${address.port}`, 'Unexpected Workbench listener or origin')
  const ready = await fetch(`${origin}/readyz`, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) })
  await ready.body?.cancel()
  check(ready.status === 200, 'Scoped Workbench did not report ready')
  const wire = resources.wire = observeDocumentWire(app, signal)

  stage('claim and log in through two independent sandboxed Chrome profiles')
  async function freshProfile(label) {
    const profile = join(root, label)
    await mkdir(profile, { mode: 0o700 })
    const browser = await startLocalWebDriver({ root, profile, origin, signal })
    resources.browsers.push(browser)
    return { browser, ui: controls(browser, signal), origin, wire, fixture }
  }
  const password = randomBytes(24).toString('base64url')
  const first = await freshProfile('chrome-owner-one')
  const { credential } = await requestControl({ runDir, op: 'claim' })
  await authenticate(first, password, credential)
  check((await requestControl({ runDir, op: 'status' })).claimed === true, 'Private control did not confirm the UI owner claim')
  const second = await freshProfile('chrome-owner-two')
  await authenticate(second, password)
  wire.assertAuth()
  await verifyInChrome(first, second, stage)
  resources.model.assertCount(0)
}

const detail = error => error instanceof ProjectDocumentsFailure || error instanceof WebDriverError
  ? error.message : 'unexpected error (raw diagnostics withheld)'

async function run(fixtureOnly) {
  const stop = new AbortController()
  const abort = () => stop.abort()
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(180_000)])
  const resources = { browsers: [] }
  let failed = false, phase = 'check the isolated synthetic Linux fixture with the real workspace catalog and readers'
  const stage = next => { phase = next; signal.throwIfAborted() }
  try {
    check(process.platform === 'linux', 'The project-documents fixture requires Linux')
    resources.temp = await makePrivateRoot()
    const fixture = await seedDocuments(resources.temp.root)
    await checkFixture(fixture)
    if (!fixtureOnly) await runInRealWorkbench(resources, fixture, signal, stage)
  } catch (error) {
    failed = true
    console.error(`Workbench project documents ${fixtureOnly ? 'fixture' : 'E2E'} failed at ${phase}: ${signal.aborted ? 'interrupted or timed out' : detail(error)}`)
  } finally {
    const cleanups = [
      ...resources.browsers.map(browser => ['Chrome', () => browser.close()]), ['Workbench', () => resources.app?.close()],
      ['final command guards', () => { if (!failed) { resources.wire?.idle(); resources.model?.assertCount(0) } }],
      ['wire observer', () => resources.wire?.close()], ['model canary', () => resources.model?.close()],
      ['owned private directory', () => resources.temp?.close()]
    ]
    for (const [name, action] of cleanups) {
      try { await action() } catch (error) {
        failed = true
        console.error(`Workbench project documents: ${name} cleanup or final assertion failed: ${detail(error)}`)
      }
    }
    process.removeListener('SIGINT', abort)
    process.removeListener('SIGTERM', abort)
  }
  if (failed || signal.aborted) process.exitCode = 1
  else if (fixtureOnly) console.log('Workbench project documents fixture passed: production catalog and file readers, private key/root, exact native bytes, excluded symlink, and cleanup. Browser E2E was not run.')
  else console.log('Workbench project documents browser E2E passed: real owner profiles, reveal focus, explicit review/create, native bytes and identity, kept draft on 409, and one-shot readback after a truncated acknowledgement.')
}

const args = process.argv.slice(2)
if (args.length === 0 || (args.length === 1 && args[0] === '--fixture-only')) await run(args.length === 1)
else {
  console.error('Usage: node scripts/workbench/e2e-project-documents.mjs [--fixture-only]')
  process.exitCode = 1
}
