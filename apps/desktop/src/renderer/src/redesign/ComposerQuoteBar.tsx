import { X } from 'lucide-react'
import { useI18n } from '../i18n/i18n'
import { quotePlain } from './ConvMessage'

/** 引用条：在附件之后、正文之前；悬停看全文。 */
export function ComposerQuoteBar({ quote, onRemove, testId, removeTestId }: {
  quote: string
  onRemove: () => void
  testId?: string
  removeTestId?: string
}): React.JSX.Element {
  const { t } = useI18n()
  return (
    <div className="cf-quotebar" data-testid={testId}>
      <span className="cf-quotebar__text" title={quotePlain(quote, true)}>
        {quotePlain(quote)}
      </span>
      <button
        type="button"
        className="cf-quotebar__x"
        data-testid={removeTestId}
        title={t('cf.quoteRemove')}
        aria-label={t('cf.quoteRemove')}
        onClick={onRemove}
      >
        <X size={13} />
      </button>
    </div>
  )
}
