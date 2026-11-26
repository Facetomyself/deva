import type { ChatSummary } from './chat-transport'
import { HttpFailure, type Revision, type Transport } from './transport'

export interface SessionPreferences {
  title: string
  customTitle: string | null
  archived: boolean
  model: string | null
  effort: string | null
}
export interface PreferenceSnapshot { preferences: SessionPreferences; revision: Revision }
export type PreferenceSet = Partial<Pick<SessionPreferences, 'customTitle' | 'archived' | 'model' | 'effort'>>

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function nullableString(value: unknown): value is string | null { return value === null || typeof value === 'string' }
function parse(value: unknown): PreferenceSnapshot {
  if (!record(value) || !record(value.preferences)) throw new Error('Invalid session preferences')
  const { title, customTitle, archived, model, effort } = value.preferences
  const { revision } = value
  if (typeof title !== 'string' || !nullableString(customTitle) || typeof archived !== 'boolean' || !nullableString(model) || !nullableString(effort) ||
      !((typeof revision === 'string' && revision.length > 0) || (typeof revision === 'number' && Number.isSafeInteger(revision))))
    throw new Error('Invalid session preferences')
  return { preferences: { title, customTitle, archived, model, effort }, revision }
}
export function createPreferenceTransport(transport: Transport, csrf: string) {
  function path(sid: string): string {
    if (!sid || /^[A-Za-z0-9_-]{1,128}$/u.exec(sid)?.[0] !== sid) throw new Error('Invalid chat id')
    return `/chats/${sid}/preferences`
  }
  return {
    async read(sid: string): Promise<PreferenceSnapshot> { return parse(await transport.request(path(sid))) },
    async patch(sid: string, revision: Revision, set: PreferenceSet): Promise<PreferenceSnapshot> {
      return parse(await transport.request(path(sid), 'PATCH', { revision, set }, csrf))
    }
  }
}

type PreferenceTransport = ReturnType<typeof createPreferenceTransport>
export type PreferenceIssue = 'conflict' | 'busy' | 'readOnly' | 'missing' | 'storage' | 'invalid' | 'readFailure' | 'writeFailure'
export interface RenameDraft { text: string; initial: string; revision: Revision }
export interface PreferenceEntry {
  confirmed?: PreferenceSnapshot
  reading?: boolean
  pending?: PreferenceSet
  draft?: RenameDraft
  issue?: PreferenceIssue
  needsRead?: boolean
}
const empty: PreferenceEntry = {}

function failure(error: unknown, reading: boolean): PreferenceIssue {
  if (error instanceof HttpFailure) {
    if (error.code === 'turn_in_progress') return 'busy'
    if (error.code === 'preferences_conflict') return 'conflict'
    if (error.code === 'chat_storage_unconfirmed') return 'storage'
    if (error.code === 'read_only_session' || error.code === 'unsupported_history') return 'readOnly'
    if (error.status === 400 || error.status === 422 || error.code === 'provider_not_found') return 'invalid'
    if (error.status === 404) return 'missing'
    if (error.status === 409) return 'conflict'
  }
  return reading ? 'readFailure' : 'writeFailure'
}

export const normalizeTitle = (text: string): string => text.replace(/\s+/g, ' ').trim()
export function matchesPreferences(row: ChatSummary, confirmed: PreferenceSnapshot | undefined): boolean {
  const p = confirmed?.preferences
  return !!p && p.title === row.title && p.customTitle === (row.customTitle ?? null) &&
    p.archived === (row.archived === true) && p.model === row.model
}
export function projectSession(row: ChatSummary, change: PreferenceSet | undefined): ChatSummary {
  if (!change) return row
  return { ...row, title: change.customTitle ?? row.title, archived: change.archived ?? row.archived,
    model: change.model === undefined ? row.model : change.model }
}

/** Revisions and draft baselines belong to the session, never to the currently mounted controls. */
export function createSessionPreferences(api: PreferenceTransport, options: {
  beforeWrite: () => Promise<void>
  expired: () => void
  committed: (sid: string, preferences: SessionPreferences) => void
  blocked: (sid: string, issue: PreferenceIssue) => void
}) {
  const entries = new Map<string, PreferenceEntry>()
  const subscribers = new Set<() => void>()
  let version = 0
  let revoked = false
  const get = (sid: string): PreferenceEntry => entries.get(sid) ?? empty
  function put(sid: string, patch: Partial<PreferenceEntry>): void {
    entries.set(sid, { ...get(sid), ...patch })
    ++version
    subscribers.forEach((notify) => notify())
  }
  function expired(error: unknown): boolean {
    if (revoked) return true
    if (!(error instanceof HttpFailure) || error.status !== 401) return false
    revoked = true
    options.expired()
    return true
  }
  async function read(sid: string, explicit = false): Promise<void> {
    const current = get(sid)
    if (revoked || current.reading || current.pending || (!explicit && current.needsRead)) return
    put(sid, { reading: true })
    try {
      const confirmed = await api.read(sid)
      if (revoked) return
      const draft = get(sid).draft
      // Only an explicit reread can rebase an edit. A new background snapshot must not make a stale draft writable.
      put(sid, { confirmed, issue: explicit ? undefined : current.issue, needsRead: false, ...(explicit && draft ? {
        draft: { text: draft.text, initial: confirmed.preferences.title, revision: confirmed.revision }
      } : {}) })
    } catch (error) {
      if (!expired(error)) put(sid, { issue: failure(error, true), needsRead: true })
    } finally { put(sid, { reading: false }) }
  }
  async function write(sid: string, set: PreferenceSet, fromDraft = false): Promise<boolean> {
    const current = get(sid)
    if (revoked || !current.confirmed || current.reading || current.pending || current.needsRead || (fromDraft && !current.draft)) return false
    const revision = fromDraft ? current.draft!.revision : current.confirmed.revision
    put(sid, { pending: set, issue: undefined })
    try {
      await options.beforeWrite()
      if (revoked) return false
      const confirmed = await api.patch(sid, revision, set)
      if (revoked) return false
      options.committed(sid, confirmed.preferences)
      put(sid, { confirmed, ...(fromDraft ? { draft: undefined } : {}) })
      return true
    } catch (error) {
      if (!expired(error)) {
        const issue = failure(error, false)
        put(sid, { issue, needsRead: issue !== 'busy' && issue !== 'invalid' })
        options.blocked(sid, issue)
      }
      return false
    } finally { put(sid, { pending: undefined }) }
  }
  return {
    get, read, write, version: () => version,
    subscribe(notify: () => void) { subscribers.add(notify); return () => { subscribers.delete(notify) } },
    beginRename(sid: string) {
      const { confirmed, draft } = get(sid)
      if (!confirmed || draft) return
      const { title } = confirmed.preferences
      put(sid, { draft: { text: title, initial: title, revision: confirmed.revision } })
    },
    editRename(sid: string, text: string) {
      const { draft, pending } = get(sid)
      if (draft && !pending) put(sid, { draft: { ...draft, text } })
    },
    discardRename(sid: string) { if (!get(sid).pending) put(sid, { draft: undefined }) },
    saveRename(sid: string) {
      const { draft } = get(sid)
      return draft ? write(sid, { customTitle: normalizeTitle(draft.text) || null }, true) : Promise.resolve(false)
    }
  }
}
export type SessionPreferenceController = ReturnType<typeof createSessionPreferences>
