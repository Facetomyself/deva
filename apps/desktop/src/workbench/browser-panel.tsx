import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Globe, Hand, Lock, TriangleAlert, X } from 'lucide-react'
import { useI18n } from '../renderer/src/i18n/i18n'
import { siteOf } from '../renderer/src/features/browser/text'
import type { BrowserView, ManualBrowserPanel } from './browser-manual'
import { FRAME_HEIGHT, FRAME_WIDTH, MAX_BROWSER_TEXT, isBrowserKey, isBrowserText, pointsOnFrame, wheelPixels } from './browser-transport'
import '../renderer/src/features/browser/chrome.css'
import './browser-panel.css'

const copy = {
  zh: {
    scope: '仅限人工操作。模型没有浏览器权限，页面、画面与输入也与对话分开。完成接管只会结束本次人工控制。',
    site: '已配置站点', select: '选择站点', open: '打开站点', claim: '开始人工接管', reclaim: '重新接管',
    dismiss: '关闭浏览器面板', done: '完成接管', retry: '重新检查', frame: '浏览器画面',
    hint: '在画面上点击、滚动，或使用方向键、Tab、回车等按键；文字请从下方手动发送。窗口失焦时会结束本次控制。',
    text: '发送到当前页的文本', send: '发送文本', invalid: '文本须为 1–1024 字符，且只包含可输入字符。',
    status: {
      checking: '正在检查浏览器服务…', ready: '浏览器已就绪。请选择站点。', open: '页面已打开。开始人工接管后显示画面。',
      leased: '页面已有一项人工接管。可以显式请求接管，正在使用的租约保持排他。', returned: '人工接管已结束。可以重新接管同一页面。',
      opening: '正在打开站点…', claiming: '正在开始人工接管…', controlling: '人工接管中', finishing: '正在结束人工接管…', closing: '正在关闭页面…',
      unconfigured: '浏览器服务尚未配置。', 'egress-unavailable': '浏览器隔离网络出口未就绪。',
      'binary-missing': '浏览器服务找不到 Chromium 程序。', 'sandbox-startup-failure': 'Chromium 沙箱启动失败。当前系统内核或沙箱配置未满足启动条件。',
      'worker-unavailable': '浏览器服务当前未响应。', 'request-failed': '页面操作未获确认。重新检查后再操作。',
      'claim-failed': '接管未获确认。现有接管可能仍有效，请稍后重试。', 'frame-failed': '画面读取失败，人工接管已结束。',
      'input-unconfirmed': '操作未获确认，已清空待发送操作。重新接管后请先核对页面。',
      'finish-unconfirmed': '结束未获确认。本地画面和输入已清除，远端租约会到期。',
      paused: '窗口已失焦，本次控制已结束。可以重新接管同一页面。', expired: '本次接管已到期。',
      done: '人工接管已完成。可以重新接管同一页面。', skipped: '已跳过本次人工接管。可以重新接管同一页面。',
      'queue-full': '输入队列已满。本次操作未发送。'
    }
  },
  en: {
    scope: 'Manual operation only. The model has no browser access; pages, frames and input stay separate from the conversation. Finishing only ends your manual control.',
    site: 'Configured site', select: 'Choose a site', open: 'Open site', claim: 'Start manual control', reclaim: 'Take control again',
    dismiss: 'Dismiss browser panel', done: 'Finish manual control', retry: 'Check again', frame: 'Browser frame',
    hint: 'Click or scroll the frame, or use keys such as arrows, Tab and Enter. Send text explicitly below. Switching away from this window ends control.',
    text: 'Text to send to the current page', send: 'Send text', invalid: 'Enter 1–1024 printable characters.',
    status: {
      checking: 'Checking the browser service…', ready: 'The browser is ready. Choose a site.', open: 'The page is open. Start manual control to see it.',
      leased: 'The page already has a manual session. An active lease remains exclusive when you request control.', returned: 'Manual control ended. You can take control of the same page again.',
      opening: 'Opening the site…', claiming: 'Starting manual control…', controlling: 'Manual control active', finishing: 'Ending manual control…', closing: 'Closing the page…',
      unconfigured: 'The browser service is not configured.', 'egress-unavailable': 'The isolated browser network egress is unavailable.',
      'binary-missing': 'The browser service could not find the Chromium binary.', 'sandbox-startup-failure': 'The Chromium sandbox failed to start. Check the system kernel and sandbox configuration.',
      'worker-unavailable': 'The browser service is unavailable.', 'request-failed': 'The page action was not confirmed. Check the service again before continuing.',
      'claim-failed': 'Control was not confirmed. An existing lease may still be active; try again later.', 'frame-failed': 'The frame could not be read. Manual control has ended.',
      'input-unconfirmed': 'The action was not confirmed and queued actions were cleared. Check the page after taking control again.',
      'finish-unconfirmed': 'Release was not confirmed. Local frames and input were cleared; the remote lease will expire.',
      paused: 'The window lost focus and control ended. You can take control of the same page again.', expired: 'This manual lease expired.',
      done: 'Manual control completed. You can take control of the same page again.', skipped: 'This manual session was skipped. You can take control of the same page again.',
      'queue-full': 'The input queue is full. This action was not sent.'
    }
  }
}
type Labels = typeof copy.en

