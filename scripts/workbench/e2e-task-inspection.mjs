import { randomBytes } from 'node:crypto'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import {
  activeTask, check, completedTask, createTaskInspectionFixture, previewCron, privateMarkers, TaskInspectionCheckError
} from './e2e-task-inspection-fixture.mjs'
import { startLocalWebDriver, waitFor, WebDriverError } from './webdriver-local.mjs'

const hook = name => `[data-testid="workbench-${name}"]`
const panel = hook('tasks-panel'), detail = `${panel} ${hook('task-detail')}`
const row = id => `${panel} ${hook('task-row')}[data-task-id="${id}"]`
const inPanel = name => `${panel} ${hook(name)}`
const chat = hook('chat')
const collection = '/api/v1/tasks'
const taskPath = id => `${collection}/${id}`
const previewPath = `${collection}/preview`, pausePath = `${taskPath(activeTask.id)}/status`
const taskReads = [collection, taskPath(activeTask.id), taskPath(completedTask.id)]
const permittedTaskRequest = (method, path) => method === 'GET' && taskReads.includes(path) ||
  method === 'POST' && path === previewPath || method === 'PATCH' && path === pausePath

// Observe actual ingress and completed responses from production; do not consume request
// bodies, replace the handler, or retain credentials, query strings, or response contents.
function wireObserver(openBusiness, signal) {
  const events = []
  let unexpected = 0
  function mark() { return events.length }
  function quiet(since) {
    check(events.length === since, 'A task endpoint was called without the expected explicit user action')
    check(unexpected === 0, 'The task flow invoked a forbidden route or an unrelated write')
  }
  return {
    mark, quiet,
    async factory(options) {
      const business = await openBusiness(options)
      return {
        ...business,
        handle(req, res, ctx) {
          const raw = req.url ?? '', path = raw.split('?', 1)[0], method = req.method, reads = method === 'GET' || method === 'HEAD'
          if (path === collection || path.startsWith(`${collection}/`)) {
            if (path !== raw || !permittedTaskRequest(method, path)) ++unexpected
            else {
              const event = { method, path, trusted: Boolean(ctx.policy.cookie(req)) && req.headers['sec-fetch-site'] === 'same-origin' &&
                (reads || (req.headers.origin === ctx.policy.origin && Boolean(req.headers['x-deva-csrf']) &&
                  /^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? ''))) }
              events.push(event)
              res.once('finish', () => { event.status = res.statusCode })
            }
          } else if (!reads || /^\/api\/v1\/(?:provider-models|workspaces|files|git|browser|schedules)(?:\/|$)/.test(path) ||
            /^\/api\/v1\/chats\/[^/]+\/(?:attachments|browser|deliveries|turns|runs)(?:\/|$)/.test(path)) {
            ++unexpected
          }
          return business.handle(req, res, ctx)
        }
      }
    },
    async expect(since, method, path, description, followReads = []) {
      const batch = await waitFor(() => events[since]?.status && events.slice(since), description, { signal })
      const [request, ...follow] = batch
      check(request.method === method && request.path === path && request.trusted && request.status === 200 &&
        follow.every(event => event.method === 'GET' && followReads.includes(event.path)),
      'The UI action did not send the expected owner HTTP request and receive HTTP 200')
      check(unexpected === 0, 'The task flow invoked a forbidden route or an unrelated write')
    },
    complete() {
      check(unexpected === 0 && events.every(event => event.trusted && event.status === 200) &&
        events.filter(event => event.method === 'POST').length === 1 && events.filter(event => event.method === 'PATCH').length === 1,
      'Expected only authenticated task reads, one CSRF preview and one CSRF pause')
    }
  }
}

