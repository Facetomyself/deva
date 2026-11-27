import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  alpha, alphaMarker, beta, betaMarker, check, conflictDraft, content, dismissedName, dismissedText,
  docs, documentPath, excluded, guide, guideText, name, nested, uncertainName, uncertainPath, uncertainText, workId
} from './e2e-project-documents-fixture.mjs'
import { waitFor } from './webdriver-local.mjs'

const hook = name => `[data-testid="workbench-${name}"]`
const workspace = name => hook(`workspace-${name}`)
const dialog = `dialog${workspace('dialog')}[open]`
const editor = `${dialog} textarea${workspace('editor')}`
const entry = path => `${dialog} :is(${workspace('entry')}, ${hook('folder-active')})[data-path="${path}"]`
const expanded = path => `${entry(path)}[aria-expanded="true"]`
const folder = path => `${dialog} button${hook('folder-active')}[data-path="${path}"][aria-current="location"]`
const breadcrumb = `${dialog} ${hook('folder-breadcrumb')} code`
const doc = name => `${dialog} ${hook(`document-${name}`)}`
const projectSelect = `${dialog} select${workspace('select')}`
const chat = hook('chat')
const authForm = '.wb-auth'

// JavaScript only observes DOM. Every action, including option selection and multiline
// textarea input, comes from native W3C operations in the shared Chromium driver.
export function controls(browser, signal) {
  const until = (probe, description) => waitFor(probe, description, { signal })
  const observe = (script, description, ...args) => until(() => browser.execute(script, ...args), description)
  const visible = (selector, description) => observe(`
    return [...document.querySelectorAll(arguments[0])].find(node => node.getClientRects().length &&
      getComputedStyle(node).visibility === 'visible') ?? null;`, description, selector)
  return {
    observe, visible,
    async click(selector, description) {
      const el = await visible(`${selector}:not(:disabled):not([aria-disabled="true"])`, description)
      await browser.click(el)
    },
    gone: (selector, description) => observe('return !document.querySelector(arguments[0]);', description, selector),
    value: (selector, expected, description, editable = false) => observe(`
      const [selector, expected, editable] = arguments;
      const field = document.querySelector(selector);
      return !!field?.getClientRects().length && field.value === expected &&
        (!editable || (!field.readOnly && !field.disabled));`, description, selector, expected, editable),
    async enter(selector, expected, description) {
      const field = await visible(`${selector}:not([readonly]):not(:disabled)`, description)
      await browser.click(field)
      await browser.shortcut(field, 'select-all')
      await browser.keys(field, expected.split('\n').join('\uE007'))
    },
    async choose(selector, optionValue, description) {
      const select = await visible(`${selector}:not(:disabled)`, description)
      const option = await observe(`
        return [...arguments[0].options].find(row => !row.disabled && row.value === arguments[1]) ?? null;`,
      'enabled authorized option', select, optionValue)
      await browser.click(option)
      await observe('return arguments[0].selectedOptions[0] === arguments[1];', description, select, option)
    },
    async catalog() {
      const select = await visible(projectSelect, 'original project selector')
      const ids = await observe(`
        const [field, labels] = arguments;
        const options = [...field.options];
        if (options.length !== 3 || options[0].value !== '') return null;
        const ids = labels.map(label => options.find(row => row.textContent.trim() === label)?.value);
        return ids.every(Boolean) ? ids : null;`, 'exactly Alpha and Beta in the authorized catalog', select, [alpha, beta])
      check(ids.every(id => workId.test(id)) && ids[0] !== ids[1], 'Project catalog did not expose distinct opaque workspace IDs')
      return { alphaId: ids[0], betaId: ids[1] }
    },
    status: state => visible(`${doc('status')}[data-state="${state}"]`, `visible document ${state} state`),
    async privacy(origin, root) {
      check(await browser.execute(`
        return location.origin === arguments[0] && location.pathname === '/' && !location.search && !location.hash &&
          !document.body.innerHTML.includes(arguments[1]) && !document.querySelector('.wb-auth');`, origin, root),
      'Authenticated browser page exposed private fixture paths or an auth form')
    }
  }
}

