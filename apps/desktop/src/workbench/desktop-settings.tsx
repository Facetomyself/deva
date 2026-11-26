import { lazy, Suspense, type ReactNode } from 'react'
import { Brain } from 'lucide-react'
import { DialogProvider } from '../renderer/src/components/DialogProvider'
import { ModelSettings } from '../renderer/src/features/settings/ModelSettings'
import { I18nProvider, useI18n } from '../renderer/src/i18n/i18n'
import { ModelsProvider, useModels } from '../renderer/src/store/models'
import { ThemeProvider } from '../renderer/src/theme/ThemeContext'
import { SettingsFrame } from '../renderer/src/redesign/SettingsFrame'
import { copy } from './first-use-copy'
import type { Bootstrap, Transport } from './transport'

const TextWorkbench = lazy(() => import('./text-workbench'))

export interface DesktopSettingsProps {
  chat?: {
    transport: Transport; bootstrap: Bootstrap; beforeWrite: () => Promise<void>; onExpired: () => void
    locked: boolean; notice: ReactNode; logout: () => void; working: boolean; logoutFailed: boolean
  }
}

function ReadyModelSettings(): React.JSX.Element {
  const { ready } = useModels()
  const { locale } = useI18n()
  return ready ? <ModelSettings webAddressEditor /> : <p role="status">{copy[locale].settingsLoading}</p>
}

function WorkbenchSettingsDialog({ chat, close }: { chat: NonNullable<DesktopSettingsProps['chat']>; close: () => void }): React.JSX.Element {
  const { t, locale } = useI18n()
  const labels = copy[locale]
  return <SettingsFrame onClose={close} closeTestId="workbench-settings-close" navigation={
    <>
      <span className="cf-nav__item is-active" aria-current="page"><span className="cf-nav__icon"><Brain size={15} /></span>{t('settings.models')}</span>
      <button className="btn btn--ghost wb-chat__logout" type="button" disabled={chat.working} onClick={chat.logout}>{labels.logout}</button>
    </>
  }>
    {chat.notice}
    {chat.logoutFailed && <p role="alert">{labels.logoutFailure}</p>}
    <fieldset className="wb-settings" disabled={chat.locked}>
      <ReadyModelSettings />
    </fieldset>
    <p className="wb-version">Deva {chat.bootstrap.version}</p>
  </SettingsFrame>
}

function Workbench({ chat }: { chat: NonNullable<DesktopSettingsProps['chat']> }): React.JSX.Element {
  const { locale } = useI18n()
  return <Suspense fallback={<main className="wb-page"><p role="status">{copy[locale].loading}</p></main>}>
    <TextWorkbench transport={chat.transport} bootstrap={chat.bootstrap} beforeWrite={chat.beforeWrite} onExpired={chat.onExpired}
      locked={chat.locked} notice={chat.notice} renderSettings={(close) => <WorkbenchSettingsDialog chat={chat} close={close} />} />
  </Suspense>
}

/** Reuse the same desktop settings provider tree, with or without authenticated text chat. */
export function DesktopSettings({ chat }: DesktopSettingsProps): React.JSX.Element {
  return (
    <ThemeProvider>
      <I18nProvider>
        <DialogProvider>
          <ModelsProvider browserSettings>
            {chat ? <Workbench chat={chat} /> : <ReadyModelSettings />}
          </ModelsProvider>
        </DialogProvider>
      </I18nProvider>
    </ThemeProvider>
  )
}