// Synchronous scripts only observe the DOM. Real W3C Element Click and Send Keys commands
// perform every target interaction, including selecting the shared schedule mode and confirming.
function controls(browser, signal) {
  const until = (probe, description) => waitFor(probe, description, { signal })
  const element = (selector, description, labels = null) => until(() => browser.execute(`
    const [selector, labels] = arguments;
    return [...document.querySelectorAll(selector)].find(node => node.getClientRects().length &&
      getComputedStyle(node).visibility === 'visible' && !node.matches(':disabled, [aria-disabled="true"]') &&
      (!labels || labels.includes(node.textContent.trim()))) ?? null;
  `, selector, labels), description)
  return {
    until, element, browser,
    click: async (...args) => browser.click(await element(...args)),
    hidden: (selector, description) => until(() => browser.execute(`
      return ![...document.querySelectorAll(arguments[0])].some(node => node.getClientRects().length &&
        getComputedStyle(node).visibility === 'visible');
    `, selector), description),
    async privateDataAbsent() {
      check(await browser.execute(`
        return !document.querySelector('[data-task-inspection-fixture]') &&
          arguments[0].every(marker => !document.body.innerHTML.includes(marker));
      `, privateMarkers), 'Native-only fields leaked or task text was interpreted as markup')
    }
  }
}

async function authenticate(ui, origin, password, credential) {
  await ui.browser.navigate(credential ? `${origin}/#claim=${encodeURIComponent(credential)}` : `${origin}/`)
  const autocomplete = credential ? 'new-password' : 'current-password'
  const input = await ui.element(`.wb-auth input[type="password"][autocomplete="${autocomplete}"]`, 'actual owner authentication form')
  check(await ui.browser.execute(`return location.origin === arguments[0] && location.pathname === '/' && !location.hash && !location.search;`, origin),
    'Owner form did not remain on the clean loopback Workbench URL')
  await ui.browser.keys(input, password)
  await ui.click('.wb-auth button[type="submit"]', 'submit actual owner form')
  await ui.element(chat, 'authenticated desktop-style Workbench shell')
}

async function openTasks(ui, wire, activeStatus = 'active') {
  const since = wire.mark()
  await ui.click(hook('tasks-toggle'), 'open Tasks using the actual desktop rail')
  await ui.element(panel, 'visible Task Inspection panel')
  await ui.element(inPanel('tasks-inactive'), 'execution-inactive notice in the actual panel',
    ['Server execution inactive; these are recorded desktop schedules.', '服务器未启用任务执行；此处展示桌面端记录的日程。'])
  await ui.until(() => ui.browser.execute(`
    const [selector, expected] = arguments;
    const matches = [...document.querySelectorAll(selector)].filter(node => node.getClientRects().length);
    return matches.length === expected.length && expected.every(([id, title, status]) => matches.some(node =>
      node.dataset.taskId === id && node.querySelector('.cf-trow__title')?.textContent === title &&
      node.closest('[data-status]')?.dataset.status === status));
  `, inPanel('task-row'), [[activeTask.id, activeTask.title, activeStatus], [completedTask.id, completedTask.title, 'completed']]),
  'both visible native task rows under the correct statuses')
  await ui.hidden(detail, 'task detail remains closed until explicit row selection')
  await wire.expect(since, 'GET', collection, 'actual owner task list HTTP response')
  await ui.privateDataAbsent()
}

async function selectTask(ui, wire, task) {
  const since = wire.mark()
  await ui.click(row(task.id), 'select the saved task row')
  await ui.until(() => ui.browser.execute(`
    const [selector, status, title, prompt, summary, updated, fired] = arguments;
    const pane = document.querySelector(selector);
    const visible = node => node?.getClientRects().length && getComputedStyle(node).visibility === 'visible';
    const promptEl = pane?.querySelector('[data-testid="workbench-task-prompt"]');
    const run = pane?.querySelector('.cf-truns .cf-trun');
    return visible(pane) && visible(promptEl) && visible(run) && pane.dataset.status === status &&
      pane.querySelector('h3')?.textContent === title && promptEl.textContent === prompt && run.textContent.includes(summary) &&
      [...pane.querySelectorAll('dl time')].some(time => time.dateTime === updated) &&
      run.querySelector('time')?.dateTime === fired;
  `, detail, task.status, task.title, task.prompt, task.runs[0].summary, new Date(task.updatedAt).toISOString(),
  new Date(task.runs[0].firedAt).toISOString()), 'selected detail displays saved timestamps, prompt and run history as literal text')
  await wire.expect(since, 'GET', taskPath(task.id), 'actual owner task detail HTTP response')
  await ui.privateDataAbsent()
}

