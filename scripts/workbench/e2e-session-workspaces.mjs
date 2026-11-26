import { randomBytes } from 'node:crypto'
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requestControl } from '../../apps/headless/src/control/socket.mjs'
import { DEFAULT_WEB_DIR, startWorkbench } from '../../apps/headless/src/server.mjs'
import { initializeMasterKey } from '../../apps/headless/src/storage/vault.mjs'
import { startLocalWebDriver, waitFor, WebDriverError } from './webdriver-local.mjs'

const hook = name => `[data-testid="workbench-${name}"]`
const scope = name => hook(`session-workspace-${name}`)
const sessionLabel = scope('label')
const chat = hook('chat')
const row = `${chat} .cf-list button.cf-thread`
const fileDialog = `dialog${hook('workspace-dialog')}[open]`
const browseSelect = `${fileDialog} select${hook('workspace-select')}`
const notesDialog = hook('project-memory')
const noteTag = `${notesDialog} button.cf-me__tag`
const roleName = 'Fixture Beta reviewer'
const alpha = { name: 'Alpha', file: 'alpha-public.txt', contents: 'Alpha fixture text only.\n', title: 'Alpha scope glossary', body: 'Alpha fixture note: use proof copy.' }
const beta = { name: 'Beta', file: 'beta-public.txt', contents: 'Beta fixture text only.\n', title: 'Beta scope checklist', body: 'Beta fixture note: verify the index.' }
const globalNote = { title: 'Global fixture note', body: 'Global-only fixture note body.' }
const roleNote = { title: 'Role fixture note', body: 'Role-only fixture note body.' }
const replacementFile = 'different-alpha-public.txt'
const wid = /^w_[a-f0-9]{32}$/
const sidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const revisionPattern = /^[0-9a-f]{64}$/

class CheckFailure extends Error {}
function check(condition, diagnostic) {
  if (!condition) throw new CheckFailure(diagnostic)
}

const privateDir = path => mkdir(path, { mode: 0o700 })
const fixtureFile = (path, contents) => writeFile(path, contents, { mode: 0o600, flag: 'wx' })
const absentPath = path => lstat(path).then(() => false, error => { if (error.code === 'ENOENT') return true; throw error })

async function mountProjects(root) {
  const workspaceRoot = join(root, 'projects')
  await privateDir(workspaceRoot)
  for (const project of [alpha, beta]) {
    const directory = join(workspaceRoot, project.name)
    await privateDir(directory)
    await fixtureFile(join(directory, project.file), project.contents)
  }
  return workspaceRoot
}

// Change the live mount from outside Workbench. Preserve the old inode outside the mount, so the
// new same-name project cannot accidentally acquire the old identity by inode reuse.
async function replaceAlpha(root, workspaceRoot) {
  const current = join(workspaceRoot, alpha.name)
  const prepared = join(root, 'new-alpha'), retired = join(root, 'retired-alpha')
  await privateDir(prepared)
  await fixtureFile(join(prepared, replacementFile), 'New directory, distinct public fixture.\n')
  const before = await lstat(current)
  check(await realpath(root) === root && await realpath(workspaceRoot) === workspaceRoot &&
    await realpath(current) === current && await realpath(prepared) === prepared && before.isDirectory() &&
    await absentPath(retired), 'Unexpected path in the controlled Alpha replacement')
  await rename(current, retired)
  check(await realpath(retired) === retired && await realpath(workspaceRoot) === workspaceRoot && await absentPath(current),
    'Alpha replacement destination changed')
  await rename(prepared, current)
  const after = await lstat(current)
  check(await realpath(current) === current && after.isDirectory() && !(before.dev === after.dev && before.ino === after.ino),
    'The replacement Alpha directory did not get a distinct identity')
  for (const [directory, project] of [[retired, alpha], [join(workspaceRoot, beta.name), beta]]) {
    check(await readFile(join(directory, project.file), 'utf8') === project.contents, 'The original synthetic files changed unexpectedly')
  }
}

