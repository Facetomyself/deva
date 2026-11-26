import { ipcMain } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getDevaHome } from './config'
import {
  deleteMemory as deleteEntry, GLOBAL_SCOPE, isMemoryType, parseEntry, pathFor, projectMemoryKey, serialize,
  snapshot as toSnapshot, writeMemory as writeEntry, type MemoryEntry, type MemoryErrorCode, type MemoryFile,
  type MemoryInput, type MemoryScope, type MemorySnapshot, type MemoryWriteResult, type ScopedStore
} from './memory-core-shared'

export {
  formatMemoryLine, GLOBAL_SCOPE, isMemoryType, memoryLimits, memoryTypeLabel, memoryUsage, newMemoryId,
  normalizeBody, normalizeTitle, projectMemoryKey, scopeKindOfId, scopeLabel, MEMORY_BODY_MAX, MEMORY_INDEX_BUDGET,
  MEMORY_MAX_ENTRIES, MEMORY_TITLE_MAX, MEMORY_TYPES, PROJECT_MEMORY_INDEX_BUDGET, PROJECT_MEMORY_MAX_ENTRIES,
  type MemoryAccess, type MemoryEntry, type MemoryErrorCode, type MemoryInput, type MemoryScope, type MemorySnapshot,
  type MemoryType, type MemoryWriteResult
} from './memory-core-shared'

/**
 * 记忆（Memory）服务 v2（方案 design/memory-v2-plan.html，借鉴 Claude Code），分三层（scope）：
 * - **global**（界面叫「关于你」）：`<DEVA_HOME>/memory.json`，用户本人的情况，以及对所有角色都适用的做事要求。
 * - **role**（角色记忆）：`<DEVA_HOME>/personas/memory/<角色 id>.json`，某个角色做自己那类工作时学到的东西；
 *   只有这个角色读写（它的定时任务、它当成员时只读）。按 id 存，改名不受影响；删角色时连同删除（先备份）。
 * - **project**（项目记忆）：`<DEVA_HOME>/projects/<key>/memory.json`，按工作区隔离的私有经验与进展，不入版本库。
 *   key = 工作区真实路径（realpath）规整后 sha1 前 24 位。团队共享的约定仍归 AGENTS.md。
 *
 * 每条记忆有类型（user 用户 / feedback 做事方式 / project 进展 / reference 资料）、一句话标题和多行正文。
 * 随消息下发的是标题索引（做事方式类附正文，见 listing.ts），其余正文由模型用 memory_read 按 id 读取——记忆再多
 * 也只占索引的上下文。上限按索引行计：条数与索引总字数两重上限，各层独立；模型写入撞上限时先自动归纳
 * （memory-consolidate.ts）。
 *
 * 旧版（v1，每条一句话 content）读到时自动转换：先备份原文件，标题取原文第一句、正文保留原文、类型暂记为 user，
 * 并标记待整理，由下一轮对话用当轮模型补上类型与标题（memory-tidy.ts）。
 *
 * 由模型经 memory_read / memory_write / memory_delete 读写（memory-tools.ts），用户经 `memory:*` IPC 在面板里查看、
 * 修改、删除；两边同一套校验。主进程单线程 + 同步读改写，多会话并行写入不会交错；写入走临时文件 + rename。
 */

/** 角色 id 是否可直接当文件名（同 personas.ts 的 isSafeId）。 */
function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id) && id !== '.' && id !== '..'
}

/** 桌面兼容路径保留原有 project root 与回落规则；Web 应使用 memory-core.ts。 */
export function memoryPath(scope: MemoryScope): string {
  return pathFor(getDevaHome(), scope, projectMemoryKey)
}

