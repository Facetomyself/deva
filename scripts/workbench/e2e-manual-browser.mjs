#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { request } from 'node:http'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { requestControl } from '../../apps/headless/src/control/socket.mjs'
import { initializeMasterKey } from '../../apps/headless/src/storage/vault.mjs'
import { startLocalWebDriver, waitFor, WebDriverError } from './webdriver-local.mjs'
import { formPath, frameSamples, siteId, siteLabel, startManualFixture, viewport } from './e2e-manual-browser-fixture.mjs'

// Run on non-root Linux after the headless and Workbench builds, with an existing
// matched Chrome/ChromeDriver pair and a Chromium that passes the worker's sandbox probe.
const repo = new URL('../../', import.meta.url)
const web = 'apps/desktop/out/workbench/'
const chromeNames = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome']
const hook = name => `[data-testid="workbench-${name}"]`
const panel = name => hook(`browser-${name}`)
const password = kind => `.wb-auth input[name="password"][autocomplete="${kind}-password"]`
const api = '/api/v1'
const browserScope = sid => `${api}/chats/${sid}/browser`
const stop = new AbortController()
let stage = 'preflight.platform'
function step(name) {
  stop.signal.throwIfAborted()
  stage = name
  console.log(`manual-browser-e2e ${name}`)
}
class Failure extends Error {}
function check(ok, code) { if (!ok) throw new Failure(code) }
const until = (fn, code, timeout) => waitFor(fn, code, { timeout, signal: stop.signal })

async function requireFile(relative, code) {
  const info = await stat(new URL(relative, repo)).catch(() => null)
  check(info?.isFile() && info.size > 0, code)
}

async function executable(chosen, fallbacks, failure) {
  const search = (process.env.PATH ?? '').split(':').filter(isAbsolute)
  const names = chosen ? [chosen] : fallbacks
  for (const name of names) {
    const candidates = isAbsolute(name) ? [name] : basename(name) === name ? search.map(dir => join(dir, name)) : []
    for (const candidate of candidates) {
      try {
        await access(candidate, constants.X_OK)
        if ((await stat(candidate)).isFile()) return candidate
      } catch { /* An executable must be present locally. */ }
    }
  }
  throw new Failure(failure)
}

async function preflight() {
  step('preflight.platform')
  check(process.platform === 'linux' && process.getuid?.() > 0 && process.geteuid?.() === process.getuid(), 'NON_ROOT_LINUX_REQUIRED')
  step('preflight.sources')
  for (const file of ['apps/browser-worker/src/worker.mjs', 'apps/browser-worker/src/client.mjs', 'apps/browser-worker/src/egress/index.mjs',
    'apps/headless/src/browser/manual-browser.mjs', 'apps/desktop/src/workbench/browser-panel.tsx']) await requireFile(file, 'MANUAL_BROWSER_SOURCE_MISSING')
  step('preflight.dist')
  await requireFile('apps/headless/dist/provider-core.mjs', 'HEADLESS_BUILD_MISSING')
  for (const asset of ['index.html', 'manifest.json', 'workbench.js']) await requireFile(web + asset, 'WORKBENCH_BUILD_MISSING')
  // The production mount keeps the React workbench in a lazy Vite chunk.
  const manifest = await readFile(new URL(web + 'manifest.json', repo), 'utf8')
    .then(JSON.parse).catch(() => null)
  const entry = manifest?.['text-workbench.tsx']?.file
  check(typeof entry === 'string' && /^assets\/[\w-]+\.js$/.test(entry), 'WORKBENCH_BUILD_STALE')
  await requireFile(web + entry, 'WORKBENCH_BUILD_MISSING')
  check((await readFile(new URL(web + entry, repo), 'utf8')).includes('workbench-browser-open'), 'WORKBENCH_BUILD_STALE')
  step('preflight.executables')
  const driver = await executable(process.env.CHROMEDRIVER_BIN || (process.env.CHROMEWEBDRIVER &&
    join(process.env.CHROMEWEBDRIVER, 'chromedriver')), ['chromedriver'], 'CHROMEDRIVER_BIN_MISSING')
  const chrome = await executable(process.env.CHROME_BIN, chromeNames, 'CHROME_BIN_MISSING')
  const chromium = await executable(process.env.CHROMIUM_PATH, [chrome], 'CHROMIUM_PATH_MISSING')
  return { driver, chrome, chromium }
}

