/** 技能记录（与 services/skills.ts 的 SkillRecord 对齐）。 */
export interface SkillRecord {
  id: string
  name: string
  description: string
  trigger: string
  allowedTools: string[]
  license: string
  compatibility: string
  metadata: Record<string, string>
  instructions: string
  enabled: boolean
  /** 可用角色（角色 id）；null = 全部角色。内置技能恒为 null。 */
  roles: string[] | null
  /** 来源：`builtin` = 应用内置（不可删/编辑、恒启用）；`custom` = 用户创建/导入。 */
  source: 'builtin' | 'custom'
}

/** 技能导入结果（skills:import 回传；error 为稳定错误码，渲染层据此本地化）。 */
export interface SkillImportResult {
  ok: boolean
  id?: string
  name?: string
  error?: string
}

/** Agent 提示词记录（与 services/personas.ts 的 PersonaRecord 对齐）。 */
export interface PersonaRecord {
  id: string
  name: string
  /** 专长，一句话（frontmatter description）。 */
  description: string
  /** 头像 spec（Humation AvatarSpec 的 JSON 字符串；空 → 由 id 确定性生成）。 */
  avatar: string
  /**
   * 自定义头像图片（data URI；空串 = 无，回落生成头像）。**只读派生字段**：真源是主进程磁盘上的
   * 图片文件，不入 upsert 入参——改图走 setAvatarImage / clearAvatarImage。
   */
  avatarImage: string
  /** 偏好模型引用 `"providerId:modelId"`；空串 = 跟随主对话默认。 */
  model: string
  /** 工作区（绝对路径；空串 = 用角色的默认工作区）。设了则绑定此角色的新对话一开始就挂载它。 */
  workspace: string
  /** 正文 = 追加进主智能体系统提示词的内容。 */
  prompt: string
  enabled: boolean
}

/** 本机用户资料（与 services/profile.ts 对齐）。 */
export interface UserProfile {
  /** 头像 spec（Humation AvatarSpec 的 JSON 字符串；空 → 固定 seed 默认头像）。 */
  avatar: string
  /** 自定义头像图片（data URI；空串 = 无）。只读派生字段，改图走 profile.setAvatarImage。 */
  avatarImage: string
}

/** 记忆类型：user 用户 / feedback 做事方式 / project 进展 / reference 资料（与 services/memory.ts 对齐）。 */
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'
/** 记忆条目（全局 / 角色 / 项目共用，与 services/memory.ts 对齐）。 */
export interface MemoryEntry {
  id: string
  type: MemoryType
  /** 一句话标题（进索引）。 */
  title: string
  /** 正文，可为空。 */
  body: string
  createdAt: number
  updatedAt: number
}
export interface MemorySnapshot {
  entries: MemoryEntry[]
  /** 当前索引总字数（与随消息下发同一口径）。 */
  used: number
  /** 索引总字数上限：写入后超出即拒写。 */
  budget: number
  maxEntries: number
  maxTitle: number
  maxBody: number
}
/** 记忆作用域：省略 = 全局；字符串 = 该工作区的项目记忆；`{ personaId }` = 该角色的记忆。 */
export type MemoryScopeArg = string | { personaId: string }
export type MemoryErrorCode = 'empty' | 'tooLong' | 'full' | 'budget' | 'notFound' | 'duplicate' | 'badType'
export type MemoryIpcResult = { ok: true; snapshot: MemorySnapshot } | { ok: false; code: MemoryErrorCode }

/** Agent 提示词新建/更新入参（有 id 覆盖，无 id 新建）。 */
export interface PersonaUpsertInput {
  id?: string
  name: string
  description?: string
  avatar?: string
  model?: string
  /** 工作区（空串 = 改回默认工作区；缺省 = 保持原值）。 */
  workspace?: string
  prompt?: string
  enabled?: boolean
}

/** MCP「线缆类型」（与 services/mcp.ts + mcp-config.ts 对齐）。 */
export type McpTransport = 'stdio' | 'sse' | 'http'
export type McpStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error'
  | 'needs_config'
  | 'needs_secret'
/** env / header 值：明文字符串，或指向加密库的引用（真实值在主进程 `mcp:<id>:<secretRef>`）。 */
export type McpValue = string | { secretRef: string }

/** MCP 服务配置（不含运行期状态；`mcp:get` 返回此形状）。 */
export interface McpServerConfig {
  id: string
  name: string
  description: string
  transport: McpTransport
  command?: string
  args?: string[]
  env?: Record<string, McpValue>
  url?: string
  headers?: Record<string, McpValue>
}

/** MCP 新建/更新入参（有 id 覆盖，无 id 新建）。 */
export interface McpServerInput {
  id?: string
  name: string
  description?: string
  transport: McpTransport
  command?: string
  args?: string[]
  env?: Record<string, McpValue>
  url?: string
  headers?: Record<string, McpValue>
  enabled?: boolean
}

/** 回渲染层的合并视图（配置 + 启用态 + 运行期状态）。 */
export interface McpServerView extends McpServerConfig {
  enabled: boolean
  /** 可用角色（角色 id）；null = 全部角色。 */
  roles: string[] | null
  scope: 'global'
  source: 'custom'
  status: McpStatus
  toolCount: number
  lastError: string | null
  /** status=needs_secret 时尚未填写的密钥字段名。 */
  missingSecrets: string[]
  /** 已发现工具的展示清单（原始名 + 命名空间化名 + 描述）。 */
  tools: { name: string; fqName: string; description: string }[]
}

/** 服务商探针「线缆类型」（与 services/provider.ts 对齐）。 */
export interface ProbeConfig {
  adapter: 'anthropic' | 'openai' | 'responses'
  providerId: string
  baseURL: string
}

export interface ProviderListModelsResult {
  ok: boolean
  models?: string[]
  kind?: string
  message?: string
}

/** IM 机器人（远程通道）状态，与 services/remote/index.ts 的 BotView / ScanEvent 对齐。 */
export type BotPlatform = 'feishu' | 'telegram' | 'web'
export type BotReplyMode = 'stream' | 'final'
/** 回复范围：all 全部 / personas 选中角色的对话 / sessions 选中的对话（两份清单都保留，切模式不丢）。 */
export interface BotReplyScope {
  mode: 'all' | 'personas' | 'sessions'
  personas: string[]
  sessions: string[]
}
export interface BotView {
  id: string
  platform: BotPlatform
  name: string
  region?: 'cn' | 'intl'
  username?: string
  enabled: boolean
  state: 'off' | 'connecting' | 'connected' | 'error'
  error?: string
  replyMode: BotReplyMode
  scope: BotReplyScope
  users: { id: string; name?: string; pairedAt: number }[]
}
export interface RemoteState {
  bots: BotView[]
}
export type BotScanEvent =
  | { scanId: string; status: 'done'; botId: string }
  | { scanId: string; status: 'denied' | 'expired' | 'cancelled' }
  | { scanId: string; status: 'error'; error: string }
