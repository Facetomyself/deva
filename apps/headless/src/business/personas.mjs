import { Buffer } from 'node:buffer'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { parsePersonaMarkdown, serializePersonaMarkdown, validAvatarSpec, validPersonaAvatarId } from '../../dist/library-core.mjs'
import { childPath, openDirectory } from '../storage/private-files.mjs'
import { assertWritable as assertSettingsWritable, encodeSettings, publishSettingsFile, readSettingsFile, withSettingsDirectory } from './settings-file.mjs'
import { record } from './settings-schema.mjs'
import { assertWritable, fail, publishCheckedFile, readCheckedText, removeCheckedFile, sameInode, sameSnapshot, statKey,
  verifyFile, withChildDirectory } from './personas-files.mjs'
import { assertNoReferences } from './personas-references.mjs'
import { personaImagesIn } from './persona-images.mjs'
import { avatarDirectoryAccess, checkedAvatarUpload } from './profile.mjs'

export { PersonaError } from './personas-files.mjs'
export const DEFAULT_PERSONA_ID = 'general'
export const MAX_PERSONA_FILES = 128
export const MAX_PERSONA_FILE_BYTES = 128 * 1024
const MAX_DIRECTORY_ENTRIES = 512
const retiredKey = 'headlessRetiredIds'
const nameFor = id => `${id}.md`
const own = Object.hasOwn
const rawRevision = /^[a-f0-9]{64}$/u
const catalogId = /^w_[a-f0-9]{32}$/u
const reserved = new Set(['constructor', 'prototype', '__proto__'])
const control = /[\u0000-\u001f\u007f\u2028\u2029]/u
const promptControl = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|\r(?!\n)/u
const matches = (pattern, value) => typeof value === 'string' && pattern.exec(value)?.[0] === value
const canonicalRoleId = validPersonaAvatarId
const requireId = id => { if (!canonicalRoleId(id)) fail('INVALID'); return id }
const hash = (...value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const defaultMarkdown = serializePersonaMarkdown({
  name: 'General', description: 'General-purpose assistant',
  prompt: 'Help the user with everyday questions and tasks. Be clear and practical.'
})

function validatedRevision(value, required = false) {
  if (value === undefined && required) fail('REVISION_REQUIRED')
  if (value !== undefined && !matches(rawRevision, value)) fail('INVALID')
  return value
}

function checkRevision(actual, expected) {
  if (expected !== undefined && actual !== expected) fail('CONFLICT')
}

function text(value, max, multiline = false) {
  if (typeof value !== 'string' || value.length > max || Buffer.byteLength(value) > max || !value.isWellFormed() ||
      (multiline ? promptControl : control).test(value)) fail('INVALID')
  return value.trim()
}

function upsertInput(input) {
  const raw = record(input, ['id', 'name', 'description', 'avatar', 'model', 'workspaceId', 'prompt', 'enabled', 'revision'])
  const fields = Object.create(null)
  const id = own(raw, 'id') ? requireId(raw.id) : undefined
  if (!id && (own(raw, 'revision') || !own(raw, 'name'))) fail('INVALID')
  const revision = own(raw, 'revision') ? validatedRevision(raw.revision, true) : validatedRevision(undefined, Boolean(id))
  for (const [field, max] of [['name', 256], ['description', 2048], ['avatar', 4096], ['model', 1024], ['prompt', 64 * 1024]]) {
    if (own(raw, field)) fields[field] = text(raw[field], max, field === 'prompt')
  }
  if (own(fields, 'name') && !fields.name) fail('INVALID')
  if (own(fields, 'avatar') && !validAvatarSpec(fields.avatar)) fail('INVALID')
  if (fields.model) {
    const colon = fields.model.indexOf(':')
    const provider = fields.model.slice(0, colon)
    const model = fields.model.slice(colon + 1)
    if (colon < 1 || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/u.test(provider) || reserved.has(provider) ||
        !model || model.trim() !== model) fail('INVALID')
  }
  if (own(raw, 'workspaceId') && raw.workspaceId !== null && raw.workspaceId !== '' && !matches(catalogId, raw.workspaceId)) fail('INVALID')
  if (own(raw, 'enabled') && typeof raw.enabled !== 'boolean') fail('INVALID')
  return { fields, id, revision, enabled: own(raw, 'enabled') ? raw.enabled : undefined,
    workspaceId: own(raw, 'workspaceId') ? (raw.workspaceId ?? '') : undefined }
}

function checkArray(value, max, kind) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max ||
      Reflect.ownKeys(value).length !== value.length + 1) fail(kind)
  for (let i = 0; i < value.length; i++) {
    const prop = Object.getOwnPropertyDescriptor(value, `${i}`)
    if (!prop?.enumerable || !own(prop, 'value')) fail(kind)
  }
}

