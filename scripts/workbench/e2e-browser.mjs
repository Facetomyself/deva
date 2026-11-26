import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { access, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requestControl } from '../../apps/headless/src/control/socket.mjs'
import { DEFAULT_WEB_DIR, startWorkbench } from '../../apps/headless/src/server.mjs'
import { initializeMasterKey } from '../../apps/headless/src/storage/vault.mjs'
import { startLocalWebDriver, waitFor, WebDriverError } from './webdriver-local.mjs'

const providerName = 'Workbench E2E provider'
const modelId = 'e2e-mock-model'
const otherModelId = 'e2e-mock-second-model'
const tab = '\uE004'
const selectAll = '\uE009a\uE000'
const models = '.wb-settings .models'
const detail = `${models} .provider-detail`
const hostInput = `${detail} .field__control > input.input[type="text"]`
const nameInput = `${detail} .provider-detail__name-input`
const keyInput = `${detail} .input-affix > input[type="password"]`
const addModelButton = `${detail} .field__row-between > button`
const modelChoice = `${detail} .model-combo__opt`
const password = autocomplete => `.wb-auth input[name="password"][type="password"][autocomplete="${autocomplete}"]`

class CheckFailure extends Error {}
function check(condition, failure) {
  if (!condition) throw new CheckFailure(failure)
}

async function startMock(key) {
  const response = JSON.stringify({ object: 'list', data: [modelId, otherModelId].map(id => ({ id, object: 'model' })) })
  let successful = 0
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/v1/models') {
      res.writeHead(404).end()
    } else if (req.headers.authorization !== `Bearer ${key}` || req.headers.cookie !== undefined) {
      res.writeHead(401).end()
    } else {
      successful++
      res.writeHead(200, { 'content-type': 'application/json' }).end(response)
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    get successful() { return successful },
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
      server.closeAllConnections()
    })
  }
}

function workbenchReadiness(port, signal) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: '/readyz', agent: false,
      signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) }, res => {
      res.resume()
      resolve(res.statusCode)
    })
    req.once('error', reject)
    req.end()
  })
}

// Only DOM predicates/element references leave the page, never raw text, input values, or URLs.
const findVisible = `
  const [selector, expected, child] = arguments;
  const visible = el => el.getClientRects().length && getComputedStyle(el).visibility === 'visible';
  if (Array.from(document.querySelectorAll('.wb-error[role="alert"], #root > [role="alert"]')).some(visible)) {
    return false;
  }
  return Array.from(document.querySelectorAll(selector)).find(el => {
    if (!visible(el) || el.matches(':disabled')) return false;
    if (expected == null) return true;
    const label = child ? el.querySelector(child) : el;
    return expected.includes(label?.textContent.trim());
  }) ?? null;
`

function ui(browser, signal) {
  return (selector, description, text = null, child = null) => waitFor(async () => {
    const result = await browser.execute(findVisible, selector, text, child)
    check(result !== false, 'Workbench showed an error alert')
    return result
  }, description, { signal })
}

async function replaceAndBlur(browser, element, text) {
  await browser.keys(element, `${selectAll}${text}`)
  await browser.keys(element, tab)
}

async function settingsStatus(browser) {
  return browser.executeAsync(`
    const finish = arguments[arguments.length - 1];
    fetch('/api/v1/settings', { credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
      .then(response => finish(response.status), () => finish(0));
  `)
}

async function claimAccount(browser, element, { origin, runDir, passwordValue, signal }) {
  const { credential } = await requestControl({ runDir, op: 'claim' })
  // The URL goes only to local WebDriver, never to the shell, logs, or an output artifact.
  await browser.navigate(`${origin}/#claim=${encodeURIComponent(credential)}`)
  // Chrome can return from eager navigation at `interactive`, just before a deferred module
  // runs. Sample at the first observed DOMContentLoaded, before waiting for any form or React.
  const firstPage = await waitFor(() => browser.execute(`
    if (!performance.getEntriesByType('navigation')[0]?.domContentLoadedEventStart) return null;
    return { cleared: location.origin === arguments[0] && location.pathname === '/' &&
      location.search === '' && location.hash === '' };
  `, origin), 'initial DOMContentLoaded', { timeout: 4_000, interval: 20, signal })
  check(firstPage.cleared, 'Claim fragment survived the initial page load')
  const input = await element(password('new-password'), 'claim password form')
  check(await browser.execute('return !document.querySelector(".wb-auth input[name=credential]");'),
    'Claim credential was not handed off to the form')
  await browser.keys(input, passwordValue)
  await browser.click(await element('.wb-auth button[type="submit"]', 'claim submit button'))
  await element(models, 'desktop model settings after claim')
  check((await requestControl({ runDir, op: 'status' })).claimed, 'Unix control did not report a claimed owner')
  check(await settingsStatus(browser) === 200, 'Claimed browser could not read settings')
}

async function configureProvider(browser, element, mock, syntheticKey) {
  await browser.click(await element(`${models} .models__add-btn`, 'add custom provider'))
  await replaceAndBlur(browser, await element(nameInput, 'custom provider name field'), providerName)
  await replaceAndBlur(browser, await element(hostInput, 'provider base URL field'), `${mock.origin}/v1`)
  const key = await element(keyInput, 'provider key field')
  await browser.keys(key, syntheticKey)
  await browser.keys(key, tab) // Commit the key through the settings UI's blur handler.
  await element(`${detail} .key-status`, 'provider key save confirmation', ['Saved', '已保存'])

  await browser.click(await element(addModelButton, 'open model chooser'))
  await browser.click(await element(modelChoice, 'model returned by mock', [modelId], '.model-combo__opt-id'))
  await element(`${modelChoice}.is-selected`, 'selected model option', [modelId], '.model-combo__opt-id')
  await browser.click(await element(`${detail} .model-add > button.btn--primary`, 'add selected model'))
  await element(`${detail} .model-row__name`, 'selected model in settings', [modelId])

  // A second real probe is queued by the UI after the model write. Await it before reload
  // rather than sleeping or treating React's optimistic model row as a persistence receipt.
  await browser.click(await element(addModelButton, 'open chooser after model save'))
  await element(modelChoice, 'remaining model returned by mock', [otherModelId], '.model-combo__opt-id')
  check(mock.successful === 2, 'Model mock did not observe two correctly authorized requests')
}

