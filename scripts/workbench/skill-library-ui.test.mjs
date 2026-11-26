import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))
const ts = require('typescript')
const react = require('react')
const { createElement } = react
const { renderToStaticMarkup } = require('react-dom/server')
const src = new URL('../../apps/desktop/src/workbench/', import.meta.url)
const read = (name) => readFile(new URL(name, src), 'utf8')
async function load(name, dependencies = {}, extra = '') {
  const js = ts.transpileModule(await read(name) + extra, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }
  }).outputText
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', 'window', js)(
    (key) => Object.hasOwn(dependencies, key) ? dependencies[key] : require(key), mod, mod.exports, {})
  return mod.exports
}
const base = await load('transport.ts')
const transport = await load('skill-library-transport.ts', { './transport': base })
const logic = await load('skill-library-controller.ts', { './skill-library-transport': transport })
const labels = await load('skill-library-copy.ts')
const { createTransport, HttpFailure } = base
const { createSkillLibraryTransport, skillProblem } = transport
const { createSkillLibrary, draftRoles, invalidDraftRoles, roleNeedsReview } = logic

const revision = (letter) => letter.repeat(64)
const documentId = 'editorial-guide'
const oldRole = 'legacy-role'
const baseSkill = { id: documentId, name: 'Editorial Guide', description: 'Plain text editing guide', source: 'custom', enabled: true,
  roles: null, revision: revision('a'), canConfigure: true }
const builtin = { ...baseSkill, id: 'create-skill', name: 'create-skill', source: 'builtin', canConfigure: false }
const instructions = '\n# Raw\n<img src="https://example.invalid/image"> [link](https://example.invalid/link) <script>test()</script>\n'
const detail = (s = baseSkill, text = instructions) => ({ ...s, detail: 'document', instructions: text,
  trigger: '', license: '', compatibility: '', allowedTools: [], metadata: {} })
const catalog = (item = baseSkill, rev = revision('b')) => ({ skills: [builtin, item], revision: rev })
const withExecution = (value) => ({ ...value, execution: 'inactive' })
const bootstrap = { protocol: 1, version: '1', platform: 'linux', config: {}, csrf: 'csrf-test', expiresAt: 1234, capabilities: { skillLibrary: true } }
const json = (value, status = 200) => new Response(JSON.stringify(value), { status })
const signal = new AbortController().signal
const options = [{ id: 'general', name: 'General', enabled: true }, { id: '编校', name: 'Editor', enabled: false }]
const malformed = /Invalid skill library response/
function defer() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function until(check) {
  for (let i = 0; i < 40; i++) { if (check()) return; await setImmediate() }
  assert.ok(check(), 'state never settled')
}

function queueTransport(steps) {
  return createTransport(async (url, init) => {
    const step = steps.shift()
    assert.ok(step, `Unexpected request ${url}`)
    const [method, path, body, result, status = 200] = step
    assert.equal(url, `/api/v1${path}`)
    assert.equal(init.method, method)
    assert.deepEqual(init.body ? JSON.parse(init.body) : undefined, body)
    assert.equal(init.credentials, 'same-origin')
    assert.equal(init.mode, 'same-origin')
    assert.equal(init.redirect, 'error')
    assert.equal(init.cache, 'no-store')
    assert.equal(init.headers.accept, 'application/json')
    if (path !== '/bootstrap') assert.equal(init.signal, signal)
    assert.equal(init.headers['x-deva-csrf'], method === 'GET' ? undefined : bootstrap.csrf)
    assert.equal(init.referrerPolicy, method === 'GET' ? 'no-referrer' : 'same-origin')
    return json(result, status)
  })
}

