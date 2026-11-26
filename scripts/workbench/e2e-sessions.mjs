import { randomBytes } from 'node:crypto'
import { access, lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requestControl } from '../../apps/headless/src/control/socket.mjs'
import { DEFAULT_WEB_DIR, startWorkbench } from '../../apps/headless/src/server.mjs'
import { initializeMasterKey } from '../../apps/headless/src/storage/vault.mjs'
import { ChatFixtureError, startChatFixture } from './e2e-chat-fixture.mjs'
import { startLocalWebDriver, waitFor, WebDriverError } from './webdriver-local.mjs'

const hook = name => `[data-testid="workbench-${name}"]`
const chat = hook('chat')
const list = `${chat} .cf-list`
const row = `${list} .cf-thread`
const title = '.cf-thread__title'
const header = `${chat} .wb-chat__title`
const action = name => `${hook('session-menu')} ${hook(`session-${name}`)}`
const chip = `${chat} .model-pick button.cf-mp__model`
const modelMenu = `${chat} .model-pick [role="menu"]`
const follow = `${chat} .model-pick ${hook('session-model-default')}`
const draft = `${chat} .cf-draft__input[role="textbox"][contenteditable="true"]`
const send = `${chat} .cf-send:not(.is-stop)`
const untitled = 'New chat'
const anchorName = 'Fixture empty anchor'
const firstText = 'Fixture automatic title from one ordinary message'
const autoTitle = 'Fixture automatic title from o…'
const followLabel = 'Follow default'
const customTitle = 'Session fixture renamed'
const reply = 'Deterministic local reply.'
const providerId = 'e2e-sessions-provider'
const providerName = 'Session fixture provider'
const defaultModel = 'session-fixture-default'
const pinnedModel = 'session-fixture-pinned'
const modelRef = model => `${providerId}:${model}`
const selectAll = '\uE009a\uE000'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

class CheckFailure extends Error {}
function check(value, diagnostic) {
  if (!value) throw new CheckFailure(diagnostic)
}

function uiFor(browser, signal) {
  const until = (probe, diagnostic, timeout) => waitFor(probe, diagnostic, { signal, timeout })
  const element = (selector, diagnostic, text, child) => until(() => browser.execute(`
    const [selector, expected, child] = arguments;
    return [...document.querySelectorAll(selector)].find(node => node.getClientRects().length &&
      getComputedStyle(node).visibility === 'visible' && !node.matches(':disabled, [aria-disabled="true"]') &&
      (expected == null || (child ? node.querySelector(child) : node)?.textContent.trim() === expected)) ?? null;
  `, selector, text ?? null, child ?? null), diagnostic)
  return {
    browser, until, element,
    click: async (...args) => browser.click(await element(...args)),
    selected: () => browser.execute('return sessionStorage.getItem("deva-workbench.chat");'),
    // Require the complete visible list, plus an unchanged observer document and selected anchor
    // when given. Checking the positive anchor also prevents an unloaded/hidden list passing.
    rows: (expected, diagnostic, stable = null, view = 'active') => until(() => browser.execute(`
      const [list, title, expected, stable, view] = arguments;
      if (stable && (performance.timeOrigin !== stable.document ||
          sessionStorage.getItem('deva-workbench.chat') !== stable.anchor)) return false;
      const visible = node => node.getClientRects().length && getComputedStyle(node).visibility === 'visible';
      const rail = document.querySelector(list);
      if (rail?.dataset.sessionView !== view || !visible(rail)) return false;
      const rows = [...rail.querySelectorAll('.cf-thread')].filter(visible);
      if (stable && !rows.some(node => node.matches('.is-active') &&
          node.querySelector(title)?.textContent.trim() === stable.name)) return false;
      const labels = rows.map(node => node.querySelector(title)?.textContent.trim()).sort();
      return labels.length === expected.length && expected.every((label, i) => labels[i] === label);
    `, list, title, [...expected].sort(), stable, view), diagnostic, stable ? 7_000 : undefined),
    gone: (selector, diagnostic) => until(() => browser.execute(`
      return ![...document.querySelectorAll(arguments[0])].some(node => node.getClientRects().length &&
        getComputedStyle(node).visibility === 'visible');
    `, selector), diagnostic)
  }
}

async function submitPassword(ui, mode, value) {
  const input = await ui.element(`.wb-auth input[type="password"][autocomplete="${mode}-password"]`, 'real owner authentication form')
  await ui.browser.keys(input, value)
  await ui.click('.wb-auth button[type="submit"]', 'submit owner authentication')
  await ui.element(chat, 'authenticated Workbench conversation view')
}

