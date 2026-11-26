import { HttpError, json, readJson } from '../http/policy.mjs'
import { openSkillChanges } from './changes.mjs'

const base='/api/v1/skills'
const item=/^\/api\/v1\/skills\/([A-Za-z0-9][A-Za-z0-9_.-]{0,63})(\/preferences)?$/u
const errors = new Map([
  ['auth',401],['origin',403],['method',405],['unexpected_query',400],['invalid_json',400],['too_large',413],['json_required',415],
  ['skill_invalid',400],['skill_not_found',404],['skill_conflict',409],['skill_unknown_role',409],['skill_unsupported',409],
  ['skill_builtin',409],['skill_limit',413],['skill_restricted',422],['skill_read_only',403],['skill_busy',429],
  ['skill_unavailable',503],['skill_storage_unconfirmed',503]
])
const tag = value => typeof value==='string' && value.length===64 && !/[^0-9a-f]/u.test(value)

/** Read-only catalog plus two typed persistence operations; neither reads auxiliary resources,
 * invokes a skill nor grants tool access. Changes carry only an opaque catalog revision. */
export function skillLibraryRoutes({store,auth,documents}) {
  const changes=openSkillChanges({revision:()=>store.revision(),auth})
  const active = new Set(), lifetime=new AbortController()
  let closing=false,drain
  async function serve(req,res,policy,path,op,id) {
    const method=op==='set'?'PATCH':op==='changes'?'POST':'GET'
    const cancel=new AbortController(),signal=AbortSignal.any([cancel.signal,lifetime.signal])
    const disconnected=()=>{if(!res.writableFinished)cancel.abort()}
    res.once('close',disconnected)
    try {
      policy.check(req,req.method!=='GET' && req.method!=='HEAD')
      if(req.url!==path)throw new HttpError(400,'unexpected_query')
      if(req.method!==method){json(res,405,{error:'method'},{allow:method});return}
      const cookie=policy.cookie(req);let actor
      const verify=()=>{
        if(signal.aborted||closing||res.destroyed)throw new HttpError(503,'skill_unavailable')
        const current=method==='GET'?auth.identify(cookie):auth.identify(cookie,req.headers['x-deva-csrf'])
        if(!current || current.role!=='owner' || (actor && (current.ownerId!==actor.ownerId || current.loginSessionId!==actor.loginSessionId)))throw new HttpError(401,'auth')
        actor??=current;return actor
      }
      verify();let result
      if(op==='list')result=await store.list()
      else if(op==='get')result=await store.get(id)
      else if(op==='roles')result=await store.roles()
      else {
        const body=await readJson(req,op==='changes'?512:8192);verify()
        if(op==='changes')result=await changes.wait(actor,body,verify,signal)
        else {
          const on=Object.hasOwn(body,'enabled'),scoped=Object.hasOwn(body,'roles')
          if(Object.keys(body).length!==2 || !Object.hasOwn(body,'revision') || !tag(body.revision) || on===scoped ||
             (on && typeof body.enabled!=='boolean') || (scoped && body.roles!==null && !Array.isArray(body.roles)))throw new HttpError(400,'skill_invalid')
          result=await store.set(id,body,verify)
          // A no-op retains the same revision: waking an existing waiter just rechecks its cursor.
          changes.wake()
        }
      }
      verify();json(res,200,result)
    } catch (error) {
      const code=error?.code==='AUTH_FAILED'?'auth':errors.has(error?.code)?error.code:'skill_storage_unconfirmed'
      if(!res.destroyed && !res.headersSent)json(res,errors.get(code),{error:code},method==='GET'?{}:{connection:'close'})
    } finally {res.off('close',disconnected)}
  }
  return Object.freeze({
    async handle(req,res,{policy}) {
      const path=(req.url??'').split('?',1)[0], match=item.exec(path)
      const op=path===base?'list':path===base+'/-/roles'?'roles':path===base+'/-/changes'?'changes':match?(match[2]?'set':'get'):null
      if(!op)return false
      if(closing || active.size>=32){json(res,closing?503:429,{error:closing?'skill_unavailable':'skill_busy'},{connection:'close'});return true}
      const job=serve(req,res,policy,path,op,match?.[1]);active.add(job)
      try{await job}finally{active.delete(job)}return true
    },
    close(){
      if (!drain) {
        closing=true; lifetime.abort()
        drain=Promise.allSettled([changes.close(),...active]).then(async()=>{
          try { await store.close?.() } finally { documents?.close() }
        })
      }
      return drain
    }
  })
}
