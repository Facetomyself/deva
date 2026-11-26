import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { builtinIds, check, guide, marker, notes, revisedGuide, roleName, SkillCheckError } from './e2e-skill-library-fixture.mjs'
import { waitFor, WebDriverError } from './webdriver-local.mjs'

const id = name => `[data-testid="workbench-${name}"]`
const skill = name => id(`skill-${name}`)
const panel = id('skills-panel'), detail = skill('detail'), instructions = skill('instructions')
const row = sid => `${skill('row')}[data-skill-id="${sid}"]`
const toggle = sid => `${row(sid)} ${skill('toggle')} button[aria-pressed]`
const passwordField = mode => `.wb-auth input[type="password"][name="password"][autocomplete="${mode}-password"]`
const mode = value => `${skill('role-mode')}[data-role-mode="${value}"]`
const option = role => `${skill('role-option')}[data-role-id="${role}"]`
const api = '/api/v1', listPath = `${api}/skills`, selectedPath = `${listPath}/${guide.id}`
const changesPath = `${listPath}/-/changes`, rolesPath = `${listPath}/-/roles`, patchPath = `${selectedPath}/preferences`
const revision = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const sameRoles = (actual, expected) => expected === null ? actual === null : Array.isArray(actual) &&
  actual.length === expected.length && [...expected].every(role => actual.includes(role))
const wait = (ctx, probe, description, timeout) => waitFor(probe, description, { signal: ctx.signal, timeout })
const observe = (ctx, script, ...args) => ctx.browser.execute(script, ...args)
const present = (ctx, selector, description) => wait(ctx, () => observe(ctx, `
  return [...document.querySelectorAll(arguments[0])].find(node => node.getClientRects().length &&
    getComputedStyle(node).visibility === 'visible' && !node.matches(':disabled')) ?? null;
`, selector), description)
async function click(ctx, selector, description) {
  try { await ctx.browser.click(await present(ctx, selector, description)) } catch (error) {
    if (error instanceof WebDriverError) throw new WebDriverError(description, error.detail)
    throw error
  }
}
const gone = (ctx, selector, description) => wait(ctx, () => observe(ctx, 'return !document.querySelector(arguments[0]);', selector), description)

// Explicit readbacks only. No cookie/CSRF values leave the browser, and this helper has no
// preference mutation route. POST changes is the read-only cursor check, not a UI action.
function readBack(ctx, path, after = null) {
  return ctx.browser.executeAsync(`
    const [path, after, done] = arguments;
    const init = { credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store' };
    (async () => {
      let response;
      if (after !== null) {
        const boot = await fetch('/api/v1/bootstrap', init);
        if (!boot.ok) return null;
        const { csrf } = await boot.json();
        response = await fetch('/api/v1/skills/-/changes', { ...init, referrerPolicy: 'same-origin', method: 'POST',
          headers: { 'content-type': 'application/json', 'x-deva-csrf': csrf }, body: JSON.stringify({ after, waitMs: 0 }) });
      } else response = await fetch(path, init);
      if (path === '/api/v1/bootstrap') return response.status;
      return response.ok ? { status: response.status, body: await response.json() } : { status: response.status };
    })().then(done, () => done(null));
  `, path, after)
}

async function authenticate(ctx, first) {
  const { browser, origin, password } = ctx
  if (first) {
    const { credential } = await ctx.claim()
    check(typeof credential === 'string' && /^[A-Za-z0-9_-]{43}$/.test(credential), 'Local control did not issue a claim receipt')
    await browser.navigate(`${origin}/#claim=${encodeURIComponent(credential)}`)
  } else await browser.navigate(`${origin}/`)
  const field = await present(ctx, passwordField(first ? 'new' : 'current'), 'actual owner credentials form')
  check(await observe(ctx, `return location.origin === arguments[0] && location.pathname === '/' && !location.hash && !location.search &&
    !document.querySelector('.wb-auth [name="credential"]') && navigator.webdriver && /HeadlessChrome/.test(navigator.userAgent);`, origin),
  'Expected the local sandboxed owner page with its claim fragment removed')
  check(await readBack(ctx, `${api}/bootstrap`) === 401, 'Fresh browser could already read owner bootstrap')
  await browser.keys(field, password)
  await click(ctx, '.wb-auth button[type="submit"]', 'submit real claim/login form')
  await present(ctx, id('chat'), 'authenticated text Workbench shell')
  check(await readBack(ctx, `${api}/bootstrap`) === 200, 'Owner UI did not establish an authenticated session')
  if (first) check(await ctx.ownerClaimed(), 'Local control did not confirm the browser owner claim')
}

