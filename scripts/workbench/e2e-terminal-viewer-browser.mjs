import { constants } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, terminalExpected } from './e2e-terminal-viewer-fixture.mjs'
import { waitFor } from './webdriver-local.mjs'

const hook = name => `[data-testid="${name}"]`
const workspace = name => hook(`workbench-workspace-${name}`)
const tty = name => hook(`workbench-tty-${name}`)
const chat = hook('workbench-chat')
const dialog = `dialog${workspace('dialog')}[open]`
const inDialog = selector => `${dialog} ${selector}`
const login = '.wb-auth input[name="password"][type="password"][autocomplete="current-password"]'
const workspaceId = /^w_[0-9a-f]{32}$/
const terminalId = /^pt_[0-9a-f]{32}$/
const profiles = '/api/v1/terminal/profiles'
const storageRead = /^\/api\/v1\/workspaces\/w_[0-9a-f]{32}\/(list|read)$/
const terminalRoute = /^\/api\/v1\/workspaces\/(w_[0-9a-f]{32})\/terminals(?:\/(pt_[0-9a-f]{32})\/(input|resize|events|dispose))?$/
const nativeKeys = { PageDown: '\uE00F', End: '\uE010', Home: '\uE011', quit: 'q' }
const knownBootReads = new Set(['/api/v1/bootstrap', '/api/v1/chats'])
const captureDir = new URL('../../test-results/terminal-viewer/', import.meta.url)
const captureFile = new URL('pty-screen.png', captureDir)

function controls(browser, signal) {
  const until = (probe, description) => waitFor(probe, description, { signal })
  const visible = (selector, description) => until(() => browser.execute(`
    return [...document.querySelectorAll(arguments[0])].find(node => node.getClientRects().length &&
      getComputedStyle(node).visibility === 'visible' && !node.matches(':disabled')) ?? null;
  `, selector), description)
  return {
    until, visible,
    click: async (selector, description) => browser.click(await visible(selector, description)),
    gone: (selector, description) => until(() => browser.execute('return !document.querySelector(arguments[0]);', selector), description)
  }
}

// Browser Resource Timing observes the deployed site as-is, including in Compose. No monkey
// patching fetch, injecting handlers, intercepting server traffic, or calling action routes.
function traffic(browser) {
  return browser.execute(`
    return performance.getEntriesByType('resource').map(row => {
      const url = new URL(row.name);
      return { sameOrigin: url.origin === location.origin, path: url.pathname,
        query: !!url.search, status: row.responseStatus, start: row.startTime, kind: row.initiatorType };
    }).filter(row => row.kind === 'fetch' || row.kind === 'xmlhttprequest' || row.path.startsWith('/api/'));
  `)
}

function terminalTraffic(rows) {
  return rows.filter(row => /(?:^|\/)(?:terminals?|tty|shell)(?:\/|$)/i.test(row.path))
}

function verifyReadingTraffic(rows, start, wid) {
  check(rows.length < 200, 'Unexpected volume of browser API traffic')
  for (const row of rows.filter(entry => entry.start >= start)) {
    const route = terminalRoute.exec(row.path)
    check(row.sameOrigin && !row.query && (row.path === profiles || row.path === '/api/v1/workspaces' ||
      (storageRead.test(row.path) && row.path.startsWith(`/api/v1/workspaces/${wid}/`)) || route?.[1] === wid ||
      (knownBootReads.has(row.path) && row.status === 200)),
    'Workspace reading invoked an unexpected API (chat action, model, write, Git, shell, or foreign origin)')
  }
}

async function loginStatus(browser) {
  return browser.executeAsync(`
    const finish = arguments[arguments.length - 1];
    fetch('/api/v1/bootstrap', { credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
      .then(response => finish(response.status), () => finish(0));
  `)
}

async function logIn(browser, ui, origin, password) {
  await browser.navigate(`${origin}/`)
  const field = await ui.visible(login, 'claimed Workbench login form in fresh Chrome')
  check(await browser.execute(String.raw`
    return location.origin === arguments[0] && location.pathname === '/' && !location.hash && !location.search &&
      navigator.webdriver && /HeadlessChrome\//.test(navigator.userAgent) && isSecureContext;
  `, origin), 'Unexpected original login page or browser')
  check(await loginStatus(browser) === 401, 'Fresh Chrome already had protected owner access')
  await browser.keys(field, password)
  await ui.click('.wb-auth button[type="submit"]', 'submit owner login through the real UI')
  await ui.visible(chat, 'authenticated Workbench shell')
  check(await loginStatus(browser) === 200, 'Browser UI login did not authorize owner bootstrap')
}

