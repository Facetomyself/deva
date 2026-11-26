import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))
const ts = require('typescript')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const source = new URL('../../apps/desktop/src/', import.meta.url)
function deferred() {
  let resolve, reject
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}
const tick = () => new Promise((resolve) => setImmediate(resolve))
const noop = () => {}

async function load(path, imports = {}, globals = {}) {
  const js = ts.transpileModule(await readFile(new URL(path, source), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }
  }).outputText
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', ...Object.keys(globals), js)(
    (name) => Object.hasOwn(imports, name) ? imports[name] : require(name), mod, mod.exports, ...Object.values(globals))
  return mod.exports
}

// Only the DOM surfaces used by the selection validator are modeled here. Actual markup is rendered below.
class Element {
  nodeType = 1
  children = []
  constructor(parentElement, ...selectors) {
    this.parentElement = parentElement
    this.selectors = selectors
    this.connected = true
    parentElement?.children.push(this)
  }
  get isConnected() { return this.parentElement?.isConnected ?? this.connected }
  closest(selectors) {
    if (selectors.split(/,\s*/).some((selector) => this.selectors.includes(selector))) return this
    return this.parentElement?.closest(selectors) ?? null
  }
  querySelectorAll(selectors) {
    return this.children.flatMap((node) => [
      ...(selectors.split(/,\s*/).some((selector) => node.selectors.includes(selector)) ? [node] : []),
      ...node.querySelectorAll(selectors)
    ])
  }
  querySelector(selectors) { return this.querySelectorAll(selectors)[0] ?? null }
  contains(node) { return this === node || !!node?.parentElement && this.contains(node.parentElement) }
  focus() { this.focused = true }
}
const leaf = (parentElement) => ({ nodeType: 3, parentElement })
const surfaceMarker = '[data-testid="workbench-message-text"]'
function selection(anchorNode, focusNode = anchorNode, plain = '  你好 🦊 <b>&_literal\n下一行  ', intersected = [], rects = []) {
  let current = plain
  const range = { startContainer: anchorNode, endContainer: focusNode, cloneRange: () => ({ ...range }),
    intersectsNode: (node) => intersected.includes(node), toString: () => current,
    getClientRects: () => rects, getBoundingClientRect: () => ({ left: 25, bottom: 45 }) }
  return { anchorNode, focusNode, rangeCount: 1, isCollapsed: false, getRangeAt: () => range,
    toString: () => plain, change: (next) => { current = next } }
}
function surfaces() {
  const page = new Element(null)
  const root = new Element(page)
  const message = new Element(root, surfaceMarker)
  const left = leaf(new Element(message))
  const right = leaf(message)
  const another = leaf(new Element(root, surfaceMarker))
  const otherOwnerText = leaf(new Element(new Element(page), surfaceMarker))
  const attachment = leaf(new Element(root))
  const delivery = leaf(new Element(root))
  const privateSetting = leaf(new Element(page, '[contenteditable]'))
  const button = new Element(message, 'button')
  return { page, root, message, left, right, another, otherOwnerText, attachment, delivery, privateSetting, button }
}

