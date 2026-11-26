import assert from 'node:assert/strict'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { acquireWriterLock } from '../src/runtime/writer-lock.mjs'

async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'deva-writer-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('independent open descriptions exclude concurrent writers; release is idempotent', async (t) => {
  const dir = await temporary(t)
  const unlock = acquireWriterLock(dir)
  try { assert.throws(() => acquireWriterLock(dir), /Another writer/) }
  finally { unlock(); unlock() }
  acquireWriterLock(dir)()
})

test('a dead container-style process does not strand a stale lock', { timeout: 8000 }, async (t) => {
  const dir = await temporary(t)
  const module = new URL('../src/runtime/writer-lock.mjs', import.meta.url).href
  const worker = spawn(process.execPath, ['--input-type=module', '-e', `import { acquireWriterLock } from ${JSON.stringify(module)}; acquireWriterLock(process.argv[1]); console.log('locked'); setInterval(()=>{},1000)`, dir], { stdio: ['ignore', 'pipe', 'ignore'] })
  const exit = once(worker, 'exit')
  t.after(() => { if (worker.exitCode === null && !worker.signalCode) worker.kill('SIGKILL') })
  const ready = await Promise.race([once(worker.stdout, 'data'), exit.then(() => { throw Error('child exited before taking lock') })])
  assert.equal(String(ready[0]).trim(), 'locked')
  assert.throws(() => acquireWriterLock(dir), /Another writer/)
  worker.kill('SIGKILL'); await exit
  acquireWriterLock(dir)()
})

test('lock file links are not followed', async (t) => {
  const dir = await temporary(t)
  await writeFile(join(dir, 'other'), 'untouched', { mode: 0o600 })
  await symlink('other', join(dir, '.workbench-writer.lock'))
  assert.throws(() => acquireWriterLock(dir))
})