// The provider setup is deliberately the only direct write from WebDriver. The existing
// settings E2E covers those controls; all session CRUD and model choices here are real clicks.
async function seedModels(ui, mockOrigin, key) {
  const ok = await ui.browser.executeAsync(`
    const [provider, activeModelId, key, done] = arguments;
    const api = async (path, method = 'GET', body, csrf) => {
      const response = await fetch('/api/v1/' + path, { method, credentials: 'same-origin', mode: 'same-origin',
        redirect: 'error', cache: 'no-store', ...(body === undefined ? {} : { body: JSON.stringify(body),
          headers: { 'content-type': 'application/json', 'x-deva-csrf': csrf } }) });
      return response.ok ? response.json() : null;
    };
    (async () => {
      const bootstrap = await api('bootstrap');
      const settings = await api('settings');
      if (bootstrap?.capabilities?.sessionPreferences !== true || !bootstrap.csrf || !settings?.revision) return false;
      const saved = await api('settings', 'PATCH', { revision: settings.revision, unset: [],
        set: { locale: 'en', models: { providers: [provider], activeModelId, activeEffort: 'default' } } }, bootstrap.csrf);
      if (!saved?.ok || !saved.revision) return false;
      const credential = await api('provider-keys/' + provider.id, 'PUT', { value: key, revision: saved.revision }, bootstrap.csrf);
      return credential?.ok === true && credential.available === true;
    })().then(done, () => done(false));
  `, {
    id: providerId, name: providerName, kind: 'custom', purpose: 'llm', accent: '#345678', adapter: 'openai',
    apiHost: `${mockOrigin}/v1`, enabled: true,
    models: [defaultModel, pinnedModel].map(id => ({ id, name: id, enabled: true }))
  }, modelRef(defaultModel), key)
  check(ok, 'Could not seed the two private loopback models')
  await ui.browser.refresh()
  await ui.element(chat, 'Workbench with saved synthetic model settings')
}

// Readbacks use B's ordinary owner cookie, and return only an opaque revision when the public
// list, preference document, and actual thread agree. They never refresh the app's React state.
function readBack(ui, id, expect, diagnostic, previous = null) {
  return ui.until(() => ui.browser.executeAsync(`
    const [id, expected, previous, done] = arguments;
    const get = async path => {
      const response = await fetch('/api/v1/chats' + path, { credentials: 'same-origin', mode: 'same-origin',
        cache: 'no-store', redirect: 'error' });
      return response.ok ? response.json() : null;
    };
    (async () => {
      const path = '/' + encodeURIComponent(id);
      const [list, document, thread] = await Promise.all([get(''), get(path + '/preferences'), get(path)]);
      const entry = list?.sessions.find(session => session.id === id);
      const { preferences, revision } = document ?? {};
      const state = thread?.state;
      if (!entry || entry.compatibility !== 'text' || entry.personaId != null || !preferences ||
          typeof revision !== 'string' || !/^[0-9a-f]{64}$/.test(revision) ||
          (previous !== null && revision === previous) || state?.id !== id) return false;
      if (![entry, state].every(row => row.title === expected.title &&
          (row.customTitle ?? null) === expected.customTitle && (row.archived === true) === expected.archived &&
          row.model === expected.model)) return false;
      if (preferences.title !== expected.title || preferences.customTitle !== expected.customTitle ||
          preferences.archived !== expected.archived || preferences.effort !== null || preferences.model !== expected.model) return false;
      if (!Array.isArray(state.messages) || state.active || state.messages.length !== expected.messages.length ||
          !expected.messages.every(([role, content], i) => state.messages[i]?.role === role && state.messages[i]?.content === content)) return false;
      return revision;
    })().then(done, () => done(false));
  `, id, expect, previous), diagnostic)
}

async function createSession(ui, prior) {
  await ui.click(`${chat} ${hook('new-chat')}`, 'new ordinary conversation button')
  const sid = await ui.until(async () => {
    const id = await ui.selected()
    return id !== prior && uuid.test(id ?? '') ? id : null
  }, 'new conversation selected by the UI')
  await ui.element(draft, 'new conversation composer')
  return sid
}

async function openSession(ui, name, id) {
  await ui.click(row, 'open the intended conversation row', name, title)
  await ui.until(async () => await ui.selected() === id, 'intended conversation selected by the user')
  await ui.element(header, 'selected conversation heading', name)
}

