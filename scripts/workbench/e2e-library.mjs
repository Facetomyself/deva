import { randomBytes } from 'node:crypto'
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { requestControl } from '../../apps/headless/src/control/socket.mjs'
import { DEFAULT_WEB_DIR, startWorkbench } from '../../apps/headless/src/server.mjs'
import { initializeMasterKey } from '../../apps/headless/src/storage/vault.mjs'
import { startLocalWebDriver, waitFor, WebDriverError } from './webdriver-local.mjs'

const hook = name => `[data-testid="workbench-${name}"]`
const panelTag = scope => `${hook(scope)} button.cf-me__tag`
const chat = hook('chat')
const roleRow = `${hook('roster-panel')} ${hook('role-row')}`
const roleName = 'Library proofreader'
const initialRoleName = 'Library reviewer'
const projectName = 'Library Alpha'
const otherProject = 'Library Beta'
const names = { initial: 'Reading preference', global: 'Updated reading preference', role: 'Editing preference', project: 'Project glossary' }
const bodies = { initial: 'Prefer short chapters.', global: 'Prefer short chapters and an index.', role: 'Use sentence case for headings.', project: 'Use the term proof copy.' }
const ink = [[39, 101, 187], [215, 157, 46]]

class CheckFailure extends Error {}
function check(condition, message) {
  if (!condition) throw new CheckFailure(message)
}

function ready(port, signal) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: '/readyz', agent: false,
      signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) }, res => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.once('error', reject)
    req.end()
  })
}

// Generate a tiny opaque RGB PNG without a downloaded fixture or a user's image.
function avatarPng() {
  const chunk = (kind, content) => {
    const length = Buffer.alloc(4), type = Buffer.from(kind), checksum = Buffer.alloc(4)
    length.writeUInt32BE(content.length)
    checksum.writeUInt32BE(crc32(Buffer.concat([type, content])))
    return Buffer.concat([length, type, content, checksum])
  }
  const side = 16
  const header = Buffer.alloc(13)
  header.writeUInt32BE(side, 0); header.writeUInt32BE(side, 4)
  header[8] = 8; header[9] = 2
  const rowBytes = 1 + 3 * side // leading PNG filter byte, followed by RGB triples
  const pixels = Buffer.alloc(side * rowBytes)
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) pixels.set(ink[Number(x >= side / 2)], y * rowBytes + 1 + 3 * x)
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}

// Observations return predicates or W3C element references. They never return page URLs,
// form values, cookies, CSRF, storage details, screenshots, or avatar bytes.
function controls(browser, signal, readOnlyNavigation = false) {
  // The restored panel can replace a DOM node between a W3C element lookup and click.
  // Re-resolve a stale reference once in the readback phase ONLY. Never replay writes or a chat launch.
  async function clickResolved(lookup) {
    try { await browser.click(await lookup()) }
    catch (error) {
      if (!readOnlyNavigation || !(error instanceof WebDriverError) || error.detail !== 'stale element reference') throw error
      await browser.click(await lookup())
    }
  }
  const until = (predicate, description) => waitFor(predicate, description, { signal })
  const element = (selector, description, text = null, child = null, hidden = false) => until(async () => {
    const result = await browser.execute(`
      const [selector, text, child, hidden] = arguments;
      const visible = node => node.getClientRects().length && getComputedStyle(node).visibility === 'visible';
      if ([...document.querySelectorAll('.wb-error[role="alert"], .wb-library__issue[role="alert"], #root > [role="alert"]')].some(visible)) return false;
      return [...document.querySelectorAll(selector)].find(node => (hidden || visible(node)) && !node.matches(':disabled') &&
        (text === null || (child ? node.querySelector(child) : node)?.textContent.trim() === text)) ?? null;
    `, selector, text, child, hidden)
    check(result !== false, 'Workbench showed an error alert')
    return result
  }, description)
  return {
    element, until,
    click: (...args) => clickResolved(() => element(...args)),
    gone: (selector, description) => until(() => browser.execute('return !document.querySelector(arguments[0]);', selector), description),
    async fill(selector, value, replace = false) {
      const field = await element(selector, 'editable form field')
      await browser.keys(field, replace ? `\uE009a\uE000${value}` : value)
    },
    async choose(selector, name) {
      await clickResolved(() => until(() => browser.execute(`
        const select = document.querySelector(arguments[0]);
        return select && !select.disabled && select.getClientRects().length ? [...select.options].find(node => !node.disabled && node.textContent.trim() === arguments[1]) ?? null : null;
      `, selector, name), 'catalogued workspace option'))
      await until(() => browser.execute('return document.querySelector(arguments[0])?.selectedOptions[0]?.textContent.trim() === arguments[1];', selector, name),
        'selected workspace option')
    }
  }
}