function loadConfig(raw, info) {
  const personas = own(raw, 'personas') ? record(raw.personas, null, true) : {}
  const enabled = own(personas, 'enabled') ? record(personas.enabled, null, true) : {}
  if (Object.values(enabled).some(value => typeof value !== 'boolean')) fail('CORRUPT')
  const order = own(personas, 'order') ? personas.order : []
  checkArray(order, 32768, 'CORRUPT')
  if (order.some(value => typeof value !== 'string' || !value || value.length > 256 || control.test(value) || reserved.has(value))) fail('CORRUPT')
  const retired = own(personas, retiredKey) ? record(personas[retiredKey], null, true) : {}
  if (Object.entries(retired).some(([id, value]) => !canonicalRoleId(id) || id === DEFAULT_PERSONA_ID || value !== true)) fail('CORRUPT')
  const retiredFold = new Set(Object.keys(retired).map(id => id.toLowerCase()))
  return { raw, info, personas, enabled, order, retired, retiredFold }
}

async function idsIn(directory) {
  const handle = await fs.opendir(childPath(directory, '.'))
  const ids = []
  const seen = new Set()
  let files = 0
  let entries = 0
  for await (const entry of handle) {
    if (++entries > MAX_DIRECTORY_ENTRIES) fail('LIMIT')
    if (!entry.name.toLowerCase().endsWith('.md')) continue
    if (++files > MAX_PERSONA_FILES) fail('LIMIT')
    const id = entry.name.slice(0, -3)
    const folded = id.toLowerCase()
    if (folded === DEFAULT_PERSONA_ID && entry.name !== 'general.md') fail('CORRUPT')
    if (!canonicalRoleId(id)) continue
    if (seen.has(folded)) fail('CORRUPT')
    seen.add(folded)
    if (entry.name.endsWith('.md')) ids.push(id)
  }
  return { ids, files, occupied: seen }
}

async function readRole(directory, id) {
  const file = await readCheckedText(directory, nameFor(id), MAX_PERSONA_FILE_BYTES)
  if (!file) return null
  let parsed
  try { parsed = parsePersonaMarkdown(id, file.raw, { strict: true }) }
  catch { fail('CORRUPT') }
  return { id, ...file, parsed }
}

function newRoleId(name, index) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 31).replace(/-+$/g, '') || 'persona'
  const { enabled, order, retiredFold, personas } = index.config
  const unavailable = new Set([...index.occupied, ...retiredFold, ...[...Object.keys(enabled), ...order].map(id => id.toLowerCase())])
  for (const field of ['seeded', 'seededPrompt']) {
    if (own(personas, field) && personas[field] && typeof personas[field] === 'object') {
      for (const id of Object.keys(personas[field])) unavailable.add(id.toLowerCase())
    }
  }
  for (let tries = 0; tries < 8; tries++) {
    const id = `${base}-${randomBytes(16).toString('hex')}`
    if (!unavailable.has(id)) return id
  }
  fail('CONFLICT')
}

function canonicalRoot(root) {
  return typeof root === 'string' && root.length <= 4096 && isAbsolute(root) && resolve(root) === root &&
    root !== '/' && !control.test(root)
}

function isWorkspaceName(name) {
  return typeof name === 'string' && name && name !== '.' && name !== '..' &&
    Buffer.byteLength(name) <= 255 && !/[/\\]/u.test(name) && !control.test(name)
}

