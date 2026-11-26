import { quoteOf } from '../renderer/src/redesign/ConvMessage'

const messageText = '[data-testid="workbench-message-text"]'
const control = 'button, input, select, textarea, [contenteditable], [role="button"], [role="checkbox"], [hidden], [inert], [aria-hidden="true"], .md-code__head'
const clampedText = '.cf-msg__clamp.is-clamped, .cf-msg__quote.is-clamped'

const elementOf = (node: Node | null): Element | null => node?.nodeType === 1 ? node as Element : node?.parentElement ?? null
const surfaceOf = (node: Node | null): HTMLElement | null => elementOf(node)?.closest<HTMLElement>(messageText) ?? null
const withinText = (message: HTMLElement, node: Node | null): boolean =>
  surfaceOf(node) === message && !elementOf(node)?.closest(control)

export type ConversationSelection = Readonly<{
  message: HTMLElement
  range: Range
  rangeText: string
  plain: string
  quote: string
}>

function containsClippedText(message: HTMLElement, range: Range): boolean {
  for (const part of message.querySelectorAll<HTMLElement>(clampedText)) {
    if (part.scrollHeight - part.clientHeight <= 1 || !range.intersectsNode(part)) continue
    const overlap = range.cloneRange()
    if (!part.contains(range.startContainer)) overlap.setStart(part, 0)
    if (!part.contains(range.endContainer)) overlap.setEnd(part, part.childNodes.length)
    // Native selections can cross line-clamped text, even though its later lines are drawn outside the clip.
    const visible = part.getBoundingClientRect()
    if (Array.from(overlap.getClientRects()).some((rect) => rect.height > 0 && rect.bottom > visible.bottom + 1)) return true
  }
  return false
}

function rangeWithinText(message: HTMLElement, range: Range): boolean {
  return withinText(message, range.startContainer) && withinText(message, range.endContainer) &&
    !Array.from(message.querySelectorAll(control)).some((node) => range.intersectsNode(node)) && !containsClippedText(message, range)
}

/** Both ends, the trigger, and the range itself must belong to the same owned text surface. */
export function captureConversationSelection(root: HTMLElement, target: Node | null, selection: Selection | null): ConversationSelection | undefined {
  const message = surfaceOf(target)
  if (!message || !root.isConnected || !root.contains(message) || !withinText(message, target) ||
    !selection || selection.isCollapsed || selection.rangeCount !== 1 ||
    !withinText(message, selection.anchorNode) || !withinText(message, selection.focusNode)) return
  const bounds = selection.getRangeAt(0)
  if (!rangeWithinText(message, bounds)) return
  const plain = selection.toString()
  if (!plain.trim()) return
  const range = bounds.cloneRange()
  return { message, range, plain, quote: quoteOf(selection), rangeText: range.toString() }
}

/** A popup can retain the gesture's snapshot after focus moves, but detached or replaced text expires. */
export function ownsConversationSelection(root: HTMLElement, captured: ConversationSelection): boolean {
  return root.isConnected && root.contains(captured.message) && rangeWithinText(captured.message, captured.range) &&
    captured.range.toString() === captured.rangeText
}

export type CopyStatus = 'copied' | 'copy-failed'

/** Call the adapter on the initiating stack; only the latest still-owned promise can publish a result. */
export function createSelectionCopyFeedback(write: (text: string) => Promise<void>) {
  let generation = 0
  return {
    invalidate() { generation++ },
    copy(text: string, current: () => boolean, report: (status: CopyStatus | undefined) => void): void {
      if (!current()) return
      const attempt = ++generation
      const finish = (status: CopyStatus): void => {
        if (attempt === generation && current()) report(status)
      }
      report(undefined)
      try {
        void write(text).then(() => finish('copied'), () => finish('copy-failed'))
      } catch { finish('copy-failed') }
    }
  }
}
