/** 目录项（单层）。 */
export interface DirEntry {
  name: string
  path: string
  type: 'dir' | 'file'
}

/** 打开文件夹结果。 */
export interface OpenFolderResult {
  path: string
  name: string
}

/** 读取文件结果（可能因过大 / 二进制而不含正文）。 */
export interface ReadFileResult {
  path: string
  content: string
  tooLarge?: boolean
  binary?: boolean
}

/** 附件类型（与 services/attachments.ts 对齐）。 */
/** file = 只把位置交给模型的文件（Word 等读不进消息的格式、超过体积上限的）。 */
export type AttachmentKind = 'image' | 'document' | 'text' | 'file' | 'unsupported'

/** 一次挑选返回的附件描述（不含正文/base64）。 */
export interface PickedAttachment {
  path: string
  name: string
  ext: string
  size: number
  kind: AttachmentKind
  supported: boolean
  reason?: string
}

/** 拖入 / 粘贴的条目里认出的文件夹（与 services/attachments.ts 对齐）。 */
export interface DroppedFolder {
  path: string
  name: string
}

/** 拖入 / 粘贴的一项：文件夹，或带真实路径的文件（与 services/attachments.ts 对齐）。 */
export type DroppedEntry = { folder: DroppedFolder } | { file: PickedAttachment }

/** 终端「线缆类型」（与 services/terminal.ts 对齐）。 */
export interface TerminalCreateOptions {
  cols: number
  rows: number
  cwd: string | null
  /** 选定的 shell 配置 id（来自 listShells）；空则用主进程默认。 */
  shellId?: string | null
}
/** 可选 shell 配置（渲染层只见 id/label/isDefault；path/args 留在主进程）。 */
export interface ShellProfile {
  id: string
  label: string
  isDefault?: boolean
}
export interface TerminalDataPayload {
  id: string
  data: string
}
export interface TerminalExitPayload {
  id: string
  exitCode: number
}

/** Git「线缆类型」（与 services/git.ts 对齐）。 */
export type GitStatusLetter = 'M' | 'A' | 'D' | 'U' | 'R' | 'C' | 'T'
export interface GitFileStatus {
  path: string
  rel: string
  name: string
  dir: string
  letter: GitStatusLetter
  staged: boolean
  unstaged: boolean
  conflicted: boolean
  untracked: boolean
}
export interface GitStatus {
  isRepo: boolean
  root: string
  branch: string | null
  detached: boolean
  upstream: string | null
  ahead: number
  behind: number
  remotes: string[]
  mergeInProgress: boolean
  staged: GitFileStatus[]
  unstaged: GitFileStatus[]
  conflicts: GitFileStatus[]
}
export interface GitDiffLine {
  type: 'ctx' | 'add' | 'del' | 'hunk'
  oldNo?: number
  newNo?: number
  text: string
}
export interface GitCommit {
  oid: string
  short: string
  author: string
  email: string
  timestamp: number
  subject: string
}
export interface GitBranch {
  /** 本地分支为短名；远程分支含远程名前缀（origin/x） */
  name: string
  current: boolean
  /** 远程分支所属远程名；本地分支为 null */
  remote: string | null
  /** 本地分支的上游；无则 null */
  upstream: string | null
}
export type GitFailReason =
  | 'auth'
  | 'network'
  | 'rejected'
  | 'conflict'
  | 'dirty'
  | 'identity-needed'
  | 'empty'
  | 'unmerged'
  | 'no-git'
  | 'canceled'
  | 'error'
export type GitAvailable = { available: false } | { available: true; version: string; path: string }
export interface GitOpResult {
  ok: boolean
  reason?: GitFailReason
  message?: string
  /** delete-branch 回 unmerged 时：未合并到当前 HEAD 的提交数 */
  count?: number
}

/** AI 生成提交信息所用的模型配置（与 chat 的模型形状一致；密钥仍在主进程按 providerId 解密）。 */
export interface GitGenModel {
  adapter: 'anthropic' | 'openai' | 'responses'
  providerId: string
  baseURL: string
  model: string
}
/** 生成语言：跟随界面语言；主进程只区分 en 与其余（回退简体中文）。 */
export type GitGenLocale = 'zh-CN' | 'en'
/** 生成结果：成功时 text 为提交信息；失败时 reason/message 说明原因。 */
export interface GitGenerateResult {
  ok: boolean
  text?: string
  /** 被用户中断：text 为已生成的部分（可能为空串）。 */
  aborted?: boolean
  reason?: GitFailReason
  message?: string
}
