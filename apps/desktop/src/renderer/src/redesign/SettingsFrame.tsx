import type { ReactNode } from 'react'
import { useI18n } from '../i18n/i18n'

export function SettingsFrame({ onClose, navigation, children, closeTestId }: {
  onClose: () => void; navigation: ReactNode; children: ReactNode; closeTestId?: string
}): React.JSX.Element {
  const { t } = useI18n()
  return <div className="cf-modal__backdrop">
    <div className="cf-modal" role="dialog" aria-label={t('cf.settings')}>
      <div className="cf-modal__head">
        <span className="cf-modal__title">{t('cf.settings')}</span>
        <button className="cf-modal__close" title={t('common.close')} aria-label={t('common.close')} data-testid={closeTestId} onClick={onClose}>✕</button>
      </div>
      <div className="cf-modal__body">
        <nav className="cf-nav">{navigation}</nav>
        <div className="cf-pane">{children}</div>
      </div>
    </div>
  </div>
}
