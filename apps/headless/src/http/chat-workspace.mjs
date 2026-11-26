import { HttpError, json, readJson } from './policy.mjs'

const tag = /^[a-f0-9]{64}$/u
const id = /^w_[a-f0-9]{32}$/u
const matches = (value, pattern) => typeof value === 'string' && pattern.exec(value)?.[0] === value

function verifiedResponse(reply) {
  const unavailable = () => { throw new HttpError(503, 'chat_storage_unconfirmed') }
  if (!reply || !matches(reply.revision, tag)) unavailable()
  if (reply.workspace === null) return { workspace: null, revision: reply.revision }
  const { id: workspaceId, name, source, state } = reply.workspace ?? {}
  if (!matches(workspaceId, id) || !['manual', 'role'].includes(source) || !['available', 'unavailable'].includes(state) ||
      (state === 'unavailable' ? name !== null : typeof name !== 'string' || !name || /[\x00-\x1f\x7f/\\]/u.test(name))) unavailable()
  // Whitelist is intentional: native focusRoot and historical paths never leave the volume.
  return { workspace: { id: workspaceId, name, state, source }, revision: reply.revision }
}

/** A conversation preference, not a remote filesystem operation. GET never auto-binds.
 * Choosing a human workspace does not read files, notes or Git and does not start a turn. */
export function makeChatWorkspaceRoute(turns) {
  let pending = 0
  return async (req, res, { auth, policy }, path, sid) => {
    const write = req.method === 'PATCH'
    let admitted = false
    try {
      policy.check(req, write)
      if (req.url !== path) throw new HttpError(400, 'unexpected_query')
      if (!write && req.method !== 'GET') { json(res,405,{error:'method'},{allow:'GET, PATCH'}); return }
      const cookie = policy.cookie(req)
      const authorize = () => write ? auth.authenticate(cookie, req.headers['x-deva-csrf']) : auth.authenticate(cookie)
      authorize()
      if (typeof turns.getWorkspace !== 'function' || typeof turns.setWorkspace !== 'function') throw new HttpError(503, 'workspace_binding_unavailable')
      if (pending >= 8) throw new HttpError(429, 'workspace_busy')
      pending++; admitted = true
      let result
      if (write) {
        const body = await readJson(req, 1024)
        if (Object.keys(body).length !== 2 || !Object.hasOwn(body, 'workspaceId') || !Object.hasOwn(body, 'revision')) throw new HttpError(400, 'invalid_workspace')
        if (body.workspaceId !== null && !matches(body.workspaceId, id)) throw new HttpError(400, 'invalid_workspace_id')
        if (!matches(body.revision, tag)) throw new HttpError(400, 'invalid_workspace_revision')
        authorize()
        result = turns.setWorkspace(sid, body, authorize)
      } else result = turns.getWorkspace(sid)
      const value = verifiedResponse(await result)
      authorize()
      if (!res.destroyed) json(res, 200, value)
    } catch (error) {
      const status = error instanceof HttpError ? error.status : error?.code === 'AUTH_FAILED' ? 401 : 500
      if (!res.headersSent && !res.destroyed) json(res, status, { error: error instanceof HttpError ? error.code : status === 401 ? 'auth' : 'internal' }, write ? { connection: 'close' } : {})
    } finally { if (admitted) pending-- }
  }
}