// The real owner session cookie stays in Chrome. Read-only checks act as a second observation
// of server state after UI actions; the script never copies auth material or writes via REST.
function authenticatedChecks(browser) {
  return {
    verify: (kind, expected) => browser.executeAsync(`
      const [kind, expected] = arguments;
      const done = arguments[arguments.length - 1];
      const get = path => fetch('/api/v1/' + path, { credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
      (async () => {
        if (kind === 'profile-status') return (await get('profile')).status === expected;
        if (kind !== 'binding') return false;
        const [roles, chats] = await Promise.all([get('personas'), get('chats')]);
        if (!roles.ok || !chats.ok) return false;
        const role = (await roles.json()).roles.find(row => row.name === expected.role);
        const sessions = (await chats.json()).sessions;
        if (!role?.enabled || role.protected || role.workspaceName !== expected.workspace || sessions.length !== 1) return false;
        const [session] = sessions;
        if (session.personaId !== role.id || session.compatibility !== 'text' || !session.writable) return false;
        const detail = await get('chats/' + encodeURIComponent(session.id));
        if (!detail.ok) return false;
        const { state } = await detail.json();
        return state?.personaId === role.id && Array.isArray(state.messages) && state.messages.length === 0;
      })().then(done, () => done(false));
    `, kind, expected)
  }
}

const passwordField = mode => `.wb-auth input[name="password"][type="password"][autocomplete="${mode}-password"]`
async function submitPassword(ui, mode, value) {
  await ui.fill(passwordField(mode), value)
  await ui.click('.wb-auth button[type="submit"]', 'submit Workbench authentication form')
  await ui.element(chat, 'authenticated Workbench chat')
}

async function claimAccount(browser, ui, http, { origin, runDir, passwordValue, signal }) {
  const { credential } = await requestControl({ runDir, op: 'claim' })
  // Only the local WebDriver command receives this one-use claim URL.
  await browser.navigate(`${origin}/#claim=${encodeURIComponent(credential)}`)
  await waitFor(() => browser.execute(`
    if (!performance.getEntriesByType('navigation')[0]?.domContentLoadedEventStart) return null;
    return { cleared: location.origin === arguments[0] && location.pathname === '/' && !location.search && !location.hash };
  `, origin), 'initial claim page DOMContentLoaded', { timeout: 4_000, interval: 20, signal }).then(result => {
    check(result.cleared, 'Claim fragment survived the initial page load')
  })
  await ui.element(passwordField('new'), 'claim password field')
  check(await http.verify('profile-status', 401), 'Library endpoint was readable before claiming')
  check(await browser.execute('return !document.querySelector(".wb-auth input[name=credential]");'), 'Claim handoff left a credential field')
  await submitPassword(ui, 'new', passwordValue)
  check((await requestControl({ runDir, op: 'status' })).claimed, 'Unix control did not report a claimed owner')
  check(await http.verify('profile-status', 200), 'Authenticated owner could not read Library state')
}

async function loginAgain(ui, http, passwordValue) {
  await ui.click(hook('settings'), 'open settings for sign out')
  await ui.click('.wb-chat__logout', 'sign out via the Workbench UI')
  await ui.element(passwordField('current'), 'owner login form after sign out')
  check(await http.verify('profile-status', 401), 'Signed-out browser retained Library access')
  await submitPassword(ui, 'current', passwordValue)
  check(await http.verify('profile-status', 200), 'Password login did not restore Library access')
}