const reactForSSR = { ...React, useLayoutEffect: React.useEffect }
const { messages } = await load('renderer/src/i18n/messages.ts')
const i18n = { useI18n: () => ({ locale: 'en', t: (key) => key.split('.').reduce((obj, part) => obj?.[part], messages.en) ?? key }) }
const importEsm = (name) => import(pathToFileURL(require.resolve(name)).href)
const md = await load('renderer/src/features/chat/Markdown.tsx', {
  'react-markdown': await importEsm('react-markdown'), 'remark-gfm': await importEsm('remark-gfm'),
  'rehype-highlight': await importEsm('rehype-highlight'), '../../i18n/i18n': i18n,
  './CodeClipboard': await load('renderer/src/features/chat/CodeClipboard.tsx')
})
const attachmentUi = await load('renderer/src/redesign/attachments.tsx', { '../i18n/i18n': i18n })
const conv = await load('renderer/src/redesign/ConvMessage.tsx', {
  react: reactForSSR, './attachments': attachmentUi, '../features/chat/Markdown': md, '../features/chat/blocks': {},
  '../i18n/i18n': i18n, './shell-common': { Avatar: () => null }, './TaskBar': {},
  '../../../shared/mention': await load('shared/mention.ts'), '../../../shared/quote': await load('shared/quote.ts')
}, { Element })
const transport = await load('workbench/chat-transport.ts')
const draftModule = await load('workbench/quote-draft.ts', { '../renderer/src/redesign/ConvMessage': conv, './chat-transport': transport })
const { createQuoteDrafts, composedDraft, exceedsDraftLimit } = draftModule
const selectionModule = await load('workbench/conversation-selection.ts', { '../renderer/src/redesign/ConvMessage': conv })
const { captureConversationSelection: capture, ownsConversationSelection: owns, createSelectionCopyFeedback } = selectionModule
const contextMenu = await load('renderer/src/redesign/ContextMenu.tsx', { react: reactForSSR })
const loadSelectionUI = (react, writeClientText = async () => assert.fail('rendering must never write the clipboard')) =>
  load('workbench/conversation-selection-ui.tsx', { react, '../renderer/src/i18n/i18n': i18n,
    '../renderer/src/redesign/ContextMenu': contextMenu, './client-clipboard': { writeClientText }, './conversation-selection': selectionModule })
const { ConversationSelectionMenu, ConversationSelectionStatus } = await loadSelectionUI(reactForSSR)
const { ComposerQuoteBar } = await load('renderer/src/redesign/ComposerQuoteBar.tsx', { '../i18n/i18n': i18n, './ConvMessage': conv })
const render = (component, props) => renderToStaticMarkup(React.createElement(component, props))

test('capture stays inside the one triggering message and ignores delivery, private, attachment, control, and other owner text', () => {
  const { root, message, left, right, another, otherOwnerText, attachment, delivery, privateSetting, button } = surfaces()
  const good = selection(left, right)
  const snapshot = capture(root, left, good)
  assert.ok(snapshot)
  assert.equal(snapshot.message, message)
  assert.equal(snapshot.plain, good.toString())
  assert.equal(snapshot.quote, '> 你好 🦊 <b>&_literal\n> 下一行')
  assert.ok(capture(root, message, selection(right, left)), 'reverse selection within one focused message')
  for (const outside of [another, otherOwnerText, attachment, delivery, privateSetting, leaf(button)]) {
    assert.equal(capture(root, outside, good), undefined)
    assert.equal(capture(root, left, selection(left, outside)), undefined)
  }
  assert.equal(capture(root, left, selection(left, right, 'text + control', [button])), undefined)
  assert.equal(capture(root, left, selection(left, right, '　 \n')), undefined)
  assert.equal(capture(root, left, { ...good, isCollapsed: true }), undefined)
  assert.equal(capture(root, left, { ...good, rangeCount: 2 }), undefined)
  assert.equal(capture(root, left, { ...good, getRangeAt: () => selection(left, attachment).getRangeAt(0) }), undefined)
  assert.ok(owns(root, snapshot))
  good.change('rewritten')
  assert.equal(owns(root, snapshot), false)
  root.parentElement.connected = false
  assert.equal(capture(root, left, selection(left, right)), undefined)
})

test('visible selections inside a clamped message work but clipped text cannot enter the menu', () => {
  const { root, message } = surfaces()
  const part = Object.assign(new Element(message, '.cf-msg__clamp.is-clamped'), {
    scrollHeight: 200, clientHeight: 60, getBoundingClientRect: () => ({ bottom: 65 })
  })
  const text = leaf(part)
  assert.ok(capture(root, text, selection(text, text, 'visible', [part], [{ height: 16, bottom: 62 }])))
  assert.equal(capture(root, text, selection(text, text, 'visibly clipped', [part], [{ height: 16, bottom: 92 }])), undefined)
})

