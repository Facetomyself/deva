import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Plus, Search } from 'lucide-react'
import { useI18n } from '../renderer/src/i18n/i18n'
import { findActive, useModels } from '../renderer/src/store/models'
import { ChatSurface, ConversationHeader, ConversationScroller, ConversationSurface } from '../renderer/src/redesign/ChatSurface'
import { Avatar } from '../renderer/src/redesign/shell-common'
import { IconRail, ThreadRow } from '../renderer/src/redesign/Rail'
import { TextConversationMessage } from '../renderer/src/redesign/ConvMessage'
import { ComposerDraftInput, ComposerJump, ComposerSendButton, ComposerWorkspaceButton } from '../renderer/src/redesign/ComposerControls'
import { useComposerEditor } from '../renderer/src/redesign/composer-editor'
import { modelGroups, ModelSelectButton } from '../renderer/src/redesign/ModelMenu'
import { clampComposer, clampSidebar, COMPOSER_DEFAULT, ICONRAIL_W, ResizeHandle, SIDEBAR_DEFAULT, useViewport } from '../renderer/src/redesign/resizable'
import { browserFiles, readyAttachmentIds, type AttachmentDraft, type BrowserFiles } from './attachment-drafts'
import { attachmentCard, AttachmentDraftCards, AttachmentHint, AttachmentIssues, AttachmentPicker, useAttachmentDrafts } from './attachment-ui'
import { chatCopy, turnLabel, type ChatCopy } from './chat-copy'
import { createChatTransport, inputBytes, MAX_TEXT_INPUT, type ChatState } from './chat-transport'
import { createLibrary, type Roster } from './library-transport'
import { LibraryWorkspace, type LibraryPanel } from './library-workspace'
import type { Bootstrap, LibraryQueue, Transport } from './transport'
import { useTextWorkbench } from './use-text-workbench'
import { WorkspaceFilesPanel } from './workspace-dialog'
import { createWorkspaceFiles } from './workspace-files'
import { createWorkspaceTransport } from './workspace-transport'
import './text-workbench.css'

type TextWorkbenchProps = {
  transport: Transport; bootstrap: Bootstrap; beforeWrite: () => Promise<void>; onExpired: () => void
  libraryQueue: LibraryQueue; locked: boolean; notice: ReactNode; renderSettings: (close: () => void) => ReactNode
}
type Workspace = ReturnType<typeof useTextWorkbench>
const EMPTY: NonNullable<ChatState['messages']> = []
const PAGE = 80
const WORKSPACE_OPEN = 'workbench-workspace-open'