// Observe production dispatch metadata only. A successful binding PATCH must pass the real
// strict route parser, and the independent GET below checks the entire path-free projection.
// No raw headers, URLs, request bodies, cookies, or note/file content are stored here.
function auditRequests(openBusiness, signal) {
  let pending = []
  return {
    async factory(options) {
      const business = await openBusiness(options)
      return {
        ...business,
        handle(req, res, context) {
          const target = req.url ?? '', path = target.split('?', 1)[0]
          const read = req.method === 'GET' || req.method === 'HEAD'
          const file = /^\/api\/v1\/workspaces\/(w_[a-f0-9]{32})\/(list|read)$/.exec(path)
          const notes = /^\/api\/v1\/memory\/(global|role|project)(?:\/([A-Za-z0-9_.-]+))?$/.exec(path)
          const binding = /^\/api\/v1\/chats\/([A-Za-z0-9_-]+)\/workspace$/.exec(path)
          let kind, ref
          if (file) { kind = file[2]; ref = file[1] }
          else if (notes) { kind = `notes-${notes[1]}`; ref = notes[2] }
          else if (!read && binding) { kind = 'bind'; ref = binding[1] }
          else if (!read && path === '/api/v1/chats') kind = 'create'
          else if (!read && path === '/api/v1/personas') kind = 'seed-role'
          else if (!read || path === '/api/v1/provider-models' || path.startsWith('/api/v1/workspaces/') ||
            path.startsWith('/api/v1/memory/')) kind = 'unexpected'
          if (kind) {
            const event = { kind, ref, method: req.method, verified: target === path && Boolean(context.policy.cookie(req)) &&
              (read || (req.headers.origin === context.policy.origin && req.headers['sec-fetch-site'] === 'same-origin' &&
                Boolean(req.headers['x-deva-csrf']) && /^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? ''))) }
            if (pending.length < 64) pending.push(event)
            res.once('finish', () => { event.status = res.statusCode })
          }
          return business.handle(req, res, context)
        }
      }
    },
    async expect(expected, diagnostic) {
      const matches = (event, [method, kind, ref]) => event.method === method && event.kind === kind && event.ref === ref
      await waitFor(() => {
        // The seed and interactive steps are sequential. An extra call is a failure even if
        // Workbench rejects it or closes its response early.
        check(pending.length <= expected.length && pending.every((event, i) => matches(event, expected[i])),
          'Unexpected model, chat, Workspace, Git, or notes request during: ' + diagnostic)
        if (pending.length !== expected.length || pending.some(event => event.status === undefined)) return false
        check(pending.every(event => event.status === 200 && event.verified), 'Expected owner HTTP operation did not succeed during: ' + diagnostic)
        return true
      }, diagnostic, { signal })
      pending = []
    }
  }
}

// WebDriver scripts observe the DOM and run independent owner GET readbacks. All tested UI
// actions (including choosing an option, opening records and logging in) are native W3C actions.
function controls(browser, signal, root) {
  const until = (probe, description) => waitFor(probe, description, { signal })
  const element = (selector, description, text = null, child = null) => until(() => browser.execute(`
    const [selector, text, child] = arguments;
    return [...document.querySelectorAll(selector)].find(node => node.getClientRects().length &&
      getComputedStyle(node).visibility === 'visible' && !node.matches(':disabled,[aria-disabled="true"]') &&
      (text === null || (child ? node.querySelector(child) : node)?.textContent.trim() === text)) ?? null;
  `, selector, text, child), description)
  return {
    browser, until, element,
    privateMarkers: [root, replacementFile, alpha.file, beta.file, alpha.contents.trim(), beta.contents.trim(),
      ...[alpha, beta, globalNote, roleNote].flatMap(note => [note.title, note.body])],
    click: async (...args) => browser.click(await element(...args)),
    selected: () => browser.execute('return sessionStorage.getItem("deva-workbench.chat");'),
    gone: selector => until(() => browser.execute(`return ![...document.querySelectorAll(arguments[0])].some(
      node => node.getClientRects().length && getComputedStyle(node).visibility === 'visible');`, selector), 'manual panel is closed'),
    async choose(selector, id) {
      const field = await element(selector, 'enabled authorized project chooser')
      const option = await until(() => browser.execute(`
        return [...arguments[0].options].find(node => !node.disabled && node.value === arguments[1]) ?? null;
      `, field, id), 'registered project option')
      await browser.click(option)
      await until(() => browser.execute('return document.querySelector(arguments[0])?.value === arguments[1];', selector, id), 'selected registered project')
    },
    async openChat(sid, role, count) {
      const target = await until(() => browser.execute(`
        const [selector, role, name, count] = arguments;
        const visible = [...document.querySelectorAll(selector)].filter(node => node.getClientRects().length);
        const chosen = visible.filter(node => (node.querySelector('.cf-thread__owner')?.textContent.trim() === name) === role);
        return visible.length === count && chosen.length === 1 ? chosen[0] : null;
      `, row, role, roleName, count), 'intended chat in the visible conversation list')
      await browser.click(target)
      await until(async () => await this.selected() === sid, 'the intended conversation is selected')
    },
    newSid(prior = null) {
      return until(async () => {
        const sid = await this.selected()
        return sid !== prior && sidPattern.test(sid ?? '') ? sid : null
      }, 'new conversation selected by its native user action')
    },
    async onlyTree(project) {
      await until(() => browser.execute(`
        const [selector, expected] = arguments;
        const rows = [...document.querySelectorAll(selector)].filter(node => node.getClientRects().length);
        return rows.length === 1 && rows[0].dataset.path === expected && rows[0].dataset.type === 'file';
      `, `${fileDialog} ${hook('workspace-entry')}`, project.file), 'only the selected project is listed in the real file tree')
    },
    noManualPanel: () => browser.execute(`return !document.querySelector(arguments[0]);`,
      `${fileDialog}, ${notesDialog}, [data-testid="workspace-git-panel"]`)
  }
}

