import { HttpError, json, readJson } from '../http/policy.mjs'

const pathPattern = /^\/api\/v1\/workspaces\/(w_[0-9a-f]{32})\/git\/(available|status|branches|log|diff)$/u

/** The HTTP surface is five fixed manual reads. The server, not the browser or a model,
 * binds a selected workspace and maps a short-lived entry ID to a diff comparison. */
export function gitViewRoutes(service) {
  let reading = 0
  return async function handle(req, res, {auth, policy}) {
    const raw = req.url ?? '', path = raw.split('?',1)[0], match = pathPattern.exec(path)
    if (!match || match[0] !== path) return false
    let reserved = false
    const abort = new AbortController()
    const disconnect = () => { if (!res.writableEnded) abort.abort() }
    try {
      policy.check(req, true)
      if (path !== raw) throw new HttpError(400, 'unexpected_query')
      if (req.method !== 'POST') { json(res,405,{error:'method'},{allow:'POST',connection:'close'}); return true }
      const cookie = policy.cookie(req), identify = () => auth.identify(cookie, req.headers['x-deva-csrf'])
      const actor = identify()
      if (!service) throw new HttpError(403, 'git_not_granted')
      if (reading >= 8) throw new HttpError(409, 'git_busy')
      reading++; reserved=true; res.once('close', disconnect)
      const body = await readJson(req, 1024)
      identify()
      if (res.destroyed) return true
      const result = await service.inspect(actor,match[1],match[2],body,abort.signal)
      identify()
      if (!res.destroyed) json(res,200,result)
    } catch (error) {
      const [status,code] = error instanceof HttpError ? [error.status,error.code] : error?.code === 'AUTH_FAILED' ? [401,'auth'] :
        error?.code === 'ERR_WORKSPACE_UNAVAILABLE' ? [404,'workspace_unavailable'] : [503,'git_unavailable']
      if (!res.headersSent && !res.destroyed) json(res,status,{error:code},{connection:'close'})
    } finally { if (reserved) reading--; res.off('close', disconnect) }
    return true
  }
}