async function logout(ctx) {
  if (!await observe(ctx, 'return !!document.querySelector(arguments[0]);', id('chat'))) return
  if (!await observe(ctx, 'return !!document.querySelector(".wb-chat__logout");')) await click(ctx, id('settings'), 'open Settings to sign out')
  await click(ctx, '.wb-chat__logout', 'sign out and revoke the real owner session')
  await present(ctx, passwordField('current'), 'fresh owner login form after logout')
  check(await readBack(ctx, `${api}/bootstrap`) === 401, 'Signed-out browser retained owner access')
}

function traffic(ctx) {
  return observe(ctx, `return performance.getEntriesByType('resource').map(row => {
    const url = new URL(row.name);
    return { sameOrigin: url.origin === location.origin, path: url.pathname, query: !!url.search, end: row.responseEnd, status: row.responseStatus };
  });`)
}
async function checkPageTraffic(ctx) {
  const seen = await traffic(ctx)
  check(seen.every(r => r.sameOrigin && !r.query && (/^\/(?:assets\/|api\/v1\/)/.test(r.path) || r.path === '/favicon.ico')),
    'Browser requested a foreign origin, linked resource or unexpected static file')
  check(seen.every(r => r.path !== `${listPath}/${notes.id}`), 'Browser loaded an unselected skill document')
}
const requests = (ctx, path, method, since = 0) => ctx.rows.slice(since).filter(row => row.path === path && row.method === method)
const noSkillReads = (ctx, since) => !ctx.rows.slice(since).some(row => row.path === listPath || row.path.startsWith(`${listPath}/`))

async function openList(ctx, since, enabled, soleOwner = true) {
  await click(ctx, id('settings'), 'open the original Settings')
  await present(ctx, '.wb-settings .models', 'original model section opens before Skills')
  const started = performance.now()
  await wait(ctx, async () => {
    const noBrowserReads = (await traffic(ctx)).every(r => r.path !== listPath && !r.path.startsWith(`${listPath}/`))
    check(noBrowserReads && (!soleOwner || noSkillReads(ctx, since)) &&
      await observe(ctx, 'return !document.querySelector(arguments[0]);', panel), 'Skills panel or traffic appeared before the explicit Settings tab click')
    return performance.now() - started >= 400
  }, 'observe an idle first model section with no skill reads')
  await click(ctx, id('skills-tab'), 'open Skills explicitly from Settings')
  await verifyList(ctx, enabled)
  check(requests(ctx, listPath, 'GET', since).some(r => r.status === 200), 'Real Settings tab did not fetch the skill list')
}

async function verifyList(ctx, enabled) {
  await present(ctx, panel, 'visible skill list panel')
  await present(ctx, `${toggle(guide.id)}[aria-pressed="${enabled}"]`, 'saved Editorial Guide toggle')
  await present(ctx, `${toggle(notes.id)}[aria-pressed="false"]`, 'saved disabled Release Notes toggle')
  check(await observe(ctx, `
    const [panel, row, builtins, documents, button, toggle, instructions, marker] = arguments;
    const rows = [...document.querySelectorAll(row)];
    return /Web chat does not run skills/i.test(document.querySelector(panel)?.textContent) && rows.length === 5 && builtins.every(id => {
      const elem = rows.find(row => row.dataset.skillId === id);
      const control = elem?.querySelector('button.cf-switch[aria-pressed="true"]');
      return elem?.getClientRects().length && elem.dataset.source === 'builtin' && elem.dataset.enabled === 'true' &&
        !elem.querySelector(button) && !elem.querySelector(toggle) && control?.disabled && /built.in/i.test(elem.textContent);
    }) && documents.every(doc => {
      const elem = rows.find(row => row.dataset.skillId === doc.id);
      return elem?.getClientRects().length && elem.dataset.source === 'custom' && elem.dataset.enabled === String(doc.enabled) &&
        elem.querySelector(button)?.textContent.includes(doc.name);
    }) && !document.querySelector(instructions) && !document.body.textContent.includes(marker);
  `, panel, skill('row'), builtinIds, [{ ...guide, enabled }, { ...notes, enabled: false }].map(({ id, name, enabled }) => ({ id, name, enabled })),
  skill('open'), skill('toggle'), instructions, marker),
  'Expected three read-only builtins and two titled custom records without document or resource content')
}