async function authenticate(ui, mode, password) {
  const input = await ui.element(`.wb-auth input[name="password"][type="password"][autocomplete="${mode}-password"]`, 'owner password form')
  await ui.browser.keys(input, password)
  await ui.click('.wb-auth button[type="submit"]', 'authenticate through the Workbench form')
  await ui.element(chat, 'authenticated Workbench')
}

const api = `async (path, method = 'GET', body, csrf) => {
  const response = await fetch('/api/v1/' + path, { method, credentials: 'same-origin', mode: 'same-origin',
    cache: 'no-store', redirect: 'error', ...(body === undefined ? {} : { body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', 'x-deva-csrf': csrf } }) });
  return response.status === 200 ? response.json() : null;
}`

async function catalog(ui) {
  const result = await ui.browser.executeAsync(`
    const [names, done] = arguments;
    const api = ${api};
    (async () => {
      const boot = await api('bootstrap');
      if (boot?.capabilities?.sessionWorkspaces !== true || boot.capabilities.gitInspect !== true) return null;
      const { workspaces } = await api('workspaces') ?? {};
      if (workspaces?.length !== names.length || !workspaces.every(row => Object.keys(row).sort().join(',') === 'id,name')) return null;
      return names.map(name => workspaces.find(row => row.name === name)?.id ?? null);
    })().then(done, () => done(null));
  `, [alpha.name, beta.name])
  check(result?.length === 2 && result.every(id => wid.test(id ?? '')) && result[0] !== result[1],
    'Bootstrap capability or two distinct path-free project options missing')
  return { alphaId: result[0], betaId: result[1] }
}

// API setup is limited to synthetic roster/notes content; the actual roles, chat scope controls,
// browse flow, note opening and mutations under test are exercised through the real UI.
async function seedLibrary(ui, { alphaId, betaId }) {
  const roleId = await ui.browser.executeAsync(`
    const [name, alphaId, betaId, notes, done] = arguments;
    const api = ${api};
    (async () => {
      const boot = await api('bootstrap');
      if (typeof boot?.csrf !== 'string' || !boot.csrf.length) return null;
      const { role } = await api('personas', 'POST', { name, enabled: true, workspaceId: betaId }, boot.csrf) ?? {};
      if (!role?.enabled || role.workspaceId !== betaId || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(role.id)) return null;
      const scopes = ['project/' + alphaId, 'project/' + betaId, 'global', 'role/' + role.id];
      for (const [i, scope] of scopes.entries()) {
        const path = 'memory/' + scope;
        const before = await api(path);
        if (before?.snapshot.entries.length !== 0) return null;
        const saved = await api(path, 'POST', { input: { type: 'reference', ...notes[i] }, revision: before.revision }, boot.csrf);
        if (!saved?.ok || saved.snapshot.entries.length !== 1 || saved.snapshot.entries[0].title !== notes[i].title) return null;
      }
      return role.id;
    })().then(done, () => done(null));
  `, roleName, alphaId, betaId, [alpha, beta, globalNote, roleNote].map(({ title, body }) => ({ title, body })))
  check(roleId, 'Authenticated library fixture setup failed')
  return roleId
}

