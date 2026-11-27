import { HttpError, json, readJson } from '../http/policy.mjs'

const collection = /^\/api\/v1\/workspaces\/(w_[a-f0-9]{32})\/document-intents(?:\/(di_[a-f0-9]{32})\/(create|status|cancel))?$/u
const codes = Object.freeze({
  auth:401, origin:403, unexpected_query:400, invalid_json:400, too_large:413, json_required:415,
  document_invalid:400, document_read_only:403, document_unsafe:403, workspace_unavailable:404,
  document_intent_missing:404, document_exists:409, document_changed:409, document_conflict:409,
  document_limit:413, document_restricted:422, document_busy:429, document_unconfirmed:503, document_unavailable:503,
})
const stop = () => new HttpError(503,'document_unavailable')
const exact = (value,fields) => Object.keys(value).length===fields.length && fields.every(key=>Object.hasOwn(value,key))

/** A human may check an empty named slot, then explicitly publish one ordinary document there.
 * Filenames and document text stay in authenticated bodies. A transport error is not a reason
 * to retry a creation: the same login can instead inspect the original intent's disk receipt. */
export function projectDocumentRoutes(service) {
  const active=new Set()
  let closing=false,drain
  async function serve(req,res,{auth,policy},path,match) {
    const [,workspace,id,op]=match
    let actor,prepared,published=false
    try {
      policy.check(req, req.method!=='GET' && req.method!=='HEAD')
      if (req.url!==path) throw new HttpError(400,'unexpected_query')
      if (req.method!=='POST') { json(res,405,{error:'method'},{allow:'POST',connection:'close'});return }
      const cookie=policy.cookie(req)
      const verify=()=>{
        const identity=auth.identify(cookie,req.headers['x-deva-csrf'])
        if (!identity || identity.role!=='owner' || actor && (identity.ownerId!==actor.ownerId || identity.loginSessionId!==actor.loginSessionId)) throw new HttpError(401,'auth')
        if (closing || res.destroyed) throw stop()
        actor??=identity;return true
      }
      verify()
      if (!service) throw new HttpError(403,'document_read_only')
      const body=await readJson(req,op==='create'?8*1024*1024:op?128:16*1024,{uniqueMembers:true})
      verify()
      const fields=op==='create'?['content']:op?[]:['directory','name']
      if (!exact(body,fields) || fields.some(field=>typeof body[field]!=='string')) throw new HttpError(400,'document_invalid')
      let result, status=200
      if (!op) {
        result=await service.prepare(actor,workspace,body,verify)
        prepared=result.id;status=201
      } else if (op==='create') {
        result=await service.create(actor,workspace,id,body,verify)
        status=result.replayed?200:201
      } else if (op==='status') result=await service.status(actor,workspace,id,body,verify)
      else result=await service.cancel(actor,workspace,id,body,verify)
      verify();json(res,status,result);published=true
    } catch(error) {
      const known=error instanceof HttpError && Object.hasOwn(codes,error.code) && codes[error.code]===error.status
      const code=known?error.code:error?.code==='AUTH_FAILED'?'auth':'document_unavailable'
      if (!res.destroyed && !res.headersSent) json(res,codes[code],{error:code},{connection:'close'})
    } finally {
      // Only unacknowledged *preparations* can be released here. A late create may have
      // already linked real bytes; keep the receipt until inspection, revocation or expiry.
      if (prepared && !published && auth.isLoginActive(actor)) {
        try { await service.cancel(actor,workspace,prepared,{},()=>auth.isLoginActive(actor)) } catch { /* expiry/teardown owns the same handle */ }
      }
    }
  }
  return Object.freeze({
    async handle(req,res,context) {
      const path=(req.url??'').split('?',1)[0],match=collection.exec(path)
      if (!match || match[0]!==path) return false
      if (closing || active.size>=8) { json(res,closing?503:429,{error:closing?'document_unavailable':'document_busy'},{connection:'close'});return true }
      const task=serve(req,res,context,path,match);active.add(task)
      try { await task } finally { active.delete(task) }
      return true
    },
    close() {
      if (!drain) {
        closing=true
        drain=Promise.allSettled([...active]).then(()=>service?.close())
      }
      return drain
    },
  })
}
