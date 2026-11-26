import type { ChatStreamEvent, DisplayMessage } from './chat-protocol'
import type { EffortLevel } from './effort'

/** 会话元信息（左侧列表用，与 chat-store.ts 对齐）。 */
export interface ChatSessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** 绑定的 persona id（对话优先外壳：驱动列表头像/主题色）。旧壳会话缺省。 */
  personaId?: string
  /** 聚焦工作区绝对路径；null = 全机通用助手。 */
  focusRoot?: string | null
  /** 本对话模型引用 `"providerId:modelId"`；空串/缺省 = 跟随全局默认。见 ChatSendRequest.modelRef。 */
  model?: string
  /** 本对话思考等级；缺省 = 尚未定格（渲染层打开时定格为「最近使用」）。 */
  effort?: EffortLevel
  /** 已归档（不在左侧对话列表里显示）；缺省 = 未归档。 */
  archived?: boolean
  /** 项目成员名单（主对话；含已移除的，见 MemberMeta.removed）。 */
  members?: MemberMeta[]
  /** 成员会话所属的主对话 id（成员会话不进左侧列表，故列表里的对话恒无此字段）。 */
  parentId?: string
}

/** 项目成员（与 services/members.ts 的 MemberRef 对齐）。 */
export interface MemberMeta {
  /** 成员会话 id（也是生成头像的种子）。 */
  sessionId: string
  name: string
  /** created = 主智能体创建（用主对话角色的设定）；mention = 用户 @ 加入的角色。 */
  origin: 'created' | 'mention'
  /** 设定来源角色 id。 */
  personaId: string
  /** 负责的文件夹（绝对路径）；null = 没有文件夹（不跟随主对话）。以成员会话的 focusRoot 为准。 */
  root: string | null
  duty: string
  /** 头像形状（主智能体建的成员创建时存下；@ 加入的与老成员没有）。 */
  shape?: string
  addedAt: number
  removed?: boolean
  /** 最近一次派来的任务标题。 */
  task?: string
  /** 最近一次结论（截断）与结局。 */
  last?: { text: string; at: number; status: 'done' | 'failed' | 'stopped'; task?: string }
  /** 用户在成员会话里亲自选过模型 / 思考等级（此后不再跟随主对话）。 */
  modelSet?: boolean
  effortSet?: boolean
}

/** 回滚列表里每轮自身的改动量（与 services/checkpoints.ts 的 RewindTurnStat 对齐）。 */
export interface RewindTurnStat {
  turn: number
  fileCount: number
  added: number
  removed: number
  /** 含近似 / 二进制 / 过大等无法精确计数的文件。 */
  approx: boolean
  hasExec: boolean
}

/** 回滚对单个文件的动作：写回 / 删除（目标是不存在）/ 重建（现已不存在）/ 无需改动。 */
export type RewindAction = 'restore' | 'delete' | 'create' | 'none'
/** ok=可回滚；conflict=回滚点之后被外部改过；link=链接文件跳过。 */
export type RewindStatus = 'ok' | 'conflict' | 'link' | 'blob_missing' | 'too_large'

/** 回滚预览里的一个文件（只有摘要，不含内容；与 services/checkpoints.ts 的 RewindFile 对齐）。 */
export interface RewindFile {
  path: string
  rel: string
  action: RewindAction
  status: RewindStatus
  added?: number
  removed?: number
  approx?: boolean
  binary?: boolean
}

export interface RewindPreview {
  files: RewindFile[]
  /** 目标轮起跑过的命令：其影响无法撤销，面板只提示条数不逐条列出。 */
  commands: string[]
}

/** 回滚模式：both=代码与对话 / conversation=仅对话 / code=仅代码。 */
export type RewindMode = 'both' | 'conversation' | 'code'

export interface RewindApplyRequest {
  sessionId: string
  turn: number
  mode: RewindMode
  /** 勾选「仍然覆盖」的冲突文件路径（RewindFile.path）。 */
  force?: string[]
}

export type RewindApplyResult =
  | {
      ok: true
      messages: DisplayMessage[]
      restored: string[]
      skipped: { rel: string; reason: RewindStatus | 'error' }[]
    }
  | { ok: false; error: 'no-session' | 'busy' | 'bad-turn' }

export type RewindUndoResult =
  | { ok: true; messages: DisplayMessage[]; restored: string[]; skipped: string[] }
  | { ok: false; error: 'no-undo' | 'busy' }

/** 定时任务类型（与 services/tasks-types.ts 对齐）。 */
export type TaskStatus = 'active' | 'paused' | 'completed' | 'error'
export interface TaskSchedule {
  kind: 'once' | 'recurring'
  at?: string
  cron?: string
  tz: string
}
export interface TaskAuthorization {
  personaId: string | null
  modelRef: string | null
}
export interface TaskRun {
  firedAt: number
  finishedAt?: number
  status: 'ok' | 'error' | 'skipped' | 'aborted'
  summary?: string
  error?: string
  /** 绑定任务这次交给主角色的结果（见 services/handoff.ts）；没交接则缺省。 */
  handoff?: { summary: string; needsAction: boolean }
}
export interface TaskRecord {
  id: string
  title: string
  prompt: string
  schedule: TaskSchedule
  auth: TaskAuthorization
  sessionId: string
  /** 运行方式「在会话中运行」所在的会话 id（见 services/tasks-types.ts）；缺省 = 独立运行。 */
  ownerSessionId?: string
  /** 在哪个对话里创建的（对话里的确认名片）。 */
  originSessionId?: string
  status: TaskStatus
  createdAt: number
  updatedAt: number
  lastRunAt: number | null
  nextRunAt: number | null
  consecutiveErrors: number
  runs: TaskRun[]
}
export interface TaskCreateInput {
  title: string
  prompt: string
  schedule: TaskSchedule
  auth: TaskAuthorization
  /** 在哪个对话里创建的（由主进程 resolveAutotask 填，渲染层不传）。 */
  originSessionId?: string
  /** 运行方式：在这个会话中运行；缺省 = 独立运行。 */
  ownerSessionId?: string
}
export interface TaskUpdateInput {
  id: string
  title?: string
  prompt?: string
  schedule?: TaskSchedule
  auth?: Partial<TaskAuthorization>
  /** 运行方式：会话 id = 在该会话中运行，null = 独立运行，缺省 = 不改。 */
  ownerSessionId?: string | null
}
/** 创建结果：成功带记录，失败带稳定错误码（渲染层据此本地化）。 */
export type CreateTaskResult =
  | { ok: true; task: TaskRecord }
  | { ok: false; error: 'invalid-input' | 'invalid-tz' | 'invalid-cron' | 'invalid-once' | 'expired' }

/** 日程预览结果（确认名片实时校验，与 services/tasks.ts 的 PreviewScheduleResult 对齐）。 */
export type PreviewScheduleResult =
  | { ok: true; description: string; nextRunAt: number | null }
  | { ok: false; error: 'invalid-input' | 'invalid-tz' | 'invalid-cron' | 'invalid-once' }

export interface ChatEventPayload {
  turnId: string
  sessionId: string
  event: ChatStreamEvent
}
