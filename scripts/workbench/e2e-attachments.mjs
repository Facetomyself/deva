import { randomBytes } from 'node:crypto'
import { access, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requestControl } from '../../apps/headless/src/control/socket.mjs'
import { DEFAULT_WEB_DIR, startWorkbench } from '../../apps/headless/src/server.mjs'
import { initializeMasterKey } from '../../apps/headless/src/storage/vault.mjs'
import {
  AttachmentCheckError, check, firstReply, fullReply, imageBytes, imageName, modelId, providerId, providerName,
  question, startAttachmentFixture, textBytes, textName, uuid4Source, verifyAttachmentFixture
} from './e2e-attachments-fixture.mjs'
import { startLocalWebDriver, waitFor, WebDriverError } from './webdriver-local.mjs'

const testId = name => `[data-testid="workbench-${name}"]`
const chat = testId('chat')
const picker = `${chat} ${testId('attachment-picker')}`
const draftFiles = `${chat} ${testId('draft-attachments')}`
const userRow = `${chat} [data-role="user"]`
const assistantRow = `${chat} [data-role="assistant"]`
const sentFiles = `${userRow} ${testId('message-attachments')}`
const send = `${chat} .cf-send:not(.is-stop)`
const uuid4 = new RegExp(`^${uuid4Source}$`)
const previewPath = new RegExp(`^/api/v1/chats/(${uuid4Source})/attachments/(${uuid4Source})/preview$`)
const escape = '\uE00C'

function visibleElement(browser, signal) {
  return (selector, diagnostic) => waitFor(() => browser.execute(`
    return Array.from(document.querySelectorAll(arguments[0])).find(el =>
      el.getClientRects().length && getComputedStyle(el).visibility === 'visible' && !el.matches(':disabled')) ?? null;
  `, selector), diagnostic, { signal })
}

async function claim(browser, element, { origin, runDir }) {
  const { credential } = await requestControl({ runDir, op: 'claim' })
  // Only ChromeDriver sees the local claim URL. No screenshots, browser logs, or URLs are emitted.
  await browser.navigate(`${origin}/#claim=${encodeURIComponent(credential)}`)
  const input = await element('.wb-auth input[type="password"][autocomplete="new-password"]', 'account claim form')
  await browser.keys(input, randomBytes(24).toString('base64url'))
  await browser.click(await element('.wb-auth button[type="submit"]', 'submit browser claim'))
  await element(chat, 'authenticated Workbench')
}

async function seedProvider(browser, key, origin) {
  // Setup only: seed a private provider in the exact browser session that just claimed the
  // account. PR2 owns the settings UI, credential persistence, and model-list probe coverage.
  const outcome = await browser.executeAsync(`
    const [provider, key, finish] = arguments;
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
      if (bootstrap?.capabilities?.attachments !== true) return 1;
      const settings = await api('settings');
      if (!settings?.revision) return 2;
      const saved = await api('settings', 'PATCH', {
        revision: settings.revision, unset: [], set: { locale: 'en', models: {
          providers: [provider], activeModelId: provider.id + ':' + provider.models[0].id, activeEffort: 'default'
        } }
      }, bootstrap.csrf);
      if (!saved?.revision) return 3;
      const credential = await api('provider-keys/' + provider.id, 'PUT', { value: key, revision: saved.revision }, bootstrap.csrf);
      return credential?.ok === true && credential.available === true ? 0 : 4;
    })().then(finish, () => finish(5));
  `, {
    id: providerId, name: providerName, kind: 'custom', purpose: 'llm', accent: '#345678',
    adapter: 'openai', apiHost: `${origin}/v1`, enabled: true, models: [{ id: modelId, name: modelId, enabled: true }]
  }, key)
  const failure = ['Setup complete', 'Attachment capability was unavailable', 'Could not read revision for setup',
    'Could not seed private provider settings', 'Could not seed the provider key', 'Same-origin setup failed']
  check(outcome === 0, failure[outcome] ?? 'Unrecognized setup result')
  await browser.refresh()
}

function selectedChat(browser) {
  // This is the real selection saved by the frontend, not an injected session or fixture ID.
  return browser.execute('return sessionStorage.getItem("deva-workbench.chat");')
}

async function createChat(browser, element, signal, previous = null) {
  await browser.click(await element(`${chat} ${testId('new-chat')}`, 'new conversation button'))
  const sid = await waitFor(async () => {
    const selected = await selectedChat(browser)
    return selected && selected !== previous && uuid4.test(selected) ? selected : null
  }, 'newly selected conversation', { signal })
  await element(picker, 'enabled file picker for the new conversation')
  return sid
}