async function expectTags(browser, ui, scope, title) {
  // The Add button is gated on the current scope's completed read, so empty checks cannot
  // accidentally pass on an editor that has yet to load the new scope.
  await ui.element(`${hook(scope)} ${hook('memory-add')}`, 'loaded memory scope')
  await ui.until(() => browser.execute(`
    const [selector, expected] = arguments;
    const found = [...document.querySelectorAll(selector)];
    return expected === null ? found.length === 0 : found.length === 1 && found[0].textContent.trim() === expected;
  `, panelTag(scope), title), 'exact memory entries for the open scope')
}

async function addMemory(ui, scope, title, body) {
  await ui.click(`${hook(scope)} ${hook('memory-add')}`, 'add a memory in the selected scope')
  await ui.fill(hook('memory-title'), title)
  await ui.fill(hook('memory-body'), body)
  await ui.click(hook('memory-save'), 'save the new memory via the editor')
  await ui.gone(hook('memory-editor'), 'memory editor closed after save')
}

async function readMemory(browser, ui, scope, title, body) {
  await expectTags(browser, ui, scope, title)
  await ui.click(panelTag(scope), 'open the saved memory', title)
  const field = await ui.element(hook('memory-body'), 'visible memory body')
  check(await browser.execute('return arguments[0].value === arguments[1];', field, body), 'Saved memory body differed')
}

async function verifyGlobalMemory(browser, ui) {
  await ui.click(hook('profile'), 'open the personal profile')
  await expectTags(browser, ui, 'profile-panel', null)
  await addMemory(ui, 'profile-panel', names.initial, bodies.initial)
  await readMemory(browser, ui, 'profile-panel', names.initial, bodies.initial)
  await ui.fill(hook('memory-title'), names.global, true)
  await ui.fill(hook('memory-body'), bodies.global, true)
  await ui.click(hook('memory-save'), 'save an edit to the global memory')
  await expectTags(browser, ui, 'profile-panel', names.global)
  await ui.click(hook('profile-close'), 'close the personal profile')
  await ui.gone(hook('profile-panel'), 'personal profile closed')
  await ui.click(hook('profile'), 'reopen the personal profile')
  await readMemory(browser, ui, 'profile-panel', names.global, bodies.global)
  await ui.click(hook('profile-close'), 'return from global memory to the profile')
}

function expectAvatar(browser, ui, selector) {
  return ui.until(() => browser.executeAsync(`
    const [selector, colors] = arguments;
    const done = arguments[arguments.length - 1];
    const node = document.querySelector(selector);
    if (!node?.getClientRects().length) return done(false);
    const src = node.getAttribute('href');
    if (!src?.startsWith('data:image/')) return done(false);
    const img = new Image();
    img.src = src;
    img.decode().then(() => {
      if (img.naturalWidth !== 256 || img.naturalHeight !== 256) return done(false);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      done(colors.every((rgb, i) => {
        const rgba = ctx.getImageData(i ? 192 : 64, 128, 1, 1).data;
        return rgba[3] === 255 && rgb.every((v, j) => Math.abs(rgba[j] - v) < 12);
      }));
    }).catch(() => done(false));
  `, selector, ink), 'visible avatar with the normalized fixture image')
}

const renderedAvatar = `${hook('profile-avatar-edit')} svg.hm-ava image`
async function uploadAvatar(browser, ui, path) {
  check(await browser.execute('return !document.querySelector(arguments[0]);', renderedAvatar), 'The fresh profile already had a custom image')
  await ui.click(hook('profile-avatar-edit'), 'open AvatarEditor')
  const file = await ui.element(hook('profile-avatar-file'), 'AvatarEditor file control', null, null, true)
  // W3C send keys to input[type=file] is the local browser file-selection operation.
  await browser.keys(file, path)
  await expectAvatar(browser, ui, `${hook('profile-panel')} .cf-avaedit__preview svg.hm-ava image`)
  await ui.click(hook('profile-avatar-save'), 'save the avatar through AvatarEditor')
  await expectAvatar(browser, ui, renderedAvatar)
  await ui.click(hook('profile-close'), 'close the profile after saving the avatar')
  await ui.gone(hook('profile-panel'), 'personal profile closed')
  await ui.click(hook('profile'), 'reopen the personal profile after avatar save')
  await expectAvatar(browser, ui, renderedAvatar)
  await ui.click(hook('profile-close'), 'close the reopened profile')
}

