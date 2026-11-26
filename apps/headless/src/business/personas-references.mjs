import { promises as fs } from 'node:fs'
import { childPath } from '../storage/private-files.mjs'
import { record } from './settings-schema.mjs'
import { fail, readCheckedText, withChildDirectory } from './personas-files.mjs'
import { personaImagesIn } from './persona-images.mjs'

const maxTasks = 4 * 1024 * 1024
const maxMemory = 8 * 1024 * 1024
const own = Object.hasOwn
const matchesRole = (value, id) => typeof value === 'string' && value.toLowerCase() === id.toLowerCase()

function extensionReference(raw, id) {
  for (const key of ['skills', 'mcp']) {
    if (!own(raw, key)) continue
    const section = record(raw[key], null, true)
    if (!own(section, 'roles')) continue
    const roles = record(section.roles, null, true)
    for (const ids of Object.values(roles)) {
      if (!Array.isArray(ids) || ids.some(value => typeof value !== 'string')) fail('REFERENCED')
      if (ids.some(value => matchesRole(value, id))) return true
    }
  }
  return false
}

async function taskReference(root, id) {
  const file = await readCheckedText(root, 'tasks.json', maxTasks)
  if (!file) return false
  const index = record(JSON.parse(file.raw), null, true)
  if (index.version !== 1 || !Array.isArray(index.tasks)) fail('REFERENCED')
  for (const raw of index.tasks) {
    const task = record(raw, null, true)
    if (matchesRole(task.personaId, id)) return true // Older entries may have kept this directly on the task.
    if (!own(task, 'auth') || task.auth === null) continue
    const auth = record(task.auth, null, true)
    if (matchesRole(auth.personaId, id)) return true
    if (own(auth, 'personaId') && auth.personaId !== null && typeof auth.personaId !== 'string') fail('REFERENCED')
  }
  return false
}

async function hasCaseAlias(directory, names) {
  const exact = new Set(names)
  const folded = new Set(names.map(name => name.toLowerCase()))
  const contents = await fs.opendir(childPath(directory, '.'))
  let count = 0
  for await (const entry of contents) {
    if (++count > 512) fail('REFERENCED')
    if (!exact.has(entry.name) && folded.has(entry.name.toLowerCase())) return true
  }
  return false
}

async function attachmentReference(index, id) {
  const { directory, verifyRootAndDir } = index
  const memory = await withChildDirectory(directory, 'memory', false, async (sub, verify) => {
    if (sub && await hasCaseAlias(sub, [`${id}.json`])) return true
    const hit = sub && await readCheckedText(sub, `${id}.json`, maxMemory)
    await verify()
    if (!hit) return false
    const state = record(JSON.parse(hit.raw), null, true)
    // Only the exact empty, current authenticated role-memory shape is known to carry no data.
    return state.version !== 2 || state.personaId !== id || !Array.isArray(state.entries) || state.entries.length !== 0 ||
      Object.keys(state).some(key => !['version', 'personaId', 'entries'].includes(key))
  })
  if (memory) return true
  // The avatar owner clears real images. A zero-byte clear slot with no legacy image
  // is inert; keep it and empty memory bytes untouched under the permanently retired ID.
  const alias = await withChildDirectory(directory, 'avatars', false, async (sub, verify) => {
    const names = ['webp', 'png', 'jpg'].map(extension => `${id}.${extension}`)
    const hit = sub && await hasCaseAlias(sub, names)
    await verify()
    return hit
  })
  return alias || personaImagesIn(directory, verifyRootAndDir).hasReference(id)
}

/** The server callback must cover hosts' live/persisted session and other bindings, be
 * read-only, and avoid recursively acquiring the shared settings inode queue. */
export async function assertNoReferences(index, id, checkReferences) {
  try {
    if (!checkReferences || extensionReference(index.config.raw, id) || await taskReference(index.root, id) ||
        await attachmentReference(index, id) || await checkReferences(id) !== true) fail('REFERENCED')
  } catch {
    // Corrupt, linked, inaccessible or unavailable dependency indexes are not negative proof.
    fail('REFERENCED')
  }
}
