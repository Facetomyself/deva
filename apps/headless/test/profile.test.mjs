import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEFAULT_USER_AVATAR } from '../dist/library-core.mjs'
import { openProfile } from '../src/business/profile.mjs'
import { openSettings } from '../src/business/settings.mjs'

const INVALID = { code: 'ERR_SETTINGS_INVALID' }
const CORRUPT = { code: 'ERR_SETTINGS_CORRUPT' }
const STORAGE = { code: 'ERR_SETTINGS_STORAGE' }
const CONFLICT = { code: 'ERR_SETTINGS_CONFLICT' }
const READ_ONLY = { code: 'ERR_SETTINGS_READ_ONLY' }
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWNYZ/B3ncFfBggFADLGB23aTHV6AAAAAElFTkSuQmCC'
const JPEG = 'data:image/jpeg;base64,/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCMArpq/9k='
const WEBP = 'data:image/webp;base64,UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAIAAUAmJaACdLoB+AADsAD+6mX//dk/2yf7ZP/eM/+cSx1O7tAAAAA='
const WEBP_ALPHA = 'data:image/webp;base64,UklGRlwAAABXRUJQVlA4WAoAAAAQAAAAAQAAAQAAQUxQSAUAAAAAf39/fwBWUDggMAAAANABAJ0BKgIAAgABQCYloAJ0ugH4AAOwAP7qZf/92T/bJ/tk/94z/5xLHU7u0AAAAA=='
const SPEC = '{"selections":{"head":"head-curly-short","glasses":"glasses-none"},"colors":{"skin":"#fedcba"},"background":"transparent","shape":"cloud"}'
const NEW_SPEC = '{"shape":"auto"}'
const bytes = uri => Buffer.from(uri.split(',')[1], 'base64')
const dataUri = (mime, buffer) => `data:${mime};base64,${buffer.toString('base64')}`

async function fixture(t, existing = false) {
  const parent = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'deva-profile-'))
  t.after(() => fs.rm(parent, { recursive: true, force: true }))
  const dataDir = join(parent, 'data')
  const imageDir = join(dataDir, 'profile')
  if (existing) await fs.mkdir(imageDir, { mode: 0o700, recursive: true })
  return { parent, dataDir, imageDir, config: join(dataDir, 'config.json'), slot: join(imageDir, 'avatar') }
}

const json = async path => JSON.parse(await fs.readFile(path, 'utf8'))

test('fresh reads project desktop defaults without a config or image write', async t => {
  const { dataDir, config, imageDir } = await fixture(t)
  const service = await openProfile({ dataDir })
  const settings = await openSettings({ dataDir })
  assert.equal(JSON.parse(DEFAULT_USER_AVATAR).selections.head, 'hm1-p-000004')
  const profile = { avatar: DEFAULT_USER_AVATAR, avatarImage: '' }
  assert.deepEqual(await service.get(), profile)
  const { revision } = await settings.getPublicConfig()
  assert.deepEqual(await service.getSnapshot(), { profile, revision })
  assert.equal(await service.setAvatarImage(''), '')
  await assert.rejects(fs.stat(config), { code: 'ENOENT' })
  await assert.rejects(fs.stat(imageDir), { code: 'ENOENT' })
  assert.equal((await fs.stat(dataDir)).mode & 0o777, 0o700)
  const changed = await service.setAvatar(SPEC, revision)
  assert.deepEqual(await json(config), { profile: { avatar: SPEC } })
  assert.equal((await fs.stat(config)).mode & 0o777, 0o600)
  assert.notEqual(changed.revision, revision)
  assert.deepEqual(await service.setAvatar(SPEC, changed.revision), changed)
  assert.equal((await (await openProfile({ dataDir })).get()).avatar, SPEC)
  await service.setAvatar('')
  assert.equal((await service.get()).avatar, DEFAULT_USER_AVATAR)
})

