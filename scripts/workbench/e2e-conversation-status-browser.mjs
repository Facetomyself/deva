import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual as equal } from 'node:util'
import { alternate, chatPath, check, endpoint, measured, modelRef, modelWindow, primary, prompts, providerName, replies } from './e2e-conversation-status-fixture.mjs'
import { waitFor } from './webdriver-local.mjs'

const hook = name => `[data-testid="workbench-${name}"]`
const chat = hook('chat')
const modelChip = `${chat} .cf-mp > .model-pick button[aria-haspopup="menu"]`
const meter = hook('context-meter'), ring = `${meter} button[aria-haspopup="dialog"]`, source = hook('context-source')
const composer = `${chat} .cf-draft__input[role="textbox"][contenteditable="true"]`
const send = `${chat} .cf-send:not(.is-stop)`
const completed = `${hook('turn-status')}[data-status="completed"]`
const otherTitle = 'New chat'

// Fixed read-only queries. Browser actions only use WebDriver's native click/key commands.
export const statusQueries = Object.freeze({
  node: `const [selector, label, child] = arguments;
    return [...document.querySelectorAll(selector)].find(node => node.getClientRects().length &&
      getComputedStyle(node).visibility === 'visible' && (label === null || (child ? node.querySelector(child) : node)?.textContent.trim() === label)) ?? null;`,
  absent: 'return !document.querySelector(arguments[0]);',
  auth: `return location.origin === arguments[0] && location.pathname === '/' && !location.search && !location.hash &&
    !document.querySelector(arguments[1]) && !document.querySelector('.wb-auth input[name="credential"]');`,
  rows: `const [title, active, read] = arguments;
    const hit = [...document.querySelectorAll('.cf-list .cf-thread')].find(el => el.querySelector('.cf-thread__title')?.textContent.trim() === title &&
      el.classList.contains('is-active') === active && el.getClientRects().length);
    if (!hit) return null;
    if (read !== null) {
      const dot = hit.querySelector('.cf-ava__dot');
      if (hit.closest('[data-read-state]')?.getAttribute('data-read-state') !== read || (read === 'unread' ?
          !dot?.getClientRects().length || getComputedStyle(dot).visibility !== 'visible' : !!dot)) return null;
    }
    return hit;`,
  focused: "return document.visibilityState === 'visible' && document.hasFocus();",
  reply: `const [text, streaming] = arguments;
    return [...document.querySelectorAll('[data-role="assistant"]')].some(row => row.getClientRects().length &&
      row.querySelector('.msg__text')?.textContent.trim() === text && (row.dataset.streaming === 'true') === streaming);`,
  choice: `const [provider, model] = arguments;
    const group = [...document.querySelectorAll('.cf-mp__group')].find(el => el.querySelector('.cf-mp__ghead')?.textContent.trim() === provider);
    return [...(group?.querySelectorAll('button[role="menuitemradio"]') ?? [])].find(el => !el.disabled && el.textContent.trim() === model && el.getClientRects().length) ?? null;`,
  meter: `const [wrapper, chip] = arguments;
    const ring = document.querySelector(wrapper), model = document.querySelector(chip);
    const a = ring?.getBoundingClientRect(), b = model?.getBoundingClientRect();
    return !!(a?.width && b?.width && a.right <= b.left + 1 && b.left - a.right < 48 && a.top < b.bottom && a.bottom > b.top &&
      ring.querySelector('svg.cf-mp__ring') && ring.closest('.cf-mp') === model.closest('.cf-mp'));`,
  card: `const [selector, state] = arguments;
    const label = document.querySelector(selector), card = label?.closest('.cf-mp__card[role="dialog"]');
    const text = card?.querySelector('.cf-mp__big')?.textContent.trim(), bar = card?.querySelector('.cf-mp__fill');
    if (!label?.getClientRects().length || !card?.getClientRects().length || label.dataset.source !== state || !text || !bar) return null;
    return { label: label.textContent.trim(), text, percentage: parseFloat(bar.style.width), trigger: !!card.querySelector('.cf-mp__tick') };`,
  removeModel: `const model = arguments[0];
    return [...document.querySelectorAll('.wb-settings .model-row')].find(row => row.querySelector('.model-row__name')?.textContent.trim() === model)
      ?.querySelector('button.model-row__act:nth-of-type(2)') ?? null;`,
  screenshot: `const [origin, selector] = arguments;
    const target = document.querySelector(selector), rect = target?.getBoundingClientRect();
    if (location.origin !== origin || location.pathname !== '/' || location.hash || location.search || !rect?.width || !rect.height ||
        rect.left < 0 || rect.top < 0 || rect.right > innerWidth || rect.bottom > innerHeight ||
        document.querySelector('.wb-auth,.wb-settings') || document.body.innerText.includes('http://') || document.body.innerText.includes('https://') ||
        [...document.querySelectorAll('input[type="password"],input[name*="credential"],input[name*="token"]')].some(el => el.value)) return null;
    return { width: innerWidth, height: innerHeight };`
})

