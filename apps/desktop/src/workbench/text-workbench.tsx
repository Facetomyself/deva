import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { FolderPlus, Paperclip, Plus, Search } from 'lucide-react'
import { useI18n } from '../renderer/src/i18n/i18n'
import { findActive, useModels } from '../renderer/src/store/models'
import { ChatSurface, ConversationHeader, ConversationScroller, ConversationSurface } from '../renderer/src/redesign/ChatSurface'
import { IconRail, ThreadRow } from '../renderer/src/redesign/Rail'
import { TextConversationMessage } from '../renderer/src/redesign/ConvMessage'
import { ComposerDraftInput, ComposerJump, ComposerSendButton } from '../renderer/src/redesign/ComposerControls'
import { useComposerEditor } from '../renderer/src/redesign/composer-editor'
import { modelGroups, ModelSelectButton } from '../renderer/src/redesign/ModelMenu'
import { clampComposer, clampSidebar, COMPOSER_DEFAULT, ICONRAIL_W, ResizeHandle, SIDEBAR_DEFAULT, useViewport } from '../renderer/src/redesign/resizable'
import { chatCopy, turnLabel, type ChatCopy } from './chat-copy'
import { createChatTransport, inputBytes, MAX_TEXT_INPUT, type ChatState } from './chat-transport'
import type { Bootstrap, Transport } from './transport'
import { useTextWorkbench } from './use-text-workbench'
import './text-workbench.css'

type TextWorkbenchProps = {
  transport: Transport; bootstrap: Bootstrap; beforeWrite: () => Promise<void>; onExpired: () => void
  locked: boolean; notice: ReactNode; renderSettings: (close: () => void) => ReactNode
}
type Workspace = ReturnType<typeof useTextWorkbench>
const EMPTY: NonNullable<ChatState['messages']> = []
const PAGE = 80

export default function TextWorkbench({ transport, bootstrap, beforeWrite, onExpired, locked, notice, renderSettings }: TextWorkbenchProps): React.JSX.Element {
  const { t, locale } = useI18n()
  const c = chatCopy(locale)
  const api = useMemo(() => createChatTransport(transport, bootstrap.csrf), [transport, bootstrap.csrf])
  const wk = useTextWorkbench(api, beforeWrite, onExpired)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [compact, setCompact] = useState(() => window.innerWidth < 780)
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT)
  const [query, setQuery] = useState('')
  const viewport = useViewport()
  const sidebar = clampSidebar(sidebarWidth, viewport.w)
  const [modelChoice, setModelChoice] = useState<Record<string, string>>({})
  const [recent, setRecent] = useState<string | null>(null)
  const state = wk.projection?.snapshot?.state
  const selectedEntry = wk.sessions.find((s) => s.id === wk.selected)
  const shown = useMemo(() => [...wk.sessions].sort((a, b) => b.updatedAt - a.updatedAt)
    .filter((s) => (s.title || t('chat.untitled')).toLowerCase().includes(query.trim().toLowerCase())), [wk.sessions, query, t])
  const assistantAppearance = { id: 'general', name: t('cf.assistant'), desc: '', avatar: '' }
  useEffect(() => {
    const preventFileDrop = (e: DragEvent): void => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault() }
    window.addEventListener('dragover', preventFileDrop)
    window.addEventListener('drop', preventFileDrop)
    return () => {
      window.removeEventListener('dragover', preventFileDrop)
      window.removeEventListener('drop', preventFileDrop)
    }
  }, [])
  const start = (): void => { setQuery(''); void wk.create() }
  const openSettings = (): void => setSettingsOpen(true)
  return <ChatSurface className="wb-chat" data-testid="workbench-chat">
    <div className="cf-body" style={{ '--cf-side': `${compact ? 0 : sidebar}px` } as React.CSSProperties}>
      {!compact && <ResizeHandle axis="x" value={sidebar} title={t('cf.resizeSidebar')}
        style={{ left: `calc(${ICONRAIL_W}px + ${sidebar}px)` }} onChange={setSidebarWidth}
        onCommit={() => setSidebarWidth((w) => clampSidebar(w, window.innerWidth))} onReset={() => setSidebarWidth(SIDEBAR_DEFAULT)} />}
      <IconRail tab="chats" onTab={() => setCompact((value) => !value)} listCollapsed={compact}
        onOpenSettings={openSettings} chatAlert={false} unavailable={c.unavailable} />
      <aside className={`cf-rail${compact ? ' is-collapsed' : ''}`} aria-hidden={compact || undefined}>
        {!compact && <>
          <div className="cf-rail__top">
            <div className="cf-search">
              <Search className="cf-search__icon" size={14} />
              <input className="cf-search__input" aria-label={t('cf.searchChats')} placeholder={t('cf.searchChats')}
                value={query} onChange={(event) => setQuery(event.target.value)} />
            </div>
            <button className="cf-rail__addbtn" type="button" data-testid="workbench-new-chat" title={t('cf.newChat')}
              aria-label={t('cf.newChat')} disabled={wk.createPending || locked} onClick={start}><Plus size={16} /></button>
          </div>
          <div className="cf-list">
            {wk.listIssue && <p className="cf-empty" role="alert">{c[wk.listIssue]}{' '}
              {wk.listIssue === 'listFailure' && <button className="cf-empty__action" type="button" onClick={() => void wk.refreshList()}>{c.reloadList}</button>}
            </p>}
            {shown.length ? shown.map((s) => <ThreadRow key={s.id} session={s} active={s.id === wk.selected}
              appearance={assistantAppearance} memberFaces={[]} membersWorking={[]} browserPages={0} tasks={[]}
              subtitle={s.compatibility === 'legacy_text' ? c.readOnly : s.compatibility === 'unsupported' ? c.unavailable : (s.model ?? t('cf.assistant'))}
              state={s.id === wk.selected && state?.active ? { streaming: true, unread: false, attention: false } : undefined}
              onClick={() => { wk.select(s.id); if (viewport.w < 780) setCompact(true) }} />)
              : !wk.listLoading && !wk.listIssue && <div className="cf-empty">{query ? t('cf.searchNoResults') : t('chat.noSessions')}</div>}
          </div>
        </>}
      </aside>
      <ConversationSurface>
        <ConversationHeader>
          <span className="cf-idbtn__name wb-chat__title">{state?.title || selectedEntry?.title || (wk.selected ? t('chat.untitled') : t('cf.tabChats'))}</span>
          <span className="cf-conv__tag wb-chat__scope" title={c.scope}>{c.scope}</span>
        </ConversationHeader>
        {notice}
        {wk.selected ? <TextThread key={wk.selected} sid={wk.selected} wk={wk} c={c} locked={locked}
          preferred={modelChoice[wk.selected] ?? state?.model ?? recent}
          onPick={(id) => { const sid = wk.selected; if (sid) setModelChoice((choices) => ({ ...choices, [sid]: id })); setRecent(id) }} openSettings={openSettings} />
          : <div className="wb-chat__empty cf-empty">
            {wk.listLoading ? <span role="status">{c.loading}</span> : <>
              <span>{wk.listIssue ? c[wk.listIssue] : c.empty}</span>
              {wk.listIssue === 'listFailure'
                ? <button className="btn btn--ghost" type="button" onClick={() => void wk.refreshList()}>{c.reloadList}</button>
                : <button className="btn btn--primary" type="button" data-testid={compact ? 'workbench-new-chat' : undefined}
                  disabled={wk.createPending || locked} onClick={start}>{t('cf.newChat')}</button>}
            </>}
          </div>}
      </ConversationSurface>
    </div>
    {settingsOpen && renderSettings(() => setSettingsOpen(false))}
  </ChatSurface>
}

