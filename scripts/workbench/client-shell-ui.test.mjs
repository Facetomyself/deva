import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))
const ts = require('typescript')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const src = new URL('../../apps/desktop/src/', import.meta.url)
async function load(path, imports = {}) {
  const js = ts.transpileModule(await readFile(new URL(path, src), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }
  }).outputText
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', js)(
    (name) => Object.hasOwn(imports, name) ? imports[name] : require(name), mod, mod.exports)
  return mod.exports
}
const shell = await load('workbench/client-shell.ts')
const { createClientFullscreen, getClientChatShortcut, subscribeChatSidebarShortcut } = shell
const { messages } = await load('renderer/src/i18n/messages.ts')
let locale = 'en'
const i18n = { useI18n: () => ({ locale, t: (key) => key.split('.').reduce((part, name) => part?.[name], messages[locale]) ?? key }) }
const { ServerPlatformLabel, getServerPlatformLabel } = await load('workbench/server-platform.tsx', { '../renderer/src/i18n/i18n': i18n })
const { ClientFullscreenButton } = await load('workbench/client-shell-ui.tsx', {
  './client-shell': shell, './client-shell.css': {}, '../renderer/src/i18n/i18n': i18n
})
const noComponent = () => null
const { IconRail } = await load('renderer/src/redesign/IconRail.tsx', {
  '../i18n/i18n': i18n, './ProfilePanel': { ProfilePanel: noComponent }, './shell-common': { Avatar: noComponent }
})

class FakeDocument extends EventTarget {
  added = []
  removed = []
  addEventListener(type, fn, options) { this.added.push(type); super.addEventListener(type, fn, options) }
  removeEventListener(type, fn, options) { this.removed.push(type); super.removeEventListener(type, fn, options) }
  emit(type, target = this) {
    const event = new Event(type)
    Object.defineProperty(event, 'target', { value: target })
    this.dispatchEvent(event)
  }
}
const click = Object.freeze({ type: 'click', isTrusted: true, defaultPrevented: false })
function deferred() {
  let resolve, reject
  const promise = new Promise((ok, bad) => { resolve = ok; reject = bad })
  return { promise, resolve, reject }
}
function fullscreenFixture() {
  const doc = new FakeDocument()
  const calls = []
  let enter = deferred(), exit = deferred()
  const root = { requestFullscreen() { assert.equal(this, root); calls.push('request'); return enter.promise } }
  Object.assign(doc, { documentElement: root, fullscreenEnabled: true, fullscreenElement: null,
    exitFullscreen() { assert.equal(this, doc); calls.push('exit'); return exit.promise } })
  const controller = createClientFullscreen(doc)
  return { doc, root, calls, controller, enter: () => enter, exit: () => exit,
    resetEnter() { enter = deferred(); return enter }, resetExit() { exit = deferred(); return exit } }
}

test('fullscreen initializes from its document and attaches one native listener pair until last disposal', () => {
  const { doc, root, calls, controller } = fullscreenFixture()
  doc.fullscreenElement = root
  assert.deepEqual(controller.getSnapshot(), { state: 'fullscreen', pressed: true, busy: false })
  assert.deepEqual(doc.added, [])
  const observations = []
  const notify = () => observations.push(controller.getSnapshot().state)
  const releaseFirst = controller.subscribe(notify)
  const releaseSecond = controller.subscribe(notify)
  assert.deepEqual(doc.added, ['fullscreenchange', 'fullscreenerror'])
  assert.equal(controller.getSnapshot(), controller.getSnapshot())
  doc.emit('fullscreenchange')
  assert.deepEqual(observations, [])
  doc.fullscreenElement = null
  doc.emit('fullscreenchange')
  assert.deepEqual(observations, ['windowed', 'windowed'])
  releaseFirst(); releaseFirst()
  assert.deepEqual(doc.removed, [])
  doc.fullscreenElement = root
  doc.emit('fullscreenchange')
  assert.deepEqual(observations, ['windowed', 'windowed', 'fullscreen'])
  releaseSecond(); releaseSecond()
  assert.deepEqual(doc.removed, ['fullscreenchange', 'fullscreenerror'])
  doc.fullscreenElement = null
  doc.emit('fullscreenchange')
  assert.deepEqual(observations, ['windowed', 'windowed', 'fullscreen'])
  assert.equal(controller.getSnapshot().state, 'windowed')
  assert.deepEqual(calls, [])
  controller.subscribe(notify)()
  assert.deepEqual(doc.added, ['fullscreenchange', 'fullscreenerror', 'fullscreenchange', 'fullscreenerror'])
  assert.deepEqual(doc.removed, doc.added)
})