// Separate same-origin GETs check the public projections and revision without changing app
// state. Neither the owner cookie, task content, nor response bodies leave the page.
async function readBack(ui, expectedStatus, expectedUpdatedAt) {
  const result = await ui.browser.executeAsync(`
    const [collection, itemPath, status, updatedAt, active, completed, markers, finish] = arguments;
    const get = async path => {
      const r = await fetch(path, { credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store' });
      return r.status === 200 ? r.json() : null;
    };
    (async () => {
      const [list, payload] = await Promise.all([get(collection), get(itemPath)]);
      const rows = list?.tasks;
      const entry = rows?.find(row => row.id === active.id);
      const done = rows?.find(row => row.id === completed.id);
      const item = payload?.task;
      if (list?.execution !== 'inactive' || payload?.execution !== 'inactive' || payload.revision !== list.revision ||
          !/^[a-f0-9]{64}$/.test(list.revision) || !Array.isArray(rows) ||
          rows.length !== 2 || entry?.title !== active.title || entry.status !== status || entry.updatedAt !== updatedAt ||
          done?.title !== completed.title || done.status !== 'completed' || done.updatedAt !== completed.updatedAt) return null;
      if (rows.some(row => ['prompt', 'runs', 'auth', 'sessionId'].some(field => Object.hasOwn(row, field))) ||
          markers.some(marker => JSON.stringify(list).includes(marker) || JSON.stringify(payload).includes(marker))) return null;
      if (item?.id !== active.id || item.status !== status || item.updatedAt !== updatedAt || item.prompt !== active.prompt ||
          item.pauseAllowed !== (status === 'active') || item.schedule?.kind !== 'recurring' || item.schedule.tz !== 'UTC' || item.schedule.cron !== active.cron ||
          item.runs?.length !== 1 || item.runs[0]?.summary !== active.summary || item.runs[0]?.firedAt !== active.firedAt) return null;
      return list.revision;
    })().then(finish, () => finish(null));
  `, collection, taskPath(activeTask.id), expectedStatus, expectedUpdatedAt, {
    id: activeTask.id, title: activeTask.title, cron: activeTask.schedule.cron, prompt: activeTask.prompt,
    summary: activeTask.runs[0].summary, firedAt: activeTask.runs[0].firedAt
  }, { id: completedTask.id, title: completedTask.title, updatedAt: completedTask.updatedAt }, privateMarkers)
  check(typeof result === 'string' && /^[a-f0-9]{64}$/.test(result), 'Public list/detail did not match the minimal native projection, saved state, and inactive execution')
  return result
}

function nextDailyUtc(epoch) {
  const current = new Date(epoch)
  const candidate = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate(), 13, 17)
  return candidate > epoch ? candidate : candidate + 86_400_000
}