function statusOf(view: BrowserView): keyof Labels['status'] {
  if (view.phase !== 'idle' && view.phase !== 'controlling') return view.phase
  if (view.worker && view.worker !== 'ready') return view.worker
  return view.notice ?? (view.phase === 'controlling' ? 'controlling' : view.tab?.state ?? 'ready')
}

function visibleWindow(): boolean { return document.visibilityState === 'visible' && document.hasFocus() }

export function ManualBrowserDialog({ api, dismiss }: { api: ManualBrowserPanel; dismiss: () => void }): React.JSX.Element {
  const { t, locale } = useI18n()
  const labels = copy[locale === 'zh-CN' ? 'zh' : 'en']
  const title = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const view = useSyncExternalStore(api.subscribe, api.snapshot)
  const [siteId, selectSite] = useState('')
  const selected = view.sites.find((site) => site.id === siteId)
  const controlling = view.phase === 'controlling'
  const idle = view.phase === 'idle' && view.worker === 'ready'
  const status = statusOf(view)
  const site = view.tab && siteOf(view.tab.origin)
  const SiteIcon = site?.secure ? Lock : TriangleAlert

  useLayoutEffect(() => {
    const element = dialog.current!
    element.showModal()
    void api.load()
    const suspendHidden = (): void => { if (document.visibilityState !== 'visible') api.suspend() }
    window.addEventListener('blur', api.suspend)
    window.addEventListener('pagehide', api.suspend)
    document.addEventListener('visibilitychange', suspendHidden)
    return () => {
      window.removeEventListener('blur', api.suspend)
      window.removeEventListener('pagehide', api.suspend)
      document.removeEventListener('visibilitychange', suspendHidden)
      api.dispose()
      if (element.open) element.close()
    }
  }, [api])

  return <dialog ref={dialog} className="wb-browser" aria-labelledby={title} data-testid="workbench-browser-dialog"
    onCancel={(event) => { event.preventDefault(); dismiss() }}>
    <div className="bc">
      <div className="bc-tabs">
        <h2 id={title}><Globe size={16} />{t('browser.title')}</h2>
        {view.tab && <>
          <span className="bc-tabs__sep" />
          <div className="bc-tabs__list"><div className="bc-tab is-on" data-testid="workbench-browser-tab">
            <span className={`bc-tab__ava${controlling ? ' is-wait' : ''}`}><Globe size={12} /></span>
            <span className="bc-tab__title">{view.tab.label}</span>
            <button type="button" className="bc-tab__x" data-testid="workbench-browser-close" aria-label={t('browser.closeTab')}
              disabled={!idle && !controlling} onClick={() => void api.close()}><X size={14} /></button>
          </div></div>
        </>}
        <div className="bc-tabs__acts">
          <button type="button" className="bc-ib" data-testid="workbench-browser-dismiss" aria-label={labels.dismiss} onClick={dismiss}><X size={18} /></button>
        </div>
      </div>
      <p className="wb-browser__scope">{labels.scope}</p>
      <div className="wb-browser__toolbar">
        <label>{labels.site}
          <select className="input" data-testid="workbench-browser-site" value={selected?.id ?? ''} disabled={!idle || !!view.tab || !view.sites.length}
            onChange={(event) => selectSite(event.currentTarget.value)}>
            <option value="">{labels.select}</option>
            {view.sites.map(({ id, label, origin }) => <option key={id} value={id}>{label} — {origin}</option>)}
          </select>
        </label>
        <button type="button" className="bc-btn" data-testid="workbench-browser-open-site"
          disabled={!idle || !!view.tab || !selected} onClick={() => { if (selected) void api.open(selected.id) }}>{labels.open}</button>
        <button type="button" className="bc-btn is-primary" data-testid="workbench-browser-claim" disabled={!idle || !view.tab}
          onClick={() => { if (visibleWindow()) void api.claim() }}>{view.tab && view.tab.state !== 'open' ? labels.reclaim : labels.claim}</button>
        <button type="button" className="bc-btn" data-testid="workbench-browser-skip" disabled={!controlling} onClick={() => api.finish('skip')}>{t('browser.skip')}</button>
        <button type="button" className="bc-btn" data-testid="workbench-browser-complete" disabled={!controlling} onClick={() => api.finish('done')}>{labels.done}</button>
      </div>
      <div className="bc-strip wb-browser__status" role="status" data-testid="workbench-browser-status" data-status={status}>
        {controlling && <Hand size={15} className="bc-strip__icon" />}
        <span>{labels.status[status]}</span>
        {site && <span className={`bc-site${site.secure ? '' : ' is-insecure'}`}><SiteIcon size={12} />{view.tab?.origin}</span>}
        {view.phase === 'idle' && (view.worker !== 'ready' || view.notice === 'request-failed' || view.notice === 'finish-unconfirmed') &&
          <button type="button" className="bc-btn" data-testid="workbench-browser-recheck" onClick={() => void api.load()}>{labels.retry}</button>}
      </div>
      <BrowserViewport api={api} frame={view.frame} controlling={controlling} labels={labels} />
    </div>
  </dialog>
}