const binding = (id, name, source, state = 'available') => ({ id, name, state, source })
function readBack(observer, sid, workspace, personaId, diagnostic) {
  return observer.until(async () => {
    const result = await observer.browser.executeAsync(`
      const [sid, workspace, personaId, markers, done] = arguments;
      const api = ${api};
      (async () => {
        const path = 'chats/' + encodeURIComponent(sid);
        const [document, history, list] = await Promise.all([api(path + '/workspace'), api(path), api('chats')]);
        const projection = JSON.stringify([document, history, list]);
        if (markers.some(marker => projection.includes(marker))) return false;
        const row = list?.sessions.find(entry => entry.id === sid);
        const state = history?.state;
        if (!document || Object.keys(document).sort().join(',') !== 'revision,workspace' ||
            (workspace === null ? document.workspace !== null : !document.workspace ||
              Object.keys(document.workspace).sort().join(',') !== 'id,name,source,state' ||
              !Object.keys(workspace).every(key => workspace[key] === document.workspace[key]))) return null;
        if (!row || state?.id !== sid || ![row, state].every(entry => entry.compatibility === 'text' &&
          (entry.personaId ?? null) === personaId) || state.active || state.messages?.length !== 0) return null;
        return document.revision;
      })().then(done, () => done(null));
    `, sid, workspace, personaId, observer.privateMarkers)
    check(result !== false, 'A project path, file, or note leaked in the public chat projection')
    return revisionPattern.test(result ?? '') ? result : false
  }, diagnostic)
}

async function checkLabel(ui, state, name = null) {
  await ui.until(() => ui.browser.execute(`
    const [selector, actions, state, name, names] = arguments;
    const visible = node => !!node?.getClientRects().length && getComputedStyle(node).visibility === 'visible';
    const label = document.querySelector(selector);
    const row = document.querySelector(actions);
    if (!visible(row) || row.dataset.state !== state) return false;
    if (state === 'unbound') return !visible(label);
    return visible(label) && label.dataset.state === state &&
      (name === null ? names.every(project => !label.textContent.includes(project)) : label.textContent.includes(name));
  `, sessionLabel, hook('session-workspace'), state, name, [alpha.name, beta.name]), `visible ${state} session workspace controls`)
}

async function viewNotes(ui, wire, project, projectId, root) {
  await ui.click(scope('open-notes'), 'explicitly open notes for the attached project')
  await ui.element(notesDialog, 'scoped project notes panel')
  await ui.element(noteTag, 'the manually requested notes for the attached project', project.title)
  check(await ui.browser.execute(`
    const [selector, title] = arguments;
    const tags = [...document.querySelectorAll(selector)];
    return tags.length === 1 && tags[0].textContent.trim() === title;
  `, noteTag, project.title), 'The notes panel was not exclusive to the selected project')
  await ui.click(noteTag, 'open the requested project note', project.title)
  const body = await ui.element(hook('memory-body'), 'visible project note body')
  const other = project === alpha ? beta : alpha
  check(await ui.browser.execute(`
    const [field, body, excluded] = arguments;
    const shown = document.body.innerText + ' ' + document.body.innerHTML;
    return field.value === body && excluded.every(marker => !shown.includes(marker));
  `, body, project.body, [root, other.title, other.body, globalNote.title, globalNote.body, roleNote.title, roleNote.body]),
  'The note body differed or an unrelated fixture appeared in the DOM')
  await ui.click(hook('project-memory-close'), 'close the explicitly opened project notes')
  await ui.gone(notesDialog)
  await wire.expect([['GET', 'notes-project', projectId]], 'one explicitly scoped project notes read')
}

async function noPreview(ui, wire, diagnostic) {
  check(await ui.noManualPanel(), 'A manual detail panel opened during: ' + diagnostic)
  await wire.expect([], diagnostic)
}

