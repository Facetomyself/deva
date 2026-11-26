import { randomBytes } from 'node:crypto'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import {
  alpha, beta, betaFile, branch, check, earlierSubject, extraBranch, GitViewCheckError, headLine, headSubject,
  makeGitViewRoot, notes, seedGitViewFixture, stagedLine, worktreeLine
} from './e2e-git-view-fixture.mjs'
import { startLocalWebDriver, waitFor, WebDriverError } from './webdriver-local.mjs'

const hook = name => `[data-testid="${name}"]`
const workspace = name => hook(`workbench-workspace-${name}`)
const dialog = `dialog${workspace('dialog')}[open]`
const git = name => hook(`workspace-git-${name}`)
const toggle = `${dialog} ${git('toggle')}`
const panel = `${dialog} ${git('panel')}`
const inside = name => `${panel} ${git(name)}`
const chat = hook('workbench-chat')
const wid = /^w_[0-9a-f]{32}$/
const gitPath = /^\/api\/v1\/workspaces\/(w_[0-9a-f]{32})\/git\/(status|branches|log|diff)$/
const gitContent = [branch, extraBranch, headSubject, earlierSubject, headLine, stagedLine, worktreeLine]

// Observe only real requests passed through the production business handler. Do not consume
// bodies, alter dispatch or responses, or keep cookies, CSRF tokens, URLs, or Git contents.
function observeWire(openBusiness, signal) {
  let pending = [], otherWrites = 0
  return {
    async factory(options) {
      const business = await openBusiness(options)
      return {
        ...business,
        handle(req, res, context) {
          const url = req.url ?? ''
          const path = url.split('?', 1)[0]
          const match = gitPath.exec(path)
          if (path.startsWith('/api/v1/workspaces/') && path.includes('/git')) {
            const observation = {
              project: match?.[1], action: match?.[2],
              sameOrigin: req.headers.origin === context.policy.origin && req.headers['sec-fetch-site'] === 'same-origin',
              owner: Boolean(context.policy.cookie(req)), csrf: Boolean(req.headers['x-deva-csrf']),
              post: req.method === 'POST' && url === path && /^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')
            }
            pending.push(observation)
            res.once('finish', () => { observation.status = res.statusCode })
          } else if ((req.method !== 'GET' && req.method !== 'HEAD') || path === '/api/v1/provider-models') {
            ++otherWrites
          }
          return business.handle(req, res, context)
        }
      }
    },
    assertNoWrites() {
      check(otherWrites === 0, 'The workspace flow invoked a chat, model, or other non-Git write route')
    },
    idle() {
      check(pending.length === 0, 'A Git request arrived without the expected explicit click')
      this.assertNoWrites()
    },
    async clicked(project, action, status = 200) {
      const observation = await waitFor(() => pending[0]?.status ? pending[0] : null, `real HTTP response to Git ${action}`, { signal })
      check(pending.length === 1 && observation.project === project && observation.action === action &&
        observation.status === status && observation.post && observation.sameOrigin && observation.owner && observation.csrf,
      `Git ${action} did not send one same-origin owner JSON POST with CSRF and the expected status`)
      pending = []
      this.idle()
    }
  }
}

// Synchronous browser scripts only inspect DOM. All user interactions go through the native
// W3C element click/keys commands from the shared helper, including the project selection.
function controls(browser, signal) {
  const until = (probe, description) => waitFor(probe, description, { signal })
  const visible = (selector, description) => until(() => browser.execute(`
    return [...document.querySelectorAll(arguments[0])].find(node => node.getClientRects().length &&
      getComputedStyle(node).visibility === 'visible' && !node.matches(':disabled')) ?? null;
  `, selector), description)
  const click = async (selector, description) => browser.click(await visible(selector, description))
  return {
    until, visible, click,
    async openWorkspace() {
      await click(workspace('open'), 'workspace toolbar button')
      await visible(dialog, 'original native workspace dialog')
    },
    absent(selector, description) {
      return until(() => browser.execute('return !document.querySelector(arguments[0]);', selector), description)
    },
    async catalog() {
      const field = await visible(`${dialog} select${workspace('select')}`, 'loaded workspace selector')
      const rows = await browser.execute(`
        const [field, names] = arguments;
        const options = [...field.options];
        if (options.length !== 3 || options[0].value !== '' || field.value !== '') return null;
        return names.map(name => options.find(row => !row.disabled && row.textContent.trim() === name)?.value ?? null);
      `, field, [alpha, beta])
      check(rows?.length === 2 && rows.every(id => typeof id === 'string' && wid.test(id)) && rows[0] !== rows[1],
        'The workspace selector did not contain exactly Alpha and Beta as distinct projects')
      return { alphaId: rows[0], betaId: rows[1] }
    },
    async select(project, file) {
      const field = await visible(`${dialog} select${workspace('select')}`, 'enabled workspace selector')
      const option = await until(() => browser.execute(`
        return [...arguments[0].options].find(row => !row.disabled && row.value === arguments[1]) ?? null;
      `, field, project), 'authorized workspace option')
      await browser.click(option)
      await until(() => browser.execute('return arguments[0].value === arguments[1];', field, project), 'selected workspace')
      await visible(`${dialog} ${workspace('entry')}[data-path="${file}"]`, 'tree for the selected project')
    },
    async privacy(markers) {
      check(await browser.execute(`
        const [markers] = arguments;
        return markers.every(marker => !document.body.innerText.includes(marker) && !document.body.innerHTML.includes(marker));
      `, markers), 'Private or stale Git information appeared in the Workbench DOM')
    }
  }
}

