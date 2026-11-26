import { useId, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type RefObject } from 'react'
import { Maximize, Minimize } from 'lucide-react'
import { useI18n } from '../renderer/src/i18n/i18n'
import {
  createClientFullscreen, getClientChatShortcut, subscribeChatSidebarShortcut,
  type ClientChatShortcut, type ClientFullscreenView
} from './client-shell'
import './client-shell.css'

type FullscreenControl = {
  view: ClientFullscreenView
  toggle: ReturnType<typeof createClientFullscreen>['toggle']
}

/** Web mount only; the caller owns the authenticated chat scope and sidebar state. */
export function useClientShell({ shortcutScope, shortcutActive, onToggleSidebar }: {
  shortcutScope: RefObject<HTMLElement>
  shortcutActive: boolean
  onToggleSidebar: () => void
}): { fullscreen: FullscreenControl; chatShortcut?: ClientChatShortcut } {
  const doc = typeof document === 'undefined' ? undefined : document
  const controller = useMemo(() => createClientFullscreen(doc), [doc])
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const shortcut = useMemo(() => getClientChatShortcut(doc?.defaultView?.navigator), [doc])
  const toggleSidebar = useRef(onToggleSidebar)
  useLayoutEffect(() => { toggleSidebar.current = onToggleSidebar }, [onToggleSidebar])
  useLayoutEffect(() => {
    if (!doc || !shortcutActive) return
    return subscribeChatSidebarShortcut(doc, { getScope: () => shortcutScope.current, shortcut, onToggleSidebar: () => toggleSidebar.current() })
  }, [doc, shortcutActive, shortcutScope, shortcut])
  return { fullscreen: { view, toggle: controller.toggle }, chatShortcut: shortcutActive ? shortcut : undefined }
}

const copy = {
  en: {
    label: 'Page fullscreen', enter: 'Enter page fullscreen', exit: 'Exit page fullscreen', locked: 'Page fullscreen is disabled while locked',
    windowed: 'Page fullscreen is off', fullscreen: 'Page fullscreen is on', foreign: 'Another element is in fullscreen',
    unavailable: 'Page fullscreen is unavailable in this browser', denied: 'The browser denied page fullscreen',
    requestDenied: 'The browser denied page fullscreen. Reload this page to try again.',
    exitDenied: 'Page fullscreen is on. The browser denied the last exit attempt.'
  },
  'zh-CN': {
    label: '页面全屏', enter: '进入页面全屏', exit: '退出页面全屏', locked: '锁定期间已停用页面全屏',
    windowed: '页面全屏已关闭', fullscreen: '页面全屏已开启', foreign: '其他元素正在全屏显示',
    unavailable: '当前浏览器未启用页面全屏功能', denied: '浏览器已阻止页面全屏操作',
    requestDenied: '浏览器已阻止页面全屏操作。刷新此页后可重试。',
    exitDenied: '页面仍处于全屏状态。浏览器阻止了上一次退出操作。'
  }
}

export function ClientFullscreenButton({ fullscreen, locked }: { fullscreen: FullscreenControl; locked: boolean }): React.JSX.Element {
  const { locale } = useI18n()
  const strings = copy[locale]
  const statusId = useId()
  const { state, pressed, busy, issue } = fullscreen.view
  const usable = state === 'windowed' || state === 'fullscreen'
  const disabled = locked || busy || !usable
  const stateText = issue === 'request-denied' ? strings.requestDenied : issue === 'exit-denied' ? strings.exitDenied : strings[state]
  const status = locked && usable ? `${stateText.replace(/[.。]$/, '')}${locale === 'zh-CN' ? '。' : '. '}${strings.locked}` : stateText
  const title = !usable || busy ? stateText : locked ? strings.locked : pressed ? strings.exit : strings.enter
  return <div className="wb-client-fullscreen__control" title={disabled ? title : undefined}>
    <button type="button" className="cf-navbtn wb-client-fullscreen" data-testid="workbench-client-fullscreen"
      data-state={state} data-locked={locked || undefined} disabled={disabled}
      aria-pressed={pressed} aria-busy={busy || undefined} aria-label={strings.label} aria-describedby={statusId}
      title={title} onClick={(event) => void fullscreen.toggle(event.nativeEvent, locked)}>
      {pressed ? <Minimize size={20} aria-hidden="true" /> : <Maximize size={20} aria-hidden="true" />}
    </button>
    <span id={statusId} className="wb-client-fullscreen__status" role="status" data-testid="workbench-client-fullscreen-status"
      data-state={state}>{status}</span>
  </div>
}
