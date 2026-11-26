import { createHash, randomBytes } from 'node:crypto'
import { basename, isAbsolute, resolve } from 'node:path'
import { validWorkspaceName } from '../files/workspace-files-fd.mjs'
import { HttpError } from '../http/policy.mjs'

export const WORKSPACE_META = '_devaHeadlessSessionWorkspace'
const hex = (value, size) => typeof value === 'string' && value.length === size && !/[^a-f0-9]/.test(value)
export const validWorkspaceId = value => typeof value === 'string' && value.startsWith('w_') && hex(value.slice(2), 32)
export const workspaceConflict = () => new HttpError(409, 'workspace_conflict')
export const workspaceUnavailable = () => new HttpError(404, 'workspace_unavailable')
const serviceError = () => new HttpError(503, 'chat_workspace_unavailable')
const digest = fields => createHash('sha256').update(JSON.stringify(fields)).digest('hex')
const validRoot = value => typeof value === 'string' && value.length <= 4095 && Buffer.byteLength(value) <= 4095 &&
  value.isWellFormed() && !value.includes('\0') && isAbsolute(value) && value !== '/' && resolve(value) === value

export function readWorkspaceInput({ workspaceId, revision }) {
  if (workspaceId !== null && !validWorkspaceId(workspaceId)) throw new HttpError(400, 'invalid_workspace_id')
  if (!hex(revision, 64)) throw new HttpError(400, 'invalid_workspace_revision')
  return { workspaceId, revision }
}

// This ties Web provenance to the native root and SID, rather than authorizing a filesystem
// operation. Current authority always comes from the operator catalog with its pin held.
const integrity = (sid, root, { id, source, originalId, generation }) =>
  digest(['deva:native-session-workspace:v1', sid, root, id, source, originalId, generation])

/** undefined = a never-bound native Web session; false = invalid/foreign record. */
export function workspaceBinding(s) {
  if (!Object.hasOwn(s, WORKSPACE_META)) return s.focusRoot == null ? undefined : false
  const value = s[WORKSPACE_META]
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== 6 || value.version !== 1 ||
      !hex(value.generation, 32) || !hex(value.integrity, 64) ||
      (value.originalId !== null && !validWorkspaceId(value.originalId))) return false
  if (value.id === null ? value.source !== null || s.focusRoot !== null
    : !validWorkspaceId(value.id) || !['manual', 'role'].includes(value.source) || !validRoot(s.focusRoot)) return false
  return integrity(s.id, s.focusRoot, value) === value.integrity ? value : false
}

export function workspaceRevision(s, binding = workspaceBinding(s)) {
  // No native path enters the public revision; the random generation separates detach/rebind ABA.
  return digest(['deva:session-workspace-revision:v1', s.id, binding?.generation ?? null])
}

export function workspacePatch(sid, grant, source, originalId) {
  const root = grant?.root ?? null
  const meta = { version: 1, id: grant?.id ?? null, source, originalId, generation: randomBytes(16).toString('hex') }
  return { focusRoot: root, [WORKSPACE_META]: { ...meta, integrity: integrity(sid, root, meta) } }
}

/** Use the grant synchronously and exclusively in the caller's pinned catalog action. */
export function grantAccess(withWorkspace) {
  if (withWorkspace !== undefined && typeof withWorkspace !== 'function') throw new TypeError('withWorkspace must be a function')
  return (id, use) => {
    if (!withWorkspace) return undefined
    let open = true, called = false, outcome, actionError, returned
    try {
      returned = withWorkspace(id, grant => {
        if (!open || called) throw serviceError()
        called = true
        try {
          if (!grant || !Object.isFrozen(grant) || grant.id !== id || !validRoot(grant.root) ||
              !validWorkspaceName(grant.name) || basename(grant.root) !== grant.name) throw serviceError()
          outcome = use(grant)
          if (outcome === undefined) throw serviceError()
          return outcome
        } catch (err) { actionError = err; throw err }
      })
    } catch (err) {
      if (err === actionError) throw err
      throw serviceError()
    } finally { open = false }
    if (actionError) throw actionError
    if (called ? returned !== outcome : returned !== undefined) throw serviceError()
    return returned
  }
}

export function workspaceProjection(s, binding, name = null) {
  const revision = workspaceRevision(s, binding)
  const workspace = binding?.id ? { id: binding.id, name, state: name === null ? 'unavailable' : 'available', source: binding.source } : null
  return { workspace, revision }
}

export function workspaceView(s, binding, withGrant) {
  if (!binding?.id) return workspaceProjection(s, binding)
  const name = withGrant(binding.id, grant => ({ name: grant.root === s.focusRoot ? grant.name : null }))?.name ?? null
  return workspaceProjection(s, binding, name)
}