function scopedCatalog(catalog) {
  // Each roster read resolves at most once per ID, even if many legacy roles share roots.
  // A separate cache per operation avoids preserving a revoked directory approval.
  const roots = new Map()
  let entries
  return {
    entries: () => entries ??= Promise.resolve().then(async () => (await catalog.list()).filter(item =>
      matches(catalogId, item?.id) && isWorkspaceName(item.name))),
    root(id) {
      if (!roots.has(id)) roots.set(id, Promise.resolve().then(() => catalog.resolveRoot(id)))
      return roots.get(id)
    }
  }
}

async function approvedWorkspace(workspaceCatalog, id, scope = scopedCatalog(workspaceCatalog)) {
  if (!workspaceCatalog || !matches(catalogId, id)) return null
  const item = (await scope.entries()).find(value => value.id === id)
  if (!item) return null
  const root = await scope.root(id)
  return canonicalRoot(root) ? { id, name: item.name, root } : null
}

async function workspaceForProjection(workspaceCatalog, parsed, scope) {
  if (!workspaceCatalog || !canonicalRoot(parsed.workspace)) return null
  try {
    if (parsed.workspaceId) {
      const approved = await approvedWorkspace(workspaceCatalog, parsed.workspaceId, scope)
      return approved?.root === parsed.workspace ? approved : null
    }
    // Desktop/legacy roles only name a path. Compare exact values with roots independently
    // resolved from the allowlist; a disk-supplied path is never submitted to a resolver.
    for (const { id, name } of await scope.entries()) {
      if (await scope.root(id) === parsed.workspace) return { id, name }
    }
  } catch { /* A vanished catalog or workspace never grants scope. */ }
  return null
}

function roleRevision(binding, config) {
  return hash('persona', binding.id, statKey(binding.info), own(config.enabled, binding.id) ? config.enabled[binding.id] : null)
}

async function publicRole(workspaceCatalog, binding, config, scope = scopedCatalog(workspaceCatalog)) {
  const { id, parsed: { name, description, avatar, model, prompt } } = binding
  const workspace = await workspaceForProjection(workspaceCatalog, binding.parsed, scope)
  return { id, name, description, avatar: validAvatarSpec(avatar) ? avatar : '', model, prompt,
    workspaceId: workspace?.id ?? '', workspaceName: workspace?.name ?? '', enabled: config.enabled[id] === true,
    protected: id === DEFAULT_PERSONA_ID, revision: roleRevision(binding, config) }
}

const rosterRevision = (order, stored) => hash('persona-roster', order, stored)

async function publicRoster(workspaceCatalog, index) {
  const ranks = new Map(index.config.order.map((id, rank) => [id, rank]))
  const rank = id => ranks.get(id) ?? Number.MAX_SAFE_INTEGER
  const roles = []
  const scope = scopedCatalog(workspaceCatalog)
  for (const id of index.ids) {
    const binding = await readRole(index.directory, id)
    if (!binding) fail('CONFLICT')
    roles.push(await publicRole(workspaceCatalog, binding, index.config, scope))
  }
  await index.verifyUnchanged()
  roles.sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  const order = roles.map(role => role.id)
  return { roles, order, revision: rosterRevision(order, index.config.order) }
}

async function withRole(index, id, expected, task) {
  const binding = index.ids.includes(id) ? await readRole(index.directory, id) : null
  if (!binding) fail('NOT_FOUND')
  checkRevision(roleRevision(binding, index.config), expected)
  return task(binding)
}