async function rename(ui, value) {
  await ui.click(action('rename'), 'rename action for the selected conversation')
  const input = await ui.element(hook('rename-input'), 'visible rename input')
  await ui.browser.keys(input, `${selectAll}${value || '\uE003'}`)
  await ui.until(() => ui.browser.execute('return arguments[0].value === arguments[1];', input, value), 'rename input contains the typed value')
  await ui.click(hook('rename-save'), 'explicitly save the title change')
  await ui.gone(hook('rename-input'), 'rename form closed after save')
}

const empty = { title: '', customTitle: null, archived: false, model: null, messages: [] }
const automatic = { ...empty, title: autoTitle, messages: [['user', firstText], ['assistant', reply]] }
const renamed = { ...automatic, title: customTitle, customTitle }

async function verifyTitlesAndArchive(a, b, mock, signal, setStage) {
  setStage('prepare an empty anchor in B so the target stays unselected there')
  const anchor = await createSession(b, null)
  const emptyRev = await readBack(b, anchor, empty, 'empty ordinary anchor exists in the public state')
  await rename(b, anchorName)
  const anchorRev = await readBack(b, anchor, { ...empty, title: anchorName, customTitle: anchorName }, 'empty anchor has a custom title', emptyRev)
  const stable = { anchor, name: anchorName, document: await b.browser.execute('return performance.timeOrigin;') }
  await b.rows([anchorName], 'B shows only its selected anchor', stable)
  await a.rows([anchorName], 'A sees the anchor before creating the target')

  setStage('create a conversation in A and see it live in B without selecting it')
  const target = await createSession(a, await a.selected())
  await a.rows([anchorName, untitled], 'A shows a newly created empty conversation')
  await b.rows([anchorName, untitled], 'B automatically shows the new unselected conversation', stable)
  let revision = await readBack(b, target, empty, 'B can read the new conversation and empty title')
  mock.assertRequestCount(0)

  setStage('send one ordinary text turn and observe the actual automatic title')
  const composer = await a.element(draft, 'editable composer for the selected target')
  await a.browser.click(composer)
  await a.browser.keys(composer, firstText)
  await a.click(send, 'send the single ordinary text turn')
  const call = await mock.expectRequest(1, { messages: [{ role: 'user', content: firstText }], signal })
  call.delta(reply)
  call.finish()
  await a.element(`${hook('turn-status')}[data-status="completed"]`, 'completed local synthetic reply')
  await a.element(`${chat} [data-role="assistant"] .msg__text`, 'rendered local synthetic reply', reply)
  await a.element(header, 'selected header uses the automatic title', autoTitle)
  await b.rows([anchorName, autoTitle], 'B automatically sees the real automatic title', stable)
  revision = await readBack(b, target, automatic, 'public transcript and automatically generated title agree', revision)

  setStage('rename in A and observe the unselected row update in B')
  await rename(a, customTitle)
  await a.element(header, 'A header has the custom title', customTitle)
  await a.rows([anchorName, customTitle], 'A list has the custom title')
  await b.rows([anchorName, customTitle], 'B automatically sees the custom title', stable)
  revision = await readBack(b, target, renamed, 'public readback of custom title', revision)

  setStage('archive in A, inspect archive in B and explicitly restore from B')
  await a.click(action('archive'), 'archive the selected conversation in A')
  await a.rows([anchorName], 'A active list excludes the archived conversation')
  await b.rows([anchorName], 'B active list automatically excludes the archived conversation', stable)
  revision = await readBack(b, target, { ...renamed, archived: true }, 'public readback of archive state', revision)
  await b.click(hook('archived-chats'), 'open the archive list in B')
  await b.rows([customTitle], 'B archive list contains only the target', null, 'archived')
  await openSession(b, customTitle, target)
  await b.element(action('archived'), 'selected conversation displays the archived marker')
  await b.click(action('restore'), 'explicitly restore the selected archived conversation')
  await a.rows([anchorName, customTitle], 'A automatically sees the restored conversation in the active list')
  await b.rows([], 'B archive list no longer contains the target', null, 'archived')
  await b.click(hook('active-chats'), 'open the active list again in B')
  await b.rows([anchorName, customTitle], 'B active list contains the restored conversation')
  revision = await readBack(b, target, renamed, 'public readback of restored state', revision)

  setStage('clear custom titles for a conversation with messages and an empty conversation')
  await openSession(a, customTitle, target)
  await rename(a, '')
  await a.element(header, 'clearing the title restores the real automatic title in A', autoTitle)
  await b.rows([anchorName, autoTitle], 'B sees the restored automatic title')
  revision = await readBack(b, target, automatic, 'public readback has a cleared custom title and unchanged transcript', revision)
  await openSession(a, anchorName, anchor)
  await rename(a, '')
  await a.element(header, 'clearing an empty conversation title restores the default label', untitled)
  await a.rows([untitled, autoTitle], 'A list uses the empty conversation default label')
  await b.rows([untitled, autoTitle], 'B list uses the empty conversation default label')
  await readBack(b, anchor, empty, 'empty session stores no label as its custom or automatic title', anchorRev)
  return { anchor, target, revision }
}