async function selectModel(browser, element, signal) {
  const chip = `${chat} .model-pick button[aria-haspopup="menu"]`
  await browser.click(await element(chip, 'composer model picker'))
  const choice = await waitFor(() => browser.execute(`
    const [provider, model] = arguments;
    const visible = el => el.getClientRects().length && getComputedStyle(el).visibility === 'visible';
    for (const group of document.querySelectorAll('.cf-mp__group')) {
      if (group.querySelector('.cf-mp__ghead')?.textContent.trim() !== provider) continue;
      for (const button of group.querySelectorAll('.model-pick__item[role="menuitemradio"]')) {
        if (visible(button) && !button.disabled && button.textContent.trim() === model) return button;
      }
    }
    return null;
  `, providerName, modelId), 'registered private model in the chooser', { signal })
  await browser.click(choice)
  await waitFor(() => browser.execute('return document.querySelector(arguments[0])?.textContent.trim() === arguments[1];',
    chip, modelId), 'selected private chat model', { signal })
}

async function pickFiles(browser, element, signal, paths) {
  await element(picker, 'visible enabled attachment picker')
  const input = await waitFor(() => browser.execute(`
    return document.querySelector(arguments[0] + '[type="file"][multiple]:enabled');
  `, `${chat} ${testId('attachment-input')}`), 'native multiple file input', { signal })
  // W3C Element Send Keys is WebDriver's native file-picker operation. Chrome reads the
  // absolute paths into this real input, triggering its normal events; no DataTransfer or File injection.
  await browser.keys(input, paths.join('\n'))
}

function attachmentState(browser, signal, scope, description, { hasImage, textCount = 1 }) {
  return waitFor(() => browser.execute(`
    const [rootSelector, textName, imageName, dimensions, hasImage, textCount] = arguments;
    const visible = el => el && el.getClientRects().length && getComputedStyle(el).visibility === 'visible';
    const roots = document.querySelectorAll(rootSelector);
    if (roots.length !== 1 || !visible(roots[0])) return null;
    const root = roots[0];
    const cards = Array.from(root.querySelectorAll('.cf-fcard__name')).filter(visible);
    if (cards.length !== textCount || (textCount && cards[0].textContent.trim() !== textName)) return null;
    const thumbs = Array.from(root.querySelectorAll('.cf-att__thumb')).filter(visible);
    if (!hasImage) return thumbs.length === 0 && root.querySelectorAll('.cf-att').length === textCount;
    if (thumbs.length !== 1 || root.querySelectorAll('.cf-att').length !== textCount + 1) return null;
    const img = thumbs[0].querySelector('img');
    return visible(img) && img.complete && img.naturalWidth === dimensions && img.naturalHeight === dimensions &&
      thumbs[0].title.startsWith(imageName + '\\n') ? img.currentSrc : null;
  `, scope, textName, imageName, 2, hasImage, textCount), description, { signal })
}

function validatedPreview(src, origin, sid) {
  const url = new URL(src, origin)
  const match = previewPath.exec(url.pathname)
  check(url.origin === origin && !url.username && !url.password && !url.search && !url.hash && match?.[1] === sid,
    'Image did not use the selected conversation’s same-origin preview route')
  return { path: url.pathname, id: match[2] }
}

async function openPreview(browser, element, signal, scope, origin, sid, expected) {
  const dialog = '.cf-viewer[role="dialog"]'
  await browser.click(await element(`${scope} button.cf-att__thumb`, 'attachment image thumbnail'))
  const src = await waitFor(() => browser.execute(`
    const img = document.querySelector(arguments[0] + ' img.cf-viewer__img');
    return img?.alt === arguments[1] && img.getClientRects().length && img.complete && img.naturalWidth === 2 &&
      img.naturalHeight === 2 ? img.currentSrc : null;
  `, dialog, imageName), '2×2 image in full preview dialog', { signal })
  check(validatedPreview(src, origin, sid).id === expected.id, 'Preview dialog changed the attachment ID')
  await browser.keys(await element(dialog, 'attachment preview dialog'), escape)
  await waitFor(() => browser.execute('return !document.querySelector(arguments[0]);', dialog), 'closed attachment preview', { signal })
}

async function expectMissingPreview(browser, path) {
  check(previewPath.test(path), 'Unexpected preview probe path')
  const absent = await browser.executeAsync(`
    const [path, finish] = arguments;
    fetch(path, { credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store' })
      .then(async response => response.status === 404 && (await response.json()).error === 'attachment_not_found')
      .then(finish, () => finish(false));
  `, path)
  check(absent, 'Attachment preview was not rejected as missing for this conversation')
}

