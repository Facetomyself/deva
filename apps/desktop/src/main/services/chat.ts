import type {
  AskOption,
  AskQuestion,
  AskResponse,
  AttachmentChip,
  AutoRetryReason,
  ChatCompactRequest,
  ChatCreateSessionRequest,
  ChatInsertRequest,
  ChatInsertResult,
  ChatModelConfig,
  ChatRenameSessionRequest,
  ChatRewindApplyRequest,
  ChatSendRequest,
  ChatSetArchivedRequest,
  ChatSetEffortRequest,
  ChatSetFocusRequest,
  ChatSetModelRequest,
  ChatStreamEvent,
  DisplayMessage,
  MountResponse,
  PlanResponse,
  ResolveAutotaskResult,
  TakenInserts
} from '../../shared/chat-protocol'
import { ipcMain, type BrowserWindow } from 'electron'
import { isEn } from '../locale'
import { isEffortLevel } from '../providers/types'
import { attachmentImage } from './attachment-image'
import { wakeForNotices } from './background-tasks'
import { setBrowserSessionBusyCheck, setSessionAborter } from './browser'
import { onChatEvent, onSessionsChanged, publishSessionsChanged } from './chat-bus'
import { loadDisplay, displayOf } from './chat-display'
import { markMemberSetting, setMemberFolder, setOpenTasks } from './chat-members'
import { deleteSessionAll, emitTodos, initializeChatRuntime, setArchived, setSessionModel } from './chat-runtime'
import {
  activeTurns,
  busySessions,
  busySince,
  backgroundSubagents,
  pendingUndo,
  genId,
  getWindow,
  setWindowGetter,
  emit,
  compacting,
  historyLocked
} from './chat-state'
import { deriveTitle, ensureSession, getSession, listSessions, save as saveProject, type ChatSessionMeta } from './chat-store'
import { abortTurn, compactWithStatus, insertMessage, sendMessage, takeInserts } from './chat-turns'
import type { CompactStatus } from './compaction'
import { trustRoot } from './fs-guard'
import { resolveModelRef } from './model-resolve'
import { personaWorkspace } from './role-home'
import type { TaskCreateInput } from './tasks-types'
import { activeTodoList, todoUserCancelNote, todoState, type TodoState } from './todos'

export { getChatRuntime, initializeChatRuntime, runScheduledTask, type ChatRuntime } from './chat-runtime'
export { hasActiveTurns, settleActiveTurns } from './chat-state'
export type { ScheduledTurnResult } from './chat-turns'

/**
 * 会话编排（Agent 主循环）。
 * 流式生成 → 收集工具调用 → 过权限闸门 → 执行 → 结果回灌 → 继续，直至模型不再调用工具
 * （主轮、子智能体与定时任务都不设步数上限，对标 Claude Code 的 agentic loop）。
 * 对话历史只存主进程（sessions），渲染层仅发新用户文本；工具/密钥/文件访问都在主进程内闭环。
 */

// 聊天 IPC 协议类型定义在 shared/chat-protocol.ts；其它主进程模块仍可从这里取。
export type {
  AskOption,
  AskQuestion,
  AskResponse,
  AttachmentChip,
  AutoRetryReason,
  ChatInsertRequest,
  ChatInsertResult,
  ChatModelConfig,
  ChatSendRequest,
  ChatStreamEvent,
  DisplayMessage,
  MountResponse,
  PlanResponse,
  ResolveAutotaskResult
}

/** 用户自定的对话标题上限（列表里单行省略显示，再长也看不全）。 */
const TITLE_MAX = 100

