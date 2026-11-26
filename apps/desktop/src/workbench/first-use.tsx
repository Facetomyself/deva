import { Component, useEffect, useMemo, useRef, useState, type ComponentType, type FormEvent, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import '../renderer/src/styles/tokens.css'
import '../renderer/src/styles/app.css'
import './first-use.css'
import { copy, type Issue, type Locale } from './first-use-copy'
import { createTransport, createSettingsBridge, installSettingsHost, HttpFailure, type Bootstrap } from './transport'

type ClaimHandoff = { claim?: string }
type Mode = 'loading' | 'claim' | 'login' | 'settings' | 'failed'

function browserLocale(): Locale {
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

function browserTheme(): void {
  const color = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
  if (color) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color)
}

function applyAppearance(config: Record<string, unknown>): Locale {
  const locale = config.locale === 'zh-CN' || config.locale === 'en' ? config.locale : browserLocale()
  const theme = config.theme === 'light' || config.theme === 'dark'
    ? config.theme : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  document.documentElement.lang = locale
  document.documentElement.dataset.theme = theme
  browserTheme()
  return locale
}

function issueFrom(error: unknown, fallback: Issue): Issue {
  if (error instanceof HttpFailure) {
    if (error.status === 401) return 'expired'
    if (error.status === 409) return 'conflict'
  }
  return fallback
}

class SettingsBoundary extends Component<{ onFailure: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }
  componentDidCatch(): void { this.props.onFailure() }
  render(): ReactNode { return this.state.failed ? null : this.props.children }
}

function FirstUse({ handoff }: { handoff: ClaimHandoff }): React.JSX.Element {
  const transport = useMemo(() => createTransport(), [])
  const bridge = useRef<ReturnType<typeof createSettingsBridge>>()
  const busy = useRef(false)
  const [working, setWorking] = useState(false)
  const [mode, setMode] = useState<Mode>('loading')
  const [locale, setLocale] = useState<Locale>(browserLocale)
  const [issue, setIssue] = useState<Issue>()
  const [logoutFailed, setLogoutFailed] = useState(false)
  const [settings, setSettings] = useState<ComponentType>()
  const [version, setVersion] = useState('')
  const t = copy[locale]
  const reload = (): void => window.location.reload()

  const openSettings = async (bootstrap: Bootstrap): Promise<void> => {
    handoff.claim = undefined
    setLocale(applyAppearance(bootstrap.config))
    setVersion(bootstrap.version)
    setMode('settings')
    const host = createSettingsBridge({
      transport, bootstrap, updateBrowserTheme: browserTheme,
      onFailure: (error) => setIssue(issueFrom(error, 'writeFailure'))
    })
    bridge.current = host
    let release: (() => void) | undefined
    try {
      await host.ready
      setLocale(applyAppearance(host.api.config.getSync()))
      release = installSettingsHost(window, host.api)
      // PR2 has settings routes only. The full shell stays in the separate mountWorkbench entry
      // for a real full-capability host; a session/bootstrap is not evidence of those capabilities.
      const { DesktopSettings } = await import('./desktop-settings')
      setSettings(() => DesktopSettings)
    } catch (error) {
      release?.()
      setIssue(issueFrom(error, 'settingsFailure'))
    }
  }

  useEffect(() => {
    setLocale(applyAppearance({}))
    void transport.inspect().then(async (screen) => {
      if (screen.mode === 'authenticated') {
        await openSettings(screen.bootstrap)
        return
      }
      if (screen.mode === 'login') handoff.claim = undefined
      setMode(screen.mode)
    }).catch(() => {
      setIssue('sessionFailure')
      setMode('failed')
    })
    // This root is mounted once per document; a restored page starts a new session check.
  }, [])

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (busy.current || (mode !== 'claim' && mode !== 'login')) return
    const form = event.currentTarget
    const fields = new FormData(form)
    const password = String(fields.get('password') ?? '')
    const credential = handoff.claim ?? String(fields.get('credential') ?? '')
    form.reset()
    setIssue(undefined)
    busy.current = true
    setWorking(true)
    try {
      const result = mode === 'claim' ? await transport.claim(credential, password) : await transport.login(password)
      await openSettings(result)
    } catch {
      setIssue('authFailure')
    } finally {
      busy.current = false
      setWorking(false)
    }
  }

  async function logout(): Promise<void> {
    if (busy.current || !bridge.current) return
    busy.current = true
    setWorking(true)
    setLogoutFailed(false)
    try {
      await bridge.current.logout()
      reload()
    } catch (error) {
      if (error instanceof HttpFailure && error.status === 401) reload()
      else setLogoutFailed(true)
    } finally {
      busy.current = false
      setWorking(false)
    }
  }

  const Settings = settings
  const settingsLocked = working || issue === 'conflict' || issue === 'writeFailure' || issue === 'settingsFailure'
  return (
    <main className="wb-page">
      <div className="wb-frame">
        <header className="wb-header">
          <h1>Deva Web</h1>
          {mode === 'settings' && issue !== 'expired' && <button className="btn btn--ghost" type="button" disabled={working} onClick={() => void logout()}>{t.logout}</button>}
        </header>
        {mode === 'loading' && <p role="status">{t.loading}</p>}
        {mode === 'settings' && <p className="wb-stage">{t.limited}</p>}
        {issue && (
          <div className="wb-error" role="alert">
            <p>{t[issue]}</p>
            <button className="btn btn--ghost" type="button" onClick={reload}>{t.reload}</button>
          </div>
        )}
        {logoutFailed && <div className="wb-error" role="alert">{t.logoutFailure}</div>}
        {(mode === 'claim' || mode === 'login') && (
          <form className="wb-card wb-auth" onSubmit={(event) => void submit(event)}>
            <h2>{t[mode]}</h2>
            <p>{mode === 'claim' ? t.claimHelp : t.loginHelp}</p>
            {mode === 'claim' && !handoff.claim && (
              <label>{t.credential}<input className="input" name="credential" type="password" autoComplete="off" required /></label>
            )}
            <label>{t.password}<input className="input" name="password" type="password" autoComplete={mode === 'claim' ? 'new-password' : 'current-password'} required /></label>
            <button className="btn btn--primary" type="submit" disabled={working}>{t[mode]}</button>
          </form>
        )}
        {mode === 'settings' && issue !== 'expired' && (
          <section className="wb-card" aria-label={t.settings}>
            {!Settings && !issue && <p role="status">{t.settingsLoading}</p>}
            {Settings && (
              <fieldset className="wb-settings" disabled={settingsLocked}>
                <SettingsBoundary onFailure={() => setIssue('settingsFailure')}><Settings /></SettingsBoundary>
              </fieldset>
            )}
          </section>
        )}
        {version && <footer className="wb-version">Deva {version}</footer>}
      </div>
    </main>
  )
}

export function mountFirstUse(handoff: ClaimHandoff): void {
  const element = document.getElementById('root')
  if (!element) throw new Error('Missing first-use root')
  createRoot(element).render(<FirstUse handoff={handoff} />)
}