test('literal code selection copies no markup and keeps original Desktop fenced quote semantics', () => {
  const { root, message } = surfaces()
  const block = new Element(message, '.md-code')
  const header = new Element(block, '.md-code__head')
  const code = new Element(block, 'code')
  code.className = 'hljs language-js'
  const contents = leaf(new Element(code))
  const literal = '\n  const fox = "🦊"\r\n    second()\n'
  const selected = capture(root, contents, selection(contents, contents, literal))
  assert.equal(selected.plain, literal)
  assert.equal(selected.quote, '> ```js\n>   const fox = "🦊"\n>     second()\n> ```')
  assert.equal(capture(root, header, selection(leaf(header))), undefined)
  assert.equal(capture(root, contents, selection(contents, contents, literal, [header])), undefined)
})

test('native writes start on activation and only confirmed latest results are reported within the same owner', async () => {
  let current = true
  const status = []
  const writes = []
  const write = (value) => {
    const pending = deferred()
    writes.push({ value, ...pending })
    return pending.promise
  }
  const feedback = createSelectionCopyFeedback(write)
  const report = (value) => status.push(value)
  const valid = () => current
  const raw = '  👩🏽‍💻 <b>&你好\n\n  '
  feedback.copy(raw, valid, report)
  assert.equal(writes[0].value, raw)
  assert.deepEqual(status, [undefined])
  writes[0].resolve()
  await tick()
  assert.deepEqual(status, [undefined, 'copied'])

  feedback.copy('first late copy', valid, report)
  feedback.copy('second rejects', valid, report)
  writes[2].reject(new Error('denied'))
  writes[1].resolve()
  await tick()
  assert.deepEqual(status, [undefined, 'copied', undefined, undefined, 'copy-failed'])

  feedback.copy('on old sid', valid, report)
  current = false
  writes[3].reject(new Error('obsolete on switch'))
  feedback.copy('stale popup', valid, report)
  await tick()
  assert.equal(writes.length, 4)
  assert.equal(status.at(-1), undefined)

  current = true
  feedback.copy('before logout', valid, report)
  feedback.invalidate()
  writes[4].resolve()
  await tick()
  assert.equal(status.at(-1), undefined)
  createSelectionCopyFeedback(() => { throw new Error('native sync failure') }).copy('failure', valid, report)
  assert.equal(status.at(-1), 'copy-failed')
})

test('real Desktop message, context menu and quote bar markup are reused without changing old message output', () => {
  const text = composedDraft({ quote: '> first <outside>\n> 🦊 second', body: 'body literal' })
  const userProps = { role: 'user', text, attachments: [{ id: 'a', name: 'filename.txt', kind: 'text', size: 2 }] }
  const original = render(conv.TextConversationMessage, userProps)
  const workbench = render(conv.TextConversationMessage, { ...userProps, selectable: true })
  assert.match(original, /class="cf-msg__quote is-clamped"[^>]*>first &lt;outside&gt;\n🦊 second/)
  assert.match(workbench, /data-testid="workbench-message-attachments".*data-testid="workbench-message-text"/s)
  assert.equal(workbench.replace(' tabindex="0" data-testid="workbench-message-text" aria-haspopup="menu"', ''), original)
  const answer = render(conv.TextConversationMessage, { role: 'assistant', selectable: true, text: '显示 **粗体** 🦊\n\n`literal`\n\n![alt](https://example.test/)' })
  assert.match(answer, /class="msg__text" tabindex="0" data-testid="workbench-message-text"/)
  assert.match(answer, /显示 <strong>粗体<\/strong> 🦊/)
  assert.doesNotMatch(answer, /https:\/\/example.test/)
  const point = { x: 8, y: 30, close: noop, copy: noop }
  const readonly = render(ConversationSelectionMenu, point)
  const writable = render(ConversationSelectionMenu, { ...point, quote: noop })
  assert.match(readonly, /class="cf-ctx"[^>]*role="menu" data-testid="workbench-selection-menu"/)
  assert.match(readonly, /role="menuitem" tabindex="-1" data-testid="workbench-selection-copy"/)
  assert.doesNotMatch(readonly, /workbench-selection-quote/)
  assert.match(writable, /role="menuitem" tabindex="-1" data-testid="workbench-selection-quote"/)
  const bar = render(ComposerQuoteBar, { quote: text.split('\n\n')[0], onRemove: noop,
    testId: 'workbench-quote-draft', removeTestId: 'workbench-quote-remove' })
  assert.match(bar, /class="cf-quotebar" data-testid="workbench-quote-draft"/)
  assert.match(bar, /title="first &lt;outside&gt;\n🦊 second">first &lt;outside&gt; 🦊 second/)
  assert.match(bar, /data-testid="workbench-quote-remove"[^>]+aria-label=/)
  assert.match(render(ConversationSelectionStatus, { status: 'copy-failed', locale: 'en' }), /role="status".*data-status="copy-failed".*Copy failed/)
  assert.match(render(ConversationSelectionStatus, { status: 'copied', locale: 'zh-CN' }), /data-status="copied">已复制所选文字/)
  assert.doesNotMatch(render(ConversationSelectionStatus, { locale: 'en' }), /data-status=/)
})