async function readCatalog(ctx, enabled, roles, doc = guide) {
  const reply = await readBack(ctx, listPath)
  const data = reply?.body
  check(reply?.status === 200 && data.execution === 'inactive' && revision(data.revision) && data.skills?.length === 5 &&
    builtinIds.every(id => data.skills.some(skill => skill.id === id && !skill.canConfigure && skill.source === 'builtin' && skill.enabled && skill.roles === null)),
  'Catalog did not preserve inactive execution or the native builtin rows')
  const active = data.skills.find(skill => skill.id === guide.id), unrelated = data.skills.find(skill => skill.id === notes.id)
  check(active?.name === doc.name && active.enabled === enabled && active.canConfigure && sameRoles(active.roles, roles) && revision(active.revision) &&
    unrelated?.name === notes.name && !unrelated.enabled && sameRoles(unrelated.roles, []) &&
    data.skills.every(skill => !Object.hasOwn(skill, 'instructions') && !Object.hasOwn(skill, 'detail')) &&
    !JSON.stringify(data).includes(marker), 'Catalog exposed document data or disagreed with the saved native skill preferences')
  return { catalog: data.revision, target: active.revision }
}

async function verifyDocument(ctx, doc) {
  await wait(ctx, () => observe(ctx, `
    const [selector, inst, title, body, marker] = arguments;
    const detail = document.querySelector(selector), pre = detail?.querySelector(inst);
    return detail?.getClientRects().length && [...detail.querySelectorAll('h1,h2,h3,h4,[role=heading]')].some(h => h.textContent.trim() === title) &&
      pre?.getClientRects().length && pre.textContent.trim() === body && pre.childElementCount === 0 && !pre.isContentEditable &&
      !detail.querySelector('a[href],img,iframe,[data-fixture="editorial-phrase"]') && !document.body.textContent.includes(marker);
  `, detail, instructions, doc.name, doc.body, marker), 'visible exact plain-text SKILL.md instructions with inert markup, links and reference text')
}

async function openDocument(ctx) {
  const from = ctx.rows.length
  await click(ctx, `${row(guide.id)} ${skill('open')}`, 'select the Editorial Guide via its actual row control')
  await verifyDocument(ctx, guide)
  check(requests(ctx, selectedPath, 'GET', from).some(r => r.status === 200), 'Opening Editorial Guide did not fetch its authenticated detail')
  const reply = await readBack(ctx, selectedPath), doc = reply?.body?.skill
  check(reply?.status === 200 && reply.body.execution === 'inactive' && doc?.detail === 'document' && doc.id === guide.id &&
    doc.instructions === guide.body && doc.trigger === 'During editorial review' && doc.license === 'CC0-1.0' && doc.compatibility === 'Plain text' &&
    doc.allowedTools?.join() === 'read_file' && doc.metadata?.audience === 'editors', 'Actual detail receipt did not return the plain document and native optional fields')
}

async function patchThrough(ctx, selector, description) {
  const before = ctx.rows.length
  await click(ctx, selector, description)
  await wait(ctx, () => {
    const calls = requests(ctx, patchPath, 'PATCH', before)
    check(calls.length <= 1 && (!calls[0]?.status || calls[0].status === 200), 'One explicit owner control attempted more than one preference write or was rejected')
    return calls[0]?.status === 200
  }, 'the one explicit preference PATCH returns HTTP 200')
}

async function openRoles(ctx) {
  await click(ctx, `${detail} ${skill('roles')}`, 'open the explicit role scope editor')
  await present(ctx, mode('all'), 'All roles radio choice in the real editor')
}
async function chooseRoles(ctx, value, roles = []) {
  await click(ctx, mode(value), `choose role scope ${value}`)
  for (const role of roles) await click(ctx, `${option(role)}:not(:checked)`, 'check the named native role through W3C')
  check(await observe(ctx, `
    const [mode, selector, expected] = arguments;
    return document.querySelector(mode)?.checked && (expected === null || JSON.stringify([...document.querySelectorAll(selector + ':checked')]
      .map(field => field.dataset.roleId).sort()) === JSON.stringify(expected));
  `, mode(value), skill('role-option'), value === 'selected' ? [...roles].sort() : null), 'Native editor did not reflect the explicit draft role choice')
}
async function confirmRoles(ctx, roles) {
  await patchThrough(ctx, skill('roles-save'), 'commit the chosen role scope via the actual Save button')
  await gone(ctx, skill('roles-save'), 'successful scope confirmation closes the role draft')
  await confirmSaved(ctx)
  const receipt = await readCatalog(ctx, false, roles)
  await ctx.fixture.assertNative(false, roles)
  return receipt
}