export default function TextWorkbench({ transport, bootstrap, beforeWrite, onExpired, libraryQueue, locked, notice, renderSettings }: TextWorkbenchProps): React.JSX.Element {
  const { t, locale } = useI18n()
  const c = chatCopy(locale)
  const api = useMemo(() => createChatTransport(transport, bootstrap.csrf), [transport, bootstrap.csrf])
  const wk = useTextWorkbench(api, beforeWrite, onExpired, bootstrap.capabilities?.attachments === true)
  const supported = bootstrap.capabilities?.library === true
  const library = useMemo(() => supported ? createLibrary(transport, libraryQueue) : undefined, [supported, transport, libraryQueue])
  const [panel, setPanel] = useState<LibraryPanel>()
  const [roster, setRoster] = useState<Roster>()
  useEffect(() => {
    if (!library) return
    let alive = true
    void library.roster().then((data) => { if (alive) setRoster((prev) => prev ?? data) }).catch(() => { /* Open the roster for recovery. */ })
    return () => { alive = false }
  }, [library])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [compact, setCompact] = useState(() => window.innerWidth < 780)
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT)
  const [query, setQuery] = useState('')
  const viewport = useViewport()
  const sidebar = clampSidebar(sidebarWidth, viewport.w)
  const [modelChoice, setModelChoice] = useState<Record<string, string>>({})
  const [recent, setRecent] = useState<string | null>(null)
  const state = wk.projection?.snapshot?.state
  const filesEnabled = bootstrap.capabilities?.workspaceFiles === true
  const files = useMemo(() => filesEnabled ? createWorkspaceFiles(createWorkspaceTransport(transport, bootstrap.csrf)) : undefined,
    [filesEnabled, transport, bootstrap.csrf])
  const [filesOpen, setFilesOpen] = useState(false)
  const workspaceLabel = locale === 'zh-CN' ? '工作区文件' : 'Workspace files'
  const openFiles = files ? () => { setFilesOpen(true); void files.loadProjects() } : undefined
  const selectedEntry = wk.sessions.find((s) => s.id === wk.selected)
  const shown = useMemo(() => [...wk.sessions].sort((a, b) => b.updatedAt - a.updatedAt)
    .filter((s) => (s.title || t('chat.untitled')).toLowerCase().includes(query.trim().toLowerCase())), [wk.sessions, query, t])
  const roleMap = useMemo(() => new Map(roster?.roles.map((role) => [role.id, role])), [roster])
  const appearance = (id?: string) => {
    const role = id ? roleMap.get(id) : undefined
    return { id: id ?? 'general', name: role?.name ?? id ?? t('cf.assistant'), desc: role?.description ?? '', avatar: role?.avatar ?? '' }
  }
  const personaId = state?.personaId ?? selectedEntry?.personaId
  const scope = wk.attachments ? (locale === 'zh-CN' ? '文本对话与手动上传附件' : 'Text chat with manual attachment uploads') : library ? c.libraryScope : c.scope
  const sid = wk.selected
  const dropFiles = wk.attachments && sid ? (event: React.DragEvent<HTMLElement>): void => {
    if (!event.dataTransfer.types.includes('Files') || !event.currentTarget.contains(event.target as Node)) return
    event.preventDefault()
    event.stopPropagation()
    wk.addAttachments(sid, browserFiles(event.dataTransfer), locked)
  } : undefined
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
  const surface = <ChatSurface className="wb-chat" data-testid="workbench-chat">
    <div className="cf-body" style={{ '--cf-side': `${compact ? 0 : sidebar}px` } as React.CSSProperties}>
      {!compact && <ResizeHandle axis="x" value={sidebar} title={t('cf.resizeSidebar')}
        style={{ left: `calc(${ICONRAIL_W}px + ${sidebar}px)` }} onChange={setSidebarWidth}
        onCommit={() => setSidebarWidth((w) => clampSidebar(w, window.innerWidth))} onReset={() => setSidebarWidth(SIDEBAR_DEFAULT)} />}
      <IconRail tab="chats" onTab={() => setCompact((value) => !value)} listCollapsed={compact}
        onOpenSettings={openSettings} chatAlert={false} unavailable={c.unavailable}
        library={library ? { openProfile: () => setPanel('profile'), openRoster: () => setPanel('roster') } : undefined} />
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
              appearance={appearance(s.personaId)} memberFaces={[]} membersWorking={[]} browserPages={0} tasks={[]}
              subtitle={s.compatibility === 'legacy_text' ? c.readOnly : s.compatibility === 'unsupported' ? c.unavailable : (s.personaId ? appearance(s.personaId).name : s.model ?? t('cf.assistant'))}
              state={s.id === wk.selected && state?.active ? { streaming: true, unread: false, attention: false } : undefined}
              onClick={() => { wk.select(s.id); if (viewport.w < 780) setCompact(true) }} />)
              : !wk.listLoading && !wk.listIssue && <div className="cf-empty">{query ? t('cf.searchNoResults') : t('chat.noSessions')}</div>}
          </div>
        </>}
      </aside>
      <ConversationSurface data-testid={dropFiles ? 'workbench-attachment-drop' : undefined} onDrop={dropFiles}
        onDragOver={dropFiles ? (event) => {
          if (!event.dataTransfer.types.includes('Files') || !event.currentTarget.contains(event.target as Node)) return
          event.preventDefault()
          event.dataTransfer.dropEffect = !locked && wk.projection?.status === 'ready' && state?.writable && !state.active && !wk.pending ? 'copy' : 'none'
        } : undefined}>
        <ConversationHeader>
          <span className="cf-idbtn__name wb-chat__title">{state?.title || selectedEntry?.title || (wk.selected ? t('chat.untitled') : t('cf.tabChats'))}</span>
          {personaId && <span className="wb-chat__persona" data-testid="workbench-chat-persona"><Avatar persona={appearance(personaId)} size={22} plain />{appearance(personaId).name}</span>}
          {openFiles && !(wk.selected && (state?.writable || state?.active)) &&
            <ComposerWorkspaceButton label={workspaceLabel} onClick={openFiles} testId={WORKSPACE_OPEN} />}
          <span className="cf-conv__tag wb-chat__scope" title={scope}>{scope}</span>
        </ConversationHeader>
        {notice}
        {wk.selected ? <TextThread key={wk.selected} sid={wk.selected} wk={wk} c={c} locked={locked}
          preferred={modelChoice[wk.selected] ?? state?.model ?? selectedEntry?.model ?? (personaId ? null : recent)}
          onPick={(id) => { const sid = wk.selected; if (sid) setModelChoice((choices) => ({ ...choices, [sid]: id })); setRecent(id) }}
          openSettings={openSettings} openFiles={openFiles} workspaceLabel={workspaceLabel} />
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
    {files && <WorkspaceFilesPanel open={filesOpen} close={() => setFilesOpen(false)} controller={files} />}
  </ChatSurface>
  return library ? <LibraryWorkspace api={library} panel={panel} locked={locked} notice={notice} onRoster={setRoster}
    close={() => setPanel(undefined)} openProjects={() => setPanel('projects')} createChat={async (role) => {
      const created = await wk.create(role.id)
      if (created) setQuery('')
      return created
    }}>{surface}</LibraryWorkspace> : surface
}

