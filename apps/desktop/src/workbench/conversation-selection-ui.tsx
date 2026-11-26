import { useEffect, useLayoutEffect, useState, type KeyboardEvent, type MouseEvent, type RefObject } from 'react'
import { Copy, TextQuote } from 'lucide-react'
import { useI18n } from '../renderer/src/i18n/i18n'
import { ContextMenu, type CtxEntry } from '../renderer/src/redesign/ContextMenu'
import { writeClientText } from './client-clipboard'
import { captureConversationSelection, createSelectionCopyFeedback, ownsConversationSelection,
  type ConversationSelection, type CopyStatus } from './conversation-selection'

type Popup = { x: number; y: number; capture: ConversationSelection }

export function ConversationSelectionMenu({ x, y, close, copy, quote }: {
  x: number; y: number; close: () => void; copy: () => void; quote?: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const items: CtxEntry[] = [{ label: t('common.copy'), icon: <Copy size={14} />, testId: 'workbench-selection-copy', onClick: copy }]
  if (quote) items.push({ label: t('cf.quote'), icon: <TextQuote size={14} />, testId: 'workbench-selection-quote', onClick: quote })
  return <ContextMenu x={x} y={y} items={items} keyboard testId="workbench-selection-menu" onClose={close} />
}

export function ConversationSelectionStatus({ status, locale }: { status?: CopyStatus; locale: string }): React.JSX.Element {
  const zh = locale.startsWith('zh')
  return <div className={status ? 'cf-empty wb-chat__notice' : undefined} role="status" aria-atomic="true"
    data-testid="workbench-selection-status" data-status={status}>
    {status === 'copied' ? (zh ? '已复制所选文字。' : 'Selected text copied.') :
      status === 'copy-failed' ? (zh ? '复制失败，浏览器未确认写入剪贴板。' : 'Copy failed. The browser did not confirm a clipboard write.') : null}
  </div>
}

export function useConversationSelection(root: RefObject<HTMLDivElement>, active: boolean, getStamp: () => number | undefined,
  onQuote?: (quote: string) => void) {
  const [feedback] = useState(() => createSelectionCopyFeedback(writeClientText))
  const [status, setStatus] = useState<CopyStatus>()
  const [popup, setPopup] = useState<Popup>()
  const stamp = getStamp()
  const current = (): boolean => active && stamp !== undefined && getStamp() === stamp && root.current?.isConnected === true
  useLayoutEffect(() => {
    setStatus(undefined)
    setPopup(undefined)
    return () => feedback.invalidate()
  }, [active, stamp, feedback])

  useEffect(() => {
    const page = root.current?.ownerDocument?.defaultView
    if (!status || !page) return
    const timer = page.setTimeout(() => setStatus(undefined), status === 'copied' ? 1800 : 6500)
    return () => page.clearTimeout(timer)
  }, [status, stamp, root])

  function open(event: MouseEvent<HTMLDivElement> | KeyboardEvent<HTMLDivElement>, x?: number, y?: number): void {
    if (!current() || !root.current || event.defaultPrevented) return
    const capture = captureConversationSelection(root.current, event.target as Node, root.current.ownerDocument.getSelection())
    if (!capture) return
    feedback.invalidate(); setStatus(undefined) // A new selection supersedes an older receipt.
    event.preventDefault()
    event.stopPropagation()
    if (!x && !y) {
      const box = capture.range.getBoundingClientRect()
      x = box.left
      y = box.bottom
    }
    setPopup({ x: x ?? 0, y: y ?? 0, capture })
  }
  const valid = (capture: ConversationSelection): boolean =>
    current() && !!root.current && ownsConversationSelection(root.current, capture)
  const close = (): void => {
    setPopup(undefined)
    if (popup && valid(popup.capture)) popup.capture.message.focus({ preventScroll: true })
  }
  const menu = active && popup ? <ConversationSelectionMenu x={popup.x} y={popup.y} close={close}
    copy={() => {
      if (valid(popup.capture)) feedback.copy(popup.capture.plain, current, setStatus)
    }}
    quote={onQuote && popup.capture.quote ? () => {
      if (valid(popup.capture)) onQuote(popup.capture.quote)
    } : undefined} /> : null
  return {
    menu, status: active ? status : undefined,
    onContextMenu: (event: MouseEvent<HTMLDivElement>) => open(event, event.clientX, event.clientY),
    onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) open(event)
    }
  }
}
