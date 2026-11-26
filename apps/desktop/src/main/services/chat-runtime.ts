import type {
  AskResponse,
  ChatInsertRequest,
  ChatInsertResult,
  ChatRewindApplyRequest,
  ChatSendRequest,
  DisplayMessage,
  MountResponse,
  PlanResponse,
  ResolveAutotaskResult
} from '../../shared/chat-protocol'
import { statSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { cancelBackground, wakeForNotices } from './background-tasks'
import { closeSessionPages } from './browser'
import { publishRemoteChange, publishSessionsChanged } from './chat-bus'
import { displayOf } from './chat-display'
import { turnRanges, turnToolIds } from './chat-history'
import { markMemberSetting, memberDispatches, memberGroupDone } from './chat-members'
import {
  busySessions,
  collectBlobs,
  emit,
  historyLocked,
  pendingAsk,
  pendingMount,
  pendingPlan,
  pendingUndo,
  rewinding,
  type RewindUndo
} from './chat-state'
import { deleteSession as deleteStoredSession, getSession, save as saveProject, setSessionArchived, type StoredSession } from './chat-store'
import { pendingHandoffs } from './chat-task-handoff'
import { abortTurn, insertMessage, runScheduledTurn, sendMessage, type ScheduledTurnResult } from './chat-turns'
import {
  applyFiles,
  buildRestoreNote,
  planRewind,
  publicPreview,
  removeSessionCheckpoints,
  summarizeTurns,
  undoFiles,
  type RewindFile,
  type RewindStatus,
  type RewindTurnStat
} from './checkpoints'
import { isCompactionSummary } from './compaction'
import { trustRoot } from './fs-guard'
import { forgetRead } from './read-sync'
import { pruneSubagents, removeSessionSubagents } from './subagent-store'
import { createTask, releaseTasksOwnedBy, setTaskSessionPurger, syncTaskModel, type CreateTaskResult } from './tasks'
import type { TaskCreateInput, TaskRecord } from './tasks-types'
import { todoState } from './todos'

export type { ScheduledTurnResult } from './chat-turns'

/** 定时任务和交互回合共用一次显式初始化；scheduler 经 runScheduledTask 调用真实的密封执行器。 */
let scheduledRunner: ((task: TaskRecord) => Promise<ScheduledTurnResult>) | null = null
export function runScheduledTask(task: TaskRecord): Promise<ScheduledTurnResult> {
  if (!scheduledRunner)
    return Promise.reject(new Error('chat runtime 尚未就绪（initializeChatRuntime 未运行）'))
  return scheduledRunner(task)
}

/**
 * 会话编排的对外入口（模块级桥接，同 scheduledRunner）：桌面 IPC 处理器与远程通道调用的是同一组函数，
 * 故手机端发起的回合、作答的问答卡，与桌面端走完全相同的路径（落盘 / 检查点 / 权限闸门一致）。
 */
export interface ChatRuntime {
  send(req: ChatSendRequest): Promise<{ turnId: string }>
  /** 回合进行中插入一条消息（见 ChatInsertRequest）。 */
  insert(req: ChatInsertRequest): ChatInsertResult
  abort(turnId: string): void
  answerAsk(r: AskResponse): boolean
  decidePlan(r: PlanResponse): boolean
  answerMount(r: MountResponse): boolean
  /** 角色名片终态（接受时角色本体由调用方先行创建）。 */
  resolveProposal(sessionId: string, toolUseId: string, status: 'accepted' | 'rejected'): boolean
  /** 定时任务确认名片：create 即授权建任务，dismiss 忽略。 */
  resolveAutotask(
    sessionId: string,
    toolUseId: string,
    action: 'create' | 'dismiss',
    input?: TaskCreateInput
  ): ResolveAutotaskResult
  /** 会话是否正有回合在跑（对话 / 定时任务）。 */
  isBusy(sessionId: string): boolean
  /** 以下三项由远程端（手机）调用，改完通知渲染层同步（正开着被删 / 归档的对话就离开，改了模型就以对话里存的为准）。 */
  setModel(sessionId: string, modelRef: string): boolean
  setArchived(sessionId: string, archived: boolean): boolean
  deleteSession(sessionId: string): void
  deleteTurns: typeof deleteSessionTurns
  rewindList: typeof rewindList
  rewindPreview: typeof rewindPreview
  rewindApply: typeof rewindApply
  rewindUndo: typeof rewindUndo
}
let chatRuntime: ChatRuntime | null = null
export function getChatRuntime(): ChatRuntime | null {
  return chatRuntime
}

/** 装配真实聊天服务和定时回合；重复调用返回同一个实例，窗口和桌面订阅由宿主单独接线。 */
export function initializeChatRuntime(): ChatRuntime {
  if (chatRuntime) return chatRuntime

  // 删绑定任务时清理任务对话，正在跑的一轮由 purgeSession 中止。
  setTaskSessionPurger(purgeSession)
  scheduledRunner = runScheduledTurn
  chatRuntime = {
    send: (req) => sendMessage(req, true),
    insert: (req) => insertMessage(req, true),
    abort: abortTurn,
    answerAsk,
    decidePlan,
    answerMount,
    resolveProposal,
    resolveAutotask,
    isBusy: (sessionId) => busySessions.has(sessionId),
    setModel: (sessionId, modelRef) => {
      const ok = setSessionModel(sessionId, modelRef)
      if (ok) publishRemoteChange({ sessionId, kind: 'model' })
      return ok
    },
    setArchived: (sessionId, archived) => {
      const ok = setArchived(sessionId, archived)
      if (ok && archived) publishRemoteChange({ sessionId, kind: 'archived' })
      return ok
    },
    deleteSession: (sessionId) => {
      deleteSessionAll(sessionId)
      publishRemoteChange({ sessionId, kind: 'deleted' })
    },
    deleteTurns: deleteSessionTurns,
    rewindList,
    rewindPreview,
    rewindApply,
    rewindUndo
  }
  return chatRuntime
}

/**
 * 按「轮」删除对话（同步删除模型上下文）。turnIndices 为 0 基轮下标集合（越界者忽略）。
 * 就地重写 s.messages，并同步：① 重锚/丢弃 notices 边车；② 清理按 toolUseId 记录的边车
 * （proposals/asks/summaries）——只保留仍存活的 tool_use。压缩摘要保留（全部轮都删时才一并清空）。
 * **边界安全**：整轮删除天然不切断 tool_use↔tool_result（一轮的工具调用与其结果同处该轮区间内），
 * 故删除后剩余序列不会出现「有 tool_use 无 tool_result」或反之的悬挂对。
 */
function deleteTurns(s: StoredSession, turnIndices: number[]): void {
  const ranges = turnRanges(s.messages)
  const del = new Set(turnIndices.filter((k) => Number.isInteger(k) && k >= 0 && k < ranges.length))
  if (del.size === 0) return
  // 实测输入量描述的是删轮前的长历史，留着会让下一轮误触发压缩、上下文占用也显示旧值；清掉即回落字符估算。
  s.lastInputTokens = undefined

  const old = s.messages
  // 压缩摘要不随轮删除：它概括的是此前全部内容（两轮之间的摘要落在上一轮的区间末尾，轮内的在本轮中间），
  // 删掉会让模型退回去看更早、更长的原文。删轮只删原文，摘要不动。
  const toDelete = new Set<number>()
  for (const k of del)
    for (let i = ranges[k].start; i < ranges[k].end; i++) if (!isCompactionSummary(old[i])) toDelete.add(i)

  // 删空全部轮：连同前言（压缩摘要等预备区，不属任何轮）一并清空——否则残留孤立前言。
  // 仅「全部轮均被删」才清前言；否则前言随其后仍存活的首轮保留。
  if (del.size === ranges.length) {
    s.messages = []
    s.notices = []
    s.proposals = {}
    s.asks = {}
    s.summaries = {}
    s.delivered = {}
    s.plans = {}
    s.autotasks = {}
    s.todos = []
    s.todoCancelled = []
    s.todoCancelNote = undefined
    // 检查点记录同样按 toolUseId 归属，随轮一并清空（lastKnown / baselines 描述的是磁盘现状，保留）。
    s.checkpoints = {}
    s.background = {}
    s.durations = {}
    cancelBackground(s.id)
    pruneSubagents(s.id, new Set())
    s.updatedAt = Date.now()
    return
  }

  s.messages = old.filter((_, i) => !toDelete.has(i))

  // 待办清单：删掉被删轮里那几次写入的快照，折叠结果即回到删轮前。不能像其余边车那样「只留存活
  // tool_use」——被压缩掉的写入仍是清单现状，那样一删轮就把它们误清了。
  if (s.todos?.length) {
    const gone = new Set<string>()
    for (const i of toDelete) {
      const c = old[i].content
      if (typeof c !== 'string') for (const p of c) if (p.type === 'tool_use') gone.add(p.id)
    }
    s.todos = s.todos.filter((e) => !gone.has(e.id))
    if (s.todoCancelled?.length) {
      const live = new Set(s.todos.map((e) => e.listId))
      s.todoCancelled = s.todoCancelled.filter((x) => live.has(x))
    }
  }

  // 重锚 notices：after 语义 = 提示前方的消息条数（锚点消息下标 = after-1）。
  //  after=0（锚在最前）恒保留；锚点消息被删 → 丢弃该提示；否则新 after = 存活消息中「旧下标 < after」的条数。
  if (s.notices?.length) {
    const survivingBefore = (afterOld: number): number => {
      let c = 0
      for (let i = 0; i < afterOld && i < old.length; i++) if (!toDelete.has(i)) c++
      return c
    }
    s.notices = s.notices
      .filter((nt) => nt.after === 0 || !toDelete.has(nt.after - 1))
      .map((nt) => (nt.after === 0 ? nt : { ...nt, after: survivingBefore(nt.after) }))
  }

  // 清理按 toolUseId 的边车：只保留仍存活消息里出现的 tool_use id。
  const liveUseIds = new Set<string>()
  for (const m of s.messages) {
    if (typeof m.content === 'string') continue
    for (const p of m.content) if (p.type === 'tool_use') liveUseIds.add(p.id)
  }
  const prune = <T>(rec?: Record<string, T>): Record<string, T> | undefined => {
    if (!rec) return rec
    const out: Record<string, T> = {}
    for (const [k, v] of Object.entries(rec)) if (liveUseIds.has(k)) out[k] = v
    return out
  }
  s.proposals = prune(s.proposals)
  s.asks = prune(s.asks)
  s.summaries = prune(s.summaries)
  s.delivered = prune(s.delivered)
  s.plans = prune(s.plans)
  // autotasks 边车随名片 tool_use 存活；删除对话轮不删已创建的定时任务本体（任务独立生命周期，经「定时任务」页管理）。
  s.autotasks = prune(s.autotasks)
  // 被删轮的检查点记录随之丢弃：它们的文件改动留在磁盘上，此后不再能经回滚撤回。
  s.checkpoints = prune(s.checkpoints)
  s.background = prune(s.background)
  s.durations = prune(s.durations)
  // 派发在被删轮次里、仍在后台跑的子智能体就地中止（不再通知）；创建或续聊发生在被删轮次的子智能体整条删除：
  // 删掉的内容模型不再看到，子智能体的上下文里也不该留着。
  cancelBackground(s.id, liveUseIds)
  pruneSubagents(s.id, liveUseIds)
  s.updatedAt = Date.now()
}

/** 推送某会话待办清单的状态（按轮删除 / 回滚 / 用户手动取消之后；不属于任何回合步骤，turnId 为空串）。 */
export function emitTodos(s: StoredSession): void {
  emit('', s.id, { type: 'todos', state: todoState(s.todos, s.todoCancelled) })
}

// 持久化角色名片的终态（接受/拒绝）。名片本体随 Message[] 存活，但终态无处落，
// 故用 StoredSession.proposals 边车按 toolUseId 记录——重开不再退回 pending、不会重复建角色。
// 桌面与手机端（remote/hub.ts）共用；决议后广播 card_resolved，另一端据此把名片收成终态。
function resolveProposal(sessionId: string, toolUseId: string, status: 'accepted' | 'rejected'): boolean {
  const s = getSession(sessionId)
  if (!s) return false
  s.proposals = { ...s.proposals, [toolUseId]: status }
  saveProject(sessionId)
  emit('', sessionId, { type: 'card_resolved', card: 'agent', toolUseId, status })
  return true
}

// 定时任务确认名片的决议——**唯一的授权时刻**（对标 chat:resolve-proposal，但兼建任务本体）。
// create：即在此刻用用户在名片里议定的完整信封调 createTask（创建=授权，此后触发零交互）；成功才落 autotasks
//         边车 {created, taskId} 并存会话；失败不落边车（名片留待用户修正后重试）。
// dismiss：记 {dismissed}，名片转紧凑「已忽略」态，不建任何任务。
// 幂等：同名片重复 create 直接回已建任务（防双提交造双任务）。任务本体持久化于主进程 tasks.json（渲染层写不进）。
function resolveAutotask(
  sessionId: string,
  toolUseId: string,
  action: 'create' | 'dismiss',
  taskInput?: TaskCreateInput
): ResolveAutotaskResult {
  const s = getSession(sessionId)
  if (!s) return { ok: false, error: 'no-session' }

  // 幂等：已创建过则回既有 taskId，绝不重复建任务。
  const prior = s.autotasks?.[toolUseId]
  if (prior?.status === 'created' && prior.taskId)
    return { ok: true, status: 'created', taskId: prior.taskId }

  if (action === 'dismiss') {
    s.autotasks = { ...s.autotasks, [toolUseId]: { status: 'dismissed' } }
    saveProject(sessionId)
    emit('', sessionId, { type: 'card_resolved', card: 'autotask', toolUseId, status: 'dismissed' })
    return { ok: true, status: 'dismissed' }
  }

  // action === 'create'
  if (!taskInput || typeof taskInput !== 'object') return { ok: false, error: 'no-input' }
  // 记下在哪个对话里创建；创建出来独立运行，不绑定这个对话。
  const res: CreateTaskResult = createTask({ ...taskInput, originSessionId: sessionId })
  if (!res.ok) return { ok: false, error: res.error }
  s.autotasks = { ...s.autotasks, [toolUseId]: { status: 'created', taskId: res.task.id } }
  saveProject(sessionId)
  emit('', sessionId, {
    type: 'card_resolved',
    card: 'autotask',
    toolUseId,
    status: 'created',
    taskId: res.task.id
  })
  return { ok: true, status: 'created', taskId: res.task.id }
}

// 以下改对话属性的操作电脑与手机共用；改完都发 publishSessionsChanged，另一端（渲染层 / 手机）据此刷新列表。

/** 切换对话的模型并落库；任务对话同步改任务的模型。对话还没建档返回 false。 */
export function setSessionModel(sessionId: string, modelRef: string): boolean {
  const session = getSession(sessionId)
  if (!session) return false
  session.model = modelRef
  saveProject(sessionId)
  syncTaskModel(sessionId, modelRef)
  // 成员会话：用户亲自选了模型，此后派任务不再按主对话覆盖。
  markMemberSetting(session, 'modelSet')
  publishSessionsChanged()
  return true
}

/** 归档 / 取消归档。进行中的对话不能归档（界面上已灰显，这里兜住点下去时回合才开始的情形）。 */
export function setArchived(sessionId: string, archived: boolean): boolean {
  const ok = !(archived && busySessions.has(sessionId)) && setSessionArchived(sessionId, archived)
  if (ok) publishSessionsChanged()
  return ok
}

/** 删除对话：主对话连同成员会话一并删除；在它里面运行的定时任务改为独立运行（任务与任务对话保留）。 */
export function deleteSessionAll(sessionId: string): void {
  const members = getSession(sessionId)?.members ?? []
  purgeSession(sessionId)
  for (const m of members) purgeSession(m.sessionId)
  releaseTasksOwnedBy(sessionId)
  publishSessionsChanged()
}

/** 删除一个会话的全部痕迹：中止进行中的回合、后台子智能体、网页，删对话文件、检查点与子智能体记录。 */
function purgeSession(sessionId: string): void {
  // 正在进行的回合先中止（本机发起 / 手机端 / 定时任务一视同仁）：不然它在后台照常调模型、执行工具，
  // 结果却写不回已删除的对话。渲染层不必先发 abort——没打开过的对话它根本不知道回合 id。
  const turnId = busySessions.get(sessionId)
  if (turnId) abortTurn(turnId, 'deleted')
  cancelBackground(sessionId)
  closeSessionPages(sessionId)
  deleteStoredSession(sessionId)
  pendingUndo.delete(sessionId)
  removeSessionCheckpoints(sessionId)
  removeSessionSubagents(sessionId)
  forgetRead(sessionId)
  memberDispatches.delete(sessionId)
  pendingHandoffs.delete(sessionId)
  for (const [g, rec] of memberGroupDone) if (rec.mainId === sessionId) memberGroupDone.delete(g)
}

// 用户对权限请求的答复
// 用户对 ask_user 询问的答复（每题的选中项标签或自由输入；null 视为取消）
// 三类答复：先到者生效（键随即删除，后到的一律 false），并广播 interaction_resolved 让其余端收卡。
function answerAsk(payload: AskResponse): boolean {
  const p = pendingAsk.get(payload.key)
  if (!p) return false
  pendingAsk.delete(payload.key)
  p.resolve(payload.answers)
  emit(p.turnId, p.sessionId, {
    type: 'interaction_resolved',
    key: payload.key,
    kind: 'ask',
    answers: payload.answers
  })
  return true
}

function decidePlan(payload: PlanResponse): boolean {
  const p = pendingPlan.get(payload.key)
  if (!p) return false
  pendingPlan.delete(payload.key)
  // 回复要回灌进模型上下文：只认「继续完善」附带的非空字符串。
  const feedback =
    payload.decision === 'keep' && typeof payload.feedback === 'string'
      ? payload.feedback.trim() || undefined
      : undefined
  p.resolve({ decision: payload.decision, ...(feedback ? { feedback } : {}) })
  emit(p.turnId, p.sessionId, {
    type: 'interaction_resolved',
    key: payload.key,
    kind: 'plan',
    decision: payload.decision,
    ...(feedback ? { feedback } : {})
  })
  return true
}

// 用户对「请求挂载工作区」的回应：path=已选目录 / null=暂不挂载。
// 只认真实存在的目录，并（幂等）登记受信根。渲染层传来的路径出自 fs.openFolder（系统目录对话框，
// 已 trustRoot），这里的 trustRoot 只是兜底。拿不到有效目录一律按「暂不挂载」处置。
// 远程通道只会传 null（目录只能在桌面的系统对话框里选，手机端无从提供可信路径）。
function answerMount(payload: MountResponse): boolean {
  const p = pendingMount.get(payload.key)
  if (!p) return false
  pendingMount.delete(payload.key)
  const raw = typeof payload.path === 'string' ? payload.path.trim() : ''
  let dir: string | null = null
  if (raw) {
    const abs = resolvePath(raw)
    try {
      if (statSync(abs).isDirectory()) {
        trustRoot(abs)
        dir = abs
      }
    } catch {
      dir = null
    }
  }
  p.resolve(dir)
  emit(p.turnId, p.sessionId, { type: 'interaction_resolved', key: payload.key, kind: 'mount', path: dir })
  return true
}

// 按「轮」删除对话（同步删上下文）。id 全局唯一 → 按 id。turnIndices 为 0 基轮下标集合。
// 返回删除后重建的展示气泡，供渲染层就地替换——保证展示与落盘一致、重启不变。
// 历史正被改写（见 historyLocked）时不删，回 null，渲染层提示稍后再删。
function deleteSessionTurns(sessionId: string, turnIndices: number[]): DisplayMessage[] | null {
  const s = getSession(sessionId)
  if (!s) return []
  if (historyLocked(sessionId)) return null
  deleteTurns(s, Array.isArray(turnIndices) ? turnIndices : [])
  // 撤销上次回滚会把刚删掉的轮复活，快照就此失效；被删轮的 blob 随之可回收。
  pendingUndo.delete(sessionId)
  saveProject(sessionId)
  collectBlobs(s)
  emitTodos(s)
  return displayOf(s)
}

// ───────── 检查点回滚（对标 Claude Code /rewind）─────────
// 只由用户在回滚面板里触发、不经工具闸门，故自守两条：路径只来自记录、链接跳过
// （见 checkpoints.planRewind）。每次执行都在主进程重算计划，不信任渲染层回传的预览。

// 回滚面板列表屏：每轮自身的改动量（文件数 / +N −M / 是否跑过命令）+ 能否撤销上次回滚。
function rewindList(sessionId: string): { turns: RewindTurnStat[]; canUndo: boolean } {
  const s = getSession(sessionId)
  if (!s) return { turns: [], canUndo: false }
  return { turns: summarizeTurns(s, turnToolIds(s.messages)), canUndo: pendingUndo.has(sessionId) }
}

// 回滚面板详情屏：回到第 turn 轮之前要动哪些文件（动作 / 状态 / +N −M）与哪些命令的影响撤不回。
async function rewindPreview(sessionId: string, turn: number): Promise<{ files: RewindFile[]; commands: string[] } | null> {
  const s = getSession(sessionId)
  if (!s) return null
  const turns = turnToolIds(s.messages)
  if (!Number.isInteger(turn) || turn < 0 || turn >= turns.length) return null
  return publicPreview(await planRewind(s, turns.slice(turn).flat(), s.focusRoot ?? null))
}

// 执行回滚：回到第 turn 轮开始之前。代码类模式恢复文件，对话类模式删掉第 turn 轮起的全部轮。
async function rewindApply(req: ChatRewindApplyRequest): Promise<
  | {
      ok: true
      messages: DisplayMessage[]
      restored: string[]
      skipped: { rel: string; reason: RewindStatus | 'error' }[]
    }
  | { ok: false; error: 'no-session' | 'busy' | 'bad-turn' }
> {
  const s = getSession(req.sessionId)
  if (!s) return { ok: false, error: 'no-session' }
  if (historyLocked(s.id)) return { ok: false, error: 'busy' }
  const turns = turnToolIds(s.messages)
  const k = req.turn
  if (!Number.isInteger(k) || k < 0 || k >= turns.length) return { ok: false, error: 'bad-turn' }
  const withCode = req.mode === 'both' || req.mode === 'code'
  const withConversation = req.mode === 'both' || req.mode === 'conversation'

  rewinding.add(s.id)
  try {
    // 撤销快照：deleteTurns 对这些字段一律整体重新赋值（不原地改），故存引用即可；
    // lastKnown 会被 applyFiles 原地更新，须拷一份。
    const undo: RewindUndo = {
      files: [],
      state: {
        messages: s.messages,
        notices: s.notices,
        proposals: s.proposals,
        asks: s.asks,
        summaries: s.summaries,
        delivered: s.delivered,
        background: s.background,
        durations: s.durations,
        plans: s.plans,
        autotasks: s.autotasks,
        todos: s.todos,
        todoCancelled: s.todoCancelled,
        checkpoints: s.checkpoints,
        lastKnown: s.lastKnown ? { ...s.lastKnown } : undefined,
        restoreNote: s.restoreNote,
        lastInputTokens: s.lastInputTokens
      }
    }

    let restored: string[] = []
    let skipped: { rel: string; reason: RewindStatus | 'error' }[] = []
    if (withCode) {
      const plan = await planRewind(s, turns.slice(k).flat(), s.focusRoot ?? null)
      const force = new Set((req.force ?? []).filter((p): p is string => typeof p === 'string'))
      const r = await applyFiles(s, plan, force)
      restored = r.restored
      skipped = r.skipped
      undo.files = r.undo
    }

    if (withConversation) {
      deleteTurns(
        s,
        Array.from({ length: turns.length - k }, (_, i) => k + i)
      )
      // 实测输入量描述的是删轮前的长历史，留着会让下一轮误触发压缩；清掉即回落字符估算。
      s.lastInputTokens = undefined
    } else if (restored.length) {
      // 仅恢复代码：对话还记着被撤销的改动——下一条消息把回滚说明带给模型，并在对话流里留一条提示。
      const note = buildRestoreNote(restored)
      s.restoreNote = s.restoreNote ? `${s.restoreNote}\n\n${note}` : note
      s.notices = [
        ...(s.notices ?? []),
        { after: s.messages.length, kind: 'notice', code: 'restored' }
      ]
    }

    if (withConversation || restored.length) pendingUndo.set(s.id, undo)
    s.updatedAt = Date.now()
    saveProject(s.id)
    if (withConversation) emitTodos(s)
    return { ok: true, messages: displayOf(s), restored, skipped }
  } finally {
    rewinding.delete(s.id)
    // 回滚期间结束的后台子智能体：此刻再为它们起轮。推迟一拍，让回滚结果先于新一轮的事件到达渲染层
    //（渲染层拿到结果会整份替换气泡）。
    setTimeout(() => wakeForNotices(s.id), 0)
  }
}

// 撤销上次回滚：文件写回回滚前的字节（只动回滚后未再被改过的），对话状态整体换回快照。
async function rewindUndo(sessionId: string): Promise<
  | { ok: true; messages: DisplayMessage[]; restored: string[]; skipped: string[] }
  | { ok: false; error: 'no-undo' | 'busy' }
> {
  const s = getSession(sessionId)
  const undo = pendingUndo.get(sessionId)
  if (!s || !undo) return { ok: false, error: 'no-undo' }
  if (historyLocked(sessionId)) return { ok: false, error: 'busy' }
  rewinding.add(sessionId)
  try {
    pendingUndo.delete(sessionId)
    const r = await undoFiles(undo.files)
    Object.assign(s, undo.state)
    s.updatedAt = Date.now()
    saveProject(sessionId)
    collectBlobs(s)
    emitTodos(s)
    return { ok: true, messages: displayOf(s), restored: r.restored, skipped: r.skipped }
  } finally {
    rewinding.delete(sessionId)
    setTimeout(() => wakeForNotices(sessionId), 0)
  }
}