async function claim(browser, ui, origin, runDir, requestControl) {
  const { credential } = await requestControl({ runDir, op: 'claim' })
  await browser.navigate(`${origin}/#claim=${encodeURIComponent(credential)}`)
  const field = await ui.visible('.wb-auth input[name="password"][type="password"][autocomplete="new-password"]', 'owner claim form')
  check(await browser.execute('return location.origin === arguments[0] && location.pathname === "/" && !location.search && !location.hash;', origin),
    'Workbench claim did not remain on the expected same-origin page')
  await browser.keys(field, randomBytes(24).toString('base64url'))
  await ui.click('.wb-auth button[type="submit"]', 'explicitly claim the owner account')
  await ui.visible(chat, 'authenticated Workbench shell')
  check((await requestControl({ runDir, op: 'status' })).claimed === true, 'Local control did not confirm the claimed owner')
}

async function showStatus({ browser, ui, wire, fixture }, project, action) {
  await ui.click(action === 'open' ? `${toggle}[aria-expanded="false"]` : inside('refresh'), `explicit Git ${action}`)
  await ui.visible(panel, 'visible Git inspection panel')
  await ui.until(() => browser.execute(`
    const [toggle, status, branch] = arguments;
    return document.querySelector(toggle)?.textContent.trim() === branch &&
      ['ready', 'partial'].includes(document.querySelector(status)?.dataset.status);
  `, toggle, inside('status'), branch), 'Git status and real current branch')
  await wire.clicked(project, 'status')
  await ui.privacy(fixture.privateMarkers)
}

async function showBranchesAndHistory({ browser, ui, wire, fixture }, project) {
  await ui.click(inside('branches'), 'explicit Git Branches')
  await ui.until(() => browser.execute(`
    const [selector, current, extra] = arguments;
    const rows = [...document.querySelectorAll(selector + ' li')];
    const named = label => rows.find(row => row.querySelector('bdi')?.textContent === label);
    return rows.length === 2 && named(current)?.getAttribute('aria-current') === 'true' &&
      named(extra)?.getAttribute('aria-current') === null;
  `, inside('branch-list'), branch, extraBranch), 'real current and additional local branches')
  await wire.clicked(project, 'branches')
  await ui.privacy(fixture.privateMarkers)

  await ui.click(inside('history'), 'explicit Git History')
  await ui.until(() => browser.execute(`
    const [selector, expected] = arguments;
    const rows = [...document.querySelectorAll(selector + ' li')];
    return rows.length === expected.length && rows.every((row, i) => {
      const [oid, subject] = expected[i];
      const short = row.querySelector('code');
      return row.getClientRects().length && row.querySelector('.wb-git__subject')?.textContent === subject &&
        short?.title === oid && /^[a-f0-9]{4,40}$/.test(short.textContent) && oid.startsWith(short.textContent);
    });
  `, inside('commit-list'), [[fixture.head, headSubject], [fixture.first, earlierSubject]]), 'both packed commit subjects and their real SHA-1 identifiers')
  await ui.absent(inside('load-more'), 'two-commit history is fully loaded')
  await wire.clicked(project, 'log')
  await ui.privacy(fixture.privateMarkers)
}