async function verifyManualAttachment(ctx, setStage) {
  const { a, b, wire, projects: { alphaId }, root } = ctx
  setStage('create an ordinary text chat and select a project for manual browsing only')
  await a.click(`${chat} ${hook('new-chat')}`, 'start an ordinary text chat')
  const sid = await a.newSid()
  const initial = await readBack(b, sid, null, null, 'ordinary chat has no workspace or role')
  await checkLabel(a, 'unbound')
  await wire.expect([['POST', 'create']], 'ordinary chat creation alone')
  await a.click(hook('workspace-open'), 'explicitly open the original manual Workspace files')
  await a.choose(browseSelect, alphaId)
  await a.onlyTree(alpha)
  await a.click(`${fileDialog} ${hook('workspace-close')}`, 'close the manual project browser')
  await a.gone(fileDialog)
  check(await readBack(b, sid, null, null, 'browsing has not attached a scope') === initial, 'Browsing changed the session workspace revision')
  await checkLabel(a, 'unbound')
  await wire.expect([['POST', 'list', alphaId]], 'one manual directory browse, with no attachment, Git, file reads or notes')

  setStage('attach Alpha explicitly and verify the label after native refresh')
  await a.choose(`select${scope('chooser')}`, alphaId)
  await noPreview(a, wire, 'choosing an attachment candidate before pressing Attach')
  check(await readBack(b, sid, null, null, 'candidate selection alone still has no binding') === initial, 'Selecting a candidate changed the workspace revision')
  await a.click(scope('bind'), 'explicitly attach Alpha to the current chat')
  const bound = binding(alphaId, alpha.name, 'manual')
  const revision = await readBack(b, sid, bound, null, 'second login reads the manual Alpha attachment')
  check(revision !== initial, 'Manual attachment did not change the scope revision')
  await checkLabel(a, 'available', alpha.name)
  await wire.expect([['PATCH', 'bind', sid]], 'manual binding alone')
  await b.openChat(sid, false, 1)
  await checkLabel(b, 'available', alpha.name)
  await a.browser.refresh()
  await a.until(async () => await a.selected() === sid, 'refresh restores the same ordinary conversation')
  await checkLabel(a, 'available', alpha.name)
  check(await readBack(b, sid, bound, null, 'Alpha still attached after refresh') === revision, 'Refresh changed the scope revision')
  await noPreview(a, wire, 'opening the already-bound chat and refreshing its label')

  setStage('explicitly open bound Workspace files and then only the bound project notes')
  await a.click(scope('open'), 'open exactly the attached Workspace files')
  await a.onlyTree(alpha)
  await a.gone(`${fileDialog} ${hook('workspace-editor')}`)
  await wire.expect([['POST', 'list', alphaId]], 'bound Workspace opens only the requested directory before a file is clicked')
  await a.click(`${fileDialog} ${hook('workspace-entry')}[data-path="${alpha.file}"]`, 'explicitly open the Alpha fixture file')
  await a.until(() => a.browser.execute(`
    const field = document.querySelector(arguments[0]);
    return !!field?.getClientRects().length && field.readOnly && field.value === arguments[1];
  `, `${fileDialog} ${hook('workspace-editor')}`, alpha.contents), 'exact read-only Alpha text after the separate file click')
  await a.click(`${fileDialog} ${hook('workspace-close')}`, 'close the attached project file browser')
  await a.gone(fileDialog)
  await wire.expect([['POST', 'read', alphaId]], 'only the explicitly opened file is read from the attached project')
  await viewNotes(a, wire, alpha, alphaId, root)
  return { sid, bound, revision }
}

async function verifyRoleDefault(ctx, manual, setStage) {
  const { a, b, wire, projects: { betaId }, roleId } = ctx
  setStage('launch a real role chat and switch between its Beta default and the manual Alpha binding')
  await a.click(hook('roster'), 'open the role roster')
  await a.click(`${hook('roster-panel')} ${hook('role-row')}`, 'select the fixture reviewer', roleName, '.cf-prow__name')
  await a.click(hook('role-start'), 'use the real Start chat control for the selected role')
  await a.gone(hook('roster-panel'))
  const sid = await a.newSid(manual.sid)
  await a.element(hook('chat-persona'), 'actual role identity in the role chat header', roleName)
  const bound = binding(betaId, beta.name, 'role')
  const revision = await readBack(b, sid, bound, roleId, 'role chat inherits Beta as its actual scope')
  await checkLabel(a, 'available', beta.name)
  await wire.expect([['POST', 'create']], 'role launch with no additional workspace mutation or preview')
  await a.openChat(manual.sid, false, 2)
  await checkLabel(a, 'available', alpha.name)
  check(await readBack(b, manual.sid, manual.bound, null, 'manual chat still owns Alpha') === manual.revision,
    'Launching the role chat changed the ordinary binding')
  await a.openChat(sid, true, 2)
  await checkLabel(a, 'available', beta.name)
  check(await readBack(b, sid, bound, roleId, 'role chat still owns Beta') === revision, 'Switching chats changed the role binding')
  await noPreview(a, wire, 'reopening both independently bound conversations')
  await viewNotes(a, wire, beta, betaId, ctx.root)
  return { sid, bound, revision }
}