export async function authenticate({ browser, ui, origin }, password, credential) {
  await browser.navigate(credential ? `${origin}/#claim=${encodeURIComponent(credential)}` : origin)
  const mode = credential ? 'new' : 'current'
  const field = await ui.visible(`${authForm} input[type="password"][autocomplete="${mode}-password"]`, `native owner ${credential ? 'claim' : 'login'} form`)
  check(await browser.execute(`
    return location.origin === arguments[0] && location.pathname === '/' && !location.search && !location.hash &&
      !document.querySelector(arguments[1]) && !document.querySelector('.wb-auth input[name="credential"]');`, origin, chat),
  'Authentication did not start from a fresh same-origin browser or exposed a claim field/fragment')
  await browser.keys(field, password)
  await ui.click(`${authForm} button[type="submit"]`, 'submit the real owner form')
  await ui.visible(chat, 'authenticated original Workbench renderer')
}

async function openDialog(ui) {
  await ui.click(workspace('open'), 'open the original Workbench workspace files')
  await ui.visible(dialog, 'native workspace dialog')
  return ui.catalog()
}

function request(ctx, mark, action, body, status = 200, intent) {
  return ctx.wire.after(mark, { wid: ctx.wid, action, body, status, intent, owner: ctx.owner })
}

async function browseAlpha(ctx, alreadyOpen = false) {
  const { ui, wire } = ctx
  const { alphaId, betaId } = await (alreadyOpen ? ui.catalog() : openDialog(ui))
  ctx.wid = alphaId
  ctx.betaId = betaId
  let mark = wire.mark()
  await ui.choose(projectSelect, alphaId, 'select Alpha in the original workspace picker')
  const rootReply = await request(ctx, mark, 'list', { path: '' })
  ctx.owner = rootReply.owner
  await ui.visible(entry(alphaMarker), 'Alpha-specific root file')
  await ui.gone(entry(betaMarker), 'Beta-specific file absent from Alpha')
  for (const path of [docs, nested]) {
    mark = wire.mark()
    await ui.click(`${entry(path)}[data-type="dir"][aria-expanded="false"]`, 'browse a listed folder using the original tree')
    await request(ctx, mark, 'list', { path })
    await ui.visible(expanded(path), 'expanded original directory row')
  }
  await ui.visible(entry(guide), 'existing nested guide tree row')
  await ui.gone(entry(excluded), 'excluded symlink absent from the actual nested tree')
  wire.idle()
}

async function openFile(ctx, path, text) {
  const mark = ctx.wire.mark()
  await ctx.ui.click(`${entry(path)}[data-type="file"]`, 'explicitly open the ordinary file from the original tree')
  check((await request(ctx, mark, 'read', { path })).exactRead, 'Normal workspace file read omitted the expected exact revisioned text')
  await selectedEditor(ctx.ui, path, text)
}

async function selectedEditor(ui, path, text) {
  await ui.value(editor, text, 'normal editor displays the exact persisted multiline text')
  await ui.visible(`${entry(path)}[aria-current="true"]`, 'ordinary file selected in the original tree')
  await ui.observe(`
    const [selector, expected] = arguments;
    const title = document.querySelector(selector);
    return title?.getClientRects().length && title.textContent.trim() === expected;`,
  'selected editor breadcrumb shows exactly the project-relative file', `${dialog} .wb-workspace__filebar strong`, path)
}

async function assertFocusedFolder(ui, path) {
  await ui.observe(`
    const active = document.querySelector(arguments[0]);
    return !!active?.getClientRects().length && document.activeElement === active;`,
  'real DOM focus is on the selected directory tree control', folder(path))
  await ui.observe('return document.querySelector(arguments[0])?.textContent.trim() === arguments[1];',
    'only the approved relative folder breadcrumb is shown', breadcrumb, `/${path}`)
}