test('literal bootstrap capability and request projections preserve the progressive read boundary', async () => {
  const updated = { ...baseSkill, enabled: false, revision: revision('c') }
  const steps = [
    ['GET', '/bootstrap', undefined, { ...bootstrap, capabilities: { skillLibrary: 'true', textChat: true } }],
    ['GET', '/bootstrap', undefined, bootstrap],
    ['GET', '/skills', undefined, withExecution(catalog())],
    ['GET', `/skills/${documentId}`, undefined, withExecution({ skill: detail() })],
    ['GET', '/skills/-/roles', undefined, { roles: options }],
    ['PATCH', `/skills/${documentId}/preferences`, { revision: baseSkill.revision, enabled: false }, withExecution({ skill: updated })],
    ['POST', '/skills/-/changes', { after: revision('b'), waitMs: 8000 }, { changed: true, revision: revision('d') }]
  ]
  const workbench = queueTransport(steps)
  const disabled = (await workbench.inspect()).bootstrap
  assert.deepEqual(disabled.capabilities, { textChat: true })
  assert.equal(createSkillLibraryTransport(workbench, disabled), undefined)
  const active = (await workbench.inspect()).bootstrap
  assert.deepEqual(active.capabilities, { skillLibrary: true })
  const api = createSkillLibraryTransport(workbench, active)
  assert.deepEqual(steps.map(([method]) => method), ['GET', 'GET', 'GET', 'PATCH', 'POST'], 'constructing a client made a network request')
  assert.deepEqual(await api.list(signal), catalog())
  assert.deepEqual(await api.detail(documentId, signal), detail())
  assert.deepEqual(await api.roles(signal), options)
  assert.deepEqual(await api.patch(baseSkill, { enabled: false }, signal), updated)
  assert.deepEqual(await api.changes(revision('b'), 8000, signal), { changed: true, revision: revision('d') })
  assert.deepEqual(steps, [])
})

test('strict wire and CAS reject unsafe routes, mixed edits, mismatched receipts and active execution', async () => {
  const wire = [
    { ...catalog(), execution: 'active' },
    withExecution({ ...catalog(), skills: [baseSkill, baseSkill] }),
    withExecution({ ...catalog(), skills: [{ ...builtin, canConfigure: true }] }),
    withExecution({ ...catalog(), skills: [{ ...baseSkill, instructions }] }),
    withExecution({ ...catalog(), revision: '1' }),
    withExecution({ skill: { ...detail(), id: 'other' } }),
    withExecution({ skill: { ...detail(), metadata: { 'key': 2 } } }),
    { roles: [{ ...options[0], prompt: 'private' }] },
    { roles: [options[0], options[0]] },
    withExecution({ skill: { ...baseSkill, enabled: false } }),
    withExecution({ skill: { ...baseSkill, enabled: false, revision: revision('d'), id: 'other' } }),
    { revision: revision('b'), changed: true },
    withExecution({ skill: null })
  ]
  let calls = 0
  const api = createSkillLibraryTransport(createTransport(async () => { calls++; return json(wire.shift()) }), bootstrap)
  for (const id of ['../x', 'a..b', 'a.', 'x%2fy', 'x\n', 'x?y', 'CONSTRUCTOR']) await assert.rejects(api.detail(id, signal), malformed)
  for (const target of [builtin, { ...baseSkill, canConfigure: false }, { ...baseSkill, revision: '0x1' }, { ...baseSkill, id: '/x' }])
    await assert.rejects(api.patch(target, { enabled: false }, signal), malformed)
  for (const edit of [{}, { enabled: 'false' }, { roles: [undefined] }, { roles: Array(1) }, { roles: ['x', 'x'] }, { roles: [], enabled: false }, { revision: '0', enabled: false }])
    await assert.rejects(api.patch(baseSkill, edit, signal), malformed)
  for (const ms of [-1, 1.2, 8001, '8000']) await assert.rejects(api.changes(revision('b'), ms, signal), malformed)
  assert.equal(calls, 0)
  for (let i = 0; i < 5; i++) await assert.rejects(api.list(signal), malformed)
  for (let i = 0; i < 2; i++) await assert.rejects(api.detail(documentId, signal), malformed)
  for (let i = 0; i < 2; i++) await assert.rejects(api.roles(signal), malformed)
  for (let i = 0; i < 2; i++) await assert.rejects(api.patch(baseSkill, { enabled: false }, signal), malformed)
  await assert.rejects(api.changes(revision('b'), 0, signal), malformed)
  assert.equal(await api.detail(documentId, signal), null)
  assert.deepEqual(wire, [])
})

