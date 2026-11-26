import { HttpError, json, readJson } from '../http/policy.mjs'

const profileUrl = '/api/v1/terminal/profiles'
const resources = /^\/api\/v1\/workspaces\/(w_[a-f0-9]{32})\/terminals(?:\/(pt_[a-f0-9]{32})\/(input|resize|events|dispose))?$/u
const allow = new Set(['terminal_not_found','terminal_invalid','terminal_unavailable','terminal_source_changed',
  'terminal_sequence','terminal_cursor','terminal_busy','terminal_unsupported','terminal_source_denied','terminal_limit'])

/** Every content/control operation is authorized for the current *login*; the private
 * domain and worker handle identity, file grants, capacity, real exits and receipts.
 * This router does not accept raw keystrokes, environment, commands or terminal bytes. */
export function terminalRoutes(service) {
  let pending = 0, closing = false
  const requests = new Set(), lifetime = new AbortController()
  let drain
  async function serve(req, res, {auth, policy}, path, match) {
    const method = path === profileUrl ? 'GET' : 'POST'
    const [wid,id,op] = match?.slice(1) ?? []
    const ended = new AbortController()
    const interrupt = () => { if (!res.writableFinished) ended.abort() }
    const signal = AbortSignal.any([lifetime.signal,ended.signal])
    let actor, created, published = false
    res.once('close',interrupt)
    try {
      policy.check(req,req.method !== 'GET' && req.method !== 'HEAD')
      if (path !== req.url) throw new HttpError(400,'unexpected_query')
      if (req.method !== method) { json(res,405,{error:'method'},{allow:method}); return }
      const cookie = policy.cookie(req)
      const identify = () => method==='GET' ? auth.identify(cookie) : auth.identify(cookie,req.headers['x-deva-csrf'])
      const verify = () => {
        if (closing) throw new HttpError(503,'terminal_unavailable')
        const current = identify()
        if (!current || current.role!=='owner' || (actor && (actor.ownerId!==current.ownerId || actor.loginSessionId!==current.loginSessionId))) throw new HttpError(401,'auth')
        actor ??= current
        return actor
      }
      verify()
      if (pending >= 20) throw new HttpError(429,'terminal_busy')
      pending++
      try {
        let result, status=200
        if (method==='GET') result=service ? await service.profiles(actor,verify) : {available:false, profiles:[], reason:'unconfigured'}
        else {
          if (!service) throw new HttpError(503,'terminal_unavailable')
          const body=await readJson(req,op ? 512 : 8192)
          verify()
          if (signal.aborted) throw new HttpError(503,'terminal_unavailable')
          if (!op) {
            result=await service.start(actor,wid,body,()=>{ if (signal.aborted) return false; return verify() })
            created=result.id;status=201
          } else if (op==='input') result=await service.input(actor,wid,id,body,verify)
          else if (op==='resize') result=await service.resize(actor,wid,id,body,verify)
          else if (op==='events') result=await service.events(actor,wid,id,body,verify,signal)
          else {
            if (Object.keys(body).length) throw new HttpError(400,'terminal_invalid')
            result=await service.dispose(actor,wid,id,verify)
          }
        }
        verify()
        if (signal.aborted || res.destroyed) return
        json(res,status,result);published=true
      } finally { pending-- }
    } catch (error) {
      const known = error instanceof HttpError
      const code = known && (allow.has(error.code) || ['auth','origin','unexpected_query','too_large','invalid_json','json_required'].includes(error.code))
        ? error.code : error?.code==='AUTH_FAILED' ? 'auth' : 'terminal_unavailable'
      const status = code==='auth' ? 401 : known && code===error.code ? error.status : 503
      if (!res.headersSent && !res.destroyed) json(res,status,{error:code},method==='POST'?{connection:'close'}:{})
    } finally {
      res.off('close',interrupt)
      if (created && !published) await service.dispose(actor,wid,created).catch(()=>{})
    }
  }
  return {
    async handle(req,res,ctx) {
      const path=(req.url??'').split('?',1)[0]
      const match=resources.exec(path)
      if (path!==profileUrl && !match) return false
      if (closing) { json(res,503,{error:'terminal_unavailable'},{connection:'close'});return true }
      const task=serve(req,res,ctx,path,match);requests.add(task)
      try { await task } finally { requests.delete(task) }
      return true
    },
    close() {
      if (!drain) { closing=true;lifetime.abort();drain=Promise.allSettled([service?.close(),...requests]).then(()=>{}) }
      return drain
    }
  }
}