function TextThread({ sid, wk, c, locked, preferred, onPick, openSettings, openFiles, workspaceLabel }: {
  sid: string; wk: Workspace; c: ChatCopy; locked: boolean; preferred: string | null; onPick: (id: string) => void; openSettings: () => void
  openFiles?: () => void; workspaceLabel: string
}): React.JSX.Element {
  const state = wk.projection?.snapshot?.state
  const link = wk.projection?.status ?? 'loading'
  const active = state?.active
  const last = state?.lastTurn
  const messages = state?.messages ?? EMPTY
  const uploads = wk.attachments
  const attachmentDraft = useAttachmentDrafts(uploads, sid)
  const add = uploads ? (files: BrowserFiles) => wk.addAttachments(sid, files, locked) : undefined
  const remove = uploads && !locked && !wk.pending ? (key: string) => void uploads.remove(sid, key) : undefined
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
  }, [messages, active, windowSize, attachmentDraft])
  const older = (): void => {
    const el = scroll.current
    if (el) anchor.current = el.scrollHeight - el.scrollTop
    following.current = false
    setWindowSize((n) => n + PAGE)
  }
  const start = Math.max(0, messages.length - windowSize)
  const visibleMessages = useMemo(() => messages.slice(start).map((message) => ({ message,
    cards: uploads ? message.attachments?.map((entry) => attachmentCard(sid, entry)) : undefined
  })), [messages, start, uploads, sid])
  const writeBanner = state?.compatibility === 'unsupported' ? c.unsupported : state?.compatibility === 'legacy_text' ? c.readOnly
    : state?.writeBlockReason === 'role_unavailable' ? c.roleUnavailable
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
        {visibleMessages.map(({ message, cards }, index) => <TextConversationMessage key={start + index} role={message.role}
          text={message.content} attachments={cards} />)}
        {active?.text && <TextConversationMessage key={active.turnId} role="assistant" text={active.text} streaming />}
        {link !== 'ready' && link !== 'missing' && <p className="cf-empty wb-chat__notice" role="status">{c[link === 'reconnecting' ? 'reconnecting' : 'loading']}</p>}
        {active && <p className="cf-empty wb-chat__notice" role="status">{active.text ? c.running : c.reading}</p>}
        {last && !active && last.status !== 'running' && <p className="cf-empty wb-chat__notice" role="status"
          data-testid="workbench-turn-status" data-status={last.status}>{turnLabel(c, last)}</p>}
        {wk.pending === 'send' && !active && <p className="cf-empty wb-chat__notice" role="status">{c.sent}</p>}
        {wk.turnIssue && <p className="cf-empty wb-chat__notice" role="alert">{c[wk.turnIssue]}</p>}
      </ConversationScroller>
    </div>
    {uploads && <AttachmentIssues draft={attachmentDraft} dismiss={() => uploads.dismiss(sid)} />}
    {(state?.writable || active) && <TextComposer sid={sid} model={(preferred ?? '')} onPick={onPick} openSettings={openSettings}
      draft={wk.drafts} writeLocked={locked || link !== 'ready' || !state?.writable || !!wk.pending}
      stopping={link !== 'ready' || !!wk.pending} active={active} send={wk.send} stop={wk.stop} c={c}
      jump={!atBottom ? jump : undefined} openFiles={openFiles} workspaceLabel={workspaceLabel}
      attachmentDraft={attachmentDraft} add={add} remove={remove} />}
    {state?.turnLimit && state.writable && <p className="wb-chat__limits">{c.limits.replace('{turns}', String(state.turnLimit))}</p>}
  </>
}