function fixture(t, initial = baseSkill, overrides = {}) {
  let current = initial, currentRevision = revision('b')
  let active = 0, maximum = 0, expired = 0
  const changeRequests = []
  const calls = []
  const body = () => catalog(current, currentRevision)
  const fake = {
    list: async () => current ? body() : { skills: [builtin], revision: currentRevision },
    detail: async () => current ? detail(current) : null,
    roles: async () => options,
    patch: async (target, edit) => {
      assert.equal(target.revision, current.revision)
      current = { ...current, ...edit, revision: revision('e') }; currentRevision = revision('f')
      return current
    },
    changes(after, ms, signal) {
      const pending = defer()
      active++
      maximum = Math.max(maximum, active)
      signal.addEventListener('abort', () => pending.reject(new Error('closed')), { once: true })
      changeRequests.push({ after, ms, signal, resolve: pending.resolve, reject: pending.reject })
      return pending.promise.finally(() => { active-- })
    }, ...overrides
  }
  const api = Object.fromEntries(Object.entries(fake).map(([name, call]) => [name, (...args) => {
    calls.push([name, ...args])
    return call(...args)
  }]))
  const controller = createSkillLibrary(api, () => { expired++ }, [0, 0, 0])
  t.after(() => controller.dispose())
  return { controller, snap: controller.snapshot, calls, changeRequests, maximum: () => maximum, expired: () => expired,
    modify(item, rev) { current = item; currentRevision = rev }, count(method) { return calls.filter(([name]) => name === method).length } }
}

test('each explicit panel visit runs one live cursor; only the selected custom row and role chooser get details', async (t) => {
  const f = fixture(t)
  const { controller: c } = f
  assert.deepEqual(f.calls, [])
  c.start(); c.start()
  await until(() => f.changeRequests.length === 1)
  assert.deepEqual(f.calls.map(([name]) => name), ['list', 'changes'])
  assert.equal(f.changeRequests[0].ms, 8000)
  assert.equal(c.open(builtin.id), false)
  assert.equal(c.openRoles(), false)
  assert.equal(c.open(documentId), true)
  await until(() => !!f.snap().selected?.document)
  assert.equal(f.count('detail'), 1)
  assert.equal(f.count('roles'), 0)
  c.openRoles(); c.openRoles()
  await until(() => !!f.snap().roles?.options)
  assert.equal(f.count('roles'), 1)
  c.back()
  assert.equal(f.snap().selected, undefined)
  assert.equal(f.snap().roles, undefined)
  const changed = { ...baseSkill, name: 'Renamed', revision: revision('c') }
  f.modify(changed, revision('d'))
  f.changeRequests[0].resolve({ changed: true, revision: revision('d') })
  await until(() => f.snap().catalog?.revision === revision('d'))
  assert.equal(f.count('detail'), 1, 'sync read opened a detail when the list was active')
  await c.refresh()
  assert.equal(f.maximum(), 1)
  c.dispose()
  assert.ok(f.changeRequests.every((r) => r.signal.aborted))
  await c.refresh()
  assert.equal(f.count('list'), 3)
})

test('the switch stays on its saved value until the exact PATCH and readback; list toggles never read documents', async (t) => {
  const patch = defer(), readback = defer()
  let lists = 0
  const after = { ...baseSkill, enabled: false, revision: revision('c') }
  const f = fixture(t, baseSkill, {
    list: async () => ++lists === 1 ? catalog() : readback.promise,
    patch: async (row, edit) => { assert.deepEqual(row, baseSkill); assert.deepEqual(edit, { enabled: false }); return patch.promise }
  })
  const { controller: c } = f
  c.start(); await until(() => !!f.snap().catalog)
  c.toggle(builtin.id)
  c.toggle(documentId); c.toggle(documentId)
  assert.equal(f.count('patch'), 1)
  assert.equal(f.snap().feedback.status, 'saving')
  assert.equal(f.snap().catalog.skills[1].enabled, true)
  patch.resolve(after)
  await until(() => lists === 2)
  assert.equal(f.snap().feedback.status, 'saving')
  readback.resolve(catalog(after, revision('d')))
  await until(() => f.snap().feedback?.status === 'saved')
  assert.equal(f.snap().catalog.skills[1].enabled, false)
  assert.equal(f.count('detail'), 0)
})

