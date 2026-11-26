import { Buffer } from 'node:buffer'
import { createHash, randomBytes } from 'node:crypto'
import { constants, promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { AVATAR_MAX_BYTES, AVATAR_MIME_BY_EXT, AVATAR_SLOT, avatarDataUri,
  avatarImageMime, decodeAvatarDataUri, projectUserProfile, validAvatarSpec } from '../../dist/library-core.mjs'
import { assertRevision, record, SettingsError } from './settings-schema.mjs'
import { assertWritable, encodeSettings, publishSettingsFile, readSettingsFile, revisionFor, withSettingsDirectory } from './settings-file.mjs'
import { childPath, openDirectory } from '../storage/private-files.mjs'

const PROFILE_DIR = 'profile'
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
const sameInode = (a, b) => a.dev === b.dev && a.ino === b.ino
const sameSnapshot = (a, b) => sameInode(a, b) && a.ctimeNs === b.ctimeNs && a.mtimeNs === b.mtimeNs && a.size === b.size
const optional = async task => {
  try { return await task() } catch (error) { if (error?.code === 'ENOENT') return null; throw error }
}
const invalid = () => new SettingsError('INVALID')
const conflict = () => new SettingsError('CONFLICT')
const corrupt = () => new SettingsError('CORRUPT')
const readOnly = () => new SettingsError('READ_ONLY')

export async function verifyAvatarRoot(path, identity) {
  const opened = await openDirectory(path, { owned: true })
  try { if (opened.identity !== identity) throw conflict() }
  finally { await opened.directory.close().catch(() => {}) }
}

/** The host holds its existing per-volume writer lock before opening this service. */
export async function openProfile(options = {}) {
  const { dataDir = process.env.DEVA_HOME?.trim() || join(homedir(), '.deva') } = record(options, ['dataDir'])
  if (typeof dataDir !== 'string' || !dataDir || dataDir.includes('\0')) throw invalid()
  const path = resolve(dataDir)
  const withinDirectory = avatarDirectoryAccess()
  const verifyRoot = identity => verifyAvatarRoot(path, identity)
  const withImageDirectory = (root, identity, create, task) =>
    withinDirectory(root, PROFILE_DIR, { create, verifyParent: () => verifyRoot(identity) }, task)
  const slot = directory => avatarSlot(directory, AVATAR_SLOT, directory, AVATAR_SLOT)
  let configSeen = false

  async function loadConfig(directory) {
    const { raw, info } = await readSettingsFile(directory)
    if (!info && configSeen) throw corrupt()
    configSeen ||= Boolean(info)
    const profile = Object.hasOwn(raw, 'profile') ? record(raw.profile, null, true) : {}
    // Desktop's IPC has always treated an absent/empty/non-string value as default.
    // For Web reads only release safe Humation strings, without migrating on get().
    const saved = profile.avatar
    const avatar = validAvatarSpec(saved) ? saved : ''
    return { raw, info, profile, avatar }
  }

  const identity = await withSettingsDirectory(path, null, async (directory, id) => {
    await loadConfig(directory)
    await withImageDirectory(directory, id, false, (imageDir, verify) => slot(imageDir).hasReference(verify))
    return id
  })
  const access = task => withSettingsDirectory(path, identity, async directory => {
    await verifyRoot(identity)
    return task(directory)
  })
  const getSnapshot = () => access(async directory => {
    const { avatar, info } = await loadConfig(directory)
    const image = await withImageDirectory(directory, identity, false, (imageDir, verify) => slot(imageDir).get(verify))
    const current = await optional(() => fs.lstat(childPath(directory, 'config.json'), { bigint: true }))
    if (Boolean(info) !== Boolean(current) || (info && !sameSnapshot(info, current))) throw conflict()
    await verifyRoot(identity)
    return { profile: projectUserProfile(avatar, image), revision: revisionFor(identity, info) }
  })
  return Object.freeze({
    async get() { return (await getSnapshot()).profile },
    getSnapshot,
    async setAvatar(spec, expectedRevision) {
      if (!validAvatarSpec(spec)) throw invalid()
      if (expectedRevision !== undefined) assertRevision(expectedRevision)
      return access(async directory => {
        const { raw, info, profile } = await loadConfig(directory)
        const revision = revisionFor(identity, info)
        if (expectedRevision !== undefined && expectedRevision !== revision) throw conflict()
        if (Object.hasOwn(profile, 'avatar') && profile.avatar === spec) return { ok: true, revision }
        const bytes = encodeSettings({ ...raw, profile: { ...profile, avatar: spec } })
        try {
          // The common publisher asks for directory.stat() in its pre-rename
          // assertion, after staging and syncing. Revalidate the named root there;
          // the actual I/O still uses only the already pinned directory descriptor.
          const guarded = {
            fd: directory.fd,
            sync: () => directory.sync(),
            async stat(options) {
              await verifyRoot(identity)
              return directory.stat(options)
            }
          }
          await assertWritable(guarded, info)
          const committed = await publishSettingsFile(guarded, bytes, info)
          configSeen = true
          return { ok: true, revision: revisionFor(identity, committed.info) }
        } finally { bytes.fill(0) }
      })
    },
    async setAvatarImage(dataUri) {
      const image = checkedAvatarUpload(dataUri)
      return access(async directory => {
        await loadConfig(directory)
        return withImageDirectory(directory, identity, Boolean(image), async (imageDir, verify) =>
          (await slot(imageDir).update(image, verify)).image)
      })
    }
  })
}

/** Keep each observed child inode for the lifetime of the service, and pin it for each operation. */
export function avatarDirectoryAccess() {
  const seen = new Map()
  return async function withDirectory(parent, name, { create = false, privateDir = false, verifyParent }, task) {
    const path = childPath(parent, name)
    const previous = seen.get(name)
    let directory = await optional(() => fs.open(path, DIRECTORY_FLAGS))
    if (!directory && previous) throw conflict()
    if (!directory && create) {
      await verifyParent()
      if (((await parent.stat({ bigint: true })).mode & 0o300n) !== 0o300n) throw readOnly()
      try { await fs.mkdir(path, { mode: 0o700 }) }
      catch (error) { if (error?.code === 'EEXIST') throw conflict(); throw error }
      await parent.sync()
      directory = await fs.open(path, DIRECTORY_FLAGS)
    }
    try {
      const pinned = directory ? await directory.stat({ bigint: true }) : null
      if (pinned) {
        assertAvatarDirectory(pinned, privateDir)
        if (previous && !sameInode(pinned, previous)) throw conflict()
      }
      const verify = async () => {
        await verifyParent()
        const current = await optional(() => fs.lstat(path, { bigint: true }))
        if (current) assertAvatarDirectory(current, privateDir)
        if (Boolean(current) !== Boolean(pinned) || (current && !sameInode(current, pinned))) throw conflict()
      }
      await verify()
      if (pinned) seen.set(name, pinned)
      return await task(directory, verify)
    } finally { await directory?.close().catch(() => {}) }
  }
}

export function checkedAvatarUpload(dataUri) {
  if (dataUri === '') return null
  const image = decodeAvatarDataUri(dataUri)
  if (!image) throw invalid()
  return image
}

/** Canonical data and legacy inputs can live in separately pinned directories. Names are server-derived. */
export function avatarSlot(directory, name, legacyDirectory, legacyStem, exactLegacy = false) {
  const current = { directory, name, mime: null }
  const legacy = Object.entries(AVATAR_MIME_BY_EXT).map(([ext, mime]) => ({
    directory: legacyDirectory, name: `${legacyStem}.${ext}`, mime, exactLegacy
  }))
  const entries = [current, ...legacy]
  // Scope the fingerprint to the public image and its generation. The inode
  // advances on equal-byte replacement; ctime changes during link publication.
  const revision = (selected, info, image) => createHash('sha256').update(JSON.stringify([name, selected?.name ?? null,
    info ? [info.dev, info.ino, info.mtimeNs, info.size].map(String) : null])).update(image).digest('hex')
  const getSnapshot = async verify => {
    const states = await imageSnapshot(entries)
    const selected = entries.find(entry => states.get(entry))
    const info = states.get(selected)
    const image = selected ? await readImage(selected, info) : ''
    await checkImages(entries, states)
    await verify()
    return { image, imageRevision: revision(selected, info, image) }
  }
  return {
    async get(verify) { return (await getSnapshot(verify)).image },
    getSnapshot,
    async hasReference(verify) {
      const states = await imageSnapshot(entries)
      await checkImages(entries, states)
      await verify()
      return Boolean(states.get(current)?.size || legacy.some(entry => states.get(entry)))
    },
    async update(image, verify, expectedRevision) {
      const states = await imageSnapshot(entries)
      const old = states.get(current)
      const hasLegacy = legacy.some(entry => states.get(entry))
      const selected = entries.find(entry => states.get(entry))
      if (expectedRevision !== undefined) {
        const before = selected ? await readImage(selected, states.get(selected)) : ''
        if (expectedRevision !== revision(selected, states.get(selected), before)) throw conflict()
      }
      if (!image && (!old || old.size === 0n) && !hasLegacy) {
        await checkImages(entries, states)
        await verify()
        return { image: '', imageRevision: revision(selected, states.get(selected), '') }
      }
      if (!directory) throw conflict()
      const staged = await publishImage(current, legacy, image?.bytes ?? Buffer.alloc(0), states, verify)
      const uri = image ? avatarDataUri(image.bytes, image.mime) : ''
      return { image: uri, imageRevision: revision(current, staged, uri) }
    }
  }
}

function assertAvatarDirectory(info, privateDir) {
  if (!info.isDirectory() || info.uid !== BigInt(process.geteuid()) || (info.mode & (privateDir ? 0o7077n : 0o7022n)) !== 0n) throw corrupt()
}

function assertImageFile({ mime }, info) {
  const forbiddenMode = mime ? 0o7133n : 0o7177n
  if (!info.isFile() || info.nlink !== 1n || info.uid !== BigInt(process.geteuid()) || (info.mode & forbiddenMode) !== 0n ||
      info.size > BigInt(AVATAR_MAX_BYTES) || (info.size === 0n && mime)) throw corrupt()
}

async function imageSnapshot(entries) {
  const states = new Map()
  const requireExact = []
  for (const entry of entries) {
    const state = entry.directory ? await optional(() => fs.lstat(childPath(entry.directory, entry.name), { bigint: true })) : null
    if (state && entry.exactLegacy) requireExact.push(entry)
    states.set(entry, state)
  }
  // In a case-folded directory lstat alone can report a different role's old file.
  // The bounded scan is only needed for candidates that actually exist.
  if (requireExact.length) {
    const unmatched = new Map(requireExact.map(entry => [entry.name, entry]))
    const dir = await fs.opendir(childPath(requireExact[0].directory, '.'))
    let scanned = 0
    for await (const item of dir) {
      if (++scanned > 512) throw corrupt()
      unmatched.delete(item.name)
      if (!unmatched.size) break
    }
    for (const entry of unmatched.values()) states.set(entry, null)
  }
  for (const [entry, state] of states) if (state) assertImageFile(entry, state)
  return states
}

async function checkImages(entries, previous) {
  for (const [entry, current] of await imageSnapshot(entries)) {
    const before = previous.get(entry)
    if (Boolean(before) !== Boolean(current) || (before && !sameSnapshot(before, current))) throw conflict()
  }
}

async function readImage(entry, expected) {
  const file = await fs.open(childPath(entry.directory, entry.name), READ_FLAGS)
  try {
    const info = await file.stat({ bigint: true })
    assertImageFile(entry, info)
    if (!sameSnapshot(info, expected)) throw conflict()
    const bytes = Buffer.alloc(Number(info.size) + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset !== Number(info.size) || !sameSnapshot(info, await file.stat({ bigint: true }))) throw conflict()
    if (!offset) return '' // The canonical clear marker; a legacy file cannot be empty.
    const image = bytes.subarray(0, offset)
    const mime = avatarImageMime(image)
    if (!mime || (entry.mime && mime !== entry.mime)) throw corrupt()
    return avatarDataUri(image, mime)
  } finally { await file.close().catch(() => {}) }
}

// Bytes only ever go to an exclusively created 0600 sibling of the target. A
// pre-existing final pathname (or a temp-name collision) is never opened writable.
async function publishImage(canonical, legacy, bytes, states, verify) {
  const { directory, name } = canonical
  const target = childPath(directory, name)
  const tmp = childPath(directory, `.avatar.${randomBytes(16).toString('hex')}.tmp`)
  const parent = await directory.stat({ bigint: true })
  const old = states.get(canonical)
  if ((parent.mode & 0o300n) !== 0o300n || (old && (old.mode & 0o200n) === 0n)) throw readOnly()
  const file = await fs.open(tmp, WRITE_FLAGS, 0o600)
  let owned, staged
  try {
    owned = await file.stat({ bigint: true })
    await file.chmod(0o600)
    await file.writeFile(bytes)
    await file.sync()
    staged = await file.stat({ bigint: true })
    await directory.sync()
    await checkImages([canonical, ...legacy], states)
    await verify()
    const current = await fs.lstat(tmp, { bigint: true })
    assertImageFile(canonical, current)
    if (!sameSnapshot(staged, current)) throw conflict()
    if (old) await fs.rename(tmp, target)
    else {
      try { await fs.link(tmp, target) }
      catch (error) { if (error?.code === 'EEXIST') throw conflict(); throw error }
    }
  } finally {
    await file.close().catch(() => {})
    await unlinkSnapshot(tmp, owned, sameInode)
  }
  // The slot is the visible commit. Retire the old extension(s) only after the
  // new slot is durable. Cleanup is best effort, and cannot roll back the commit.
  if (await directory.sync().then(() => true, () => false)) {
    const retired = new Set()
    for (const entry of legacy) {
      const previous = states.get(entry)
      if (!previous) continue
      await unlinkSnapshot(childPath(entry.directory, entry.name), previous, sameSnapshot)
      retired.add(entry.directory)
    }
    for (const dir of retired) await dir.sync().catch(() => {})
  }
  return staged
}

async function unlinkSnapshot(path, info, compare) {
  if (!info) return
  try {
    if (compare(info, await fs.lstat(path, { bigint: true }))) await fs.unlink(path)
  } catch { /* A vanished or inaccessible path needs no pre-commit recovery. */ }
}