test('reads legacy desktop spec and extension order; new format and clear are atomic single slots', async t => {
  const { dataDir, config, imageDir, slot } = await fixture(t, true)
  const original = { theme: 'dark', profile: { avatar: SPEC, unknownSibling: { n: 3 } }, irrelevant: ['keep'] }
  await fs.writeFile(config, JSON.stringify(original), { mode: 0o644 })
  await fs.writeFile(join(imageDir, 'avatar.png'), bytes(PNG), { mode: 0o644 })
  await fs.writeFile(join(imageDir, 'avatar.webp'), bytes(WEBP), { mode: 0o644 })
  const service = await openProfile({ dataDir })
  assert.deepEqual(await service.get(), { avatar: SPEC, avatarImage: WEBP })
  assert.deepEqual((await fs.readdir(imageDir)).sort(), ['avatar.png', 'avatar.webp'])
  assert.equal(await service.setAvatarImage(JPEG.replace('image/jpeg', 'image/jpg')), JPEG)
  assert.equal((await fs.stat(slot)).mode & 0o777, 0o600)
  assert.deepEqual(await fs.readFile(slot), bytes(JPEG))
  assert.deepEqual(await fs.readdir(imageDir), ['avatar'])
  assert.deepEqual(await json(config), original)
  for (const uri of [WEBP_ALPHA, PNG, WEBP]) {
    assert.equal(await service.setAvatarImage(uri), uri)
    assert.equal((await (await openProfile({ dataDir })).get()).avatarImage, uri)
    assert.deepEqual(await fs.readFile(slot), bytes(uri))
  }
  assert.equal(await service.setAvatarImage(''), '')
  assert.equal((await fs.stat(slot)).size, 0)
  // An old copy restored after clear still cannot become active again.
  const old = join(imageDir, 'avatar.jpg')
  await fs.writeFile(old, bytes(JPEG), { mode: 0o644 })
  assert.equal((await (await openProfile({ dataDir })).get()).avatarImage, '')
  await service.setAvatarImage('')
  await assert.rejects(fs.stat(old), { code: 'ENOENT' })
  assert.ok(!(await fs.readFile(config, 'utf8')).includes('base64'))
})

test('rejects noncanonical base64, unsupported MIME, forged/oversized rasters and unsafe Humation input without changing disk', async t => {
  const { dataDir, config, slot } = await fixture(t)
  const service = await openProfile({ dataDir })
  const committed = await service.setAvatar(SPEC)
  await service.setAvatarImage(PNG)
  const invalidSpecs = [null, {}, '[]', 'false', '  ', 'x'.repeat(4097), '{"selections":[]}',
    '{"selections":{"head":"../foo"}}', '{"colors":{"hair":"url(https://example.test)"}}',
    '{"background":"javascript:void(0)"}', '{"shape":"foreign"}', '{"__proto__":{"x":true}}']
  for (const spec of invalidSpecs) await assert.rejects(service.setAvatar(spec), INVALID)
  const oversizedDimensions = bytes(PNG)
  oversizedDimensions.writeUInt32BE(4097, 16)
  const badRiff = bytes(WEBP)
  badRiff.writeUInt32LE(11, 4)
  const invalidImages = [null, {}, '/etc/passwd', 'file:///foo.png', 'https://example.test/avatar.png',
    'data:image/svg+xml;base64,PHN2Zy8+', 'data:image/png;base64,PHNjcmlwdD4=',
    PNG.replace('image/png', 'image/gif'), PNG.replace('image/png', 'image/webp'), PNG.replace(',', ';x=y,'),
    `${PNG}\n`, ` ${PNG}`, PNG.replace(',', ', '), PNG.replace(',', ',-'), `${PNG}=`,
    JPEG.slice(0, -1), JPEG.replace('/9k=', '/9l='), WEBP.slice(0, -4),
    dataUri('image/png', oversizedDimensions), dataUri('image/webp', badRiff),
    dataUri('image/png', Buffer.concat([bytes(PNG), Buffer.from('extra')])),
    dataUri('image/png', Buffer.alloc(2 * 1024 * 1024 + 1))]
  for (const uri of invalidImages) await assert.rejects(service.setAvatarImage(uri), INVALID)
  assert.deepEqual(await fs.readFile(slot), bytes(PNG))
  assert.deepEqual(await json(config), { profile: { avatar: SPEC } })
  assert.deepEqual(await service.getSnapshot(), { profile: { avatar: SPEC, avatarImage: PNG }, revision: committed.revision })
})

