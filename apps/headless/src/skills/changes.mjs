import { performance } from 'node:perf_hooks'
import { HttpError } from '../http/policy.mjs'

const tag = value => typeof value === 'string' && value.length === 64 && !/[^0-9a-f]/u.test(value)
const fail = (status,code) => new HttpError(status,code)

/** One shared metadata sample per interval for all visible panels. Dormant when no one
 * is waiting: no permanent directory watcher, body cache, filesystem polling or model work. */
export function openSkillChanges({revision,auth,intervalMs=1000,readBudgetMs=4500,now=()=>performance.now()}) {
  const waiters = new Set()
  let closed=false, reading=false, queued=false, again=false, timer, sampling

  function authorized(w) {
    try { return w.actor?.role==='owner' && auth.isLoginActive(w.actor)===true && w.verify()!==false && auth.isLoginActive(w.actor)===true }
    catch { return false }
  }
  function finish(w, error, value) {
    if (!waiters.delete(w)) return
    clearTimeout(w.budget); w.signal?.removeEventListener('abort', w.cancel)
    if (!waiters.size) { clearTimeout(timer);timer=undefined }
    if (error) w.reject(error)
    else w.resolve(value)
  }
  function later() {
    clearTimeout(timer);timer=undefined
    if (closed || !waiters.size) return
    const due=Math.min(intervalMs,...[...waiters].map(w=>Math.max(0,w.end-now())))
    timer=setTimeout(wake,Math.max(1,Math.ceil(due)));timer.unref?.()
  }
  async function sample() {
    queued=false
    if (closed || !waiters.size) return
    reading=true;again=false
    const batch=[...waiters]
    try {
      for(const w of batch) if(!authorized(w)) finish(w,fail(401,'auth'))
      if (!waiters.size) return
      const value=await revision()
      if (!tag(value)) throw fail(503,'skill_unavailable')
      for(const w of batch) {
        if (!waiters.has(w)) continue
        if (!authorized(w)) finish(w,fail(401,'auth'))
        else if (value!==w.after || now()>=w.end) finish(w,null,{changed:value!==w.after,revision:value})
      }
    } catch (error) {
      // Routes further restrict the error vocabulary; never leak native filesystem/parse diagnostics.
      const safe = error instanceof HttpError ? error : fail(503,'skill_unavailable')
      for(const w of batch) if(waiters.has(w)) finish(w,authorized(w)?safe:fail(401,'auth'))
    } finally {
      reading=false
      if(again) wake(); else later()
    }
  }
  function wake() {
    if(closed || !waiters.size)return
    clearTimeout(timer);timer=undefined
    if(reading){again=true;return}
    if(!queued){
      queued=true
      queueMicrotask(()=>{ sampling=sample() })
    }
  }
  const off=auth.onSessionRevoked(sessionId=>{
    for (const w of waiters) if(w.actor.loginSessionId===sessionId) finish(w,fail(401,'auth'))
  })
  return {
    async wait(actor,body,verify,signal) {
      if (closed) throw fail(503,'skill_unavailable')
      if (!body || typeof body!=='object' || Object.keys(body).length!==2 || !Object.hasOwn(body,'after') ||
          !Object.hasOwn(body,'waitMs') || !tag(body.after) || !Number.isSafeInteger(body.waitMs) || body.waitMs<0 || body.waitMs>8000) throw fail(400,'skill_invalid')
      if (!authorized({actor,verify})) throw fail(401,'auth')
      if (signal?.aborted) throw fail(503,'skill_unavailable')
      if(waiters.size>=16 || [...waiters].filter(w=>w.actor.loginSessionId===actor.loginSessionId).length>=2) throw fail(429,'skill_busy')
      return new Promise((resolve,reject)=>{
        const w={actor,after:body.after,end:now()+body.waitMs,verify,signal,resolve,reject}
        w.cancel=()=>finish(w,fail(503,'skill_unavailable'))
        // Keep one deadline referenced while a caller is actually waiting. Otherwise
        // an embedded Node host with no other active handle can exit before it gets a reply.
        w.budget=setTimeout(w.cancel,body.waitMs+readBudgetMs)
        waiters.add(w);signal?.addEventListener('abort',w.cancel,{once:true})
        wake()
      })
    },
    wake,
    close() {
      if(!closed){
        closed=true;off();clearTimeout(timer)
        for (const w of waiters) finish(w,fail(503,'skill_unavailable'))
      }
      return sampling
    }
  }
}