function imageReady(img: HTMLImageElement): boolean { return img.complete && img.naturalWidth === FRAME_WIDTH && img.naturalHeight === FRAME_HEIGHT }

function BrowserViewport({ api, frame, controlling, labels }: { api: ManualBrowserPanel; frame?: string; controlling: boolean; labels: Labels }): React.JSX.Element {
  const image = useRef<HTMLImageElement>(null)
  const text = useRef<HTMLInputElement>(null)
  const [invalidText, setInvalidText] = useState(false)
  const hasFrame = !!frame
  useLayoutEffect(() => {
    if (controlling) return
    if (text.current) text.current.value = ''
    setInvalidText(false)
  }, [controlling])
  useEffect(() => {
    const img = image.current
    if (!img || !hasFrame) return
    const scroll = (event: WheelEvent): void => {
      if (!event.isTrusted || event.ctrlKey || !visibleWindow() || !imageReady(img)) return
      const point = pointsOnFrame(img.getBoundingClientRect(), event.clientX, event.clientY)
      if (!point) return
      event.preventDefault()
      api.input({ type: 'scroll', ...point, deltaX: wheelPixels(event.deltaX, event.deltaMode, FRAME_WIDTH),
        deltaY: wheelPixels(event.deltaY, event.deltaMode, FRAME_HEIGHT) })
    }
    img.addEventListener('wheel', scroll, { passive: false })
    return () => img.removeEventListener('wheel', scroll)
  }, [api, hasFrame])

  function sendText(): void {
    const field = text.current
    if (!field || !image.current || !imageReady(image.current) || !visibleWindow()) return
    if (!isBrowserText(field.value)) { setInvalidText(true); return }
    if (api.input({ type: 'text', text: field.value })) {
      field.value = ''
      setInvalidText(false)
    }
  }

  return <>
    {controlling && <p className="wb-browser__scope">{labels.hint}</p>}
    {frame && <div className="bc-frame is-handoff wb-browser__frame">
      <img ref={image} src={frame} data-testid="workbench-browser-frame" alt={labels.frame} draggable={false}
        width={FRAME_WIDTH} height={FRAME_HEIGHT} tabIndex={0} onError={() => api.frameFailed(frame)}
        onContextMenu={(event) => event.preventDefault()}
        onClick={(event) => {
          if (!event.nativeEvent.isTrusted || event.button !== 0 || !event.detail || !visibleWindow() || !imageReady(event.currentTarget)) return
          const point = pointsOnFrame(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY)
          if (point) api.input({ type: 'click', ...point })
        }}
        onKeyDown={(event) => {
          if (!event.nativeEvent.isTrusted || event.nativeEvent.isComposing || event.repeat || event.ctrlKey || event.altKey || event.metaKey ||
              event.shiftKey || !isBrowserKey(event.key) || !visibleWindow() || !imageReady(event.currentTarget)) return
          event.preventDefault()
          event.stopPropagation()
          api.input({ type: 'key', key: event.key })
        }} />
    </div>}
    <div className="wb-browser__toolbar wb-browser__text">
      <label>{labels.text}
        <input ref={text} className="input" data-testid="workbench-browser-text" type="password" maxLength={MAX_BROWSER_TEXT}
          autoComplete="off" spellCheck={false} aria-invalid={invalidText || undefined} disabled={!controlling || !hasFrame}
          onChange={() => { if (invalidText) setInvalidText(false) }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isTrusted && event.key === 'Enter' && !event.nativeEvent.isComposing && !event.repeat) {
              event.preventDefault()
              sendText()
            }
          }} />
      </label>
      <button type="button" className="bc-btn" data-testid="workbench-browser-send-text" disabled={!controlling || !hasFrame}
        onClick={(event) => { if (event.nativeEvent.isTrusted) sendText() }}>{labels.send}</button>
      {invalidText && <span role="alert">{labels.invalid}</span>}
    </div>
  </>
}