function readiness(port) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: '/readyz', agent: false,
      signal: AbortSignal.any([stop.signal, AbortSignal.timeout(5_000)]) }, res => {
      res.resume()
      resolve(res.statusCode)
    })
    req.once('error', reject)
    req.end()
  })
}

async function privateSocket(actual, dir, name) {
  check(actual === join(dir, name) && await realpath(dir) === dir, 'UNIX_SOCKET_SCOPE_MISMATCH')
  const [socket, parent] = await Promise.all([lstat(actual), lstat(dir)])
  check(socket.isSocket() && (socket.mode & 0o7777) === 0o600 && socket.uid === process.getuid() &&
    parent.isDirectory() && (parent.mode & 0o7777) === 0o700 && parent.uid === process.getuid(), 'UNIX_SOCKET_NOT_PRIVATE')
}

// Read only process identities needed for the two exact browser profiles. Neither
// argv, runtime paths nor PIDs are diagnostic output. The services own termination.
async function browserProcesses() {
  const names = (await readdir('/proc')).filter(name => /^\d+$/.test(name))
  const rows = []
  for (let offset = 0; offset < names.length; offset += 32) await Promise.all(names.slice(offset, offset + 32).map(async name => {
    try {
      const raw = await readFile(`/proc/${name}/stat`, 'utf8')
      const [state, parent, group] = raw.slice(raw.lastIndexOf(')') + 2).split(' ')
      if (state === 'Z' || state === 'X' || (await stat(`/proc/${name}`)).uid !== process.getuid()) return
      const argv = (await readFile(`/proc/${name}/cmdline`, 'utf8')).split('\0')
      rows.push({ pid: Number(name), parent: Number(parent), group: Number(group), argv })
    } catch (error) {
      if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) throw error
    }
  }))
  return rows
}

const profileArg = '--user-data-dir='
const hasExactProfile = (row, profile) => row.argv.includes(`${profileArg}${profile}`) ||
  row.argv.some(arg => arg.startsWith(`--database=${profile}/`))

async function workerProcess() {
  const rows = (await browserProcesses()).filter(row => row.parent === process.pid && row.group === row.pid)
  const owned = rows.flatMap(({ pid, group, argv }) => argv.filter(arg => /^--user-data-dir=\/tmp\/deva-browser-[a-z\d]{6}$/i.test(arg))
    .map(arg => ({ pid, group, profile: arg.slice(profileArg.length) })))
  check(owned.length === 1, 'WORKER_PROCESS_IDENTITY_MISMATCH')
  return owned[0]
}

async function verifyUiSandbox(profile) {
  const rows = await browserProcesses()
  const candidates = rows.filter(row => row.argv.includes(`${profileArg}${profile}`) &&
    row.argv.includes('--remote-debugging-pipe') && !row.argv.some(arg => arg.startsWith('--type=')))
  check(candidates.length === 1, 'UI_CHROME_PROCESS_IDENTITY_MISMATCH')
  const chrome = candidates[0]
  const driver = rows.find(row => row.pid === chrome.parent && row.parent === process.pid && row.argv.includes('--port=0'))
  check(driver, 'CHROMEDRIVER_PROCESS_IDENTITY_MISMATCH')
  const field = (raw, key) => raw.split('\n').find(line => line.startsWith(`${key}:`))?.split(/\s+/).slice(1) ?? []
  const status = pid => readFile(`/proc/${pid}/status`, 'utf8').catch(() => '')
  const parent = await status(chrome.pid)
  check(field(parent, 'NSpid').length > 0, 'UI_CHROME_PROCESS_IDENTITY_MISMATCH')
  await until(async () => {
    for (const row of await browserProcesses()) {
      if (row.group !== chrome.group || !row.argv.includes('--type=renderer')) continue
      const child = await status(row.pid)
      if (field(child, 'NSpid').length > field(parent, 'NSpid').length && field(child, 'Seccomp')[0] === '2' &&
          field(child, 'NoNewPrivs')[0] === '1' && Number(field(child, 'Seccomp_filters')[0]) > Number(field(parent, 'Seccomp_filters')[0])) return true
    }
    return false
  }, 'UI_CHROMIUM_SANDBOX_REQUIRED', 5_000)
  return { profile, group: driver.group }
}