test('fullscreen notifications and native writes stay in the controller document', async () => {
  const local = fullscreenFixture(), other = fullscreenFixture()
  let localNotices = 0, otherNotices = 0
  const clearLocal = local.controller.subscribe(() => { localNotices++ })
  const clearOther = other.controller.subscribe(() => { otherNotices++ })
  other.doc.fullscreenElement = other.root; other.doc.emit('fullscreenchange', other.root)
  assert.equal(local.controller.getSnapshot().state, 'windowed')
  assert.equal(other.controller.getSnapshot().state, 'fullscreen')
  assert.deepEqual([localNotices, otherNotices], [0, 1])
  const entering = local.controller.toggle(click)
  local.enter().resolve(); await entering
  assert.deepEqual(local.calls, ['request'])
  assert.deepEqual(other.calls, [])
  clearLocal(); clearOther()
})

test('trusted click invokes native API synchronously; promise success never substitutes for the DOM', async () => {
  const f = fullscreenFixture()
  const { doc, root, calls, controller } = f
  const observations = []
  const release = controller.subscribe(() => observations.push(controller.getSnapshot()))
  for (const gesture of [{ ...click, isTrusted: false }, { ...click, defaultPrevented: true }, { ...click, type: 'keydown' }]) {
    await controller.toggle(gesture)
  }
  await controller.toggle(click, true)
  assert.deepEqual(calls, [])
  const first = controller.toggle(click)
  assert.deepEqual(calls, ['request'])
  assert.deepEqual(controller.getSnapshot(), { state: 'windowed', pressed: false, busy: true })
  await controller.toggle(click)
  assert.deepEqual(calls, ['request'])
  f.enter().resolve(); await first
  assert.deepEqual(controller.getSnapshot(), { state: 'windowed', pressed: false, busy: false })
  assert.ok(observations.every((view) => !view.pressed))
  const enter = f.resetEnter()
  const second = controller.toggle(click)
  doc.fullscreenElement = root; doc.emit('fullscreenchange', root)
  assert.deepEqual(controller.getSnapshot(), { state: 'fullscreen', pressed: true, busy: true })
  enter.resolve(); await second
  const exit = controller.toggle(click)
  assert.deepEqual(calls, ['request', 'request', 'exit'])
  f.exit().resolve(); await exit
  assert.deepEqual(controller.getSnapshot(), { state: 'fullscreen', pressed: true, busy: false })
  // A browser-initiated exit is observed, with no application Escape handler.
  doc.fullscreenElement = null; doc.emit('fullscreenchange')
  assert.deepEqual(observations.at(-1), { state: 'windowed', pressed: false, busy: false })
  assert.deepEqual(doc.added, ['fullscreenchange', 'fullscreenerror'])
  release()
})

test('fullscreen errors and rejected or thrown native operations preserve real state and disable the button capability', async () => {
  const f = fullscreenFixture()
  const { doc, root, calls, controller } = f
  const dispose = controller.subscribe(() => {})
  const entering = controller.toggle(click)
  doc.emit('fullscreenerror', { name: 'nested video' })
  assert.equal(controller.getSnapshot().state, 'windowed')
  doc.emit('fullscreenerror', root)
  assert.deepEqual(controller.getSnapshot(), { state: 'denied', pressed: false, busy: true, issue: 'request-denied' })
  f.enter().reject(new TypeError('policy')); await entering
  assert.deepEqual(controller.getSnapshot(), { state: 'denied', pressed: false, busy: false, issue: 'request-denied' })
  await controller.toggle(click)
  assert.deepEqual(calls, ['request'])
  // A genuine external change is still reported and clears the stale failure.
  doc.fullscreenElement = root; doc.emit('fullscreenchange', root)
  doc.fullscreenEnabled = false
  const exiting = controller.toggle(click)
  f.exit().reject(new TypeError('exit denied')); await exiting
  assert.deepEqual(controller.getSnapshot(), { state: 'fullscreen', pressed: true, busy: false, issue: 'exit-denied' })
  assert.deepEqual(calls, ['request', 'exit'])
  const exitAgain = f.resetExit()
  const retrying = controller.toggle(click)
  assert.deepEqual(calls, ['request', 'exit', 'exit'])
  doc.fullscreenElement = null; doc.emit('fullscreenchange')
  exitAgain.resolve(); await retrying
  assert.deepEqual(controller.getSnapshot(), { state: 'denied', pressed: false, busy: false })
  doc.fullscreenEnabled = true
  root.requestFullscreen = () => { throw new Error('synchronous policy denial') }
  await controller.toggle(click)
  assert.deepEqual(controller.getSnapshot(), { state: 'denied', pressed: false, busy: false, issue: 'request-denied' })
  dispose()
})