async function selectRole(ui, name) {
  await ui.click(roleRow, 'select the custom role', name, '.cf-prow__name')
}

async function createRoleAndMemory(ui, browser) {
  await ui.click(hook('roster'), 'open the role roster')
  await ui.click(hook('role-add'), 'add a custom role')
  await ui.fill(hook('role-name'), initialRoleName)
  await ui.choose(hook('role-workspace'), projectName)
  await ui.click(hook('role-save'), 'save the new custom role')
  await selectRole(ui, initialRoleName)
  await ui.click(hook('role-edit'), 'edit the custom role')
  await ui.fill(hook('role-name'), roleName, true)
  await ui.click(hook('role-save'), 'save the renamed custom role')
  await ui.element(roleRow, 'renamed role row', roleName, '.cf-prow__name')
  await ui.element(hook('role-start'), 'enabled custom role can launch a chat')
  await ui.click(hook('role-enabled'), 'disable the custom role')
  await ui.until(() => browser.execute(`
    const launch = document.querySelector(arguments[0]);
    const toggle = document.querySelector(arguments[1]);
    return launch?.disabled === true && toggle?.disabled === false;
  `, hook('role-start'), hook('role-enabled')), 'disabled role with completed toggle and blocked launch')
  await ui.click(hook('role-enabled'), 'enable the custom role again')
  await ui.element(hook('role-start'), 'reenabled role can launch a chat')
  await ui.click(hook('role-memory'), 'open custom role memory')
  await expectTags(browser, ui, 'roster-panel', null)
  await addMemory(ui, 'roster-panel', names.role, bodies.role)
  await expectTags(browser, ui, 'roster-panel', names.role)
  await ui.click(hook('roster-panel-close'), 'close the role roster')
}

async function openProjectMemory(ui) {
  await ui.click(hook('profile'), 'open personal profile for project memory')
  await ui.click(hook('project-open'), 'open the project memory panel')
  await ui.choose(hook('project-select'), projectName)
}

async function verifyProjectIsolation(browser, ui) {
  await openProjectMemory(ui)
  await expectTags(browser, ui, 'project-memory', null)
  await addMemory(ui, 'project-memory', names.project, bodies.project)
  await expectTags(browser, ui, 'project-memory', names.project)
  await ui.choose(hook('project-select'), otherProject)
  await expectTags(browser, ui, 'project-memory', null)
  await ui.click(hook('project-memory-close'), 'close project memory')
}

async function verifyPersistence(browser, ui) {
  await ui.click(hook('profile'), 'open the persisted personal profile')
  await expectAvatar(browser, ui, renderedAvatar)
  await readMemory(browser, ui, 'profile-panel', names.global, bodies.global)
  await ui.click(hook('profile-close'), 'return from global memory to the profile')
  await ui.click(hook('profile-close'), 'close the persisted profile')
  await openProjectMemory(ui)
  await readMemory(browser, ui, 'project-memory', names.project, bodies.project)
  await ui.click(hook('project-memory-close'), 'close the persisted project panel')
  await ui.click(hook('roster'), 'open the persisted role roster')
  await selectRole(ui, roleName)
  await ui.element(hook('role-start'), 'persisted custom role is enabled')
  await ui.click(hook('role-memory'), 'open persisted custom role memory')
  await readMemory(browser, ui, 'roster-panel', names.role, bodies.role)
  await ui.click(hook('role-memory'), 'return from role memory to the role card')
}

async function verifyBoundChat(browser, ui, http) {
  const composer = `${chat} .cf-draft__input[role="textbox"][contenteditable="true"]`
  const binding = () => http.verify('binding', { role: roleName, workspace: projectName })
  await ui.click(hook('role-start'), 'start a new text chat as the custom role')
  await ui.gone(hook('roster-panel'), 'role roster closed after launching the conversation')
  await ui.element(hook('chat-persona'), 'custom role identity in the chat header', roleName)
  await ui.element(composer, 'new text conversation composer')
  check(await binding(), 'Server state did not show the selected workspace and the new role-bound text session')
  await browser.refresh()
  await ui.element(hook('chat-persona'), 'role identity in the chat header after refresh', roleName)
  await ui.element(composer, 'persisted text conversation composer after refresh')
  check(await binding(), 'Server state did not retain the role-bound text session after refresh')
}

