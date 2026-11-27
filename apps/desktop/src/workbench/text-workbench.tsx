import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Archive, ArrowLeft, Globe, Plus, Search } from 'lucide-react'
import { useI18n } from '../renderer/src/i18n/i18n'
import { findActive, useModels } from '../renderer/src/store/models'
import { ChatSurface, ConversationHeader, ConversationScroller, ConversationSurface } from '../renderer/src/redesign/ChatSurface'
import { Avatar } from '../renderer/src/redesign/shell-common'
import { IconRail, type RailTab } from '../renderer/src/redesign/IconRail'
import { ThreadRow } from '../renderer/src/redesign/Rail'
import { TextConversationMessage } from '../renderer/src/redesign/ConvMessage'
import { ComposerDraftInput, ComposerJump, ComposerSendButton, ComposerWorkspaceButton } from '../renderer/src/redesign/ComposerControls'
import { ComposerQuoteBar } from '../renderer/src/redesign/ComposerQuoteBar'
import { useComposerEditor } from '../renderer/src/redesign/composer-editor'
import { modelGroups, ModelSelectButton } from '../renderer/src/redesign/ModelMenu'
import { clampComposer, clampSidebar, COMPOSER_DEFAULT, ICONRAIL_W, ResizeHandle, SIDEBAR_DEFAULT, useViewport } from '../renderer/src/redesign/resizable'
import { browserFiles, readyAttachmentIds, type AttachmentDraft, type BrowserFiles } from './attachment-drafts'
import { attachmentCard, AttachmentDraftCards, AttachmentHint, AttachmentIssues, AttachmentPicker, useAttachmentDrafts } from './attachment-ui'
import { createManualBrowserPanel, type ManualBrowserPanel } from './browser-manual'
import { ManualBrowserDialog } from './browser-panel'
import { createBrowserTransport, type BrowserTransport } from './browser-transport'
import { chatCopy, turnLabel, type ChatCopy } from './chat-copy'
import { createChatTransport, type ChatState, type ChatSummary } from './chat-transport'
import { contextTarget, WorkbenchContextMeter } from './conversation-status-context'
import { eligibleReadRow, matchingReadEntry } from './conversation-status-reads'
import { createConversationStatusTransport, type ConversationStatusTransport } from './conversation-status-transport'
import { DisplayedReadStatus, ReadThreadRow, useConversationReadMap } from './conversation-status-ui'
import { ConversationSelectionStatus, useConversationSelection } from './conversation-selection-ui'
import { eligibleDeliveryReplies } from './deliveries-controller'
import { createDeliveriesTransport, type DeliveriesTransport, type DeliveryGroup, type DeliveryLocation } from './deliveries-transport'
import { BrowserDeliveryCard, DeliveryFeedback, DeliveryHistory, ReplyDeliveryActions, useDeliveries } from './deliveries-ui'
import { createWorkspaceGitView } from './git-view-controller'
import { createGitViewTransport } from './git-view-transport'
import { ProjectMemoryDialog } from './library-memory'
import { createLibrary, type Roster } from './library-transport'
import { LibraryWorkspace, type LibraryPanel } from './library-workspace'
import { createProjectDocuments } from './project-document-controller'
import { createProjectDocumentTransport } from './project-document-transport'
import { exceedsDraftLimit } from './quote-draft'
import { createPreferenceTransport, matchesPreferences, projectSession } from './session-preferences'
import { SessionHeaderActions, SessionModelPicker, SessionPreferenceStatus, SessionRenameDialog } from './session-preference-ui'
import { createSessionWorkspaceTransport } from './session-workspace-transport'
import { AttachedWorkspaceLabel, SessionWorkspaceControls, useSessionWorkspace } from './session-workspace-ui'
import { closedTaskSnapshot, createTaskInspection, idleTaskSubscription } from './task-inspection-controller'
import { createTaskInspectionTransport } from './task-inspection-transport'
import { TaskInspectionPanel } from './task-inspection-ui'
import { createTerminalView } from './terminal-view-controller'
import { createTerminalViewTransport } from './terminal-view-transport'
import type { Bootstrap, LibraryQueue, Transport } from './transport'
import { useTextWorkbench } from './use-text-workbench'
import { ClientFullscreenButton, useClientShell } from './client-shell-ui'
import { pasteClientText, writeClientText } from './client-clipboard'
import { ClientPasteFeedback, useClientPasteNotice } from './client-paste-feedback'
import { CodeClipboardProvider } from '../renderer/src/features/chat/CodeClipboard'
import { WorkspaceFilesPanel } from './workspace-dialog'
import { createWorkspaceFiles, openWorkspaceProject } from './workspace-files'
import { createWorkspaceTransport } from './workspace-transport'
import './text-workbench.css'

type TextWorkbenchProps = {
  transport: Transport; bootstrap: Bootstrap; beforeWrite: () => Promise<void>; onExpired: () => void
  libraryQueue: LibraryQueue; locked: boolean; notice: ReactNode; renderSettings: (close: () => void) => ReactNode
}
type Workspace = ReturnType<typeof useTextWorkbench>
const EMPTY: NonNullable<ChatState['messages']> = []
const EMPTY_ROWS: ChatSummary[] = []
const PAGE = 80
const WORKSPACE_OPEN = 'workbench-workspace-open'
const emptyVersion = () => 0
const emptySubscribe = () => () => {}

