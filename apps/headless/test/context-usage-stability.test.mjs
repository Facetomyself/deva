import assert from 'node:assert/strict'
import test from 'node:test'
import {createConversationUsage} from '../src/chat/conversation-usage.mjs'

const model={modelRef:'local:fixture',modelId:'fixture',adapter:'openai',contextWindow:12000}
const initial={session:{id:'a',createdAt:1,model:model.modelRef,messages:[{role:'user',content:'first'}]},layout:{owned:false,eligible:true}}
const revised={session:{...initial.session,messages:[{role:'user',content:'new content '.repeat(400)}]},layout:initial.layout}
function endpoint(refresh) {
  let configReads=0
  const usage=createConversationUsage({read:()=>initial,refresh,active:()=>undefined,
    settings:{async getContextModel(){configReads++;return model}}})
  return {query:()=>usage('a',{model:null},()=>true),reads:()=>configReads}
}

test('after expensive estimation a new durable file stamp forces a fresh local projection, never another upstream request',async()=>{
  let disk=initial,checks=0
  const api=endpoint((_sid,prior)=>{
    if (++checks===2) disk=revised // The named file changed during the first projection.
    return prior===disk?prior:disk
  })
  const result=await api.query()
  assert.equal(result.source,'estimate');assert.ok(result.usage.used>1000)
  assert.equal(api.reads(),1);assert.equal(checks,4)
})

test('a continuously changing protected session fails boundedly rather than returning a stale estimate',async()=>{
  let checks=0
  const api=endpoint((_sid,old)=>{checks++;return {...old}})
  await assert.rejects(api.query(),{status:409,code:'read_unavailable'});assert.equal(api.reads(),1);assert.equal(checks,4)
})