async function verifyReplacementAndDetach(ctx, manual, role, setStage) {
  const { a, b, wire, root, workspaceRoot, projects, roleId } = ctx
  setStage('replace Alpha externally and verify unavailable state retains only the original opaque identity')
  await a.openChat(manual.sid, false, 2)
  await checkLabel(a, 'available', alpha.name)
  await replaceAlpha(root, workspaceRoot)
  const replacement = await catalog(b)
  check(replacement.alphaId !== projects.alphaId && replacement.betaId === projects.betaId,
    'Same-name replacement was not a fresh Alpha identity or displaced Beta')
  const unavailable = binding(projects.alphaId, null, 'manual', 'unavailable')
  const beforeDetach = await readBack(b, manual.sid, unavailable, null, 'old Alpha ID has unavailable state with a null name')
  check(await readBack(b, role.sid, role.bound, roleId, 'independent Beta is unaffected') === role.revision,
    'Replacing Alpha changed the Beta binding')
  await a.browser.refresh()
  await a.until(async () => await a.selected() === manual.sid, 'restored selected chat after external replacement')
  await checkLabel(a, 'unavailable')
  check(await a.browser.execute(`
    const controls = [...document.querySelectorAll(arguments[0])];
    return controls.every(node => !node.getClientRects().length || node.matches(':disabled,[aria-disabled="true"]'));
  `, `${scope('open')}, ${scope('open-notes')}`), 'A stale binding exposed an enabled files or notes action')
  await noPreview(a, wire, 'displaying a stale binding without opening the replacement')

  setStage('detach the stale scope through the owner UI and verify the same SID in the second login')
  const documentTime = await b.browser.execute('return performance.timeOrigin;')
  await a.click(scope('release'), 'owner explicitly detaches the unavailable project')
  const detached = await readBack(b, manual.sid, null, null, 'second owner page sees the detached scope on the same SID')
  await checkLabel(a, 'unbound')
  await checkLabel(b, 'unbound')
  check(detached !== beforeDetach && detached !== manual.revision && await b.selected() === manual.sid &&
    await b.browser.execute('return performance.timeOrigin;') === documentTime, 'Detach did not produce a new revision in the existing observer page')
  await b.browser.refresh()
  await b.until(async () => await b.selected() === manual.sid, 'observer refresh preserves the original SID')
  await checkLabel(b, 'unbound')
  await wire.expect([['PATCH', 'bind', manual.sid]], 'explicit detach alone')
  await a.openChat(role.sid, true, 2)
  await checkLabel(a, 'available', beta.name)
  check(await readBack(b, role.sid, role.bound, roleId, 'Beta remains bound after detach') === role.revision,
    'Detaching Alpha changed the distinct role chat')
  await noPreview(a, wire, 'final selected Beta label without any implicit preview')
}