test('quote draft composition uses UTF-8 for the whole submitted text, with independent owner/SID revisions', () => {
  const quote = '> 你好 🦊\n> second'
  const a = createQuoteDrafts(), otherOwner = createQuoteDrafts()
  const b = a.setBody('b', 'separate chat')
  a.setBody('a', '  multiline\nbody  ')
  a.setQuote('a', quote)
  assert.equal(composedDraft(a.read('a')), `${quote}\n\nmultiline\nbody`)
  assert.equal(composedDraft(otherOwner.read('a')), '')
  const sent = a.read('a')
  a.setQuote('a', quote)
  assert.equal(a.commit('a', sent), false)
  assert.equal(a.read('a').quote, quote)
  a.setQuote('a', '')
  assert.equal(a.read('a').body, '  multiline\nbody  ')
  assert.equal(a.read('b'), b)
  const exact = '🦊'.repeat(transport.MAX_TEXT_INPUT / 4)
  assert.equal(exceedsDraftLimit(a.setBody('a', exact)), false)
  a.setQuote('a', '> x')
  assert.equal(exceedsDraftLimit(a.read('a')), true)
  const current = a.setBody('a', '')
  assert.equal(composedDraft(current), '> x')
  assert.equal(a.commit('a', current), true)
  assert.equal(a.commit('a', current), false)
  assert.deepEqual(a.read('a'), { quote: '', body: '' })
  assert.equal(a.read('b'), b)
})

// Deterministic hook lifecycle for browser/transport boundaries: flush layout/effects on render,
// keep refs/state between renders, and run their cleanup when the authenticated owner unmounts.
function lifecycle() {
  const slots = []
  let cursor = 0, effects = []
  const memo = (make, deps) => {
    const i = cursor++, old = slots[i]
    if (!old || deps.some((d, n) => !Object.is(d, old.deps[n])) || deps.length !== old.deps.length) {
      slots[i] = { deps, value: make() }
    }
    return slots[i].value
  }
  const effect = (run, deps) => {
    const old = slots[cursor]
    memo(() => {
      const item = {}
      effects.push(() => { old?.value.dispose?.(); item.dispose = run() })
      return item
    }, deps)
  }
  return {
    react: {
      useMemo: memo, useCallback: (fn, deps) => memo(() => fn, deps), useEffect: effect, useLayoutEffect: effect,
      useRef: (current) => memo(() => ({ current }), []),
      useState: (initial) => {
        const cell = memo(() => ({ current: typeof initial === 'function' ? initial() : initial }), [])
        return [cell.current, (next) => { cell.current = typeof next === 'function' ? next(cell.current) : next }]
      }
    },
    render(run) {
      cursor = 0
      effects = []
      const result = run()
      for (const next of effects) next()
      return result
    },
    dispose() { for (const slot of slots) slot?.value?.dispose?.() }
  }
}

