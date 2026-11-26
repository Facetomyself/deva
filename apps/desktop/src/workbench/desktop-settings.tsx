import { lazy, Suspense, useLayoutEffect, useState, type ReactNode } from 'react'
import { Brain, Puzzle } from 'lucide-react'
import { ToastProvider } from '../renderer/src/components/ToastProvider'
import { DialogProvider } from '../renderer/src/components/DialogProvider'
import { ModelSettings } from '../renderer/src/features/settings/ModelSettings'
import { I18nProvider, useI18n } from '../renderer/src/i18n/i18n'
import { ModelsProvider, useModels } from '../renderer/src/store/models'
import { ThemeProvider } from '../renderer/src/theme/ThemeContext'
import { SettingsFrame } from '../renderer/src/redesign/SettingsFrame'
import { copy } from './first-use-copy'
import { ServerPlatformLabel } from './server-platform'
import type { Bootstrap, LibraryQueue, Transport } from './transport'

const TextWorkbench = lazy(() => import('./text-workbench'))
const SkillLibrary = lazy(() => import('./skill-library'))

export interface DesktopSettingsProps {
  chat?: {
    transport: Transport; bootstrap: Bootstrap; beforeWrite: () => Promise<void>; onExpired: () => void
    libraryQueue: LibraryQueue; locked: boolean; notice: ReactNode; logout: () => void; working: boolean; logoutFailed: boolean
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
  const [section, setSection] = useState<'models' | 'skills'>('models')
  const skillLibrary = chat.bootstrap.capabilities?.skillLibrary === true
  const showSkills = skillLibrary && section === 'skills' && !chat.locked
  useLayoutEffect(() => {
    const previous = document.activeElement
    document.querySelector<HTMLButtonElement>('button[data-testid="workbench-settings-close"]')?.focus()
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [])
  useLayoutEffect(() => {
    if (chat.locked || !skillLibrary) setSection('models')
  }, [chat.locked, skillLibrary])
  const modelLabel = <><span className="cf-nav__icon"><Brain size={15} aria-hidden /></span>{t('settings.models')}</>
  return <SettingsFrame onClose={close} closeTestId="workbench-settings-close" navigation={
    <>
      {skillLibrary ? <>
        <button className={`cf-nav__item${showSkills ? '' : ' is-active'}`} aria-current={showSkills ? undefined : 'page'}
          type="button" onClick={() => setSection('models')}>{modelLabel}</button>
        <button className={`cf-nav__item${showSkills ? ' is-active' : ''}`} aria-current={showSkills ? 'page' : undefined}
          type="button" data-testid="workbench-skills-tab" aria-label={`${t('activity.extensions')} · ${t('extensions.skills')}`} disabled={chat.locked}
          onClick={(event) => { if (event.nativeEvent.isTrusted) setSection('skills') }}>
          <span className="cf-nav__icon"><Puzzle size={15} aria-hidden /></span>{t('activity.extensions')}
        </button>
      </> : <span className="cf-nav__item is-active" aria-current="page">{modelLabel}</span>}
      <button className="btn btn--ghost wb-chat__logout" type="button" disabled={chat.working} onClick={chat.logout}>{labels.logout}</button>
    </>
  }>
    {chat.notice}
    {chat.logoutFailed && <p role="alert">{labels.logoutFailure}</p>}
    {showSkills ? <Suspense fallback={<p role="status">{labels.settingsLoading}</p>}>
      <SkillLibrary transport={chat.transport} bootstrap={chat.bootstrap} onExpired={chat.onExpired} />
    </Suspense> : <>
      <fieldset className="wb-settings" disabled={chat.locked}>
        <ReadyModelSettings />
      </fieldset>
      <p className="wb-version">Deva {chat.bootstrap.version} · <ServerPlatformLabel platform={chat.bootstrap.platform} /></p>
    </>}
  </SettingsFrame>
}

function Workbench({ chat }: { chat: NonNullable<DesktopSettingsProps['chat']> }): React.JSX.Element {
  const { locale } = useI18n()
  return <Suspense fallback={<main className="wb-page"><p role="status">{copy[locale].loading}</p></main>}>
    <TextWorkbench transport={chat.transport} bootstrap={chat.bootstrap} beforeWrite={chat.beforeWrite} onExpired={chat.onExpired}
      libraryQueue={chat.libraryQueue} locked={chat.locked} notice={chat.notice} renderSettings={(close) => <WorkbenchSettingsDialog chat={chat} close={close} />} />
  </Suspense>
}

/** Reuse the same desktop settings provider tree, with or without authenticated text chat. */
export function DesktopSettings({ chat }: DesktopSettingsProps): React.JSX.Element {
  return (
    <ThemeProvider>
      <I18nProvider>
        <DialogProvider>
          <ModelsProvider browserSettings>
            {chat ? chat.bootstrap.capabilities?.library ? <ToastProvider><Workbench chat={chat} /></ToastProvider> : <Workbench chat={chat} /> : <ReadyModelSettings />}
          </ModelsProvider>
        </DialogProvider>
      </I18nProvider>
    </ThemeProvider>
  )
}
