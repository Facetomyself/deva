import { randomBytes } from 'node:crypto'
import { access, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { requestControl } from '../../apps/headless/src/control/socket.mjs'
import { DEFAULT_WEB_DIR, startWorkbench } from '../../apps/headless/src/server.mjs'
import { initializeMasterKey } from '../../apps/headless/src/storage/vault.mjs'
import {
  alpha, check, createPrivateRoot, DeliveryCheckError, expectDownload, finalReply, firstReply, folder, legacyBytes, legacyName,
  legacyRelative, legacyTitle, modelId, outsideName, providerId, providerName, question, seedLegacy, startDeliveryFixture,
  verifyDeliveriesFixture
} from './e2e-deliveries-fixture.mjs'
import { startLocalWebDriver, waitFor, WebDriverError } from './webdriver-local.mjs'

const testId = name => `[data-testid="${name}"]`
const workbenchId = name => testId(`workbench-${name}`)
const chat = workbenchId('chat')
const user = `${chat} [data-role="user"]`
const assistant = `${chat} [data-role="assistant"]`
const titleSelector = '.cf-thread__title'
const compose = `${chat} .cf-draft__input[role="textbox"][contenteditable="true"]`
const send = `${chat} .cf-send:not(.is-stop)`
const completed = `${chat} ${workbenchId('turn-status')}[data-status="completed"]`
const exportButton = `${chat} ${workbenchId('export-md')}`
const cardHook = testId('deliverables-card')
const cards = `${chat} ${cardHook}`
const card = kind => `${chat}${kind === 'desktop' ? ` ${workbenchId('deliveries')}` : ''} ` +
  `${cardHook}[data-delivery-origin="${kind}"][data-delivery-group-id]`
const item = `${testId('deliverables-file-row')}[data-delivery-item-index="0"]`
const action = (kind, verb) => `${card(kind)} ${item} ${testId(`deliverables-${verb}`)}`
const workspace = `dialog${workbenchId('workspace-dialog')}[open]`
const workspaceEntry = `${workspace} ${workbenchId('workspace-entry')}`
const replyName = 'reply-001.md'
const replyBytes = Buffer.from(finalReply, 'utf8')

function controls(browser, signal) {
  const until = (probe, diagnostic) => waitFor(probe, diagnostic, { signal })
  const element = (selector, diagnostic, text = null, child = null) => until(() => browser.execute(`
    const [selector, expected, child] = arguments;
    return [...document.querySelectorAll(selector)].find(node => node.getClientRects().length &&
      getComputedStyle(node).visibility === 'visible' && !node.matches(':disabled, [aria-disabled="true"]') &&
      (expected === null || (child ? node.querySelector(child) : node)?.textContent.trim() === expected)) ?? null;
  `, selector, text, child), diagnostic)
  return { until, element, click: async (...args) => browser.click(await element(...args)) }
}

async function claim(browser, ui, { origin, runDir }) {
  const { credential } = await requestControl({ runDir, op: 'claim' })
  // Only the browser receives the single-use fragment. Log no URLs, credentials, or screenshots.
  await browser.navigate(`${origin}/#claim=${encodeURIComponent(credential)}`)
  const password = await ui.element('.wb-auth input[type="password"][autocomplete="new-password"]', 'owner claim form')
  check(await browser.execute('return location.origin === arguments[0] && !location.search && !location.hash;', origin),
    'Owner handoff did not clear the claim fragment')
  await browser.keys(password, randomBytes(24).toString('base64url'))
  await ui.click('.wb-auth button[type="submit"]', 'submit the owner claim form')
  await ui.element(chat, 'authenticated Workbench')
  check((await requestControl({ runDir, op: 'status' })).claimed === true, 'Workbench did not record a claimed owner')
}

// Setup only, using the owner cookie, CSRF and revisions from the actual browser session.
// Deliveries, including the download request itself, are driven exclusively by visible controls.
async function seedProvider(browser, origin, key) {
  const ok = await browser.executeAsync(`
    const [provider, key, done] = arguments;
    const api = async (path, method = 'GET', body, csrf) => {
      const response = await fetch('/api/v1/' + path, {
        method, credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store',
        ...(body === undefined ? {} : { body: JSON.stringify(body),
          headers: { 'content-type': 'application/json', 'x-deva-csrf': csrf } })
      });
      return response.ok ? response.json() : null;
    };
    (async () => {
      const bootstrap = await api('bootstrap');
      const settings = await api('settings');
      if (!bootstrap?.csrf || !settings?.revision) return false;
      const saved = await api('settings', 'PATCH', { revision: settings.revision, unset: [],
        set: { locale: 'zh-CN', models: { providers: [provider],
          activeModelId: provider.id + ':' + provider.models[0].id, activeEffort: 'default' } } }, bootstrap.csrf);
      if (!saved?.ok || !saved.revision) return false;
      const credential = await api('provider-keys/' + provider.id, 'PUT', { value: key, revision: saved.revision }, bootstrap.csrf);
      return credential?.ok === true && credential.available === true;
    })().then(done, () => done(false));
  `, {
    id: providerId, name: providerName, kind: 'custom', purpose: 'llm', accent: '#345678', adapter: 'openai',
    apiHost: `${origin}/v1`, enabled: true, models: [{ id: modelId, name: modelId, enabled: true }]
  }, key)
  check(ok, 'Could not seed the private loopback provider')
  await browser.refresh()
}

function selection(browser, ui, diagnostic, test) {
  return ui.until(async () => {
    const selected = await browser.execute('return sessionStorage.getItem("deva-workbench.chat");')
    return typeof selected === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(selected) &&
      test(selected) ? selected : null
  }, diagnostic)
}

async function sendFromComposer({ browser, ui, mock, signal }) {
  const chip = `${chat} .model-pick button[aria-haspopup="menu"]`
  await ui.click(chip, 'model chooser')
  await ui.click(`${chat} .model-pick__item[role="menuitemradio"]`, 'private model option', modelId)
  await ui.element(chip, 'private model is selected', modelId)
  const input = await ui.element(compose, 'live chat composer')
  await browser.click(input)
  await browser.keys(input, question)
  const sendButton = await ui.element(send, 'enabled Send')
  mock.permitSend()
  await browser.click(sendButton)
  await mock.waitForSend(signal)
  await ui.element(`${assistant}[data-streaming="true"] .msg__text h1`, 'first streamed Markdown heading', firstReply.slice(2))
  check(await browser.execute('return ![...document.querySelectorAll(arguments[0])].some(el => !el.disabled);', exportButton),
    'The unfinished assistant reply exposed an enabled Markdown export')
  mock.complete()
  await assertCompleted(ui)
  mock.assertCount(1)
}

async function assertCompleted(ui) {
  await ui.element(completed, 'confirmed completed chat turn')
  await ui.element(`${user} .cf-msg__body`, 'persisted user question', question)
  await ui.element(`${assistant}:not([data-streaming="true"]) .msg__text p`, 'completed Unicode assistant paragraph', 'UTF-8 正文 📝')
  await ui.element(`${assistant}:not([data-streaming="true"]) .msg__text li`, 'completed Markdown list item', 'Preserves Markdown.')
}

// Resource timing proves that the UI used the actual same-origin route. The bridge receives
// only a boolean; it never exposes URL values, revisions, response bodies, or header contents.
function sameOriginObserved({ browser, ui, origin }, path, diagnostic, bodyLength = null) {
  return ui.until(() => browser.execute(`
    const [origin, path, bodyLength] = arguments;
    return location.origin === origin && performance.getEntriesByType('resource').some(entry => {
      const url = new URL(entry.name);
      return url.origin === origin && url.pathname === path && !url.search && !url.hash &&
        (bodyLength === null || (entry.encodedBodySize === bodyLength && entry.decodedBodySize === bodyLength));
    });
  `, origin, path, bodyLength), diagnostic)
}

async function deliveryCard({ browser, ui }, kind, name, diagnostic) {
  return ui.until(() => browser.execute(`
    const [all, selector, row, first, expected, forbidden] = arguments;
    const visible = node => node.getClientRects().length && getComputedStyle(node).visibility === 'visible';
    const cards = [...document.querySelectorAll(all)].filter(visible);
    if (cards.length !== 1 || !cards[0].matches(selector)) return null;
    const card = cards[0];
    const rows = [...card.querySelectorAll(row)].filter(visible);
    return rows.length === 1 && rows[0].matches(first) &&
      rows[0].querySelector('.deliv__name')?.textContent.trim() === expected && !card.textContent.includes(forbidden) &&
      /^d_[0-9a-f]{32}$/.test(card.dataset.deliveryGroupId ?? '') ? card.dataset.deliveryGroupId : null;
  `, cards, card(kind), testId('deliverables-file-row'), item, name, outsideName), diagnostic)
}

const deliveryPath = sid => `/api/v1/chats/${sid}/deliveries`
const itemPath = (sid, gid, action) => `${deliveryPath(sid)}/${gid}/items/0/${action}`

async function download(ctx, { sid, gid, kind, name, bytes }) {
  const { ui, seed, signal, mock } = ctx
  check((await readdir(seed.downloadsDir)).length === 0, 'Private Chrome download directory was not empty before the click')
  await ui.click(action(kind, 'download'), 'actual delivery card Download button')
  await expectDownload(seed.downloadsDir, name, bytes, signal)
  await sameOriginObserved(ctx, itemPath(sid, gid, 'download'),
    'same-origin delivery download request with the expected response length', bytes.length)
  check(await ctx.browser.execute('return sessionStorage.getItem("deva-workbench.chat") === arguments[0];', sid),
    'Downloading the delivery changed the selected conversation')
  mock.assertCount(1)
}

async function verifyReply(ctx, setStage) {
  const { browser, ui, seed, mock } = ctx
  setStage('start a real text chat and wait for its confirmed SSE reply')
  await ui.click(`${chat} ${workbenchId('new-chat')}`, 'start a new conversation')
  const sid = await selection(browser, ui, 'new real text conversation', id => id !== seed.sid)
  await sendFromComposer(ctx)
  const req = { sid, kind: 'reply', name: replyName, bytes: replyBytes }
  setStage('export the confirmed reply as Markdown and download from its desktop card')
  check((await readdir(seed.downloadsDir)).length === 0, 'A download appeared before the user clicked Export')
  await ui.click(exportButton, 'export Markdown for the confirmed assistant reply', '导出 Markdown')
  const gid = await deliveryCard(ctx, req.kind, req.name, 'desktop delivery card with the exported Markdown file')
  await sameOriginObserved(ctx, `${deliveryPath(sid)}/reply`, 'same-origin confirmed-reply export request')
  mock.assertCount(1)
  await download(ctx, { ...req, gid })

  setStage('refresh the page and download the same persisted Markdown delivery')
  await browser.refresh()
  await selection(browser, ui, 'same conversation after browser refresh', id => id === sid)
  await assertCompleted(ui)
  check(await deliveryCard(ctx, req.kind, req.name, 'persisted Markdown delivery after refreshing') === gid,
    'Refreshing replaced the saved Markdown delivery group')
  await sameOriginObserved(ctx, deliveryPath(sid), 'fresh same-origin delivery list after browser refresh')
  await download(ctx, { ...req, gid })
}

async function verifyLegacy(ctx, setStage) {
  const { browser, ui, seed, mock } = ctx
  setStage('open the native desktop chat and download only its authorized delivery')
  await ui.click(`${chat} .cf-thread`, 'open the read-only native desktop conversation', legacyTitle, titleSelector)
  await selection(browser, ui, 'selected native desktop conversation', id => id === seed.sid)
  const gid = await deliveryCard(ctx, 'desktop', legacyName, 'desktop card exposes exactly the authorized file')
  check(await browser.execute(`return !document.querySelector(arguments[0]).textContent.includes(arguments[1]);`, chat, outsideName),
    'Unauthorized legacy filename appeared in the Workbench chat')
  await sameOriginObserved(ctx, deliveryPath(seed.sid), 'legacy deliveries loaded through the same-origin collection route')
  await download(ctx, { sid: seed.sid, gid, kind: 'desktop', name: legacyName, bytes: legacyBytes })

  setStage('locate the authorized file in the real read-only Alpha workspace tree')
  await ui.click(`${action('desktop', 'locate')}[aria-label="在工作区文件面板中定位"]`, 'locate authorized legacy file')
  await sameOriginObserved(ctx, itemPath(seed.sid, gid, 'locate'), 'same-origin workspace locate request made by the card')
  await ui.until(() => browser.execute(`
    const [select, entries, project, folder, file] = arguments;
    const option = document.querySelector(select)?.selectedOptions[0];
    const visible = node => node.getClientRects().length && getComputedStyle(node).visibility === 'visible';
    const rows = [...document.querySelectorAll(entries)].filter(visible);
    const dir = rows.find(row => row.dataset.path === folder && row.dataset.type === 'dir');
    const leaf = rows.find(row => row.dataset.path === file && row.dataset.type === 'file');
    return Boolean(option?.textContent.trim() === project && rows.length === 2 &&
      dir?.getAttribute('aria-expanded') === 'true' && leaf?.getAttribute('aria-current') === 'true');
  `, `${workspace} ${workbenchId('workspace-select')}`, workspaceEntry, alpha, folder, legacyRelative),
  'Alpha tree expanded to and selected the authorized nested file')
  await ui.element(`${workspace} ${workbenchId('workspace-status')}[data-status="readonly"]`, 'located file remains read-only')
  await ui.until(() => browser.execute(`
    const [selector, content, save] = arguments;
    const editor = document.querySelector(selector);
    return editor?.getClientRects().length && editor.readOnly && editor.value === content && document.querySelector(save)?.disabled;
  `, `${workspace} ${workbenchId('workspace-editor')}`, legacyBytes.toString('utf8').replaceAll('\r\n', '\n'),
  `${workspace} ${workbenchId('workspace-save')}`), 'locate loaded the expected file into the read-only editor without another click')
  await seed.assertUnchanged()
  mock.assertCount(1)
}

async function runBrowser() {
  const stop = new AbortController()
  const abort = () => stop.abort()
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  const signal = stop.signal
  let stage = 'validate environment', root, mock, workbench, browser, failed = false
  const setStage = value => { stage = value }
  try {
    check(process.platform === 'linux' && process.getuid?.() > 0 && process.geteuid?.() > 0,
      'Run this test on Linux as a non-root user')
    await Promise.all(['provider-core', 'chat-core', 'library-core'].map(name =>
      access(new URL(`../../apps/headless/dist/${name}.mjs`, import.meta.url)))).catch(() => {
      throw new DeliveryCheckError('Build the headless artifacts with pnpm headless:test')
    })
    await access(join(DEFAULT_WEB_DIR, 'index.html')).catch(() => {
      throw new DeliveryCheckError('Build the Workbench assets with pnpm workbench:build')
    })
    stage = 'seed private workspace and start real loopback Workbench'
    root = await createPrivateRoot()
    const seed = await seedLegacy(root)
    const keyFile = join(root, 'master.key'), runDir = join(root, 'run')
    const key = randomBytes(24).toString('base64url')
    await initializeMasterKey(keyFile)
    mock = await startDeliveryFixture(key)
    workbench = await startWorkbench({ dataDir: seed.dataDir, keyFile, runDir, webDir: DEFAULT_WEB_DIR, port: 0,
      businessOptions: { allowedOrigins: [mock.origin], workspaceRoot: seed.workspaceRoot, workspaceWritable: false } })
    const { origin, address } = workbench
    check(address.address === '127.0.0.1', 'Workbench listener was not loopback')
    const ready = await fetch(`${origin}/readyz`, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) })
    await ready.body?.cancel()
    check(ready.status === 200, 'Workbench readiness check did not return 200')
    stage = 'start sandboxed non-root Chrome with the private download directory'
    browser = await startLocalWebDriver({ root, profile: join(root, 'chrome-profile'), origin, signal, downloadsDir: seed.downloadsDir })
    const ui = controls(browser, signal)
    stage = 'claim the owner through the Workbench page and seed the loopback provider'
    await claim(browser, ui, { origin, runDir })
    await seedProvider(browser, mock.origin, key)
    mock.assertCount(0)
    const ctx = { browser, ui, seed, origin, signal, mock }
    await verifyReply(ctx, setStage)
    await verifyLegacy(ctx, setStage)
  } catch (error) {
    failed = true
    console.error(`Workbench delivery E2E failed at ${stage}: ${signal.aborted ? 'interrupted' : safeMessage(error)}`)
  } finally {
    // Shutdown the real service before checking the final count, so teardown includes any late requests.
    for (const [name, cleanup] of [
      ['browser', () => browser?.close()], ['Workbench', () => workbench?.close()],
      ['OpenAI fixture', async () => { try { if (!failed) mock?.assertCount(1) } finally { await mock?.close() } }],
      ['temporary directory', () => root && rm(root, { recursive: true, force: true })]
    ]) {
      try { await cleanup() } catch {
        failed = true
        console.error(`Workbench delivery E2E: ${name} final check or cleanup failed`)
      }
    }
    process.removeListener('SIGINT', abort)
    process.removeListener('SIGTERM', abort)
  }
  if (failed || signal.aborted) process.exitCode = 1
  else console.log('Workbench delivery E2E passed: Markdown export and persisted download, authorized native delivery and real workspace locate, one upstream request.')
}

function safeMessage(error) {
  return error instanceof DeliveryCheckError || error instanceof WebDriverError ? error.message : 'unexpected error (raw diagnostics withheld)'
}

const args = process.argv.slice(2)
if (args.length === 0) await runBrowser()
else if (args.length === 1 && args[0] === '--fixture-only') {
  try {
    await verifyDeliveriesFixture()
    console.log('Workbench delivery fixture preflight passed (fixture only; browser E2E was not run).')
  } catch (error) {
    console.error(`Workbench delivery fixture preflight failed: ${safeMessage(error)}`)
    process.exitCode = 1
  }
} else {
  console.error('Usage: node scripts/workbench/e2e-deliveries.mjs [--fixture-only]')
  process.exitCode = 1
}
