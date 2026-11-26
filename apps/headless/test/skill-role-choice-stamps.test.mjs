import assert from 'node:assert/strict'
import {lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync, chmodSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {basename,dirname,join} from 'node:path'
import test from 'node:test'
import {skillRoleChoiceVerifier} from '../src/business/skill-role-choice-stamps.mjs'

const info=path=>lstatSync(path,{bigint:true})
const conflict=fn=>assert.throws(fn, {code:'skill_conflict',status:409})
test('native role choice proof ignores unrelated config publications but fails on changed or swapped role binding',t=>{
  const temp=realpathSync.native(tmpdir()), root=mkdtempSync(join(temp,'deva-skill-role-')), original=info(root)
  t.after(()=>{
    const current=info(root)
    assert.equal(dirname(root),temp);assert.match(basename(root),/^deva-skill-role-[A-Za-z0-9]{6}$/)
    assert.equal(realpathSync.native(root),root);assert.deepEqual([current.dev,current.ino,current.uid],[original.dev,original.ino,BigInt(process.geteuid())]);
    rmSync(root,{recursive:true})
  })
  const roster=join(root,'personas'), file=join(roster,'editor.md')
  mkdirSync(roster,{mode:0o700});writeFileSync(file,'# Original editorial role',{mode:0o600,flag:'wx'})
  const proof=()=>skillRoleChoiceVerifier(root,info(root),info(roster),[{id:'editor',info:info(file)}])
  const first=proof();assert.equal(first(),true)
  writeFileSync(join(root,'config.json'),'{}',{flag:'wx',mode:0o600});assert.equal(first(),true)
  const next=join(roster,'new-editor');writeFileSync(next,'# Same role name, different binding',{mode:0o600,flag:'wx'});
  assert.equal(realpathSync.native(file),file);assert.equal(dirname(next),roster);renameSync(next,file);conflict(first)
  const second=proof();chmodSync(file,0o400);conflict(second)
  const third=proof();const retired=join(root,'old-roles');assert.equal(realpathSync.native(roster),roster);assert.equal(dirname(retired),root)
  renameSync(roster,retired);mkdirSync(roster,{mode:0o700});writeFileSync(file,'# Replacement',{flag:'wx',mode:0o600});conflict(third)
})
