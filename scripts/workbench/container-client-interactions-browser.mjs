import { check } from './container-client-interactions-docker.mjs'
import { formatCodeFixture } from './container-client-interactions-probe.mjs'
import { waitFor } from './webdriver-local.mjs'

const chat = '[data-testid="workbench-chat"]'
const testId = name => `[data-testid="workbench-${name}"]`
const withinChat = name => `${chat} ${testId(name)}`
const fullscreen = withinChat('client-fullscreen')
const rail = `${chat} .cf-iconrail`
const sidebarButton = `${rail} button[aria-current="true"][aria-expanded]`
const sidebarSearch = `${chat} .cf-rail:not(.is-collapsed) .cf-search__input`
const historyTitle = `${chat} .cf-thread .cf-thread__title`
const draft = `${chat} .cf-draft__input[role="textbox"][contenteditable="true"]`
const login = '.wb-auth input[name="password"][type="password"][autocomplete="current-password"]'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function visible(browser, signal) {
  return (selector, description, text) => waitFor(async () => {
    const found = await browser.execute(`
      const [selector, text] = arguments;
      const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility === 'visible';
      if (Array.from(document.querySelectorAll('.wb-error[role="alert"], #root > [role="alert"]')).some(visible)) return false;
      return Array.from(document.querySelectorAll(selector)).find(el => visible(el) && !el.matches(':disabled') &&
        (text == null || el.textContent.trim() === text)) ?? null;
    `, selector, text ?? null)
    check(found !== false, 'Packed Workbench showed an authentication or application error')
    return found
  }, description, { signal })
}

function protectedStatus(browser) {
  return browser.executeAsync(`
    const finish = arguments[arguments.length - 1];
    fetch('/api/v1/bootstrap', { cache: 'no-store', credentials: 'same-origin', redirect: 'error' })
      .then(response => finish(response.status), () => finish(0));
  `)
}

async function verifyLinuxSettings(browser, element) {
  await browser.click(await element(withinChat('settings'), 'open the owner settings'))
  const platform = await element(testId('server-platform'), 'Linux server platform shown in the Web settings')
  check(await browser.execute(String.raw`return /\bLinux\b/i.test(arguments[0].textContent);`, platform), 'Settings did not show Linux for the runtime')
  await browser.click(await element(testId('settings-close'), 'close owner settings'))
}

async function verifyFullscreen(browser, element, signal) {
  const button = await element(fullscreen, 'original rail fullscreen control')
  check(await browser.execute(`
    if (!arguments[0].closest('.cf-iconrail') || !document.fullscreenEnabled || document.fullscreenElement) return false;
    const events = [];
    document.addEventListener('fullscreenchange', event => {
      const node = document.fullscreenElement;
      events.push(!event.isTrusted || (node && node !== document.documentElement) ? 'unexpected' : node ? 'enter' : 'exit');
    });
    document.addEventListener('fullscreenerror', () => events.push('error'));
    window.__containerQaFullscreen = events;
    window.__containerQaRailButton = arguments[0];
    performance.setResourceTimingBufferSize(2048);
    window.__containerQaActionStart = performance.now();
    return true;
  `, button), 'The original IconRail was not in a fullscreen-capable, non-fullscreen document')
  const state = (entered, sequence) => browser.execute(`
    return document.fullscreenElement === (arguments[0] ? document.documentElement : null) &&
      window.__containerQaFullscreen.join(',') === arguments[1];
  `, entered, sequence)
  await browser.click(button)
  await waitFor(() => state(true, 'enter'), 'exactly one fullscreenchange with a real document.fullscreenElement', { signal })
  const exit = await element(fullscreen, 'the same IconRail fullscreen control while fullscreen')
  check(await browser.execute(`return arguments[0] === window.__containerQaRailButton;`, exit), 'Fullscreen swapped out the original rail control')
  await browser.click(exit)
  await waitFor(() => state(false, 'enter,exit'), 'one real enter and one real exit through the original rail', { signal })
}

async function verifySidebar(browser, element, signal) {
  await element(sidebarSearch, 'sidebar visible before Ctrl+B')
  await browser.shortcut(await element(`${sidebarButton}[aria-expanded="true"]`, 'expanded chat list toggle'), 'sidebar')
  await element(`${sidebarButton}[aria-expanded="false"]`, 'collapsed chat list toggle')
  check(await browser.execute(`
    const rail = document.querySelector(arguments[0]);
    return rail?.classList.contains('is-collapsed') && rail.getAttribute('aria-hidden') === 'true' && !rail.querySelector('.cf-search__input');
  `, `${chat} .cf-rail`), 'Ctrl+B did not collapse the actual sidebar')
  await browser.shortcut(await element(`${sidebarButton}[aria-expanded="false"]`, 'collapsed chat list toggle'), 'sidebar')
  await element(sidebarSearch, 'sidebar restored by Ctrl+B')
  await waitFor(() => browser.execute(`return !!document.querySelector(arguments[0]);`, `${sidebarButton}[aria-expanded="true"]`),
    'restored chat-list aria-expanded state', { signal })
}