test('configuration and profile writers serialize by directory inode and share a revision', async t => {
  const { dataDir, config } = await fixture(t, true)
  const unknown = { extension: ['opaque'], profile: { label: 'keep' }, theme: 'light', locale: 'en' }
  await fs.writeFile(config, JSON.stringify(unknown))
  const [first, second, settings] = await Promise.all([
    openProfile({ dataDir }), openProfile({ dataDir: join(dataDir, '.') }), openSettings({ dataDir })
  ])
  const initial = (await first.getSnapshot()).revision
  const save = await first.setAvatar(SPEC, initial)
  await assert.rejects(settings.patch({ set: { theme: 'dark' }, revision: initial }), CONFLICT)
  const next = await settings.patch({ set: { theme: 'dark' }, revision: save.revision })
  await assert.rejects(second.setAvatar(NEW_SPEC, save.revision), CONFLICT)
  assert.equal((await second.getSnapshot()).revision, next.revision)
  for (let i = 0; i < 16; i++) {
    const spec = i % 2 ? SPEC : NEW_SPEC
    const theme = i % 2 ? 'light' : 'dark'
    await Promise.all([first.setAvatar(spec), settings.patch({ set: { theme } })])
    const onDisk = await json(config)
    assert.deepEqual(onDisk, { ...unknown, theme, profile: { ...unknown.profile, avatar: spec } })
    assert.equal((await first.getSnapshot()).revision, (await settings.getPublicConfig()).revision)
  }
  const outcomes = await Promise.allSettled([first.setAvatar(NEW_SPEC, (await first.getSnapshot()).revision), second.setAvatar(SPEC)])
  assert.ok(outcomes.some(result => result.status === 'fulfilled'))
  await Promise.all([first.setAvatarImage(WEBP), second.setAvatarImage(PNG)])
  assert.ok([WEBP, PNG].includes((await first.get()).avatarImage))
})

test('an image publication failure preserves old legacy or canonical image, even for a clear', async t => {
  const { dataDir, imageDir, slot } = await fixture(t, true)
  const path = join(imageDir, 'avatar.png')
  await fs.writeFile(path, bytes(PNG))
  const service = await openProfile({ dataDir })
  await fs.chmod(imageDir, 0o500)
  try {
    await assert.rejects(service.setAvatarImage(JPEG), READ_ONLY)
    await assert.rejects(service.setAvatarImage(''), READ_ONLY)
    assert.equal((await service.get()).avatarImage, PNG)
    assert.deepEqual(await fs.readdir(imageDir), ['avatar.png'])
  } finally { await fs.chmod(imageDir, 0o700) }
  await service.setAvatarImage(JPEG)
  await fs.chmod(slot, 0o400)
  await assert.rejects(service.setAvatarImage(WEBP), READ_ONLY)
  await assert.rejects(service.setAvatarImage(''), READ_ONLY)
  assert.equal((await service.get()).avatarImage, JPEG)
  assert.deepEqual(await fs.readdir(imageDir), ['avatar'])
})

test('rejects substituted data/profile directories and unsafe symlink, hardlink, directory and FIFO image targets', async t => {
  const { parent, dataDir, imageDir, config, slot } = await fixture(t, true)
  const outside = join(parent, 'outside.png')
  const legacy = join(imageDir, 'avatar.png')
  await fs.writeFile(outside, bytes(PNG), { mode: 0o600 })
  await fs.symlink(outside, legacy)
  await assert.rejects(openProfile({ dataDir }), CORRUPT)
  await fs.unlink(legacy)
  const service = await openProfile({ dataDir })
  await service.setAvatarImage(JPEG)
  await fs.link(outside, legacy)
  await assert.rejects(service.setAvatarImage(WEBP), CORRUPT)
  await assert.rejects(service.setAvatarImage(''), CORRUPT)
  await fs.unlink(legacy)
  await fs.mkdir(legacy)
  await assert.rejects(service.get(), CORRUPT)
  await fs.rmdir(legacy)
  execFileSync('mkfifo', [legacy])
  await assert.rejects(service.get(), CORRUPT)
  await fs.unlink(legacy)
  assert.deepEqual(await fs.readFile(slot), bytes(JPEG))
  assert.deepEqual(await fs.readFile(outside), bytes(PNG))
  await fs.symlink(outside, config)
  await assert.rejects(service.setAvatar(SPEC), CORRUPT)
  await assert.rejects(service.setAvatarImage(WEBP), CORRUPT)
  await fs.unlink(config)
  const symlinkRoot = join(parent, 'alias')
  await fs.symlink(dataDir, symlinkRoot)
  await assert.rejects(openProfile({ dataDir: symlinkRoot }), STORAGE)
  const displacedImageDir = join(parent, 'displaced-profile')
  await fs.rename(imageDir, displacedImageDir)
  await fs.symlink(displacedImageDir, imageDir)
  await assert.rejects(service.get(), STORAGE)
  await assert.rejects(service.setAvatarImage(WEBP), STORAGE)
  await fs.unlink(imageDir)
  await fs.mkdir(imageDir, { mode: 0o700 })
  await assert.rejects(service.get(), CONFLICT)
  await assert.rejects(service.setAvatarImage(WEBP), CONFLICT)
  assert.deepEqual(await fs.readFile(join(displacedImageDir, 'avatar')), bytes(JPEG))
  assert.deepEqual(await fs.readdir(imageDir), [])
  const displacedRoot = join(parent, 'displaced-data')
  await fs.rename(dataDir, displacedRoot)
  await fs.mkdir(dataDir, { mode: 0o700 })
  await assert.rejects(service.setAvatar(SPEC), STORAGE)
  assert.deepEqual(await fs.readdir(dataDir), [])
})