async function pathAbsent(path) {
  return lstat(path).then(() => false, error => { if (error.code === 'ENOENT') return true; throw error })
}
async function processGone(identity, extraHome) {
  if (!identity) return true
  return !(await browserProcesses()).some(row => row.group === identity.group || hasExactProfile(row, identity.profile) ||
    (extraHome && row.argv.some(arg => arg.startsWith(`--database=${extraHome}/`))))
}
async function workerGone(identity) {
  return await processGone(identity) && await pathAbsent(identity.profile)
}

function ui(browser) {
  const element = (selector, code, timeout) => until(() => browser.execute(`
    const e = document.querySelector(arguments[0]);
    return e && !e.matches(':disabled') && e.getClientRects().length && getComputedStyle(e).visibility === 'visible' ? e : null;
  `, selector), code, timeout)
  return {
    element,
    click: async (selector, code, timeout) => browser.click(await element(selector, code, timeout)),
    status: (allowed, timeout) => until(() => browser.execute(`
      const status = document.querySelector(arguments[0])?.dataset.status;
      return arguments[1].includes(status) ? status : null;
    `, panel('status'), allowed), 'PANEL_STATE_MISMATCH', timeout),
    absent: (selector, code) => until(() => browser.execute('return !document.querySelector(arguments[0]);', selector), code),
  }
}

// Observe narrow same-origin JSON metadata, or make a deliberately denied POST.
// Only booleans, opaque chat/tab IDs, enum values and HTTP status cross WebDriver.
// Valid CSRF for a negative guard is read inside the page and never returned.
function observe(browser, mode, path, body) {
  return browser.executeAsync(`
    const [mode, path, body, done] = arguments;
    (async () => {
      const options = { mode:'same-origin', credentials:'same-origin', cache:'no-store', redirect:'error', referrerPolicy:'same-origin' };
      if (mode === 'csrf-deny' || mode === 'tab-deny') {
        const headers = { 'content-type':'application/json' };
        if (mode === 'tab-deny') {
          const boot = await fetch('/api/v1/bootstrap', options);
          if (!boot.ok) return 0;
          headers['x-deva-csrf'] = (await boot.json()).csrf;
        }
        const res = await fetch(path, { ...options, method:'POST', headers, body:JSON.stringify(body) });
        if (res.body) await res.body.cancel();
        return res.status;
      }
      const res = await fetch(path, options);
      if (mode === 'status') { if (res.body) await res.body.cancel(); return res.status; }
      if (!res.ok) return null;
      const value = await res.json();
      const sid = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
      if (mode === 'sessions') {
        return Array.isArray(value.sessions) && value.sessions.every(s => sid(s.id)) ? value.sessions.map(s => s.id) : null;
      }
      if (mode === 'tabs') {
        return Array.isArray(value.tabs) && value.tabs.every(t => sid(t.sessionId) && /^[A-Za-z0-9_-]{24}$/.test(t.tabId) &&
          ['open','leased','returned'].includes(t.state)) ? value.tabs.map(({sessionId,tabId,state}) => ({sessionId,tabId,state})) : null;
      }
      if (mode === 'idle') return Array.isArray(value.state?.messages) && value.state.messages.length === 0 &&
        value.state.active === null && value.state.lastTurn === null;
      return false;
    })().then(done, () => done(null));
  `, mode, path, body ?? null)
}