test('409, 404, 403, 422 and lost receipts are distinct, and failures only trigger readback', async (t) => {
  const failures = [[409, 'skill_conflict', 'stale'], [404, 'skill_not_found', 'missing'], [403, 'skill_read_only', 'readonly'],
    [422, 'skill_restricted', 'restricted'], [409, 'skill_unknown_role', 'unknownRole'], [503, 'skill_storage_unconfirmed', 'unavailable']]
  for (const [status, code, expected] of failures) {
    const f = fixture(t, baseSkill, { patch: async () => { throw new HttpFailure(status, code) } })
    f.controller.start(); await until(() => !!f.snap().catalog)
    f.controller.toggle(documentId)
    await until(() => f.snap().feedback?.status === expected && f.count('list') === 2)
    assert.equal(f.count('patch'), 1)
    assert.equal(f.snap().catalog.skills[1].enabled, true)
    assert.equal(f.snap().feedback.edit.enabled, false)
    f.controller.dispose()
  }
  assert.equal(skillProblem(new HttpFailure(409, 'skill_builtin')), 'readonly')
  assert.equal(skillProblem(new HttpFailure(409, 'skill_unsupported')), 'restricted')
})

test('external revisions recheck the selected detail but retain explicit role drafts pending review; unknown saved roles remain removable', async (t) => {
  const historical = { ...baseSkill, roles: [oldRole] }
  const f = fixture(t, historical)
  const { controller: c } = f
  c.start(); await until(() => f.changeRequests.length === 1)
  c.open(documentId); await until(() => !!f.snap().selected?.document)
  c.openRoles(); await until(() => !!f.snap().roles?.options)
  assert.equal(f.snap().roles.draft.mode, 'selected')
  assert.deepEqual(draftRoles(f.snap().roles.draft), [oldRole])
  c.pickRole('injected-id', true)
  assert.deepEqual(draftRoles(f.snap().roles.draft), [oldRole])
  c.pickRole('编校', true)
  assert.deepEqual(draftRoles(f.snap().roles.draft), [oldRole, '编校'])
  assert.equal(invalidDraftRoles(f.snap().roles, historical), false)
  const externallyChanged = { ...historical, enabled: false, revision: revision('c') }
  f.modify(externallyChanged, revision('d'))
  f.changeRequests[0].resolve({ changed: true, revision: revision('d') })
  await until(() => f.snap().selected?.document?.revision === revision('c'))
  assert.equal(f.count('detail'), 2)
  assert.equal(f.count('roles'), 1)
  assert.deepEqual(draftRoles(f.snap().roles.draft), [oldRole, '编校'])
  assert.equal(roleNeedsReview(f.snap().roles.draft, externallyChanged), true)
  c.saveRoles(); assert.equal(f.count('patch'), 0)
  await c.reviewRoles()
  assert.equal(f.count('roles'), 2)
  assert.equal(f.count('patch'), 0)
  assert.equal(roleNeedsReview(f.snap().roles.draft, externallyChanged), false)
  c.pickRole(oldRole, false)
  assert.deepEqual(draftRoles(f.snap().roles.draft), ['编校'])
  c.pickRole('编校', false)
  assert.deepEqual(draftRoles(f.snap().roles.draft), [])
  c.setRoleMode('all'); assert.equal(draftRoles(f.snap().roles.draft), null)
  c.setRoleMode('none'); c.saveRoles()
  await until(() => f.snap().feedback?.status === 'saved')
  assert.equal(f.snap().roles, undefined)
  assert.deepEqual(f.calls.find(([name]) => name === 'patch')[2], { roles: [] })
})

test('role CAS 409 retains input and requires review; session expiration cancels the panel', async (t) => {
  const f = fixture(t, baseSkill, { patch: async () => { throw new HttpFailure(409, 'skill_conflict') } })
  const { controller: c } = f
  c.start(); await until(() => !!f.snap().catalog)
  c.open(documentId); await until(() => !!f.snap().selected?.document)
  c.openRoles(); await until(() => !!f.snap().roles?.options)
  c.setRoleMode('none'); c.saveRoles()
  await until(() => f.snap().feedback?.status === 'stale')
  assert.deepEqual(draftRoles(f.snap().roles.draft), [])
  assert.equal(f.snap().roles.draft.review, true)
  c.saveRoles(); assert.equal(f.count('patch'), 1)
  await c.reviewRoles()
  assert.equal(f.snap().roles.draft.review, false)
  assert.equal(f.count('patch'), 1)
  const g = fixture(t, baseSkill, { changes: async () => { throw new HttpFailure(401) } })
  g.controller.start()
  await until(() => g.expired() === 1)
  assert.equal(g.controller.open(documentId), false)
  assert.equal(g.count('detail'), 0)
})