async function revealGuideParent(ui) {
  await ui.click(`${dialog} ${hook('folder-reveal')}`, 'explicitly reveal the open guide parent folder')
  await assertFocusedFolder(ui, nested)
  for (const path of [docs, nested]) await ui.visible(expanded(path), 'Reveal expanded the ancestor chain and its actual parent')
  await ui.visible(`${entry(guide)}[aria-current="true"]`, 'original guide stays selected after Reveal')
}

async function proveReveal(ctx) {
  const { ui, fixture, wire } = ctx
  await openFile(ctx, guide, guideText)
  // Keep the actual file selected, but remove its parent row from the visible subtree.
  // The explicit Reveal has to expand the ancestor and restore focus itself.
  await ui.click(expanded(docs), 'collapse the existing guide ancestor while keeping the editor selected')
  await ui.gone(entry(nested), 'nested parent hidden before Reveal')
  await ui.value(editor, guideText, 'original guide remains selected before Reveal')
  await revealGuideParent(ui)
  await ui.value(editor, guideText, 'Reveal did not modify the original editor')
  await fixture.assertLayout()
  wire.idle()
}

async function prepare(ctx, directory, filename, text, layout = []) {
  const { ui, wire, fixture } = ctx
  const path = directory ? `${directory}/${filename}` : filename
  await ui.click(doc('new'), 'explicitly open New Document in the original workspace dialog')
  await ui.visible(doc('draft'), 'local new-document draft form')
  await ui.choose(doc('parent'), directory, 'select the actual already-listed destination folder')
  await ui.enter(doc('name'), filename, 'type the ordinary filename via Chrome')
  await ui.enter(doc('content'), text, 'type exact multiline document bytes via Chrome')
  await ui.value(doc('name'), filename, 'name is present before Review')
  await ui.value(doc('content'), text, 'exact local draft before Review', true)
  await ui.status('draft')
  await ui.gone(doc('create'), 'local draft has no Create action before explicit Review')
  await fixture.assertLayout(layout)
  wire.idle()

  const mark = wire.mark()
  await ui.click(doc('review'), 'explicitly Review the local draft')
  const result = await request(ctx, mark, 'document-intents', { directory, name: filename }, 201)
  check(result.receipt?.path === path, 'Intent did not return an opaque ID, exact relative path, and positive TTL')
  await ui.status('prepared')
  await ui.visible(doc('create'), 'explicit Create control appears only after preparation')
  await fixture.assertLayout(layout)
  wire.idle()
  return result.receipt.id
}

async function confirmCancel(ctx, mark, id) {
  check((await request(ctx, mark, 'cancel', {}, 200, id)).retired, 'Cleanup did not retire the original intent through its cancel route')
}

async function dismissRoot(ctx) {
  await ctx.ui.click(`${dialog} ${hook('folder-root')}[data-path=""]`, 'select the actual project-root tree control')
  await assertFocusedFolder(ctx.ui, '')
  const id = await prepare(ctx, '', dismissedName, dismissedText)
  const mark = ctx.wire.mark()
  await ctx.ui.click(doc('cancel'), 'dismiss the prepared project-root document')
  await ctx.ui.gone(doc('draft'), 'dismissed prepared draft is closed')
  await confirmCancel(ctx, mark, id)
  await ctx.fixture.assertLayout()
  ctx.wire.idle()
}

async function dispatchCreate(ctx, id, text, status) {
  const mark = ctx.wire.mark()
  await ctx.ui.click(doc('create'), 'click the real prepared Create control')
  const receipt = await request(ctx, mark, 'create', { content: text }, status, id)
  if (status === 409) check(receipt.conflict, 'The real 409 did not identify the occupied file slot')
  return mark
}