async function authenticate(browser, screen, passwordValue, kind) {
  await browser.keys(await screen.element(password(kind), 'AUTH_PASSWORD_FORM_MISSING'), passwordValue)
  await screen.click('.wb-auth button[type="submit"]', 'AUTH_SUBMIT_MISSING')
  await screen.element(hook('chat'), 'AUTHENTICATED_CHAT_MISSING')
  check(await observe(browser, 'status', `${api}/bootstrap`) === 200, 'AUTHENTICATED_BOOTSTRAP_MISSING')
}

async function logout(browser, screen) {
  await screen.click(hook('settings'), 'SETTINGS_BUTTON_MISSING')
  await screen.click('.wb-chat__logout', 'LOGOUT_BUTTON_MISSING')
  await screen.element(password('current'), 'LOGIN_SCREEN_MISSING')
  await screen.absent(hook('chat'), 'LOGOUT_CHAT_STILL_VISIBLE')
  check(await observe(browser, 'status', `${api}/browser/status`) === 401, 'BROWSER_STATUS_AUTH_GUARD_MISSING')
}

async function newChat(browser, screen) {
  const previous = await observe(browser, 'sessions', `${api}/chats`)
  check(previous, 'CHAT_LIST_MISSING')
  await screen.click(hook('new-chat'), 'NEW_CHAT_BUTTON_MISSING')
  const sid = await until(async () => {
    const ids = await observe(browser, 'sessions', `${api}/chats`)
    const added = ids?.filter(id => !previous.includes(id))
    return added?.length === 1 ? added[0] : null
  }, 'NEW_CHAT_NOT_PERSISTED')
  // A persisted session can arrive at the server before React has selected the new chat.
  await until(() => browser.execute(`
    const [create, count] = arguments;
    return document.querySelector(create)?.disabled === false &&
      document.querySelectorAll('.wb-chat .cf-thread').length === count &&
      !!document.querySelector('.wb-chat .cf-thread.is-active');
  `, hook('new-chat'), previous.length + 1), 'NEW_CHAT_NOT_SELECTED')
  return sid
}

async function openPanel(screen) {
  await screen.click(panel('open'), 'PANEL_OPEN_BUTTON_MISSING')
  await screen.element(`${panel('dialog')}[open]`, 'PANEL_DIALOG_MISSING')
}

async function dismissPanel(screen) {
  await screen.click(panel('dismiss'), 'PANEL_DISMISS_BUTTON_MISSING')
  await screen.absent(panel('dialog'), 'PANEL_STILL_VISIBLE')
}

async function tabIn(browser, sid, state) {
  const tabs = await observe(browser, 'tabs', browserScope(sid))
  check(tabs?.length === 1 && tabs[0].sessionId === sid && tabs[0].state === state, 'TAB_SCOPE_OR_STATE_MISMATCH')
  return tabs[0].tabId
}

async function emptyScope(browser, sid) {
  check((await observe(browser, 'tabs', browserScope(sid)))?.length === 0, 'TAB_LEAKED_TO_CHAT_SCOPE')
}

async function openSite(browser, screen, fixture, sid) {
  await screen.status(['ready'])
  const oldDocs = fixture.documents.length
  const option = `option[value="${siteId}"]`
  const selector = await screen.element(panel('site'), 'SITE_SELECTOR_MISSING')
  const actualOption = await until(() => browser.execute(`
    const [select, option, label, origin] = arguments;
    const entry = select.querySelector(option);
    return select.tagName === 'SELECT' && [...select.options].filter(o => o.value).length === 1 &&
      entry?.textContent.includes(label) && entry.textContent.includes(origin) ? entry : null;
  `, selector, option, siteLabel, fixture.origin), 'REGISTERED_SITE_MISSING')
  await browser.click(actualOption)
  await screen.click(panel('open-site'), 'REGISTERED_SITE_OPEN_MISSING')
  await screen.status(['open'], 30_000)
  await screen.absent(panel('frame'), 'FRAME_BEFORE_CLAIM')
  check(fixture.documents.length === oldDocs + 1, fixture.failure ?? 'EXPECTED_ONE_FIXTURE_DOCUMENT')
  return { tabId: await tabIn(browser, sid, 'open'), nonce: fixture.documents[oldDocs] }
}