export function registerChatIpc(getWin: () => BrowserWindow | null): void {
  setWindowGetter(getWin)
  // 渲染层只是总线的一个订阅者（远程通道是另一个，见 remote/hub.ts）。
  // 退出收尾期间窗口可能已销毁：此时回合仍在补结果 / 落盘，事件丢掉即可，绝不能因 send 抛错打断收尾。
  onChatEvent((p) => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    win.webContents.send('chat:event', p)
  })
  onSessionsChanged(() => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    win.webContents.send('chat:sessions-changed')
  })
  const runtime = initializeChatRuntime()

  ipcMain.handle('chat:send', (_e, payload: ChatSendRequest) => sendMessage(payload))

  // 回合进行中插入消息（见 insertMessage）；撤回全部待送达的，返回合并后的原文与附件供放回输入框。
  ipcMain.handle('chat:insert', (_e, payload: ChatInsertRequest): ChatInsertResult => insertMessage(payload))
  ipcMain.handle(
    'chat:withdraw-inserts',
    (_e, sessionId: string): TakenInserts => takeInserts(sessionId) ?? { text: '', attachments: [] }
  )

  /* 说明：persona 绑定与聚焦工作区都已由 ensureSession 落在 session 上，runTurn 内直接读取 —— 见其实现。 */

  // 手动压缩（输入框 /compact）：立即压缩历史，只回发 compacted + done，无后续模型轮。
  ipcMain.handle(
    'chat:compact',
    async (_e, payload: ChatCompactRequest): Promise<{ turnId: string }> => {
      const { sessionId, model } = payload
      // 历史正被改写（见 historyLocked）：不压，请求直接失败，渲染层撤掉占位并提示原因。
      if (historyLocked(sessionId))
        throw new Error(
          isEn()
            ? 'This chat is busy right now. Try compacting again when it finishes.'
            : '这个对话正在进行中，请等它结束后再压缩。'
        )
      const turnId = genId('turn')
      const controller = new AbortController()
      activeTurns.set(turnId, controller)
      compacting.add(sessionId)
      try {
        const session = getSession(sessionId)
        let status: CompactStatus = 'none'
        let message: string | undefined
        if (session) {
          // 与 runTurn 同源：按**本对话**模型（快照固定）压缩——窗口与摘要模型都用它，删除则回落 model。
          const r = await compactWithStatus(turnId, sessionId, {
            session,
            model: resolveModelRef(session.model, model),
            signal: controller.signal
          })
          status = r.status
          message = r.message
          if (status === 'failed') console.warn('[compaction] 手动压缩失败：', message)
          if (status === 'compacted') {
            // 压缩不删消息，被压的轮照样能回滚（检查点保留）；撤销快照是改写前的整份历史，随之作废。
            pendingUndo.delete(sessionId)
            saveProject(sessionId)
          }
        }
        emit(turnId, sessionId, { type: 'compacted', scope: 'manual', status, message })
      } catch (e) {
        emit(turnId, sessionId, {
          type: 'compacted',
          scope: 'manual',
          status: 'failed',
          message: (e as Error)?.message ?? String(e)
        })
      } finally {
        activeTurns.delete(turnId)
        compacting.delete(sessionId)
        emit(turnId, sessionId, { type: 'done', stopReason: 'end_turn' })
        // 压缩期间结束的后台子智能体：此刻再为它们起轮。
        wakeForNotices(sessionId)
      }
      return { turnId }
    }
  )

  // 立即建档一条空对话（对话优先外壳：与角色开启新对话时即落盘，重启仍在）。
  // 与 chat:send 的惰性建档同源（ensureSession + saveProject），差别只在「首发前就落盘」——
  // 让空对话作为真实持久化会话进入左侧列表、跨重启存活。旧 AppShell 不调用此接口，仍走惰性路径。
  ipcMain.handle(
    'chat:create-session',
    (_e, payload: ChatCreateSessionRequest): { ok: true } => {
      const { sessionId, personaId, focusRoot, modelRef } = payload
      // 角色设了工作区（见 role-home.ts personaWorkspace）且调用方没指定：新对话一开始就挂载它。
      ensureSession(sessionId, { personaId, focusRoot: focusRoot ?? personaWorkspace(personaId), model: modelRef })
      saveProject(sessionId)
      return { ok: true }
    }
  )

  // 对话输入框切换模型：立即落库到本对话（此前只写渲染层覆盖层、随下一次发送才落库，切了没发重启即丢）。
  // 尚未建档的惰性会话查不到 → 不建档，模型仍由覆盖层随首发落库。不改 updatedAt（换模型不算新活动）。
  // ok = 对话已建档、已落库（渲染层据此撤掉本地覆盖层，此后以主进程为准）；惰性未建档的返回 false。
  // 任务对话里切换模型 = 改任务的模型（两边同步，见 tasks.ts syncTaskModel）。
  ipcMain.handle('chat:set-model', (_e, payload: ChatSetModelRequest): { ok: boolean } => ({
    ok: setSessionModel(payload.sessionId, payload.modelRef)
  }))

  // 对话输入框切换思考等级：同 set-model——立即落库到本对话，惰性未建档的会话跳过（随首发落库），不改 updatedAt。
  ipcMain.handle('chat:set-effort', (_e, payload: ChatSetEffortRequest): { ok: true } => {
    const session = getSession(payload.sessionId)
    if (session && isEffortLevel(payload.effort)) {
      session.effort = payload.effort
      saveProject(payload.sessionId)
      markMemberSetting(session, 'effortSet')
    }
    return { ok: true }
  })

  // 挂载 / 卸载聚焦工作区：立即落库到本对话。此前只写渲染层覆盖层、随下一次桌面发送才落库——
  // 挂载后首条消息若来自远程通道（飞书等，不带 focusRoot），这一轮就读不到工作区；切了没发重启也会丢。
  // 惰性会话同 set-model：查不到则不建档，仍由覆盖层随首发落库。不改 updatedAt。
  ipcMain.handle('chat:set-focus', (_e, payload: ChatSetFocusRequest): { ok: true } => {
    const session = getSession(payload.sessionId)
    if (session?.parentId) {
      setMemberFolder(session, payload.focusRoot)
      return { ok: true }
    }
    if (session) {
      session.focusRoot = payload.focusRoot
      saveProject(payload.sessionId)
    }
    return { ok: true }
  })

  // 重命名对话：写入标题并落盘（索引随之刷新），回传最终标题。清空即恢复自动标题——同首发时的派生规则，
  // 取首条用户消息（展示用原文，不含随消息附带的提醒）。会话对象全局缓存为同一份，回合进行中改名也不会被
  // 这一轮后续落盘冲掉；自动派生只在标题为空时写，不会覆盖用户起的名字。不改 updatedAt（改名不算新活动，
  // 列表顺序不变）。尚未建档的惰性会话查不到 → null。
  ipcMain.handle(
    'chat:rename-session',
    (_e, payload: ChatRenameSessionRequest): { title: string } | null => {
      const session = getSession(payload.sessionId)
      if (!session) return null
      let title = String(payload.title ?? '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX)
      if (!title) {
        const first = displayOf(session).find((m) => m.role === 'user' && !m.notify)
        if (first?.role === 'user')
          title = deriveTitle(first.text) || deriveTitle(first.attachments.map((a) => a.name).join(' '))
      }
      session.title = title
      saveProject(payload.sessionId)
      publishSessionsChanged()
      return { title }
    }
  )

  // 归档 / 取消归档：只改这一个标记并落盘，不动 updatedAt（列表顺序不变）。尚未建档的惰性会话回 ok:false。
  // 进行中的对话不能归档（界面上菜单已灰显；这里兜住菜单打开后回合才开始的情形，返回 false 渲染层即按清单复原）。
  ipcMain.handle('chat:set-archived', (_e, payload: ChatSetArchivedRequest): { ok: boolean } => ({
    ok: setArchived(payload.sessionId, payload.archived === true)
  }))

  // 左侧会话列表：一次列全部（对话无项目/分桶概念）。IPC 仍收 workspaceRoot 以兼容渲染层调用签名，忽略即可。
  ipcMain.handle(
    'chat:list-sessions',
    (_e, _workspaceRoot: string | null): ChatSessionMeta[] => {
      // 成员会话（见 members.ts，带 parentId）也一并交出：渲染层不列进左侧列表，但打开成员对话时要读它的模型、
      // 思考等级与文件夹；它的文件夹同样要在下面登记受信根（输入框的 git 小部件要用）。
      const list = listSessions()
      // 重开后恢复「已挂载项目」的受信根：trustRoot 是内存态、随重启清空（见 fs-guard），而 focusRoot 是
      // 持久化的对话属性——若不在此重新登记，重启后带挂载目录的会话一渲染就调 git:status / fs:*，其首行
      // assertInside 因根未受信而抛「拒绝访问」，表现为「git 丢失 + Error occurred in handler for 'git:status'」。
      // 这是渲染层能拿到 focusRoot 的最早时刻（渲染任何对话 / GitWidget 前必先经此列表），在此登记即无竞态。
      // 语义等同 IDE 重开时恢复已打开的项目文件夹（受信根只约束渲染层 IPC，与 Agent 文件工具无关）。
      for (const m of list) {
        if (typeof m.focusRoot === 'string' && m.focusRoot.trim()) trustRoot(m.focusRoot)
      }
      return list
    }
  )

  ipcMain.handle(
    'chat:load-session',
    (_e, sessionId: string, _workspaceRoot: string | null): DisplayMessage[] => loadDisplay(sessionId)
  )

  // 对话记录里的图片附件：缩略图或原图（见 attachment-image.ts）。
  ipcMain.handle('chat:attachment-image', (_e, sessionId: unknown, ref: unknown, full: unknown): string | null =>
    attachmentImage(sessionId, ref, full)
  )

  // 载入历史 + 进行中回合的 turnId（无则 null），同一时刻取出：渲染层据此接上别处发起、仍在跑的一轮——
  // 此后到达的流事件都晚于这份快照，不会漏掉 done 而永远停在「进行中」。
  ipcMain.handle(
    'chat:attach-session',
    (
      _e,
      sessionId: string
    ): { messages: DisplayMessage[]; turnId: string | null; startedAt: number | null } => ({
      messages: loadDisplay(sessionId),
      turnId: busySessions.get(sessionId) ?? null,
      // 进行中这一轮的开始时刻：渲染层中途接上时据此续上计时，而不是从接上那一刻重新算。
      startedAt: busySince.get(sessionId) ?? null
    })
  )

  ipcMain.handle(
    'chat:resolve-proposal',
    (_e, sessionId: string, toolUseId: string, status: 'accepted' | 'rejected'): { ok: boolean } => ({
      ok: runtime.resolveProposal(sessionId, toolUseId, status)
    })
  )

  ipcMain.handle(
    'chat:resolve-autotask',
    (
      _e,
      sessionId: string,
      toolUseId: string,
      action: 'create' | 'dismiss',
      taskInput?: TaskCreateInput
    ): ResolveAutotaskResult => runtime.resolveAutotask(sessionId, toolUseId, action, taskInput)
  )

  // 删除某会话（含会话级授权）。id 全局唯一 → 按 id 删。主对话连同它的成员会话一并删除；在它里面运行的定时任务
  // 改为独立运行（任务与任务对话保留，任务对话回到左侧列表）。
  ipcMain.handle(
    'chat:delete-session',
    (_e, sessionId: string, _workspaceRoot: string | null): { ok: true } => {
      deleteSessionAll(sessionId)
      return { ok: true }
    }
  )

  // 移除成员（成员卡片的「移除成员」）：不再派任务给它，正在进行的任务中止；成员会话保留（可从名单里恢复）。
  // 主智能体经下一次随消息下发的名单更新得知。
  ipcMain.handle(
    'chat:remove-member',
    (_e, sessionId: string, memberSessionId: string): { ok: boolean } => {
      const main = getSession(sessionId)
      const ref = main?.members?.find((m) => m.sessionId === memberSessionId && !m.removed)
      if (!main || !ref) return { ok: false }
      ref.removed = true
      setOpenTasks(ref, [])
      saveProject(sessionId)
      const turnId = busySessions.get(memberSessionId)
      if (turnId) abortTurn(turnId)
      publishSessionsChanged()
      return { ok: true }
    }
  )

  // 内置浏览器：对话有进行中的回合或后台子智能体时，后台网页不按短时限回收（见 browser/pages.ts BACKGROUND_CLOSE_MS）
  setBrowserSessionBusyCheck(
    (sessionId) => busySessions.has(sessionId) || [...backgroundSubagents.values()].some((b) => b.sessionId === sessionId)
  )

  // 内置浏览器窗口里的「停止」：按对话停止它正在进行的回合
  setSessionAborter((sessionId) => {
    const turnId = busySessions.get(sessionId)
    if (!turnId) return false
    abortTurn(turnId)
    return true
  })

  ipcMain.handle('chat:abort', (_e, turnId: string): { ok: true } => {
    abortTurn(turnId)
    return { ok: true }
  })

  // 停止一个后台运行的子智能体（Task 卡上的停止键）。toolUseId = 开出它的那次调用 id（即卡片 id）。
  // 它照常收尾：Task 卡定格「已停止」，结论（含停止前的输出）随下一轮交给模型，但不为此自动起一轮。
  ipcMain.handle(
    'chat:stop-subagent',
    (_e, sessionId: string, toolUseId: string): { ok: boolean } => {
      const b = backgroundSubagents.get(toolUseId)
      if (!b || b.sessionId !== sessionId) return { ok: false }
      b.stoppedByUser = true
      b.controller.abort()
      return { ok: true }
    }
  )

  // 保留 workspaceRoot 占位签名；历史改写共用运行时的互斥检查。
  ipcMain.handle(
    'chat:delete-turns',
    (_e, sessionId: string, _workspaceRoot: string | null, turnIndices: number[]): DisplayMessage[] | null =>
      runtime.deleteTurns(sessionId, turnIndices)
  )

  // 待办清单：渲染层切到某会话时拉取当前状态（此后的变化都走 todos 事件推送）。
  ipcMain.handle('chat:todos', (_e, sessionId: string): TodoState => {
    const s = getSession(sessionId)
    return todoState(s?.todos, s?.todoCancelled)
  })

  // 用户在面板里手动取消当前清单（不再进行）：胶囊收起，并在下一条消息里告知模型（todoCancelNote）。
  // 回合进行中不受理——模型正在推进它，取消了也会被立刻写回；界面上此时按钮不可点，先停止任务再取消。
  ipcMain.handle('chat:todo-cancel', (_e, sessionId: string): TodoState => {
    const s = getSession(sessionId)
    if (!s) return { active: null }
    const cur = activeTodoList(s.todos, s.todoCancelled)
    if (cur && !busySessions.has(sessionId)) {
      s.todoCancelled = [...(s.todoCancelled ?? []), cur.id]
      s.todoCancelNote = todoUserCancelNote(cur)
      saveProject(sessionId)
      emitTodos(s)
    }
    return todoState(s.todos, s.todoCancelled)
  })

  ipcMain.handle('chat:rewind-list', (_e, sessionId: string) => runtime.rewindList(sessionId))
  ipcMain.handle('chat:rewind-preview', (_e, sessionId: string, turn: number) => runtime.rewindPreview(sessionId, turn))
  ipcMain.handle('chat:rewind-apply', (_e, req: ChatRewindApplyRequest) => runtime.rewindApply(req))
  ipcMain.handle('chat:rewind-undo', (_e, sessionId: string) => runtime.rewindUndo(sessionId))

  ipcMain.handle('chat:ask-response', (_e, payload: AskResponse): { ok: boolean } => ({
    ok: runtime.answerAsk(payload)
  }))

  ipcMain.handle('chat:plan-response', (_e, payload: PlanResponse): { ok: boolean } => ({
    ok: runtime.decidePlan(payload)
  }))

  ipcMain.handle('chat:mount-response', (_e, payload: MountResponse): { ok: boolean } => ({
    ok: runtime.answerMount(payload)
  }))
}
