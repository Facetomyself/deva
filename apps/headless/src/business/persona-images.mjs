import { isAbsolute, resolve } from 'node:path'
import { PERSONA_AVATAR_SLOT_DIR, personaAvatarSlotName, validPersonaAvatarId } from '../../dist/library-core.mjs'
import { record } from './settings-schema.mjs'
import { withSettingsDirectory } from './settings-file.mjs'
import { fail } from './personas-files.mjs'
import { avatarDirectoryAccess, avatarSlot, checkedAvatarUpload, verifyAvatarRoot } from './profile.mjs'

const PERSONAS_DIR = 'personas'
const AVATARS_DIR = 'avatars'

/** Work within the caller's already-locked, pinned persona directory. No queue re-entry. */
export function personaImagesIn(personaDirectory, verifyPersonaDirectory, withinDirectory = avatarDirectoryAccess()) {
  const work = (id, write, create, task) => {
    if (!validPersonaAvatarId(id)) fail('INVALID')
    const name = personaAvatarSlotName(id)
    return withinDirectory(personaDirectory, AVATARS_DIR,
      { create, verifyParent: verifyPersonaDirectory }, async (legacy, verifyLegacy) => {
        if (!legacy) return task(avatarSlot(null, name, null, id), verifyLegacy)
        const legacySlot = avatarSlot(null, name, legacy, id, true)
        const createManaged = create || (write && await legacySlot.hasReference(verifyLegacy))
        return withinDirectory(legacy, PERSONA_AVATAR_SLOT_DIR,
          { create: createManaged, privateDir: true, verifyParent: verifyLegacy },
          (managed, verify) => task(avatarSlot(managed, name, legacy, id, true), verify))
      })
  }
  const getSnapshot = id => work(id, false, false, (slot, verify) => slot.getSnapshot(verify))
  const replaceDecoded = (id, image, expectedRevision, verifyRole) =>
    work(id, true, Boolean(image), (slot, verify) => slot.update(image, async () => {
      await verify()
      await verifyRole?.()
    }, expectedRevision))
  const replace = (id, dataUri, expectedRevision, verifyRole) => {
    if (!validPersonaAvatarId(id)) fail('INVALID')
    return replaceDecoded(id, checkedAvatarUpload(dataUri), expectedRevision, verifyRole)
  }
  return {
    getSnapshot,
    replace,
    replaceDecoded,
    async get(id) { return (await getSnapshot(id)).image },
    async set(id, dataUri) { return (await replace(id, dataUri)).image },
    async clear(id) { return (await replace(id, '')).image },
    hasReference(id) { return work(id, false, false, (slot, verify) => slot.hasReference(verify)) }
  }
}

/** The host holds its volume writer lock; this adapter takes the shared inode queue. */
export async function openPersonaImages(options = {}) {
  const { dataDir } = record(options, ['dataDir'])
  if (typeof dataDir !== 'string' || !isAbsolute(dataDir) || dataDir.includes('\0') || resolve(dataDir) === '/') fail('INVALID')
  const path = resolve(dataDir)
  const withinDirectory = avatarDirectoryAccess()
  const verifyRoot = id => verifyAvatarRoot(path, id)
  const identity = await withSettingsDirectory(path, null, async (root, id) => {
    await withinDirectory(root, PERSONAS_DIR, { verifyParent: () => verifyRoot(id) }, async (directory, verifyParent) => {
      if (!directory) return
      await withinDirectory(directory, AVATARS_DIR, { verifyParent }, async (avatars, verifyAvatars) => {
        if (!avatars) return
        await withinDirectory(avatars, PERSONA_AVATAR_SLOT_DIR, { privateDir: true, verifyParent: verifyAvatars }, () => {})
      })
    })
    return id
  })
  const access = (id, create, missing, task) => {
    if (!validPersonaAvatarId(id)) fail('INVALID')
    const verifyParent = () => verifyRoot(identity)
    return withSettingsDirectory(path, identity, root => withinDirectory(root, PERSONAS_DIR,
      { create, verifyParent }, (directory, verify) => directory ? task(personaImagesIn(directory, verify, withinDirectory)) : missing))
  }
  return Object.freeze({
    async get(id) { return access(id, false, '', images => images.get(id)) },
    async set(id, dataUri) {
      if (!validPersonaAvatarId(id)) fail('INVALID')
      const image = checkedAvatarUpload(dataUri)
      return access(id, Boolean(image), '', async images => (await images.replaceDecoded(id, image)).image)
    },
    async clear(id) { return access(id, false, '', images => images.clear(id)) }
  })
}