test('a directory replaced while an image is staged aborts before publication', async t => {
  const { parent, dataDir, imageDir, slot } = await fixture(t, true)
  const service = await openProfile({ dataDir })
  await service.setAvatarImage(PNG)
  const displaced = join(parent, 'staged-original')
  const original = fs.open
  let replaced = false
  fs.open = async (path, ...args) => {
    const handle = await original(path, ...args)
    if (!replaced && typeof path === 'string' && /\/\.avatar\.[a-f0-9]{32}\.tmp$/.test(path)) {
      try {
        await fs.rename(imageDir, displaced)
        await fs.mkdir(imageDir, { mode: 0o700 })
        replaced = true
      } catch (error) {
        await handle.close()
        throw error
      }
    }
    return handle
  }
  try { await assert.rejects(service.setAvatarImage(JPEG), CONFLICT) }
  finally { fs.open = original }
  assert.equal(replaced, true)
  await assert.rejects(fs.stat(slot), { code: 'ENOENT' })
  assert.deepEqual(await fs.readdir(displaced), ['avatar'])
  assert.deepEqual(await fs.readFile(join(displaced, 'avatar')), bytes(PNG))
})

test('a data root replaced while the profile config is staged aborts before publication', async t => {
  const { parent, dataDir, config } = await fixture(t)
  const service = await openProfile({ dataDir })
  await service.setAvatar(SPEC)
  const displaced = join(parent, 'staged-data')
  const original = fs.open
  let replaced = false
  fs.open = async (path, ...args) => {
    const handle = await original(path, ...args)
    if (!replaced && typeof path === 'string' && /\/\.config\.[a-f0-9]{32}\.tmp$/.test(path)) {
      try {
        await fs.rename(dataDir, displaced)
        await fs.mkdir(dataDir, { mode: 0o700 })
        replaced = true
      } catch (error) {
        await handle.close()
        throw error
      }
    }
    return handle
  }
  try { await assert.rejects(service.setAvatar(NEW_SPEC), CONFLICT) }
  finally { fs.open = original }
  assert.equal(replaced, true)
  await assert.rejects(fs.stat(config), { code: 'ENOENT' })
  assert.deepEqual(await fs.readdir(displaced), ['config.json'])
  assert.deepEqual(await json(join(displaced, 'config.json')), { profile: { avatar: SPEC } })
})

test('keeps unsafe or corrupt disk bytes out of profile results', async t => {
  const { dataDir, imageDir, config } = await fixture(t, true)
  await fs.writeFile(config, JSON.stringify({ profile: { avatar: '{"background":"url(file:///private)"}' } }))
  const legacy = join(imageDir, 'avatar.jpg')
  await fs.writeFile(legacy, bytes(PNG))
  const service = await openProfile({ dataDir })
  await assert.rejects(service.get(), CORRUPT)
  await fs.writeFile(legacy, bytes(JPEG))
  assert.deepEqual(await service.get(), { avatar: DEFAULT_USER_AVATAR, avatarImage: JPEG })
  await fs.chmod(legacy, 0o666)
  await assert.rejects(service.get(), CORRUPT)
  await fs.chmod(legacy, 0o644)
  await fs.chmod(imageDir, 0o777)
  await assert.rejects(service.get(), CORRUPT)
  await fs.chmod(imageDir, 0o700)
  await fs.writeFile(config, '{broken')
  await assert.rejects(service.setAvatar(SPEC), CORRUPT)
  assert.equal(await fs.readFile(config, 'utf8'), '{broken')
})
