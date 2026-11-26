import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { promisify } from 'node:util'
import { requestControl } from '../../apps/headless/src/control/socket.mjs'
import { DEFAULT_WEB_DIR, startWorkbench } from '../../apps/headless/src/server.mjs'
import { initializeMasterKey } from '../../apps/headless/src/storage/vault.mjs'
import { startLocalWebDriver, waitFor, WebDriverError } from './webdriver-local.mjs'

const exec = promisify(execFile)
const hook = suffix => `[data-testid="workbench-workspace-${suffix}"]`
const dialog = `dialog${hook('dialog')}[open]`
const inside = suffix => `${dialog} ${hook(suffix)}`
const projectSelect = `${dialog} select${hook('select')}`
const editor = `${dialog} textarea${hook('editor')}`
const diskPreview = `${dialog} .wb-workspace__review textarea[readonly]`
const alpha = 'Workspace Alpha'
const beta = 'Workspace Beta'
const folder = '笔记 目录'
const documentPath = `${folder}/工作 文档.txt`
const binary = 'fixture.bin'
const large = 'large fixture.txt'
const betaMarker = 'beta only.txt'
const text = {
  initial: '初始预览\n  Alpha original\n', first: '第一次保存\n  Alpha saved\n',
  draft: '保留中文草稿\n  Local draft\n', disk: '外部编辑\n  Written by the CLI fixture\n',
  final: '保留中文草稿\n  Reviewed and edited after reload\n', beta: '项目 B 的同名文件\n  Leave intact\n'
}
const fixtureFile = (path, data) => writeFile(path, data, { mode: 0o600, flag: 'wx' })

class CheckFailure extends Error {}
function check(condition, message) {
  if (!condition) throw new CheckFailure(message)
}

async function seed(root) {
  const workspaceRoot = join(root, 'projects')
  const alphaDir = join(workspaceRoot, alpha), betaDir = join(workspaceRoot, beta)
  const alphaFile = join(alphaDir, documentPath), betaFile = join(betaDir, documentPath)
  await mkdir(join(alphaDir, folder), { recursive: true, mode: 0o700 })
  await mkdir(join(betaDir, folder), { recursive: true, mode: 0o700 })
  await Promise.all([
    fixtureFile(alphaFile, text.initial), fixtureFile(betaFile, text.beta),
    fixtureFile(join(alphaDir, binary), Buffer.from([0x00, 0x01, 0xfe, 0xff])),
    fixtureFile(join(alphaDir, large), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61)),
    fixtureFile(join(betaDir, betaMarker), 'Only in the beta project\n'),
    fixtureFile(join(workspaceRoot, 'not a project.txt'), 'A file at the mounted parent is not a project\n')
  ])
  return { root, workspaceRoot, alphaFile, betaFile }
}