async function confirmSaved(ctx) {
  await wait(ctx, () => observe(ctx, `return [...document.querySelectorAll(arguments[0])].some(node =>
    node.getClientRects().length && /saved|recorded/i.test(node.textContent));`, skill('status')),
  'visible acknowledgement of the recorded preference')
}

async function verifyChanges(ctx, from, changed, expected) {
  const reply = await readBack(ctx, changesPath, from), body = reply?.body
  check(reply?.status === 200 && Object.keys(body ?? {}).sort().join() === 'changed,revision' && body.changed === changed && body.revision === expected,
    'Read-only changes cursor did not return precisely changed and revision')
}

async function verifyChat(ctx) {
  await click(ctx, id('settings-close'), 'return to the text page without activating a skill')
  await gone(ctx, panel, 'Settings and Skills dismissed')
  check((await readBack(ctx, `${api}/chats`))?.body?.sessions?.length === 0 && await observe(ctx, `
    const chat = document.querySelector(arguments[0]);
    return chat?.getClientRects().length && !arguments[1].some(value => chat.textContent.includes(value)) && !document.querySelector(arguments[2]);
  `, id('chat'), [guide.name, notes.name, guide.body.split('\n')[1], notes.body.split('\n')[1], marker], id('turn-status')),
  'Skills settings populated prior instructions, started a model turn, or created a conversation')
  await checkPageTraffic(ctx)
}

