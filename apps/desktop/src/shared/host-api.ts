import type { BrowserLiveFrame, BrowserUiState } from './browser'
import type {
  ChatSendRequest,
  ChatInsertRequest,
  ChatInsertResult,
  TakenInserts,
  ChatCompactRequest,
  ChatCreateSessionRequest,
  ChatSetModelRequest,
  ChatSetEffortRequest,
  ChatSetFocusRequest,
  ChatRenameSessionRequest,
  ChatRemoteChange,
  DisplayMessage,
  AskResponse,
  PlanResponse,
  TodoState,
  MountResponse,
  ResolveAutotaskResult,
  ContextUsage
} from './chat-protocol'
import type { DeliverableInfo } from './deliverables'
import type {
  ChatSessionMeta,
  RewindTurnStat,
  RewindPreview,
  RewindApplyRequest,
  RewindApplyResult,
  RewindUndoResult,
  TaskStatus,
  TaskSchedule,
  TaskRecord,
  TaskCreateInput,
  TaskUpdateInput,
  CreateTaskResult,
  PreviewScheduleResult,
  ChatEventPayload
} from './host-conversations'
import type {
  DirEntry,
  OpenFolderResult,
  ReadFileResult,
  PickedAttachment,
  DroppedEntry,
  TerminalCreateOptions,
  ShellProfile,
  TerminalDataPayload,
  TerminalExitPayload,
  GitStatus,
  GitDiffLine,
  GitCommit,
  GitBranch,
  GitAvailable,
  GitOpResult,
  GitGenModel,
  GitGenLocale,
  GitGenerateResult
} from './host-files'
import type {
  SkillRecord,
  SkillImportResult,
  PersonaRecord,
  UserProfile,
  MemoryType,
  MemorySnapshot,
  MemoryScopeArg,
  MemoryIpcResult,
  PersonaUpsertInput,
  McpServerConfig,
  McpServerInput,
  McpServerView,
  ProbeConfig,
  ProviderListModelsResult,
  BotPlatform,
  BotReplyMode,
  BotReplyScope,
  RemoteState,
  BotScanEvent
} from './host-settings'
import type { PhoneLinkResult, PhonePairedEvent, PhoneQrResult, PhoneState, PhoneVia } from './phone'
import type { UpdateState } from './update'

// 保持原有宿主 DTO 的统一入口；重用独立共享模块中已有的类型。
export type * from './host-conversations'
export type * from './host-files'
export type * from './host-settings'
export type {
  ChatModelConfig,
  ChatSendRequest,
  ChatInsertRequest,
  ChatInsertResult,
  TakenInserts,
  ChatCompactRequest,
  ChatCreateSessionRequest,
  ChatSetModelRequest,
  ChatSetEffortRequest,
  ChatSetFocusRequest,
  ChatRenameSessionRequest,
  ChatRemoteChange,
  AttachmentChip,
  HandoffInfo,
  MemberTask,
  DisplayBlock,
  DisplayMessage,
  AskOption,
  AskQuestion,
  AskResponse,
  PlanResponse,
  TodoItem,
  TodoList,
  TodoState,
  MountResponse,
  ResolveAutotaskResult,
  ChatStreamEvent,
  ContextUsage,
  MemberProgressGroup
} from './chat-protocol'
export type { AgentDraft, AutotaskDraft } from './drafts'
export type { EffortLevel } from './effort'

/** Desktop 原生平台标识；声明本身只依赖标准 TypeScript / DOM 类型。 */
export type HostPlatform =
  | 'aix'
  | 'android'
  | 'darwin'
  | 'freebsd'
  | 'haiku'
  | 'linux'
  | 'openbsd'
  | 'sunos'
  | 'win32'
  | 'cygwin'
  | 'netbsd'

/** 订阅同步返回取消订阅函数。 */
type Unsubscribe = () => void

