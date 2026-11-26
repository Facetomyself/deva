export type ClientFullscreenState = 'windowed' | 'fullscreen' | 'foreign' | 'unavailable' | 'denied'
type FullscreenOperation = 'request' | 'exit'
type FullscreenIssue = 'request-denied' | 'exit-denied'
export type ClientFullscreenView = Readonly<{
  state: ClientFullscreenState; pressed: boolean; busy: boolean; issue?: FullscreenIssue
}>
type FullscreenGesture = Pick<Event, 'isTrusted' | 'type' | 'defaultPrevented'>

const unavailableFullscreen: ClientFullscreenView = { state: 'unavailable', pressed: false, busy: false }

/** No window metrics or inferred browser/OS fullscreen: the native document owns the truth. */
export function createClientFullscreen(doc: Document | undefined) {
  const listeners = new Set<{ notify: () => void }>()
  let lastElement: Element | null | undefined
  let issue: FullscreenIssue | undefined
  let pending: FullscreenOperation | undefined
  let view = unavailableFullscreen
  let publishedView = view

  function getSnapshot(): ClientFullscreenView {
    const root = doc?.documentElement
    const element = doc?.fullscreenElement
    if (lastElement !== element) {
      lastElement = element
      issue = undefined
    }
    const pressed = !!root && element === root
    const busy = !!pending
    const state: ClientFullscreenState = element && !pressed ? 'foreign'
      : !doc || !root || !('fullscreenElement' in doc) || typeof doc.exitFullscreen !== 'function' ? 'unavailable'
      // An entry policy does not disable leaving a document already in fullscreen.
      : pressed ? 'fullscreen'
      : typeof root.requestFullscreen !== 'function' ? 'unavailable'
      : issue === 'request-denied' || doc.fullscreenEnabled === false ? 'denied' : 'windowed'
    if (view.state !== state || view.pressed !== pressed || view.busy !== busy || view.issue !== issue) {
      view = { state, pressed, busy, ...(issue && { issue }) }
    }
    return view
  }

  function publish(): void {
    const current = getSnapshot()
    if (publishedView === current) return
    publishedView = current
    for (const listener of listeners) listener.notify()
  }
  function recordDenial(operation: FullscreenOperation): void {
    const { state, pressed } = getSnapshot()
    if (state === 'foreign' || (operation === 'exit') !== pressed) return
    issue = operation === 'exit' ? 'exit-denied' : 'request-denied'
  }
  function onError(event: Event): void {
    // A nested element can fire its own fullscreenerror on this document.
    if (!pending || (event.target !== doc && event.target !== doc?.documentElement)) return
    recordDenial(pending)
    publish()
  }
  function subscribe(notify: () => void): () => void {
    const listener = { notify }
    listeners.add(listener)
    if (listeners.size === 1) {
      publishedView = getSnapshot()
      doc?.addEventListener('fullscreenchange', publish)
      doc?.addEventListener('fullscreenerror', onError)
    }
    return () => {
      if (!listeners.delete(listener) || listeners.size) return
      doc?.removeEventListener('fullscreenchange', publish)
      doc?.removeEventListener('fullscreenerror', onError)
    }
  }

  async function toggle(gesture: FullscreenGesture, locked = false): Promise<void> {
    if (!doc || locked || pending || gesture.type !== 'click' || !gesture.isTrusted || gesture.defaultPrevented) return
    const { state } = getSnapshot()
    if (state !== 'windowed' && state !== 'fullscreen') {
      publish()
      return
    }
    const operation = state === 'windowed' ? 'request' : 'exit'
    issue = undefined
    pending = operation
    try {
      // Invoke before notifying subscribers or awaiting: preserve browser user activation.
      const completion = operation === 'request' ? doc.documentElement.requestFullscreen() : doc.exitFullscreen()
      publish()
      await completion
    } catch {
      recordDenial(operation)
    } finally {
      pending = undefined
      publish()
    }
  }
  return { getSnapshot, subscribe, toggle }
}

