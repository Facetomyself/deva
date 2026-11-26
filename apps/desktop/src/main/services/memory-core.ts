import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, parse, resolve } from 'node:path'
import { createStrictMemoryStorage, MemoryServiceError } from './memory-core-storage'
import {
  deleteMemory, GLOBAL_SCOPE, hashProjectPath, isMemoryType, parseEntry, pathFor, serialize, snapshot, writeMemory,
  type MemoryEntry, type MemoryFile, type MemoryInput, type MemoryScope, type MemorySnapshot, type MemoryType,
  type MemoryWriteResult, type ScopedStore
} from './memory-core-shared'

export { MemoryServiceError, type MemoryServiceErrorCode } from './memory-core-storage'
export {
  isMemoryType, memoryUsage, projectMemoryKey, MEMORY_BODY_MAX, MEMORY_INDEX_BUDGET,
  MEMORY_MAX_ENTRIES, MEMORY_TITLE_MAX, MEMORY_TYPES, PROJECT_MEMORY_INDEX_BUDGET, PROJECT_MEMORY_MAX_ENTRIES,
  type MemoryEntry, type MemoryErrorCode, type MemoryInput, type MemorySnapshot, type MemoryType, type MemoryWriteResult
} from './memory-core-shared'

/** Web callers address a workspace by its opaque registered ID, never by a path. */
export type MemoryServiceScope =
  | { kind: 'global' }
  | { kind: 'role'; personaId: string }
  | { kind: 'project'; workspaceId: string }

export interface MemoryServiceOptions {
  /** Explicit absolute Deva profile directory; the caller owns the single-writer lease. */
  dataDir: string
  /** Look up an authorized workspace ID. Return its registered canonical absolute directory. */
  resolveWorkspaceRoot?: (workspaceId: string) => string | undefined
}

const prototypeKeys = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype'].map((key) => key.toLowerCase()))
const windowsDevice = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i

function safeScopeId(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && /^[A-Za-z0-9]/.test(value) &&
    !/[^A-Za-z0-9_.-]/.test(value) && !value.endsWith('.') && !prototypeKeys.has(value.toLowerCase())
}

export function isValidMemoryRoleId(value: unknown): value is string {
  return safeScopeId(value, 64) && !windowsDevice.test(value)
}

const hasOwn = (record: object, key: string) => Object.prototype.hasOwnProperty.call(record, key)
const own = (record: Record<string, unknown>, key: string) => hasOwn(record, key) ? record[key] : undefined

/** Only plain data properties with a recognized schema: no inherited fields, getters or extra keys. */
function exactRecord(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return (proto === null || proto === Object.prototype) && Reflect.ownKeys(value).every((key) =>
    typeof key === 'string' && fields.includes(key) && hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))
}

function strictWorkspaceRoot(workspaceId: string, lookup: MemoryServiceOptions['resolveWorkspaceRoot']): string {
  try {
    const path = lookup?.(workspaceId)
    if (typeof path === 'string' && isAbsolute(path) && !path.includes('\0')) {
      const absolute = resolve(path)
      const canonical = realpathSync.native(absolute)
      if (absolute === canonical && statSync(canonical).isDirectory()) return canonical
    }
  } catch (error) {
    throw new MemoryServiceError('workspaceUnavailable', error)
  }
  throw new MemoryServiceError('workspaceUnavailable')
}

function strictScope(raw: unknown, lookup: MemoryServiceOptions['resolveWorkspaceRoot']): MemoryScope {
  if (!exactRecord(raw, ['kind', 'personaId', 'workspaceId'])) throw new MemoryServiceError('invalidScope')
  const kind = own(raw, 'kind')
  if (kind === 'global' && !hasOwn(raw, 'personaId') && !hasOwn(raw, 'workspaceId')) return GLOBAL_SCOPE
  const personaId = own(raw, 'personaId')
  if (kind === 'role' && !hasOwn(raw, 'workspaceId') && isValidMemoryRoleId(personaId)) return { kind, personaId }
  const workspaceId = own(raw, 'workspaceId')
  if (kind === 'project' && !hasOwn(raw, 'personaId') && safeScopeId(workspaceId, 128)) {
    return { kind, root: strictWorkspaceRoot(workspaceId, lookup) }
  }
  throw new MemoryServiceError('invalidScope')
}

function validEntryId(id: unknown): id is string {
  // Entry IDs are lookup keys, never file paths. Preserve already-stored legacy IDs.
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && !id.includes('\0') && !prototypeKeys.has(id.toLowerCase())
}

function strictInput(input: unknown): MemoryInput {
  if (!exactRecord(input, ['type', 'title', 'body'])) throw new MemoryServiceError('invalidInput')
  const type = own(input, 'type')
  const title = own(input, 'title')
  const body = own(input, 'body')
  if ((type !== undefined && typeof type !== 'string') || (title !== undefined && typeof title !== 'string') ||
      (body !== undefined && typeof body !== 'string')) throw new MemoryServiceError('invalidInput')
  // The common writer returns the existing badType result for an unknown string type.
  return { type: type as MemoryType | undefined, title, body }
}

