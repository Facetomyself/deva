import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import test from 'node:test'
import { serializePersonaMarkdown } from '../dist/library-core.mjs'
import { openPersonaImages } from '../src/business/persona-images.mjs'
import { openPersonas } from '../src/business/personas.mjs'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWNYZ/B3ncFfBggFADLGB23aTHV6AAAAAElFTkSuQmCC'
const WEBP = 'data:image/webp;base64,UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAIAAUAmJaACdLoB+AADsAD+6mX//dk/2yf7ZP/eM/+cSx1O7tAAAAA='
const bytes = uri => Buffer.from(uri.split(',')[1], 'base64')
const fault = code => ({ code })
const slot = (managed, id) => join(managed, createHash('sha256').update(id).digest('hex'))

async function fixture(t) {
  const parent = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'deva-persona-images-'))
  t.after(() => fs.rm(parent, { recursive: true, force: true }))
  const dataDir = join(parent, 'data')
  const roles = join(dataDir, 'personas')
  const avatars = join(roles, 'avatars')
  const managed = join(avatars, '.managed-v1')
  return { parent, dataDir, roles, avatars, managed }
}

async function desktopAdapter() {
  // Bundle only the image adapter and shared core, without importing Electron.
  const src = fileURLToPath(new URL('../../desktop/src/main/services/avatar-image.ts', import.meta.url))
  const result = await build({ entryPoints: [src], bundle: true, platform: 'node', format: 'esm', target: 'node22', write: false })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`)
}

await test('separates case, dotted IDs, legacy suffixes and the desktop-visible canonical slot', async t => {
  const { dataDir, avatars, managed } = await fixture(t)
  const service = await openPersonaImages({ dataDir })
  assert.equal(await service.clear('note'), '')
  await assert.rejects(fs.stat(avatars), fault('ENOENT'))
  await fs.mkdir(avatars, { recursive: true, mode: 0o700 })
  const old = join(avatars, 'note.png')
  await fs.writeFile(old, bytes(PNG))
  const desktop = await desktopAdapter()
  assert.equal(await service.get('note'), PNG)
  assert.equal(desktop.readAvatarImage(avatars, 'note'), PNG)
  assert.equal(await service.get('note.png'), '')
  assert.equal(await service.set('note.png', WEBP), WEBP)
  assert.equal(await service.set('Note', WEBP), WEBP)
  assert.deepEqual(await fs.readFile(old), bytes(PNG))
  assert.deepEqual(await fs.readFile(slot(managed, 'note.png')), bytes(WEBP))
  assert.notEqual(slot(managed, 'Note'), slot(managed, 'note'))
  assert.equal((await fs.stat(managed)).mode & 0o777, 0o700)
  assert.equal((await fs.stat(slot(managed, 'Note'))).mode & 0o777, 0o600)
  const restarted = await openPersonaImages({ dataDir })
  assert.equal(await restarted.get('note.png'), WEBP)
  assert.equal(desktop.readAvatarImage(avatars, 'note.png'), WEBP)
  assert.equal(desktop.writeAvatarImage(avatars, 'note', WEBP), WEBP)
  assert.equal(await restarted.get('note'), WEBP)
  assert.equal(await restarted.clear('note.png'), '')
  assert.equal((await fs.stat(slot(managed, 'note.png'))).size, 0)
  const restored = join(avatars, 'note.png.png')
  await fs.writeFile(restored, bytes(PNG))
  assert.equal(await restarted.get('note.png'), '')
  assert.equal(desktop.readAvatarImage(avatars, 'note.png'), '')
  desktop.clearAvatarImage(avatars, 'note.png')
  await assert.rejects(fs.stat(restored), fault('ENOENT'))
  assert.equal(await restarted.get('Note'), WEBP)
  assert.equal(await restarted.get('note'), WEBP)
})

await test('invalid input and publication failures leave legacy and canonical bytes unchanged', async t => {
  const { dataDir, avatars, managed } = await fixture(t)
  const service = await openPersonaImages({ dataDir })
  for (const id of ['../x', 't/../x', 'x\\y', 'x..y', 'x.', 'x\n', 'a'.repeat(65), 'CON.png', 'constructor', 'GENERAL', {}]) {
    await assert.rejects(service.set(id, PNG), fault('ERR_PERSONA_INVALID'))
    await assert.rejects(service.get(id), fault('ERR_PERSONA_INVALID'))
  }
  for (const uri of ['file:///tmp/test', '../../test.png', 'data:image/svg+xml;base64,PHN2Zy8+',
    'data:image/png;base64,PHNjcmlwdD4=', PNG.replace('image/png', 'image/webp'), `${WEBP}\n`, null]) {
    await assert.rejects(service.set('role', uri), fault('ERR_SETTINGS_INVALID'))
  }
  await assert.rejects(fs.stat(avatars), fault('ENOENT'))
  await fs.mkdir(avatars, { recursive: true, mode: 0o700 })
  const old = join(avatars, 'role.png')
  await fs.writeFile(old, bytes(PNG))
  const originalLink = fs.link
  fs.link = async (from, to) => {
    if (typeof from === 'string' && /\/\.avatar\.[a-f0-9]{32}\.tmp$/.test(from)) throw Object.assign(new Error('injected link I/O'), fault('EIO'))
    return originalLink(from, to)
  }
  try {
    await assert.rejects(service.set('role', WEBP), fault('ERR_SETTINGS_STORAGE'))
    await assert.rejects(service.clear('role'), fault('ERR_SETTINGS_STORAGE'))
  } finally { fs.link = originalLink }
  assert.equal(await service.get('role'), PNG)
  assert.deepEqual(await fs.readFile(old), bytes(PNG))
  assert.deepEqual(await fs.readdir(managed), [])
  await service.set('role', WEBP)
  const current = slot(managed, 'role')
  await fs.chmod(current, 0o400)
  await assert.rejects(service.set('role', PNG), fault('ERR_SETTINGS_READ_ONLY'))
  await assert.rejects(service.clear('role'), fault('ERR_SETTINGS_READ_ONLY'))
  assert.deepEqual(await fs.readFile(current), bytes(WEBP))
  assert.equal(await service.get('role'), WEBP)
})

await test('linked targets and a managed directory replaced during staging fail without touching other bytes', async t => {
  const { dataDir, parent, avatars, managed } = await fixture(t)
  const service = await openPersonaImages({ dataDir })
  await service.set('role', PNG)
  const outside = join(parent, 'outside')
  await fs.writeFile(outside, bytes(WEBP), { mode: 0o600 })
  const legacy = join(avatars, 'role.webp')
  await fs.symlink(outside, legacy)
  await assert.rejects(service.get('role'), fault('ERR_SETTINGS_CORRUPT'))
  await assert.rejects(service.clear('role'), fault('ERR_SETTINGS_CORRUPT'))
  await fs.unlink(legacy)
  await fs.link(outside, legacy)
  await assert.rejects(service.set('role', WEBP), fault('ERR_SETTINGS_CORRUPT'))
  await fs.unlink(legacy)
  const symlinkSlot = slot(managed, 'other')
  await fs.symlink(outside, symlinkSlot)
  await assert.rejects(service.get('other'), fault('ERR_SETTINGS_CORRUPT'))
  await fs.unlink(symlinkSlot)
  await fs.link(outside, symlinkSlot)
  await assert.rejects(service.set('other', WEBP), fault('ERR_SETTINGS_CORRUPT'))
  await fs.unlink(symlinkSlot)
  const originalOpen = fs.open
  const displaced = join(parent, 'displaced')
  let replaced = false
  fs.open = async (path, ...args) => {
    const handle = await originalOpen(path, ...args)
    if (!replaced && typeof path === 'string' && /\/\.avatar\.[a-f0-9]{32}\.tmp$/.test(path)) {
      try {
        await fs.rename(managed, displaced)
        await fs.mkdir(managed, { mode: 0o700 })
        replaced = true
      } catch (error) { await handle.close(); throw error }
    }
    return handle
  }
  try { await assert.rejects(service.set('role', WEBP), fault('ERR_SETTINGS_CONFLICT')) }
  finally { fs.open = originalOpen }
  assert.equal(replaced, true)
  assert.deepEqual(await fs.readFile(slot(displaced, 'role')), bytes(PNG))
  assert.deepEqual(await fs.readdir(managed), [])
  assert.deepEqual(await fs.readFile(outside), bytes(WEBP))
  await assert.rejects(service.get('role'), fault('ERR_SETTINGS_CONFLICT'))
  await fs.rmdir(managed)
  await fs.symlink(displaced, managed)
  await assert.rejects(openPersonaImages({ dataDir }), fault('ERR_SETTINGS_STORAGE'))
})

await test('role edits require both revisions in the same queue and image references protect removal', async t => {
  const { dataDir, roles, avatars, managed } = await fixture(t)
  await fs.mkdir(avatars, { recursive: true, mode: 0o700 })
  const md = serializePersonaMarkdown({ name: 'Exact role', avatar: '{"shape":"cloud"}', prompt: 'Stored prose, not a tool call.' })
  const roleFile = join(roles, 'writer.md')
  await fs.writeFile(roleFile, md)
  await fs.writeFile(join(roles, 'writer.png.md'), serializePersonaMarkdown({ name: 'Dotted ID' }))
  const legacy = join(avatars, 'writer.png')
  await fs.writeFile(legacy, bytes(PNG))
  const one = await openPersonas({ dataDir, checkReferences: async () => true })
  const two = await openPersonas({ dataDir, checkReferences: async () => true })
  const initial = await one.getAvatarImage('writer')
  assert.equal(initial.image, PNG)
  assert.equal(initial.revision, (await one.get('writer')).revision)
  assert.match(initial.imageRevision, /^[a-f0-9]{64}$/)
  const dotted = await one.get('writer.png')
  assert.deepEqual(await one.remove('writer.png', dotted.revision), { ok: true })
  assert.deepEqual(await fs.readFile(legacy), bytes(PNG))
  await assert.rejects(one.setAvatarImage('writer', WEBP, initial.revision), fault('ERR_PERSONA_REVISION_REQUIRED'))
  await assert.rejects(one.setAvatarImage('ghost', WEBP, initial.revision, initial.imageRevision), fault('ERR_PERSONA_NOT_FOUND'))
  const edited = await one.upsert({ id: 'writer', name: 'New display name', revision: initial.revision })
  await assert.rejects(one.setAvatarImage('writer', WEBP, initial.revision, initial.imageRevision), fault('ERR_PERSONA_CONFLICT'))
  const before = await fs.readFile(roleFile)
  const race = await Promise.allSettled([
    one.setAvatarImage('writer', WEBP, edited.revision, initial.imageRevision),
    two.setAvatarImage('writer', PNG, edited.revision, initial.imageRevision)
  ])
  const accepted = race.find(result => result.status === 'fulfilled')?.value
  assert.ok(accepted)
  assert.equal(race.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(race.find(result => result.status === 'rejected').reason.code, 'ERR_SETTINGS_CONFLICT')
  assert.notEqual(accepted.imageRevision, initial.imageRevision)
  assert.deepEqual(await one.getAvatarImage('writer'), accepted)
  assert.deepEqual(await fs.readFile(roleFile), before)
  assert.equal((await one.get('writer')).avatar, '{"shape":"cloud"}')
  await assert.rejects(one.remove('writer', edited.revision), fault('ERR_PERSONA_REFERENCED'))
  const cleared = await two.setAvatarImage('writer', '', edited.revision, accepted.imageRevision)
  assert.equal(cleared.image, '')
  assert.notEqual(cleared.imageRevision, accepted.imageRevision)
  assert.equal((await fs.stat(slot(managed, 'writer'))).size, 0)
  assert.deepEqual(await one.getAvatarImage('writer'), cleared)
  assert.deepEqual(await one.remove('writer', edited.revision), { ok: true })
  assert.equal((await fs.stat(slot(managed, 'writer'))).size, 0)
})
