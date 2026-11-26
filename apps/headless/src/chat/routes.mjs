import { HttpError, json, readJson } from '../http/policy.mjs'

const collection = '/api/v1/chats'
const resource = /^\/api\/v1\/chats\/([A-Za-z0-9_-]{1,128})(?:\/(turns|stop))?$/

/** Owner-only typed commands. Streams are separate read-only WebSocket connections. Neither
 * this entry nor a caller-supplied payload can select a model URL, send a system prompt, or run tools. */
export function chatRoutes(turns) {
  return async (req, res, { auth, policy }) => {
    const path = (req.url ?? '').split('?', 1)[0]
    const match = resource.exec(path)
    if (path !== collection && !match) return false
    const write = req.method === 'POST'
    const methods = match ? [match[2] ? 'POST' : 'GET'] : ['GET', 'POST']
    try {
      policy.check(req, write)
      if (req.url !== path) throw new HttpError(400, 'unexpected_query')
      if (!methods.includes(req.method)) { json(res, 405, { error: 'method' }, { allow: methods.join(', ') }); return true }
      const cookie = policy.cookie(req)
      if (write) auth.authenticate(cookie, req.headers['x-deva-csrf']); else auth.authenticate(cookie)
      if (!match) {
        if (write) json(res, 200, { session: turns.create(await readJson(req, 512)) })
        else json(res, 200, { sessions: turns.list() })
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
