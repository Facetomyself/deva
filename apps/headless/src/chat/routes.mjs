import { HttpError, json, readJson } from '../http/policy.mjs'
import { sessionPreferenceRoute } from './session-routes.mjs'
import { isChatRoleId } from './text-turns.mjs'

const collection = '/api/v1/chats'
const resource = /^\/api\/v1\/chats\/([A-Za-z0-9_-]{1,128})(?:\/(turns|stop|preferences))?$/
const roleServiceError = () => new HttpError(503, 'chat_role_unavailable')
const roleUnavailable = () => new HttpError(409, 'role_unavailable')

async function createBoundSession(turns, withRoleForChat, body, authenticate) {
  if (Object.keys(body).some(key => key !== 'sessionId' && key !== 'personaId')) throw new HttpError(400, 'invalid_create')
  const { personaId } = body
  if (!isChatRoleId(personaId)) throw new HttpError(400, 'invalid_persona_id')
  if (!withRoleForChat) throw roleServiceError()
  const options = Object.hasOwn(body, 'sessionId') ? { sessionId: body.sessionId } : {}
  let session, finished = false
  try {
    const result = await withRoleForChat(personaId, role => {
      if (finished || session) throw roleServiceError()
      // The library may queue this operation; recheck ownership at the point of persistence.
      authenticate()
      if (role == null) throw roleUnavailable()
      if (role.id !== personaId) throw roleServiceError()
      // Keep this callback synchronous: the strict session write completes inside the library queue.
      session = turns.create(options, role)
      return session
    })
    if (!session) throw result == null ? roleUnavailable() : roleServiceError()
    return session
  } catch (error) {
    if (error instanceof HttpError || error?.code === 'AUTH_FAILED') throw error
    throw roleServiceError()
  } finally { finished = true }
}

/** Owner-only typed commands. Streams are separate read-only WebSocket connections. Neither
 * this entry nor a caller-supplied payload can select a model URL, send a system prompt, or run tools. */
export function chatRoutes(turns, { withRoleForChat } = {}) {
  if (withRoleForChat !== undefined && typeof withRoleForChat !== 'function') throw new TypeError('withRoleForChat must be a function')
  return async (req, res, { auth, policy }) => {
    const path = (req.url ?? '').split('?', 1)[0]
    const match = resource.exec(path)
    if (path !== collection && !match) return false
    if (match?.[2] === 'preferences') {
      await sessionPreferenceRoute(req, res, { auth, policy }, turns, path, match[1])
      return true
    }
    const write = req.method === 'POST'
    const methods = match ? [match[2] ? 'POST' : 'GET'] : ['GET', 'POST']
    try {
      policy.check(req, write)
      if (req.url !== path) throw new HttpError(400, 'unexpected_query')
      if (!methods.includes(req.method)) { json(res, 405, { error: 'method' }, { allow: methods.join(', ') }); return true }
      const cookie = policy.cookie(req)
      const authenticateWrite = () => auth.authenticate(cookie, req.headers['x-deva-csrf'])
      if (write) authenticateWrite(); else auth.authenticate(cookie)
      if (!match) {
        if (write) {
          const body = await readJson(req, 512)
          const session = Object.hasOwn(body, 'personaId')
            ? await createBoundSession(turns, withRoleForChat, body, authenticateWrite)
            : turns.create(body)
          json(res, 200, { session })
        } else json(res, 200, { sessions: turns.list() })
      } else if (!write) {
        json(res, 200, turns.snapshot(match[1]))
      } else {
        const body = await readJson(req, match[2] === 'turns' ? 80 * 1024 : 512)
        // sid is derived solely from the authenticated resource path, never from the body.
        if (Object.hasOwn(body, 'sid')) throw new HttpError(400, 'unexpected_session_id')
        const args = { ...body, sid: match[1] }
        if (match[2] === 'turns') {
          const ack = await turns.send(args)
          json(res, ack.duplicate ? 200 : 202, ack)
        } else json(res, 200, turns.stop(args))
      }
    } catch (error) {
      const known = error instanceof HttpError
      const status = known ? error.status : error?.code === 'AUTH_FAILED' ? 401 : 500
      if (!res.headersSent && !res.destroyed) json(res, status, { error: known ? error.code : status === 401 ? 'auth' : 'internal' }, write ? { connection: 'close' } : {})
    }
    return true
  }
}