async function proveRace(first, second) {
  const { fixture, wire, ui } = first
  await revealGuideParent(ui)
  const firstIntent = await prepare(first, nested, name, content)
  const secondIntent = await prepare(second, nested, name, conflictDraft)
  check(firstIntent !== secondIntent && first.owner !== second.owner && first.wid === second.wid && first.betaId === second.betaId,
    'Expected two independently authenticated profiles and intentions in the same workspace')
  await fixture.checkAbsent(documentPath)
  const mark = await dispatchCreate(first, firstIntent, content, 201)
  await ui.status('saved')
  await request(first, mark, 'list', { path: nested })
  check((await request(first, mark, 'read', { path: documentPath })).exactRead, 'The real success flow did not read the new file back')
  await confirmCancel(first, mark, firstIntent)
  await selectedEditor(ui, documentPath, content)
  const identity = await fixture.created(documentPath)
  await fixture.assertLayout([documentPath])

  const conflictMark = await dispatchCreate(second, secondIntent, conflictDraft, 409)
  await confirmCancel(second, conflictMark, secondIntent)
  await second.ui.observe(`
    const el = document.querySelector(arguments[0]);
    return !!el?.getClientRects().length && el.dataset.state === 'draft' && el.dataset.issue === 'exists' && !!el.textContent.trim();`,
  'visible create conflict for the independent losing owner session', doc('status'))
  await second.ui.value(doc('content'), conflictDraft, 'conflict leaves the complete user draft available', true)
  await second.ui.value(doc('name'), name, 'conflict retains the selected filename')
  await fixture.created(documentPath, identity)
  await fixture.assertLayout([documentPath])
  wire.idle()

  // From the independent profile, browse to the resulting file through a clean ordinary read.
  await second.ui.click(doc('cancel'), 'leave the kept losing draft after inspecting its conflict')
  await second.ui.gone(doc('draft'), 'losing draft closed after explicit dismissal')
  await second.ui.click(doc('new'), 'return to the independent owner’s kept draft')
  await second.ui.value(doc('name'), name, 'reopened losing draft retains the ordinary filename')
  await second.ui.value(doc('content'), conflictDraft, 'reopened losing draft retains the exact user text', true)
  await second.ui.click(doc('cancel'), 'close the kept draft before a fresh ordinary file read')
  await second.ui.gone(doc('draft'), 'document draft is closed before reload')
  wire.idle()
  await showBeta(second)
  await browseAlpha(second, true)
  check(first.owner !== second.owner, 'Independent owner remained independently authenticated after switching projects')
  await openFile(second, documentPath, content)
  await fixture.created(documentPath, identity)
  wire.idle()
  return identity
}

async function proveAmbiguity(ctx, identity) {
  const { wire, ui, fixture } = ctx
  const id = await prepare(ctx, nested, uncertainName, uncertainText, [documentPath])
  await fixture.checkAbsent(uncertainPath)
  wire.cutOneCreate(ctx.wid, id)
  const creation = await dispatchCreate(ctx, id, uncertainText, 201)
  wire.assertTruncated()
  await ui.status('unconfirmed')
  await ui.value(doc('content'), uncertainText, 'truncated ACK preserves exact local content')
  const native = await fixture.created(uncertainPath)
  check(wire.mark() === creation + 1, 'Unconfirmed state dispatched an automatic retry or read before explicit Verify')
  wire.idle()

  const mark = wire.mark()
  await ui.click(doc('verify'), 'explicitly Verify the ambiguous create through its original intent and normal file readback')
  check((await request(ctx, mark, 'status', {}, 200, id)).confirmedReceipt, 'One-shot Verify did not establish the original committed receipt')
  await request(ctx, mark, 'list', { path: nested })
  check((await request(ctx, mark, 'read', { path: uncertainPath })).exactRead, 'Explicit Verify did not read back the exact created file')
  await ui.status('saved')
  await confirmCancel(ctx, mark, id)
  await selectedEditor(ui, uncertainPath, uncertainText)
  await fixture.created(uncertainPath, native)
  await fixture.created(documentPath, identity)
  await fixture.assertLayout([documentPath, uncertainPath])
  wire.idle()
}

