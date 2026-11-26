import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync,
  renameSync, rmSync, writeFileSync
} from 'node:fs'
import type { Stats } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { createMediaStore } from './media-store-core'
import type { ChatMediaCodec } from './media-store-core'
import { modelFirst } from './model-view'
import type { EffortLevel, Message } from '../providers/types'
import type { ChatSessionMeta, StoredSession } from './chat-storage-types'

export type { ChatSessionMeta, StoredNotice, StoredSession } from './chat-storage-types'

const INDEX_FILE = '_index.json'
// The index is derived. A marker survives a crash or a failed index write after the session was committed.
const INDEX_PENDING = '_index.pending'
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i

/** Validate the exact SID, never normalize it into an alias of another file. */
export function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 200 && !/[^A-Za-z0-9_-]/.test(id) &&
    id.toLowerCase() !== '_index' && !WINDOWS_DEVICE.test(id)
}

function requireSessionId(id: unknown): asserts id is string {
  if (!isValidSessionId(id)) throw new TypeError('Invalid chat session ID')
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

/** Check the actual opened file as well as the name; compacted history must not follow links. */
function withRegularFile<T>(path: string, flags: number, use: (fd: number, stat: Stats) => T): T {
  const named = lstatSync(path)
  if (!named.isFile() || named.nlink !== 1) throw new Error('Expected a regular chat storage file with one link')
  const fd = openSync(path, flags | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || named.dev !== stat.dev || named.ino !== stat.ino) {
      throw new Error('Chat storage file changed while opening')
    }
    return use(fd, stat)
  } finally {
    closeSync(fd)
  }
}

function readRegular(path: string): string {
  return withRegularFile(path, constants.O_RDONLY, (fd) => readFileSync(fd, 'utf8'))
}

