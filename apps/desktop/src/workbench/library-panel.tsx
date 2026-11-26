import { useRef, useState, type ReactNode } from 'react'
import { useI18n } from '../renderer/src/i18n/i18n'
import { libraryCopy, libraryIssue, type LibraryIssue } from './library-copy'

export function usePanelTask() {
  const active = useRef(false)
  const [pending, setPending] = useState<'read' | 'write'>()
  const [issue, setIssue] = useState<LibraryIssue>()
  const run = async <T,>(kind: 'read' | 'write', op: () => Promise<T>, apply?: (result: T) => void): Promise<T> => {
    if (active.current || (kind === 'write' && issue === 'stale')) throw new Error('Panel operation already pending or needs reloading')
    active.current = true
    setPending(kind)
    setIssue(undefined)
    try { const result = await op(); apply?.(result); return result }
    catch (error) { setIssue(libraryIssue(error, kind === 'write')); throw error }
    finally { active.current = false; setPending(undefined) }
  }
  return { pending, issue, run, clear: () => setIssue(undefined), markStale: () => setIssue('stale') }
}

export function taskResult(job: Promise<unknown>): void {
  void job.catch(() => { /* The panel shows the recovery state. */ })
}

export function PanelNotice({ issue, pending, reload, locked }: {
  issue?: LibraryIssue; pending?: 'read' | 'write'; reload: () => void; locked?: boolean
}): React.JSX.Element | null {
  const { locale } = useI18n()
  const c = libraryCopy(locale)
  if (issue) return <div className="wb-library__issue" role="alert" data-testid="workbench-library-issue">
    <span>{c[issue]}</span>
    {['readFailure', 'stale', 'unavailable'].includes(issue) && !locked && <button className="cf-btn" type="button" onClick={reload}>{c.reload}</button>}
  </div>
  return pending ? <p className="wb-library__status" role="status">{pending === 'read' ? c.loading : c.busy}</p> : null
}

export function LibraryDialog({ title, testId, children, onClose, busy }: {
  title: string; testId: string; children: ReactNode; onClose: () => void; busy?: boolean
}): React.JSX.Element {
  const { t } = useI18n()
  return <div className="cf-modal__backdrop" onClick={() => { if (!busy) onClose() }}>
    <div className="cf-modal is-editor wb-library__modal" role="dialog" aria-modal="true" aria-label={title}
      data-testid={testId} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy && !event.defaultPrevented) { event.stopPropagation(); onClose() }
      }}>
      <div className="cf-modal__head">
        <span className="cf-modal__title">{title}</span>
        <button className="cf-modal__close" type="button" aria-label={t('cf.close')}
          data-testid={`${testId}-close`} disabled={busy} onClick={onClose}>✕</button>
      </div>
      {children}
    </div>
  </div>
}