// A separate, bounded local process edits one pre-existing fixture file in place, without
// any Workbench credentials or API. Check the previous contents before truncating it.
async function externalEdit({ root, alphaFile }, signal) {
  check(alphaFile.startsWith(`${root}${sep}`) && await realpath(alphaFile) === alphaFile, 'External editor target escaped the fixture')
  await exec(process.execPath, ['-e', `
    const fs = require('node:fs');
    const [path, before, after] = process.argv.slice(1);
    if (fs.realpathSync(path) !== path) process.exit(1);
    const fd = fs.openSync(path, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || fs.readFileSync(fd, 'utf8') !== before) process.exitCode = 1;
      else {
        fs.ftruncateSync(fd, 0);
        const bytes = Buffer.from(after);
        if (fs.writeSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) process.exitCode = 1;
        fs.fsyncSync(fd);
      }
    } finally { fs.closeSync(fd); }
  `, alphaFile, text.first, text.disk], {
    cwd: root, env: { HOME: root, TMPDIR: root }, signal, timeout: 5_000, maxBuffer: 4_096
  }).catch(() => { throw new CheckFailure('Local fixture editor could not change the expected Alpha text file') })
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

// Script execution only observes the DOM. All interactions use W3C click/keys/refresh;
// the returned values are predicates or opaque element references, never form contents.
function controls(browser, signal) {
  const until = (probe, description) => waitFor(probe, description, { signal })
  const element = (selector, description, labels = null) => until(() => browser.execute(`
    const [selector, labels] = arguments;
    return [...document.querySelectorAll(selector)].find(node => node.getClientRects().length &&
      getComputedStyle(node).visibility === 'visible' && !node.matches(':disabled') &&
      (!labels || labels.includes(node.textContent.trim()))) ?? null;
  `, selector, labels), description)
  return {
    until, element,
    click: async (...args) => browser.click(await element(...args)),
    has: (selector, description) => until(() => browser.execute('return !!document.querySelector(arguments[0]);', selector), description),
    gone: (selector, description) => until(() => browser.execute('return !document.querySelector(arguments[0]);', selector), description),
    async catalog() {
      const field = await element(projectSelect, 'loaded workspace selector')
      check(await browser.execute(`
        const [field, names] = arguments;
        const options = [...field.options];
        const projects = options.filter(option => option.value !== '');
        return options.length === names.length + 1 && options[0].value === '' && field.value === '' &&
          projects.length === names.length && new Set(projects.map(option => option.value)).size === names.length &&
          names.every(name => projects.some(option => !option.disabled && option.textContent.trim() === name &&
            /^w_[a-f0-9]{32}$/.test(option.value)));
      `, field, [alpha, beta]), 'Workspace selector did not contain exactly the two authorized project IDs and the placeholder')
    },
    async select(name) {
      const field = await element(projectSelect, 'workspace selector')
      const option = await until(() => browser.execute(`
        return [...arguments[0].options].find(option => !option.disabled && option.value &&
          option.textContent.trim() === arguments[1]) ?? null;
      `, field, name), 'authorized workspace option')
      await browser.click(option)
      await until(() => browser.execute(`
        const [field, option] = arguments;
        return field.selectedOptions[0] === option && field.value === option.value && option.value !== '';
      `, field, option), 'selected the workspace using its ID')
    },
    async tree(expected) {
      await until(() => browser.execute(`
        const [selector, expected] = arguments;
        const rows = [...document.querySelectorAll(selector)].filter(node => node.getClientRects().length &&
          getComputedStyle(node).visibility === 'visible');
        return rows.length === expected.length && expected.every(([path, type]) =>
          rows.some(node => node.dataset.path === path && node.dataset.type === type));
      `, inside('entry'), expected), 'exact visible entries in the selected project tree')
    },
    async value(selector, text, description, readOnly = false) {
      await until(() => browser.execute(`
        const [selector, expected, readOnly] = arguments;
        const field = document.querySelector(selector);
        return !!field?.getClientRects().length && getComputedStyle(field).visibility === 'visible' &&
          field.readOnly === readOnly && field.value === expected;
      `, selector, text, readOnly), description)
    },
    async typeDraft(text) {
      const field = await element(`${editor}:not([readonly])`, 'writable text editor')
      await browser.click(field)
      // Linux Control+A, release modifiers, and use real Enter for each textarea newline.
      await browser.keys(field, `\uE009a\uE000${text.split('\n').join('\uE007')}`)
      await this.value(editor, text, 'browser editor contains the typed text')
      await this.status('dirty')
    },
    status: (state, role = '') => element(`${inside('status')}[data-status="${state}"]${role}`, `${state} workspace status`)
  }
}

async function claim(browser, ui, origin, runDir) {
  const { credential } = await requestControl({ runDir, op: 'claim' })
  const password = randomBytes(24).toString('hex')
  await browser.navigate(`${origin}/#claim=${encodeURIComponent(credential)}`)
  const field = await ui.element('.wb-auth input[name="password"][type="password"][autocomplete="new-password"]', 'owner claim password input')
  check(await browser.execute(`return location.origin === arguments[0] && location.pathname === '/' &&
    !location.search && !location.hash && !document.querySelector('.wb-auth input[name="credential"]');`, origin),
  'Claim handoff exposed a fragment or a credential field')
  await browser.keys(field, password)
  await ui.click('.wb-auth button[type="submit"]', 'claim via the Workbench form')
  await ui.element('[data-testid="workbench-chat"]', 'authenticated Workbench')
  check((await requestControl({ runDir, op: 'status' })).claimed, 'Local control did not report a claimed owner')
}

const folderRow = [folder, 'dir']
const alphaTree = [folderRow, [binary, 'file'], [large, 'file']]
const betaTree = [folderRow, [betaMarker, 'file']]
const entry = path => `${inside('entry')}[data-path="${path}"]`
const disabledSave = `${inside('save')}:disabled`

async function openWorkspace(ui) {
  await ui.click(hook('open'), 'open workspace files in the Workbench')
  await ui.element(dialog, 'visible native workspace dialog')
  await ui.catalog()
}

async function openDocument(ui, project) {
  await ui.select(project)
  const tree = project === alpha ? alphaTree : betaTree
  await ui.tree(tree)
  await ui.click(`${entry(folder)}[aria-expanded="false"]`, 'expand the nested folder')
  await ui.tree([...tree, [documentPath, 'file']])
  await ui.click(entry(documentPath), 'open the nested text document')
}

async function save(ui) {
  await ui.click(inside('save'), 'explicitly save the editor draft')
  await ui.status('saved')
  await ui.has(disabledSave, 'clean editor has a disabled Save control')
}

async function verifyWritable({ browser, ui, fixture, signal, setStage }) {
  const { alphaFile, betaFile } = fixture
  setStage('preview the isolated workspace tree and save a text edit')
  await openWorkspace(ui)
  await openDocument(ui, alpha)
  await ui.value(editor, text.initial, 'nested text preview preserves Unicode, spaces, and newlines')
  await ui.has(disabledSave, 'unmodified text cannot be saved')
  await ui.typeDraft(text.first)
  check(await readFile(alphaFile, 'utf8') === text.initial, 'The file changed before explicit Save')
  await save(ui)
  check(await readFile(alphaFile, 'utf8') === text.first, 'The first UI save did not reach the Alpha file')

  setStage('retain the draft after an ordinary external edit, then explicitly reload and save')
  await ui.typeDraft(text.draft)
  await externalEdit(fixture, signal)
  check(await readFile(alphaFile, 'utf8') === text.disk, 'The fixture disk edit was not applied')
  await ui.click(inside('save'), 'try saving with the old disk revision')
  await ui.status('conflict', '[role="alert"]')
  await ui.value(editor, text.draft, 'conflict leaves the typed draft intact')
  await ui.has(disabledSave, 'conflicted draft requires a disk reload before saving')
  check(await readFile(alphaFile, 'utf8') === text.disk, 'A stale save overwrote the external disk edit')
  await ui.click(inside('reload'), 'explicitly reload the conflicted file')
  await ui.status('reviewing')
  await ui.value(editor, text.draft, 'reload retains the local draft')
  await ui.value(diskPreview, text.disk, 'review shows the distinct external disk text', true)
  await ui.has(disabledSave, 'review must be acknowledged before Save is enabled')
  await ui.click(`${dialog} .wb-workspace__review-actions button`, 'keep the draft after reviewing the disk version',
    ['Keep draft', '继续使用草稿'])
  await ui.gone(diskPreview, 'disk review closes after accepting the draft')
  await ui.value(editor, text.draft, 'keep-draft restores the writable editor')
  await ui.status('dirty')
  await ui.typeDraft(text.final)
  check(await readFile(alphaFile, 'utf8') === text.disk, 'Reloading or keeping the draft changed the disk before Save')
  await save(ui)
  check(await readFile(alphaFile, 'utf8') === text.final, 'The explicit post-review save did not reach disk')

  setStage('preview binary and oversized files without an editor')
  for (const [path, kind] of [[binary, 'binary'], [large, 'tooLarge']]) {
    await ui.click(entry(path), `open the ${kind} fixture`)
    await ui.status(kind)
    await ui.gone(editor, `${kind} fixture has no text editor`)
    await ui.has(disabledSave, `${kind} fixture cannot be saved`)
  }

  setStage('refresh, reopen, and check persistence and cross-project isolation')
  await ui.click(inside('close'), 'close the workspace dialog')
  await ui.gone(dialog, 'workspace dialog closed')
  await browser.refresh()
  await openWorkspace(ui)
  await openDocument(ui, alpha)
  await ui.value(editor, text.final, 'saved Alpha text persists after browser refresh')
  await openDocument(ui, beta)
  await ui.value(editor, text.beta, 'same relative file in Beta still has its distinct original text')
  check(await readFile(betaFile, 'utf8') === text.beta, 'Alpha edits unexpectedly changed the Beta file on disk')
}

async function verifyReadOnly({ ui, fixture, setStage }) {
  setStage('verify the separate read-only Workbench in the browser')
  await openWorkspace(ui)
  await openDocument(ui, alpha)
  await ui.status('readonly')
  await ui.value(editor, text.final, 'read-only editor displays the saved fixture text', true)
  await ui.has(disabledSave, 'read-only fixture has a disabled Save control')
  check(await readFile(fixture.alphaFile, 'utf8') === text.final, 'The read-only instance changed the Alpha file')
}

async function runInstance({ fixture, webDir, workspaceWritable, signal, setStage, verify }) {
  const mode = workspaceWritable ? 'writable' : 'read-only'
  let workbench, browser, activeError
  try {
    setStage(`start the ${mode} loopback Workbench`)
    const instanceDir = join(fixture.root, mode)
    await mkdir(instanceDir, { mode: 0o700 })
    const dataDir = join(instanceDir, 'data'), keyFile = join(instanceDir, 'master.key'), runDir = join(instanceDir, 'run')
    await initializeMasterKey(keyFile)
    workbench = await startWorkbench({ dataDir, keyFile, runDir, webDir, port: 0,
      businessOptions: { workspaceRoot: fixture.workspaceRoot, workspaceWritable } })
    check(workbench.address.address === '127.0.0.1', 'Workbench listener is not loopback')
    check(await ready(workbench.address.port, signal), 'Workbench readiness check failed')
    setStage(`start sandboxed Chrome for the ${mode} Workbench`)
    browser = await startLocalWebDriver({ root: instanceDir, profile: join(instanceDir, 'chrome-profile'), origin: workbench.origin, signal })
    const ui = controls(browser, signal)
    setStage(`claim the ${mode} Workbench through the owner form`)
    await claim(browser, ui, workbench.origin, runDir)
    await verify({ browser, ui, fixture, signal, setStage })
  } catch (error) {
    activeError = error
    throw error
  } finally {
    let cleanupFailed = false
    for (const [name, cleanup] of [['browser', () => browser?.close()], ['Workbench', () => workbench?.close()]]) {
      try { await cleanup() } catch {
        cleanupFailed = true
        console.error(`Workbench Workspaces browser E2E: ${mode} ${name} cleanup failed`)
      }
    }
    if (cleanupFailed && !activeError) throw new CheckFailure('Instance cleanup failed')
  }
}

const stop = new AbortController()
const abort = () => stop.abort()
process.once('SIGINT', abort)
process.once('SIGTERM', abort)
let stage = 'validate environment'
let root, failed
const setStage = next => { stage = next }
try {
  check(process.platform === 'linux' && process.getuid?.() > 0 && process.geteuid?.() > 0, 'Run this test on Linux as a non-root user')
  setStage('check build outputs')
  for (const entry of ['provider', 'chat', 'library']) {
    await access(new URL(`../../apps/headless/dist/${entry}-core.mjs`, import.meta.url)).catch(() => {
      throw new CheckFailure('Build the headless cores with pnpm --filter @deva/headless build')
    })
  }
  await access(join(DEFAULT_WEB_DIR, 'index.html')).catch(() => { throw new CheckFailure('Build the Workbench with pnpm workbench:build') })
  setStage('create the isolated project fixtures and web directory')
  const prefix = join(await realpath(tmpdir()), 'deva-wb-workspaces-')
  const created = await mkdtemp(prefix)
  check(created.startsWith(prefix) && created.length > prefix.length && await realpath(created) === created, 'Unexpected temporary directory')
  root = created
  const webDir = join(root, 'web')
  await cp(DEFAULT_WEB_DIR, webDir, { recursive: true, force: false, errorOnExist: true })
  const fixture = await seed(root)
  for (const [workspaceWritable, verify] of [[true, verifyWritable], [false, verifyReadOnly]]) {
    await runInstance({ fixture, webDir, workspaceWritable, signal: stop.signal, setStage, verify })
  }
} catch (error) {
  failed = true
  const detail = stop.signal.aborted ? 'interrupted' : error instanceof CheckFailure || error instanceof WebDriverError
    ? error.message : 'unexpected error (raw diagnostics withheld)'
  console.error(`Workbench Workspaces browser E2E failed at ${stage}: ${detail}`)
} finally {
  // Only remove the absolute, canonical directory created and verified above.
  try { if (root) await rm(root, { recursive: true, force: true }) } catch {
    failed = true
    console.error('Workbench Workspaces browser E2E: temporary directory cleanup failed')
  }
  process.removeListener('SIGINT', abort)
  process.removeListener('SIGTERM', abort)
}
if (failed || stop.signal.aborted) process.exitCode = 1
else console.log('Workbench Workspaces browser E2E passed: authorized project tree, explicit saves, external-edit conflict and recovery, binary and oversized previews, persisted isolated text, and read-only controls.')