async function capture(ctx) {
  if (process.env.DEVA_QA_DOCUMENT_CAPTURE !== '1') return
  await selectedEditor(ctx.ui, documentPath, content)
  // A normal file selection clears the directory focus. Exercise Reveal rather than
  // expecting a stale breadcrumb left over from another document.
  await ctx.ui.click(`${dialog} ${hook('folder-reveal')}`, 'reveal the selected created document before the screenshot')
  await assertFocusedFolder(ctx.ui,nested)
  await selectedEditor(ctx.ui,documentPath,content)
  await ctx.ui.privacy(ctx.origin, ctx.fixture.root)
  const viewport = await ctx.browser.execute(`
    const [editor, select, draft, selected, text, path] = arguments;
    const form = document.querySelector(select), field = document.querySelector(editor), row = document.querySelector(selected);
    if (!field || field.value !== text || !field.getClientRects().length || form?.selectedOptions[0]?.textContent.trim() !== 'Alpha' ||
        [...form.options].filter(o => o.value).map(o => o.textContent.trim()).sort().join(',') !== 'Alpha,Beta' ||
        !row?.getClientRects().length || row.dataset.path !== path || document.querySelector(draft) ||
        [...document.querySelectorAll('input[type="password"],input[name*="credential"],input[name*="token"]')].some(input => input.value)) return null;
    return { width: innerWidth, height: innerHeight };`, editor, projectSelect, doc('draft'), `${entry(documentPath)}[aria-current="true"]`, content, documentPath)
  check(viewport, 'Capture requires the exact synthetic final editor, selected breadcrumb, and empty credential controls')
  let dir = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '')
  for (const component of ['test-results', 'project-documents']) {
    dir = join(dir, component)
    await mkdir(dir, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
    const info = await lstat(dir)
    check(info.isDirectory() && info.uid === process.geteuid() && await realpath(dir) === dir, 'Capture output directory is not canonical and owned')
  }
  const encoded = await ctx.browser.fixtureScreenshot()
  check(typeof encoded === 'string' && encoded.length > 1024 && encoded.length < 4 * 1024 * 1024, 'Unexpected viewport capture size')
  const png = Buffer.from(encoded, 'base64')
  check(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    png.readUInt32BE(16) === viewport.width && png.readUInt32BE(20) === viewport.height, 'Chrome did not return a real viewport PNG')
  await writeFile(join(dir, 'created-document.png'), png, { flag: 'wx', mode: 0o600 })
}

async function showBeta(ctx) {
  const mark = ctx.wire.mark()
  await ctx.ui.choose(projectSelect, ctx.betaId, 'select distinct approved Beta project')
  await ctx.wire.after(mark, { wid: ctx.betaId, action: 'list', body: { path: '' }, status: 200, owner: ctx.owner })
  await ctx.ui.visible(entry(betaMarker), 'Beta-specific file exists in the actual independent tree')
  await ctx.ui.gone(entry(documentPath), 'the created Alpha file is absent from the Beta tree')
}

export async function verifyInChrome(first, second, stage) {
  stage('browse the approved project and reveal the existing file parent with native focus')
  await browseAlpha(first)
  await proveReveal(first)
  await first.ui.privacy(first.origin, first.fixture.root)

  stage('review and dismiss a prepared root document, without creating anything')
  await dismissRoot(first)
  await browseAlpha(second)
  await second.ui.privacy(second.origin, second.fixture.root)

  stage('prepare competing nested documents, create once, and preserve the losing draft after actual HTTP 409')
  const identity = await proveRace(first, second)

  stage('truncate one authentic post-commit ACK, and Verify through ordinary readback only')
  await proveAmbiguity(first, identity)

  stage('optionally capture the verified final synthetic editor')
  await first.ui.click(`${entry(documentPath)}[data-type="file"]`, 'return to the original successfully created synthetic document')
  await selectedEditor(first.ui, documentPath, content)
  await first.ui.privacy(first.origin, first.fixture.root)
  await first.fixture.created(documentPath, identity)
  await capture(first)
  first.wire.idle()
}
