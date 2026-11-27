import assert from 'node:assert/strict'
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { openSettings } from '../src/business/settings.mjs'

// Checking the current model window must not open the credentials used for an actual Send.
test('read-only context model resolution uses the saved role/global model limits and never calls the vault', async t=>{
  const parent=await realpath(tmpdir()), root=await mkdtemp(join(parent,'deva-context-settings-')), info=await lstat(root,{bigint:true})
  const name=join(root,'config.json')
  t.after(async()=>{
    const now=await lstat(root,{bigint:true})
    assert.equal(await realpath(root),root);assert.equal(dirname(root),parent)
    assert.deepEqual([now.dev,now.ino,now.uid,now.mode&0o777n],[info.dev,info.ino,BigInt(process.geteuid()),0o700n]);await rm(root,{recursive:true})
  })
  const providers=[{id:'editorial',name:'Fixture',enabled:true,kind:'custom',purpose:'llm',adapter:'openai',apiHost:'https://example.invalid/v1',
    models:[{id:'notes-unknown',enabled:true},{id:'selected-64k',enabled:true},{id:'pinned',enabled:true,contextWindow:15111},{id:'off',enabled:false}]},
    {id:'disabled',enabled:false,adapter:'openai',apiHost:'https://example.invalid/v1',models:[{id:'visible',enabled:true}]},
    {id:'judge',purpose:'decision',adapter:'jev',enabled:true,apiHost:'https://example.invalid/v1',models:[{id:'private',enabled:true}]}]
  const encoded=Buffer.from(JSON.stringify({models:{activeModelId:'editorial:notes-unknown',providers},compaction:{defaultWindow:17423,triggerRatio:0.3},futureKey:'unchanged'}))
  await writeFile(name,encoded,{mode:0o600,flag:'wx'})
  let canary=false, contacted=0
  const guard=()=>{if(canary){contacted++;throw Error('Unexpected private read')}}
  const settings=await openSettings({dataDir:root,vault:{list:()=>{guard();return []},get:guard,set:guard}})
  const before=await lstat(name,{bigint:true});canary=true
  for(const [ref,model,contextWindow] of [[null,'notes-unknown',17423],['editorial:selected-64k','selected-64k',64000],['editorial:pinned','pinned',15111]]){
    const row=await settings.getContextModel(ref)
    assert.deepEqual(row,{modelRef:`editorial:${model}`,modelId:model,adapter:'openai',contextWindow})
  }
  for(const ref of ['editorial:off','editorial:missing','disabled:visible','judge:private'])assert.equal(await settings.getContextModel(ref),null)
  for(const ref of ['', 'editorial: spaced','other:abc\n']) await assert.rejects(settings.getContextModel(ref))
  assert.equal(contacted,0);assert.deepEqual(await readFile(name),encoded)
  const after=await lstat(name,{bigint:true});assert.deepEqual([after.ino,after.ctimeNs,after.mtimeNs],[before.ino,before.ctimeNs,before.mtimeNs])
})