function waitForReply(browser, signal, text, streaming) {
  return waitFor(() => browser.execute(`
    const [selector, text, streaming] = arguments;
    const rows = document.querySelectorAll(selector);
    if (rows.length !== 1) return false;
    const row = rows[0];
    const visible = el => el.getClientRects().length && getComputedStyle(el).visibility === 'visible';
    return (row.dataset.streaming === 'true') === streaming && [row, ...row.querySelectorAll('*')]
      .some(el => visible(el) && el.textContent.trim() === text);
  `, assistantRow, text, streaming), streaming ? 'first visible streamed model delta' : 'complete model reply in the conversation', { signal })
}

async function uploadAndReplace({ browser, element, signal, origin, sid, mock, paths }) {
  await pickFiles(browser, element, signal, paths)
  const getImage = async () => validatedPreview(await attachmentState(browser, signal, draftFiles,
    'editable text card and decoded 2×2 image thumbnail in the composer', { hasImage: true }), origin, sid)
  const initial = await getImage()
  await element(send, 'Send enabled after both uploads are confirmed')
  await openPreview(browser, element, signal, draftFiles, origin, sid, initial)
  mock.assertCount(0)

  await browser.click(await element(`${draftFiles} .cf-att:has(button.cf-att__thumb) button.cf-att__x`, 'remove the draft image'))
  await attachmentState(browser, signal, draftFiles, 'only the text card after removing the draft image', { hasImage: false })
  await element(send, 'Send enabled after image removal is confirmed')
  await expectMissingPreview(browser, initial.path)
  mock.assertCount(0)

  await pickFiles(browser, element, signal, [paths[1]])
  const replacement = await getImage()
  check(initial.id !== replacement.id, 'Picking the image again did not issue a new attachment ID')
  await element(send, 'Send enabled for the confirmed replacement image and text')
  mock.assertCount(0)
  return replacement
}

async function assertSent({ browser, element, signal, origin, sid, replacement }) {
  await element(`${chat} ${testId('turn-status')}[data-status="completed"]`, 'completed attachment turn')
  await waitForReply(browser, signal, fullReply, false)
  const src = await attachmentState(browser, signal, sentFiles, 'text card and decoded image on the sent user message', { hasImage: true })
  check(validatedPreview(src, origin, sid).id === replacement.id, 'Sent card did not retain the approved image ID')
  check(await browser.execute(`
    const [user, draft, question] = arguments;
    const rows = document.querySelectorAll(user);
    return rows.length === 1 && rows[0].textContent.includes(question) &&
      !document.querySelector(draft) && !rows[0].querySelector('.cf-att__x');
  `, userRow, draftFiles, question), 'Sent attachment cards were not confined to the committed user message')
}

async function driveBrowser(ctx, setStage) {
  const { browser, element, signal, origin, runDir, key, mock } = ctx
  setStage('claim account in Workbench')
  await claim(browser, element, { origin, runDir })
  setStage('seed private provider in the claimed browser session')
  await seedProvider(browser, key, mock.origin)
  mock.assertCount(0)
  setStage('create conversation and choose model in composer')
  const sid = await createChat(browser, element, signal)
  await selectModel(browser, element, signal)
  setStage('choose files, inspect draft preview, remove and choose again')
  const replacement = await uploadAndReplace({ ...ctx, sid })

  setStage('click Send and observe one exact OpenAI request and live SSE')
  const input = await element(`${chat} .cf-draft__input[role="textbox"][contenteditable="true"]`, 'composer text input')
  await browser.click(input)
  await browser.keys(input, question)
  const sendButton = await element(send, 'Send message with approved files')
  check(await browser.execute('return !document.querySelector(arguments[0] + ", " + arguments[1]);', userRow, assistantRow),
    'Conversation changed before the explicit Send action')
  mock.permitSend()
  await browser.click(sendButton)
  await mock.waitForSend(signal)
  await waitForReply(browser, signal, firstReply, true)
  mock.complete()
  await assertSent({ ...ctx, sid, replacement })
  mock.assertCount(1)

  setStage('refresh and open the persisted attachment preview')
  await browser.refresh()
  await assertSent({ ...ctx, sid, replacement })
  check(await selectedChat(browser) === sid, 'Refresh selected a different conversation')
  await openPreview(browser, element, signal, sentFiles, origin, sid, replacement)
  mock.assertCount(1)

  setStage('create a second conversation and verify attachment isolation')
  const other = await createChat(browser, element, signal, sid)
  check(await browser.execute('return !document.querySelector(arguments[0] + ", " + arguments[1]);', sentFiles, draftFiles),
    'Attachment cards appeared in another conversation')
  await expectMissingPreview(browser, `/api/v1/chats/${other}/attachments/${replacement.id}/preview`)
  mock.assertCount(1)
}