/** Solo server-owned roster. All reads/writes share the settings file directory inode queue. */
export async function openPersonas(options) {
  const { dataDir, workspaceCatalog, checkReferences } = record(options, ['dataDir', 'workspaceCatalog', 'checkReferences'])
  if (typeof dataDir !== 'string' || !isAbsolute(dataDir) || dataDir.includes('\0') ||
      (workspaceCatalog != null && (typeof workspaceCatalog.list !== 'function' || typeof workspaceCatalog.resolveRoot !== 'function')) ||
      (checkReferences !== undefined && typeof checkReferences !== 'function')) fail('INVALID')
  const path = resolve(dataDir)
  if (path === '/') fail('INVALID')
  const avatarDirectories = avatarDirectoryAccess()
  let configSeen = false
  let personaDirectory
  async function readConfig(root) {
    const { raw, info } = await readSettingsFile(root)
    if (!info && configSeen) fail('CORRUPT')
    configSeen ||= Boolean(info)
    return loadConfig(raw, info)
  }
  async function verifyRoot(expected) {
    const opened = await openDirectory(path, { owned: true })
    try { if (opened.identity !== expected) fail('CONFLICT') }
    finally { await opened.directory.close().catch(() => {}) }
  }
  const identity = await withSettingsDirectory(path, null, async (root, current) => {
    const config = await readConfig(root)
    await withChildDirectory(root, 'personas', true, async (directory, verify, info) => {
      const { files } = await idsIn(directory)
      const general = await readRole(directory, DEFAULT_PERSONA_ID)
      if (!general) {
        if (files >= MAX_PERSONA_FILES) fail('LIMIT')
        const verifyDirs = async () => { await verifyRoot(current); await verify() }
        const seedEnabled = !own(config.enabled, DEFAULT_PERSONA_ID)
        const seededConfig = own(config.personas, 'seeded') ? record(config.personas.seeded, null, true) : {}
        // Record the ordinary role as already seeded in the desktop's format too;
        // opening a copied volume in desktop should preserve existing general edits.
        const next = seedEnabled ? enabledChange(config, DEFAULT_PERSONA_ID, true) : config.raw
        const bytes = seedEnabled || seededConfig.general !== true ? encodeSettings({ ...next, personas: {
          ...next.personas, seeded: { ...seededConfig, [DEFAULT_PERSONA_ID]: true }
        } }) : null
        try {
          if (bytes) await assertSettingsWritable(root, config.info)
          const seeded = await publishCheckedFile(directory, nameFor(DEFAULT_PERSONA_ID), defaultMarkdown, null, MAX_PERSONA_FILE_BYTES, async () => {
            await verifyDirs()
            if (!sameSnapshot((await readConfig(root)).info, config.info)) fail('CONFLICT')
            if ((await idsIn(directory)).files >= MAX_PERSONA_FILES) fail('LIMIT')
          })
          if (bytes) {
            try {
              await verifyDirs()
              await publishSettingsFile(root, bytes, config.info)
              configSeen = true
            } catch (error) {
              await removeCheckedFile(directory, nameFor(DEFAULT_PERSONA_ID), seeded, MAX_PERSONA_FILE_BYTES, verifyDirs)
              throw error
            }
          }
        } finally { bytes?.fill(0) }
      }
      personaDirectory = info
    })
    return current
  })
  function access(task) {
    return withSettingsDirectory(path, identity, async root => {
      await verifyRoot(identity)
      const config = await readConfig(root)
      return withChildDirectory(root, 'personas', false, async (directory, verify, info) => {
        if (!info || !sameInode(personaDirectory, info)) fail('CONFLICT')
        const { ids: entries, files, occupied } = await idsIn(directory)
        if (!entries.includes(DEFAULT_PERSONA_ID)) fail('CONFLICT')
        const ids = entries.filter(id => !config.retiredFold.has(id.toLowerCase()))
        const verifyRootAndDir = async () => { await verifyRoot(identity); await verify() }
        return task({ root, directory, ids, files, occupied, config, verifyRootAndDir, async verifyUnchanged({ newId } = {}) {
          await verifyRootAndDir()
          if (!sameSnapshot((await readConfig(root)).info, config.info)) fail('CONFLICT')
          if (newId) {
            const current = await idsIn(directory)
            if (current.files >= MAX_PERSONA_FILES) fail('LIMIT')
            if (current.occupied.has(newId.toLowerCase())) fail('CONFLICT')
          }
        } })
      })
    })
  }
  async function commitConfig(index, bytes) {
    await index.verifyRootAndDir()
    const committed = await publishSettingsFile(index.root, bytes, index.config.info)
    configSeen = true
    return committed
  }
  function enabledChange(config, id, enabled) {
    return { ...config.raw, personas: { ...config.personas, enabled: { ...config.enabled, [id]: enabled } } }
  }
  async function writeEnabled(index, binding, enabled) {
    const id = binding.id
    if (enabled === undefined || index.config.enabled[id] === enabled) return index.config
    const raw = enabledChange(index.config, id, enabled)
    const bytes = encodeSettings(raw)
    try {
      await verifyFile(index.directory, nameFor(id), binding.info, MAX_PERSONA_FILE_BYTES)
      const { info } = await commitConfig(index, bytes)
      return loadConfig(raw, info)
    } finally { bytes.fill(0) }
  }
  async function upsert(index, request, existing) {
    const id = request.id ?? newRoleId(request.fields.name, index)
    if (!existing && index.files >= MAX_PERSONA_FILES) fail('LIMIT')
    if (request.workspaceId !== undefined) {
      let approved
      if (request.workspaceId) {
        try { approved = await approvedWorkspace(workspaceCatalog, request.workspaceId) } catch { fail('INVALID') }
        if (!approved) fail('INVALID')
      }
      request.fields.workspace = approved?.root ?? ''
      request.fields.workspaceId = approved?.id ?? ''
    }
    const md = serializePersonaMarkdown(request.fields, existing?.parsed)
    const changed = !existing || md !== existing.raw
    let binding = existing
    if (changed) {
      const willSetEnabled = request.enabled !== undefined && index.config.enabled[id] !== request.enabled
      if (willSetEnabled) {
        // Validate the second file before committing the first; both are guarded under the same queue.
        const bytes = encodeSettings(enabledChange(index.config, id, request.enabled))
        bytes.fill(0)
        await assertSettingsWritable(index.root, index.config.info)
      }
      const verify = async () => {
        await index.verifyUnchanged({ newId: existing ? undefined : id })
        if (request.fields.workspaceId) {
          let confirmed
          try { confirmed = await approvedWorkspace(workspaceCatalog, request.fields.workspaceId) } catch { fail('CONFLICT') }
          if (confirmed?.root !== request.fields.workspace) fail('CONFLICT')
        }
      }
      let parsed
      try { parsed = parsePersonaMarkdown(id, md, { strict: true }) } catch { fail('INVALID') }
      const info = await publishCheckedFile(index.directory, nameFor(id), md, existing?.info ?? null, MAX_PERSONA_FILE_BYTES, verify)
      binding = { id, raw: md, parsed, info }
    }
    let config
    try { config = await writeEnabled(index, binding, request.enabled) }
    catch (error) {
      if (changed) {
        // Best effort, only if the inode we just published is still ours. Never roll back over a newer edit.
        if (existing) await publishCheckedFile(index.directory, nameFor(id), existing.raw, binding.info,
          MAX_PERSONA_FILE_BYTES, index.verifyRootAndDir)
        else await removeCheckedFile(index.directory, nameFor(id), binding.info, MAX_PERSONA_FILE_BYTES, index.verifyRootAndDir)
      }
      throw error
    }
    return publicRole(workspaceCatalog, binding, config)
  }
  const imagesIn = index => personaImagesIn(index.directory, index.verifyRootAndDir, avatarDirectories)
  async function verifyRoleImageBinding(index, binding) {
    await index.verifyUnchanged()
    await verifyFile(index.directory, nameFor(binding.id), binding.info, MAX_PERSONA_FILE_BYTES)
  }
  return Object.freeze({
    list: () => access(index => publicRoster(workspaceCatalog, index)),
    async getAvatarImage(id) {
      requireId(id)
      return access(index => withRole(index, id, undefined, async binding => {
        const result = await imagesIn(index).getSnapshot(id)
        await verifyRoleImageBinding(index, binding)
        return { ...result, revision: roleRevision(binding, index.config) }
      }))
    },
    async setAvatarImage(id, dataUri, expectedRoleRevision, expectedImageRevision) {
      requireId(id)
      const expectedRole = validatedRevision(expectedRoleRevision, true)
      const expectedImage = validatedRevision(expectedImageRevision, true)
      const image = checkedAvatarUpload(dataUri)
      return access(index => withRole(index, id, expectedRole, async binding => {
        const result = await imagesIn(index).replaceDecoded(id, image, expectedImage, () => verifyRoleImageBinding(index, binding))
        return { ...result, revision: roleRevision(binding, index.config) }
      }))
    },
    async get(id) {
      requireId(id)
      return access(async index => {
        if (!index.ids.includes(id)) return null
        const binding = await readRole(index.directory, id)
        if (!binding) fail('CONFLICT')
        const result = await publicRole(workspaceCatalog, binding, index.config)
        await index.verifyUnchanged()
        await verifyFile(index.directory, nameFor(id), binding.info, MAX_PERSONA_FILE_BYTES)
        return result
      })
    },
    async upsert(input) {
      const request = upsertInput(input)
      return access(index => request.id ? withRole(index, request.id, request.revision, role => upsert(index, request, role))
        : upsert(index, request, null))
    },
    async setEnabled(id, enabled, revision) {
      requireId(id)
      const expected = validatedRevision(revision, true)
      if (typeof enabled !== 'boolean') fail('INVALID')
      return access(index => withRole(index, id, expected, async binding =>
        publicRole(workspaceCatalog, binding, await writeEnabled(index, binding, enabled))))
    },
    async reorder(ids, revision) {
      checkArray(ids, MAX_PERSONA_FILES, 'INVALID')
      const order = ids.map(requireId)
      if (new Set(order).size !== order.length) fail('INVALID')
      const expected = validatedRevision(revision, true)
      return access(async index => {
        // Read the full projection before writing order: corrupt files fail before commit,
        // and changing a name invalidates older tabs when it changes the fallback ordering.
        const roster = await publicRoster(workspaceCatalog, index)
        checkRevision(roster.revision, expected)
        const present = new Set(index.ids)
        if (present.size !== order.length || order.some(id => !present.has(id))) fail('INVALID')
        const byId = new Map(roster.roles.map(role => [role.id, role]))
        const nextOrder = [...order, ...index.config.order.filter(id => !present.has(id))]
        const raw = { ...index.config.raw, personas: { ...index.config.personas, order: nextOrder } }
        const bytes = encodeSettings(raw)
        try {
          if (JSON.stringify(index.config.order) !== JSON.stringify(nextOrder)) await commitConfig(index, bytes)
        } finally { bytes.fill(0) }
        return { roles: order.map(id => byId.get(id)), order, revision: rosterRevision(order, nextOrder) }
      })
    },
    async remove(id, revision) {
      requireId(id)
      if (id === DEFAULT_PERSONA_ID) fail('PROTECTED')
      const expected = validatedRevision(revision, true)
      return access(index => withRole(index, id, expected, async binding => {
        await assertNoReferences(index, id, checkReferences)
        await assertWritable(index.directory, binding.info)
        await verifyFile(index.directory, nameFor(id), binding.info, MAX_PERSONA_FILE_BYTES)
        const { raw: before, personas, enabled, order, retired } = index.config
        const nextEnabled = { ...enabled }
        delete nextEnabled[id]
        const raw = { ...before, personas: { ...personas, enabled: nextEnabled, order: order.filter(value => value !== id),
          [retiredKey]: { ...retired, [id]: true } } }
        const bytes = encodeSettings(raw)
        const rollback = encodeSettings(before)
        try {
          // A durable retirement guard comes first: a delayed external restore cannot
          // revive a role already removed by this service (and creation is always server-assigned).
          const committed = await commitConfig(index, bytes)
          try {
            if (!committed.durable) fail('CONFLICT')
            await removeCheckedFile(index.directory, nameFor(id), binding.info, MAX_PERSONA_FILE_BYTES, async () => {
              await index.verifyRootAndDir()
              if (!sameSnapshot((await readConfig(index.root)).info, committed.info)) fail('CONFLICT')
              await assertNoReferences(index, id, checkReferences)
            })
          } catch (error) {
            // An unsuccessful unlink must not silently retire an otherwise intact role.
            await index.verifyRootAndDir()
            await publishSettingsFile(index.root, rollback, committed.info)
            throw error
          }
          return { ok: true }
        } finally { bytes.fill(0); rollback.fill(0) }
      }))
    }
  })
}