export type ClientChatShortcut = Readonly<{ modifier: 'meta' | 'control'; label: string; aria: string }>
export type ClientNavigator = {
  platform?: string
  userAgent?: string
  userAgentData?: { platform?: string }
}
const commandShortcut: ClientChatShortcut = { modifier: 'meta', label: '⌘B', aria: 'Meta+B' }
const controlShortcut: ClientChatShortcut = { modifier: 'control', label: 'Ctrl+B', aria: 'Control+B' }

/** The server platform is intentionally absent from shortcut selection. */
export function getClientChatShortcut(navigator?: ClientNavigator): ClientChatShortcut {
  for (const platform of [navigator?.userAgentData?.platform, navigator?.platform, navigator?.userAgent]) {
    if (!platform) continue
    if (/\b(?:mac(?:os|intel|ppc|68k|intosh)?|iOS|iPhone|iPad|iPod)\b/i.test(platform)) return commandShortcut
    if (/\b(?:win(?:32|64|dows)?|linux|android|cros|chrome\s*os|x11|freebsd|openbsd)\b/i.test(platform)) return controlShortcut
  }
  return controlShortcut
}

const overlays = 'dialog[open], [role~="dialog"], [role~="alertdialog"], [role~="menu"], [role~="listbox"]'
const hidden = '[hidden], [inert], [aria-hidden="true"]'
const editing = [
  'input', 'textarea', 'select', 'iframe',
  '[contenteditable="" i]', '[contenteditable="true" i]', '[contenteditable="plaintext-only" i]',
  '[role~="textbox"]', '[role~="searchbox"]', '[role~="spinbutton"]', '[role~="combobox"]',
  '[role~="menuitem"]', '[role~="menuitemradio"]', '[role~="menuitemcheckbox"]',
  '.cm-editor', '.monaco-editor', '.xterm', '[data-lexical-editor]', overlays, hidden
].join(', ')

function asElement(target: EventTarget | null): Element | undefined {
  return target && (target as Node).nodeType === 1 ? target as Element : undefined
}
function blocksShortcut(element: Element | undefined): boolean {
  return !!element && ((element as HTMLElement).isContentEditable || !!element.closest(editing))
}
function visibleOverlay(doc: Document): boolean {
  return Array.from(doc.querySelectorAll(overlays)).some((element) => {
    if (element.closest(hidden) || !element.getClientRects().length) return false
    const visibility = doc.defaultView?.getComputedStyle(element).visibility
    return visibility !== 'hidden' && visibility !== 'collapse'
  })
}

export function subscribeChatSidebarShortcut(doc: Document, options: {
  getScope: () => HTMLElement | null
  shortcut: ClientChatShortcut
  onToggleSidebar: () => void
}): () => void {
  function onKeyDown(event: KeyboardEvent): void {
    if (event.defaultPrevented || !event.cancelable || event.repeat || event.isComposing || event.keyCode === 229 ||
      event.shiftKey || event.altKey || event.key?.toLowerCase() !== 'b' ||
      (options.shortcut.modifier === 'meta' ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey)) return
    const scope = options.getScope()
    if (!scope?.isConnected || scope.ownerDocument !== doc || scope.closest(hidden) ||
      doc.visibilityState === 'hidden' || doc.designMode?.toLowerCase() === 'on') return
    const inScope = (element: Element | undefined): boolean => !element || element === doc.body ||
      element === doc.documentElement || scope.contains(element)
    const active = asElement(doc.activeElement)
    if (!inScope(asElement(event.target)) || !inScope(active) || blocksShortcut(active) ||
      event.composedPath().some((target) => blocksShortcut(asElement(target))) || visibleOverlay(doc)) return
    event.preventDefault()
    options.onToggleSidebar()
  }
  doc.addEventListener('keydown', onKeyDown)
  return () => doc.removeEventListener('keydown', onKeyDown)
}