async function logOut(browser, ui) {
  // On the happy path the workspace is already closed. Also clear it before logout if a
  // verification assertion interrupted the flow, so its native modality cannot trap Settings.
  if (await browser.execute('return !!document.querySelector(arguments[0]);', dialog)) {
    await ui.click(inDialog(workspace('close')), 'close workspace dialog before owner sign-out')
    await ui.gone(dialog, 'workspace dialog closed before sign-out')
  }
  await ui.click(`${chat} ${hook('workbench-settings')}`, 'open real Workbench Settings')
  await ui.click('.wb-chat__logout', 'sign out with the owner settings button')
  await ui.visible(login, 'owner login form after sign-out')
  check(await loginStatus(browser) === 401 && await browser.execute('return !document.querySelector(arguments[0]);', chat),
    'Browser retained protected access or the owner Workbench after sign-out')
}

async function selectFixture(browser, ui, expected) {
  await ui.click(workspace('open'), 'open the real workspace dialog')
  await ui.visible(dialog, 'native modal workspace dialog')
  const field = await ui.visible(inDialog(`select${workspace('select')}`), 'workspace project selector')
  const option = await ui.until(() => browser.execute(`
    const [field, name] = arguments;
    return [...field.options].find(option => !option.disabled && option.value && option.textContent.trim() === name) ?? null;
  `, field, expected.project), 'registered synthetic project option')
  await browser.click(option)
  const wid = await ui.until(() => browser.execute(`
    const [field, option] = arguments;
    return field.selectedOptions[0] === option && field.value;
  `, field, option), 'workspace selected through native option click')
  check(workspaceId.test(wid), 'Expected an opaque workspace identifier')
  const entry = await ui.until(() => browser.execute(`
    return [...document.querySelectorAll(arguments[0])].find(row => row.dataset.path === arguments[1] &&
      row.dataset.type === 'file' && row.getClientRects().length && !row.disabled) ?? null;
  `, inDialog(workspace('entry')), expected.file), 'authorized fixture file in the workspace tree')
  await browser.click(entry)
  await ui.until(() => browser.execute(`
    const [editor, readonly, save, expected] = arguments;
    const node = document.querySelector(editor);
    return node instanceof HTMLTextAreaElement && node.getClientRects().length && node.readOnly && node.value === expected &&
      !!document.querySelector(readonly) && document.querySelector(save)?.disabled === true;
  `, inDialog(workspace('editor')), inDialog(`${workspace('status')}[data-status="readonly"]`),
  inDialog(workspace('save')), `${expected.lines.join('\n')}\n`), 'exact synthetic document preview with a read-only editor and disabled Save')
  await ui.visible(inDialog(tty('open')), 'explicit terminal viewer action for the granted read-only file')
  check(terminalTraffic(await traffic(browser)).length === 0 && await browser.execute(`
    return !document.querySelector(arguments[0]);
  `, tty('panel')), 'A terminal request or panel was present before explicit viewer open')
  return wid
}

function successful(row) { return row.status >= 200 && row.status < 300 }

async function terminalResource(browser, ui, wid, from) {
  return ui.until(async () => {
    const rows = await traffic(browser)
    const fresh = rows.filter(row => row.start >= from)
    const created = fresh.filter(row => row.path === `/api/v1/workspaces/${wid}/terminals`)
    check(created.length <= 1, 'One explicit click attempted to create more than one viewer')
    if (!created.length) return null
    check(created[0].status === 201, 'The real browser create request did not return HTTP 201')
    const handles = new Set(fresh.map(row => terminalRoute.exec(row.path)).filter(match => match?.[1] === wid && match[3] === 'events').map(match => match[2]))
    check(handles.size <= 1, 'One explicit open contacted multiple viewer resources')
    const [id] = handles
    return terminalId.test(id) ? id : null
  }, 'real creation and event traffic for one opaque viewer')
}

async function recordTime(browser) { return browser.execute('return performance.now();') }

