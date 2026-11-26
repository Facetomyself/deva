import { HttpError, json, readJson } from '../http/policy.mjs'

const collection = '/api/v1/tasks'
const item = /^\/api\/v1\/tasks\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})(\/status)?$/u
const failureStatus = new Map([
  ['preview_busy', 429], ['preview_timeout', 503], ['preview_closed', 503],
  ['preview_aborted', 409], ['preview_unavailable', 503]
])

/** Exact owner operations only. There is deliberately no dispatcher for running, resuming,
 * creating or deleting a desktop agent task. Preview computes a date, not an execution. */
export function taskRoutes({ store, preview }) {
  const lifetime = new AbortController(), live = new Set()
  let closed = false, drain

  async function serve(req, res, {auth, policy}, path, operation, id, permitted) {
    const changing = permitted !== 'GET', cancel = new AbortController()
    const signal = AbortSignal.any([lifetime.signal, cancel.signal])
    const disconnect = () => { if (!res.writableEnded) cancel.abort() }
    res.once('close', disconnect)
    try {
      // Validate the method's origin, even when the caller intentionally chose a wrong method.
      policy.check(req, req.method !== 'GET' && req.method !== 'HEAD')
      const cookie = policy.cookie(req)
      let actor
      const verify = () => {
        if (signal.aborted || closed || res.destroyed) throw new HttpError(503, 'task_closed')
        const current = changing ? auth.identify(cookie, req.headers['x-deva-csrf']) : auth.identify(cookie)
        if (!current || current.role !== 'owner' || (actor && (current.ownerId !== actor.ownerId || current.loginSessionId !== actor.loginSessionId))) {
          throw new HttpError(401, 'auth')
        }
        actor ??= current
        return actor
      }
      if (req.url !== path) throw new HttpError(400, 'unexpected_query')
      if (req.method !== permitted) { json(res,405,{error:'method'},{allow:permitted});return }
      verify()
      let result
      if (operation === 'list') result = await store.list()
      else if (operation === 'get') result = await store.get(id)
      else if (operation === 'preview') {
        const body = await readJson(req, 2048)
        verify()
        result = await preview.preview(body, signal)
      } else {
        const body = await readJson(req, 512)
        if (Object.keys(body).length !== 2 || !Object.hasOwn(body,'revision') || !Object.hasOwn(body,'status') ||
            body.status !== 'paused' || typeof body.revision !== 'string' || body.revision.length !== 64 || /[^0-9a-f]/u.test(body.revision)) {
          throw new HttpError(400, 'invalid_task_pause')
        }
        verify()
        result = await store.pause(id, body.revision, verify)
      }
      verify() // A slow disk/preview response must not deliver private data to a revoked login.
      json(res,200,result)
    } catch (error) {
      const known = error instanceof HttpError, previewFailure = failureStatus.get(error?.code)
      const status = known ? error.status : error?.code === 'AUTH_FAILED' ? 401 : previewFailure ?? 500
      const code = known || previewFailure ? error.code : status === 401 ? 'auth' : 'internal'
      if (!res.headersSent && !res.destroyed) json(res,status,{error:code},changing ? {connection:'close'} : {})
    } finally { res.off('close',disconnect) }
  }
  return {
    async handle(req, res, ctx) {
      const path = (req.url ?? '').split('?',1)[0]
      const matched = item.exec(path)
      // Native app records may use the literal ID "preview"; GET still inspects that
      // record, whereas an explicit POST to this exact resource previews a schedule.
      const op = path === collection ? 'list' : path === `${collection}/preview` && req.method === 'POST' ? 'preview'
        : matched ? matched[2] ? 'pause' : 'get' : null
      if (!op) return false
      const permitted = op === 'preview' ? 'POST' : op === 'pause' ? 'PATCH' : 'GET'
      if (closed || live.size >= 8) { json(res,closed?503:429,{error:closed?'task_closed':'task_busy'},{connection:'close'}); return true }
      const request = serve(req,res,ctx,path,op,matched?.[1],permitted)
      live.add(request)
      try { await request } finally { live.delete(request) }
      return true
    },
    close() {
      if (!drain) {
        closed=true;lifetime.abort()
        drain = (async () => {
          try { await Promise.all([preview.close(), ...live]) } finally { await store.close?.() }
        })()
      }
      return drain
    }
  }
}
