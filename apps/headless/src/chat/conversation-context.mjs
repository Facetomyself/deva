import { chatScope } from '../events/index.mjs'
import { HttpError } from '../http/policy.mjs'
import { isDeepStrictEqual } from 'node:util'
import { MAX_NATIVE_BYTES, readLimit, readUnavailable, withConversationFiles } from './conversation-context-storage.mjs'

const MAX_DIRECTORY_ENTRIES = 16384
const MAX_CANDIDATES = 8192
const MAX_MESSAGES = 4096
const MAX_PARTS = 16384
const missing = () => new HttpError(404, 'session_not_found')
const unsupported = () => new HttpError(409, 'unsupported_history')
const busy = () => new HttpError(409, 'read_view_busy')
const stale = () => new HttpError(409, 'read_view_stale')
const time = n => Number.isSafeInteger(n) && n >= 0
const sameCursor = (a, b) => a?.scope === b.scope && a.epoch === b.epoch && a.generation === b.generation && a.seq === b.seq
const contentsMatch = (native, s) => isDeepStrictEqual(native, Object.fromEntries(Object.entries(s).filter(([_key, value]) => value !== undefined)))

// A desktop read marker is a Date timestamp. Its representable ceiling leaves room for
// monotonic admission and finalization even on a skewed or deliberately fixed wall clock.
export const MAX_CONVERSATION_WATERMARK = 8_640_000_000_000_000
export function nextConversationUpdatedAt(previous, wallTime = Date.now(), watermark) {
  const native = time(watermark) && watermark <= MAX_CONVERSATION_WATERMARK ? watermark : 0
  const next = Math.max(previous + 1, wallTime, native + 1)
  if (!time(previous) || !time(wallTime) || !time(next)) throw new HttpError(503, 'chat_storage_unconfirmed')
  return next
}

// One user entry and at most one assistant reply per receipt. Admitted-but-unfinished
// records are visible after restart as interrupted, never as a fabricated latest reply.
export function matchesTurnLayout(messages, requests) {
  let at = 0
  for (const request of requests) {
    if (messages[at++]?.role !== 'user') return false
    if (messages[at]?.role === 'assistant') {
      if (request.status === 'running' || request.status === 'interrupted') return false
      at++
    }
  }
  return at === messages.length
}

function checkShape(s, sid) {
  if (s === null || typeof s !== 'object' || Array.isArray(s) || s.id !== sid || typeof s.title !== 'string' ||
      !time(s.createdAt) || !time(s.updatedAt) || !Array.isArray(s.messages)) throw readUnavailable()
  if (s.compacted !== undefined || s.messages.length > MAX_MESSAGES) throw unsupported()
  let parts = 0
  for (const m of s.messages) {
    if (!m || !['user', 'assistant'].includes(m.role)) throw unsupported()
    if (typeof m.content === 'string') continue
    if (!Array.isArray(m.content) || (parts += m.content.length) > MAX_PARTS ||
        m.content.some(p => !p || typeof p.type !== 'string')) throw unsupported()
  }
}

/** Independent read-only proof; the chat-store loader can repair the index or clean up sidecars,
 * so these endpoints never use it to populate the writer's cache. */