async function viewerFrame({ browser, ui, lines }, shape, description) {
  const [cols, rows, top] = shape
  const visibleLines = lines.slice(top, top + rows)
  await ui.until(() => browser.execute(`
    const [screenSelector, statusSelector, receiptSelector, cols, rows, top, total, text] = arguments;
    const screen = document.querySelector(screenSelector);
    const status = document.querySelector(statusSelector);
    const receipt = document.querySelector(receiptSelector);
    return screen?.localName === 'pre' && screen.tabIndex === 0 && screen.getClientRects().length &&
      getComputedStyle(screen).visibility === 'visible' && status?.dataset.status === 'active' &&
      Number(screen.dataset.cols) === cols && Number(screen.dataset.rows) === rows &&
      Number(screen.dataset.top) === top && Number(screen.dataset.left) === 0 &&
      Number(screen.dataset.totalLines) === total && screen.textContent === text && !screen.children.length &&
      !!receipt?.getClientRects().length && receipt.textContent.includes(cols + ' × ' + rows);
  `, inDialog(tty('screen')), inDialog(tty('status')), inDialog(tty('receipt')),
  cols, rows, top, lines.length, visibleLines.join('\n')), description)
}

async function nativeKey({ browser, ui }, key) {
  const screen = await ui.visible(inDialog(tty('screen')), 'keyboard-focusable real viewer screen')
  await browser.click(screen)
  check(await browser.execute('return document.activeElement === arguments[0];', screen), 'Native click did not focus the viewer screen')
  await browser.keys(screen, nativeKeys[key])
}