test('a dropped watch freezes CAS and scrubs details, reconfirms the same cursor, and signs out on final 401', async (t) => {
  const reconnect = defer()
  let lists = 0, details = 0
  const f = fixture(t, baseSkill, {
    list: async () => ++lists === 1 ? catalog() : reconnect.promise,
    detail: async () => detail(baseSkill, ++details === 1 ? 'old preview' : 'reconfirmed preview')
  })
  const { controller: c } = f
  c.start(); await until(() => f.changeRequests.length === 1)
  c.open(documentId); await until(() => !!f.snap().selected?.document)
  c.openRoles(); await until(() => !!f.snap().roles?.options)
  c.setRoleMode('none')
  f.changeRequests[0].reject(new TypeError('watch disconnected'))
  await until(() => f.snap().reconnecting && lists === 2)
  assert.equal(f.snap().selected.document, undefined)
  assert.equal(f.snap().roles.draft.review, true)
  assert.deepEqual(draftRoles(f.snap().roles.draft), [])
  c.saveRoles(); c.toggle(documentId)
  assert.equal(f.count('patch'), 0)
  reconnect.resolve(catalog())
  await until(() => f.changeRequests.length === 2)
  assert.equal(details, 2, 'a matching cursor still needs selected detail confirmation')
  assert.equal(f.snap().selected.document.instructions, 'reconfirmed preview')
  assert.equal(f.snap().reconnecting, false)
  assert.equal(f.snap().roles.draft.review, true)
  assert.equal(f.count('roles'), 1, 'reconnecting is not a role selection')
  assert.equal(f.count('patch'), 0)
  assert.equal(f.maximum(), 1)
  assert.equal(f.changeRequests[0].after, f.changeRequests[1].after)
  f.changeRequests[1].reject(new HttpFailure(401))
  await until(() => f.expired() === 1)
  assert.equal(f.snap().catalog, undefined)
  assert.equal(f.snap().selected, undefined)
  assert.equal(f.snap().roles, undefined)
  assert.equal(f.changeRequests[1].signal.aborted, true)
  assert.equal(f.count('patch'), 0)
})

test('recovery is bounded when watch keeps failing; permanent errors require explicit Refresh', async (t) => {
  const repeated = fixture(t, baseSkill, { changes: async () => { throw new HttpFailure(429, 'skill_busy') } })
  repeated.controller.start()
  await until(() => repeated.count('changes') === 4 && repeated.snap().reconnecting === false)
  assert.equal(repeated.count('list'), 4)
  assert.equal(repeated.snap().syncError, 'unavailable')
  repeated.controller.toggle(documentId)
  assert.equal(repeated.count('patch'), 0)
  repeated.controller.dispose()

  const f = fixture(t)
  const { controller: c } = f
  c.start(); await until(() => f.changeRequests.length === 1)
  c.open(documentId); await until(() => !!f.snap().selected?.document)
  f.changeRequests[0].reject(new HttpFailure(403, 'skill_read_only'))
  await until(() => f.snap().syncError === 'readonly')
  assert.equal(f.snap().selected.document, undefined)
  assert.equal(f.snap().reconnecting, false)
  assert.equal(f.count('list'), 1)
  c.toggle(documentId)
  assert.equal(f.count('patch'), 0)
  await c.refresh()
  await until(() => f.changeRequests.length === 2)
  assert.ok(f.snap().selected.document)
  assert.equal(f.snap().syncError, undefined)
  assert.equal(f.count('detail'), 2)
})

test('a completed stale detail and roster read cannot update another view or the reopened list', async (t) => {
  const pendingDetail = defer(), pendingRoles = defer()
  let detailReads = 0
  const newer = { ...baseSkill, name: 'New title', revision: revision('d') }
  const f = fixture(t, baseSkill, {
    detail: async () => ++detailReads === 1 ? pendingDetail.promise : detail(newer, 'new literal text'),
    roles: async () => pendingRoles.promise
  })
  const { controller: c } = f
  c.start(); await until(() => !!f.snap().catalog)
  c.open(documentId)
  const oldDetailSignal = f.calls.find(([name]) => name === 'detail')[2]
  f.modify(newer, revision('c'))
  await c.refresh()
  await until(() => f.snap().selected?.document?.instructions === 'new literal text')
  assert.equal(oldDetailSignal.aborted, true)
  pendingDetail.resolve(detail())
  await setImmediate()
  assert.equal(f.snap().selected?.document?.instructions, 'new literal text')
  c.openRoles()
  const roleSignal = f.calls.find(([name]) => name === 'roles')[1]
  c.back()
  assert.equal(roleSignal.aborted, true)
  pendingRoles.resolve(options)
  await setImmediate()
  assert.equal(f.snap().selected, undefined)
  assert.equal(f.snap().roles, undefined)
})