async function showDiffs({ browser, ui, wire, fixture }, project) {
  await ui.click(`${panel} .wb-git__tabs button:first-child`, 'return to Git Changes')
  wire.idle()
  const entry = await ui.until(() => browser.execute(`
    const [panel, path] = arguments;
    const rows = [...(document.querySelector(panel)?.querySelectorAll('button[data-testid^="workspace-git-entry-"]') ?? [])];
    if (rows.length !== 1 || rows[0].disabled || !rows[0].getClientRects().length || rows[0].querySelector('bdi')?.textContent !== path) return null;
    return /^workspace-git-entry-(e_[0-9a-f]{32})$/.exec(rows[0].dataset.testid)?.[1] ?? null;
  `, panel, notes), 'one visible tracked change with an opaque entry ID')
  for (const [side, before, after, oldNo, newNo, otherBaseline] of [
    ['staged', headLine, stagedLine, '2', '3', worktreeLine],
    ['worktree', stagedLine, worktreeLine, '3', '3', headLine]
  ]) {
    await ui.click(inside(`diff-${entry}-${side}`), `explicit ${side} comparison for the selected notes row`)
    const diff = `${inside('diff')}[data-state="ready"][data-side="${side}"]`
    await ui.until(() => browser.execute(`
      const [selector, path, before, after, oldNo, newNo, otherBaseline] = arguments;
      const diff = document.querySelector(selector);
      if (!diff?.getClientRects().length || diff.querySelector('h4 bdi')?.textContent !== path ||
          diff.textContent.includes(otherBaseline)) return false;
      const line = (kind, text, a, b) => [...diff.querySelectorAll('.diffview__line.' + kind)].some(row => {
        const nums = [...row.querySelectorAll('.diffview__no')].map(node => node.textContent.trim());
        const sign = row.querySelector('.diffview__sign')?.textContent;
        return row.getClientRects().length && nums.length === 2 && nums[0] === a && nums[1] === b &&
          sign === (kind === 'del' ? '−' : '+') && row.querySelector('.diffview__text')?.textContent === text;
      });
      return line('del', before, oldNo, '') && line('add', after, '', newNo);
    `, diff, notes, before, after, oldNo, newNo, otherBaseline), `visible ${side} deletion and addition with correct old and new line numbers`)
    await wire.clicked(project, 'diff')
    await ui.privacy(fixture.privateMarkers)
  }
}

async function verifyReset(ctx, alphaId, betaId) {
  const { ui, wire, fixture } = ctx
  const hidden = async () => {
    await ui.absent(git('panel'), 'Git panel removed, including all previous rows')
    await ui.privacy([...fixture.privateMarkers, ...gitContent])
    wire.idle()
  }
  await ui.select(betaId, betaFile)
  await hidden()
  await ui.click(`${toggle}[aria-expanded="false"]`, 'explicitly try the ungranted Beta Git panel')
  await ui.visible(`${inside('status')}[data-status="not_granted"] [role="alert"]`, 'Git grant denial in the Beta workspace')
  await wire.clicked(betaId, 'status', 403)
  await ui.privacy([...fixture.privateMarkers, ...gitContent])

  await ui.select(alphaId, notes)
  await hidden()
  await showStatus(ctx, alphaId, 'open')
  await ui.click(`${toggle}[aria-expanded="true"]`, 'close the Git panel without leaving the workspace dialog')
  await hidden()
  await showStatus(ctx, alphaId, 'open')
  await ui.click(`${dialog} ${workspace('close')}`, 'close the native workspace dialog')
  await ui.absent(dialog, 'closed workspace dialog')
  await hidden()
  await ui.openWorkspace()
  await hidden()
  await ui.click(`${dialog} ${workspace('close')}`, 'close the reopened workspace dialog')
  await ui.absent(dialog, 'closed reopened workspace dialog')
  await hidden()
}

