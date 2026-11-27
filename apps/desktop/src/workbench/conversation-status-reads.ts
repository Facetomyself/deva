import type { ChatProjection } from './chat-stream'
import type { ChatCursor, ChatState, ChatSummary } from './chat-transport'
import type { ConversationStatusTransport, ReadEntry, ReadObservation } from './conversation-status-transport'

const EMPTY = new Map<string, ReadEntry>()
export type ReadView = { entries: ReadonlyMap<string, ReadEntry>; phase: 'idle' | 'reading' | 'ready' | 'unavailable'; review?: string }
export const emptyReadView: ReadView = { entries: EMPTY, phase: 'idle' }
export const noReadSubscription = () => () => {}
const maxRemembered = 256
const isExpired = (error: unknown) => (error as { status?: number } | null)?.status === 401

export function eligibleReadRow<T extends Pick<ChatSummary, 'id' | 'compatibility' | 'archived'>>(row: T | undefined): row is T {
  return !!row && (row.compatibility === 'text' || row.compatibility === 'legacy_text') && !row.archived && !row.id.startsWith('task-')
}

export function matchingReadEntry(view: ReadView, row: ChatSummary | undefined): ReadEntry | undefined {
  if (!eligibleReadRow(row)) return
  const entry = view.entries.get(row.id)
  return entry?.updatedAt === row.updatedAt ? entry : undefined
}

export function hasDisplayedMessages(state: ChatState): boolean {
  return !!state.messages?.some(({ content, attachments }) => !!content.trim() || !!attachments?.length)
}

export function observeReading(row: ChatSummary | undefined, projection: ChatProjection | undefined, shown: boolean): ReadObservation | undefined {
  if (!shown || !eligibleReadRow(row) || projection?.status !== 'ready') return
  const snapshot = projection.snapshot
  const state = snapshot?.state
  if (!snapshot || !eligibleReadRow(state) || state.id !== row.id || state.updatedAt !== row.updatedAt || state.compatibility !== row.compatibility ||
    state.active || state.lastTurn?.status === 'running' || !hasDisplayedMessages(state) || snapshot.cursor.scope !== `chat:${row.id}`) return
  return { id: row.id, updatedAt: row.updatedAt, cursor: snapshot.cursor }
}

export function sameReadCursor(a: ChatCursor, b: ChatCursor): boolean {
  return a.scope === b.scope && a.epoch === b.epoch && a.generation === b.generation && a.seq === b.seq
}

/** Per login. Map refreshes follow the existing list owner; mutations never retry themselves. */
export function createConversationReads(api: Pick<ConversationStatusTransport, 'reads' | 'mark'>, expired: () => void) {
  let rows: readonly ChatSummary[] = []
  let selected: string | null = null
  let current = emptyReadView
  let query: AbortController | undefined
  let write: { controller: AbortController; observation: ReadObservation } | undefined
  let explicitRetry: string | undefined
  const listeners = new Set<() => void>()
  const attempted = new Map<string, ChatCursor>()
  const held = new Set<string>()

  function remember<T>(map: Map<string, T>, key: string, value: T): void {
    map.delete(key)
    map.set(key, value)
    if (map.size > maxRemembered) map.delete(map.keys().next().value!)
  }
  function hold(id: string): void {
    held.delete(id)
    held.add(id)
    if (held.size > maxRemembered) held.delete(held.values().next().value!)
  }
  function publish(phase: ReadView['phase'], entries: ReadView['entries']): void {
    current = { phase, entries, review: selected && held.has(selected) ? selected : undefined }
    listeners.forEach((listener) => listener())
  }
  function abortWrite(): void {
    const pending = write
    write = undefined
    if (!pending) return
    hold(pending.observation.id) // Abort cannot tell whether a dispatched write committed.
    pending.controller.abort()
  }
  async function refresh(): Promise<void> {
    query?.abort()
    query = undefined
    if (!rows.some(eligibleReadRow)) { publish('idle', EMPTY); return }
    const controller = new AbortController()
    query = controller
    publish('reading', current.entries)
    try {
      const entries = await api.reads(controller.signal)
      if (query !== controller || controller.signal.aborted) return
      // Every new owner-list snapshot gets a fresh map, even with the same IDs and timestamps.
      query = undefined
      if (selected) {
        const entry = entries.get(selected)
        const row = rows.find((candidate) => candidate.id === selected)
        if (entry && entry.updatedAt === row?.updatedAt && !entry.unread) {
          if (explicitRetry === selected) explicitRetry = undefined
          held.delete(selected)
        }
      }
      publish('ready', entries)
    } catch (error) {
      if (query !== controller || controller.signal.aborted) return
      query = undefined
      explicitRetry = undefined
      publish('unavailable', EMPTY)
      if (isExpired(error)) expired()
    }
  }
  async function mark(observation: ReadObservation): Promise<void> {
    const { id, updatedAt, cursor } = observation
    const row = rows.find((candidate) => candidate.id === id)
    const entry = matchingReadEntry(current, row)
    if (write || current.phase !== 'ready' || selected !== id || !entry?.unread || entry.updatedAt !== updatedAt) return
    const key = JSON.stringify([id, updatedAt])
    if (explicitRetry !== id && (held.has(id) || attempted.has(key))) return
    explicitRetry = undefined
    remember(attempted, key, cursor)
    const controller = new AbortController()
    const job = { controller, observation }
    write = job
    try {
      const { changed: _changed, ...ack } = await api.mark(observation, controller.signal)
      if (write !== job || controller.signal.aborted) return
      write = undefined
      held.delete(id)
      if (query || ack.readAt === null) { void refresh(); return }
      const shown = current.entries.get(id)
      if (current.phase === 'ready' && shown?.updatedAt === updatedAt) {
        publish('ready', new Map(current.entries).set(id, ack))
      } else publish(current.phase, current.entries)
    } catch (error) {
      if (write !== job || controller.signal.aborted) return
      write = undefined
      hold(id)
      if (isExpired(error)) { publish('unavailable', EMPTY); expired(); return }
      // Read the authoritative result under this login; a conflict and a lost acknowledgement are both non-replayable.
      void refresh()
    }
  }
  return {
    snapshot: () => current,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    scope(nextRows: readonly ChatSummary[], sid: string | null) {
      if (nextRows === rows && sid === selected) return
      if (sid !== selected) {
        abortWrite()
        explicitRetry = undefined
      }
      rows = nextRows
      selected = sid
      void refresh()
    },
    mark,
    retry(id: string) {
      if (id !== selected || write) return
      explicitRetry = id
      void refresh()
    },
    close() {
      query?.abort()
      query = undefined
      abortWrite()
      explicitRetry = undefined
      attempted.clear()
      held.clear()
      rows = []
      selected = null
      current = emptyReadView
    }
  }
}

export type ConversationReads = ReturnType<typeof createConversationReads>