async function previewSchedule(ui, wire, fixture, baselineRevision) {
  const since = wire.mark()
  const mode = await ui.element(`${panel} .sched__mode[role="combobox"]`, 'shared ScheduleEditor mode dropdown')
  await ui.browser.click(mode)
  const option = await ui.until(() => ui.browser.execute(`
    const [mode, labels] = arguments;
    const list = document.getElementById(mode.getAttribute('aria-controls'));
    return [...(list?.querySelectorAll('[role="option"]') ?? [])]
      .find(row => row.getClientRects().length && labels.includes(row.textContent.trim())) ?? null;
  `, mode, ['Custom cron', '自定义 cron']), 'actual Custom cron dropdown option')
  await ui.browser.click(option)
  const cron = await ui.element(`${panel} input.sched__cron`, 'shared ScheduleEditor cron input')
  await ui.browser.click(cron)
  await ui.browser.keys(cron, `\uE009a\uE000${previewCron}`)
  const zone = await ui.element(inPanel('task-preview-zone'), 'editable ScheduleEditor IANA timezone')
  await ui.browser.click(zone)
  await ui.browser.keys(zone, '\uE009a\uE000UTC')
  const allowPast = await ui.element(inPanel('task-preview-allow-past'), 'explicit Allow past checkbox')
  await ui.until(() => ui.browser.execute(`
    const [cron, expected, zone, allowPast] = arguments;
    return cron.value === expected && zone.value === 'UTC' && allowPast.checked === false;
  `, cron, previewCron, zone, allowPast), 'typed daily cron with explicit UTC and Allow past off')
  wire.quiet(since)
  await fixture.assertOriginal()

  const start = Date.now()
  await ui.click(inPanel('task-preview'), 'explicitly preview the UTC schedule')
  await wire.expect(since, 'POST', previewPath, 'one real same-origin preview HTTP response')
  const candidates = [...new Set([nextDailyUtc(start), nextDailyUtc(Date.now())])].map(at => new Date(at).toISOString())
  await ui.until(() => ui.browser.execute(`
    const [selector, candidates] = arguments;
    const result = document.querySelector(selector);
    const time = result?.querySelector('time');
    return result?.getClientRects().length && time?.getClientRects().length &&
      candidates.includes(time.dateTime) && /UTC/.test(result.textContent) && /(?:13:17|1:17)/.test(time.textContent);
  `, inPanel('task-preview-result'), candidates), 'visible 13:17 UTC wall time and correct next UTC instant')
  await ui.privateDataAbsent()
  await fixture.assertOriginal()
  check(await readBack(ui, 'active', activeTask.updatedAt) === baselineRevision, 'Schedule preview changed the task revision')
}

async function confirmPause(ui, wire, fixture, baselineRevision) {
  const since = wire.mark()
  await ui.click(inPanel('task-pause'), 'open the active task Pause confirmation')
  await ui.element(inPanel('task-pause-confirm'), 'visible explicit Pause confirmation')
  wire.quiet(since)
  await fixture.assertOriginal()
  await ui.click(inPanel('task-pause-cancel'), 'cancel the first Pause confirmation')
  await ui.hidden(inPanel('task-pause-confirm'), 'cancelled confirmation closes')
  wire.quiet(since)
  await fixture.assertOriginal()
  check(await readBack(ui, 'active', activeTask.updatedAt) === baselineRevision, 'Cancelling Pause changed the task revision')

  const before = wire.mark()
  await ui.click(inPanel('task-pause'), 'reopen Pause confirmation')
  await ui.element(inPanel('task-pause-confirm'), 'active task awaits explicit confirmation again')
  wire.quiet(before)
  const from = Date.now()
  await ui.click(inPanel('task-pause-confirm'), 'explicitly confirm Pausing the selected task')
  await wire.expect(before, 'PATCH', pausePath, 'real status PATCH for the selected active task only', taskReads)
  await ui.element(`${detail}[data-status="paused"]`, 'selected detail refreshed to its saved paused status')
  await ui.element(`${panel} [data-status="paused"] ${hook('task-row')}[data-task-id="${activeTask.id}"]`,
    'paused task moved to the Paused group in the list')
  await ui.hidden(inPanel('task-pause-confirm'), 'confirmed pause closes its confirmation')
  await ui.hidden(inPanel('task-pause'), 'paused task no longer presents Pause')
  const to = Date.now()
  const state = await fixture.assertPaused(from, to)
  const revision = await readBack(ui, 'paused', state.updatedAt)
  check(revision !== baselineRevision && revision === state.hash, 'Confirmed Pause did not return the new native task revision')
  await ui.privateDataAbsent()
  return { state, revision, from, to }
}