// These isolated, read-only negative probes run only after all actual browser assertions.
// Keep bootstrap CSRF and wire error bodies in the page and return only fixed outcomes.
async function verifyHttpGuards(browser, origin, alphaId, betaId) {
  check(wid.test(alphaId) && wid.test(betaId) && alphaId !== betaId, 'Unexpected workspace IDs for the HTTP probes')
  const result = await browser.executeAsync(`
    const [origin, alpha, beta, rawPath, finish] = arguments;
    if (location.origin !== origin) return finish(1);
    const fetchApi = (path, init = {}) => fetch('/api/v1/' + path, {
      credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', ...init
    });
    const path = (project, action) => 'workspaces/' + project + '/git/' + action;
    const post = (body, csrf, credentials = 'same-origin') => ({
      method: 'POST', credentials, body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...(csrf ? { 'x-deva-csrf': csrf } : {}) }
    });
    (async () => {
      const bootstrap = await fetchApi('bootstrap');
      if (!bootstrap.ok) return 2;
      const { csrf } = await bootstrap.json();
      if (typeof csrf !== 'string' || !csrf.length) return 2;
      for (const action of ['status', 'diff']) {
        const response = await fetchApi(path(alpha, action));
        const { error } = await response.json();
        // Browsers can omit Origin on same-origin GET. The origin or method guard must reject it.
        if (!(response.status === 403 && error === 'origin') &&
            !(response.status === 405 && error === 'method' && response.headers.get('allow') === 'POST')) return 3;
      }
      const anonymous = await fetchApi(path(alpha, 'status'), post({}, csrf, 'omit'));
      if (anonymous.status !== 401 || (await anonymous.json()).error !== 'auth') return 4;
      const noCsrf = await fetchApi(path(alpha, 'status'), post({}));
      const csrfError = (await noCsrf.json()).error;
      if (!(noCsrf.status === 401 && csrfError === 'auth') && !(noCsrf.status === 403 && csrfError === 'csrf_failed')) return 5;
      async function status() {
        const response = await fetchApi(path(alpha, 'status'), post({}, csrf));
        if (response.status !== 200) return null;
        const data = await response.json();
        const entry = data.entries?.find(row => row.rel === rawPath && row.diffSides?.includes('staged'));
        return data.workspaceId === alpha && /^v_[a-f0-9]{32}$/.test(data.viewId) && /^e_[a-f0-9]{32}$/.test(entry?.entryId)
          ? { viewId: data.viewId, entryId: entry.entryId, side: 'staged' } : null;
      }
      const before = await status();
      if (!before) return 6;
      const raw = await fetchApi(path(alpha, 'diff'), post({ ...before, path: rawPath }, csrf));
      if (raw.status !== 400 || (await raw.json()).error !== 'invalid_git_request') return 7;
      const denied = await fetchApi(path(beta, 'status'), post({}, csrf));
      if (denied.status !== 403 || (await denied.json()).error !== 'git_not_granted') return 8;
      const after = await status();
      if (!after || after.viewId === before.viewId || after.entryId === before.entryId) return 6;
      const stale = await fetchApi(path(alpha, 'diff'), post(before, csrf));
      if (stale.status !== 409 || (await stale.json()).error !== 'git_stale') return 9;
      return 0;
    })().then(finish, () => finish(10));
  `, origin, alphaId, betaId, notes)
  const failures = [null, 'Browser lost the Workbench origin', 'Owner bootstrap unavailable', 'Git unexpectedly served a GET request',
    'Git did not require an owner session', 'Git did not require a CSRF header', 'Git did not issue distinct opaque status views',
    'Git accepted a raw diff path', 'Registered Beta was not denied the extra Git grant',
    'Git did not reject a superseded status view', 'Read-only HTTP probe failed']
  check(result === 0, failures[result] ?? 'Unexpected HTTP probe result')
}

async function driveBrowser(ctx, setStage) {
  const { browser, ui, wire, fixture, origin } = ctx
  setStage('select registered Alpha with Git still closed')
  await ui.openWorkspace()
  const { alphaId, betaId } = await ui.catalog()
  await ui.select(alphaId, notes)
  await ui.visible(`${toggle}[aria-expanded="false"]`, 'closed Git toggle for Alpha')
  await ui.absent(git('panel'), 'Git panel absent by default')
  await ui.privacy([...fixture.privateMarkers, ...gitContent])
  wire.idle()

  setStage('click Git and refresh the real repository status')
  await showStatus(ctx, alphaId, 'open')
  await showStatus(ctx, alphaId, 'refresh')
  setStage('click Branches and History')
  await showBranchesAndHistory(ctx, alphaId)
  setStage('click the notes staged and worktree diffs')
  await showDiffs(ctx, alphaId)
  setStage('switch projects and close Git and the workspace')
  await verifyReset(ctx, alphaId, betaId)
  setStage('check read-only HTTP method, owner scope, CSRF, raw paths and stale views')
  await verifyHttpGuards(browser, origin, alphaId, betaId)
  wire.assertNoWrites()
}