test('the actual shared desktop extension row, Toggle, settings frame and literal detail are reused', async () => {
  const i18n = { useI18n: () => ({ locale: 'en', t: (key) => ({ 'cf.builtin': 'Built-in', 'cf.kindSkill': 'Skill', 'extensions.skills': 'Skills', 'common.back': 'Back' })[key] ?? key }) }
  const parts = await load('../renderer/src/redesign/SkillSettingsParts.tsx')
  const shell = await load('../renderer/src/redesign/shell-common.tsx', { '../i18n/i18n': i18n, '../components/humation': {}, '../store/profile': {} })
  const frame = await load('../renderer/src/redesign/SettingsFrame.tsx', { '../i18n/i18n': i18n })
  const pane = await load('skill-library.tsx', { '../renderer/src/i18n/i18n': i18n, '../renderer/src/redesign/SkillSettingsParts': parts,
    '../renderer/src/redesign/shell-common': shell, './skill-library-controller': logic, './skill-library-transport': transport,
    './skill-library-copy': labels, './skill-library.css': {}, react: { ...react, useLayoutEffect: react.useEffect } }, '\nexport { OpenPanel }\n')
  const markup = (state) => renderToStaticMarkup(createElement(frame.SettingsFrame, { navigation: 'Extensions', onClose() {} },
    createElement(pane.OpenPanel, { controller: { snapshot: () => state, subscribe: () => () => {}, back() {} } })))
  const list = markup({ catalog: catalog(), listing: false })
  assert.match(list, /role="dialog"/)
  assert.match(list, /class="cf-rows"/)
  assert.match(list, /data-skill-id="create-skill"[^>]*class="cf-setrow"><div class="cf-setrow__main">/)
  assert.match(list, /Built-in · Read-only/)
  assert.match(list, /data-testid="workbench-skill-open"[^>]*class="cf-setrow__open"/)
  assert.equal([...list.matchAll(/data-testid="workbench-skill-toggle"/g)].length, 1)
  assert.match(list, /class="cf-switch is-on" aria-pressed="true"/)
  assert.doesNotMatch(list, /workbench-skill-instructions|workbench-skill-roles-save|example\.invalid/)
  const view = markup({ catalog: catalog(), listing: false, selected: { item: baseSkill, document: detail(), loading: false } })
  assert.match(view, /class="provider-detail provider-detail--fill"/)
  assert.match(view, /data-testid="workbench-skill-back"/)
  assert.match(view, /<pre[^>]+data-testid="workbench-skill-instructions"[^>]*>[\s\S]+&lt;img src=/)
  assert.doesNotMatch(view, /<(?:img|script|a|iframe)\b|href="https:\/\//)
  assert.match(view, /Web chat does not run skills or their tools/)
  const native = await read('../renderer/src/redesign/SettingsPane.tsx')
  assert.match(native, /<ExtensionSettingsRow\b/)
  assert.match(native, /<SkillSettingsDetail\b/)
  assert.match(native, /<Markdown text=\{item\.instructions\}/)
  const settings = await read('desktop-settings.tsx')
  assert.match(settings, /useState<'models' \| 'skills'>\('models'\)/)
  assert.match(settings, /chat\.bootstrap\.capabilities\?\.skillLibrary === true/)
  assert.match(settings, /event\.nativeEvent\.isTrusted\) setSection\('skills'\)/)
  assert.match(settings, /<SettingsFrame .*workbench-settings-close/)
  assert.match(settings, /\<fieldset className="wb-settings" disabled=\{chat.locked\}\>/)
  assert.match(settings, /lazy\(\(\) => import\('\.\/skill-library'\)\)/)
  assert.match(settings, /lazy\(\(\) => import\('\.\/text-workbench'\)\)/)
  assert.match(await read('first-use.tsx'), /await import\('\.\/desktop-settings'\)/)
})