export default function TextWorkbench({ transport, bootstrap, beforeWrite, onExpired, libraryQueue, locked, notice, renderSettings }: TextWorkbenchProps): React.JSX.Element {
  const { t, locale } = useI18n()
  const c = chatCopy(locale)
  const api = useMemo(() => createChatTransport(transport, bootstrap.csrf), [transport, bootstrap.csrf])
  const preferenceEnabled = bootstrap.capabilities?.sessionPreferences === true
  const preferenceApi = useMemo(() => preferenceEnabled ? createPreferenceTransport(transport, bootstrap.csrf) : undefined,
    [preferenceEnabled, transport, bootstrap.csrf])
  const workspacesEnabled = bootstrap.capabilities?.sessionWorkspaces === true
  const statusApi = useMemo(() => createConversationStatusTransport(transport, bootstrap), [transport, bootstrap])
  const wk = useTextWorkbench(api, beforeWrite, onExpired, bootstrap.capabilities?.attachments === true, preferenceApi, workspacesEnabled, !!statusApi)
  const reads = useConversationReadMap(statusApi, locked ? EMPTY_ROWS : wk.sessions, locked ? null : wk.selected, onExpired)
  const preferences = wk.preferences
  const preferenceVersion = useSyncExternalStore(preferences?.subscribe ?? emptySubscribe, preferences?.version ?? emptyVersion)
  const [archivedView, setArchivedView] = useState(false)
  const [renameSid, setRenameSid] = useState<string>()
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
  const tasksEnabled = bootstrap.capabilities?.taskInspection === true
  const tasks = useMemo(() => tasksEnabled ? createTaskInspection(createTaskInspectionTransport(transport, bootstrap.csrf), {
    expired: onExpired, beforePause: beforeWrite
  }) : undefined, [tasksEnabled, transport, bootstrap.csrf, beforeWrite, onExpired])
  const taskView = useSyncExternalStore(tasks?.subscribe ?? idleTaskSubscription, tasks?.snapshot ?? closedTaskSnapshot)
  const tasksButton = useRef<HTMLButtonElement>(null)
  const tasksPanelId = useId()
  useLayoutEffect(() => {
    if (locked) tasks?.close()
    return () => tasks?.close()
  }, [locked, tasks])
  const tasksVisible = !!tasks && !locked && taskView.open
  const closeTasks = (): void => { tasks?.close(); tasksButton.current?.focus() }
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
  const documents = useMemo(() => files ? createProjectDocuments(files, createProjectDocumentTransport(transport, bootstrap.csrf)) : undefined,
    [files, transport, bootstrap.csrf])
  const documentsEnabled = !locked && bootstrap.capabilities?.workspaceDocumentCreate === true
  const gitEnabled = filesEnabled && bootstrap.capabilities?.gitInspect === true
  const git = useMemo(() => gitEnabled ? createWorkspaceGitView(createGitViewTransport(transport, bootstrap.csrf), onExpired) : undefined,
    [gitEnabled, transport, bootstrap.csrf, onExpired])
  const [filesOpen, setFilesOpen] = useState(false)
  const workspaceLabel = locale === 'zh-CN' ? '工作区文件' : 'Workspace files'
  const sid = wk.selected
  const terminalEnabled = filesEnabled && bootstrap.capabilities?.terminalViewer === true
  const terminal = useMemo(() => terminalEnabled ? createTerminalView(createTerminalViewTransport(transport, bootstrap.csrf), onExpired) : undefined,
    [terminalEnabled, transport, bootstrap.csrf, bootstrap.expiresAt, onExpired, sid])
  const selectedEntry = wk.sessions.find((s) => s.id === sid)
  const workspaceSid = !locked && selectedEntry?.compatibility === 'text' && wk.projection?.status !== 'missing' ? selectedEntry.id : undefined
  const workspaceWritable = !!workspaceSid && wk.projection?.status === 'ready' && state?.compatibility === 'text' && !state.active && !wk.pending
  const workspaceApi = useMemo(() => workspacesEnabled ? createSessionWorkspaceTransport(transport, bootstrap.csrf) : undefined,
    [workspacesEnabled, transport, bootstrap.csrf])
  const { controller: binding, view: bound } = useSessionWorkspace(workspaceApi, workspaceSid, selectedEntry?.workspaceRevision,
    state?.workspaceRevision, workspaceWritable, beforeWrite, onExpired, wk.refreshList)
  const controlledOpen = files && binding && workspaceSid ? () => void binding.open(workspaceSid, 'files', ({ workspace, signal }) =>
    openWorkspaceProject(files, workspace.id, signal)) : undefined
  const manualFilesSid = useRef<string | null>()
  const openFiles = files ? () => {
    tasks?.close()
    if (controlledOpen && bound.confirmed?.workspace?.state === 'available' && !bound.pending && !bound.needsReview) {
      controlledOpen()
      return
    }
    if (workspacesEnabled && manualFilesSid.current !== sid) void files.select('')
    manualFilesSid.current = sid
    setFilesOpen(true)
    void files.loadProjects()
  } : undefined
  const notes = library && binding && workspaceSid ? () => void binding.open(workspaceSid, 'notes') : undefined
  const approvedProject = bound.access
  const deliveryEnabled = bootstrap.capabilities?.deliveries === true
  const deliveryApi = useMemo(() => deliveryEnabled ? createDeliveriesTransport(transport, bootstrap.csrf) : undefined,
    [deliveryEnabled, transport, bootstrap.csrf])
  const [locatedFilesSid, setLocatedFilesSid] = useState<string>()
  useLayoutEffect(() => { setLocatedFilesSid(undefined) }, [sid, locked])
  const openInWorkspace = useCallback(async ({ workspaceId, path }: DeliveryLocation, signal: AbortSignal): Promise<boolean> => {
    if (!sid || !files || signal.aborted || !await files.reveal(workspaceId, path, signal) || signal.aborted) return false
    setLocatedFilesSid(sid)
    return true
  }, [files, sid])
  const preferenceEntry = sid ? preferences?.get(sid) : undefined
  const projectedEntry = selectedEntry ? projectSession(selectedEntry, preferenceEntry?.pending) : undefined
  useEffect(() => {
    if (selectedEntry?.compatibility === 'text' && preferences && !matchesPreferences(selectedEntry, preferences.get(selectedEntry.id).confirmed))
      void preferences.read(selectedEntry.id)
  }, [preferences, selectedEntry])
  const shown = useMemo(() => wk.sessions.map((row) => projectSession(row, preferences?.get(row.id).pending))
    .sort((a, b) => b.updatedAt - a.updatedAt), [wk.sessions, preferences, preferenceVersion])
  const archivedCount = preferences ? shown.filter((row) => row.archived).length : 0
  const visibleRows = shown.filter((row) => (!preferences || !!row.archived === archivedView) &&
    (archivedView || (row.title || t('chat.untitled')).toLowerCase().includes(query.trim().toLowerCase())))
  const compatible = selectedEntry?.compatibility === 'text' && state?.compatibility === 'text'
  const busyPreferences = !!(state?.active || wk.pending)
  const storageLocked = state && !state.writable && state.writeBlockReason !== 'session_turn_limit'
  const preferenceLocked = locked || wk.projection?.status !== 'ready' || !compatible || storageLocked || busyPreferences ||
    preferenceEntry?.issue === 'readOnly' || preferenceEntry?.issue === 'missing'
  const preferenceBlockReason = busyPreferences ? c.busy : selectedEntry?.compatibility === 'unsupported' ? c.unsupported
    : selectedEntry?.compatibility === 'legacy_text' ? c.readOnly : storageLocked ? c.locked : wk.projection?.status !== 'ready' ? c.loading : undefined
  const preferenceControlsDisabled = preferenceLocked || !preferenceEntry?.confirmed || !!(preferenceEntry.reading || preferenceEntry.pending || preferenceEntry.needsRead)
  const confirmedModel = preferenceEntry?.confirmed?.preferences.model
  const archiveSession = (): void => {
    if (!sid || !preferences || preferenceControlsDisabled || !preferenceEntry?.confirmed) return
    void preferences.write(sid, { archived: !projectedEntry?.archived })
  }
  const renameSession = (): void => {
    if (!sid || !preferences || preferenceControlsDisabled) return
    preferences.beginRename(sid)
    setRenameSid(sid)
  }
  const reloadPreferences = (): void => {
    if (sid && preferences) void preferences.read(sid, true).then(() => wk.refreshList())
  }
  const roleMap = useMemo(() => new Map(roster?.roles.map((role) => [role.id, role])), [roster])
  const appearance = (id?: string) => {
    const role = id ? roleMap.get(id) : undefined
    return { id: id ?? 'general', name: role?.name ?? id ?? t('cf.assistant'), desc: role?.description ?? '', avatar: role?.avatar ?? '' }
  }
  const personaId = state?.personaId ?? selectedEntry?.personaId
  const scope = wk.attachments ? (locale === 'zh-CN' ? '文本对话与手动上传附件' : 'Text chat with manual attachment uploads') : library ? c.libraryScope : c.scope
  const browserConfigured = bootstrap.capabilities?.browserPanel === true
  const browser = useMemo(() => browserConfigured ? createBrowserTransport(transport, bootstrap.csrf) : undefined,
    [browserConfigured, transport, bootstrap.csrf])
  const [browserOpen, setBrowserOpen] = useState<{ sid: string; transport: BrowserTransport; panel: ManualBrowserPanel }>()
  const browserVisible = browserOpen && browserOpen.sid === sid && browserOpen.transport === browser && !locked && !settingsOpen
  useEffect(() => { if (browserOpen && !browserVisible) setBrowserOpen(undefined) }, [browserOpen, browserVisible])
  const dropFiles = !tasksVisible && wk.attachments && sid ? (event: React.DragEvent<HTMLElement>): void => {
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
  const start = (): void => { setQuery(''); setArchivedView(false); void wk.create() }
  const openSettings = (): void => { tasks?.close(); setSettingsOpen(true) }
  const taskEntryDisabled = locked || settingsOpen || !!panel || (!!renameSid && renameSid === sid)
  const selectRailTab = (tab: RailTab): void => {
    if (tab === 'chats') {
      if (tasksVisible) tasks?.close()
      else setCompact((value) => !value)
    } else if (tab === 'tasks' && tasks && !taskEntryDisabled) {
      if (tasksVisible) closeTasks()
      else void tasks.open()
    }
  }
  const shortcutScope = useRef<HTMLDivElement>(null)
  const clientShell = useClientShell({ shortcutScope,
    shortcutActive: !locked && !tasksVisible && !settingsOpen && !panel && !(renameSid && renameSid === sid) &&
      !browserVisible && !filesOpen && !(sid && locatedFilesSid === sid) && !approvedProject,
    onToggleSidebar: () => setCompact(value => !value) })
  const statusBlocked = locked || tasksVisible || settingsOpen || !!panel || (!!renameSid && renameSid === sid) ||
    !!browserVisible || filesOpen || (!!sid && locatedFilesSid === sid) || !!approvedProject || !!clientShell.fullscreen?.view.busy ||
    clientShell.fullscreen?.view.state === 'foreign'
  const surface = <CodeClipboardProvider writeText={writeClientText} locked={locked}><ChatSurface className={`wb-chat${preferences ? ' wb-chat--session-prefs' : ''}`} data-testid="workbench-chat">
    <div ref={shortcutScope} className={`cf-body${tasksVisible ? ' wb-chat__body--tasks' : ''}`} style={{ '--cf-side': `${compact ? 0 : sidebar}px` } as React.CSSProperties}>
      <IconRail tab={tasksVisible ? 'tasks' : 'chats'} onTab={selectRailTab} listCollapsed={compact}
        onOpenSettings={openSettings} chatAlert={false} unavailable={c.unavailable}
        chatShortcut={clientShell.chatShortcut}
        webFullscreen={<ClientFullscreenButton fullscreen={clientShell.fullscreen} locked={taskEntryDisabled || !!browserVisible || filesOpen || !!approvedProject} />}
        taskInspection={tasks ? { panelId: tasksPanelId, disabled: taskEntryDisabled, buttonRef: tasksButton } : undefined}
        library={library ? { openProfile: () => { tasks?.close(); setPanel('profile') }, openRoster: () => { tasks?.close(); setPanel('roster') } } : undefined} />
      {tasks && tasksVisible ? <main className="wb-tasks__main">
        {notice}
        <TaskInspectionPanel api={tasks} view={taskView} id={tasksPanelId} close={closeTasks} />
      </main> : <>
        {!compact && <ResizeHandle axis="x" value={sidebar} title={t('cf.resizeSidebar')}
          style={{ left: `calc(${ICONRAIL_W}px + ${sidebar}px)` }} onChange={setSidebarWidth}
          onCommit={() => setSidebarWidth((w) => clampSidebar(w, window.innerWidth))} onReset={() => setSidebarWidth(SIDEBAR_DEFAULT)} />}
        <aside className={`cf-rail${compact ? ' is-collapsed' : ''}`} aria-hidden={compact || undefined}>
          {!compact && <>
            <div className="cf-rail__top">
              {preferences && archivedView ? <>
                <button className="cf-rail__back" type="button" data-testid="workbench-active-chats" title={t('cf.backToChats')}
                  aria-label={t('cf.backToChats')} onClick={() => setArchivedView(false)}><ArrowLeft size={16} /></button>
                <span className="cf-rail__title">{t('cf.archivedChats')}</span>
                <span className="cf-rail__count">{archivedCount}</span>
              </> : <>
                <div className="cf-search">
                  <Search className="cf-search__icon" size={14} />
                  <input className="cf-search__input" aria-label={t('cf.searchChats')} placeholder={t('cf.searchChats')}
                    value={query} onChange={(event) => setQuery(event.target.value)} />
                </div>
                {preferences && <button className="cf-rail__back wb-session-prefs__archive-link" type="button" data-testid="workbench-archived-chats"
                  title={t('cf.archivedChats')} aria-label={t('cf.archivedChats')} onClick={() => setArchivedView(true)}>
                  <Archive size={16} />{archivedCount > 0 && <span className="cf-rail__count">{archivedCount}</span>}
                </button>}
                <button className="cf-rail__addbtn" type="button" data-testid="workbench-new-chat" title={t('cf.newChat')}
                  aria-label={t('cf.newChat')} disabled={wk.createPending || locked} onClick={start}><Plus size={16} /></button>
              </>}
            </div>
            <div className="cf-list" data-session-view={preferences ? archivedView ? 'archived' : 'active' : undefined}>
              {wk.listIssue && <p className="cf-empty" role="alert">{c[wk.listIssue]}{' '}
                {wk.listIssue === 'listFailure' && <button className="cf-empty__action" type="button" onClick={() => void wk.refreshList()}>{c.reloadList}</button>}
              </p>}
              {visibleRows.length ? visibleRows.map((s) => {
                const entry = !statusApi || archivedView || (state?.id === s.id && !eligibleReadRow(state))
                  ? undefined : matchingReadEntry(reads.readView, s)
                const streaming = s.id === sid && !!state?.active
                return <ReadThreadRow key={s.id} id={s.id} enabled={!!statusApi && !archivedView} entry={entry}><ThreadRow session={s} active={s.id === sid}
                  appearance={appearance(s.personaId)} memberFaces={[]} membersWorking={[]} browserPages={0} tasks={[]}
                  subtitle={s.compatibility === 'legacy_text' ? c.readOnly : s.compatibility === 'unsupported' ? c.unavailable : (s.personaId ? appearance(s.personaId).name : s.model ?? t('cf.assistant'))}
                  state={streaming || entry?.unread ? { streaming, unread: !!entry?.unread, attention: false } : undefined}
                  onClick={() => { wk.select(s.id); if (viewport.w < 780) setCompact(true) }} /></ReadThreadRow>
              }) : !wk.listLoading && !wk.listIssue && <div className="cf-empty">{query && !archivedView ? t('cf.searchNoResults') : t('chat.noSessions')}</div>}
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
            <span className="cf-idbtn__name wb-chat__title">{(preferences ? projectedEntry?.title ?? state?.title : state?.title || selectedEntry?.title)
              || (sid ? t('chat.untitled') : t('cf.tabChats'))}</span>
            {personaId && <span className="wb-chat__persona" data-testid="workbench-chat-persona"><Avatar persona={appearance(personaId)} size={22} plain />{appearance(personaId).name}</span>}
            <AttachedWorkspaceLabel view={bound} locale={locale} open={controlledOpen} />
            {preferences && selectedEntry && <SessionHeaderActions archived={!!projectedEntry?.archived} disabled={preferenceControlsDisabled}
              blocked={preferenceBlockReason}
              rename={renameSession} archive={archiveSession} />}
            {openFiles && !(wk.selected && (state?.writable || state?.active)) &&
              <ComposerWorkspaceButton label={workspaceLabel} onClick={openFiles} testId={WORKSPACE_OPEN} />}
            {browser && sid && <button className="cf-wschip wb-browser__launch" type="button" data-testid="workbench-browser-open"
              aria-haspopup="dialog" aria-label={t('browser.title')} disabled={locked} onClick={() => {
                setBrowserOpen({ sid, transport: browser, panel: createManualBrowserPanel(browser, sid, onExpired) })
              }}><Globe size={15} /><span>{t('browser.title')}</span></button>}
            <span className="cf-conv__tag wb-chat__scope" title={scope}>{scope}</span>
          </ConversationHeader>
          {notice}
          {binding && <SessionWorkspaceControls controller={binding} view={bound} locale={locale} writable={workspaceWritable} openNotes={notes} />}
          {preferenceEntry && renameSid !== sid && <SessionPreferenceStatus entry={preferenceEntry} reload={reloadPreferences} locked={locked} />}
          {sid ? <TextThread key={sid} sid={sid} wk={wk} c={c} locked={locked}
            preferred={modelChoice[sid] ?? state?.model ?? selectedEntry?.model ?? (personaId ? null : recent)}
            onPick={(id) => { setModelChoice((choices) => ({ ...choices, [sid]: id })); setRecent(id) }}
            managedModel={preferences ? {
              pinned: preferenceEntry?.pending?.model !== undefined ? preferenceEntry.pending.model : confirmedModel,
              disabled: preferenceControlsDisabled || selectedEntry?.model !== confirmedModel,
              contextReady: !!preferenceEntry?.confirmed && selectedEntry?.model === confirmedModel &&
                !(preferenceEntry.pending || preferenceEntry.reading || preferenceEntry.needsRead),
              choose: (model) => {
                if (!preferenceControlsDisabled && model !== preferenceEntry?.confirmed?.preferences.model) void preferences.write(sid, { model })
              }
            } : undefined}
            openSettings={openSettings} openFiles={openFiles} workspaceLabel={workspaceLabel}
            conversationStatus={statusApi ? { api: statusApi, reads, row: selectedEntry, contextBlocked: statusBlocked,
              readBlocked: statusBlocked || archivedView || !!projectedEntry?.archived || !!wk.pending || !!wk.listIssue } : undefined}
             deliveryApi={deliveryApi} locale={locale} beforeWrite={beforeWrite} onExpired={onExpired}
             openInWorkspace={files ? openInWorkspace : undefined} />
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
      </>}
    </div>
    {settingsOpen && renderSettings(() => setSettingsOpen(false))}
    {browserOpen && browserVisible && <ManualBrowserDialog api={browserOpen.panel} dismiss={() => setBrowserOpen(undefined)} />}
    {files && <WorkspaceFilesPanel open={filesOpen || (!!sid && locatedFilesSid === sid && !locked) || approvedProject?.kind === 'files'}
      close={() => { setFilesOpen(false); setLocatedFilesSid(undefined); binding?.closeProject() }} controller={files} git={locked ? undefined : git}
      terminal={locked ? undefined : terminal} documents={documents} documentActionsEnabled={documentsEnabled} documentScope={sid ?? undefined} />}
    {library && !panel && !settingsOpen && approvedProject?.kind === 'notes' && <ProjectMemoryDialog
      key={`${workspaceSid}:${approvedProject.workspace.id}`} api={library} locked={locked} notice={notice}
      lockedProject={{ ...approvedProject.workspace, signal: approvedProject.signal }} onClose={() => binding?.closeProject()} />}
    {renameSid && renameSid === sid && preferences && preferenceEntry && <SessionRenameDialog key={sid} sid={sid} entry={preferenceEntry}
      store={preferences} disabled={preferenceLocked} close={() => setRenameSid(undefined)} reload={reloadPreferences} />}
  </ChatSurface></CodeClipboardProvider>
  return library ? <LibraryWorkspace api={library} panel={panel} locked={locked} notice={notice} onRoster={setRoster}
    close={() => setPanel(undefined)} openProjects={() => setPanel('projects')} createChat={async (role) => {
      const created = await wk.create(role.id)
      if (created) { setQuery(''); setArchivedView(false) }
      return created
    }}>{surface}</LibraryWorkspace> : surface
}

type ManagedModel = { pinned: string | null | undefined; disabled: boolean; contextReady: boolean; choose: (model: string | null) => void }
type StatusOptions = {
  api: ConversationStatusTransport; reads: ReturnType<typeof useConversationReadMap>; row?: ChatSummary
  contextBlocked: boolean; readBlocked: boolean
}

function TextThread({ sid, wk, c, locked, preferred, onPick, managedModel, openSettings, openFiles, workspaceLabel,
  deliveryApi, locale, beforeWrite, onExpired, openInWorkspace, conversationStatus }: {
  sid: string; wk: Workspace; c: ChatCopy; locked: boolean; preferred: string | null; onPick: (id: string) => void; openSettings: () => void
  openFiles?: () => void; workspaceLabel: string; managedModel?: ManagedModel; deliveryApi?: DeliveriesTransport; locale: string
  conversationStatus?: StatusOptions
  beforeWrite: () => Promise<void>; onExpired: () => void; openInWorkspace?: (where: DeliveryLocation, signal: AbortSignal) => Promise<boolean>
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
  const focusComposer = useRef<() => void>()
  const canQuote = !locked && link === 'ready' && state?.compatibility === 'text' && state.writable
  const selection = useConversationSelection(scroll, !locked, () => wk.selectionStamp(sid), canQuote ? (quote) => {
    if (wk.setDraftQuote(sid, quote)) focusComposer.current?.()
  } : undefined)
  const following = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const anchor = useRef<number>()
  // Deltas only change active.text. Read deliveries on confirmed snapshot/turn changes, never on deltas.
  const authority = link === 'ready' && state ? [wk.projection?.snapshot?.cursor.generation, state.compatibility,
    state.messages?.length ?? 'history', active?.turnId ?? '', last?.turnId ?? '', last?.status ?? '', last?.reason ?? ''].join(':') : undefined
  const { controller: deliveries, view: deliveryView } = useDeliveries(deliveryApi, sid, !locked && link !== 'missing', authority,
    { beforeWrite, expired: onExpired, openWorkspace: openInWorkspace })
  const start = Math.max(0, messages.length - windowSize)
  const eligible = eligibleDeliveryReplies(state, !!wk.pending, authority, deliveryView)
  const messageIndexFor = (group: DeliveryGroup): number | undefined => {
    const i = group.messageIndex
    return group.origin === 'reply' && group.turnId && i !== undefined && state?.compatibility === 'text' &&
      messages[i]?.role === 'assistant' && messages[i].content.trim() ? i : undefined
  }
  const attached = new Map<number, DeliveryGroup[]>()
  const history = deliveryView.groups.filter((group) => {
    const i = messageIndexFor(group)
    if (i === undefined || i < start) return true
    const groups = attached.get(i) ?? []
    groups.push(group)
    attached.set(i, groups)
    return false
  })
  const requestedReveal = useRef<number>()
  const focusSource = (selector: string): void => {
    const element = scroll.current?.querySelector<HTMLElement>(selector)
    if (!element) return
    following.current = false
    element.focus({ preventScroll: true })
    element.scrollIntoView({ block: 'nearest' })
  }
  const reveal = (group: DeliveryGroup): void => {
    const i = messageIndexFor(group)
    if (i === undefined) return focusSource(`[data-delivery-group-id="${group.id}"]`)
    if (i >= start) return focusSource(`[data-delivery-message-index="${i}"]`)
    requestedReveal.current = i
    following.current = false
    setWindowSize((n) => Math.max(n, messages.length - i))
  }
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
    if (requestedReveal.current !== undefined) {
      focusSource(`[data-delivery-message-index="${requestedReveal.current}"]`)
      requestedReveal.current = undefined
    }
  }, [messages, active, windowSize, attachmentDraft])
  const older = (): void => {
    const el = scroll.current
    if (el) anchor.current = el.scrollHeight - el.scrollTop
    following.current = false
    setWindowSize((n) => n + PAGE)
  }
  const visibleMessages = useMemo(() => messages.slice(start).map((message) => ({ message,
    cards: uploads ? message.attachments?.map((entry) => attachmentCard(sid, entry)) : undefined
  })), [messages, start, uploads, sid])
  const writeBanner = state?.compatibility === 'unsupported' ? c.unsupported : state?.compatibility === 'legacy_text' ? c.readOnly
    : state?.writeBlockReason === 'role_unavailable' ? c.roleUnavailable
      : state?.writeBlockReason === 'session_turn_limit' ? c.limit : state && !state.writable ? c.locked : undefined
  return <>
    {conversationStatus && <DisplayedReadStatus {...conversationStatus.reads} locale={locale} row={conversationStatus.row}
      projection={wk.projection} current={() => wk.currentReadProjection(sid)} blocked={conversationStatus.readBlocked} atBottom={atBottom}
      hasContent={visibleMessages.some(({ message, cards }) => !!message.content.trim() || !!cards?.length)} scroller={scroll}
      refresh={() => { wk.refreshProjection(sid); wk.refreshList() }} />}
    <div className="cf-convmid">
      <ConversationScroller scrollRef={scroll} onContextMenu={selection.onContextMenu} onKeyDown={selection.onKeyDown} onScroll={(event) => {
        const el = event.currentTarget
        following.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 64
        setAtBottom(following.current)
      }}>
        {start > 0 && <button className="btn btn--ghost wb-chat__older" type="button" onClick={older}>{c.previous}</button>}
        {writeBanner && <p className="cf-empty wb-chat__notice" role="status">{writeBanner}</p>}
        {link === 'missing' && <p className="cf-empty wb-chat__notice" role="alert">{c.missing}</p>}
        {!messages.length && !writeBanner && link === 'ready' && <div className="cf-empty">{c.empty}</div>}
        {visibleMessages.map(({ message, cards }, index) => {
          const at = start + index
          const candidate = eligible.get(at)
          const groups = attached.get(at) ?? []
          const bubble = <TextConversationMessage key={at} role={message.role} text={message.content} attachments={cards} selectable={!locked} />
          return deliveries && (candidate || groups.length) ? <div key={at} className="wb-deliveries__message"
            data-delivery-message-index={at} tabIndex={-1}>
            {bubble}
            <div className="wb-deliveries__reply">
              {candidate && authority && <ReplyDeliveryActions candidate={candidate} authority={authority} state={deliveryView}
                controller={deliveries} locale={locale} />}
              {groups.map((group) => <BrowserDeliveryCard key={group.id} group={group} state={deliveryView}
                controller={deliveries} locale={locale} source workspace={false} reveal={() => reveal(group)} />)}
            </div>
          </div> : bubble
        })}
        {active?.text && <TextConversationMessage key={active.turnId} role="assistant" text={active.text} streaming selectable={!locked} />}
        {link !== 'ready' && link !== 'missing' && <p className="cf-empty wb-chat__notice" role="status">{c[link === 'reconnecting' ? 'reconnecting' : 'loading']}</p>}
        {active && <p className="cf-empty wb-chat__notice" role="status">{active.text ? c.running : c.reading}</p>}
        {last && !active && last.status !== 'running' && <p className="cf-empty wb-chat__notice" role="status"
          data-testid="workbench-turn-status" data-status={last.status}>{turnLabel(c, last)}</p>}
        {wk.pending === 'send' && !active && <p className="cf-empty wb-chat__notice" role="status">{c.sent}</p>}
        {wk.turnIssue && <p className="cf-empty wb-chat__notice" role="alert">{c[wk.turnIssue]}</p>}
        {deliveries && <DeliveryHistory groups={history} state={deliveryView} authority={authority} controller={deliveries} locale={locale}
          workspace={!!openInWorkspace} hasSource={(group) => messageIndexFor(group) !== undefined} reveal={reveal} />}
      </ConversationScroller>
    </div>
    {selection.menu}
    <ConversationSelectionStatus status={selection.status} locale={locale} />
    {deliveries && <DeliveryFeedback state={deliveryView} authority={authority} controller={deliveries} locale={locale} />}
    {uploads && <AttachmentIssues draft={attachmentDraft} dismiss={() => uploads.dismiss(sid)} />}
    {(state?.writable || active) && <TextComposer sid={sid} model={(preferred ?? '')} onPick={onPick} managedModel={managedModel} openSettings={openSettings}
      drafts={wk.drafts} focusComposer={focusComposer} clipboardLocked={locked}
      writeLocked={!canQuote || !!wk.pending}
      stopping={link !== 'ready' || !!wk.pending} active={active} send={wk.send} stop={wk.stop} c={c}
      jump={!atBottom ? jump : undefined} openFiles={openFiles} workspaceLabel={workspaceLabel}
      context={conversationStatus ? { api: conversationStatus.api, projection: wk.projection, blocked: conversationStatus.contextBlocked, onExpired } : undefined}
      attachmentDraft={attachmentDraft} add={add} remove={remove} />}
    {state?.turnLimit && state.writable && <p className="wb-chat__limits">{c.limits.replace('{turns}', String(state.turnLimit))}</p>}
  </>
}

function TextComposer({ sid, drafts, focusComposer, clipboardLocked, model, onPick, managedModel, openSettings, writeLocked, stopping, active, send, stop, c, jump, openFiles, workspaceLabel,
  attachmentDraft, add, remove, context }: {
  sid: string; drafts: Workspace['drafts']; focusComposer: React.MutableRefObject<(() => void) | undefined>; clipboardLocked: boolean
  model: string; onPick: (id: string) => void; managedModel?: ManagedModel; openSettings: () => void
  writeLocked: boolean; stopping: boolean; active: ChatState['active'] | undefined; send: Workspace['send']; stop: Workspace['stop']; c: ChatCopy; jump?: () => void
  openFiles?: () => void; workspaceLabel: string; attachmentDraft: AttachmentDraft; add?: (files: BrowserFiles) => void; remove?: (key: string) => void
  context?: Pick<Parameters<typeof WorkbenchContextMeter>[0], 'api' | 'projection' | 'blocked' | 'onExpired'>
}): React.JSX.Element {
  const { t } = useI18n()
  const { ready, providers, activeModelId } = useModels()
  const viewport = useViewport()
  const [height, setHeight] = useState(COMPOSER_DEFAULT)
  const readDraft = useCallback(() => drafts.read(sid), [drafts, sid])
  const draft = useSyncExternalStore(drafts.subscribe, readDraft, readDraft)
  const editorBody = useRef('')
  const [open, setOpen] = useState(false)
  const groups = modelGroups(providers)
  const picked = findActive(groups.map((g) => ({ ...g.p, models: g.models })), managedModel ? managedModel.pinned ?? null : model || activeModelId)
  const sendModel = managedModel?.pinned === null ? null : picked ? `${picked.provider.id}:${picked.model.id}` : undefined
  const canSend = !writeLocked && !managedModel?.disabled && !active && ready && sendModel !== undefined &&
    (sendModel !== null || groups.length > 0)
  const over = exceedsDraftLimit(draft)
  const ids = readyAttachmentIds(attachmentDraft)
  const submit = (): void => {
    if (canSend) void send(sid, editor.getText(), sendModel)
  }
  const pasteNotice = useClientPasteNotice()
  const editor = useComposerEditor({
    onChange: (value) => { editorBody.current = value; drafts.setBody(sid, value) },
    mentionNames: [],
    onPaste: (event) => {
      if (clipboardLocked) { event.preventDefault(); pasteNotice.report('locked'); return true }
      if (!add || !event.clipboardData) return false
      const files = browserFiles(event.clipboardData)
      if (!files.files.length && !files.issues.length) return false
      event.preventDefault()
      add(files)
      return true
    },
    onClientTextPaste: (event, insert) => pasteClientText(event, insert, pasteNotice.report),
    onKey: (key, e) => {
      if (key !== 'enter' || e.shiftKey || e.ctrlKey || e.altKey) return false
      e.preventDefault()
      submit()
      return true
    }
  })
  useLayoutEffect(() => {
    focusComposer.current = editor.focusEnd
    return () => { focusComposer.current = undefined }
  }, [editor.focusEnd, focusComposer])
  useLayoutEffect(() => {
    if (draft.body === editorBody.current) return
    editorBody.current = draft.body
    editor.setText(draft.body)
    if (!draft.body) editor.clearHistory()
  }, [draft.body, editor.setText, editor.clearHistory])
  useEffect(() => {
    if (managedModel?.disabled) setOpen(false)
  }, [managedModel?.disabled])
  useEffect(() => {
    if (!open) return
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [open])
  return <div className="cf-composer">
    {jump && <ComposerJump onJump={jump} />}
    <div className="cf-composer__inner">
      {(!managedModel ? !picked : (managedModel.pinned === null ? groups.length === 0 : !!managedModel.pinned && !picked)) &&
        <div className="wb-chat__model">{c.selectModel}{' '}
          <button className="cf-empty__action" type="button" onClick={openSettings}>{t('settings.models')}</button>
        </div>}
      {over && <p className="wb-chat__model" role="alert">{c.inputLimit}</p>}
      <ClientPasteFeedback state={pasteNotice.state} />
      <div className="cf-box">
        <ResizeHandle axis="y" className="cf-resizer--box" value={clampComposer(height, viewport.h)} title={t('cf.resizeComposer')}
          onChange={(value) => setHeight(clampComposer(value, viewport.h))} onCommit={() => setHeight((v) => clampComposer(v, viewport.h))}
          onReset={() => setHeight(COMPOSER_DEFAULT)} />
        {add && <AttachmentDraftCards sid={sid} draft={attachmentDraft} remove={remove} />}
        {draft.quote && <ComposerQuoteBar quote={draft.quote} testId="workbench-quote-draft" removeTestId="workbench-quote-remove"
          onRemove={() => { drafts.setQuote(sid, ''); editor.focusEnd() }} />}
        <ComposerDraftInput editor={editor} height={clampComposer(height, viewport.h)} placeholder={c.input} />
        <div className="cf-box__bar">
          {add && <AttachmentPicker add={add} disabled={writeLocked || !!active} />}
          <ComposerWorkspaceButton label={openFiles ? workspaceLabel : t('cf.mountWorkspace')} title={openFiles ? workspaceLabel : c.unavailable}
            onClick={openFiles} testId={openFiles ? WORKSPACE_OPEN : undefined} />
          <div className="cf-mp">
            {open && <div className="model-pick__backdrop" onClick={() => setOpen(false)} />}
            {context && <WorkbenchContextMeter {...context} sid={sid} modelReady={ready && (!managedModel || managedModel.contextReady)}
              target={contextTarget(managedModel ? managedModel.pinned : model || null, groups, activeModelId)} />}
            <div className="model-pick">{managedModel ? <SessionModelPicker active={picked} groups={groups} open={open}
              disabled={managedModel.disabled || !ready} pinned={managedModel.pinned} onToggle={() => setOpen((value) => !value)}
              onPick={(pid, mid) => { managedModel.choose(`${pid}:${mid}`); setOpen(false) }} follow={() => { managedModel.choose(null); setOpen(false) }} />
              : <ModelSelectButton active={picked} groups={groups} open={open}
                onToggle={() => setOpen((value) => !value)} onPick={(pid, mid) => { onPick(`${pid}:${mid}`); setOpen(false) }} />}</div>
          </div>
          {active ? <ComposerSendButton stop disabled={stopping} onClick={() => void stop(sid, active.turnId)} />
            : <ComposerSendButton disabled={!canSend || !ids || (!draft.quote && !draft.body.trim() && !ids.length) || over} onClick={submit} />}
        </div>
      </div>
      {add && <AttachmentHint />}
    </div>
  </div>
}