async function runBrowser(resources, fixture, signal, setStage) {
  setStage('check non-root browser environment and build outputs')
  check(process.platform === 'linux' && process.getuid?.() > 0 && process.geteuid?.() > 0, 'Run the browser E2E on Linux as a non-root user')
  await Promise.all(['provider', 'chat', 'library'].map(entry =>
    access(new URL(`../../apps/headless/dist/${entry}-core.mjs`, import.meta.url)))).catch(() => {
    throw new GitViewCheckError('Build the headless cores with pnpm --filter @deva/headless build')
  })
  const { DEFAULT_WEB_DIR, startWorkbench } = await import('../../apps/headless/src/server.mjs')
  await access(join(DEFAULT_WEB_DIR, 'index.html')).catch(() => { throw new GitViewCheckError('Build the Workbench with pnpm workbench:build') })
  setStage('start the real Workbench on loopback')
  const [{ requestControl }, { initializeMasterKey }, { openBusiness }] = await Promise.all([
    import('../../apps/headless/src/control/socket.mjs'), import('../../apps/headless/src/storage/vault.mjs'),
    import('../../apps/headless/src/business/handlers.mjs')
  ])
  const root = resources.temp.root
  const keyFile = join(root, 'master.key'), runDir = join(root, 'run')
  const wire = observeWire(openBusiness, signal)
  await initializeMasterKey(keyFile)
  const workbench = resources.workbench = await startWorkbench({ dataDir: join(root, 'data'), keyFile, runDir, host: '127.0.0.1',
    webDir: DEFAULT_WEB_DIR, port: 0, businessFactory: wire.factory,
    businessOptions: { workspaceRoot: fixture.workspaceRoot, gitProjects: [alpha] } })
  const origin = workbench.origin
  check(workbench.address.address === '127.0.0.1' && origin === `http://127.0.0.1:${workbench.address.port}`, 'Unexpected Workbench listener or origin')
  const ready = await fetch(`${origin}/readyz`, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) })
  await ready.body?.cancel()
  check(ready.status === 200, 'Workbench readiness did not report HTTP 200')

  setStage('start non-root sandboxed Chrome')
  const browser = resources.browser = await startLocalWebDriver({ root, profile: join(root, 'chrome-profile'), origin, signal })
  const ui = controls(browser, signal)
  setStage('claim Workbench through its owner form and private Unix control')
  await claim(browser, ui, origin, runDir, requestControl)
  await driveBrowser({ browser, ui, wire, fixture, origin }, setStage)
}

function detail(error) {
  return error instanceof GitViewCheckError || error instanceof WebDriverError ? error.message : 'unexpected error (raw diagnostics withheld)'
}

async function run(fixtureOnly) {
  const stop = new AbortController()
  const abort = () => stop.abort()
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(180_000)])
  let fixture, stage = 'create isolated packed SHA-1 fixture', failed = false
  const resources = {}
  try {
    resources.temp = await makeGitViewRoot()
    fixture = await seedGitViewFixture(resources.temp, signal)
    if (!fixtureOnly) await runBrowser(resources, fixture, signal, next => { stage = next })
  } catch (error) {
    failed = true
    console.error(`Workbench Git View ${fixtureOnly ? 'fixture' : 'E2E'} failed at ${stage}: ${signal.aborted ? 'interrupted or timed out' : detail(error)}`)
  } finally {
    for (const [name, cleanup] of [
      ['browser shutdown', () => resources.browser?.close()], ['Workbench shutdown', () => resources.workbench?.close()],
      ['fixture Git and worktree integrity', () => fixture?.assertUnchanged()], ['temporary directory cleanup', () => resources.temp?.close()]
    ]) {
      try { await cleanup() } catch (error) {
        failed = true
        console.error(`Workbench Git View ${name} failed: ${detail(error)}`)
      }
    }
    process.removeListener('SIGINT', abort)
    process.removeListener('SIGTERM', abort)
  }
  if (failed || signal.aborted) process.exitCode = 1
  else if (fixtureOnly) console.log('Workbench Git View fixture passed: two genuine SHA-1 commits, pack and index, and distinct HEAD/index/worktree bytes. Browser E2E was not run.')
  else console.log('Workbench Git View E2E passed: explicit owner clicks, real packed history and branches, both numbered diffs, cleared views, HTTP guards, and unchanged Git and worktree files.')
}

const args = process.argv.slice(2)
if (!args.length) await run(false)
else if (args.length === 1 && args[0] === '--fixture-only') await run(true)
else {
  console.error('Usage: node scripts/workbench/e2e-git-view.mjs [--fixture-only]')
  process.exitCode = 1
}
