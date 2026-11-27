import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import test from 'node:test'

const path=fileURLToPath(new URL('./container-project-documents.mjs',import.meta.url))
function cli(...args) {return spawnSync(process.execPath,[path,...args],{env:{PATH:'/usr/bin:/bin',LANG:'C'},encoding:'utf8',timeout:5000})}

test('a manual package verification requires a full image ID; help and invalid flags never start Docker',()=>{
  const help=cli('--help')
  assert.equal(help.status,0);assert.match(help.stdout,/--disposable-image sha256:/);assert.equal(help.stderr,'')
  for (const args of [['--disposable-image'],['--disposable-image','latest'],['--disposable-image','sha256:'+'A'.repeat(64)],['--disposable-image','sha256:'+'a'.repeat(64)+'\n'],['--fixture-only','--extra']]) {
    const result=cli(...args)
    assert.equal(result.status,1);assert.equal(result.stdout,'');assert.match(result.stderr,/Usage: node scripts\/workbench\/container-project-documents\.mjs/)
  }
})