async function runBrowser(fixture, resources, signal, setStage) {
  setStage('check non-root browser environment and build outputs')
  check(process.platform === 'linux' && process.getuid?.() > 0 && process.geteuid?.() > 0, 'Run the browser E2E on Linux as a non-root user')
  await Promise.all(['provider', 'chat', 'library'].map(entry =>
    access(new URL(`../../apps/headless/dist/${entry}-core.mjs`, import.meta.url)))).catch(() => {
    throw new TaskInspectionCheckError('Build the headless cores with pnpm --filter @deva/headless build')
  })
  const { DEFAULT_WEB_DIR, startWorkbench } = await import('../../apps/headless/src/server.mjs')
  await access(join(DEFAULT_WEB_DIR, 'index.html')).catch(() => { throw new TaskInspectionCheckError('Build the Workbench with pnpm workbench:build') })
  setStage('start the production Workbench on loopback')
  const [{ requestControl }, { initializeMasterKey }, { openBusiness }] = await Promise.all([
    import('../../apps/headless/src/control/socket.mjs'), import('../../apps/headless/src/storage/vault.mjs'),
    import('../../apps/headless/src/business/handlers.mjs')
  ])
  const keyFile = join(fixture.root, 'master.key'), runDir = join(fixture.root, 'run')
  await initializeMasterKey(keyFile)
  const wire = wireObserver(openBusiness, signal)
  const workbench = resources.workbench = await startWorkbench({ dataDir: fixture.dataDir, keyFile, runDir,
    webDir: DEFAULT_WEB_DIR, host: '127.0.0.1', port: 0, businessFactory: wire.factory })
  const origin = workbench.origin
  check(workbench.address.address === '127.0.0.1' && origin === `http://127.0.0.1:${workbench.address.port}`, 'Unexpected Workbench listener or origin')
  const ready = await fetch(`${origin}/readyz`, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) })
  await ready.body?.cancel()
  check(ready.status === 200, 'Workbench readiness did not report HTTP 200')
  await fixture.assertOriginal()

  async function openBrowser(profile) {
    const browser = resources.browser = await startLocalWebDriver({ root: fixture.root, profile: join(fixture.root, profile), origin, signal })
    return controls(browser, signal)
  }
  setStage('claim through the private Unix control and sandboxed Chrome owner form')
  const ui = await openBrowser('chrome-owner-claim')
  const pass = randomBytes(24).toString('base64url')
  const { credential } = await requestControl({ runDir, op: 'claim' })
  await authenticate(ui, origin, pass, credential)
  check((await requestControl({ runDir, op: 'status' })).claimed === true, 'Unix control did not confirm the browser claim')
  wire.quiet(0)

  setStage('open the rail Tasks panel and inspect both native tasks')
  await openTasks(ui, wire)
  await selectTask(ui, wire, completedTask)
  await ui.hidden(inPanel('task-pause'), 'completed native task offers no Pause action')
  await selectTask(ui, wire, activeTask)
  const revision = await readBack(ui, 'active', activeTask.updatedAt)
  check(revision === fixture.initialRevision, 'Task list/detail did not report the native fixture revision')
  await fixture.assertOriginal()

  setStage('capture optional sandboxed Chrome layouts for the verified synthetic task detail')
  try {
    const { captureTaskInspectionLayouts } = await import('./task-inspection-visual.mjs')
    await captureTaskInspectionLayouts({ browser: ui.browser, origin })
  } catch (error) {
    if (error instanceof WebDriverError) throw error
    throw new TaskInspectionCheckError('Synthetic Task Inspection layout capture failed (raw diagnostics withheld)')
  }

  setStage('use the shared ScheduleEditor and explicitly preview the future UTC occurrence')
  await previewSchedule(ui, wire, fixture, revision)
  setStage('cancel, then explicitly confirm Pause for the selected task')
  const paused = await confirmPause(ui, wire, fixture, revision)
  await ui.click(inPanel('tasks-close'), 'close Task Inspection')
  await ui.hidden(panel, 'closed Task Inspection panel')
  await resources.browser.close()
  resources.browser = undefined

  setStage('sign in with a fresh sandboxed Chrome profile and confirm persisted inactivity')
  const login = await openBrowser('chrome-owner-login')
  const beforeLogin = wire.mark()
  await authenticate(login, origin, pass)
  wire.quiet(beforeLogin)
  await openTasks(login, wire, 'paused')
  await selectTask(login, wire, { ...activeTask, status: 'paused', updatedAt: paused.state.updatedAt })
  await login.hidden(inPanel('task-pause'), 'fresh owner session sees the task already paused')
  check(await readBack(login, 'paused', paused.state.updatedAt) === paused.revision, 'Independent owner login did not see the saved revision')
  check(await login.browser.executeAsync(`
    const finish = arguments[arguments.length - 1];
    fetch('/api/v1/chats', { credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store' })
      .then(async r => {
        if (r.status !== 200) return false;
        const { sessions } = await r.json();
        return Array.isArray(sessions) && sessions.length === 0;
      }).then(finish, () => finish(false));
  `), 'Task inspection created a chat session or the owner chat readback failed')
  const beforeReturn = wire.mark()
  await login.click('.cf-iconrail button[aria-label="Chats"], .cf-iconrail button[aria-label="消息"]', 'return to the original conversation via the desktop icon rail')
  await login.hidden(panel, 'Chat navigation closes the task tab')
  await login.element(`${chat} .cf-rail__top`, 'original conversation sidebar is restored')
  check(await login.browser.execute('return document.querySelector(arguments[0])?.getAttribute("aria-current") === "false" && !document.querySelector(arguments[1]);', hook('tasks-toggle'), panel),
    'Leaving Tasks kept its tab active or its UI mounted')
  wire.quiet(beforeReturn)
  resources.verifyDisk = () => fixture.assertPaused(paused.from, paused.to, paused.state)
  await resources.verifyDisk()
  wire.complete()
}