test('nested fullscreen is left alone; absent API and capability policy are distinct', async () => {
  const { doc, root, calls, controller } = fullscreenFixture()
  doc.fullscreenElement = { tagName: 'IFRAME' }
  assert.deepEqual(controller.getSnapshot(), { state: 'foreign', pressed: false, busy: false })
  await controller.toggle(click)
  assert.deepEqual(calls, [])
  doc.fullscreenElement = root
  assert.equal(controller.getSnapshot().state, 'fullscreen')
  doc.fullscreenElement = null
  doc.fullscreenEnabled = false
  await controller.toggle(click)
  assert.deepEqual(controller.getSnapshot(), { state: 'denied', pressed: false, busy: false })
  assert.deepEqual(calls, [])
  delete root.requestFullscreen
  await controller.toggle(click)
  assert.equal(controller.getSnapshot().state, 'unavailable')
  assert.equal(createClientFullscreen(undefined).getSnapshot().state, 'unavailable')
  assert.equal(createClientFullscreen(new FakeDocument()).getSnapshot().state, 'unavailable')
})

class FakeElement {
  nodeType = 1
  isContentEditable = false
  isConnected = true
  visible = true
  constructor(ownerDocument, parent = null, selectors = []) { Object.assign(this, { ownerDocument, parent, selectors }) }
  closest(selector) { return selector.split(', ').some((part) => this.selectors.includes(part)) ? this : this.parent?.closest(selector) }
  contains(target) { return target === this || (target.parent ? this.contains(target.parent) : false) }
  getClientRects() { return this.visible ? [{}] : [] }
}
function keyboardFixture(shortcut) {
  const doc = new FakeDocument()
  const el = (parent, ...selectors) => new FakeElement(doc, parent, selectors)
  const html = el(null), body = el(html), root = el(body), child = el(root), outside = el(body)
  Object.assign(doc, { body, documentElement: html, activeElement: body, visibilityState: 'visible', designMode: 'off',
    overlays: [], querySelectorAll() { return this.overlays }, defaultView: { getComputedStyle: (node) => ({ visibility: node.visibility }) } })
  let currentScope = root, toggles = 0
  const send = (props = {}, target = child, path = [target, root, body, html, doc]) => {
    const event = new Event('keydown', { cancelable: props.cancelable ?? true })
    const { defaultPrevented, cancelable, ...keys } = props
    Object.assign(event, { key: 'b', ctrlKey: shortcut.modifier === 'control', metaKey: shortcut.modifier === 'meta', ...keys })
    Object.defineProperty(event, 'target', { value: target })
    Object.defineProperty(event, 'composedPath', { value: () => path })
    if (defaultPrevented) event.preventDefault()
    return doc.dispatchEvent(event)
  }
  const activate = () => subscribeChatSidebarShortcut(doc, { shortcut, getScope: () => currentScope, onToggleSidebar: () => { toggles++ } })
  return { doc, el, root, child, body, outside, send, activate, toggles: () => toggles, scope: (node) => { currentScope = node } }
}

