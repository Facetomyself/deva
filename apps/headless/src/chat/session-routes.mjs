import { HttpError, json, readJson } from '../http/policy.mjs'

/** Owner-only session metadata. The resource path supplies the only session scope. */
export async function sessionPreferenceRoute(req, res, { auth, policy }, turns, path, sid) {
  const write = req.method === 'PATCH'
  try {
    policy.check(req, write)
    if (req.url !== path) throw new HttpError(400, 'unexpected_query')
    if (!write && req.method !== 'GET') {
      json(res, 405, { error: 'method' }, { allow: 'GET, PATCH' })
      return
    }
    const cookie = policy.cookie(req)
    const authenticateWrite = () => {
      policy.check(req, true)
      auth.authenticate(cookie, req.headers['x-deva-csrf'])
    }
    if (!write) {
      auth.authenticate(cookie)
      json(res, 200, turns.getPreferences(sid))
      return
    }
    authenticateWrite()
    const body = await readJson(req, 8 * 1024)
    authenticateWrite()
    json(res, 200, await turns.patchPreferences(sid, body, authenticateWrite))
  } catch (error) {
    const known = error instanceof HttpError
    const status = known ? error.status : error?.code === 'AUTH_FAILED' ? 401 : 500
    if (!res.headersSent && !res.destroyed) json(res, status, { error: known ? error.code : status === 401 ? 'auth' : 'internal' }, write ? { connection: 'close' } : {})
  }
}