function message(error) {
  return error instanceof TaskInspectionCheckError || error instanceof WebDriverError ? error.message : 'unexpected error (raw diagnostics withheld)'
}

async function run(fixtureOnly) {
  const stop = new AbortController(), abort = () => stop.abort()
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(180_000)])
  const resources = {}
  let fixture, stage = 'create isolated private native tasks.json', failed = false
  try {
    fixture = await createTaskInspectionFixture()
    await fixture.assertOriginal()
    if (!fixtureOnly) await runBrowser(fixture, resources, signal, next => { stage = next })
  } catch (error) {
    failed = true
    console.error(`Workbench Task Inspection ${fixtureOnly ? 'fixture' : 'E2E'} failed at ${stage}: ${signal.aborted ? 'interrupted or timed out' : message(error)}`)
  } finally {
    for (const [name, close] of [
      ['browser shutdown', () => resources.browser?.close()], ['Workbench shutdown', () => resources.workbench?.close()],
      ['final native task integrity', () => resources.verifyDisk?.()], ['temporary directory cleanup', () => fixture?.close()]
    ]) {
      try { await close() } catch (error) {
        failed = true
        console.error(`Workbench Task Inspection ${name} failed: ${message(error)}`)
      }
    }
    process.removeListener('SIGINT', abort)
    process.removeListener('SIGTERM', abort)
  }
  if (failed || signal.aborted) process.exitCode = 1
  else if (fixtureOnly) console.log('Workbench Task Inspection fixture passed: two synthetic native task records in a private byte-stable file. Browser E2E was not run.')
  else console.log('Workbench Task Inspection E2E passed: owner list and escaped detail/history, explicit UTC preview, confirm-only pause with surgical native bytes, and fresh-login readback.')
}

const args = process.argv.slice(2)
if (!args.length) await run(false)
else if (args.length === 1 && args[0] === '--fixture-only') await run(true)
else {
  console.error('Usage: node scripts/workbench/e2e-task-inspection.mjs [--fixture-only]')
  process.exitCode = 1
}