test('mounted, in-scope shortcuts resolve from the browser client and take only its primary modifier', () => {
  const mac = getClientChatShortcut({ userAgentData: { platform: 'macOS' }, platform: 'Win32' })
  const ios = getClientChatShortcut({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X)' })
  const win = getClientChatShortcut({ platform: 'Win32' })
  const unknown = getClientChatShortcut({ userAgentData: { platform: 'Unknown' }, platform: '', userAgent: 'browser' })
  assert.deepEqual(mac, { modifier: 'meta', label: '⌘B', aria: 'Meta+B' })
  assert.equal(ios, mac)
  assert.equal(getClientChatShortcut({ userAgentData: { platform: 'Unknown' }, platform: 'MacIntel' }), mac)
  assert.equal(getClientChatShortcut({ userAgentData: { platform: 'Linux' }, platform: 'MacIntel' }), win)
  assert.deepEqual(win, { modifier: 'control', label: 'Ctrl+B', aria: 'Control+B' })
  assert.equal(unknown, win)
  assert.equal(getClientChatShortcut(), win)
  assert.equal(getServerPlatformLabel('linux', 'en'), 'Server platform: Linux')
  assert.equal(getServerPlatformLabel('linux', 'zh-CN'), '服务端平台：Linux')
  assert.equal(getServerPlatformLabel('haiku', 'en'), 'Server platform: Haiku')
  assert.equal(getServerPlatformLabel('cygwin', 'en'), 'Server platform: Cygwin')
  assert.equal(getServerPlatformLabel('__proto__', 'en'), 'Server platform: Unknown')
  assert.equal(getServerPlatformLabel('/private/host', 'zh-CN'), '服务端平台：未知')
  for (const shortcut of [mac, win, unknown]) {
    const f = keyboardFixture(shortcut)
    assert.equal(f.send(), true)
    const dispose = f.activate()
    f.scope(null); assert.equal(f.send(), true)
    f.scope(f.root); f.root.isConnected = false; assert.equal(f.send(), true)
    f.root.isConnected = true
    assert.equal(f.send({}, f.outside), true)
    f.doc.activeElement = f.outside; assert.equal(f.send({}, f.body), true)
    f.doc.activeElement = f.body
    assert.equal(f.send({ ctrlKey: shortcut.modifier === 'meta', metaKey: shortcut.modifier === 'control' }), true)
    assert.equal(f.send({ ctrlKey: true, metaKey: true }), true)
    assert.equal(f.send({ ctrlKey: false, metaKey: false }), true)
    assert.equal(f.send({ key: 'B' }), false)
    assert.equal(f.send({}, f.body, [f.body, f.doc]), false)
    assert.equal(f.toggles(), 2)
    dispose()
    assert.equal(f.send(), true)
    assert.equal(f.toggles(), 2)
    assert.deepEqual(f.doc.added, ['keydown']); assert.deepEqual(f.doc.removed, ['keydown'])
  }
})

test('keyboard leaves editors, menus, overlays, inert scopes, IME and existing key handlers alone', () => {
  const f = keyboardFixture(getClientChatShortcut({ platform: 'Linux x86_64' }))
  const dispose = f.activate()
  for (const invalid of [{ key: 'Escape' }, { key: 'F11' }, { key: 'a' }, { cancelable: false }, { repeat: true },
    { isComposing: true }, { keyCode: 229 }, { shiftKey: true }, { altKey: true }]) assert.equal(f.send(invalid), true)
  assert.equal(f.send({ defaultPrevented: true }), false)
  for (const selector of ['input', 'textarea', 'select', 'iframe', '[role~="textbox"]', '[role~="combobox"]',
    '[contenteditable="plaintext-only" i]', '.cm-editor', '.xterm', '[role~="menuitem"]', '[role~="dialog"]', '[inert]']) {
    const input = f.el(f.root, selector), inner = f.el(input)
    assert.equal(f.send({}, inner, [inner, input, f.root, f.body, f.doc]), true, selector)
    f.doc.activeElement = input; assert.equal(f.send({}, f.body), true, selector)
    f.doc.activeElement = f.body
  }
  const shadowInput = f.el(null); shadowInput.isContentEditable = true
  assert.equal(f.send({}, f.child, [shadowInput, f.child, f.root, f.doc]), true)
  for (const selector of ['dialog[open]', '[role~="menu"]', '[role~="listbox"]']) {
    const overlay = f.el(f.body, selector)
    f.doc.overlays = [overlay]
    assert.equal(f.send(), true, selector)
  }
  f.root.selectors = ['[inert]']; assert.equal(f.send(), true)
  f.root.selectors = []; f.doc.overlays = []
  f.doc.visibilityState = 'hidden'; assert.equal(f.send(), true)
  f.doc.visibilityState = 'visible'; f.doc.designMode = 'on'; assert.equal(f.send(), true)
  assert.equal(f.toggles(), 0)
  f.doc.designMode = 'off'
  f.doc.overlays = [f.el(f.body, '[role~="menu"]')]; f.doc.overlays[0].visibility = 'hidden'
  assert.equal(f.send(), false)
  assert.equal(f.toggles(), 1)
  dispose()
})

const h = React.createElement
const renderRail = (props = {}) => renderToStaticMarkup(h(IconRail, {
  tab: 'chats', onTab: () => {}, listCollapsed: false, chatAlert: false, onOpenSettings: () => {}, ...props
}))
const button = (view, locked = false) => h(ClientFullscreenButton, { fullscreen: { view, toggle: () => {} }, locked })
const fullTag = (markup) => markup.match(/<button[^>]*data-testid="workbench-client-fullscreen"[^>]*>/)?.[0]

test('Web rail exposes fullscreen and the original chat accessible label; Desktop stays unchanged', () => {
  const shortcut = getClientChatShortcut({ platform: 'MacIntel' })
  const view = { state: 'windowed', pressed: false, busy: false }
  const desktop = renderRail()
  const web = renderRail({ chatShortcut: shortcut, webFullscreen: button(view) })
  assert.doesNotMatch(desktop, /workbench-client-fullscreen|aria-keyshortcuts/)
  const accessibleName = desktop.match(/<button[^>]*aria-label="([^"]+)"[^>]*aria-current="true"/)?.[1]
  assert.ok(accessibleName)
  assert.ok(web.includes(`title="${accessibleName} (⌘B)" aria-label="${accessibleName}" aria-keyshortcuts="Meta+B"`))
  assert.doesNotMatch(renderRail({ tab: 'tasks', chatShortcut: shortcut }), /aria-keyshortcuts|⌘B/)
  assert.match(fullTag(web), /aria-pressed="false" aria-label="Page fullscreen" aria-describedby=/)
  assert.match(web, /role="status" data-testid="workbench-client-fullscreen-status" data-state="windowed">Page fullscreen is off/)
  assert.ok(web.indexOf('workbench-client-fullscreen-status') < web.indexOf('title="Settings"'))
  assert.match(renderToStaticMarkup(h(ServerPlatformLabel, { platform: 'linux' })), /data-testid="workbench-server-platform"[^>]*>Server platform: Linux/)
})