function TextThread({ sid, wk, c, locked, preferred, onPick, openSettings }: {
  sid: string; wk: Workspace; c: ChatCopy; locked: boolean; preferred: string | null; onPick: (id: string) => void; openSettings: () => void
}): React.JSX.Element {
  const state = wk.projection?.snapshot?.state
  const link = wk.projection?.status ?? 'loading'
  const active = state?.active
  const last = state?.lastTurn
  const messages = state?.messages ?? EMPTY
  const [windowSize, setWindowSize] = useState(PAGE)
  const scroll = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const anchor = useRef<number>()
  const jump = (): void => {
    const el = scroll.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    following.current = true
    setAtBottom(true)
  }
  useLayoutEffect(() => {
    if (anchor.current !== undefined && scroll.current) {
      scroll.current.scrollTop = scroll.current.scrollHeight - anchor.current
      anchor.current = undefined
    } else if (following.current) jump()
  }, [messages, active, windowSize])
  const older = (): void => {
    const el = scroll.current
    if (el) anchor.current = el.scrollHeight - el.scrollTop
    following.current = false
    setWindowSize((n) => n + PAGE)
  }
  const start = Math.max(0, messages.length - windowSize)
  const writeBanner = state?.compatibility === 'unsupported' ? c.unsupported : state?.compatibility === 'legacy_text' ? c.readOnly
    : state?.writeBlockReason === 'session_turn_limit' ? c.limit : state && !state.writable ? c.locked : undefined
  return <>
    <div className="cf-convmid">
      <ConversationScroller scrollRef={scroll} onScroll={(event) => {
        const el = event.currentTarget
        following.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 64
        setAtBottom(following.current)
      }}>
        {start > 0 && <button className="btn btn--ghost wb-chat__older" type="button" onClick={older}>{c.previous}</button>}
        {writeBanner && <p className="cf-empty wb-chat__notice" role="status">{writeBanner}</p>}
        {link === 'missing' && <p className="cf-empty wb-chat__notice" role="alert">{c.missing}</p>}
        {!messages.length && !writeBanner && link === 'ready' && <div className="cf-empty">{c.empty}</div>}
        {messages.slice(start).map((m, index) => <TextConversationMessage key={start + index} role={m.role} text={m.content} />)}
        {active?.text && <TextConversationMessage key={active.turnId} role="assistant" text={active.text} streaming />}
        {link !== 'ready' && link !== 'missing' && <p className="cf-empty wb-chat__notice" role="status">{c[link === 'reconnecting' ? 'reconnecting' : 'loading']}</p>}
        {active && <p className="cf-empty wb-chat__notice" role="status">{active.text ? c.running : c.reading}</p>}
        {last && !active && last.status !== 'running' && <p className="cf-empty wb-chat__notice" role="status"
          data-testid="workbench-turn-status" data-status={last.status}>{turnLabel(c, last)}</p>}
        {wk.pending === 'send' && !active && <p className="cf-empty wb-chat__notice" role="status">{c.sent}</p>}
        {wk.turnIssue && <p className="cf-empty wb-chat__notice" role="alert">{c[wk.turnIssue]}</p>}
      </ConversationScroller>
    </div>
    {(state?.writable || active) && <TextComposer sid={sid} model={(preferred ?? '')} onPick={onPick} openSettings={openSettings}
      draft={wk.drafts} writeLocked={locked || link !== 'ready' || !state?.writable || !!wk.pending}
      stopping={link !== 'ready' || !!wk.pending} active={active} send={wk.send} stop={wk.stop} c={c}
      jump={!atBottom ? jump : undefined} />}
    {state?.turnLimit && state.writable && <p className="wb-chat__limits">{c.limits.replace('{turns}', String(state.turnLimit))}</p>}
  </>
}