function modelOption(ui, model, diagnostic, checked = null) {
  return ui.until(() => ui.browser.execute(`
    const [menu, provider, model, checked] = arguments;
    const visible = node => node.getClientRects().length && getComputedStyle(node).visibility === 'visible';
    const group = [...document.querySelectorAll(menu + ' .cf-mp__group')]
      .find(node => visible(node) && node.querySelector('.cf-mp__ghead')?.textContent.trim() === provider);
    return [...(group?.querySelectorAll('[role="menuitemradio"]') ?? [])].find(node => visible(node) &&
      !node.matches(':disabled, [aria-disabled="true"]') && node.textContent.trim() === model &&
      (checked === null || node.getAttribute('aria-checked') === String(checked))) ?? null;
  `, modelMenu, providerName, model, checked), diagnostic)
}

async function verifyModels(a, b, mock, { anchor, target, revision }, setStage) {
  const modelReadBack = (model, diagnostic, before) => readBack(b, target, { ...automatic, model }, diagnostic, before)
  const assertSingleTurn = () => {
    mock.assertRequestCount(1)
    check(mock.successful === 0, 'Session preference controls requested the upstream model catalog')
  }

  setStage('pin the other configured model from the real composer chooser')
  await openSession(a, autoTitle, target)
  await a.click(chip, 'open the composer model menu')
  await modelOption(a, defaultModel, 'enabled configured default in the real provider group')
  await a.browser.click(await modelOption(a, pinnedModel, 'enabled alternate model in the real provider group', false))
  await a.element(chip, 'composer renders the alternate model after pinning', pinnedModel)
  revision = await modelReadBack(modelRef(pinnedModel), 'public preferences persist the exact model pin', revision)
  assertSingleTurn()

  setStage('verify the selected model pin after reopening and refreshing')
  await openSession(a, untitled, anchor)
  await a.element(chip, 'the other session still follows the configured default', followLabel)
  await openSession(a, autoTitle, target)
  await a.element(chip, 'composer pin survives reopening the conversation', pinnedModel)
  await a.browser.refresh()
  await a.element(header, 'same conversation is restored after refreshing A', autoTitle)
  await a.click(chip, 'open the composer with the persisted pin after refresh', pinnedModel)
  await modelOption(a, pinnedModel, 'alternate model is still checked after refresh', true)
  check(await modelReadBack(modelRef(pinnedModel), 'pin remains persisted after refresh') === revision, 'Refreshing a pinned conversation changed its revision')
  assertSingleTurn()

  setStage('click Follow default and verify it after reopening and refreshing')
  await a.click(`${follow}[aria-pressed="false"]`, 'explicit Follow default action from a pinned model')
  await a.element(chip, 'composer now explicitly follows the default', followLabel)
  revision = await modelReadBack(null, 'public preferences explicitly record Follow default as null', revision)
  await openSession(a, untitled, anchor)
  await openSession(a, autoTitle, target)
  await a.element(chip, 'Follow default survives reopening the conversation', followLabel)
  await a.browser.refresh()
  await a.element(header, 'same conversation is restored after refreshing A again', autoTitle)
  await a.click(chip, 'open the model chooser in the fresh document', followLabel)
  await a.element(`${follow}[aria-pressed="true"]`, 'Follow default is still the selected action after refresh', followLabel)
  check(await modelReadBack(null, 'Follow default remains persisted after refresh') === revision, 'Refreshing a default-following conversation changed its revision')
  assertSingleTurn()
}

