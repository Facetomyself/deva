import { HttpError, json, readJson } from '../http/policy.mjs'

const route = /^\/api\/v1\/workspaces\/(w_[a-f0-9]{32})\/(list|read|file)$/
const errors = new Map(Object.entries({
  ERR_WORKSPACE_UNAVAILABLE: [404, 'workspace_unavailable'],
  ERR_WORKSPACE_FILE_PATH: [400, 'invalid_workspace_path'],
  ERR_WORKSPACE_FILE_NOT_FOUND: [404, 'file_not_found'],
  ERR_WORKSPACE_FILE_UNSAFE: [403, 'unsafe_workspace_entry'],
  ERR_WORKSPACE_FILE_READ_ONLY: [403, 'workspace_read_only'],
  ERR_WORKSPACE_FILE_CONFLICT: [409, 'conflict'],
  ERR_WORKSPACE_FILE_LIMIT: [413, 'file_limit'],
  ERR_WORKSPACE_FILE_IO: [500, 'workspace_io'],
  AUTH_FAILED: [401, 'auth']
}))

/** Manual, owner-only document API. There is intentionally no session→file authority, no
 * model-supplied path and no generic command dispatcher. Reads use JSON to keep filenames
 * out of URLs and, like writes, require the existing same-origin CSRF binding. */
export function workspaceFileRoutes(files) {
  let pending = 0
  return async (req, res, { auth, policy }) => {
    const path = (req.url ?? '').split('?', 1)[0]
    const match = route.exec(path)
    if (!match) return false
    let held = false
    try {
      policy.check(req, true)
      if (req.url !== path) throw new HttpError(400, 'unexpected_query')
      const [, id, action] = match
      const desired = action === 'file' ? 'PUT' : 'POST'
      if (req.method !== desired) { json(res, 405, { error: 'method' }, { allow: desired, connection: 'close' }); return true }
      const cookie = policy.cookie(req)
      const check = () => auth.authenticate(cookie, req.headers['x-deva-csrf'])
      check()
      if (pending >= 8) throw new HttpError(503, 'workspace_busy')
      pending++; held = true
      const body = await readJson(req, action === 'file' ? 8 * 1024 * 1024 : 16 * 1024)
      const keys = action === 'file' ? ['path', 'content', 'revision'] : ['path']
      if (Object.keys(body).length !== keys.length || !keys.every(k => Object.hasOwn(body, k)) || typeof body.path !== 'string') throw new HttpError(400, 'invalid_fields')
      if (action === 'file' && (typeof body.content !== 'string' || typeof body.revision !== 'string')) throw new HttpError(400, 'invalid_fields')
      check() // Upload time may exceed the remaining lifetime of the initial validation.
      const result = action === 'file' ? await files.write(id, body) : action === 'read' ? await files.read(id, body.path) : await files.list(id, body.path)
      json(res, 200, result)
    } catch (error) {
      const known = error instanceof HttpError ? [error.status, error.code] : errors.get(error?.code) ?? [500, 'workspace_io']
      if (!res.headersSent && !res.destroyed) json(res, known[0], { error: known[1] }, { connection: 'close' })
    } finally { if (held) pending-- }
    return true
  }
}