function gesture(target, key = 'F10', shiftKey = true) {
  return { target, key, shiftKey, clientX: 10, clientY: 10, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true }, stopPropagation() { this.stopped = true } }
}

test('selection menu opens from right click or same-message keyboard focus; quoting and changing owner publish no clipboard write', async () => {
  const { root, message, left, right, another, attachment } = surfaces()
  const owner = lifecycle()
  const writes = [], quotes = []
  let active = true, stamp = 1, writable = true
  const { useConversationSelection } = await loadSelectionUI(owner.react, (value) => {
    const deferredWrite = deferred()
    writes.push({ value, ...deferredWrite })
    return deferredWrite.promise
  })
  const selected = selection(left, right)
  root.ownerDocument = { getSelection: () => selected }
  const show = () => owner.render(() => useConversationSelection({ current: root }, active, () => stamp,
    writable ? (q) => quotes.push(q) : undefined))
  let view = show()
  assert.equal(view.menu, null)
  const foreign = gesture(another)
  view.onKeyDown(foreign)
  assert.equal(foreign.defaultPrevented, false)
  view.onContextMenu(gesture(attachment))
  assert.equal(show().menu, null)
  const keyboard = gesture(message)
  view.onKeyDown(keyboard)
  view = show()
  assert.equal(keyboard.defaultPrevented, true)
  assert.equal(view.menu.props.x, 25)
  assert.deepEqual(writes, [])
  view.menu.props.close()
  assert.equal(message.focused, true)
  view.menu.props.quote()
  assert.deepEqual(quotes, ['> 你好 🦊 <b>&_literal\n> 下一行'])
  assert.deepEqual(writes, [])

  writable = false
  view = show()
  const context = gesture(left)
  view.onContextMenu(context)
  view = show()
  assert.equal(context.defaultPrevented, true)
  assert.equal(view.menu.props.quote, undefined)
  view.menu.props.close()
  view.menu.props.copy()
  assert.equal(writes[0].value, selected.toString())
  assert.equal(show().status, undefined)
  writes[0].reject(new Error('permission denied'))
  await tick()
  assert.equal(show().status, 'copy-failed')

  view.onKeyDown(gesture(message, 'ContextMenu', false))
  view = show()
  view.menu.props.close()
  view.menu.props.copy()
  stamp++ // Switching away and back invalidates old receipts even if the visible SID is reused.
  writes[1].resolve()
  await tick()
  assert.equal(show().status, undefined)
  active = false
  assert.equal(show().menu, null)
  assert.equal(show().status, undefined)
  owner.dispose()
})

const attachmentModule = await load('workbench/attachment-drafts.ts', { './chat-transport': transport })
const { HttpFailure } = await load('workbench/transport.ts')
async function workbenchFixture() {
  const owner = lifecycle(), turns = [], consumed = []
  const projections = new Map([
    ['a', { compatibility: 'text', writable: true }], ['b', { compatibility: 'text', writable: true }],
    ['read-only', { compatibility: 'legacy_text', writable: false }]
  ])
  const file = { id: '1a111111-0000-4000-8000-000000000002', name: 'notes.txt', mime: 'text/plain', kind: 'text', size: 7 }
  const empty = { entries: [], issues: [] }
  const files = new Map([['a', { entries: [{ status: 'ready', attachment: file }], issues: [] }]])
  const api = { send(sid, draft) {
    const receipt = deferred()
    turns.push({ sid, draft, ...receipt })
    return receipt.promise
  } }
  const { useTextWorkbench } = await load('workbench/use-text-workbench.ts', {
    react: owner.react, './chat-transport': transport, './quote-draft': draftModule,
    './attachment-drafts': { ...attachmentModule, createAttachmentDrafts: () => ({
      get: (sid) => files.get(sid) ?? empty,
      committed: (sid, ids) => { consumed.push({ sid, ids }); files.delete(sid) }
    }) },
    './chat-stream': { createChatStream: ({ sid }) => ({ current: () => ({ status: 'ready', snapshot: { state: projections.get(sid) } }), close: noop, refresh: noop }) },
    './session-list': { createListRefresh: () => ({ request: noop, afterWrite: noop, close: noop }) },
    './session-preferences': {}, './sessions-stream': {}, './transport': { HttpFailure }
  }, { window: { location: { origin: 'https://workbench.test' }, setInterval: noop, clearInterval: noop,
    addEventListener: noop, removeEventListener: noop, sessionStorage: { setItem: noop, removeItem: noop } } })
  const read = () => owner.render(() => useTextWorkbench(api, noop, noop, true))
  let wk = read()
  const select = (sid) => { wk.select(sid); wk = read(); return wk }
  return { read, select, turns, consumed, files, file, dispose: owner.dispose }
}