async function verifyReload(browser, element, mock) {
  await browser.refresh()
  await element(models, 'desktop model settings following refresh')
  await browser.click(await element(`${models} .provider-row`, 'persisted custom provider', [providerName], '.provider-row__name-text'))
  const host = await element(hostInput, 'persisted provider base URL field')
  check(await browser.execute('return arguments[0].value === arguments[1];', host, `${mock.origin}/v1`),
    'Provider base URL was not restored from storage')
  await element(`${detail} .key-status`, 'persisted provider key status', ['Configured', '已配置'])
  const key = await element(keyInput, 'blank provider key field following refresh')
  check(await browser.execute('return arguments[0].value === "";', key), 'Stored key was echoed into the password input')
  await element(`${detail} .model-row__name`, 'persisted selected model', [modelId])
  await element(`${detail} .model-row [role="switch"][aria-checked="true"]`, 'persisted enabled model')
  await browser.click(await element(addModelButton, 'reopen model chooser following refresh'))
  await element(modelChoice, 'post-refresh model probe', [otherModelId], '.model-combo__opt-id')
  check(mock.successful === 3, 'The persisted key did not authorize the post-refresh probe')
}

async function signOut(browser, element) {
  await browser.click(await element('.wb-header > button', 'sign out', ['Sign out', '退出登录']))
  await element(password('current-password'), 'login form following sign out')
  check(await browser.execute('return !document.querySelector(".wb-settings .models");'), 'Settings remained visible after sign out')
  check(await settingsStatus(browser) === 401, 'Signed-out browser retained access to settings')
}

const stop = new AbortController()
const abort = () => stop.abort()
process.once('SIGINT', abort)
process.once('SIGTERM', abort)
let stage = 'validate environment'
let root, mock, workbench, browser, failed
try {
  check(process.platform === 'linux' && process.getuid?.() > 0 && process.geteuid?.() > 0,
    'Run this test on Linux as a non-root user')
  stage = 'check build outputs'
  await access(new URL('../../apps/headless/dist/provider-core.mjs', import.meta.url)).catch(() => {
    throw new CheckFailure('Build the provider with pnpm --filter @deva/headless build')
  })
  stage = 'start local workbench and model mock'
  const prefix = join(await realpath(tmpdir()), 'deva-wb-e2e-')
  const createdRoot = await mkdtemp(prefix)
  check(createdRoot.startsWith(prefix) && createdRoot.length > prefix.length, 'Unexpected temporary directory')
  root = createdRoot
  const dataDir = join(root, 'data')
  const keyFile = join(root, 'master.key')
  const runDir = join(root, 'run')
  const webDir = DEFAULT_WEB_DIR
  const syntheticKey = `synthetic-e2e-${randomBytes(18).toString('hex')}`
  const passwordValue = `deva-e2e-${randomBytes(18).toString('hex')}`
  await initializeMasterKey(keyFile)
  mock = await startMock(syntheticKey)
  const mockOrigin = mock.origin
  workbench = await startWorkbench({ dataDir, keyFile, runDir, webDir, port: 0, businessOptions: { allowedOrigins: [mockOrigin] } })
  check(await workbenchReadiness(workbench.address.port, stop.signal) === 200,
    'Workbench is not ready; build the desktop workbench assets')
  stage = 'start sandboxed headless Chrome'
  browser = await startLocalWebDriver({ root, profile: join(root, 'chrome-profile'), origin: workbench.origin, signal: stop.signal })
  const element = ui(browser, stop.signal)
  stage = 'claim fragment and password form'
  await claimAccount(browser, element, { origin: workbench.origin, runDir, passwordValue, signal: stop.signal })
  stage = 'provider setup and model selection'
  await configureProvider(browser, element, mock, syntheticKey)
  stage = 'refresh and verify persisted settings'
  await verifyReload(browser, element, mock)
  stage = 'sign out and check access'
  await signOut(browser, element)
} catch (error) {
  failed = true
  const detail = stop.signal.aborted ? 'interrupted' : error instanceof CheckFailure || error instanceof WebDriverError
    ? error.message : 'unexpected error (raw diagnostics withheld)'
  console.error(`Workbench browser E2E failed at ${stage}: ${detail}`)
} finally {
  // Run every cleanup, even on a lost WebDriver session. Remove only the known, absolute
  // path returned by mkdtemp for this invocation; never expose its profile as an artifact.
  for (const [name, cleanup] of [
    ['browser', () => browser?.close()], ['workbench', () => workbench?.close()],
    ['model mock', () => mock?.close()], ['temporary directory', () => root && rm(root, { recursive: true, force: true })]
  ]) {
    try { await cleanup() } catch {
      failed = true
      console.error(`Workbench browser E2E: ${name} cleanup failed`)
    }
  }
  process.removeListener('SIGINT', abort)
  process.removeListener('SIGTERM', abort)
}
if (failed || stop.signal.aborted) process.exitCode = 1
else console.log('Workbench browser E2E passed: claim, model setup, refresh persistence, and sign out.')
