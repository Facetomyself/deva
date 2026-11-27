import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { openWorkspaceCatalog } from '../src/business/workspace-catalog.mjs'
import { openProjectDocumentService } from '../src/files/project-document-service.mjs'
import { openProjectDocumentTarget } from '../src/files/project-document-target.mjs'
import { HttpError } from '../src/http/policy.mjs'

const A = Object.freeze({ role: 'owner', ownerId: 'owner', loginSessionId: 'login-A' })
const B = Object.freeze({ ...A, loginSessionId: 'login-B' })
const ok = () => true
const fault = (status, code) => e => e instanceof HttpError && e.status === status && e.code === code

test('real publication reads back exact bytes; login revocation at visibility keeps file but returns zero receipts', { skip: process.platform !== 'linux' }, async t => {
  const base = await realpath(tmpdir()), root = await mkdtemp(join(base, 'deva-project-document-service-'))
  const { dev, ino } = await lstat(root)
  const folder = join(root, 'Project', 'Notes')
  const installed = join(folder, 'english.txt'), revoked = join(folder, 'during.md')
  let catalog, service
  t.after(async () => {
    try { service?.close(); catalog?.close() }
    finally {
      assert.equal(dirname(root), base)
      assert.equal(await realpath(root), root)
      const current = await lstat(root)
      assert.deepEqual([current.dev, current.ino], [dev, ino])
      await rm(root, { recursive: true })
    }
  })
  await mkdir(folder, { recursive: true, mode: 0o700 })
  catalog = openWorkspaceCatalog({ root })
  const wid = catalog.list()[0].id
  const active = new Set([A.loginSessionId, B.loginSessionId])
  let listener, nativeCloses = 0, nativePublishes = 0
  const revoke = actor => { active.delete(actor.loginSessionId); listener(actor.loginSessionId) }
  service = openProjectDocumentService({
    auth: { isLoginActive: actor => active.has(actor.loginSessionId), onSessionRevoked(fn) { listener = fn; return () => { listener = undefined } } },
    openTarget(workspace, body) {
      const target = openProjectDocumentTarget(catalog, workspace, body)
      return { ...target,
        publish(...args) { nativePublishes++; return target.publish(...args) },
        close() { nativeCloses++; return target.close() },
      }
    },
  })
  assert.throws(() => service.prepare(A, wid, { directory: 'Notes', name: 'AGENTS.md' }, ok), fault(422, 'document_restricted'))
  const live = service.prepare(A, wid, { directory: 'Notes', name: 'english.txt' }, ok)
  const blocked = '{"private_key":"PRIVATE_LITERAL"}'
  assert.throws(() => service.create(A, wid, live.id, { content: blocked }, ok), fault(422, 'document_restricted'))
  const bytes = '\uFEFF真实 UTF-8\r\nsecond line\r\n'
  const receipt = service.create(A, wid, live.id, { content: bytes }, ok)
  assert.match(receipt.revision, /^r_[a-f0-9]{64}$/u)
  assert.equal(receipt.replayed, false)
  const before = await lstat(installed, { bigint: true })
  assert.deepEqual(await readFile(installed), Buffer.from(bytes))
  assert.deepEqual(service.create(A, wid, live.id, { content: bytes }, ok), { ...receipt, replayed: true })
  const after = await lstat(installed, { bigint: true })
  assert.deepEqual([after.ino, after.ctimeNs], [before.ino, before.ctimeNs])
  assert.equal(nativePublishes, 2, 'the rejected restricted text and the successful publish each reached native validation')

  const abandoned = service.prepare(A, wid, { directory: 'Notes', name: 'during.md' }, ok)
  assert.throws(() => service.create(A, wid, abandoned.id, { content: bytes }, () => {
    if (existsSync(revoked)) revoke(A)
    return true
  }), fault(401, 'auth'))
  assert.deepEqual(await readFile(revoked), Buffer.from(bytes))
  assert.deepEqual((await readdir(folder)).sort(), ['during.md', 'english.txt'])
  assert.equal(nativeCloses, 2, 'all held pins for the revoked identity were released')
  assert.throws(() => service.status(B, wid, live.id, {}, ok), fault(404, 'document_intent_missing'))
  assert.throws(() => service.status(B, wid, abandoned.id, {}, ok), fault(404, 'document_intent_missing'))
  assert.throws(() => service.prepare(B, wid, { directory: 'Notes', name: 'during.md' }, ok), fault(409, 'document_exists'))
  assert.equal(nativeCloses, 3, 'rejected prepared target closes too')
})
