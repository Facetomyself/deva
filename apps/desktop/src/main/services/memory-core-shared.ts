import { createHash, randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'
export const MEMORY_TYPES: readonly MemoryType[] = Object.freeze(['user', 'feedback', 'project', 'reference'])

export interface MemoryEntry {
  /** 稳定短 id（全局 m_ / 角色 r_ / 项目 p_ + 8 位十六进制），供读取正文、更新、删除引用。 */
  id: string
  type: MemoryType
  /** 一句话标题：进索引，只看它就能判断与当前任务是否相关。 */
  title: string
  /** 正文：规则或事实，做事方式与进展类另写原因与何时适用；可为空。 */
  body: string
  createdAt: number
  updatedAt: number
}

/** 写入入参：新增时 type 与 title 必填；按 id 更新时省略的字段保持原值。 */
export interface MemoryInput {
  type?: MemoryType
  title?: string
  body?: string
}

/** 记忆作用域：全局（用户本人）/ 某个角色 / 某个工作区。 */
export type MemoryScope = { kind: 'global' } | { kind: 'role'; personaId: string } | { kind: 'project'; root: string }

export const GLOBAL_SCOPE: MemoryScope = Object.freeze({ kind: 'global' })

/**
 * 一次回合里各层记忆的读写方式（主对话全可写；项目成员全局与角色只读、项目可写；定时任务全只读）。
 * 项目记忆的工作区以 ToolContext.workspaceRoot 的实时值为准（轮中挂载后即生效），这里只记读写方式。
 */
export interface MemoryAccess {
  global: 'rw' | 'ro'
  role: { personaId: string; name: string; mode: 'rw' | 'ro' }
  project: 'rw' | 'ro'
}

/** 标题、正文字数上限（各层共用）。 */
export const MEMORY_TITLE_MAX = 60
export const MEMORY_BODY_MAX = 1500
/** 全局与每个角色：条数 / 索引总字数上限。 */
export const MEMORY_MAX_ENTRIES = 100
export const MEMORY_INDEX_BUDGET = 4000
/** 每个项目：条数 / 索引总字数上限。 */
export const PROJECT_MEMORY_MAX_ENTRIES = 60
export const PROJECT_MEMORY_INDEX_BUDGET = 3000

interface Limits {
  maxEntries: number
  budget: number
}

export function memoryLimits(scope: MemoryScope): Limits {
  return scope.kind === 'project'
    ? { maxEntries: PROJECT_MEMORY_MAX_ENTRIES, budget: PROJECT_MEMORY_INDEX_BUDGET }
    : { maxEntries: MEMORY_MAX_ENTRIES, budget: MEMORY_INDEX_BUDGET }
}

/** id 前缀 → 作用域类别（供读取 / 更新 / 删除时自动定位）。 */
export function scopeKindOfId(id: string): MemoryScope['kind'] {
  return id.startsWith('p_') ? 'project' : id.startsWith('r_') ? 'role' : 'global'
}

/**
 * 工作区 → 稳定的项目记忆键。按真实路径算（符号链接 / 大小写不同的写法指向同一项目即同一份记忆），
 * 取不到真实路径（目录已不存在等）回落原路径。Windows / macOS 默认大小写不敏感，统一转小写。
 */
export function projectMemoryKey(root: string): string {
  let p = root
  try {
    p = realpathSync.native(root)
  } catch {
    /* 回落原路径 */
  }
  return hashProjectPath(p)
}

export function hashProjectPath(p: string): string {
  let norm = p.replace(/[\\/]+$/, '')
  if (process.platform === 'win32' || process.platform === 'darwin') norm = norm.toLowerCase()
  return createHash('sha1').update(norm).digest('hex').slice(0, 24)
}

const TYPE_LABEL: Record<MemoryType, string> = { user: '用户', feedback: '做事方式', project: '进展', reference: '资料' }

/** 给模型看的类型名（界面另有自己的叫法，见 i18n）。 */
export function memoryTypeLabel(t: MemoryType): string {
  return TYPE_LABEL[t]
}

export function isMemoryType(v: unknown): v is MemoryType {
  return typeof v === 'string' && (MEMORY_TYPES as readonly string[]).includes(v)
}

export function scopeLabel(scope: MemoryScope): string {
  return scope.kind === 'project' ? '项目记忆' : scope.kind === 'role' ? '角色记忆' : '全局记忆'
}

/** 规整标题：单行、去首尾空白。 */
export function normalizeTitle(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** 规整正文：统一换行、去首尾空白、连续空行压成一个。 */
export function normalizeBody(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 旧版一句话 → 标题：取第一句（最多 60 字），太长截断加省略号。 */
function firstSentence(content: string): string {
  const text = normalizeTitle(content)
  const m = text.match(/^.+?[。！？；!?;](?=\s|$|[^\d])/)
  const s = (m && m[0].length <= MEMORY_TITLE_MAX ? m[0] : text).replace(/[。；;，,、：:]+$/, '')
  return s.length <= MEMORY_TITLE_MAX ? s : `${s.slice(0, MEMORY_TITLE_MAX - 1)}…`
}

// ── 读写文件 ────────────────────────────────────────────────────────────────────

export interface MemoryFile {
  entries: MemoryEntry[]
  /** 旧版转换来的条目还没由模型补上类型与标题（见 memory-tidy.ts）。 */
  tidy?: 'pending'
  /** 整理已失败的次数：到上限即放弃，保留规则转换的结果。 */
  tidyTries?: number
}

export function parseEntry(raw: unknown): { entry: MemoryEntry; legacy: boolean } | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  if (typeof e.id !== 'string') return null
  const createdAt = Number(e.createdAt) || 0
  const updatedAt = Number(e.updatedAt) || createdAt
  if (typeof e.title === 'string') {
    return {
      entry: {
        id: e.id,
        type: isMemoryType(e.type) ? e.type : 'user',
        title: e.title,
        body: typeof e.body === 'string' ? e.body : '',
        createdAt,
        updatedAt
      },
      legacy: false
    }
  }
  // v1：每条一句话 content。
  if (typeof e.content !== 'string') return null
  return {
    entry: { id: e.id, type: 'user', title: firstSentence(e.content), body: e.content, createdAt, updatedAt },
    legacy: true
  }
}

export function newMemoryId(scope: MemoryScope, existing: MemoryEntry[]): string {
  const prefix = scope.kind === 'project' ? 'p_' : scope.kind === 'role' ? 'r_' : 'm_'
  const taken = new Set(existing.map((e) => e.id))
  let id = ''
  do id = `${prefix}${randomBytes(4).toString('hex')}`
  while (taken.has(id))
  return id
}

/** 索引里的一行（随消息下发、memory_read 回灌与用量计算共用）。 */
export function formatMemoryLine(e: Pick<MemoryEntry, 'id' | 'type' | 'title'>): string {
  return `- [${e.id}] ${memoryTypeLabel(e.type)} · ${e.title}`
}

/** 索引总用量（字数），与随消息下发同一口径。 */
export function memoryUsage(entries: Pick<MemoryEntry, 'id' | 'type' | 'title'>[]): number {
  return entries.reduce((n, e) => n + formatMemoryLine(e).length, 0)
}

/** 失败原因码：渲染层据此走 i18n，工具回灌则用 error 文本。 */
export type MemoryErrorCode = 'empty' | 'tooLong' | 'full' | 'budget' | 'notFound' | 'duplicate' | 'badType'

export type MemoryWriteResult =
  | { ok: true; entry: MemoryEntry; created: boolean }
  | { ok: false; code: MemoryErrorCode; error: string }

function budgetError(scope: MemoryScope, used: number): MemoryWriteResult {
  return {
    ok: false,
    code: 'budget',
    error: `${scopeLabel(scope)}的索引总量已达上限（写入后 ${used} 字，上限 ${memoryLimits(scope).budget}）：请用 memory_write 带 id 合并相近条目、缩短标题，或用 memory_delete 删除过时条目后再写`
  }
}

export interface MemorySnapshot {
  entries: MemoryEntry[]
  /** 当前索引总字数（与随消息下发同一口径）。 */
  used: number
  budget: number
  maxEntries: number
  maxTitle: number
  maxBody: number
}

export interface ScopedStore {
  read(scope: MemoryScope): { file: MemoryFile; save: (file: MemoryFile) => void }
}

/** 新增（无 id）或按 id 更新一条记忆。 */
export function writeMemory(input: MemoryInput, id: string | undefined, scope: MemoryScope, store: ScopedStore): MemoryWriteResult {
  const lim = memoryLimits(scope)
  const { file, save } = store.read(scope)
  const entries = file.entries
  const hit = id ? entries.find((e) => e.id === id) : undefined
  if (id && !hit)
    return {
      ok: false,
      code: 'notFound',
      error: `${scopeLabel(scope)}中不存在 id 为 ${id} 的记忆（可先用 memory_read 查看现有记忆）`
    }
  const type = input.type ?? hit?.type
  if (!type || !isMemoryType(type))
    return { ok: false, code: 'badType', error: '缺少有效的类型 type（user / feedback / project / reference）' }
  const title = input.title !== undefined ? normalizeTitle(input.title) : (hit?.title ?? '')
  const body = input.body !== undefined ? normalizeBody(input.body) : (hit?.body ?? '')
  if (!title) return { ok: false, code: 'empty', error: '记忆标题为空' }
  if (title.length > MEMORY_TITLE_MAX)
    return {
      ok: false,
      code: 'tooLong',
      error: `标题过长（${title.length} 字，上限 ${MEMORY_TITLE_MAX}）：标题只写一句话概括，细节写进正文 body`
    }
  if (body.length > MEMORY_BODY_MAX)
    return { ok: false, code: 'tooLong', error: `正文过长（${body.length} 字，上限 ${MEMORY_BODY_MAX}）：请精简` }
  // 同层里标题相同 = 同一主题：新增时内容也一样视为已记住，不一样则提示带 id 更新；更新时撞上别的条目也拒。
  const key = title.toLowerCase()
  const twin = entries.find((e) => e.id !== id && e.title.toLowerCase() === key)
  if (twin) {
    if (!hit && twin.body === body && twin.type === type) return { ok: true, entry: twin, created: false }
    return {
      ok: false,
      code: 'duplicate',
      error: `已有同标题的记忆（id=${twin.id}）：同一主题请带这个 id 更新，不要重复新增`
    }
  }
  const now = Date.now()
  if (hit) {
    const next = { ...hit, type, title, body }
    const used = memoryUsage(entries) - formatMemoryLine(hit).length + formatMemoryLine(next).length
    // 只拒「越改越超」：缩短 / 不变的更新即便总量仍超（旧数据）也放行，否则永远没法合并瘦身。
    if (used > lim.budget && formatMemoryLine(next).length > formatMemoryLine(hit).length) return budgetError(scope, used)
    Object.assign(hit, { type, title, body, updatedAt: now })
    save(file)
    return { ok: true, entry: hit, created: false }
  }
  if (entries.length >= lim.maxEntries)
    return {
      ok: false,
      code: 'full',
      error: `${scopeLabel(scope)}已满（上限 ${lim.maxEntries} 条）：请先用 memory_delete 删除过时条目，或用 memory_write 带 id 合并相近条目`
    }
  const entry: MemoryEntry = { id: newMemoryId(scope, entries), type, title, body, createdAt: now, updatedAt: now }
  const used = memoryUsage(entries) + formatMemoryLine(entry).length
  if (used > lim.budget) return budgetError(scope, used)
  entries.push(entry)
  save(file)
  return { ok: true, entry, created: true }
}

/** 删除一条记忆；返回被删条目（不存在则 null）。 */
export function deleteMemory(id: string, scope: MemoryScope, store: ScopedStore): MemoryEntry | null {
  const { file, save } = store.read(scope)
  const idx = file.entries.findIndex((e) => e.id === id)
  if (idx < 0) return null
  const [removed] = file.entries.splice(idx, 1)
  save(file)
  return removed
}

export function snapshot(scope: MemoryScope, entries: MemoryEntry[]): MemorySnapshot {
  const lim = memoryLimits(scope)
  return {
    entries,
    used: memoryUsage(entries),
    budget: lim.budget,
    maxEntries: lim.maxEntries,
    maxTitle: MEMORY_TITLE_MAX,
    maxBody: MEMORY_BODY_MAX
  }
}

export function pathFor(dataDir: string, scope: MemoryScope, projectKey: (root: string) => string): string {
  if (scope.kind === 'project') return join(dataDir, 'projects', projectKey(scope.root), 'memory.json')
  if (scope.kind === 'role') return join(dataDir, 'personas', 'memory', `${scope.personaId}.json`)
  return join(dataDir, 'memory.json')
}

export function serialize(scope: MemoryScope, file: MemoryFile): string {
  return JSON.stringify({
    version: 2,
    ...(scope.kind === 'project' ? { root: scope.root } : scope.kind === 'role' ? { personaId: scope.personaId } : {}),
    ...(file.tidy ? { tidy: file.tidy } : {}),
    ...(file.tidyTries ? { tidyTries: file.tidyTries } : {}),
    entries: file.entries
  }, null, 2)
}