async function captureSynthetic({ browser, expected }) {
  if (process.env.DEVA_QA_TERMINAL_CAPTURE !== '1') return
  check(expected.project === terminalExpected.project && expected.file === terminalExpected.file &&
    expected.lines.length === terminalExpected.lines.length && expected.lines.every((line, i) => line === terminalExpected.lines[i]),
  'Screenshot capture requires the known synthetic terminal fixture')
  check(await browser.execute(`
    const [dialogSelector, screenSelector, receiptSelector, login, primaryControls, editorSelector, launchSelector] = arguments;
    const dialog = document.querySelector(dialogSelector);
    const screen = document.querySelector(screenSelector), receipt = document.querySelector(receiptSelector);
    if (!dialog?.open || !screen || !receipt || document.querySelector(login)) return false;
    const bounds = dialog.getBoundingClientRect();
    const clear = element => {
      if (!element) return false;
      const { top, bottom, left, right, width, height } = element.getBoundingClientRect();
      return width > 0 && height > 0 && top >= Math.max(0, bounds.top) && bottom <= Math.min(innerHeight, bounds.bottom) &&
        left >= Math.max(0, bounds.left) - 1 && right <= Math.min(innerWidth, bounds.right) + 1;
    };
    return clear(screen) && clear(receipt) && primaryControls.every(selector=>clear(dialog.querySelector(selector))) &&
      !dialog.querySelector(editorSelector) && !dialog.querySelector(launchSelector) &&
      getComputedStyle(receipt).color !== getComputedStyle(screen).color &&
      ![...document.querySelectorAll('input')].some(field => field.value && field.getClientRects().length > 0);
  `, dialog, inDialog(tty('screen')), inDialog(tty('receipt')), login,
    ['previous','next','size','quit'].map(tty), workspace('editor'), tty('open')),
  'Screenshot requires the full numbered screen, primary navigation and native receipt without a duplicate editor or launch action')
  const directory = dirname(fileURLToPath(captureFile)), root = dirname(directory)
  await mkdir(root, { recursive: true, mode: 0o700 })
  check((await lstat(root)).isDirectory(), 'The fixed screenshot root must be an ordinary directory')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  check((await lstat(directory)).isDirectory(), 'The fixed screenshot directory must be an ordinary directory')
  const image = Buffer.from(await browser.fixtureScreenshot(), 'base64')
  check(image.length > 8 && image.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')), 'Chrome returned an invalid viewport screenshot')
  const handle = await open(fileURLToPath(captureFile), constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
  try {
    const stat = await handle.stat()
    check(stat.isFile() && stat.nlink === 1 && stat.uid === process.geteuid(), 'The fixed screenshot target must be a private ordinary file')
    await handle.chmod(0o600)
    await handle.truncate(0)
    await handle.writeFile(image)
  } finally {
    await handle.close()
  }
}

async function checkViewerControls({ browser, ui }) {
  for (const [name, description] of [['next', 'next page'], ['previous', 'previous page'], ['quit', 'quit'], ['size', 'viewport size'], ['close', 'close viewer']]) {
    await ui.visible(inDialog(`button${tty(name)}`), `fixed ${description} viewer control`)
  }
  check(await browser.execute(`
    const panel = document.querySelector(arguments[0]);
    return panel && !panel.querySelector('input, textarea, select, [contenteditable], iframe, a[href], [data-qa-pager]');
  `, inDialog(tty('panel'))), 'Viewer exposed command/path entry, navigation, or rendered fixture markup as HTML')
}

// CLI/browser test readback is limited to the original authenticated resource and to a
// non-blocking events cursor. Bootstrap CSRF and the owner cookie stay inside Chrome.
async function readEvents(browser, wid, id, after) {
  check(workspaceId.test(wid) && terminalId.test(id) && Number.isSafeInteger(after) && after >= 0,
    'Invalid original viewer resource for events readback')
  return browser.executeAsync(`
    const [wid, id, after, done] = arguments;
    const init = { credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store' };
    (async () => {
      const boot = await fetch('/api/v1/bootstrap', init);
      if (boot.status !== 200) return null;
      const { csrf } = await boot.json();
      if (typeof csrf !== 'string' || !csrf) return null;
      const event = await fetch('/api/v1/workspaces/' + wid + '/terminals/' + id + '/events', {
        ...init, method: 'POST', headers: { 'content-type': 'application/json', 'x-deva-csrf': csrf },
        body: JSON.stringify({ after, waitMs: 0 })
      });
      return { status: event.status, body: await event.json() };
    })().then(done, () => done(null));
  `, wid, id, after)
}

async function verifyQuitEvents({ browser, ui, lines, wid }, id, shapes) {
  const expectedCursor = shapes.length + 1
  const reply = await ui.until(async () => {
    const state = await readEvents(browser, wid, id, 0)
    return state?.status === 429 ? null : state
  }, 'authenticated non-blocking readback for the exited viewer')
  const batch = reply.body
  check(reply.status === 200 && batch?.cursor === expectedCursor && batch.reset === false && batch.events?.length === expectedCursor,
    'Native viewer event journal did not contain exactly the expected screen and exit sequence')
  for (const [i, [cols, rows, top]] of shapes.entries()) {
    const event = batch.events[i]
    const screen = event?.screen
    check(event?.seq === i + 1 && event.type === 'screen' && screen?.cols === cols && screen.rows === rows &&
      screen.top === top && screen.left === 0 && screen.totalLines === lines.length && Array.isArray(screen.lines) &&
      screen.lines.length === rows && screen.lines.every((line, j) => line === lines[top + j]),
    `Viewer screen event ${i + 1} disagreed with the numbered fixture currently rendered by the browser`)
  }
  const exit = batch.events.at(-1)
  check(exit?.type === 'exit' && exit.seq === expectedCursor && exit.exit?.code === 0 && exit.exit.signal === null && exit.exit.reason === 'quit',
    'The single terminal exit was not the native clean code 0 from q')
  const again = await readEvents(browser, wid, id, expectedCursor)
  check(again?.status === 200 && again.body?.cursor === expectedCursor && again.body.reset === false && again.body.events?.length === 0,
    'Reading from the native exit cursor returned a duplicate or changed receipt')
}

function viewerRequests(rows, wid, id, action) {
  return rows.filter(row => row.path === `/api/v1/workspaces/${wid}/terminals/${id}/${action}`)
}

async function waitForDispose({ browser, ui, wid }, id, afterClick) {
  await ui.until(async () => {
    const requests = viewerRequests(await traffic(browser), wid, id, 'dispose')
    check(requests.length <= 1 && requests.every(row => row.start >= afterClick), 'Viewer sent a premature or duplicate dispose request')
    if (!requests.length) return false
    check(requests[0].status === 200, 'Real viewer disposal did not return HTTP 200')
    return true
  }, 'original viewer released by the real UI close')
}

async function firstViewer(ctx, openedAt) {
  const { browser, ui, lines, wid } = ctx
  const shapes = [[80, 12, 0], [80, 12, 12], [80, 12, 24], [64, 8, 24], [80, 12, 24],
    [80, 12, lines.length - 12], [80, 12, 0]]
  await ui.click(inDialog(tty('open')), 'explicitly open the first Linux PTY viewer')
  await viewerFrame(ctx, shapes[0], 'real initial 80×12 screen matches the numbered fixture, Unicode and literal quoted markup')
  await checkViewerControls(ctx)
  await captureSynthetic(ctx)
  await ctx.onViewerOpened?.()

  const pageAt = await recordTime(browser)
  await nativeKey(ctx, 'PageDown')
  await viewerFrame(ctx, shapes[1], 'one native PageDown updates the physical viewer to its distinct next page')
  const id = await terminalResource(browser, ui, wid, openedAt)
  await ui.until(async () => (await recordTime(browser)) - pageAt >= 120, 'allow the native key cadence before the next page command')
  await ui.click(inDialog(tty('next')), 'visible Next page button')
  await viewerFrame(ctx, shapes[2], 'Next page button advances the real PTY further')

  for (const [i, description] of [[3, 'shrink to 64×8'], [4, 'restore 80×12']]) {
    await ui.click(inDialog(tty('size')), `real size control: ${description}`)
    await viewerFrame(ctx, shapes[i], `physical screen confirms ${description}, preserving the scrolling anchor`)
  }
  const endAt = await recordTime(browser)
  await nativeKey(ctx, 'End')
  await viewerFrame(ctx, shapes[5], 'native End anchors the last source line and terminal newline')
  await ui.until(async () => (await recordTime(browser)) - endAt >= 120, 'allow the native key cadence before Home')
  await nativeKey(ctx, 'Home')
  await viewerFrame(ctx, shapes[6], 'native Home restores the exact real first page')

  await nativeKey(ctx, 'quit')
  await ui.visible(inDialog(`${tty('status')}[data-status="exited"][data-code="0"][data-signal="null"][data-reason="quit"]`),
    'visible clean native exit code 0 from a single real q')
  await verifyQuitEvents(ctx, id, shapes)
  const end = await traffic(browser)
  const inputs = viewerRequests(end, wid, id, 'input').sort((a, b) => a.start - b.start)
  const resize = viewerRequests(end, wid, id, 'resize')
  // The independent exit event can cancel q's HTTP acknowledgement before Resource
  // Timing records it. The native exit/cursor above, not that acknowledgement, proves q.
  check((inputs.length === 4 || inputs.length === 5) && inputs.slice(0, 4).every(successful) &&
    (inputs.length === 4 || successful(inputs[4]) || inputs[4].status === 0) && resize.length === 2 && resize.every(successful),
  'Unexpected or duplicate real input/resize requests for the first viewer')
  const closingAt = await recordTime(browser)
  await ui.click(inDialog(tty('close')), 'explicitly close the exited viewer panel')
  await ui.gone(tty('panel'), 'viewer panel removed after its close button')
  await ui.visible(dialog, 'closing the viewer panel preserves the native workspace dialog')
  const launch = await ui.visible(inDialog(tty('open')), 'launch control restored after closing viewer')
  await ui.until(() => browser.execute(`return document.activeElement===arguments[0] && document.querySelector(arguments[1])?.value===arguments[2];`,
    launch, inDialog(workspace('editor')), `${ctx.expected.lines.join('\n')}\n`), 'focus returns to the launch control and the saved editor is restored')
  await waitForDispose(ctx, id, closingAt)
  return id
}

async function secondViewer(ctx, firstId) {
  const { browser, ui, wid } = ctx
  const openedAt = await recordTime(browser)
  await ui.click(inDialog(tty('open')), 'explicitly open a second independent live viewer')
  await viewerFrame(ctx, [80, 12, 0], 'fresh live viewer starts on the real first page again')
  await ctx.onViewerOpened?.()
  const id = await terminalResource(browser, ui, wid, openedAt)
  check(id !== firstId, 'Opening the file again reused the prior terminal resource')
  const closingAt = await recordTime(browser)
  await ui.click(inDialog(workspace('close')), 'close the entire workspace dialog while the second viewer is live')
  await ui.gone(dialog, 'workspace dialog removed')
  await ui.gone(tty('panel'), 'live viewer removed with the workspace dialog')
  await waitForDispose(ctx, id, closingAt)
  const state = await readEvents(browser, wid, id, 0)
  check(state?.status === 404 && state.body?.error === 'terminal_not_found',
    'The prior authenticated resource retained its live viewer or screen after closing the dialog')
  return id
}

async function verifyNarrowApi({ browser, wid }, id) {
  const result = await browser.executeAsync(`
    const [wid, id, done] = arguments;
    const init = { credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store' };
    (async () => {
      const get = path => fetch('/api/v1/' + path, init);
      const profiles = await get('terminal/profiles');
      const body = await profiles.json();
      if (profiles.status !== 200 || body.available !== true || body.reason !== null || body.profiles?.length !== 1 ||
          body.profiles[0].id !== 'text-view' || body.profiles[0].label !== 'Read-only text viewer') return false;
      const base = 'workspaces/' + wid + '/terminals/' + id;
      const candidates = ['shell', 'terminal', 'terminal/shell', 'terminal/path', 'terminal/cwd',
        'workspaces/' + wid + '/shell', base + '/shell', base + '/cwd', base + '/path'];
      for (const route of candidates) {
        const response = await get(route);
        if (response.status !== 404 || (await response.json()).error !== 'not_found') return false;
      }
      return true;
    })().then(done, () => done(false));
  `, wid, id)
  check(result === true, 'Only the fixed text-view profile should be available; shell, path and cwd routes must be absent')
}

async function emptyChatList(browser) {
  const empty = await browser.executeAsync(`
    const done = arguments[arguments.length - 1];
    fetch('/api/v1/chats', { credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store' })
      .then(async response => response.status === 200 && (await response.json()).sessions?.length === 0)
      .then(done, () => done(false));
  `)
  check(empty === true, 'Expected an empty instance with no chat created during the terminal flow')
}

async function drive(browser, ui, expected, onViewerOpened) {
  await ui.until(async () => (await traffic(browser)).some(row => row.path === '/api/v1/personas' && row.status === 200),
    'finish the ordinary Workbench shell startup reads')
  await emptyChatList(browser)
  const start = await recordTime(browser)
  const wid = await selectFixture(browser, ui, expected)
  const openedAt = await recordTime(browser)
  const ctx = { browser, ui, wid, expected, lines: [...expected.lines, ''], onViewerOpened }
  const firstId = await firstViewer(ctx, openedAt)
  const lastId = await secondViewer(ctx, firstId)
  const rows = await traffic(browser)
  const terminal = terminalTraffic(rows)
  const creations = terminal.filter(row => row.path === `/api/v1/workspaces/${wid}/terminals`)
  const catalog = terminal.filter(row => row.path === profiles)
  check(terminal.every(row => row.start >= openedAt) && catalog.length === 2 && catalog.every(successful) &&
    creations.length === 2 && creations.every(row => row.status === 201),
  'Expected exactly two explicit profile-and-create flows and no terminal traffic before the first click')
  check(terminal.every(row => {
    const match = terminalRoute.exec(row.path)
    return row.path === profiles || (match?.[1] === wid && (!match[2] || match[2] === firstId ||
      (match[2] === lastId && (match[3] === 'events' || match[3] === 'dispose'))))
  }), 'Reading called a terminal action outside the two explicitly opened resources')
  verifyReadingTraffic(rows, start, wid)
  await emptyChatList(browser)
  await verifyNarrowApi(ctx, lastId)
}

/** Drive the deployed Workbench's original UI. Caller starts/owns a fresh, sandboxed
 * webdriver-local browser and provisioned read-only Linux fixture; this logs in and out. */
export async function verifyTerminalBrowser({ browser, origin, password, signal, expected, onViewerOpened }) {
  const url = new URL(origin)
  check(url.href === `${url.origin}/` && /^http:\/\/127\.0\.0\.1:\d+$/.test(url.origin), 'Use the fresh loopback Workbench origin')
  check(typeof password === 'string' && password.length >= 12 && typeof expected?.project === 'string' && typeof expected.file === 'string' &&
    Array.isArray(expected.lines) && expected.lines.length > 36 && expected.lines.every(line => typeof line === 'string' && !/[\r\n\t]/.test(line)),
  'Expected an isolated multiline read-only workspace fixture and claimed owner password')
  const ui = controls(browser, signal)
  let failure
  try {
    await logIn(browser, ui, url.origin, password)
    await drive(browser, ui, expected, onViewerOpened)
  } catch (error) {
    failure = error
  } finally {
    try {
      if (await browser.execute('return !!document.querySelector(arguments[0]);', chat)) await logOut(browser, ui)
      else if (!failure) check(false, 'The authenticated UI disappeared before explicit sign-out')
    } catch (error) {
      if (!failure) failure = error
    }
  }
  if (failure) throw failure
}
