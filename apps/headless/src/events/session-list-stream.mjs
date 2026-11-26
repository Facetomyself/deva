import { HttpError } from '../http/policy.mjs'
import { SESSIONS_SCOPE } from './journal.mjs'

const journalId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export const SESSION_LIST_PATH = '/api/v1/chats/stream'
export const MAX_SESSION_LIST_EVENT_BYTES = 512

export function attachSessionListStream(journal, cursor, callbacks) {
  if (cursor && (cursor.scope !== SESSIONS_SCOPE || !journalId.test(cursor.epoch) || !journalId.test(cursor.generation))) {
    throw new HttpError(400, 'invalid_cursor')
  }
  // The cursor is a reconnect hint only. Never replay obsolete invalidations or
  // trust a client-supplied sequence as the watermark (even after restart).
  const { cursor: latest, subscription } = journal.watchSessions(callbacks)
  return { subscription, initial: JSON.stringify({ t: 'sessions-snapshot', cursor: latest }) }
}

export function projectSessionListEvent(frame) {
  if (frame.type !== 'sessions_changed' || frame.cursor?.scope !== SESSIONS_SCOPE) return null
  const { epoch, generation, seq } = frame.cursor
  return { t: 'sessions-changed', cursor: { epoch, generation, scope: SESSIONS_SCOPE, seq } }
}