async function runBrowser() {
  const stop = new AbortController()
  const abort = () => stop.abort()
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  let stage = 'validate environment', root, mock, workbench, browser, failed = false
  try {
    check(process.platform === 'linux' && process.getuid?.() > 0 && process.geteuid?.() > 0,
      'Run this test on Linux as a non-root user')
    await Promise.all(['provider-core', 'chat-core', 'library-core'].map(name =>
      access(new URL(`../../apps/headless/dist/${name}.mjs`, import.meta.url)))).catch(() => {
      throw new AttachmentCheckError('Build the headless artifacts with pnpm headless:build')
    })
    await access(join(DEFAULT_WEB_DIR, 'index.html')).catch(() => {
      throw new AttachmentCheckError('Build the Workbench assets with pnpm workbench:build')
    })
    stage = 'start local Workbench and upstream fixture'
    const prefix = join(await realpath(tmpdir()), 'deva-attachments-e2e-')
    const createdRoot = await mkdtemp(prefix)
    check(createdRoot.startsWith(prefix) && createdRoot.length === prefix.length + 6, 'Unexpected temporary directory')
    root = createdRoot
    const paths = [join(root, textName), join(root, imageName)]
    await Promise.all([writeFile(paths[0], textBytes, { mode: 0o600 }), writeFile(paths[1], imageBytes, { mode: 0o600 })])
    const keyFile = join(root, 'master.key')
    const runDir = join(root, 'run')
    const key = randomBytes(24).toString('base64url')
    await initializeMasterKey(keyFile)
    mock = await startAttachmentFixture(key)
    workbench = await startWorkbench({ dataDir: join(root, 'data'), keyFile, runDir, webDir: DEFAULT_WEB_DIR, port: 0,
      businessOptions: { allowedOrigins: [mock.origin] } })
    const signal = stop.signal
    const origin = workbench.origin
    const readiness = await fetch(`${origin}/readyz`, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) })
    check(readiness.status === 200, 'Workbench readiness check did not return HTTP 200')
    await readiness.body?.cancel()
    stage = 'start non-root sandboxed headless Chrome'
    browser = await startLocalWebDriver({ root, profile: join(root, 'chrome-profile'), origin, signal })
    await driveBrowser({ browser, element: visibleElement(browser, signal), origin, runDir, key, mock, paths, signal }, next => { stage = next })
  } catch (error) {
    failed = true
    const detail = stop.signal.aborted ? 'interrupted' : safeMessage(error)
    console.error(`Workbench attachment E2E failed at ${stage}: ${detail}`)
  } finally {
    // This absolute path was verified against our own mkdtemp prefix. Its browser profile can
    // contain session state and is never retained as an artifact, including on failure.
    for (const [name, cleanup] of [
      ['browser', () => browser?.close()], ['Workbench', () => workbench?.close()],
      ['OpenAI fixture', () => mock?.close()], ['temporary directory', () => root && rm(root, { recursive: true, force: true })]
    ]) {
      try { await cleanup() } catch {
        failed = true
        console.error(`Workbench attachment E2E: ${name} cleanup failed`)
      }
    }
    process.removeListener('SIGINT', abort)
    process.removeListener('SIGTERM', abort)
  }
  if (failed || stop.signal.aborted) process.exitCode = 1
  else console.log('Workbench attachment E2E passed: file picker, draft removal and re-upload, one OpenAI wire request, live reply, and session-bound persisted preview.')
}

function safeMessage(error) {
  return error instanceof AttachmentCheckError || error instanceof WebDriverError ? error.message : 'unexpected error (raw diagnostics withheld)'
}
const args = process.argv.slice(2)
if (args.length === 0) await runBrowser()
else if (args.length === 1 && args[0] === '--fixture-only') {
  try {
    await verifyAttachmentFixture()
    console.log('Workbench attachment fixture preflight passed (fixture only; browser E2E was not run).')
  } catch (error) {
    console.error(`Workbench attachment fixture preflight failed: ${safeMessage(error)}`)
    process.exitCode = 1
  }
} else {
  console.error('Usage: node scripts/workbench/e2e-attachments.mjs [--fixture-only]')
  process.exitCode = 1
}