test('quoted turns use the existing send receipt, preserve files and revision across failure/switch, and stay inside the owning login', async () => {
  const w = await workbenchFixture()
  let a = w.select('a')
  const quote = '> 第一行 🦊\n> second'
  assert.equal(a.setDraftQuote('b', quote), false)
  assert.equal(a.setDraftQuote('a', quote), true)
  assert.equal(w.turns.length, 0)
  assert.equal(w.files.get('a').entries[0].attachment, w.file)
  assert.equal(await a.send('a', '🦊'.repeat(transport.MAX_TEXT_INPUT / 4), null), false)
  assert.equal(w.turns.length, 0)

  const first = a.send('a', ' original\nbody ', null)
  await tick()
  assert.equal(w.turns[0].draft.text, `${quote}\n\noriginal\nbody`)
  assert.deepEqual(w.turns[0].draft.attachments, [w.file.id])
  assert.equal(await a.send('a', 'another click while pending', null), false)
  w.turns[0].reject(new Error('network failed before receipt'))
  assert.equal(await first, false)
  assert.equal(w.read().turnIssue, 'turnFailure')
  assert.deepEqual(w.consumed, [])
  assert.equal(a.drafts.read('a').quote, quote)

  const retry = a.send('a', ' original\nbody ', null)
  await tick()
  assert.deepEqual(w.turns[1].draft, w.turns[0].draft)
  a.setDraftQuote('a', quote)
  const changed = a.drafts.read('a')
  const b = w.select('b')
  assert.equal(a.selectionStamp('a'), undefined)
  assert.equal(b.setDraftQuote('b', '> other'), true)
  assert.equal(a.setDraftQuote('a', '> stale'), false)
  w.turns[1].resolve({ turnId: 'id', duplicate: true })
  assert.equal(await retry, true)
  assert.deepEqual(w.consumed, [{ sid: 'a', ids: [w.file.id] }])
  assert.equal(b.drafts.read('a'), changed)
  assert.equal(composedDraft(b.drafts.read('b')), '> other')

  const legacy = w.select('read-only')
  assert.equal(legacy.setDraftQuote('read-only', quote), false)
  assert.equal(await legacy.send('read-only', 'read-only chat', null), false)
  a = w.select('a')
  const acknowledged = a.send('a', ' original\nbody ', null)
  await tick()
  assert.notEqual(w.turns[2].draft.clientRequestId, w.turns[1].draft.clientRequestId)
  w.select('b')
  w.turns[2].resolve({ turnId: 'next' })
  assert.equal(await acknowledged, true)
  assert.equal(composedDraft(a.drafts.read('a')), '')
  assert.equal(composedDraft(a.drafts.read('b')), '> other')

  const beforeLogout = w.read().send('b', '', null)
  await tick()
  w.dispose()
  assert.equal(b.selectionStamp('b'), undefined)
  const newOwner = await workbenchFixture()
  assert.equal(composedDraft(newOwner.select('b').drafts.read('b')), '')
  w.turns[3].resolve({ turnId: 'old-owner' })
  assert.equal(await beforeLogout, false)
  assert.equal(composedDraft(newOwner.read().drafts.read('b')), '')
  newOwner.dispose()
})