async function wordOffset(browser, message, word) {
  // The browser recalculates the real rendered word's midpoint. W3C pointer offsets are
  // relative to the in-view center of the element's first client rect, not to its top-left.
  const offset = await browser.execute(`
    const [message, word] = arguments;
    const text = document.createTreeWalker(message, NodeFilter.SHOW_TEXT);
    for (let node = text.nextNode(); node; node = text.nextNode()) {
      const i = node.textContent.indexOf(word);
      if (i < 0) continue;
      const range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + word.length);
      const hit = range.getBoundingClientRect(); const box = message.getClientRects()[0];
      const x = Math.floor((hit.left + hit.right) / 2), y = Math.floor((hit.top + hit.bottom) / 2);
      if (!box || hit.width <= 0 || hit.height <= 0 || x < 0 || x >= innerWidth || y < 0 || y >= innerHeight ||
          !message.contains(document.elementFromPoint(x, y))) return null;
      return {
        x: x - Math.floor((Math.max(0, box.left) + Math.min(innerWidth, box.right)) / 2),
        y: y - Math.floor((Math.max(0, box.top) + Math.min(innerHeight, box.bottom)) / 2)
      };
    }
    return null;
  `, message, word)
  check(offset !== null && Number.isInteger(offset.x) && Number.isInteger(offset.y), 'Synthetic text was not hittable in the native history bubble')
  return offset
}

async function verifyClipboard(browser, element, signal, fixture) {
  const thread = await element(historyTitle, 'native chat fixture row', fixture.title)
  await browser.click(thread)
  const message = await element(withinChat('message-text'), 'plain text from native chat history', fixture.word)
  const offset = await wordOffset(browser, message, fixture.word)
  await browser.doubleClick(message, offset)
  await waitFor(() => browser.execute(`
    const [message, word] = arguments, selection = getSelection();
    return !!selection && selection.rangeCount === 1 && !selection.isCollapsed && selection.toString() === word &&
      message.contains(selection.anchorNode) && message.contains(selection.focusNode);
  `, message, fixture.word), 'real browser word selection in the intended message', { signal })
  await browser.contextClick(message, offset)
  const menu = testId('selection-menu')
  const popup = await element(menu, 'browser message selection context menu')
  check(await browser.execute(`return !arguments[0].querySelector(arguments[1]);`, popup, testId('selection-quote')),
    'The read-only native history menu offered Quote')
  await browser.click(await element(`${menu} ${testId('selection-copy')}`, 'copy selected fixture text through the read-only Web UI'))
  await element(`${testId('selection-status')}[data-status="copied"]`, 'copy confirmation')

  await browser.click(await element(withinChat('new-chat'), 'create a fresh Web-owned writable chat'))
  const editor = await element(draft, 'writable draft in newly created Web chat')
  check(await browser.execute(`
    const [editor, word] = arguments;
    if (editor.textContent !== '') return false;
    editor.addEventListener('paste', event => {
      window.__containerQaPaste = event.isTrusted && event.clipboardData?.getData('text/plain') === word;
    }, { capture: true, once: true });
    return true;
  `, editor, fixture.word), 'Fresh composer did not start empty')
  await browser.click(editor)
  await browser.shortcut(editor, 'paste')
  await waitFor(() => browser.execute(`return window.__containerQaPaste === true && arguments[0].textContent === arguments[1];`, editor, fixture.word),
    'trusted browser paste preserved the copied fixture bytes in the new composer', { signal })
}

async function verifyCodeClipboard(browser, element, signal, fixture) {
  await browser.click(await element(historyTitle, 'reopen the original native history', fixture.title))
  const copyButton = `${chat} [data-role="assistant"] .md-code__head ${testId('code-copy')}`
  const button = await element(copyButton, 'shared fenced-code header Copy button in read-only native history')
  const { plain } = formatCodeFixture(fixture.word)
  check(await browser.execute(`
    return arguments[0].closest('.md-code')?.querySelector('pre > code')?.textContent === arguments[1];
  `, button, plain), 'Rendered fenced code did not retain its exact text and terminal newline')
  await browser.click(button)
  await waitFor(async () => {
    const status = await browser.execute(`return arguments[0].dataset.status;`, button)
    check(status !== 'failed', 'Browser rejected the shared code header clipboard write')
    return status === 'copied'
  }, 'copy confirmation from the real code header', { signal })

  const search = await element(sidebarSearch, 'the real conversation rail search input for native paste')
  check(await browser.execute(`
    const [search, plain] = arguments;
    if (search.value !== '') return false;
    search.addEventListener('paste', event => {
      window.__containerQaCodePaste = event.isTrusted && event.target === search && event.clipboardData?.getData('text/plain') === plain;
    }, { capture: true, once: true });
    return true;
  `, search, plain), 'Sidebar search did not start empty')
  await browser.click(search)
  await browser.shortcut(search, 'paste')
  // An input[type=text] strips line endings; the trusted paste event above still compares the exact LF-terminated bytes.
  await waitFor(() => browser.execute(`
    return window.__containerQaCodePaste === true && arguments[0].value === arguments[1];
  `, search, plain.slice(0, -1)), 'trusted code paste preserved the exact clipboard text, including terminal newline', { signal })
  await browser.shortcut(search, 'select-all')
  await browser.keys(search, '\uE003')
  await waitFor(() => browser.execute(`return arguments[0].value === '';`, search), 'native keyboard cleared the conversation search', { signal })
  await element(historyTitle, 'original history visible again after clearing search', fixture.title)
}