export function createConversationContext({ dataDir, validSid, journal, cached, blocked, closing, active, inspect, unreadable }) {
  const candidates = new Map() // bounded stamps and booleans only; never retain another copy of a transcript
  const forgetCandidate = sid => candidates.delete(sid)
  function assertAvailable(sid) {
    if (!validSid(sid)) throw new HttpError(400, 'invalid_session_id')
    if (closing()) throw new HttpError(503, 'chat_closed')
    if (blocked(sid)) throw readUnavailable()
    if (unreadable(sid)) throw unsupported()
  }

  function view(file, sid, expected) {
    const session = file.parse()
    checkShape(session, sid)
    const layout = inspect(session, expected)
    if (!layout) throw unsupported()
    if ((!file.privateMode && layout.owned) || (expected && !contentsMatch(session, expected))) throw readUnavailable()
    return { session, layout, stamp: file.stamp, expected }
  }

  function read(sid) {
    assertAvailable(sid)
    const expected = cached(sid)
    const value = withConversationFiles(dataDir, files => files?.read(sid, file => view(file, sid, expected)))
    if (!value) throw expected ? readUnavailable() : missing()
    return value
  }

  // Only use this for a strict-save readback, before advertising a terminal measurement.
  function confirm(s) {
    const ok = withConversationFiles(dataDir, files => files?.read(s.id, file => file.privateMode && contentsMatch(file.parse(), s)))
    if (!ok) throw readUnavailable()
  }

  function stable(sid, stamp, updatedAt, expected) {
    assertAvailable(sid)
    const now = cached(sid)
    if ((expected && expected !== now) || (now && now.updatedAt !== updatedAt)) return false
    return withConversationFiles(dataDir, files => files?.read(sid, file => file.stamp === stamp)) === true
  }

  function refresh(sid, current) {
    return stable(sid, current.stamp, current.session.updatedAt, current.expected) ? current : read(sid)
  }

  function readCandidates() {
    if (closing()) return []
    return withConversationFiles(dataDir, files => {
      if (!files) return []
      let budget = MAX_NATIVE_BYTES
      const result = []
      for (const id of files.scan(MAX_DIRECTORY_ENTRIES)) {
        if (!validSid(id) || blocked(id) || active(id) || unreadable(id)) continue
        let proof
        try {
          const expected = cached(id)
          proof = files.read(id, file => {
            const previous = candidates.get(id)
            if (previous?.stamp === file.stamp && previous.cached === (expected !== undefined) &&
                (!expected || expected.updatedAt === previous.updatedAt)) return previous
            if (file.size > budget) throw readLimit()
            budget -= file.size
            const identity = { stamp: file.stamp, cached: expected !== undefined, updatedAt: expected?.updatedAt }
            try {
              const { session, layout } = view(file, id, expected)
              return { ...identity, updatedAt: session.updatedAt, eligible: layout.eligible }
            } catch (error) {
              if (!(error instanceof HttpError) || error.status !== 409) throw error
              return { ...identity, eligible: false }
            }
          })
        } catch (error) {
          if (!(error instanceof HttpError) || error.status !== 409) throw error
        }
        forgetCandidate(id)
        if (!proof) continue
        if (candidates.size >= MAX_DIRECTORY_ENTRIES) forgetCandidate(candidates.keys().next().value)
        candidates.set(id, proof)
        if (proof.eligible) {
          if (result.length === MAX_CANDIDATES) throw readLimit()
          result.push({ id, updatedAt: proof.updatedAt })
        }
      }
      return result.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    })
  }

  function readObservation(sid) {
    if (!validSid(sid)) throw new HttpError(400, 'invalid_session_id')
    if (active(sid)) throw busy()
    const scope = chatScope(sid)
    const { session: { updatedAt }, layout: { eligible }, stamp, expected } = read(sid)
    let initial
    try {
      initial = journal.snapshot(scope, () => stable(sid, stamp, updatedAt, expected))
    } catch (error) {
      if (error instanceof HttpError) throw error
      throw error?.code === 'SNAPSHOT_CHANGED' ? stale() : readUnavailable()
    }
    if (active(sid)) throw busy()
    if (!initial.state) throw stale()
    const cursor = Object.freeze({ ...initial.cursor })
    if (cursor.scope !== scope || typeof cursor.epoch !== 'string' || typeof cursor.generation !== 'string' || !time(cursor.seq)) throw readUnavailable()
    return Object.freeze({ id: sid, updatedAt, cursor, eligible, verify() {
      if (active(sid)) throw busy()
      let now
      try { now = journal.snapshot(scope, () => stable(sid, stamp, updatedAt, expected)) }
      catch { throw stale() }
      if (active(sid)) throw busy()
      if (!now.state || !sameCursor(now.cursor, cursor)) throw stale()
      return true
    } })
  }

  return { read, refresh, confirm, readCandidates, readObservation }
}
