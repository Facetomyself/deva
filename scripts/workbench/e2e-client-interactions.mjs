import { randomBytes } from 'node:crypto'
import { access, lstat, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { requestControl } from '../../apps/headless/src/control/socket.mjs'
import { DEFAULT_WEB_DIR, startWorkbench } from '../../apps/headless/src/server.mjs'
import {
  check, InteractionCheckError, observeInteractionWrites, privateRoot, project, projectFile, projectText,
  seedInteractions, startInteractionModel
} from './e2e-client-interactions-fixture.mjs'
import { startLocalWebDriver, waitFor, WebDriverError } from './webdriver-local.mjs'
import { captureClientInteraction } from './client-interaction-visual.mjs'

const hook = name => `[data-testid="workbench-${name}"]`
const chat = hook('chat')
const composer = `${chat} .cf-draft__input[role="textbox"][contenteditable="true"]`
const send = `${chat} .cf-send:not(.is-stop)`
const completed = `${chat} ${hook('turn-status')}[data-status="completed"]`
const assistant = `${chat} [data-role="assistant"]:not([data-streaming="true"]) ${hook('message-text')}`
const user = `${chat} [data-role="user"]`
const menu = `${hook('selection-menu')}[role="menu"]`
const quoteDraft = `${chat} ${hook('quote-draft')}`
const chatToggle = `${chat} nav.cf-iconrail button[aria-current="true"][aria-expanded]:not(${hook('tasks-toggle')})`
const fullscreen = `${chat} nav.cf-iconrail button${hook('client-fullscreen')}`
const workspace = `dialog${hook('workspace-dialog')}[open]`
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const a = { prompt: 'Seed interaction chat A', token: 'CaféMistral', body: 'Keep *the exact original body*.' }
const b = { prompt: 'Seed interaction chat B', token: 'CrèmeSolaire', body: 'Separate unsent body in chat B.' }
a.reply = `Signal ${a.token} belongs to chat A.`
b.reply = `Signal ${b.token} belongs to chat B.`
const finalReply = 'Quoted context reached the local fixture.'
const msg = (role, content) => ({ role, content })

// JavaScript only observes DOM and selection state. W3C references, booleans, and
// synthetic-target coordinates leave the page; editor or clipboard contents never do.
function controls(browser, signal) {
  const until = (probe, diagnostic) => waitFor(probe, diagnostic, { signal })
  const element = (selector, diagnostic, expected = null, child = null) => until(() => browser.execute(`
    const [selector, expected, child] = arguments;
    return [...document.querySelectorAll(selector)].find(node => node.getClientRects().length &&
      getComputedStyle(node).visibility === 'visible' && !node.matches(':disabled, [aria-disabled="true"]') &&
      (expected === null || (child ? node.querySelector(child) : node)?.textContent.trim() === expected)) ?? null;
  `, selector, expected, child), diagnostic)
  const matches = (script, diagnostic, ...args) => until(() => browser.execute(script, ...args), diagnostic)
  return {
    until, element, matches,
    click: async (...args) => browser.click(await element(...args)),
    gone: (selector, diagnostic) => matches('return !document.querySelector(arguments[0]);', diagnostic, selector),
    selected: () => browser.execute('return sessionStorage.getItem("deva-workbench.chat");'),
    draft: (expected, diagnostic) => matches(`
      const editor = document.querySelector(arguments[0]);
      return editor?.getClientRects().length && editor.textContent === arguments[1];
    `, diagnostic, composer, expected),
    async type(value) {
      const editor = await element(composer, 'visible Lexical composer')
      await browser.click(editor)
      await browser.keys(editor, value)
    }
  }
}

async function submitPassword({ browser, ui, password }, mode) {
  const input = await ui.element(`.wb-auth input[type="password"][autocomplete="${mode}-password"]`, 'real owner password form')
  await browser.keys(input, password)
  await ui.click('.wb-auth button[type="submit"]', 'real owner authentication submit')
  await ui.element(chat, 'authenticated Workbench')
}

async function newSession({ ui, writes }, previous) {
  writes.permitCreate()
  await ui.click(`${chat} ${hook('new-chat')}`, 'create a regular chat using the Workbench rail')
  const sid = await ui.until(async () => {
    const selected = await ui.selected()
    return selected !== previous && uuid.test(selected ?? '') ? selected : null
  }, 'new Workbench conversation ID')
  await ui.element(composer, 'new chat Lexical composer')
  return sid
}

async function assertSelected({ ui }, source) {
  await ui.until(async () => await ui.selected() === source.sid, 'correct chat ID selected')
  await ui.element(assistant, 'confirmed synthetic reply in the selected chat', source.reply)
  await ui.element(composer, 'selected chat Lexical composer')
}

async function openSession(ctx, source) {
  await ctx.ui.click(`${chat} .cf-thread`, 'open the intended chat rail row', source.prompt, '.cf-thread__title')
  await assertSelected(ctx, source)
}

async function sendExplicit(ctx, sid, conversation, reply) {
  const { browser, ui, mock, signal, sends } = ctx
  const button = await ui.element(send, 'enabled real Send button')
  check(await ui.selected() === sid, 'The deliberate Send is not in its expected chat')
  await phaseGuard(ctx)
  const previous = sends.length
  mock.permitSend(previous, conversation, reply)
  await browser.click(button)
  sends.push(sid)
  await mock.waitForReply(sends.length, signal)
  await ui.element(completed, 'real confirmed completed turn')
  await ui.element(assistant, 'rendered exact synthetic model reply', reply)
  await phaseGuard(ctx)
}

async function phaseGuard({ mock, writes, seed, sends }) {
  mock.assertCount(sends.length)
  writes.assertTurns(sends)
  await seed.assertFileUnchanged()
}

async function seedChat(ctx, source, previous) {
  source.sid = await newSession(ctx, previous)
  await ctx.ui.draft('', 'new chat has an empty editor')
  await ctx.ui.gone(quoteDraft, 'new chat has no quote from another chat')
  await ctx.ui.type(source.prompt)
  await ctx.ui.draft(source.prompt, 'initial question is present in the editor only')
  await sendExplicit(ctx, source.sid, [msg('user', source.prompt)], source.reply)
  await ctx.ui.draft('', 'completed initial Send clears the editor')
}

async function openSelection({ browser, ui }, source, keyboard = false) {
  const element = await ui.element(assistant, 'selectable plain-text synthetic reply', source.reply)
  const offset = await ui.until(() => browser.execute(`
    const [element, token] = arguments;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = node.data.indexOf(token);
      if (index < 0) continue;
      // A detached Range only measures glyphs; it never touches the active browser Selection.
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + token.length);
      const glyphs = range.getClientRects();
      const origin = element.getClientRects()[0];
      if (glyphs.length !== 1 || !origin) return null;
      const rect = glyphs[0];
      const x = Math.floor((rect.left + rect.right) / 2), y = Math.floor((rect.top + rect.bottom) / 2);
      if (!element.contains(document.elementFromPoint(x, y))) return null;
      return {
        x: x - Math.floor((Math.max(0, origin.left) + Math.min(innerWidth, origin.right)) / 2),
        y: y - Math.floor((Math.max(0, origin.top) + Math.min(innerHeight, origin.bottom)) / 2)
      };
    }
    return null;
  `, element, source.token), 'visible glyphs for the synthetic Unicode word')
  await browser.doubleClick(element, offset)
  await ui.matches(`
    const [element, expected] = arguments;
    const selection = document.getSelection();
    return !!selection && selection.rangeCount === 1 && !selection.isCollapsed &&
      element.contains(selection.anchorNode) && element.contains(selection.focusNode) && selection.toString() === expected;
  `, 'native double click selected exactly the synthetic word in one message body', element, source.token)
  if (keyboard) await browser.shortcut(element, 'context-menu')
  else await browser.contextClick(element, offset)
  await ui.element(menu, keyboard ? 'shared message selection menu from native Shift+F10' : 'shared message selection menu from native right click')
}

async function verifyClipboard(ctx) {
  const { browser, ui } = ctx
  await openSelection(ctx, a)
  await captureClientInteraction(ctx, 'selection-menu')
  await ui.click(`${menu} ${hook('selection-copy')}`, 'real Copy action in the shared menu')
  await ui.until(async () => {
    const status = await browser.execute('return document.querySelector(arguments[0])?.dataset.status ?? null;', hook('selection-status'))
    check(status !== 'copy-failed', 'The real browser clipboard rejected the shared menu Copy action')
    return status === 'copied'
  }, 'successful real browser clipboard write feedback')
  await ui.gone(menu, 'shared menu closed after Copy')
  await phaseGuard(ctx)
  const editor = await ui.element(composer, 'actual Lexical editor to receive native paste')
  await browser.click(editor)
  await browser.shortcut(editor, 'paste')
  await ui.draft(a.token, 'native Ctrl+V inserted exactly the copied Unicode word into Lexical')
  await ui.gone(quoteDraft, 'Copy and paste did not create a quote draft')
  await phaseGuard(ctx)
  await browser.shortcut(editor, 'select-all')
  await browser.keys(editor, '\uE003') // Backspace via W3C, after it selected the browser-pasted text.
  await ui.draft('', 'pasted fixture text was cleared with native keys')
}

async function assertQuote({ ui }, source) {
  await ui.matches(`
    const [selector, expected] = arguments;
    const quotes = [...document.querySelectorAll(selector)].filter(node => node.getClientRects().length);
    return quotes.length === 1 && quotes[0].textContent.trim() === expected &&
      quotes[0].querySelector('.cf-quotebar__text')?.title === expected;
  `, 'exactly one quote preview for the selected chat', quoteDraft, source.token)
}

async function addQuote(ctx, source, keyboard = false) {
  await openSelection(ctx, source, keyboard)
  if (keyboard) {
    const first = await ctx.ui.element(`${menu} ${hook('selection-copy')}`, 'first keyboard menu item')
    await ctx.ui.matches('return document.activeElement === arguments[0];','keyboard menu initially focuses Copy',first)
    await ctx.browser.keys(first, '\uE015') // ArrowDown selects Quote in the shared menu.
    const quote = await ctx.ui.element(`${menu} ${hook('selection-quote')}`, 'keyboard Quote menu item')
    await ctx.ui.matches('return document.activeElement === arguments[0];','ArrowDown moves focus to Quote',quote)
    await ctx.browser.keys(quote, '\uE007') // Enter is a real keyboard activation.
  } else await ctx.ui.click(`${menu} ${hook('selection-quote')}`, 'real Quote action in the shared menu')
  await ctx.ui.gone(menu, 'shared menu closed after Quote')
  await assertQuote(ctx, source)
  await phaseGuard(ctx)
}

async function verifyDraftIsolation(ctx, stage) {
  const { ui } = ctx
  stage('copy and paste the synthetic Unicode using only native Chrome gestures')
  await verifyClipboard(ctx)

  stage('quote in A over typed body and prepare an independent draft in B')
  await ui.type(a.body)
  await ui.draft(a.body, 'A body before quoting')
  await addQuote(ctx, a)
  await ui.draft(a.body, 'quotation left the existing A body untouched')
  await captureClientInteraction(ctx, 'quoted-draft')
  await seedChat(ctx, b, a.sid)
  await ui.type(b.body)
  await ui.draft(b.body, 'B body before quoting')
  await addQuote(ctx, b, true)
  await ui.draft(b.body, 'quotation left the existing B body untouched')

  stage('switch the two pending quote/draft pairs and cancel only B’s quote')
  await openSession(ctx, a)
  await assertQuote(ctx, a)
  await ui.draft(a.body, 'A restored its own body, not B’s')
  await openSession(ctx, b)
  await assertQuote(ctx, b)
  await ui.draft(b.body, 'B restored its own body, not A’s')
  await ui.click(`${quoteDraft} ${hook('quote-remove')}`, 'remove B’s quote via the real quote preview control')
  await ui.gone(quoteDraft, 'B quote vanished after explicit removal')
  await ui.draft(b.body, 'canceling B quote left its existing body untouched')
  await phaseGuard(ctx)

  stage('explicitly Send A and verify the exact quote Markdown on the real provider wire')
  await openSession(ctx, a)
  await assertQuote(ctx, a)
  await ui.draft(a.body, 'cancel in B left A body and quote untouched')
  const wireText = `> ${a.token}\n\n${a.body}`
  await sendExplicit(ctx, a.sid, [msg('user', a.prompt), msg('assistant', a.reply), msg('user', wireText)], finalReply)
  await ui.element(`${user} .cf-msg__quote`, 'sent message renders the expected quote', a.token)
  await ui.element(`${user} .cf-msg__clamp`, 'sent message renders the unchanged body', a.body)
  await ui.gone(quoteDraft, 'committed quote is gone from A draft after Send')
  await ui.draft('', 'A editor is empty after explicit Send')
  await openSession(ctx, b)
  await ui.draft(b.body, 'B body remains unsent after Send in A')
  await ui.gone(quoteDraft, 'B quote stayed canceled after Send in A')
  await phaseGuard(ctx)
}

function sidebarState({ ui }, expanded) {
  return ui.matches(`
    const [selector, expected] = arguments;
    const control = document.querySelector(selector);
    const rail = document.querySelector('.cf-rail');
    return control?.getAttribute('aria-expanded') === String(expected) && !!rail &&
      rail.classList.contains('is-collapsed') === !expected && Boolean(rail.querySelector('.cf-list')) === expected;
  `, expanded ? 'chat sidebar expanded in its control and DOM' : 'chat sidebar collapsed in its control and DOM', chatToggle, expanded)
}

async function verifyModalShortcut(ctx) {
  const { browser, ui } = ctx
  await ui.click(hook('workspace-open'), 'open the actual Workspace Files modal')
  const close = await ui.element(`${workspace} ${hook('workspace-close')}`, 'open native Workspace Files modal with a noneditable control')
  await browser.shortcut(close, 'sidebar')
  await sidebarState(ctx, true)

  const select = `${workspace} ${hook('workspace-select')}`
  const field = await ui.element(select, 'native workspace selector with the synthetic project')
  const option = await ui.matches(`
    const options = Array.from(arguments[0].options).filter(entry => entry.value && !entry.disabled);
    return options.length === 1 && options[0].textContent === arguments[1] ? options[0] : null;
  `, 'the only workspace option names the private fixture project', field, project)
  const projectId = await browser.execute('return arguments[0].value;', option)
  const listed = ctx.writes.permitFileRead(projectId, 'list')
  await browser.click(option)
  const file = await ui.element(`${workspace} ${hook('workspace-entry')}[data-type="file"]`, 'unrelated project file', projectFile)
  await listed()
  const read = ctx.writes.permitFileRead(projectId, 'read')
  await browser.click(file)
  const editor = await ui.element(`${workspace} textarea${hook('workspace-editor')}:not([readonly])`, 'real writable project textarea')
  await read()
  await browser.click(editor)
  await browser.shortcut(editor, 'sidebar')
  await ui.matches(`
    return arguments[0].value === arguments[1] && document.querySelector(arguments[2])?.disabled;
  `, 'Ctrl+B left the project textarea clean and Save disabled', editor, projectText, `${workspace} ${hook('workspace-save')}`)
  await sidebarState(ctx, true)
  await ui.click(`${workspace} ${hook('workspace-close')}`, 'explicitly close the workspace modal')
  await ui.gone(workspace, 'workspace modal closed')
  await sidebarState(ctx, true)
  await phaseGuard(ctx)
}

async function verifyShortcuts(ctx) {
  const { browser, ui } = ctx
  await sidebarState(ctx, true)
  const toggle = await ui.element(`${chatToggle}[aria-keyshortcuts="Control+B"]`, 'real chat rail advertises its Linux shortcut')
  // Focus the noneditable message via W3C Element Send Keys, without clicking the sidebar button.
  const noneditable = await ui.element(assistant, 'actual focusable and noneditable message body', b.reply)
  await browser.shortcut(noneditable, 'sidebar')
  await sidebarState(ctx, false)
  await browser.shortcut(noneditable, 'sidebar')
  await sidebarState(ctx, true)
  await ui.matches('return arguments[0].getAttribute("aria-keyshortcuts") === "Control+B";', 'actual chat rail retained its shortcut', toggle)
  await phaseGuard(ctx)

  const editor = await ui.element(composer, 'real editable Lexical surface')
  await browser.click(editor)
  await browser.shortcut(editor, 'sidebar')
  await sidebarState(ctx, true)
  await ui.draft(b.body, 'editor Ctrl+B left the existing plain-text Lexical draft untouched')
  await phaseGuard(ctx)
  await verifyModalShortcut(ctx)

  await ui.click(hook('tasks-toggle'), 'open the real Tasks surface')
  await ui.element(hook('tasks-panel'), 'real Tasks panel remains independent of chat')
  await ui.element(hook('task-empty'), 'synthetic Workbench has no saved tasks')
  const close = await ui.element(`${hook('tasks-panel')} ${hook('tasks-close')}`, 'noneditable Tasks control')
  await browser.shortcut(close, 'sidebar')
  await ui.element(`${hook('tasks-toggle')}[aria-expanded="true"]`, 'Ctrl+B left Tasks open')
  await ui.click(`${hook('tasks-panel')} ${hook('tasks-close')}`, 'explicitly close Tasks')
  await sidebarState(ctx, true)
  await ui.draft(b.body, 'Tasks open/close and Ctrl+B did not change the chat draft')
  await phaseGuard(ctx)
}

async function verifyFullscreen(ctx) {
  const { ui } = ctx
  const state = (pressed, diagnostic) => ui.matches(`
    const [control, status, pressed] = arguments;
    const button = document.querySelector(control);
    const entry = document.querySelector(status);
    const mode = pressed ? 'fullscreen' : 'windowed';
    return document.fullscreenElement === (pressed ? document.documentElement : null) &&
      button?.getAttribute('aria-pressed') === String(pressed) && button.dataset.state === mode &&
      !button.disabled && button.getAttribute('aria-describedby') === entry?.id && entry?.dataset.state === mode;
  `, diagnostic, fullscreen, hook('client-fullscreen-status'), pressed)
  await state(false, 'initial page fullscreen is off according to the page DOM and rail control')
  await ui.click(fullscreen, 'enter page fullscreen through the original icon rail')
  await state(true, 'document root is the native page fullscreen element and rail ARIA is pressed')
  await phaseGuard(ctx)
  await ui.click(fullscreen, 'explicitly exit page fullscreen through the same real icon')
  await state(false, 'native fullscreen element cleared and rail ARIA is reset after explicit exit')
  await ui.draft(b.body, 'fullscreen enter/exit kept the existing draft')
  await phaseGuard(ctx)
}

async function verifyQuoteLifetime(ctx, stage) {
  const { browser, ui } = ctx
  stage('reload a document with a live quote and observe that the quote is ephemeral')
  await addQuote(ctx, b)
  await browser.refresh()
  await assertSelected(ctx, b)
  await ui.gone(quoteDraft, 'reload did not recover a pending quote')
  await phaseGuard(ctx)

  stage('logout with a live quote and sign in again via the real UI')
  await addQuote(ctx, b)
  await ui.click(`${chat} ${hook('settings')}`, 'open original Workbench settings')
  await ui.element(hook('server-platform'), 'Settings labels the Workbench host platform separately', 'Server platform: Linux')
  await ui.click('.wb-chat__logout', 'sign out via the native settings surface')
  await ui.element('.wb-auth input[autocomplete="current-password"]', 'login form following sign-out')
  await ui.gone(chat, 'signed-out page unmounted the authenticated Workbench')
  await phaseGuard(ctx)
  await submitPassword(ctx, 'current')
  await openSession(ctx, b)
  await ui.gone(quoteDraft, 'another authenticated Workbench mount did not recover the previous quote')
  await phaseGuard(ctx)
}

const stop = new AbortController()
const abort = () => stop.abort()
process.once('SIGINT', abort)
process.once('SIGTERM', abort)
const { signal } = stop
let phase = 'validate environment', root, mock, seed, workbench, writes, browser, ctx, failed = false
const stage = value => { phase = value }
try {
  check(process.argv.length === 2, 'Usage: node scripts/workbench/e2e-client-interactions.mjs')
  check(process.platform === 'linux' && process.getuid?.() > 0 && process.geteuid?.() > 0, 'Run on Linux as a non-root user')
  await Promise.all(['provider', 'chat', 'library'].map(name =>
    access(new URL(`../../apps/headless/dist/${name}-core.mjs`, import.meta.url)))).catch(() => {
    throw new InteractionCheckError('Build the headless server cores with pnpm --filter @deva/headless build')
  })
  await access(join(DEFAULT_WEB_DIR, 'index.html')).catch(() => { throw new InteractionCheckError('Build the Workbench with pnpm workbench:build') })

  stage('start the private loopback provider and production Workbench')
  root = await privateRoot()
  mock = await startInteractionModel()
  seed = await seedInteractions(root, mock)
  const { dataDir, keyFile, runDir, workspaceRoot } = seed
  workbench = await startWorkbench({ dataDir, keyFile, runDir, webDir: DEFAULT_WEB_DIR, port: 0,
    businessOptions: { allowedOrigins: [mock.origin], workspaceRoot, workspaceWritable: true } })
  const { origin, address } = workbench
  const ready = await fetch(`${origin}/readyz`, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) })
  await ready.body?.cancel()
  check(address.address === '127.0.0.1' && ready.status === 200, 'Workbench was not ready on loopback')
  writes = observeInteractionWrites(address.port)

  stage('start actual sandboxed ChromeDriver and claim the owner in the browser')
  browser = await startLocalWebDriver({ root, profile: join(root, 'chrome-profile'), origin, signal })
  const ui = controls(browser, signal)
  ctx = { browser, ui, mock, writes, seed, signal, origin, sends: [], password: randomBytes(24).toString('base64url') }
  const { credential } = await requestControl({ runDir, op: 'claim' })
  await browser.navigate(`${origin}/#claim=${encodeURIComponent(credential)}`)
  await submitPassword(ctx, 'new')
  check((await requestControl({ runDir, op: 'status' })).claimed, 'Real Workbench did not record the claimed owner')
  await phaseGuard(ctx)

  stage('send the first explicit plain-text question and observe the real SSE response')
  await seedChat(ctx, a, null)
  await verifyDraftIsolation(ctx, stage)
  stage('exercise sidebar scope in chat, Lexical, workspace modal, and Tasks')
  await verifyShortcuts(ctx)
  stage('enter and explicitly exit native page fullscreen')
  await verifyFullscreen(ctx)
  await verifyQuoteLifetime(ctx, stage)
  check(ctx.sends.length === 3 && writes.createdCount() === 2, 'Expected exactly two created chats and three deliberate Send clicks')
} catch (error) {
  failed = true
  const detail = signal.aborted ? 'interrupted' : error instanceof InteractionCheckError || error instanceof WebDriverError
    ? error.message : 'unexpected error (raw diagnostics withheld)'
  console.error(`Workbench client interactions E2E failed at ${phase}: ${detail}`)
} finally {
  // Drain the real Workbench first so even late model calls and writes are included.
  for (const [name, cleanup] of [
    ['Chrome', () => browser?.close()], ['Workbench', () => workbench?.close()],
    ['phase guards', async () => { if (!failed && ctx) await phaseGuard(ctx) }],
    ['write observer', () => writes?.close()], ['model fixture', () => mock?.close()],
    ['private directory', async () => {
      if (!root) return
      check(await realpath(root) === root && (await lstat(root)).isDirectory(), 'Temporary directory identity changed')
      await rm(root, { recursive: true })
    }]
  ]) {
    try { await cleanup() } catch {
      failed = true
      console.error(`Workbench client interactions E2E: ${name} cleanup or final assertion failed`)
    }
  }
  process.removeListener('SIGINT', abort)
  process.removeListener('SIGTERM', abort)
}
if (failed || signal.aborted) process.exitCode = 1
else console.log('Workbench client interactions E2E passed: native Unicode copy/paste, isolated quote drafts and exact explicit Send, scoped Ctrl+B, real page fullscreen.')
