import { isContextModelRef } from '../business/context-model.mjs'
import { chatScope } from '../events/journal.mjs'
import { MAX_CONVERSATION_WATERMARK } from './conversation-context.mjs'
import { HttpError, json, readJson } from '../http/policy.mjs'

const listPath='/api/v1/conversation-status/reads'
const chatPath=/^\/api\/v1\/chats\/([A-Za-z0-9_-]{1,128})\/(read-state|context-usage)$/u
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const exact=(obj,fields)=>obj!==null && typeof obj==='object' && !Array.isArray(obj) &&
  Object.keys(obj).length===fields.length && fields.every(k=>Object.hasOwn(obj,k))
const integer=n=>Number.isSafeInteger(n) && n>=0
const id=s=>typeof s==='string' && s.length===36 && uuid.test(s)
const codes=Object.freeze({
  auth:401, origin:403, unexpected_query:400, json_required:415, invalid_json:400, too_large:413,
  invalid_session_id:400, session_not_found:404, invalid_read_view:400, invalid_model_ref:400,
  read_view_stale:409, read_view_busy:409, unsupported_history:409, read_unavailable:409,
  read_state_read_only:403, read_state_conflict:409, read_state_unsupported:409, read_state_limit:413,
  read_state_unconfirmed:503, chat_model_unavailable:503, chat_storage_unconfirmed:503,
  conversation_status_busy:429, conversation_status_unavailable:503, chat_closed:503,
})
const unavailable=()=>new HttpError(503,'conversation_status_unavailable')
function sameCursor(a,b) {return a.epoch===b.epoch && a.generation===b.generation && a.scope===b.scope && a.seq===b.seq}
function storedTime(value) {
  if (value===null) return null
  if (!integer(value) || value>MAX_CONVERSATION_WATERMARK) throw new HttpError(409,'read_state_unsupported')
  return value
}
function seenInput(body,sid) {
  const c=body.cursor
  if (!exact(body,['updatedAt','cursor']) || !integer(body.updatedAt) || !exact(c,['epoch','generation','scope','seq']) ||
      !id(c.epoch) || !id(c.generation) || !integer(c.seq) || c.scope!==chatScope(sid)) throw new HttpError(400,'invalid_read_view')
}

/** Read status is a shared owner preference, not a grant on a transcript. A foreground
 * page may acknowledge only the durable snapshot it actually had, not a client clock. */
export function conversationStatusRoutes({turns,marks,journal}) {
  const active=new Set()
  let closed=false,drain
  function list(verify) {
    const rows=turns.readCandidates()
    const stored=marks.snapshot()
    const entries=rows.map(({id,updatedAt})=>{
      const readAt=storedTime(stored.get(id)??null)
      return {id,updatedAt,readAt,unread:readAt===null || readAt<updatedAt}
    })
    verify();return {entries}
  }
  function mark(sid,body,verify) {
    seenInput(body,sid)
    const observed=turns.readObservation(sid)
    const assertCurrent=()=>{
      verify()
      if (observed.updatedAt!==body.updatedAt || !sameCursor(observed.cursor,body.cursor)) throw new HttpError(409,'read_view_stale')
      if (observed.verify()!==true) throw new HttpError(409,'read_view_stale')
      return verify()
    }
    assertCurrent()
    if (!observed.eligible) return {id:sid,updatedAt:observed.updatedAt,readAt:null,unread:false,changed:false}
    const {changed,readAt}=marks.advance({id:sid,through:observed.updatedAt},assertCurrent)
    storedTime(readAt)
    assertCurrent()
    if (changed) journal.publishSessionsChanged()
    return {id:sid,updatedAt:observed.updatedAt,readAt,unread:false,changed}
  }
  async function serve(req,res,{auth,policy},path,match) {
    const method=path===listPath?'GET':'POST'
    try {
      policy.check(req,req.method!=='GET' && req.method!=='HEAD')
      if (req.url!==path) throw new HttpError(400,'unexpected_query')
      if (req.method!==method) {json(res,405,{error:'method'},{allow:method,connection:'close'});return}
      const cookie=policy.cookie(req);let actor
      const verify=()=>{
        if (closed || res.destroyed) throw unavailable()
        const current=method==='GET'? auth.identify(cookie):auth.identify(cookie,req.headers['x-deva-csrf'])
        if (!current || current.role!=='owner' || (actor && (current.ownerId!==actor.ownerId || current.loginSessionId!==actor.loginSessionId))) throw new HttpError(401,'auth')
        actor??=current;return true
      }
      verify();let result
      if (method==='GET') result=list(verify)
      else {
        const [,sid,operation]=match
        const body=await readJson(req,operation==='read-state'?1024:4096,{uniqueMembers:'deep'});verify()
        if (operation==='read-state') result=mark(sid,body,verify)
        else {
          if (!exact(body,['model']) || !(body.model===null || isContextModelRef(body.model))) throw new HttpError(400,'invalid_model_ref')
          result=await turns.contextUsage(sid,body,verify)
        }
      }
      verify();json(res,200,result)
    } catch(error) {
      // A malformed stored file is not bad client input. Preserve that file and
      // leave every unrelated chat route operational rather than fabricating empty marks.
      const code=error?.code==='AUTH_FAILED'?'auth':error instanceof HttpError && error.code==='invalid_read_state'?'read_state_unconfirmed':
        error instanceof HttpError && Object.hasOwn(codes,error.code) && codes[error.code]===error.status ? error.code:'conversation_status_unavailable'
      if (!res.destroyed && !res.headersSent) json(res,codes[code],{error:code},method==='POST'?{connection:'close'}:{})
    }
  }
  return Object.freeze({
    async handle(req,res,ctx) {
      const path=(req.url??'').split('?',1)[0],match=chatPath.exec(path)
      if (path!==listPath && (!match || match[0]!==path)) return false
      if (closed || active.size>=16) {json(res,closed?503:429,{error:closed?'conversation_status_unavailable':'conversation_status_busy'},{connection:'close'});return true}
      const job=serve(req,res,ctx,path,match);active.add(job)
      try {await job} finally {active.delete(job)}return true
    },
    close(){if(!drain){closed=true;drain=Promise.allSettled([...active]).then(()=>marks.close())}return drain}
  })
}
