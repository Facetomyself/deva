import { useEffect, useId, useState } from 'react'
import { useI18n } from '../../i18n/i18n'

/** On Web a settings patch is a network write and may rebind a credential. Only commit a
 * completed address on blur/Enter; typing a partial URL must never mutate persisted state. */
function completeEndpoint(address: string): boolean {
  try { return !address.includes('\\') && /^https?:\/\/[^/@?#\s]+(?:\/[^?#\s]*)?$/i.test(address) && Boolean(new URL(address).hostname) }
  catch { return false }
}

export function ProviderUrlInput({ value, onCommit, onReady }: { value: string; onCommit(value: string): void; onReady(ready: boolean): void }) {
  const { locale, t } = useI18n()
  const [draft, setDraft] = useState(value)
  const [invalid, setInvalid] = useState(false)
  const note = useId()
  useEffect(() => { setDraft(value); setInvalid(false); onReady(completeEndpoint(value)) }, [value, onReady])
  const commit = () => {
    const raw = draft.trim()
    if (raw && !completeEndpoint(raw)) { setInvalid(true); onReady(false); return }
    const next = raw.replace(/\/+$/, '')
    setDraft(next); setInvalid(false); onReady(completeEndpoint(next))
    if (next !== value) onCommit(next)
  }
  return <>
    <input className="input" type="text" aria-label={t('models.apiHost')} aria-invalid={invalid || undefined}
      aria-describedby={invalid ? note : undefined} spellCheck={false} value={draft}
      onChange={e => { setDraft(e.target.value); setInvalid(false); onReady(false) }} onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.blur() }
        if (e.key === 'Escape') { setDraft(value); setInvalid(false); onReady(completeEndpoint(value)) }
      }} />
    {invalid && <span id={note} className="field__warn" role="status">{locale === 'en'
      ? 'Enter an HTTP(S) endpoint without credentials, a query or a fragment.'
      : '请输入完整的 HTTP(S) 服务地址；凭据、查询参数和片段不属于服务地址。'}</span>}
  </>
}