/** 渲染层依赖的宿主契约。各宿主负责提供自己的实现。 */
export interface DevaApi {
  platform: HostPlatform
  window: {
    minimize: () => Promise<void>
    toggleMaximize: () => Promise<void>
    close: () => Promise<void>
    isFullScreen: () => Promise<boolean>
    onFullScreen: (cb: (on: boolean) => void) => Unsubscribe
    setOverlaySymbolColor: (color: string) => Promise<void>
  }
  /** 工作区文件系统与用户选取的附件。 */
  fs: {
    openFolder: () => Promise<OpenFolderResult | null>
    revealFolder: (path: string) => Promise<{ ok: boolean }>
    readDir: (path: string) => Promise<DirEntry[]>
    readFile: (path: string) => Promise<ReadFileResult>
    writeFile: (path: string, content: string) => Promise<{ ok: true }>
    pickAttachments: () => Promise<PickedAttachment[]>
    /** 粘贴文件的字节；data 为 null 时只报体积。 */
    pasteAttachment: (file: {
      name: string
      mime: string
      size: number
      data: Uint8Array | null
    }) => Promise<PickedAttachment>
    attachmentImage: (path: string, full?: boolean) => Promise<string | null>
    /** 接收实际拖入或粘贴的 File，按下标返回已授权条目；没有本地路径的条目为 null。 */
    droppedEntries: (files: File[]) => Promise<(DroppedEntry | null)[]>
  }
  /** 应用配置：首帧同步读取，其余读写可异步进行。 */
  config: {
    /** 同步取整份配置，供首帧读取主题与语言。 */
    getSync: () => Record<string, unknown>
    get: () => Promise<Record<string, unknown>>
    /** 顶层浅合并；值为 undefined 时删除对应键。 */
    set: (patch: Record<string, unknown>) => Promise<{ ok: true }>
  }
  skills: {
    list: () => Promise<SkillRecord[]>
    get: (id: string) => Promise<SkillRecord | null>
    import: () => Promise<SkillImportResult>
    remove: (id: string) => Promise<{ ok: boolean }>
    setEnabled: (id: string, enabled: boolean) => Promise<{ ok: true }>
    setRoles: (id: string, roles: string[] | null) => Promise<{ ok: boolean }>
    onChanged: (cb: (skills: SkillRecord[]) => void) => Unsubscribe
  }
  profile: {
    get: () => Promise<UserProfile>
    setAvatar: (spec: string) => Promise<{ ok: true }>
    setAvatarImage: (dataUri: string) => Promise<string>
  }
  memory: {
    list: (scope?: MemoryScopeArg) => Promise<MemorySnapshot>
    write: (
      input: { type?: MemoryType; title?: string; body?: string },
      id?: string,
      scope?: MemoryScopeArg
    ) => Promise<MemoryIpcResult>
    remove: (id: string, scope?: MemoryScopeArg) => Promise<MemoryIpcResult>
    clear: (scope?: MemoryScopeArg) => Promise<MemoryIpcResult>
  }
  personas: {
    list: () => Promise<PersonaRecord[]>
    get: (id: string) => Promise<PersonaRecord | null>
    upsert: (input: PersonaUpsertInput) => Promise<PersonaRecord>
    remove: (id: string) => Promise<{ ok: true }>
    setEnabled: (id: string, enabled: boolean) => Promise<{ ok: true }>
    reorder: (ids: string[]) => Promise<{ ok: true }>
    setAvatarImage: (id: string, dataUri: string) => Promise<string>
    clearAvatarImage: (id: string) => Promise<{ ok: true }>
  }
  mcp: {
    list: () => Promise<McpServerView[]>
    get: (id: string) => Promise<McpServerConfig | null>
    upsert: (input: McpServerInput) => Promise<McpServerConfig>
    remove: (id: string) => Promise<{ ok: true }>
    setEnabled: (id: string, enabled: boolean) => Promise<{ ok: true }>
    setRoles: (id: string, roles: string[] | null) => Promise<{ ok: boolean }>
    retry: (id: string) => Promise<McpServerView | null>
    setSecret: (id: string, field: string, value: string) => Promise<{ ok: boolean; available: boolean }>
    hasSecret: (id: string, field: string) => Promise<boolean>
    onStatus: (cb: (view: McpServerView) => void) => Unsubscribe
  }
  secrets: {
    set: (providerId: string, key: string) => Promise<{ ok: boolean; available: boolean }>
    has: (providerId: string) => Promise<boolean>
    delete: (providerId: string) => Promise<{ ok: true }>
    list: () => Promise<string[]>
    available: () => Promise<boolean>
  }
  provider: {
    listModels: (cfg: ProbeConfig) => Promise<ProviderListModelsResult>
  }
  /** 对话、流式事件、待办与回滚。 */
  chat: {
    send: (req: ChatSendRequest) => Promise<{ turnId: string }>
    insert: (req: ChatInsertRequest) => Promise<ChatInsertResult>
    withdrawInserts: (sessionId: string) => Promise<TakenInserts>
    compact: (req: ChatCompactRequest) => Promise<{ turnId: string }>
    createSession: (req: ChatCreateSessionRequest) => Promise<{ ok: true }>
    setModel: (req: ChatSetModelRequest) => Promise<{ ok: boolean }>
    setEffort: (req: ChatSetEffortRequest) => Promise<{ ok: true }>
    setFocus: (req: ChatSetFocusRequest) => Promise<{ ok: true }>
    renameSession: (req: ChatRenameSessionRequest) => Promise<{ title: string } | null>
    setArchived: (req: { sessionId: string; archived: boolean }) => Promise<{ ok: boolean }>
    abort: (turnId: string) => Promise<{ ok: true }>
    stopSubagent: (sessionId: string, toolUseId: string) => Promise<{ ok: boolean }>
    listSessions: (workspaceRoot: string | null) => Promise<ChatSessionMeta[]>
    loadSession: (sessionId: string, workspaceRoot: string | null) => Promise<DisplayMessage[]>
    attachmentImage: (sessionId: string, ref: string, full?: boolean) => Promise<string | null>
    /** 同时载入历史和正在进行的回合；空闲时 turnId 与 startedAt 均为 null。 */
    attachSession: (sessionId: string) => Promise<{ messages: DisplayMessage[]; turnId: string | null; startedAt: number | null }>
    deleteSession: (sessionId: string, workspaceRoot: string | null) => Promise<{ ok: true }>
    removeMember: (sessionId: string, memberSessionId: string) => Promise<{ ok: boolean }>
    /** 按 0 基回合下标删除；对话正在进行、压缩或回滚时返回 null。 */
    deleteTurns: (
      sessionId: string,
      workspaceRoot: string | null,
      turnIndices: number[]
    ) => Promise<DisplayMessage[] | null>
    todos: (sessionId: string) => Promise<TodoState>
    contextUsage: (sessionId: string, modelRef: string) => Promise<ContextUsage | null>
    cancelTodoList: (sessionId: string) => Promise<TodoState>
    rewindList: (sessionId: string) => Promise<{ turns: RewindTurnStat[]; canUndo: boolean }>
    rewindPreview: (sessionId: string, turn: number) => Promise<RewindPreview | null>
    rewindApply: (req: RewindApplyRequest) => Promise<RewindApplyResult>
    rewindUndo: (sessionId: string) => Promise<RewindUndoResult>
    resolveProposal: (
      sessionId: string,
      toolUseId: string,
      status: 'accepted' | 'rejected'
    ) => Promise<{ ok: boolean }>
    resolveAutotask: (
      sessionId: string,
      toolUseId: string,
      action: 'create' | 'dismiss',
      taskInput?: TaskCreateInput
    ) => Promise<ResolveAutotaskResult>
    respondAsk: (payload: AskResponse) => Promise<{ ok: boolean }>
    respondPlan: (payload: PlanResponse) => Promise<{ ok: boolean }>
    respondMount: (payload: MountResponse) => Promise<{ ok: boolean }>
    onEvent: (cb: (payload: ChatEventPayload) => void) => Unsubscribe
    onSessionsChanged: (cb: () => void) => Unsubscribe
    markRead: (sessionId: string) => Promise<{ ok: true }>
    onRemoteChange: (cb: (c: ChatRemoteChange) => void) => Unsubscribe
  }
  /** 集成终端：终端输入、调整尺寸及销毁为同步返回的通知。 */
  terminal: {
    listShells: () => Promise<ShellProfile[]>
    create: (opts: TerminalCreateOptions) => Promise<{ id: string }>
    write: (id: string, data: string) => void
    resize: (id: string, cols: number, rows: number) => void
    dispose: (id: string) => void
    onData: (cb: (payload: TerminalDataPayload) => void) => Unsubscribe
    onExit: (cb: (payload: TerminalExitPayload) => void) => Unsubscribe
  }
  /** Git 源代码管理；仓库操作的 dir 是工作区根目录。 */
  git: {
    available: () => Promise<GitAvailable>
    status: (dir: string) => Promise<GitStatus>
    diff: (
      dir: string,
      path: string,
      opts: { staged?: boolean; untracked?: boolean }
    ) => Promise<GitDiffLine[]>
    stage: (dir: string, paths: string[]) => Promise<GitOpResult>
    unstage: (dir: string, paths: string[]) => Promise<GitOpResult>
    discard: (dir: string, tracked: string[], untracked: string[]) => Promise<GitOpResult>
    commit: (dir: string, message: string) => Promise<GitOpResult>
    setConfig: (dir: string, name: string, email: string, global: boolean) => Promise<GitOpResult>
    branches: (dir: string) => Promise<GitBranch[]>
    checkout: (dir: string, ref: string) => Promise<GitOpResult>
    createBranch: (dir: string, name: string, checkout: boolean) => Promise<GitOpResult>
    checkoutRemote: (dir: string, remoteRef: string) => Promise<GitOpResult>
    merge: (dir: string, ref: string) => Promise<GitOpResult>
    mergeAbort: (dir: string) => Promise<GitOpResult>
    deleteBranch: (dir: string, name: string, force: boolean) => Promise<GitOpResult>
    renameBranch: (dir: string, oldName: string, newName: string) => Promise<GitOpResult>
    deleteRemoteBranch: (dir: string, remote: string, branch: string) => Promise<GitOpResult>
    log: (dir: string, depth?: number) => Promise<GitCommit[]>
    init: (dir: string) => Promise<GitOpResult>
    fetch: (dir: string) => Promise<GitOpResult>
    pull: (dir: string) => Promise<GitOpResult>
    push: (dir: string, setUpstreamBranch: string | null) => Promise<GitOpResult>
    generateCommitMessage: (
      dir: string,
      model: GitGenModel,
      locale: GitGenLocale,
      reqId?: string
    ) => Promise<GitGenerateResult>
    cancelCommitMessage: (reqId: string) => Promise<boolean>
    onCommitMessageDelta: (cb: (reqId: string, text: string) => void) => Unsubscribe
  }
  tasks: {
    list: () => Promise<TaskRecord[]>
    get: (id: string) => Promise<TaskRecord | null>
    create: (input: TaskCreateInput) => Promise<CreateTaskResult>
    update: (input: TaskUpdateInput) => Promise<TaskRecord | null>
    remove: (id: string) => Promise<{ ok: true }>
    setStatus: (id: string, status: TaskStatus) => Promise<TaskRecord | null>
    runNow: (id: string) => Promise<{ ok: boolean; reason?: string; already?: 'running' | 'queued' }>
    /** 只预览日程；allowPast 为 true 时允许已过去的一次性日程。 */
    preview: (
      schedule: TaskSchedule,
      locale: 'zh-CN' | 'en',
      allowPast?: boolean
    ) => Promise<PreviewScheduleResult>
    onChanged: (cb: (tasks: TaskRecord[]) => void) => Unsubscribe
    onNavigate: (cb: (payload: { sessionId?: string; pane?: 'tasks' }) => void) => Unsubscribe
  }
  clipboard: {
    readText: () => Promise<string>
    writeText: (text: string) => Promise<{ ok: true }>
  }
  deliverables: {
    inspect: (sessionId: string, toolUseId: string) => Promise<DeliverableInfo[]>
    thumbnail: (sessionId: string, toolUseId: string, index: number) => Promise<string | null>
    open: (sessionId: string, toolUseId: string, index: number) => Promise<{ ok: boolean }>
    reveal: (sessionId: string, toolUseId: string, index: number) => Promise<{ ok: boolean }>
  }
  workspace: {
    roleHome: (personaId: string) => Promise<{ path: string; exists: boolean }>
  }
  /** 内置浏览器的状态、窗口、标签页与预览。 */
  browser: {
    getState: () => Promise<BrowserUiState>
    ready: () => Promise<BrowserUiState>
    onState: (cb: (state: BrowserUiState) => void) => Unsubscribe
    open: (opts?: { tab?: string; sessionId?: string }) => Promise<{ ok: boolean }>
    dock: () => Promise<{ ok: boolean }>
    closeSession: (sessionId: string) => Promise<{ ok: boolean }>
    setPreviewPinned: (tab: string | null) => Promise<{ ok: boolean }>
    liveStart: (tab: string) => Promise<boolean>
    liveStop: () => Promise<{ ok: boolean }>
    onLiveFrame: (cb: (frame: BrowserLiveFrame) => void) => Unsubscribe
    pin: (on: boolean) => Promise<{ ok: boolean }>
    activate: (tab: string) => Promise<{ ok: boolean }>
    closeTab: (tab: string) => Promise<{ ok: boolean }>
    nav: (tab: string, what: 'back' | 'forward' | 'reload' | 'stop') => Promise<{ ok: boolean }>
    menu: (
      tab: string,
      labels: Record<string, string>,
      at: { x: number; y: number }
    ) => Promise<{ ok: boolean }>
    thumbnail: (tab: string) => Promise<string | null>
    handoff: (sessionId: string, answer: 'done' | 'skip') => Promise<{ ok: boolean }>
    stop: (sessionId: string) => Promise<{ ok: boolean }>
  }
  update: {
    getState: () => Promise<UpdateState>
    check: () => Promise<void>
    download: () => Promise<void>
    install: () => Promise<void>
    onState: (cb: (state: UpdateState) => void) => Unsubscribe
  }
  remote: {
    getState: () => Promise<RemoteState>
    scanStart: (platform: BotPlatform, opts?: { token?: string }) => Promise<
      | { ok: true; scanId: string; qr: string; link?: string; userCode?: string; expiresAt: number }
      | { ok: false; error: string }
    >
    scanCancel: (scanId: string) => Promise<{ ok: true }>
    setEnabled: (id: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>
    setReplyMode: (id: string, mode: BotReplyMode) => Promise<{ ok: true }>
    setScope: (id: string, scope: BotReplyScope) => Promise<{ ok: true }>
    deleteBot: (id: string) => Promise<{ ok: true }>
    pairCode: (id: string) => Promise<{ code: string; expiresAt: number }>
    pairCancel: (id: string) => Promise<{ ok: true }>
    removeUser: (id: string, userId: string) => Promise<{ ok: true }>
    onChanged: (cb: (state: RemoteState) => void) => Unsubscribe
    onScan: (cb: (ev: BotScanEvent) => void) => Unsubscribe
  }
  phone: {
    getState: () => Promise<PhoneState>
    add: () => Promise<PhoneState>
    remove: () => Promise<PhoneState>
    setEnabled: (enabled: boolean) => Promise<PhoneState>
    retry: () => Promise<{ ok: true }>
    qr: (via: PhoneVia) => Promise<PhoneQrResult>
    link: (via: PhoneVia) => Promise<PhoneLinkResult>
    qrCancel: () => Promise<{ ok: true }>
    removeDevice: (id: string) => Promise<{ ok: true }>
    onChanged: (cb: (state: PhoneState) => void) => Unsubscribe
    onPaired: (cb: (ev: PhonePairedEvent) => void) => Unsubscribe
  }
}