function visibleFrame(browser, fixture, nonce, phase) {
  return until(async () => {
    check(!fixture.failure, fixture.failure)
    return browser.execute(`
      const [selector, dialogSelector, {width,height}, samples] = arguments;
      const dialog = document.querySelector(dialogSelector), img = dialog?.querySelector(selector);
      if (!dialog?.open || dialog.querySelector('iframe,embed,object') || !document.hasFocus() ||
          !(img instanceof HTMLImageElement) || !img.complete || !img.currentSrc.startsWith('blob:') ||
          img.naturalWidth !== width || img.naturalHeight !== height || !img.getClientRects().length) return null;
      const box = img.getBoundingClientRect();
      if (document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) !== img) return null;
      const canvas = document.createElement('canvas'); canvas.width = samples.length; canvas.height = 1;
      const ctx = canvas.getContext('2d', {willReadFrequently:true});
      samples.forEach(([x,y], i) => ctx.drawImage(img,x,y,1,1,i,0,1,1));
      const observed = ctx.getImageData(0,0,samples.length,1).data;
      return samples.every(([, , rgb], i) => rgb.every((channel, j) => Math.abs(observed[i*4+j]-channel) <= 2)) ? img : null;
    `, panel('frame'), panel('dialog'), viewport, frameSamples(nonce, phase))
  }, 'EXPECTED_LIVE_PNG_NOT_DISPLAYED')
}

async function claim(screen, browser, fixture, nonce, phase) {
  await screen.click(panel('claim'), 'CLAIM_BUTTON_MISSING')
  await screen.status(['controlling'])
  return visibleFrame(browser, fixture, nonce, phase)
}

async function finish(screen) {
  await screen.click(panel('complete'), 'FINISH_BUTTON_MISSING')
  await screen.status(['done'])
  await screen.absent(panel('frame'), 'FRAME_AFTER_FINISH')
}

async function closeSite(browser, screen, sid, tabId) {
  await screen.click(panel('close'), 'CLOSE_TAB_BUTTON_MISSING')
  await screen.status(['ready'])
  await screen.absent(panel('frame'), 'FRAME_AFTER_CLOSE')
  await emptyScope(browser, sid)
  check(await observe(browser, 'tab-deny', `${browserScope(sid)}/${tabId}/close`, {}) === 403, 'CLOSED_TAB_STILL_AUTHORIZED')
}

async function verifyManual({ browser, screen, fixture, sid, own, release }) {
  step('ui.csrf')
  check(await observe(browser, 'csrf-deny', `${browserScope(sid)}/open`, { siteId }) === 401, 'BROWSER_OPEN_CSRF_GUARD_MISSING')
  check(fixture.documents.length === 0, 'DENIED_OPEN_REACHED_TARGET')
  step('ui.site.open')
  await openPanel(screen)
  const { tabId, nonce } = await openSite(browser, screen, fixture, sid)
  const target = await own()
  step('ui.lease.claim')
  let frame = await claim(screen, browser, fixture, nonce, 'ready')
  check(await tabIn(browser, sid, 'leased') === tabId, 'LEASE_TARGET_CHANGED')
  const invalidProof = 'A'.repeat(43)
  check(await observe(browser, 'tab-deny', `${browserScope(sid)}/${tabId}/frame`, {
    viewerNonce: invalidProof, token: invalidProof
  }) === 403, 'FRAME_WITHOUT_LEASE_PROOF')
  step('ui.form.focus')
  // W3C element click performs a trusted pointer click at the visible image centre;
  // the fixture first places its real name input, then the enabled Confirm there.
  await browser.click(frame)
  await visibleFrame(browser, fixture, nonce, 'focused')
  step('ui.form.text')
  await browser.keys(await screen.element(panel('text'), 'MANUAL_TEXT_FIELD_MISSING'), fixture.name)
  await screen.click(panel('send-text'), 'SEND_TEXT_BUTTON_MISSING')
  frame = await visibleFrame(browser, fixture, nonce, 'typed')
  check(await browser.execute('return document.querySelector(arguments[0])?.value === "";', panel('text')), 'MANUAL_TEXT_NOT_CLEARED')
  step('ui.form.confirm')
  await browser.click(frame)
  await visibleFrame(browser, fixture, nonce, 'done')
  check(fixture.confirmed(nonce), 'TARGET_CONFIRMATION_MISSING')
  step('ui.lease.finish')
  await finish(screen)
  check(await tabIn(browser, sid, 'returned') === tabId, 'FINISH_TARGET_CHANGED')
  step('ui.lease.reclaim')
  await claim(screen, browser, fixture, nonce, 'done')
  check(await tabIn(browser, sid, 'leased') === tabId && fixture.documents.length === 1 &&
    (await workerProcess()).pid === target.pid, 'RECLAIM_REPLACED_TARGET')
  step('ui.tab.close')
  await closeSite(browser, screen, sid, tabId)
  await release(target)
}