const stop = new AbortController()
const abort = () => stop.abort()
process.once('SIGINT', abort)
process.once('SIGTERM', abort)
const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(180_000)])
let stage = 'validate environment'
const setStage = value => { stage = value }
let root, workbench, browserA, browserB, failed
try {
  check(process.argv.length === 2, 'Usage: node scripts/workbench/e2e-session-workspaces.mjs')
  check(process.platform === 'linux' && process.getuid?.() > 0 && process.geteuid?.() > 0, 'Run on Linux as a non-root user')
  check(Number(process.versions.node.split('.')[0]) >= 22, 'Run with Node 22 or later')
  setStage('check the Workbench build outputs')
  await Promise.all(['provider', 'chat', 'library'].map(entry =>
    access(new URL(`../../apps/headless/dist/${entry}-core.mjs`, import.meta.url)))).catch(() => {
    throw new CheckFailure('Build the headless cores with pnpm headless:test')
  })
  await access(join(DEFAULT_WEB_DIR, 'index.html')).catch(() => { throw new CheckFailure('Build the Workbench with pnpm workbench:build') })
  const { openBusiness } = await import('../../apps/headless/src/business/handlers.mjs')

  setStage('start the real Workbench with private fixture data and a loopback listener')
  const prefix = join(await realpath(tmpdir()), 'deva-wb-session-workspaces-')
  const created = await mkdtemp(prefix)
  check(created.startsWith(prefix) && created.length > prefix.length && await realpath(created) === created, 'Unexpected temporary directory')
  root = created
  const [keyFile, runDir, dataDir, homeA, homeB] = ['master.key', 'run', 'data', 'browser-a', 'browser-b'].map(name => join(root, name))
  await Promise.all([privateDir(homeA), privateDir(homeB)])
  const workspaceRoot = await mountProjects(root)
  await initializeMasterKey(keyFile)
  const wire = auditRequests(openBusiness, signal)
  workbench = await startWorkbench({ dataDir, keyFile, runDir, host: '127.0.0.1', port: 0, businessFactory: wire.factory,
    businessOptions: { workspaceRoot, gitProjects: [alpha.name], allowedOrigins: [] } })
  const { origin } = workbench
  check(workbench.address.address === '127.0.0.1' && origin === `http://127.0.0.1:${workbench.address.port}`, 'Workbench listener is not loopback')
  const ready = await fetch(`${origin}/readyz`, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) })
  await ready.body?.cancel()
  check(ready.status === 200, 'Workbench readiness failed')

  setStage('start sandboxed Chrome A and claim the fresh owner through Workbench')
  browserA = await startLocalWebDriver({ root: homeA, profile: join(homeA, 'profile'), origin, signal })
  const a = controls(browserA, signal, root)
  const password = randomBytes(24).toString('hex')
  const { credential } = await requestControl({ runDir, op: 'claim' })
  await browserA.navigate(`${origin}/#claim=${encodeURIComponent(credential)}`)
  await authenticate(a, 'new', password)
  check((await requestControl({ runDir, op: 'status' })).claimed === true, 'Unix control did not report the claimed owner')

  setStage('start sandboxed Chrome B using a distinct profile and genuine owner login')
  browserB = await startLocalWebDriver({ root: homeB, profile: join(homeB, 'profile'), origin, signal })
  const b = controls(browserB, signal, root)
  await browserB.navigate(`${origin}/`)
  await authenticate(b, 'current', password)
  await wire.expect([], 'startup and both owner logins')

  setStage('seed public role and contrasting note fixtures via authenticated library setup')
  const projects = await catalog(b)
  const roleId = await seedLibrary(a, projects)
  await wire.expect([['POST', 'seed-role'], ['GET', 'notes-project', projects.alphaId], ['POST', 'notes-project', projects.alphaId],
    ['GET', 'notes-project', projects.betaId], ['POST', 'notes-project', projects.betaId],
    ['GET', 'notes-global'], ['POST', 'notes-global'], ['GET', 'notes-role', roleId], ['POST', 'notes-role', roleId]], 'explicit authenticated fixture setup')
  const ctx = { a, b, wire, root, workspaceRoot, projects, roleId }
  const manual = await verifyManualAttachment(ctx, setStage)
  const role = await verifyRoleDefault(ctx, manual, setStage)
  await verifyReplacementAndDetach(ctx, manual, role, setStage)
} catch (error) {
  failed = true
  const detail = signal.aborted ? 'interrupted or timed out' :
    error instanceof CheckFailure || error instanceof WebDriverError ? error.message : 'unexpected error (raw diagnostics withheld)'
  console.error(`Workbench Session Workspaces browser E2E failed at ${stage}: ${detail}`)
} finally {
  for (const [name, cleanup] of [
    ['browser B', () => browserB?.close()], ['browser A', () => browserA?.close()], ['Workbench', () => workbench?.close()],
    ['temporary directory', async () => {
      if (!root) return
      check(await realpath(root) === root && (await lstat(root)).isDirectory(), 'Temporary directory has changed')
      await rm(root, { recursive: true })
    }]
  ]) {
    try { await cleanup() } catch {
      failed = true
      console.error(`Workbench Session Workspaces browser E2E: ${name} cleanup failed`)
    }
  }
  process.removeListener('SIGINT', abort)
  process.removeListener('SIGTERM', abort)
}
if (failed || signal.aborted) process.exitCode = 1
else console.log('Workbench Session Workspaces browser E2E passed: manual browse and attach, persistent independent chat scopes, role default, explicit file and notes reads, unavailable replacement, and cross-login detach.')