function controls({ browser, signal }) {
  const q = (name, ...args) => browser.execute(statusQueries[name], ...args)
  const observe = (name, description, ...args) => waitFor(() => q(name, ...args), description, { signal })
  const node = (selector, label = null, child = null) => observe('node', `visible original ${selector}`, selector, label, child)
  const click = async (selector, label, child) => browser.click(await node(`${selector}:not(:disabled):not([aria-disabled="true"])`, label, child))
  return { q, observe, node, click, row: (title, active, read = null) => observe('rows', `conversation row selection and native ${read ?? 'neutral'} indicator`, title, active, read) }
}

export async function authenticateStatus(context, password, credential) {
  const { browser, origin } = context
  const ui = context.ui = controls(context)
  await browser.navigate(credential ? `${origin}/#claim=${encodeURIComponent(credential)}` : `${origin}/`)
  const field = await ui.node(`.wb-auth input[type="password"][autocomplete="${credential ? 'new' : 'current'}-password"]`)
  check(await ui.q('auth', origin, chat), 'Fresh owner form did not scrub the private claim fragment')
  await browser.keys(field, password)
  await ui.click('.wb-auth button[type="submit"]')
  await ui.node(chat)
}

async function select(ctx, title, read = null) {
  await ctx.browser.click(await ctx.ui.row(title, false, read))
  await ctx.ui.row(title, true)
}

async function chooseModel(ctx, name) {
  await ctx.ui.click(modelChip)
  await ctx.browser.click(await ctx.ui.observe('choice', 'enabled original model option', providerName, name))
  await ctx.ui.node(`${modelChip}:not(:disabled)`, name)
}

async function sendTurn(ctx, number) {
  const input = await ctx.ui.node(composer)
  await ctx.browser.click(input)
  await ctx.browser.keys(input, prompts[number - 1])
  await ctx.ui.click(send)
  const turn = await ctx.upstream.expect(number)
  await ctx.ui.observe('reply', 'actual assistant SSE fragment in the selected original conversation', replies[number - 1], true)
  return turn
}

export function exactUsage(body, ref, label) {
  check(body?.compaction === 'inactive' && body?.modelRef === ref && body?.source === label,
    `Expected honest inactive-compaction ${label} usage response for the selected model`)
  const usage = body.usage
  if (label === 'unavailable') return check(usage === null, 'Unavailable model retained a stale usage value')
  check(usage?.window === modelWindow && usage.trigger === null && usage.estimated === (label === 'estimate'),
    'Context window, estimate flag or inactive compaction trigger differed')
  check(label === 'none' ? usage.used === null : label === 'measured' ? usage.used === measured :
    Number.isSafeInteger(usage.used) && usage.used > 0 && usage.used < measured, 'Context usage token count differed')
}

async function expectBrowserUsage(ctx, mark, sid, requestRef, responseRef, label) {
  const response = await ctx.wire.after(mark, 'context-usage', row => row.owner === ctx.owner && row.sid === sid &&
    row.request?.model === requestRef && row.response?.source === label)
  check(response.status === 200 && response.authenticated && equal(response.request, { model: requestRef }),
    'Browser meter used an unexpected context metadata request')
  exactUsage(response.response, responseRef, label)
}