const stop = new AbortController()
const abort = () => stop.abort()
process.once('SIGINT', abort)
process.once('SIGTERM', abort)
let stage = 'validate environment'
let root, browser, workbench, failed
try {
  check(process.platform === 'linux' && process.getuid?.() > 0 && process.geteuid?.() > 0, 'Run this test on Linux as a non-root user')
  stage = 'check build outputs'
  for (const entry of ['provider', 'chat', 'library']) {
    await access(new URL(`../../apps/headless/dist/${entry}-core.mjs`, import.meta.url)).catch(() => {
      throw new CheckFailure('Build the headless cores with pnpm --filter @deva/headless build')
    })
  }
  await access(join(DEFAULT_WEB_DIR, 'index.html')).catch(() => { throw new CheckFailure('Build the Workbench with pnpm workbench:build') })
  stage = 'start a real local Workbench with an isolated workspace volume'
  const prefix = join(await realpath(tmpdir()), 'deva-wb-library-')
  const created = await mkdtemp(prefix)
  check(created.startsWith(prefix) && created.length > prefix.length && await realpath(created) === created, 'Unexpected temporary directory')
  root = created
  const keyFile = join(root, 'master.key'), runDir = join(root, 'run'), dataDir = join(root, 'data')
  const workspaceRoot = join(root, 'workspaces'), avatarFile = join(root, 'avatar.png')
  const passwordValue = randomBytes(24).toString('hex')
  await mkdir(join(workspaceRoot, projectName), { recursive: true })
  await mkdir(join(workspaceRoot, otherProject))
  await writeFile(avatarFile, avatarPng(), { mode: 0o600, flag: 'wx' })
  await initializeMasterKey(keyFile)
  workbench = await startWorkbench({ dataDir, keyFile, runDir, port: 0, businessOptions: { workspaceRoot } })
  check(await ready(workbench.address.port, stop.signal), 'Workbench readiness check failed')
  stage = 'start sandboxed Chrome through local ChromeDriver'
  browser = await startLocalWebDriver({ root, profile: join(root, 'chrome-profile'), origin: workbench.origin, signal: stop.signal })
  const ui = controls(browser, stop.signal)
  const http = authenticatedChecks(browser)
  stage = 'claim via Unix control and the Workbench password form'
  await claimAccount(browser, ui, http, { origin: workbench.origin, runDir, passwordValue, signal: stop.signal })
  stage = 'create, edit, close and reopen global memory'
  await verifyGlobalMemory(browser, ui)
  stage = 'upload, save and reopen the personal avatar'
  await uploadAvatar(browser, ui, avatarFile)
  stage = 'create, rename and reenable a custom role with a workspace and isolated memory'
  await createRoleAndMemory(ui, browser)
  stage = 'create isolated project memory and check the other project'
  await verifyProjectIsolation(browser, ui)
  stage = 'sign out and log in again through the existing auth UI'
  await loginAgain(ui, http, passwordValue)
  stage = 'check avatar and all three memory scopes in a fresh document'
  await verifyPersistence(browser, controls(browser, stop.signal, true))
  stage = 'start a role-bound text conversation and verify its identity after refresh'
  await verifyBoundChat(browser, ui, http)
} catch (error) {
  failed = true
  const detail = stop.signal.aborted ? 'interrupted' : error instanceof CheckFailure || error instanceof WebDriverError
    ? error.message : 'unexpected error (raw diagnostics withheld)'
  console.error(`Workbench Library browser E2E failed at ${stage}: ${detail}`)
} finally {
  for (const [name, cleanup] of [
    ['browser', () => browser?.close()], ['workbench', () => workbench?.close()],
    ['temporary directory', () => root && rm(root, { recursive: true, force: true })]
  ]) {
    try { await cleanup() } catch {
      failed = true
      console.error(`Workbench Library browser E2E: ${name} cleanup failed`)
    }
  }
  process.removeListener('SIGINT', abort)
  process.removeListener('SIGTERM', abort)
}
if (failed || stop.signal.aborted) process.exitCode = 1
else console.log('Workbench Library browser E2E passed: claim and login, profile avatar, separate global/role/project memories, and persisted role-bound chat.')