function TextComposer({ sid, draft, model, onPick, openSettings, writeLocked, stopping, active, send, stop, c, jump }: {
  sid: string; draft: Map<string, string>; model: string; onPick: (id: string) => void; openSettings: () => void
  writeLocked: boolean; stopping: boolean; active: ChatState['active'] | undefined; send: Workspace['send']; stop: Workspace['stop']; c: ChatCopy; jump?: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const { ready, providers, activeModelId } = useModels()
  const viewport = useViewport()
  const [height, setHeight] = useState(COMPOSER_DEFAULT)
  const [text, setText] = useState(() => draft.get(sid) ?? '')
  const [open, setOpen] = useState(false)
  const groups = modelGroups(providers)
  const picked = findActive(groups.map((g) => ({ ...g.p, models: g.models })), model || activeModelId)
  const over = inputBytes(text) > MAX_TEXT_INPUT
  const mounted = useRef(false)
  const submit = (): void => {
    if (writeLocked || active || !ready || !picked) return
    const sent = editor.getText().trim()
    if (!sent || inputBytes(sent) > MAX_TEXT_INPUT) return
    void send(sid, sent, `${picked.provider.id}:${picked.model.id}`).then((ok) => {
      if (ok && mounted.current && editor.getText().trim() === sent) {
        editor.setText('')
        editor.clearHistory()
      }
    })
  }
  const editor = useComposerEditor({
    onChange: (value) => { setText(value); if (value) draft.set(sid, value); else draft.delete(sid) },
    mentionNames: [],
    onKey: (key, e) => {
      if (key !== 'enter' || e.shiftKey || e.ctrlKey || e.altKey) return false
      e.preventDefault()
      submit()
      return true
    }
  })
  useLayoutEffect(() => {
    mounted.current = true
    editor.setText(draft.get(sid) ?? '')
    return () => { mounted.current = false }
  }, [sid])
  useEffect(() => {
    if (!open) return
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [open])
  return <div className="cf-composer">
    {jump && <ComposerJump onJump={jump} />}
    <div className="cf-composer__inner">
      {!picked && <div className="wb-chat__model">{c.selectModel}{' '}
        <button className="cf-empty__action" type="button" onClick={openSettings}>{t('settings.models')}</button>
      </div>}
      {over && <p className="wb-chat__model" role="alert">{c.inputLimit}</p>}
      <div className="cf-box">
        <ResizeHandle axis="y" className="cf-resizer--box" value={clampComposer(height, viewport.h)} title={t('cf.resizeComposer')}
          onChange={(value) => setHeight(clampComposer(value, viewport.h))} onCommit={() => setHeight((v) => clampComposer(v, viewport.h))}
          onReset={() => setHeight(COMPOSER_DEFAULT)} />
        <ComposerDraftInput editor={editor} height={clampComposer(height, viewport.h)} placeholder={c.input} />
        <div className="cf-box__bar">
          <button className="cf-iconbtn" type="button" title={c.unavailable} aria-label={t('cf.attach')} disabled><Paperclip size={16} /></button>
          <button className="cf-wschip" type="button" title={c.unavailable} aria-label={t('cf.mountWorkspace')} disabled><FolderPlus size={15} />{t('cf.mountWorkspace')}</button>
          <div className="cf-mp">
            {open && <div className="model-pick__backdrop" onClick={() => setOpen(false)} />}
            <div className="model-pick"><ModelSelectButton active={picked} groups={groups} open={open}
              onToggle={() => setOpen((value) => !value)} onPick={(pid, mid) => { onPick(`${pid}:${mid}`); setOpen(false) }} /></div>
          </div>
          {active ? <ComposerSendButton stop disabled={stopping} onClick={() => void stop(sid, active.turnId)} />
            : <ComposerSendButton disabled={writeLocked || !ready || !picked || !text.trim() || over} onClick={submit} />}
        </div>
      </div>
    </div>
  </div>
}
