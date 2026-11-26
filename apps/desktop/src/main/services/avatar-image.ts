import { randomBytes } from 'node:crypto'
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readSync, readdirSync, renameSync, rmSync, writeFileSync, type Stats
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  AVATAR_MAX_BYTES, AVATAR_MIME_BY_EXT, AVATAR_SLOT, PERSONA_AVATAR_SLOT_DIR,
  avatarDataUri, avatarImageMime, decodeAvatarDataUri, personaAvatarSlotName, validPersonaAvatarId, type AvatarMime
} from './avatar-image-core'

interface AvatarLocation {
  legacyDir: string
  managedDir: string
  slotName: string
  legacyStem: string
  persona?: true
}
interface Entry { path: string; mime: AvatarMime | null; stat: Stats | undefined }
const readOnly = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const info = (path: string): Stats | undefined => lstatSync(path, { throwIfNoEntry: false })
const sameInode = (a: Stats, b: Stats): boolean => a.ino === b.ino && a.dev === b.dev
const sameFile = (a: Stats | undefined, b: Stats | undefined): boolean =>
  !a || !b ? a === b : sameInode(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs

function checkDirectory(path: string): Stats | undefined {
  const stat = info(path)
  if (stat && !stat.isDirectory()) throw new Error('Invalid avatar directory')
  return stat
}

function entries(location: AvatarLocation): Entry[] {
  const { legacyDir, managedDir, slotName, legacyStem, persona } = location
  if (persona) checkDirectory(dirname(legacyDir))
  const legacy = checkDirectory(legacyDir)
  const managed = legacy && checkDirectory(managedDir)
  // Require the literal legacy spelling even on a case-insensitive Desktop volume.
  const exactNames = persona && legacy ? new Set(readdirSync(legacyDir)) : null
  const path = join(managedDir, slotName)
  return [{ path, mime: null, stat: managed ? info(path) : undefined },
    ...Object.entries(AVATAR_MIME_BY_EXT).map(([extension, mime]) => {
      const name = `${legacyStem}.${extension}`
      const path = join(legacyDir, name)
      return { path, mime, stat: legacy && (!exactNames || exactNames.has(name)) ? info(path) : undefined }
    })]
}

function fileSafe(entry: Entry): boolean {
  const { mime, stat } = entry
  return !stat || (stat.isFile() && stat.nlink === 1 && stat.size <= AVATAR_MAX_BYTES && (!mime || stat.size > 0))
}

function readAvatar(location: AvatarLocation): string {
  try {
    const targets = entries(location)
    if (!targets.every(fileSafe)) return ''
    const entry = targets.find(item => item.stat)
    if (!entry?.stat?.size) return '' // Canonical tombstone suppresses legacy fallback.
    const fd = openSync(entry.path, readOnly)
    try {
      const before = fstatSync(fd)
      if (!sameFile(before, entry.stat)) return ''
      const bytes = Buffer.alloc(before.size + 1)
      let offset = 0
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
        if (!count) break
        offset += count
      }
      if (offset !== before.size || !sameFile(before, fstatSync(fd)) || !sameFile(before, info(entry.path))) return ''
      const image = bytes.subarray(0, offset)
      const mime = avatarImageMime(image)
      return mime && (!entry.mime || mime === entry.mime) ? avatarDataUri(image, mime) : ''
    } finally { closeSync(fd) }
  } catch { return '' }
}

function ensureDirectories(location: AvatarLocation): void {
  const { legacyDir, managedDir, persona } = location
  if (persona && !checkDirectory(dirname(legacyDir))) mkdirSync(dirname(legacyDir), { mode: 0o700 })
  if (!checkDirectory(legacyDir)) mkdirSync(legacyDir, { mode: 0o700 })
  if (managedDir !== legacyDir && !checkDirectory(managedDir)) mkdirSync(managedDir, { mode: 0o700 })
}

function syncDirectory(path: string): boolean {
  try {
    const fd = openSync(path, constants.O_RDONLY)
    try { fsyncSync(fd) } finally { closeSync(fd) }
    return true
  } catch { return process.platform === 'win32' }
}

function writeAvatar(location: AvatarLocation, dataUri: string): string {
  const image = dataUri === '' ? null : decodeAvatarDataUri(dataUri)
  if (!image && dataUri !== '') return ''
  let temporary: string | undefined
  let ownTemp: Stats | undefined
  try {
    const original = entries(location)
    const [canonical, ...legacy] = original
    if (!original.every(fileSafe)) return ''
    if (!image && !canonical.stat?.size && legacy.every(entry => !entry.stat)) return ''
    ensureDirectories(location)
    const managed = checkDirectory(location.managedDir)
    if (!managed || (managed.mode & 0o300) !== 0o300 || (canonical.stat && (canonical.stat.mode & 0o200) === 0)) return ''
    const path = join(location.managedDir, `.avatar.${randomBytes(16).toString('hex')}.tmp`)
    const fd = openSync(path, 'wx', 0o600)
    temporary = path
    try {
      ownTemp = fstatSync(fd)
      fchmodSync(fd, 0o600)
      writeFileSync(fd, image?.bytes ?? Buffer.alloc(0))
      fsyncSync(fd)
      ownTemp = fstatSync(fd)
    } finally { closeSync(fd) }
    const current = entries(location)
    const directory = checkDirectory(location.managedDir)
    if (!directory || !sameInode(directory, managed) || !sameFile(ownTemp, info(path)) ||
        original.some((entry, index) => !sameFile(entry.stat, current[index].stat))) return ''
    if (canonical.stat) {
      renameSync(path, canonical.path)
      temporary = undefined
    } else {
      linkSync(path, canonical.path)
      if (removeSnapshot(path, ownTemp)) temporary = undefined
    }
    // The durable slot is authoritative even if discarding a legacy extension fails.
    if (syncDirectory(location.managedDir)) {
      for (const entry of legacy) removeSnapshot(entry.path, entry.stat, sameFile)
      if (location.legacyDir !== location.managedDir) syncDirectory(location.legacyDir)
    }
    return image ? avatarDataUri(image.bytes, image.mime) : ''
  } catch { return '' }
  finally { if (temporary) removeSnapshot(temporary, ownTemp) }
}

function removeSnapshot(path: string, before: Stats | undefined,
  compare: (a: Stats, b: Stats) => boolean = sameInode): boolean {
  try {
    if (!before) return false
    const current = info(path)
    if (current && compare(before, current)) rmSync(path)
    return true
  } catch { return false }
}

const userLocation = (dir: string): AvatarLocation => ({ legacyDir: dir, managedDir: dir, slotName: AVATAR_SLOT, legacyStem: AVATAR_SLOT })
const personaLocation = (dir: string, id: string): AvatarLocation => ({ legacyDir: dir, managedDir: join(dir, PERSONA_AVATAR_SLOT_DIR),
  slotName: personaAvatarSlotName(id), legacyStem: id, persona: true })

/** Desktop IPC retains its empty-string fallback; layout/codec match the Web adapter. */
export const readProfileAvatarImage = (dir: string): string => readAvatar(userLocation(dir))
export const writeProfileAvatarImage = (dir: string, dataUri: string): string => writeAvatar(userLocation(dir), dataUri)
export const readAvatarImage = (dir: string, id: string): string => validPersonaAvatarId(id) ? readAvatar(personaLocation(dir, id)) : ''
export const writeAvatarImage = (dir: string, id: string, dataUri: string): string =>
  validPersonaAvatarId(id) ? writeAvatar(personaLocation(dir, id), dataUri) : ''
export function clearAvatarImage(dir: string, id: string): void { writeAvatarImage(dir, id, '') }