async function verifyNoRemoteClientEffects(browser) {
  check(await browser.execute(String.raw`
    const start = window.__containerQaActionStart;
    const entries = performance.getEntriesByType('resource').filter(row => row.startTime >= start);
    return window.__containerQaFullscreen.join(',') === 'enter,exit' && !document.fullscreenElement && entries.length < 2048 &&
      entries.every(entry => !/(?:^|\/)(?:clipboard|full[-_]?screen|commands?)(?:\/|$)/i.test(new URL(entry.name).pathname));
  `), 'Local client actions made an unexpected command request or fullscreen transition')
}

async function verifySessionsAndTasks(browser, fixture) {
  const snapshot = await browser.executeAsync(`
    const [sid, word, markdown, finish] = arguments;
    async function read(path) {
      const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
      if (!response.ok) throw new Error('verification request failed');
      return response.json();
    }
    (async () => {
      const [{ sessions }, tasks] = await Promise.all([read('/api/v1/chats'), read('/api/v1/tasks')]);
      if (sessions.length !== 2 || !tasks || !Array.isArray(tasks.tasks) || tasks.tasks.length || tasks.execution !== 'inactive') return null;
      const before = sessions.find(entry => entry.id === sid), after = sessions.find(entry => entry.id !== sid);
      if (before?.writable !== false || before.compatibility !== 'legacy_text' || after?.writable !== true || after.compatibility !== 'text') return null;
      const [{state: history}, {state: fresh}] = await Promise.all([read('/api/v1/chats/' + sid), read('/api/v1/chats/' + after.id)]);
      if (history.active !== null || history.lastTurn !== null || history.messages.length !== 2 ||
          history.messages[0].role !== 'user' || history.messages[0].content !== word ||
          history.messages[1].role !== 'assistant' || history.messages[1].content !== markdown ||
          fresh.active !== null || fresh.lastTurn !== null || fresh.messages.length !== 0) return null;
      return after.id;
    })().then(finish, () => finish(null));
  `, fixture.sid, fixture.word, formatCodeFixture(fixture.word).markdown)
  check(typeof snapshot === 'string' && uuid.test(snapshot) && snapshot !== fixture.sid, 'Expected only fixture and empty Web chat; no active/sent turn or saved task')
  return snapshot
}

export async function verifyBrowser({ browser, origin, password, fixture, signal, stage }) {
  const element = visible(browser, signal)
  stage('real sandboxed Chrome login')
  await browser.navigate(`${origin}/`)
  const input = await element(login, 'claimed deployment browser login form')
  check(await browser.execute(String.raw`return /HeadlessChrome\//.test(navigator.userAgent) && navigator.webdriver && isSecureContext;`),
    'Expected real headless Chrome in a secure local context')
  check(await browser.execute(`
    const policy = document.featurePolicy;
    if (typeof policy?.allowsFeature !== 'function') return true;
    return !policy.allowsFeature('clipboard-read') && policy.allowsFeature('clipboard-write') && policy.allowsFeature('fullscreen');
  `), 'Browser document policy did not block async clipboard reads while allowing clipboard writes and fullscreen')
  check(await protectedStatus(browser) === 401, 'The fresh browser already had an owner session')
  await browser.keys(input, password)
  await browser.click(await element('.wb-auth button[type="submit"]', 'submit real browser owner login'))
  await element(chat, 'packaged Workbench chat after browser login')
  check(await protectedStatus(browser) === 200, 'Browser login did not authorize bootstrap')

  stage('display Linux server platform in packed settings')
  await verifyLinuxSettings(browser, element)
  stage('native document fullscreen enter and exit')
  await verifyFullscreen(browser, element, signal)
  stage('Ctrl+B sidebar collapse and restore')
  await verifySidebar(browser, element, signal)
  stage('read-only selection Copy without Quote, then trusted paste into a fresh draft')
  await verifyClipboard(browser, element, signal, fixture)
  stage('read-only fenced code header Copy, exact native paste to sidebar search and clear')
  await verifyCodeClipboard(browser, element, signal, fixture)
  await verifyNoRemoteClientEffects(browser)
  stage('confirm only expected chats, no active turns or runnable tasks')
  const freshId = await verifySessionsAndTasks(browser, fixture)

  stage('sign out and close browser owner session')
  await browser.click(await element(withinChat('settings'), 'open settings for sign-out'))
  await browser.click(await element('.wb-chat__logout', 'real owner sign-out'))
  await element(login, 'login form after browser owner logout')
  check(await protectedStatus(browser) === 401 && await browser.execute(`return !document.querySelector(arguments[0]);`, chat),
    'Signed-out browser retained protected access or the owner chat UI')
  return freshId
}