async function openMeter(ctx, label) {
  await ctx.ui.observe('meter', 'actual ContextRing immediately before the model control', meter, modelChip)
  await ctx.ui.click(ring)
  const value = await ctx.ui.observe('card', 'visible explicit usage source and original ContextRing progress bar', source, label)
  check(!value.trigger, 'Inactive Workbench unexpectedly rendered the auto-compaction tick')
  if (label === 'measured') {
    check(value.label === 'Previous request · measured input tokens' && /\(25(?:\.0)?%\)/.test(value.text) && value.percentage === 25,
      'Original ContextRing did not display the explicit measured label and exact 25%')
  } else check(value.label === 'Estimate from saved conversation history' && value.percentage >= 0 && value.percentage < 25 && !/\(25(?:\.0)?%\)/.test(value.text),
    'Original ContextRing retained measured presentation after switching to estimated usage')
  return value
}

export async function readNativeMarker(fixture, sid) {
  let handle
  try { handle = await open(join(fixture.dataDir, 'read-state.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
  catch (error) { if (error.code === 'ENOENT') return { at: null, stamp: null }; throw error }
  try {
    const stat = await handle.stat({ bigint: true })
    check(stat.isFile() && stat.uid === BigInt(process.geteuid()) && stat.nlink === 1n && (stat.mode & 0o077n) === 0n && stat.size < 64_000n,
      'Native read state was not a bounded, private ordinary file')
    const json = JSON.parse(await handle.readFile('utf8'))
    return { at: json[sid] ?? null, stamp: [stat.dev, stat.ino, stat.mtimeNs, stat.ctimeNs] }
  } finally { await handle.close() }
}

function readRow(value, sid) { return value?.entries?.find(row => row.id === sid) }
async function nativeSnapshot(ctx, sid) {
  const result = await ctx.wire.get(ctx.owner, chatPath(sid))
  check(result.status === 200 && result.body?.state?.id === sid && result.body.cursor?.seq >= 0,
    'Independent authenticated GET did not obtain the native snapshot and cursor')
  return result.body
}

async function peerReadback(ctx, mark, sid, snapshot, unread) {
  const row = await ctx.wire.after(mark, 'reads', entry => entry.owner === ctx.owner && (() => {
    const row = readRow(entry.response, sid)
    return row?.updatedAt === snapshot.state.updatedAt && row.unread === unread
  })())
  check(row.status === 200 && row.method === 'GET', 'Profile did not learn status through an authorized GET')
  return readRow(row.response, sid)
}

async function finishAwayAndRead(sender, viewer, sid, turn, number, save, previous, stage) {
  const title = prompts[0]
  await sender.ui.row(title, true)
  await select(sender, otherTitle)
  await viewer.browser.click(await viewer.ui.row(otherTitle, true))
  await viewer.ui.observe('focused', 'real foreground other-conversation page, with target not selected')
  const mark = sender.wire.mark()
  const before = await readNativeMarker(sender.fixture, sid)
  check(before.at === previous && !sender.wire.rows('read-state').some(row => row.sid === sid && row.request?.updatedAt > (previous ?? 0)),
    'A streaming or unattended target was marked read early')
  turn.complete()
  const snapshot = await waitFor(async () => {
    const next = await nativeSnapshot(sender, sid)
    return next.state.lastTurn?.status === 'completed' && next.state.messages?.at(-1)?.content === replies[number - 1] && next
  }, 'completed native assistant snapshot while both real pages are in another conversation', { signal: sender.signal })
  const unread = await peerReadback(viewer, mark, sid, snapshot, true)
  check(unread.readAt === previous && equal(await readNativeMarker(sender.fixture, sid), before),
    'Unattended completed reply advanced the native read timestamp')
  await viewer.ui.row(title, false, 'unread')
  await sender.ui.row(title, false, 'unread')
  if (number === 1 && save) await save(viewer, 'read-indicator.png', `.cf-list [data-read-state="unread"] .cf-ava__dot`)

  stage(`explicitly view reply ${number} with real focus and propagate exactly one native read`)
  const listener = await sender.openList(sender.owner)
  try {
    await listener.next('sessions-snapshot')
    const readMark = sender.wire.mark()
    await select(viewer, title, 'unread')
    await viewer.ui.observe('focused', 'real focused target page after trusted sidebar click')
    await viewer.ui.node(completed)
    await viewer.ui.observe('reply', 'the completed reply is visibly rendered before acknowledging the snapshot', replies[number - 1], false)
    const committed = await sender.wire.after(readMark, 'read-state', row => row.owner === viewer.owner && row.sid === sid)
    const expected = { cursor: snapshot.cursor, updatedAt: snapshot.state.updatedAt }
    const at = committed.response?.readAt
    check(committed.authenticated && committed.status === 200 && equal(committed.request, expected) &&
      equal(committed.response, { id: sid, updatedAt: expected.updatedAt, readAt: at, unread: false, changed: true }) &&
      Number.isSafeInteger(at) && at === expected.updatedAt && at !== previous, 'Read write did not match the exact native cursor, timestamp and authorized single commit')
    const native = await readNativeMarker(sender.fixture, sid)
    check(native.at === at, 'Native timestamp disagreed with the confirmed read command')
    await listener.next('sessions-changed') // Cursor only; no transcript, read data, model or provider fields.
    const remote = await peerReadback(sender, readMark, sid, snapshot, false)
    check(remote.readAt === at, 'Idle peer readback did not expose the same authorized native timestamp')
    await sender.ui.row(title, false, 'read') // Its current conversation never changed during the peer read.
    return { at, native, readMark }
  } finally { listener.close() }
}

async function setUpThreads(first, second, stage) {
  const { wire, upstream } = first
  stage('create two native workbench threads with separate owner profiles')
  let mark = wire.mark()
  await first.ui.click(hook('new-chat'))
  const other = (await wire.after(mark, 'create', row => row.owner === first.owner)).response?.session?.id
  check(other, 'Expected the original New Chat action to create the other conversation')
  await first.ui.row(otherTitle, true)
  // The second owner explicitly clicks inside Other (with the actual current selection),
  // giving the ambient page native focus before either target turn can complete.
  await second.browser.click(await second.ui.row(otherTitle, true))
  await second.ui.observe('focused', 'second physical owner has genuine focus in the other conversation')
  mark = wire.mark()
  await first.ui.click(hook('new-chat'))
  const target = (await wire.after(mark, 'create', row => row.owner === first.owner)).response?.session?.id
  check(target && target !== other, 'Expected independent target and other chats')
  await expectBrowserUsage(first, mark, target, null, modelRef(primary), 'none')
  await first.ui.node(`${source}[data-source="none"]`, 'No context usage yet')
  await first.ui.observe('absent', 'empty history has no stale meter', meter)
  upstream.assertCount(0)
  return target
}

async function removePinnedModel(ctx) {
  await ctx.ui.click(hook('settings'))
  await ctx.ui.click('.wb-settings .provider-row', providerName, '.provider-row__name-text')
  await ctx.browser.click(await ctx.ui.observe('removeModel', 'remove the actual pinned synthetic model from settings', alternate))
  await ctx.ui.click(hook('settings-close'))
  await ctx.ui.node(`${source}[data-source="unavailable"]`, 'Context usage unavailable')
  await ctx.ui.observe('absent', 'deleted selected model cleared stale original ContextRing', meter)
}

export async function verifyStatusInChrome(first, second, stage, save) {
  const { wire, upstream } = first
  ;[first.owner, second.owner] = wire.assertAuth()
  const sid = await setUpThreads(first, second, stage)

  stage('pin the visible measured model, send a real turn, then leave both profiles on Other before completion')
  await chooseModel(first, primary)
  const firstTurn = await sendTurn(first, 1)
  const once = await finishAwayAndRead(first, second, sid, firstTurn, 1, save, null, stage)
  await expectBrowserUsage(second, once.readMark, sid, modelRef(primary), modelRef(primary), 'measured')
  await second.ui.node(modelChip, primary)
  const measuredCard = await openMeter(second, 'measured')
  if (save) await save(second, 'context-meter.png', `${source}[data-source="measured"]`)
  await second.ui.click(ring)
  upstream.assertCount(1)

  stage('reselect and refocus captured reply; change model and verify estimate without another call')
  await select(second, otherTitle)
  await select(second, prompts[0], 'read')
  await second.ui.observe('focused', 'genuine focus remains on the re-read reply')
  await second.ui.observe('reply', 'unchanged reply after repeated real selection', replies[0], false)
  await select(second, otherTitle)
  await select(first, prompts[0], 'read')
  const switched = wire.mark()
  await chooseModel(first, alternate)
  await expectBrowserUsage(first, switched, sid, modelRef(alternate), modelRef(alternate), 'estimate')
  const estimatedCard = await openMeter(first, 'estimate')
  await first.ui.click(ring)
  check(equal(await readNativeMarker(first.fixture, sid), once.native) && wire.rows('read-state').filter(r => r.sid === sid).length === 1,
    'Repeated focus or selection issued a second read write or modified the native file')
  upstream.assertCount(1)

  stage('complete a real no-usage reply and retain honest estimation')
  const secondTurn = await sendTurn(first, 2)
  const twice = await finishAwayAndRead(first, second, sid, secondTurn, 2, undefined, once.at, stage)
  await expectBrowserUsage(second, twice.readMark, sid, modelRef(alternate), modelRef(alternate), 'estimate')
  await openMeter(second, 'estimate')
  await second.ui.click(ring)

  stage('remove the pinned model through Settings and verify the stale meter disappears')
  await removePinnedModel(second)
  check(equal(await readNativeMarker(first.fixture, sid), twice.native) && wire.rows('read-state').length === 2,
    'The second snapshot was re-marked or the native marker unexpectedly changed')
  const turns = wire.rows('turns')
  check(turns.length === 2 && turns.every(row => row.sid === sid && row.owner === first.owner && row.status === 202),
    'Expected only the two explicitly sent browser turns')
  wire.assertSound()
  upstream.assertCount(2)
  return { distinctOwnerSessions: true, unattendedReadWrites: 0, focusedReadWrites: 2, staleMeterRemoved: true,
    measuredPercent: measuredCard.percentage, measuredLabel: measuredCard.label, estimateLabel: estimatedCard.label,
    cursorOnlyScopedInvalidation: true, modelCalls: 2 }
}

export async function captureDirectory(base = fileURLToPath(new URL('../../test-results/conversation-status', import.meta.url))) {
  const parent = join(base, '..')
  for (const part of [parent, base]) {
    await mkdir(part, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
    const info = await lstat(part)
    check(info.isDirectory() && info.uid === process.geteuid() && await realpath(part) === part, 'Capture ancestor is not canonical and owned')
  }
  const path = await mkdtemp(join(base, 'pr18-'))
  const info = await lstat(path)
  check((info.mode & 0o777) === 0o700 && info.uid === process.geteuid(), 'Capture directory is not private')
  return { path, async save(ctx, name, selector) {
    check(['read-indicator.png', 'context-meter.png'].includes(name), 'Unexpected synthetic capture name')
    const viewport = await ctx.ui.q('screenshot', ctx.origin, selector)
    check(viewport?.width >= 800 && viewport.height >= 600 && viewport.width <= 1920 && viewport.height <= 1200,
      'Capture requires guarded actual synthetic DOM and a bounded viewport')
    const value = await ctx.browser.fixtureScreenshot()
    check(typeof value === 'string' && value.length > 1024 && value.length < 4 * 1024 * 1024, 'Unexpected bounded viewport encoding')
    const bytes = Buffer.from(value, 'base64')
    check(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) === viewport.width && bytes.readUInt32BE(20) === viewport.height &&
      bytes.toString('ascii', bytes.length - 8, bytes.length - 4) === 'IEND', 'Browser did not produce a complete viewport PNG')
    await writeFile(join(path, name), bytes, { flag: 'wx', mode: 0o600 })
  } }
}