function TextComposer({ sid, draft, model, onPick, openSettings, writeLocked, stopping, active, send, stop, c, jump, openFiles, workspaceLabel,
  attachmentDraft, add, remove }: {
  sid: string; draft: Map<string, string>; model: string; onPick: (id: string) => void; openSettings: () => void
  writeLocked: boolean; stopping: boolean; active: ChatState['active'] | undefined; send: Workspace['send']; stop: Workspace['stop']; c: ChatCopy; jump?: () => void
  openFiles?: () => void; workspaceLabel: string; attachmentDraft: AttachmentDraft; add?: (files: BrowserFiles) => void; remove?: (key: string) => void
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
  const ids = readyAttachmentIds(attachmentDraft)
  const mounted = useRef(false)
  const submit = (): void => {
    if (writeLocked || active || !ready || !picked) return
    const sent = editor.getText().trim()
    if (!ids || (!sent && !ids.length) || inputBytes(sent) > MAX_TEXT_INPUT) return
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
    onPaste: add ? (event) => {
      if (!event.clipboardData) return false
      const files = browserFiles(event.clipboardData)
      if (!files.files.length && !files.issues.length) return false
      event.preventDefault()
      add(files)
      return true
    } : undefined,
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
        {add && <AttachmentDraftCards sid={sid} draft={attachmentDraft} remove={remove} />}
        <ComposerDraftInput editor={editor} height={clampComposer(height, viewport.h)} placeholder={c.input} />
        <div className="cf-box__bar">
          {add && <AttachmentPicker add={add} disabled={writeLocked || !!active} />}
          <ComposerWorkspaceButton label={openFiles ? workspaceLabel : t('cf.mountWorkspace')} title={openFiles ? workspaceLabel : c.unavailable}
            onClick={openFiles} testId={openFiles ? WORKSPACE_OPEN : undefined} />
          <div className="cf-mp">
            {open && <div className="model-pick__backdrop" onClick={() => setOpen(false)} />}
            <div className="model-pick"><ModelSelectButton active={picked} groups={groups} open={open}
              onToggle={() => setOpen((value) => !value)} onPick={(pid, mid) => { onPick(`${pid}:${mid}`); setOpen(false) }} /></div>
          </div>
          {active ? <ComposerSendButton stop disabled={stopping} onClick={() => void stop(sid, active.turnId)} />
            : <ComposerSendButton disabled={writeLocked || !ready || !picked || !ids || (!text.trim() && !ids.length) || over} onClick={submit} />}
        </div>
      </div>
      {add && <AttachmentHint />}
    </div>
  </div>
}