async function verifyExpiry({ browser, screen, fixture, sid, own, release }) {
  step('isolation.lease.expiry')
  const { tabId, nonce } = await openSite(browser, screen, fixture, sid)
  const target = await own()
  const started = performance.now()
  await claim(screen, browser, fixture, nonce, 'ready')
  // The real handoff has a 60 s deadline. No fake timers or private test hooks.
  // Browser expiry may send Skip just before the remote deadline or lose that race.
  await screen.status(['expired', 'finish-unconfirmed'], 72_000)
  check(performance.now() - started >= 55_000, 'LEASE_END_PRECEDED_EXPIRY')
  await screen.absent(panel('frame'), 'FRAME_AFTER_EXPIRY')
  await dismissPanel(screen)
  await openPanel(screen)
  const status = await screen.status(['ready', 'returned'])
  if (status === 'returned') {
    check(await tabIn(browser, sid, 'returned') === tabId, 'EXPIRY_REPLACED_TARGET')
    await closeSite(browser, screen, sid, tabId)
  } else await emptyScope(browser, sid)
  await release(target)
}

async function verifyLogout({ browser, screen, fixture, sid, own, release, passwordValue }) {
  step('isolation.chat')
  const { tabId, nonce } = await openSite(browser, screen, fixture, sid)
  const target = await own()
  await claim(screen, browser, fixture, nonce, 'ready')
  await dismissPanel(screen)
  const other = await newChat(browser, screen)
  await openPanel(screen)
  await screen.status(['ready'])
  await screen.absent(panel('frame'), 'OLD_FRAME_IN_OTHER_CHAT')
  await emptyScope(browser, other)
  check(await observe(browser, 'tab-deny', `${browserScope(other)}/${tabId}/close`, {}) === 403, 'CROSS_CHAT_TAB_ACCESS')
  await dismissPanel(screen)
  await until(async () => (await observe(browser, 'tabs', browserScope(sid)))?.[0]?.state === 'returned', 'DISMISS_LEASE_NOT_RELEASED')
  step('isolation.logout')
  await logout(browser, screen)
  check(await observe(browser, 'status', browserScope(sid)) === 401, 'LOGOUT_TAB_LIST_STILL_AUTHORIZED')
  await release(target)
  await authenticate(browser, screen, passwordValue, 'current')
  await emptyScope(browser, sid)
  check(await observe(browser, 'tab-deny', `${browserScope(sid)}/${tabId}/close`, {}) === 403, 'NEW_LOGIN_REATTACHED_OLD_TAB')
  step('isolation.no-model-or-tool-turn')
  for (const chat of [sid, other]) {
    check(await observe(browser, 'idle', `${api}/chats/${chat}`) === true, 'MANUAL_BROWSER_CREATED_CHAT_ACTIVITY')
  }
  check(!fixture.failure && fixture.documents.length === 3, fixture.failure ?? 'FIXTURE_DOCUMENT_COUNT_MISMATCH')
  await logout(browser, screen)
}

