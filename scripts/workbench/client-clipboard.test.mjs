import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'

const require=createRequire(new URL('../../apps/desktop/package.json',import.meta.url))
const ts=require('typescript')
const script=await readFile(new URL('../../apps/desktop/src/workbench/client-clipboard.ts',import.meta.url),'utf8')
const js=ts.transpileModule(script,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
const mod={exports:{}};new Function('module','exports',js)(mod,mod.exports)
const {writeClientText, pasteClientText}=mod.exports
const page=writeText=>({isSecureContext:true,document:{hasFocus:()=>true},navigator:{userActivation:{isActive:true},clipboard:{writeText}}})
const failure=issue=>error=>error.issue===issue && error.message==='client_clipboard_'+issue
function paste({text='text',types=['text/plain'],trusted=true,already=false,readable=true}={}) {
  const seen=[];let prevented=0
  const event={isTrusted:trusted,defaultPrevented:already,preventDefault(){this.defaultPrevented=true;prevented++},clipboardData:{types,
    getData(type){seen.push(type);assert.equal(type,'text/plain');if(!readable)throw Error('private native detail');return text}}}
  return {event,seen,prevented:()=>prevented}
}

test('writes exact client text synchronously on the click and waits for a native acknowledgment',async()=>{
  const text=' \t陆地\r\nCafé ☕\n ', calls=[], pending=Promise.withResolvers()
  const target=page(function(value){assert.equal(this,target.navigator.clipboard);calls.push(value);return pending.promise})
  Object.defineProperty(target.navigator.clipboard,'readText',{get(){assert.fail('a Copy must never read clipboard')}})
  let done=false;const receipt=writeClientText(text,target).then(()=>{done=true})
  assert.deepEqual(calls,[text]);await Promise.resolve();assert.equal(done,false);pending.resolve();await receipt;assert.equal(done,true)
})

test('missing capability, insecure context, background focus or permission denial never fake a copy',async()=>{
  const spy=()=>assert.fail('should not attempt a native write')
  await assert.rejects(writeClientText('x',{...page(spy),isSecureContext:false}),failure('unsupported'))
  await assert.rejects(writeClientText('x',{...page(spy),navigator:{}}),failure('unsupported'))
  await assert.rejects(writeClientText('x',{...page(spy),document:{hasFocus:()=>false}}),failure('denied'))
  const inactive=page(spy);inactive.navigator.userActivation.isActive=false;await assert.rejects(writeClientText('x',inactive),failure('denied'))
  const denied=Object.assign(Error('native message should not escape'),{name:'NotAllowedError'})
  await assert.rejects(writeClientText('x',page(()=>Promise.reject(denied))),failure('denied'))
  const bad=page(spy);Object.defineProperty(bad.navigator,'clipboard',{get(){throw Object.assign(Error(),{name:'SecurityError'})}})
  await assert.rejects(writeClientText('x',bad),failure('denied'))
  await assert.rejects(writeClientText('x',page(()=>undefined)),failure('unconfirmed'))
  await assert.rejects(writeClientText('界'.repeat(90_000),page(spy)),failure('too-large'))
})

test('a native Paste inserts only text/plain at the live selection and never requests HTML or URL data',()=>{
  const original='  海边\r\n<script>literal</script>\tCafé\r尾\n', p=paste({text:original,types:['text/html','text/uri-list','text/plain']})
  const inserted=[], statuses=[]
  assert.equal(pasteClientText(p.event, text=>{inserted.push(text);return true}, s=>statuses.push(s)),true)
  assert.equal(p.prevented(),1);assert.deepEqual(p.seen,['text/plain']);assert.deepEqual(inserted,[original.replace(/\r\n?/g,'\n')]);assert.deepEqual(statuses,['pasted'])
})

test('synthetic, previously consumed, file-bearing or HTML-only paste cannot insert hidden text',()=>{
  const insert=()=>assert.fail('unexpected plaintext insertion')
  for(const [args,expectedStatus,prevented] of [[{trusted:false},[],1],[{already:true},[],0],[{types:['Files','text/plain']},['not-text'],1],
    [{types:['text/html']},['not-text'],1],[{types:['text/uri-list']},['not-text'],1]]){
    const p=paste(args), statuses=[];assert.equal(pasteClientText(p.event,insert,s=>statuses.push(s)),true)
    assert.deepEqual(p.seen,[]);assert.deepEqual(statuses,expectedStatus);assert.equal(p.prevented(),prevented)
  }
})

test('oversize, unavailable or lost-selection paste has explicit feedback and no partial insertion',()=>{
  for(const [opt,label] of [[{text:'界'.repeat(90_000)},'too-large'],[{readable:false},'unavailable'],[{text:''},'not-text']]){
    const p=paste(opt), states=[];pasteClientText(p.event,()=>assert.fail('must preserve draft'),s=>states.push(s));assert.deepEqual(states,[label])
  }
  const p=paste(), states=[];pasteClientText(p.event,()=>false,s=>states.push(s));assert.deepEqual(states,['unavailable'])
})
