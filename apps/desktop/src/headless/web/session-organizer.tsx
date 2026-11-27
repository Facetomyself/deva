import { useLayoutEffect, useRef, type ButtonHTMLAttributes } from 'react'

export type Translate = (en: string, zh: string) => string
export type TitleEdit = { draft: string; revision: number | null; issue?: string }

export function SessionButton({ pending, children, disabled, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  pending?: boolean
}) {
  return <button type="button" className="web-secondary" {...props} disabled={disabled || pending} aria-busy={pending || undefined}>
    {pending && <span className="web-spinner" aria-hidden="true" />}{children}
  </button>
}

export function TitleEditor({ edit, title, t, pending, reviewing, disabled, readOnly, saveDisabled, change, review, save, cancel }: {
  edit: TitleEdit
  title: string
  t: Translate
  pending: boolean
  reviewing: boolean
  disabled: boolean
  readOnly: boolean
  saveDisabled: boolean
  change: (draft: string) => void
  review: () => void
  save: () => void
  cancel: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const reviewNeeded = edit.revision === null
  const prevReview = useRef(reviewNeeded)
  useLayoutEffect(() => { input.current?.focus(); input.current?.select() }, [])
  useLayoutEffect(() => {
    if (prevReview.current && !reviewNeeded) input.current?.focus()
    prevReview.current = reviewNeeded
  }, [reviewNeeded])

  return <form className="web-title-editor" onSubmit={(event) => { event.preventDefault(); save() }} onKeyDown={(event) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape' && !pending && !disabled) { event.preventDefault(); cancel() }
  }}>
    <label htmlFor="web-session-title">{t('Session title', '会话标题')}</label>
    <div className="web-title-editor__row">
      <input ref={input} id="web-session-title" data-testid="rename-input" value={edit.draft} readOnly={pending || disabled || readOnly}
        autoComplete="off" aria-describedby={edit.issue && !pending ? 'web-title-help web-title-conflict' : 'web-title-help'}
        onChange={(event) => change(event.target.value)} onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault()
        }} />
      <div className="web-header-actions">
        {reviewNeeded && !pending && <SessionButton pending={reviewing} disabled={disabled || readOnly} onClick={review}>
          {reviewing ? t('Checking…', '正在检查…') : t('Review', '查看最新标题')}
        </SessionButton>}
        <SessionButton type="submit" data-testid="rename-save" pending={pending} disabled={disabled || readOnly || saveDisabled || reviewNeeded}>
          {pending ? t('Saving…', '保存中…') : t('Save', '保存')}
        </SessionButton>
        <SessionButton data-testid="rename-cancel" disabled={pending || disabled} onClick={cancel}>{t('Cancel', '取消')}</SessionButton>
      </div>
    </div>
    <p id="web-title-help" className="web-muted">{t('Leave blank to use the automatic title.', '留空以使用自动标题。')}</p>
    {edit.issue && !pending && <p id="web-title-conflict" className="web-title-issue" role="alert">
      {edit.issue}{' '}{t('Current title:', '当前标题：')} <strong>{title}</strong>
    </p>}
  </form>
}