async function run() {
  const cleanup = []
  const interrupted = () => stop.abort()
  process.once('SIGINT', interrupted)
  process.once('SIGTERM', interrupted)
  let failed = false
  try {
    const { driver, chrome, chromium } = await preflight()
    const { startWorkbench } = await import('../../apps/headless/src/server.mjs')
    const { startEgress, parseSites } = await import('../../apps/browser-worker/src/egress/index.mjs')
    const { startWorker } = await import('../../apps/browser-worker/src/worker.mjs')
    const { openWorkerClient } = await import('../../apps/browser-worker/src/client.mjs')
    step('start.private-runtime')
    const parent = await realpath('/tmp')
    const prefix = 'deva-wb-manual-'
    const root = await mkdtemp(join(parent, prefix))
    const identity = await lstat(root)
    const assertRoot = async () => {
      const current = await lstat(root)
      check(dirname(root) === parent && basename(root).startsWith(prefix) && basename(root).length === prefix.length + 6 &&
        current.isDirectory() && current.uid === process.getuid() && (current.mode & 0o7777) === 0o700 &&
        current.dev === identity.dev && current.ino === identity.ino && await realpath(root) === root, 'TEMP_ROOT_IDENTITY_MISMATCH')
    }
    await assertRoot()
    cleanup.push(['temp', async () => {
      await assertRoot()
      await rm(root, { recursive: true, force: false })
      check(await pathAbsent(root), 'TEMP_ROOT_SURVIVED_CLEANUP')
    }])
    const [egressDir, workerDir, runDir, dataDir, profile, keyFile] = ['egress', 'worker', 'run', 'data', 'ui-chrome', 'vault-key']
      .map(name => join(root, name))
    await initializeMasterKey(keyFile)
    step('start.fixture-egress')
    const fixture = await startManualFixture()
    cleanup.push(['fixture', fixture.close])
    const sites = parseSites([{ id: siteId, label: siteLabel, url: fixture.origin + formPath }])
    // The broker pins an existing private directory; unlike the worker it never creates one.
    await mkdir(egressDir, { mode: 0o700 })
    const egress = await startEgress({ runDir: egressDir, sites, privateOrigins: [fixture.origin] })
    cleanup.push(['egress', async () => { await egress.close(); check(await pathAbsent(egress.socketPath), 'EGRESS_SOCKET_SURVIVED') }])
    await privateSocket(egress.socketPath, egressDir, 'egress.sock')
    step('start.worker-sandbox')
    const worker = await startWorker({ runDir: workerDir, egressSocket: egress.socketPath, sites, executablePath: chromium,
      maxSessions: 1, maxConcurrentOpens: 1 })
    const owned = new Set()
    const own = async () => { const identity = await workerProcess(); owned.add(identity); return identity }
    const release = async target => {
      await until(() => workerGone(target), 'EXACT_WORKER_CHROMIUM_SURVIVED_CLOSE', 8_000)
      owned.delete(target)
    }
    cleanup.push(['worker', async () => {
      await worker.close()
      check(await pathAbsent(worker.path), 'WORKER_SOCKET_SURVIVED')
      for (const target of owned) check(await workerGone(target), 'WORKER_CHROMIUM_SURVIVED_CLEANUP')
    }])
    await privateSocket(worker.path, workerDir, 'worker.sock')
    const { state } = await openWorkerClient({ runDir: workerDir }).status()
    const workerError = { 'binary-missing': 'CHROMIUM_PATH_MISSING', 'sandbox-startup-failure': 'WORKER_CHROMIUM_SANDBOX_REQUIRED',
      'egress-unavailable': 'EGRESS_UNAVAILABLE', unconfigured: 'WORKER_UNCONFIGURED' }
    check(state === 'ready', workerError[state] ?? 'WORKER_NOT_READY')
    check(fixture.documents.length === 0 && !fixture.failure, fixture.failure ?? 'SANDBOX_PROBE_CONTACTED_FIXTURE')
    step('start.workbench')
    const workbench = await startWorkbench({ dataDir, keyFile, runDir, host: '127.0.0.1', port: 0,
      businessOptions: { browserRunDir: workerDir } })
    cleanup.push(['workbench', async () => {
      await workbench.close()
      check(await pathAbsent(workbench.controlPath), 'WORKBENCH_SOCKET_SURVIVED')
    }])
    await privateSocket(workbench.controlPath, runDir, 'workbench-control.sock')
    check(workbench.origin === `http://127.0.0.1:${workbench.address.port}` && await readiness(workbench.address.port) === 200,
      'WORKBENCH_NOT_READY')
    step('start.webdriver-sandbox')
    process.env.CHROME_BIN = chrome
    process.env.CHROMEDRIVER_BIN = driver
    let uiProcess, browser
    cleanup.push(['webdriver', async () => {
      try { await browser?.close() } finally {
        // Also check exact profile helpers when Chrome was lost before sandbox verification.
        await waitFor(() => processGone(uiProcess ?? { profile }, root), 'WEBDRIVER_CHROME_SURVIVED_CLEANUP', { timeout: 4_000 })
          .catch(() => { throw new Failure('WEBDRIVER_CHROME_SURVIVED_CLEANUP') })
      }
    }])
    browser = await startLocalWebDriver({ root, profile, origin: workbench.origin, signal: stop.signal })
    const screen = ui(browser)
    const passwordValue = `deva-e2e-${randomBytes(18).toString('hex')}`
    step('ui.auth.claim-owner')
    const { credential } = await requestControl({ runDir, op: 'claim' })
    await browser.navigate(`${workbench.origin}/#claim=${encodeURIComponent(credential)}`)
    uiProcess = await verifyUiSandbox(profile)
    await screen.element(password('new'), 'CLAIM_FORM_MISSING')
    check(await browser.execute('return location.hash === "";'), 'CLAIM_FRAGMENT_NOT_CLEARED')
    await authenticate(browser, screen, passwordValue, 'new')
    check((await requestControl({ runDir, op: 'status' })).claimed === true, 'OWNER_CLAIM_NOT_PERSISTED')
    step('ui.auth.login')
    await logout(browser, screen)
    await authenticate(browser, screen, passwordValue, 'current')
    step('ui.chat.create')
    const sid = await newChat(browser, screen)
    await emptyScope(browser, sid)
    const context = { browser, screen, fixture, sid, own, release, passwordValue }
    await verifyManual(context)
    await verifyExpiry(context)
    await verifyLogout(context)
  } catch (error) {
    failed = true
    // The helper itself sanitizes operation names, but only emit fixed details here.
    const detail = stop.signal.aborted ? 'INTERRUPTED' : error instanceof Failure ? error.message :
      error instanceof WebDriverError ? (/^[A-Z_]+$/.test(error.detail) ? error.detail :
        error.detail === 'session not created' ? 'WEBDRIVER_SANDBOX_OR_BINARY_MISMATCH' : 'WEBDRIVER_COMMAND_FAILED') : 'UNEXPECTED_FAILURE'
    console.error(`manual-browser-e2e FAIL ${stage} ${detail}`)
  } finally {
    for (const [name, close] of cleanup.reverse()) {
      try { await close() } catch (error) {
        failed = true
        console.error(`manual-browser-e2e FAIL cleanup.${name} ${error instanceof Failure ? error.message : 'CLEANUP_FAILED'}`)
      }
    }
    process.removeListener('SIGINT', interrupted)
    process.removeListener('SIGTERM', interrupted)
  }
  if (failed || stop.signal.aborted) process.exitCode = 1
  else console.log('manual-browser-e2e PASS login, CSRF, Unix worker/egress, live PNG form, same-page reclaim, expiry, logout, idle chat')
}

await run()
