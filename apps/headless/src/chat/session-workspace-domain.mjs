import { HttpError } from '../http/policy.mjs'
import {
  WORKSPACE_META, grantAccess, workspaceBinding, workspaceConflict, workspacePatch,
  workspaceProjection, workspaceRevision, workspaceUnavailable, workspaceView
} from './session-workspace.mjs'
import {
  confirmWorkspaceNative, matchesWorkspaceNative, readWorkspaceNative, workspaceFileStamp, workspaceStorageError
} from './session-workspace-storage.mjs'

const busy = () => new HttpError(409, 'turn_in_progress')

export function createSessionWorkspaceDomain({
  dataDir, withWorkspace, validSid, isClosing, isActive, isBlocked, compatibility, checkMedia,
  lookupSession, commit, quarantine, publishSessionsChanged
}) {
  const withGrant = grantAccess(withWorkspace)
  const drift = new Set()
  const stamps = new WeakMap()
  const knownWeb = new Map()
  const isDrifted = sid => drift.has(sid)
  const note = s => knownWeb.set(s.id, s)

  // Ordinary list/send never query the operator catalog. A cheap file stamp protects the
  // loaded native binding; an unexpected change falls back to strict native comparison.
  function stable(s) {
    if (isDrifted(s.id)) return false
    if (!s[WORKSPACE_META] || !workspaceBinding(s) || isBlocked(s.id)) return true
    try {
      const stamp = workspaceFileStamp(dataDir, s.id)
      if (stamp && stamps.get(s) === stamp) return true
      const native = readWorkspaceNative(dataDir, s.id)
      if (native?.privateMode && matchesWorkspaceNative(native, s)) {
        stamps.set(s, native.stamp)
        return true
      }
    } catch { /* unknown native state; quarantine for this process */ }
    drift.add(s.id)
    return false
  }

  function afterSave(s, readback) {
    const stamp = readback ? confirmWorkspaceNative(dataDir, s) : workspaceFileStamp(dataDir, s.id)
    if (!stamp) throw workspaceStorageError()
    stamps.set(s, stamp)
  }

  function nativeSession(sid, writing = false) {
    if (isBlocked(sid) || isDrifted(sid)) throw workspaceStorageError()
    const cached = knownWeb.get(sid)
    let native
    try { native = readWorkspaceNative(dataDir, sid) }
    catch (err) {
      if (cached) drift.add(sid)
      throw err
    }
    if (cached && (!native || !matchesWorkspaceNative(native, cached))) {
      drift.add(sid)
      throw writing && native ? workspaceConflict() : workspaceStorageError()
    }
    return native
  }

  function workspaceSession(sid, writing = false) {
    if (isClosing()) throw new HttpError(503, 'chat_closed')
    if (!validSid(sid)) throw new HttpError(400, 'invalid_session_id')
    if (writing && isActive(sid)) throw busy()
    const native = nativeSession(sid, writing)
    if (!native) throw new HttpError(404, 'session_not_found')
    const kind = compatibility(native.value)
    if (kind !== 'text') throw new HttpError(409, kind === 'legacy_text' ? 'read_only_session' : 'unsupported_history')
    if (!native.privateMode || (writing && !native.writable)) throw workspaceStorageError()
    checkMedia(native.value, knownWeb.get(sid))
    return native
  }

  function getWorkspace(sid) {
    const { value } = workspaceSession(sid)
    return workspaceView(value, workspaceBinding(value), withGrant)
  }

  function setWorkspace(sid, { workspaceId, revision }, verifyOwner) {
    function authenticate() {
      if (verifyOwner === undefined) return
      const verified = verifyOwner(sid)
      if (typeof verified?.then === 'function') {
        Promise.resolve(verified).catch(() => {})
        throw new HttpError(401, 'unauthorized')
      }
      if (verified === false) throw new HttpError(401, 'unauthorized')
    }
    function current() {
      const native = workspaceSession(sid, true)
      if (workspaceRevision(native.value) !== revision) throw workspaceConflict()
      return native
    }
    authenticate()
    const native = current()
    const binding = workspaceBinding(native.value)
    if ((binding?.id ?? null) === workspaceId) return workspaceView(native.value, binding, withGrant)
    let rollback
    function persist(before, grant) {
      const stored = lookupSession(sid)
      if (!stored || isDrifted(sid) || !matchesWorkspaceNative(before, stored)) throw workspaceStorageError()
      const patch = workspacePatch(sid, grant, grant ? 'manual' : null, workspaceBinding(stored)?.originalId ?? null)
      authenticate() // Disk and catalog work may have outlived the owner session.
      if (isClosing()) throw new HttpError(503, 'chat_closed')
      if (isActive(sid)) throw busy()
      if (isBlocked(sid) || isDrifted(sid)) throw workspaceStorageError()
      if (workspaceRevision(stored) !== revision || workspaceFileStamp(dataDir, sid) !== before.stamp) throw workspaceConflict()
      rollback = commit(stored, patch, null, () => afterSave(stored, true))
      return workspaceProjection(stored, patch[WORKSPACE_META], grant?.name)
    }
    let result
    try {
      // No await from authentication and CAS through native readback. Recheck inside the
      // pinned action as well, so a synchronous/reentrant adapter cannot defeat same-SID CAS.
      result = workspaceId === null ? persist(native) : withGrant(workspaceId, grant => persist(current(), grant))
    } catch (err) {
      if (!rollback) throw err
      rollback()
      quarantine(sid)
      throw workspaceStorageError()
    }
    if (!result) throw workspaceUnavailable()
    publishSessionsChanged()
    return result
  }

  return { note, stable, afterSave, isDrifted, nativeSession, withGrant, getWorkspace, setWorkspace }
}