/** Write a private, exclusive temp file and publish by rename; never overwrite a target through a link. */
function replaceFile(path: string, data: string): void {
  const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`
  const fd = openSync(tmp, 'wx', 0o600)
  try {
    try {
      writeFileSync(fd, data, 'utf8')
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, path)
  } catch (error) {
    try { rmSync(tmp, { force: true }) } catch { /* temporary file is ignored by scans */ }
    throw error
  }
}

function metaOf(s: StoredSession): ChatSessionMeta {
  return {
    id: s.id,
    title: s.title,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    personaId: s.personaId,
    focusRoot: s.focusRoot ?? null,
    model: s.model,
    effort: s.effort,
    archived: s.archived,
    ...(s.members?.length ? { members: s.members } : {}),
    ...(s.parentId ? { parentId: s.parentId } : {})
  }
}

function isMeta(value: unknown): value is ChatSessionMeta {
  const m = value as ChatSessionMeta | null
  return !!m && isValidSessionId(m.id) && typeof m.title === 'string' &&
    Number.isFinite(m.createdAt) && Number.isFinite(m.updatedAt)
}

function isMessage(value: unknown): value is Message {
  const msg = value as Message | null
  return !!msg && (msg.role === 'user' || msg.role === 'assistant') &&
    (typeof msg.content === 'string' || (Array.isArray(msg.content) &&
      msg.content.every((part) => part && typeof part.type === 'string')))
}

function compactedPrefix(id: string): string {
  return `${id}.compacted-`
}

function isCompactedFile(id: string, name: unknown): name is string {
  const prefix = compactedPrefix(id)
  if (typeof name !== 'string' || isAbsolute(name) || !name.startsWith(prefix) || !name.endsWith('.jsonl')) return false
  const suffix = name.slice(prefix.length, -'.jsonl'.length)
  return suffix.length > 0 && !/[^A-Za-z0-9_-]/.test(suffix)
}

type Layout = { file: string; prefix: Message[]; bytes: number }
type SessionOptions = { personaId?: string; focusRoot?: string | null; model?: string; effort?: EffortLevel }

export interface ChatStoreOptions {
  /** Deva home (the server's dataDir), not its inner data or chats directory. */
  dataDir: string
  media?: ChatMediaCodec
  removeToolResults?: (id: string) => void
  onWarning?: (message: string) => void
}

/** One writer per data directory; both desktop and headless use this implementation. */
export function createChatStore({ dataDir, media, removeToolResults, onWarning = console.warn }: ChatStoreOptions) {
  if (typeof dataDir !== 'string' || !dataDir.trim() || dataDir.includes('\0')) {
    throw new TypeError('dataDir must be a directory path')
  }
  const home = resolve(dataDir)
  const chatsDir = join(home, 'data', 'chats')
  const indexPath = join(chatsDir, INDEX_FILE)
  const pendingPath = join(chatsDir, INDEX_PENDING)
  const codec = media ?? createMediaStore(home)
  const sessions = new Map<string, StoredSession>()
  // Layout is committed only after its main JSON points to it. A caller's mutable `compacted` is never an I/O input.
  const layouts = new WeakMap<StoredSession, Layout>()
  const persisted = new WeakSet<StoredSession>()
  let index: Map<string, ChatSessionMeta> | undefined
  let indexDirty = false
  const fileForId = (id: string) => join(chatsDir, `${id}.json`)

  function ensureIndex(): Map<string, ChatSessionMeta> {
    if (index) return index
    let names: string[]
    try {
      names = readdirSync(chatsDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && isValidSessionId(entry.name.slice(0, -5)))
        .map((entry) => entry.name.slice(0, -5))
    } catch (error) {
      if (!missing(error)) throw error
      return new Map()
    }
    const next = new Map<string, ChatSessionMeta>()
    try {
      try {
        lstatSync(pendingPath)
        throw new Error('Pending chat index update')
      } catch (error) {
        if (!missing(error)) throw error
      }
      const raw: unknown = JSON.parse(readRegular(indexPath))
      if (Array.isArray(raw) && raw.every(isMeta)) {
        for (const m of raw) next.set(m.id, m)
        if (raw.length === next.size && names.length === next.size && names.every((id) => next.has(id))) {
          return (index = next)
        }
      }
    } catch { /* missing or damaged index: reconstruct from session files */ }
    next.clear()
    for (const id of names) {
      try {
        const s = readMain(id)
        if (s) next.set(id, metaOf(s))
      } catch { /* skip damaged files */ }
    }
    indexDirty = true
    return (index = next)
  }

  function markIndexPending(): void {
    try {
      closeSync(openSync(pendingPath, 'wx', 0o600))
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST' || !lstatSync(pendingPath).isFile()) throw error
    }
  }

  function persistIndex(): void {
    if (!index || !indexDirty) return
    replaceFile(indexPath, JSON.stringify([...index.values()], null, 2))
    rmSync(pendingPath, { force: true })
    indexDirty = false
  }

  function readMain(id: string): StoredSession | undefined {
    let text: string
    try {
      text = readRegular(fileForId(id))
    } catch (error) {
      if (missing(error)) return undefined
      throw error
    }
    const value = JSON.parse(text) as StoredSession
    if (!isMeta(value) || value.id !== id || !Array.isArray(value.messages) || !value.messages.every(isMessage)) {
      throw new Error('Invalid chat session file')
    }
    return value
  }

  function readCompacted(id: string, value: unknown): Layout | undefined {
    const c = value as StoredSession['compacted']
    if (!c || !Number.isSafeInteger(c.count) || c.count < 1 || !isCompactedFile(id, c.file)) return undefined
    try {
      const text = readRegular(join(chatsDir, c.file))
      const prefix: Message[] = []
      let start = 0
      while (prefix.length < c.count && start < text.length) {
        const newline = text.indexOf('\n', start)
        const end = newline < 0 ? text.length : newline
        const line = text.slice(start, end)
        start = newline < 0 ? end : end + 1
        if (!line) continue
        const message: unknown = JSON.parse(line)
        if (!isMessage(message)) return undefined
        prefix.push(message)
      }
      if (prefix.length !== c.count) return undefined
      // Legacy JSONL without a final newline is readable, but a future append must rewrite it.
      const bytes = text[start - 1] === '\n' ? Buffer.byteLength(text.slice(0, start)) : -1
      return { file: c.file, prefix, bytes }
    } catch {
      return undefined
    }
  }

  function removeCompactedFiles(id: string, keep?: string): void {
    try {
      for (const name of readdirSync(chatsDir)) {
        if (name !== keep && isCompactedFile(id, name)) rmSync(join(chatsDir, name), { force: true })
      }
    } catch { /* cleanup is opportunistic */ }
  }

  function loadSession(id: string): StoredSession | undefined {
    const cached = sessions.get(id)
    if (cached) return cached
    const s = readMain(id)
    if (!s) return undefined
    let tidy = true
    if (s.compacted !== undefined) {
      const layout = readCompacted(id, s.compacted)
      if (layout) {
        s.messages = [...layout.prefix, ...s.messages]
        layouts.set(s, layout)
      } else {
        // The live suffix remains readable. Keep the existing sidecar for recovery/inspection.
        const n = s.compacted?.count
        onWarning(`[chat-store] 对话 ${id} 的较早记录读取失败，只载入其后的部分`)
        if (typeof n === 'number' && Number.isSafeInteger(n) && n > 0 && Array.isArray(s.notices)) {
          s.notices = s.notices.filter((nt) => nt && nt.after >= n).map((nt) => ({ ...nt, after: nt.after - n }))
        }
        delete s.compacted
        tidy = false
      }
    }
    codec.hydrateMessages(s.messages)
    if (tidy) removeCompactedFiles(id, s.compacted?.file)
    persisted.add(s)
    sessions.set(id, s)
    return s
  }

  function toLines(messages: Message[]): string {
    return messages.map((m) => `${JSON.stringify(m, codec.mediaReplacer)}\n`).join('')
  }

  /** Write the sidecar first. Extra lines from an interrupted save remain invisible to the old main file. */
  function prepareLayout(s: StoredSession, id: string): Layout | undefined {
    const cut = modelFirst(s.messages)
    if (!cut) return undefined
    const prev = layouts.get(s)
    if (prev && prev.bytes >= 0 && prev.prefix.length <= cut && prev.prefix.every((m, i) => m === s.messages[i])) {
      let found = false
      try {
        const flags = prev.prefix.length === cut ? constants.O_RDONLY : constants.O_WRONLY | constants.O_APPEND
        const appended = withRegularFile(join(chatsDir, prev.file), flags, (fd, stat) => {
          // Uncommitted tail, shortened sidecar or a failed append: publish a new sidecar instead of duplicating lines.
          if (stat.size !== prev.bytes) return undefined
          found = true
          if (prev.prefix.length === cut) return prev
          const more = toLines(s.messages.slice(prev.prefix.length, cut))
          writeFileSync(fd, more, 'utf8')
          return { file: prev.file, prefix: s.messages.slice(0, cut), bytes: prev.bytes + Buffer.byteLength(more) }
        })
        if (appended) return appended
      } catch (error) {
        if (found || !missing(error)) throw error
      }
    }
    const file = `${compactedPrefix(id)}${Date.now().toString(36)}${randomBytes(8).toString('hex')}.jsonl`
    const prefix = s.messages.slice(0, cut)
    const data = toLines(prefix)
    writeFileSync(join(chatsDir, file), data, { flag: 'wx', mode: 0o600 })
    return { file, prefix, bytes: Buffer.byteLength(data) }
  }

  /** `didCommit` separates main-file failures from a committed session whose derived index needs repair. */
  function writeSession(id: string, s: StoredSession, didCommit?: () => void): void {
    if (s.id !== id) throw new Error('Chat session ID changed in memory')
    const entries = ensureIndex()
    mkdirSync(chatsDir, { recursive: true, mode: 0o700 })
    markIndexPending()
    const prev = layouts.get(s)
    const next = prepareLayout(s, id)
    const compacted = next && { count: next.prefix.length, file: next.file }
    const messages = next ? s.messages.slice(next.prefix.length) : s.messages
    replaceFile(fileForId(id), JSON.stringify({ ...s, compacted, messages }, codec.mediaReplacer, 2))
    didCommit?.()
    persisted.add(s)
    if (next && compacted) {
      layouts.set(s, next)
      s.compacted = compacted
    } else {
      layouts.delete(s)
      delete s.compacted
    }
    if (prev?.file !== next?.file) removeCompactedFiles(id, next?.file)
    entries.set(id, metaOf(s))
    index = entries
    indexDirty = true
    persistIndex()
  }

  function saveStrict(id: string): void {
    requireSessionId(id)
    const s = loadSession(id)
    if (!s) throw new Error('Chat session does not exist')
    writeSession(id, s)
  }

  function save(id: string): void {
    requireSessionId(id)
    const s = sessions.get(id)
    if (s) {
      try { writeSession(id, s) } catch { /* legacy callers keep the in-memory session */ }
    }
  }

  function listSessions(): ChatSessionMeta[] {
    const entries = ensureIndex()
    try { persistIndex() } catch { /* the session file is authoritative; retry repair later */ }
    return [...entries.values()].map((m) => ({ ...m, focusRoot: m.focusRoot ?? null }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  function getSession(id: string): StoredSession | undefined {
    requireSessionId(id)
    try { return loadSession(id) } catch { return undefined }
  }

  /** New sessions exist only in memory until saved, and never leak into another session's index write. */
  function ensureSession(id: string, opts?: SessionOptions): StoredSession {
    requireSessionId(id)
    let s = loadSession(id)
    if (!s) {
      const now = Date.now()
      s = {
        id, title: '', createdAt: now, updatedAt: now, messages: [],
        personaId: opts?.personaId, focusRoot: opts?.focusRoot ?? null, model: opts?.model, effort: opts?.effort
      }
      sessions.set(id, s)
    } else {
      if (s.personaId === undefined && opts?.personaId !== undefined) s.personaId = opts.personaId
      if (opts?.focusRoot !== undefined) s.focusRoot = opts.focusRoot
      if (opts?.model !== undefined) s.model = opts.model
      if (opts?.effort !== undefined) s.effort = opts.effort
    }
    return s
  }

  /** Idempotent archive retains updatedAt and repairs the index if a previous attempt committed only the session. */
  function setSessionArchivedStrict(id: string, archived: boolean): boolean {
    requireSessionId(id)
    const s = loadSession(id)
    if (!s || !persisted.has(s)) return false
    if (!!s.archived === archived) {
      ensureIndex()
      persistIndex()
      return true
    }
    const prior = s.archived
    let committed = false
    if (archived) s.archived = true
    else delete s.archived
    try {
      writeSession(id, s, () => { committed = true })
    } catch (error) {
      if (!committed) {
        if (prior === undefined) delete s.archived
        else s.archived = prior
      }
      throw error
    }
    return true
  }

  function setSessionArchivedLegacy(id: string, archived: boolean): boolean {
    const s = getSession(id)
    if (!s) return false
    if (!!s.archived !== archived) {
      if (archived) s.archived = true
      else delete s.archived
      save(id)
    }
    return true
  }

  /** Desktop-only bindings: these preserve timestamps and retain legacy best-effort writes. */
  function rebindSessionPersona(id: string, from: string, to: string): boolean {
    if (ensureIndex().get(id)?.personaId !== from) return false
    const s = getSession(id)
    if (!s || s.personaId !== from) return false
    s.personaId = to
    save(id)
    return true
  }

  function syncSessionBinding(id: string, b: { personaId?: string; model: string }): boolean {
    if (!ensureIndex().has(id)) return false
    const s = getSession(id)
    if (!s) return false
    let changed = false
    if (b.personaId && s.personaId !== b.personaId) { s.personaId = b.personaId; changed = true }
    if ((s.model ?? '') !== b.model) { s.model = b.model; changed = true }
    if (changed) save(id)
    return changed
  }

  function deleteSession(id: string): void {
    requireSessionId(id)
    let hasFile = false
    try { hasFile = lstatSync(fileForId(id)).isFile() } catch (error) { if (!missing(error)) throw error }
    if (!hasFile && !sessions.has(id)) return
    if (hasFile) {
      const entries = ensureIndex()
      markIndexPending()
      rmSync(fileForId(id), { force: true })
      entries.delete(id)
      index = entries
      indexDirty = true
    }
    sessions.delete(id)
    removeCompactedFiles(id)
    removeToolResults?.(id)
    persistIndex()
  }

  return {
    listSessions, getSession, ensureSession, save, saveStrict, deleteSession,
    setSessionArchived: setSessionArchivedStrict, setSessionArchivedStrict,
    setSessionArchivedLegacy, rebindSessionPersona, syncSessionBinding
  }
}

/** 工作区绝对路径 → 权限作用域的稳定键，不参与对话存储。 */
export function projectKey(workspaceRoot: string | null): string {
  if (!workspaceRoot) return 'no-project'
  const norm = workspaceRoot.replace(/[\\/]+$/, '').toLowerCase()
  return createHash('sha1').update(norm).digest('hex').slice(0, 24)
}

export function deriveTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > 30 ? `${oneLine.slice(0, 30)}…` : oneLine
}
