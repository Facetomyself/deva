import { useId, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { useI18n } from '../renderer/src/i18n/i18n'
import { sameTerminalTarget, type TerminalView, type TerminalViewState } from './terminal-view-controller'
import { TERMINAL_COMPACT_SIZE, TERMINAL_DEFAULT_SIZE, type TerminalKey, type TerminalTarget } from './terminal-view-transport'
import './terminal-view.css'

const copy = {
  'zh-CN': {
    open: '打开 TTY 查看器', title: 'TTY 只读文本查看器', screen: 'TTY 文本屏幕', close: '关闭查看器',
    snapshot: '磁盘快照', revision: '版本', loading: '正在打开查看器…', active: '只读文本查看器已连接。',
    pending: '正在等待查看器确认…', reconnecting: '正在重新连接到此查看器…',
    keys: '在查看器内使用方向键、Page Up、Page Down、Home、End 或 Q。', resize: '调整为',
    viewport: '视口', firstColumn: '起始列',
    rowRange: (first: number, last: number, total: number) => `第 ${first === last ? first : `${first}–${last}`} 行，共 ${total} 行`,
    navigate: '查看器导航', moreNavigation: '更多导航', exitTitle: '查看器已退出', code: '退出码', signal: '信号',
    navigation: { up: '上移', down: '下移', left: '左移', right: '右移', 'page-up': '上一页', 'page-down': '下一页', home: '开头', end: '末尾', quit: '退出查看器' },
    reasons: { quit: '手动退出', disposed: '已关闭', fault: '查看器故障', 'worker-lost': '查看进程连接丢失' },
    issues: {
      auth: '所有者会话已过期。', unavailable: 'TTY 查看器或此磁盘快照当前不可用。', unconfigured: '此部署尚未配置 TTY 查看器。',
      stale: '磁盘文件已更改或工作区已更换。请重新读取文件后再打开查看器。',
      limit: '此文件超过 TTY 查看上限。请选择至多 64 KiB 且至多 4,096 行的文本文件。',
      unsupported: '此磁盘快照为二进制或采用其他不受支持的格式。请选择 UTF-8 纯文本文件。',
      sourceDenied: '此文件受工作区查看限制。请选择工作区内获准查看的文件。',
      disconnected: '查看器连接已断开。请关闭查看器后手动重新打开。',
      uncertain: '操作结果未获确认。请关闭查看器后手动重新打开。', failure: '读取查看器失败。请关闭查看器后手动重新打开。'
    }
  },
  en: {
    open: 'Open TTY viewer', title: 'TTY read-only text viewer', screen: 'TTY text screen', close: 'Close viewer',
    snapshot: 'Disk snapshot', revision: 'Revision', loading: 'Opening the viewer…', active: 'Read-only text viewer connected.',
    pending: 'Waiting for the viewer to confirm…', reconnecting: 'Reconnecting to this viewer…',
    keys: 'In the viewer, use the arrow keys, Page Up, Page Down, Home, End or Q.', resize: 'Resize to',
    viewport: 'Viewport', firstColumn: 'First visible column',
    rowRange: (first: number, last: number, total: number) => first === last ? `Row ${first} of ${total}` : `Rows ${first}–${last} of ${total}`,
    navigate: 'Viewer navigation', moreNavigation: 'More navigation', exitTitle: 'Viewer exited', code: 'Exit code', signal: 'Signal',
    navigation: { up: 'Up', down: 'Down', left: 'Left', right: 'Right', 'page-up': 'Previous page', 'page-down': 'Next page', home: 'Top', end: 'Bottom', quit: 'Quit viewer' },
    reasons: { quit: 'Quit', disposed: 'Closed', fault: 'Viewer fault', 'worker-lost': 'Viewer process disconnected' },
    issues: {
      auth: 'The owner session has expired.', unavailable: 'The TTY viewer or this disk snapshot is unavailable.', unconfigured: 'The TTY viewer is not configured for this deployment.',
      stale: 'The file changed on disk or the workspace was replaced. Reload the file before opening the viewer again.',
      limit: 'This file exceeds the TTY viewer limit. Choose a text file of at most 64 KiB and 4,096 lines.',
      unsupported: 'This disk snapshot is binary or in an unsupported format. Choose a plain UTF-8 text file.',
      sourceDenied: 'Workspace rules restrict access to this file. Choose a file approved for viewing in this workspace.',
      disconnected: 'The viewer disconnected. Close it and reopen it manually.',
      uncertain: 'The action was not confirmed. Close the viewer and reopen it manually.', failure: 'Reading the viewer failed. Close it and reopen it manually.'
    }
  }
}
type Copy = typeof copy.en
const keyboard = new Map<string, TerminalKey>([
  ['ArrowUp', 'up'], ['ArrowDown', 'down'], ['ArrowLeft', 'left'], ['ArrowRight', 'right'], ['PageUp', 'page-up'],
  ['PageDown', 'page-down'], ['Home', 'home'], ['End', 'end'], ['q', 'quit'], ['Q', 'quit']
])
const moreControls = [
  ['up', 'workbench-tty-up'], ['down', 'workbench-tty-down'], ['left', 'workbench-tty-left'], ['right', 'workbench-tty-right'],
  ['home', 'workbench-tty-home'], ['end', 'workbench-tty-end']
] as const
const closedView = { phase: 'closed' } as const
const emptyView = () => closedView
const emptySubscribe = () => () => {}

export function TerminalViewer({ api, target, children }: { api?: TerminalView; target?: TerminalTarget; children: ReactNode }): React.JSX.Element {
  const view = useSyncExternalStore(api?.subscribe ?? emptySubscribe, api?.snapshot ?? emptyView, api?.snapshot ?? emptyView)
  const c = copy[useI18n().locale === 'zh-CN' ? 'zh-CN' : 'en']
  const launch = useRef<HTMLButtonElement>(null)
  const restoreLaunchFocus = useRef(false)
  const id = useId()
  const opened = !!api && !!target && view.phase !== 'closed' && sameTerminalTarget(view.target, target)
  useLayoutEffect(() => {
    if (!opened && restoreLaunchFocus.current) {
      restoreLaunchFocus.current = false
      launch.current?.focus()
    }
  }, [opened])
  function close(): void { restoreLaunchFocus.current = true; api?.dismiss() }
  return <>
    {api && target && <div className="wb-tty" data-workspace-tty="">
      {opened ? <ViewerPanel {...{ api, id, view, c, close }} /> :
        <button type="button" className="cf-btn" ref={launch} data-testid="workbench-tty-open"
          onClick={(event) => { if (event.nativeEvent.isTrusted) void api.open(target) }}>{c.open}</button>}
    </div>}
    {/* Keep the closed editor in one reconciliation slot as clean/dirty eligibility changes. */}
    {!opened && children}
  </>
}

function ViewerPanel({ api, id, view, c, close }: {
  api: TerminalView; id: string; view: Exclude<TerminalViewState, { phase: 'closed' }>; c: Copy; close: () => void
}): React.JSX.Element {
  const closeButton = useRef<HTMLButtonElement>(null)
  const screenElement = useRef<HTMLPreElement>(null)
  const hadScreen = useRef(false)
  const { phase, screen, target, exit, issue, requestedSize } = view
  useLayoutEffect(() => { closeButton.current?.focus() }, [])
  useLayoutEffect(() => {
    const close = closeButton.current
    const el = screenElement.current
    if (!el) {
      if (close && close.ownerDocument.activeElement === close.ownerDocument.body) close.focus()
      return
    }
    if (!hadScreen.current) {
      hadScreen.current = true
      if (el.ownerDocument.activeElement === close) el.focus()
    }
  }, [screen])
  const active = phase === 'active'
  const size = requestedSize?.cols === TERMINAL_COMPACT_SIZE.cols && requestedSize.rows === TERMINAL_COMPACT_SIZE.rows ?
    TERMINAL_DEFAULT_SIZE : TERMINAL_COMPACT_SIZE
  const message = issue ? c.issues[issue] : exit ? `${c.exitTitle} · ${c.reasons[exit.reason]} · ${c.code}: ${exit.code} · ${c.signal}: ${exit.signal}` :
    phase === 'loading' || phase === 'active' || phase === 'pending' || phase === 'reconnecting' ? c[phase] : undefined
  const tabIndex = screen && phase !== 'exited' ? undefined : -1
  const keyButton = (key: TerminalKey, testId: string): React.JSX.Element =>
    <button key={key} type="button" className="cf-btn" data-testid={testId} aria-disabled={!active} tabIndex={tabIndex}
      onClick={(event) => { if (active && event.nativeEvent.isTrusted) void api.key(key) }}>{c.navigation[key]}</button>
  return <section className="wb-tty__panel" id={id} aria-labelledby={`${id}-title`} data-testid="workbench-tty-panel" onKeyDown={(event) => {
    if (event.defaultPrevented || !event.nativeEvent.isTrusted || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
    const key = keyboard.get(event.key)
    if (!key) return
    event.preventDefault()
    event.stopPropagation()
    if (active && !event.repeat) void api.key(key)
  }}>
    <header className="wb-tty__header">
      <h3 id={`${id}-title`}>{c.title}</h3>
      <button type="button" className="cf-btn" ref={closeButton} data-testid="workbench-tty-close" onClick={close}>{c.close}</button>
    </header>
    <p className="wb-tty__detail">{c.snapshot}: <bdi>{target.path}</bdi> · <span aria-hidden="true">{c.revision}: </span>
      <code role="group" title={target.revision} aria-label={`${c.revision}: ${target.revision}`}>
        <span aria-hidden="true">{target.revision.slice(0, 14)}…</span>
      </code></p>
    <p className="wb-tty__detail" role={issue ? 'alert' : 'status'} data-testid="workbench-tty-status" data-status={phase} data-issue={issue}
      data-code={exit ? String(exit.code) : undefined} data-signal={exit ? String(exit.signal) : undefined} data-reason={exit?.reason}>{message}</p>
    <div className="wb-tty__controls" role="group" aria-label={c.navigate}>
      {keyButton('page-up', 'workbench-tty-previous')}
      {keyButton('page-down', 'workbench-tty-next')}
      <button type="button" className="cf-btn" data-testid="workbench-tty-size" aria-disabled={!active} tabIndex={tabIndex}
        onClick={(event) => { if (active && event.nativeEvent.isTrusted) void api.resize(size) }}>{c.resize} {size.cols} × {size.rows}</button>
      {keyButton('quit', 'workbench-tty-quit')}
    </div>
    {screen && <>
      <pre ref={screenElement} className="wb-tty__screen" tabIndex={0} role="region" aria-label={c.screen} aria-describedby={`${id}-receipt ${id}-keys`} dir="ltr"
        data-testid="workbench-tty-screen" data-cols={screen.cols} data-rows={screen.rows} data-top={screen.top} data-left={screen.left}
        data-total-lines={screen.totalLines}>{screen.lines.join('\n')}</pre>
      <p id={`${id}-receipt`} className="wb-tty__detail wb-tty__receipt" data-testid="workbench-tty-receipt">
        {c.viewport} {screen.cols} × {screen.rows} · {c.rowRange(screen.top + 1, screen.top + screen.lines.length, screen.totalLines)} · {c.firstColumn}: {screen.left + 1}
      </p>
    </>}
    <p id={`${id}-keys`} className="wb-tty__detail">{c.keys}</p>
    <details className="wb-tty__more">
      <summary>{c.moreNavigation}</summary>
      <div className="wb-tty__controls">{moreControls.map(([key, testId]) => keyButton(key, testId))}</div>
    </details>
  </section>
}
