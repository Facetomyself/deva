import { ChevronDown, Square } from 'lucide-react'
import type { ComposerEditor } from './composer-editor'
import { useI18n } from '../i18n/i18n'

export function ComposerJump({ onJump }: { onJump: () => void }): React.JSX.Element {
  const { t } = useI18n()
  const label = t('chat.jumpToLatest')
  return <button className="cf-jump" type="button" onClick={onJump} title={label} aria-label={label}><ChevronDown size={18} /></button>
}

export function ComposerDraftInput({ editor, height, placeholder, onFocus, onBlur }: {
  editor: ComposerEditor; height: number; placeholder: string; onFocus?: () => void; onBlur?: () => void
}): React.JSX.Element {
  return <div className="cf-draft" style={{ height }}>
    <div ref={editor.rootRef} className="cf-draft__input" contentEditable role="textbox" aria-multiline aria-label={placeholder}
      onFocus={onFocus} onBlur={onBlur} />
    {editor.empty && <div className="cf-draft__ph">{placeholder}</div>}
  </div>
}

export function ComposerSendButton({ stop, disabled, title, onClick }: {
  stop?: boolean; disabled?: boolean; title?: string; onClick: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const label = stop ? t('chat.stop') : t('cf.send')
  return <button className={`cf-send${stop ? ' is-stop' : ''}`} type="button" aria-label={stop ? label : undefined}
    title={title ?? (stop ? label : undefined)} disabled={disabled} onClick={onClick}>
    {stop ? <Square size={14} fill="currentColor" /> : label}
  </button>
}