function decodeStrict(bytes: Buffer): { file: MemoryFile; legacy: boolean } {
  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch (error) {
    throw new MemoryServiceError('corruptStorage', error)
  }
  const corrupt = () => new MemoryServiceError('corruptStorage')
  if (!exactRecord(raw, ['version', 'root', 'personaId', 'tidy', 'tidyTries', 'entries'])) throw corrupt()
  const version = own(raw, 'version'), records = own(raw, 'entries')
  const root = own(raw, 'root'), personaId = own(raw, 'personaId')
  const tidy = own(raw, 'tidy'), tries = own(raw, 'tidyTries')
  if ((version !== undefined && version !== 1 && version !== 2) || !Array.isArray(records) ||
      (root !== undefined && typeof root !== 'string') || (personaId !== undefined && typeof personaId !== 'string') ||
      (tidy !== undefined && tidy !== 'pending') || (tries !== undefined &&
        (typeof tries !== 'number' || !Number.isSafeInteger(tries) || tries < 0))) throw corrupt()
  const ids = new Set<string>()
  const entries: MemoryEntry[] = []
  // Historical v1 files had version: 1, but the desktop reader also accepted the versionless envelope.
  // Require a uniform entry schema; an unrecognized or partly corrupt file is never partly loaded.
  let shape = version
  for (const record of records) {
    if (!exactRecord(record, ['id', 'content', 'type', 'title', 'body', 'createdAt', 'updatedAt'])) throw corrupt()
    const isV1 = hasOwn(record, 'content')
    const id = own(record, 'id'), createdAt = own(record, 'createdAt'), updatedAt = own(record, 'updatedAt')
    const entryVersion = isV1 ? 1 : 2
    shape ??= entryVersion
    if (shape !== entryVersion || !validEntryId(id) || ids.has(id) ||
        typeof createdAt !== 'number' || !Number.isFinite(createdAt) ||
        typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) throw corrupt()
    const type = own(record, 'type'), title = own(record, 'title'), body = own(record, 'body')
    if (isV1) {
      if (typeof own(record, 'content') !== 'string' || type !== undefined || title !== undefined || body !== undefined) throw corrupt()
    } else if (!isMemoryType(type) || typeof title !== 'string' || typeof body !== 'string') {
      throw corrupt()
    }
    const parsed = parseEntry(record)!
    // Unlike the permissive desktop reader, retain valid numeric zero timestamps exactly.
    entries.push({ ...parsed.entry, createdAt, updatedAt })
    ids.add(id)
  }
  const legacy = shape === 1
  return { legacy, file: {
    entries,
    ...((tidy === 'pending' || (legacy && entries.length > 0)) ? { tidy: 'pending' as const } : {}),
    ...(typeof tries === 'number' ? { tidyTries: tries } : {})
  } }
}

/**
 * Strict Node memory CRUD. Missing files alone read as empty; bad data/I/O throw stable error codes.
 * Reading v1 only returns an in-memory v2 view. The first successful mutation must complete
 * an original-byte backup before publishing v2; invalid/no-op operations leave v1 untouched.
 * No Electron, global state, background processes, or workspace access beyond root validation.
 */
export function createMemoryService({ dataDir, resolveWorkspaceRoot }: MemoryServiceOptions) {
  if (typeof dataDir !== 'string' || !isAbsolute(dataDir) || dataDir.includes('\0') || resolve(dataDir) === parse(dataDir).root)
    throw new TypeError('dataDir must be an absolute profile directory')
  if (resolveWorkspaceRoot !== undefined && typeof resolveWorkspaceRoot !== 'function')
    throw new TypeError('resolveWorkspaceRoot must be a function')
  const home = resolve(dataDir)
  const storage = createStrictMemoryStorage(home)
  const store: ScopedStore = {
    read(scope) {
      const path = pathFor(home, scope, hashProjectPath)
      const previous = storage.read(path)
      const { file, legacy } = previous ? decodeStrict(previous.bytes) : { file: { entries: [] }, legacy: false }
      return { file, save: (next) => storage.write(path, serialize(scope, next), previous, legacy) }
    }
  }
  const resolveScope = (scope: MemoryServiceScope) => strictScope(scope, resolveWorkspaceRoot)
  return {
    listMemories(scope: MemoryServiceScope): MemoryEntry[] {
      return store.read(resolveScope(scope)).file.entries
    },
    snapshot(scope: MemoryServiceScope): MemorySnapshot {
      const resolved = resolveScope(scope)
      return snapshot(resolved, store.read(resolved).file.entries)
    },
    writeMemory(input: MemoryInput, id: string | undefined, scope: MemoryServiceScope): MemoryWriteResult {
      const resolved = resolveScope(scope)
      if (id !== undefined && !validEntryId(id)) throw new MemoryServiceError('invalidInput')
      return writeMemory(strictInput(input), id, resolved, store)
    },
    deleteMemory(id: string, scope: MemoryServiceScope): MemoryEntry | null {
      const resolved = resolveScope(scope)
      if (!validEntryId(id)) throw new MemoryServiceError('invalidInput')
      return deleteMemory(id, resolved, store)
    },
    clearMemories(scope: MemoryServiceScope): void {
      store.read(resolveScope(scope)).save({ entries: [] })
    }
  }
}
