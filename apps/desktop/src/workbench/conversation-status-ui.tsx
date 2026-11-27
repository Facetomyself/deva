import { useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ReactNode, type RefObject } from 'react'
import type { ChatProjection } from './chat-stream'
import type { ChatSummary } from './chat-transport'
import {
  createConversationReads, eligibleReadRow, emptyReadView, hasDisplayedMessages, matchingReadEntry,
  noReadSubscription, observeReading, sameReadCursor
} from './conversation-status-reads'
import type { ConversationStatusTransport, ReadEntry } from './conversation-status-transport'
import './conversation-status.css'

const getEmptyView = () => emptyReadView

export function useConversationReadMap(api: ConversationStatusTransport | undefined, rows: readonly ChatSummary[],
  sid: string | null, onExpired: () => void) {
  const expired = useRef(onExpired)
  useLayoutEffect(() => { expired.current = onExpired }, [onExpired])
  const reads = useMemo(() => api && createConversationReads(api, () => expired.current()), [api])
  useLayoutEffect(() => () => reads?.close(), [reads])
  useLayoutEffect(() => { reads?.scope(rows, sid) }, [reads, rows, sid])
  const snapshot = reads?.snapshot ?? getEmptyView
  const readView = useSyncExternalStore(reads?.subscribe ?? noReadSubscription, snapshot, snapshot)
  return { reads, readView }
}

export function ReadThreadRow({ id, enabled, entry, children }: { id: string; enabled: boolean; entry?: ReadEntry; children: ReactNode }): React.JSX.Element {
  return enabled ? <div className="wb-read__row" data-session-id={id} data-read-state={entry ? entry.unread ? 'unread' : 'read' : 'unknown'}>{children}</div> : <>{children}</>
}

export function readViewInForeground(doc: Document, scroller: HTMLDivElement | null): boolean {
  if (!scroller?.isConnected || doc.visibilityState !== 'visible' || !doc.hasFocus() ||
    (doc.fullscreenElement && !doc.fullscreenElement.contains(scroller)) ||
    doc.querySelector('[aria-modal="true"], dialog[open]') ||
    scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 64) return false
  const messages = scroller.querySelectorAll<HTMLElement>('.cf-msg[data-role]:not([data-streaming])')
  const newest = messages[messages.length - 1]?.getBoundingClientRect()
  const viewport = scroller.getBoundingClientRect()
  return !!newest && newest.bottom > viewport.top && newest.top < viewport.bottom && newest.width > 0 && viewport.width > 0
}

type ReadDisplay = {
  row?: ChatSummary
  projection?: ChatProjection
  current: () => ChatProjection | undefined
  refresh: () => void
  blocked: boolean
  atBottom: boolean
  hasContent: boolean
  scroller: RefObject<HTMLDivElement>
}

export function DisplayedReadStatus({ reads, readView, locale, ...display }: ReturnType<typeof useConversationReadMap> & ReadDisplay & {
  locale: string
}): React.JSX.Element | null {
  const { row, projection, blocked, atBottom, hasContent } = display
  const entry = matchingReadEntry(readView, row)
  const observation = observeReading(row, projection, !blocked && atBottom && hasContent)
  const displayed = useRef<ReadDisplay>(display)
  useLayoutEffect(() => { displayed.current = display })
  const id = observation?.id
  const updatedAt = observation?.updatedAt
  const cursor = observation?.cursor
  const canObserve = !!reads && !!entry?.unread && readView.phase === 'ready' && !!id && !!cursor
  useLayoutEffect(() => {
    if (!reads || !canObserve || !id || !cursor) return
    let frame: number | undefined
    const afterPaint = (): void => {
      if (frame !== undefined) window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => {
          frame = undefined
          const view = displayed.current
          const live = observeReading(view.row, view.current(), !view.blocked && view.atBottom && view.hasContent &&
            readViewInForeground(document, view.scroller.current))
          if (live && live.id === id && live.updatedAt === updatedAt && sameReadCursor(live.cursor, cursor)) void reads.mark(live)
        })
      })
    }
    afterPaint()
    window.addEventListener('focus', afterPaint)
    document.addEventListener('visibilitychange', afterPaint)
    document.addEventListener('fullscreenchange', afterPaint)
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame)
      window.removeEventListener('focus', afterPaint)
      document.removeEventListener('visibilitychange', afterPaint)
      document.removeEventListener('fullscreenchange', afterPaint)
    }
  }, [reads, canObserve, id, updatedAt, cursor, readView])

  const state = projection?.snapshot?.state
  if (!reads || !eligibleReadRow(row) || !eligibleReadRow(state) || state.id !== row.id || state.active || !hasDisplayedMessages(state)) return null
  const review = readView.review === row.id
  const unavailable = readView.phase === 'unavailable' || (readView.phase === 'ready' && !entry && projection?.status === 'ready' && state.updatedAt === row.updatedAt)
  const phase = review ? 'review' : unavailable ? 'unavailable' : readView.phase !== 'ready' || !entry ? 'loading' : entry.unread ? 'unread' : 'read'
  const zh = locale === 'zh-CN'
  const text = {
    review: zh ? '请刷新并重新确认已读状态。' : 'Refresh and verify the read status.',
    unavailable: zh ? '此对话的已读状态暂不可用。' : 'Read status is unavailable for this conversation.',
    loading: zh ? '正在读取已读状态…' : 'Loading read status…',
    unread: zh ? '未读' : 'Unread',
    read: zh ? '已读' : 'Read'
  }[phase]
  const feedback = review || unavailable
  return <div className={feedback ? 'wb-read__feedback' : 'wb-status__sr-only'} data-testid="workbench-read-status" data-state={phase}>
    <span role="status">{text}</span>
    {feedback && <button className="cf-empty__action" type="button" disabled={blocked || readView.phase === 'reading'} onClick={() => {
      display.refresh()
      reads.retry(row.id)
    }}>{zh ? '重试' : 'Retry'}</button>}
  </div>
}
