import assert from 'node:assert/strict'
import {setImmediate as tick, setTimeout as delay} from 'node:timers/promises'
import test from 'node:test'
import {openSkillChanges} from '../src/skills/changes.mjs'

const a='a'.repeat(64), b='b'.repeat(64), id={role:'owner',ownerId:'owner',loginSessionId:'A'}, other={...id,loginSessionId:'B'}
const noDeep=()=>true
function fixture(extra={}) {
  const listeners=new Set(), active=new Set(['A','B']);let tag=a,samples=0
  const watch=openSkillChanges({auth:{isLoginActive:x=>active.has(x.loginSessionId), onSessionRevoked(fn){listeners.add(fn);return()=>listeners.delete(fn)}},
    revision:async()=>{samples++;return tag},intervalMs:80,readBudgetMs:1000,...extra})
  return {watch,set(value){tag=value},get samples(){return samples},revoke(key){active.delete(key);for(const cb of listeners)cb(key)},listeners}
}

test('only an open owner poll samples metadata; concurrent views share one probe and one opaque change',async t=>{
  const f=fixture();t.after(()=>f.watch.close());assert.equal(f.samples,0)
  const p=f.watch.wait(id,{after:a,waitMs:4000},noDeep);const q=f.watch.wait(other,{after:a,waitMs:4000},noDeep)
  await tick();assert.equal(f.samples,1);f.set(b);f.watch.wake()
  assert.deepEqual(await Promise.all([p,q]),[{changed:true,revision:b},{changed:true,revision:b}]);assert.equal(f.samples,2)
  await delay(110);assert.equal(f.samples,2,'no idle core watcher or file poll after departure')
  assert.deepEqual(await f.watch.wait(id,{after:b,waitMs:0},noDeep),{changed:false,revision:b})
})

test('external metadata changes, disconnect, cap, and owner revocation are separate outcomes',async t=>{
  const f=fixture({intervalMs:22});t.after(()=>f.watch.close());const abort=new AbortController()
  const external=f.watch.wait(other,{after:a,waitMs:600},noDeep);await tick();f.set(b)
  assert.deepEqual(await external,{changed:true,revision:b})
  const p=assert.rejects(f.watch.wait(id,{after:b,waitMs:4000},noDeep,abort.signal),{code:'skill_unavailable'});
  const q=assert.rejects(f.watch.wait(id,{after:b,waitMs:4000},noDeep),{code:'auth'});
  await assert.rejects(f.watch.wait(id,{after:b,waitMs:4000},noDeep),{code:'skill_busy'});abort.abort();f.revoke('A');await Promise.all([p,q]);
  await assert.rejects(f.watch.wait(id,{after:b,waitMs:0},noDeep),{code:'auth'})
  for(const wrong of [{after:b,waitMs:8001},{after:b,waitMs:-1},{after:b,waitMs:0,path:'/invalid'},{after:b+'\n',waitMs:0}]){
    await assert.rejects(f.watch.wait(other,wrong,noDeep),{code:'skill_invalid'})
  }
  const stop=assert.rejects(f.watch.wait(other,{after:b,waitMs:4000},noDeep),{code:'skill_unavailable'});f.watch.close();await stop;assert.equal(f.listeners.size,0)
})

test('late metadata from a blocked read is never delivered to a revoked or already closed client',async()=>{
  const deferred=Promise.withResolvers(),f=fixture({revision:()=>deferred.promise})
  const revoked=assert.rejects(f.watch.wait(id,{after:a,waitMs:1000},noDeep),{code:'auth'})
  const closed=assert.rejects(f.watch.wait(other,{after:a,waitMs:1000},noDeep),{code:'skill_unavailable'})
  await tick();f.revoke('A');f.watch.close();await Promise.all([revoked,closed]);deferred.resolve(b);await tick();assert.equal(f.listeners.size,0)
})