async function capture(ctx, kind) {
  if (process.env.DEVA_QA_SKILLS_CAPTURE !== '1') return
  const selector = kind === 'list' ? panel : detail
  check(await observe(ctx, `
    const [selector, kind, refresh, open, back, roles, guide, notes, instructions, marker] = arguments;
    const panel = document.querySelector(selector), dialog = panel?.closest('[role=dialog]');
    if (!panel || !dialog || dialog.querySelector('input, textarea, [contenteditable]') || document.querySelector('.wb-auth, input[type=password]') ||
        [...document.querySelectorAll('input, textarea, [contenteditable=true]')].some(node => node.getClientRects().length &&
          (node.value || (node.isContentEditable && node.textContent.trim()))) || document.body.textContent.includes(marker)) return false;
    const bounds = dialog.getBoundingClientRect();
    const inside = node => {
      if (!node || getComputedStyle(node).visibility !== 'visible') return false;
      const r = node.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.top >= Math.max(0, bounds.top) && r.bottom <= Math.min(innerHeight, bounds.bottom) &&
        r.left >= Math.max(0, bounds.left) && r.right <= Math.min(innerWidth, bounds.right);
    };
    const heading = [...panel.querySelectorAll('h1,h2,h3,h4,[role=heading]')].find(h => h.textContent.trim() === (kind === 'list' ? 'Skills' : guide.name));
    const primary = kind === 'list' ? [panel.querySelector(refresh), ...panel.querySelectorAll(open)] :
      [dialog.querySelector(back), panel.querySelector(roles), panel.querySelector(instructions)];
    const ack = [...panel.querySelectorAll('p')].find(node => /Web chat does not run skills/i.test(node.textContent));
    return inside(heading) && inside(ack) && primary.length >= 3 && primary.every(inside) &&
      (kind === 'list' ? panel.textContent.includes(notes.name) && !panel.querySelector(instructions) : panel.querySelector(instructions)?.textContent.trim() === guide.body);
  `, selector, kind, id('skills-refresh'), skill('open'), skill('back'), skill('roles'), guide, notes, instructions, marker),
  'Screenshot requires stable visible headings, primary controls and inactive acknowledgement with only known synthetic data')
  const file = fileURLToPath(new URL(`../../test-results/skill-library/${kind === 'list' ? 'skills-list' : 'skill-detail'}.png`, import.meta.url))
  for (const dir of [dirname(dirname(file)), dirname(file)]) {
    await mkdir(dir, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
    check((await lstat(dir)).isDirectory() && await realpath(dir) === dir, 'Fixed screenshot location must be an ordinary directory')
  }
  const image = Buffer.from(await ctx.browser.fixtureScreenshot(), 'base64')
  check(image.length > 8 && image.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')), 'Chrome did not return a PNG screenshot')
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
  try {
    const file = await handle.stat()
    check(file.isFile() && file.nlink === 1 && file.uid === process.geteuid(), 'Fixed screenshot target must be a private ordinary file')
    await handle.chmod(0o600)
    await handle.truncate(0)
    await handle.writeFile(image)
  } finally { await handle.close() }
}

export async function runSkillBrowser(ctx) {
  const { fixture, mark, openBrowser } = ctx
  mark('start sandboxed Chrome through local ChromeDriver')
  const first = { ...ctx, browser: await openBrowser('owner-a') }
  let second, failure
  try {
    mark('claim the local owner in Chrome and explicitly open Skills under Settings')
    await authenticate(first, true)
    await first.browser.fixtureViewport('wide')
    await openList(first, 0, true)
    const beforeRefresh = ctx.rows.length
    await click(first, id('skills-refresh'), 'explicitly refresh the summary list')
    await wait(first, () => requests(first, listPath, 'GET', beforeRefresh).some(r => r.status === 200), 'real skill list refresh returns HTTP 200')
    check(!ctx.rows.some(r => r.method === 'GET' && r.path.startsWith(`${listPath}/`)),
      'The summary list fetched a skill document, builtin detail or role roster early')
    const original = await readCatalog(first, true, null)
    await capture(first, 'list')
    mark('select one document, check plain-text display, and record the enabled preference')
    await openDocument(first)
    await capture(first, 'detail')
    await click(first, skill('back'), 'return from document to its skill list before toggling')
    const toggleAt = ctx.rows.length
    await patchThrough(first, `${toggle(guide.id)}[aria-pressed="true"]`, 'turn off the recorded Editorial Guide preference')
    await verifyList(first, false)
    await confirmSaved(first)
    const disabled = await readCatalog(first, false, null)
    check(disabled.target !== original.target, 'Preference update left the skill revision unchanged')
    await fixture.assertNative(false, null)
    check(requests(first, selectedPath, 'GET', toggleAt).length === 0, 'Toggling a recorded preference fetched the document from the list')
    await checkPageTraffic(first)
    mark('reload the document and check the saved list and role choices')
    const reloaded = ctx.rows.length
    await first.browser.refresh()
    await present(first, id('chat'), 'text shell after real page refresh')
    await openList(first, reloaded, false)
    await openDocument(first)
    const beforeRoles = ctx.rows.length
    await openRoles(first)
    check(requests(first, rolesPath, 'GET', beforeRoles).some(r => r.status === 200), 'Opening role scope did not fetch the native role choices')
    const roles = (await readBack(first, rolesPath))?.body?.roles
    check(roles?.some(r => r.id === fixture.role.id && r.name === roleName && r.enabled) && roles.some(r => r.id === fixture.general.id && r.enabled),
      'Scope roster did not contain the native fixture role bindings')
    await chooseRoles(first, 'none')
    const none = await confirmRoles(first, [])
    await openRoles(first)
    await chooseRoles(first, 'selected', [fixture.role.id])
    const one = await confirmRoles(first, [fixture.role.id])
    check(none.target !== one.target, 'Choosing one role did not advance the revision')
    await openRoles(first)
    await click(first, `${option(fixture.general.id)}:not(:checked)`, 'add General alongside the saved ordinary role')
    const two = await confirmRoles(first, [fixture.role.id, fixture.general.id])
    await verifyChanges(first, two.catalog, false, two.catalog)
    mark('log in independently and exercise concurrent owner and manual document invalidation')
    second = { ...ctx, browser: await openBrowser('owner-b') }
    const newOwner = ctx.rows.length
    await authenticate(second, false)
    await openList(second, newOwner, false, false)
    const fresh = await readCatalog(second, false, [fixture.role.id, fixture.general.id])
    check(fresh.target === two.target, 'Independent owner login did not see the durable state')
    await openDocument(second)
    await verifyConcurrent(first, second, two)
    check(requests(first, patchPath, 'PATCH').length === 5, 'Expected just the toggle and four explicit scope confirmations')
    mark('interrupt one pending read, scrub the preview and restore it from the unchanged native revision')
    const beforeDrop=ctx.rows.length
    await wait(first,()=>ctx.dropChanges(),'one live owner metadata request to interrupt',5000)
    try {
      await wait(first,()=>observe(first,`return !document.querySelector(arguments[0]) &&
        /reconnect/i.test(document.querySelector(arguments[1])?.textContent) &&
        !document.querySelector(arguments[2]) && document.querySelector(arguments[3])?.disabled === true;`,
        instructions,skill('status'),skill('roles'),`${detail} ${skill('toggle')} button`),'document scrubbed and preferences frozen after genuine transport loss',8000)
    } catch (error) {
      const flags=await observe(first,`return [!!document.querySelector(arguments[0]),/reconnect/i.test(document.querySelector(arguments[1])?.textContent),
        !!document.querySelector(arguments[2]),document.querySelector(arguments[3])?.disabled === true].map(Number).join('');`,
        instructions,skill('status'),skill('roles'),`${detail} ${skill('toggle')} button`)
      if(!/^[01]{4}$/.test(flags))throw error
      throw new SkillCheckError(`Reconnect state: document=${flags[0]} reconnecting=${flags[1]} roleButton=${flags[2]} frozen=${flags[3]}`)
    } finally {ctx.resumeChanges()}
    await verifyDocument(first,revisedGuide)
    await wait(first,()=>[listPath,selectedPath].every(path=>requests(first,path,'GET',beforeDrop).some(r=>r.status===200)),
      'reconnect independently verifies catalog and selected document even without a new revision')
    check(requests(first,patchPath,'PATCH',beforeDrop).length===0,'Reconnecting replayed a preference write')
    mark('verify no model, chat, resource or skill execution side effects')
    for (const builtin of builtinIds) {
      const reply = await readBack(first, `${listPath}/${builtin}`), value = reply?.body?.skill
      check(reply?.status === 200 && reply.body.execution === 'inactive' && value?.detail === 'builtin' && !value.canConfigure &&
        !Object.hasOwn(value, 'instructions'), 'Builtin detail was not read-only metadata')
    }
    await verifyChat(first)
    await verifyChat(second)
  } catch (error) { failure = error }
  for (const owner of [second, first].filter(Boolean)) {
    try { await logout(owner) } catch (error) { failure ??= error }
  }
  if (failure) throw failure
}

async function verifyConcurrent(first, second, two) {
  await openRoles(first)
  await chooseRoles(first, 'none')
  const since = await observe(first, 'return performance.now();')
  await openRoles(second)
  await chooseRoles(second, 'all')
  const all = await confirmRoles(second, null)
  await staleDraft(first, since, 'none')
  await verifyChanges(second, two.catalog, true, all.catalog)
  await first.fixture.assertNative(false, null)
  await reviewDraft(first, guide, 'none')
  await openRoles(first)
  await chooseRoles(first, 'selected', [first.fixture.role.id])
  const manualAt = await observe(first, 'return performance.now();')
  await first.fixture.reviseGuide()
  await staleDraft(first, manualAt, 'selected')
  await reviewDraft(first, revisedGuide, 'selected')
  const revised = await readCatalog(first, false, null, revisedGuide)
  check(revised.target !== all.target && revised.catalog !== all.catalog, 'Manual document edit did not advance both selected record and catalog revisions')
  await verifyChanges(first, all.catalog, true, revised.catalog)
  await first.fixture.assertNative(false, null)
}

async function staleDraft(ctx, since, draft) {
  await wait(ctx, async () => {
    const event = (await traffic(ctx)).some(r => r.path === changesPath && r.status === 200 && r.end >= since)
    return event && await observe(ctx, `
      const [status, save, mode] = arguments;
      return [...document.querySelectorAll(status)].some(node => node.getClientRects().length && /Review your choices against the latest saved preferences/i.test(node.textContent)) &&
        document.querySelector(save)?.disabled && document.querySelector(mode)?.checked;
    `, `${detail} ${skill('status')}[data-error="stale"][role="status"]`, skill('roles-save'), mode(draft))
  }, 'authenticated invalidation blocks the retained stale draft before any refresh or review click', 20_000)
  await checkPageTraffic(ctx)
}

async function reviewDraft(ctx, doc, draft) {
  await verifyDocument(ctx, doc)
  const before = requests(ctx, patchPath, 'PATCH').length
  await click(ctx, skill('role-review'), 'explicitly review the stale choice against the latest saved scope')
  await present(ctx, skill('roles-save'), 'reviewed local draft must still require explicit Save')
  check(await observe(ctx, 'return document.querySelector(arguments[0])?.checked;', mode(draft)), 'Review replaced the dirty role choice silently')
  await click(ctx, skill('roles-cancel'), 'discard the reviewed draft without overwriting the saved scope')
  await gone(ctx, skill('roles-save'), 'discarded draft no longer has a Save button')
  check(requests(ctx, patchPath, 'PATCH').length === before, 'Reviewing or discarding a stale draft wrote a preference')
}