// 兼容旧桌面：读失败回空，尽力在读取时备份并迁移 v1；严格 Web I/O 不经过这里。
function readMemoryFile(scope: MemoryScope): MemoryFile {
  const p = memoryPath(scope)
  if (!existsSync(p)) return { entries: [] }
  let parsed: { entries?: unknown; tidy?: unknown; tidyTries?: unknown }
  let raw: string
  try {
    raw = readFileSync(p, 'utf8')
    parsed = JSON.parse(raw)
  } catch {
    return { entries: [] }
  }
  if (!Array.isArray(parsed?.entries)) return { entries: [] }
  const entries: MemoryEntry[] = []
  let legacy = false
  for (const r of parsed.entries) {
    const hit = parseEntry(r)
    if (!hit) continue
    entries.push(hit.entry)
    legacy ||= hit.legacy
  }
  const file: MemoryFile = {
    entries,
    ...(parsed.tidy === 'pending' ? { tidy: 'pending' as const } : {}),
    ...(typeof parsed.tidyTries === 'number' ? { tidyTries: parsed.tidyTries } : {})
  }
  if (legacy) {
    // 旧版文件：原样备份一份，再按新格式写回并标记待整理（只转换一次）。
    try {
      const dir = join(dirname(p), 'memory-backups')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `memory-v1-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), raw, 'utf8')
      file.tidy = 'pending'
      writeMemoryFile(scope, file)
    } catch {
      /* 写不了：本次按转换结果用，下次再试 */
    }
  }
  return file
}

function writeMemoryFile(scope: MemoryScope, file: MemoryFile): void {
  const path = memoryPath(scope)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, serialize(scope, file), 'utf8')
  renameSync(tmp, path)
}

const desktopStore: ScopedStore = {
  read(scope) {
    return { file: readMemoryFile(scope), save: (file) => writeMemoryFile(scope, file) }
  }
}

/** 读取某作用域的全部记忆（按创建先后）。文件不存在 / 损坏视为空，绝不抛错。 */
export function listMemories(scope: MemoryScope = GLOBAL_SCOPE): MemoryEntry[] {
  if (scope.kind === 'role' && !isSafeId(scope.personaId)) return []
  return readMemoryFile(scope).entries
}

/** 是否有旧版转换来、待模型整理的条目，以及已失败的次数。 */
export function memoryTidyState(scope: MemoryScope): { pending: boolean; tries: number } {
  if (scope.kind === 'role' && !isSafeId(scope.personaId)) return { pending: false, tries: 0 }
  const f = readMemoryFile(scope)
  return { pending: f.tidy === 'pending', tries: f.tidyTries ?? 0 }
}

/** 整理结束：写回整理后的条目并清掉待整理标记（entries 省略 = 只记一次失败）。 */
export function finishMemoryTidy(scope: MemoryScope, entries: MemoryEntry[] | null, giveUp: boolean): void {
  const f = readMemoryFile(scope)
  if (entries) writeMemoryFile(scope, { entries })
  else if (giveUp) writeMemoryFile(scope, { entries: f.entries })
  else writeMemoryFile(scope, { ...f, tidyTries: (f.tidyTries ?? 0) + 1 })
}

export function writeMemory(input: MemoryInput, id?: string, scope: MemoryScope = GLOBAL_SCOPE): MemoryWriteResult {
  if (scope.kind === 'role' && !isSafeId(scope.personaId))
    return { ok: false, code: 'notFound', error: '找不到这个角色的记忆' }
  return writeEntry(input, id, scope, desktopStore)
}

export function deleteMemory(id: string, scope: MemoryScope = GLOBAL_SCOPE): MemoryEntry | null {
  if (scope.kind === 'role' && !isSafeId(scope.personaId)) return null
  return deleteEntry(id, scope, desktopStore)
}

/** 整体替换某作用域的全部条目（归纳后写回，见 memory-consolidate.ts）；待整理标记原样保留。 */
export function replaceMemories(scope: MemoryScope, entries: MemoryEntry[]): void {
  const f = readMemoryFile(scope)
  writeMemoryFile(scope, { ...f, entries })
}

/** 清空某作用域的全部记忆（仅用户经面板触发；模型没有对应工具）。 */
export function clearMemories(scope: MemoryScope = GLOBAL_SCOPE): void {
  writeMemoryFile(scope, { entries: [] })
}

/** 删除角色时连同它的记忆一起删：先备份到同目录的 memory-backups/。 */
export function removeRoleMemory(personaId: string): void {
  if (!isSafeId(personaId)) return
  const p = memoryPath({ kind: 'role', personaId })
  if (!existsSync(p)) return
  try {
    const dir = join(dirname(p), 'memory-backups')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${personaId}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
      readFileSync(p, 'utf8'),
      'utf8'
    )
    rmSync(p, { force: true })
  } catch {
    /* 备份不了就不删：留着比误删强 */
  }
}

// ── 面板 IPC ────────────────────────────────────────────────────────────────────

function snapshot(scope: MemoryScope): MemorySnapshot {
  return toSnapshot(scope, listMemories(scope))
}

export type MemoryIpcResult = { ok: true; snapshot: MemorySnapshot } | { ok: false; code: MemoryErrorCode }

/**
 * IPC 入参 → 作用域：省略（undefined / null）= 全局；非空字符串 = 该工作区的项目记忆；`{ personaId }` = 该角色的记忆。
 * 其余一律抛错让 invoke reject——若静默回落全局，渲染层传坏参数时「清空项目记忆」就会变成清空全局记忆。
 */
function ipcScope(arg: unknown): MemoryScope {
  if (arg === undefined || arg === null) return GLOBAL_SCOPE
  if (typeof arg === 'string' && arg.trim()) return { kind: 'project', root: arg.trim() }
  const personaId = (arg as { personaId?: unknown } | null)?.personaId
  if (typeof personaId === 'string' && isSafeId(personaId)) return { kind: 'role', personaId }
  throw new Error('memory: invalid scope')
}

function ipcInput(raw: unknown): MemoryInput {
  const o = (raw ?? {}) as Record<string, unknown>
  return {
    ...(isMemoryType(o.type) ? { type: o.type } : {}),
    ...(typeof o.title === 'string' ? { title: o.title } : {}),
    ...(typeof o.body === 'string' ? { body: o.body } : {})
  }
}

/**
 * 面板用：查看 / 修改 / 删除 / 清空。每次都回带最新快照，渲染层直接替换列表。
 * 末位参数 scope：省略 = 全局（个人资料面板）；字符串 = 该工作区的项目记忆；`{ personaId }` = 角色记忆。
 */
export function registerMemoryIpc(): void {
  ipcMain.handle('memory:list', (_e, scope?: unknown): MemorySnapshot => snapshot(ipcScope(scope)))
  ipcMain.handle('memory:write', (_e, input: unknown, id?: string, scopeArg?: unknown): MemoryIpcResult => {
    const scope = ipcScope(scopeArg)
    const target = typeof id === 'string' && id ? id : undefined
    const r = writeMemory(ipcInput(input), target, scope)
    if (!r.ok) return { ok: false, code: r.code }
    // 手动新增撞上已有条目：writeMemory 对模型按幂等成功处理，面板则要明确告诉用户「没有新增」。
    if (!target && !r.created) return { ok: false, code: 'duplicate' }
    return { ok: true, snapshot: snapshot(scope) }
  })
  ipcMain.handle('memory:delete', (_e, id: string, scopeArg?: unknown): MemoryIpcResult => {
    const scope = ipcScope(scopeArg)
    deleteMemory(String(id ?? ''), scope)
    return { ok: true, snapshot: snapshot(scope) }
  })
  ipcMain.handle('memory:clear', (_e, scopeArg?: unknown): MemoryIpcResult => {
    const scope = ipcScope(scopeArg)
    clearMemories(scope)
    return { ok: true, snapshot: snapshot(scope) }
  })
}
