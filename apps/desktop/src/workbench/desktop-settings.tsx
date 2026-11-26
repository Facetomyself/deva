import { DialogProvider } from '../renderer/src/components/DialogProvider'
import { ModelSettings } from '../renderer/src/features/settings/ModelSettings'
import { I18nProvider, useI18n } from '../renderer/src/i18n/i18n'
import { ModelsProvider, useModels } from '../renderer/src/store/models'
import { ThemeProvider } from '../renderer/src/theme/ThemeContext'
import { copy } from './first-use-copy'

function ReadyModelSettings(): React.JSX.Element {
  const { ready } = useModels()
  const { locale } = useI18n()
  return ready ? <ModelSettings webAddressEditor /> : <p role="status">{copy[locale].settingsLoading}</p>
}

/** Uses the desktop settings page and its providers. Loaded only after the narrow host is ready. */
export function DesktopSettings(): React.JSX.Element {
  return (
    <ThemeProvider>
      <I18nProvider>
        <DialogProvider>
          <ModelsProvider browserSettings>
            <ReadyModelSettings />
          </ModelsProvider>
        </DialogProvider>
      </I18nProvider>
    </ThemeProvider>
  )
}