const stop = new AbortController()
const abort = () => stop.abort()
process.once('SIGINT', abort)
process.once('SIGTERM', abort)
let root, workbench, mock, browserA, browserB, failed
let stage = 'validate environment'
const setStage = value => { stage = value }
try {
  check(process.argv.length === 2, 'Usage: node scripts/workbench/e2e-sessions.mjs')
  check(process.platform === 'linux' && process.getuid?.() > 0 && process.geteuid?.() > 0, 'Run on Linux as a non-root user')
  stage = 'check build outputs'
  for (const entry of ['provider', 'chat', 'library']) {
    await access(new URL(`../../apps/headless/dist/${entry}-core.mjs`, import.meta.url)).catch(() => {
      throw new CheckFailure('Build the headless cores with pnpm --filter @deva/headless build')
    })
  }
  await access(join(DEFAULT_WEB_DIR, 'index.html')).catch(() => { throw new CheckFailure('Build the Workbench with pnpm workbench:build') })

  stage = 'start a private loopback Workbench and synthetic model fixture'
  const prefix = join(await realpath(tmpdir()), 'deva-wb-sessions-')
  const created = await mkdtemp(prefix)
  check(created.startsWith(prefix) && created.length > prefix.length && await realpath(created) === created, 'Unexpected temporary directory')
  root = created
  const [keyFile, runDir, dataDir, homeA, homeB] = ['master.key', 'run', 'data', 'browser-a', 'browser-b'].map(name => join(root, name))
  await Promise.all([mkdir(homeA, { mode: 0o700 }), mkdir(homeB, { mode: 0o700 })])
  const password = randomBytes(24).toString('hex'), key = randomBytes(24).toString('hex')
  await initializeMasterKey(keyFile)
  mock = await startChatFixture({ key, modelId: defaultModel, otherModelId: pinnedModel })
  workbench = await startWorkbench({ dataDir, keyFile, runDir, port: 0, businessOptions: { allowedOrigins: [mock.origin] } })
  const { origin } = workbench
  check(workbench.address.address === '127.0.0.1' &&
    (await fetch(`${origin}/readyz`, { redirect: 'error', signal: AbortSignal.timeout(5_000) })).ok, 'Workbench was not ready on loopback')

  stage = 'start sandboxed Chrome A and claim the fresh owner through its UI'
  const { signal } = stop
  browserA = await startLocalWebDriver({ root: homeA, profile: join(homeA, 'profile'), origin, signal })
  const a = uiFor(browserA, signal)
  const { credential } = await requestControl({ runDir, op: 'claim' })
  await browserA.navigate(`${origin}/#claim=${encodeURIComponent(credential)}`)
  await submitPassword(a, 'new', password)
  check((await requestControl({ runDir, op: 'status' })).claimed === true, 'Unix control did not report a claimed owner')
  await seedModels(a, mock.origin, key)

  stage = 'start sandboxed Chrome B with its own profile and owner login'
  browserB = await startLocalWebDriver({ root: homeB, profile: join(homeB, 'profile'), origin, signal })
  const b = uiFor(browserB, signal)
  await browserB.navigate(`${origin}/`)
  await submitPassword(b, 'current', password)

  const sessions = await verifyTitlesAndArchive(a, b, mock, signal, setStage)
  await verifyModels(a, b, mock, sessions, setStage)
} catch (error) {
  failed = true
  const detail = stop.signal.aborted ? 'interrupted' :
    error instanceof CheckFailure || error instanceof ChatFixtureError || error instanceof WebDriverError ? error.message : 'unexpected error (raw diagnostics withheld)'
  console.error(`Workbench Sessions browser E2E failed at ${stage}: ${detail}`)
} finally {
  for (const [name, close] of [
    ['browser B', () => browserB?.close()], ['browser A', () => browserA?.close()],
    ['Workbench', () => workbench?.close()], ['model fixture', () => mock?.close()],
    ['temporary directory', async () => {
      if (!root) return
      check(await realpath(root) === root && (await lstat(root)).isDirectory(), 'Temporary directory has changed')
      await rm(root, { recursive: true })
      const exists = await lstat(root).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
      check(!exists, 'Temporary directory remained after cleanup')
    }]
  ]) {
    try { await close() } catch {
      failed = true
      console.error(`Workbench Sessions browser E2E: ${name} cleanup failed`)
    }
  }
  process.removeListener('SIGINT', abort)
  process.removeListener('SIGTERM', abort)
}
if (failed || stop.signal.aborted) process.exitCode = 1
else console.log('Workbench Sessions browser E2E passed: independent owner logins, live session list, title/archive/restore, and persisted pin/Follow default without additional model requests.')