test('localized fullscreen states remain distinguishable when unavailable, denied, nested or locked', () => {
  locale = 'zh-CN'
  try {
    const markup = renderToStaticMarkup(button({ state: 'fullscreen', pressed: true, busy: false }, true))
    assert.match(fullTag(markup), /data-state="fullscreen" data-locked="true" disabled="" aria-pressed="true" aria-label="页面全屏"/)
    assert.match(markup, /role="status"[^>]*>页面全屏已开启.*锁定/)
    const expected = { denied: '浏览器已阻止页面全屏操作', foreign: '其他元素正在全屏显示', unavailable: '当前浏览器未启用页面全屏功能' }
    for (const [state, description] of Object.entries(expected)) {
      const html = renderToStaticMarkup(button({ state, pressed: false, busy: false }))
      assert.match(fullTag(html), new RegExp(`data-state="${state}" disabled="" aria-pressed="false"`))
      assert.match(html, new RegExp(`data-testid="workbench-client-fullscreen-status" data-state="${state}">${description}`))
    }
    const rejected = renderToStaticMarkup(button({ state: 'denied', pressed: false, busy: false, issue: 'request-denied' }))
    assert.match(rejected, /data-state="denied">浏览器已阻止页面全屏操作。刷新此页后可重试。/)
    const stillFullscreen = renderToStaticMarkup(button({ state: 'fullscreen', pressed: true, busy: false, issue: 'exit-denied' }))
    assert.match(stillFullscreen, /data-state="fullscreen">页面仍处于全屏状态。浏览器阻止了上一次退出操作。/)
    assert.doesNotMatch(fullTag(stillFullscreen), /disabled/)
    const busy = renderToStaticMarkup(button({ state: 'windowed', pressed: false, busy: true }))
    assert.match(fullTag(busy), /disabled="" aria-pressed="false" aria-busy="true"/)
    assert.match(renderToStaticMarkup(h(ServerPlatformLabel, { platform: 'linux' })), />服务端平台：Linux</)
  } finally { locale = 'en' }
})
