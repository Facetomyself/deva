import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { assertWritable, publishSettingsFile, revisionFor, withSettingsDirectory } from '../business/settings-file.mjs'
import { close, mountId, openAbsoluteDirectory, stat } from '../files/workspace-files-fd.mjs'
import { configurationInfo, readSkillConfiguration, sameConfig } from './config-file.mjs'
import { encodeSkillPreference, parseSkillConfig, skillPreferences } from './config.mjs'
import { publicSkillError, skillError } from './errors.mjs'
import { assertSkillId, assertSkillOwner, skillPreferenceEdit, validRoleId } from './validation.mjs'

const execution = 'inactive'
const conflict = () => skillError('skill_conflict')
const hash = parts => createHash('sha256').update(JSON.stringify(parts)).digest('hex')
const rootId = info => [info.dev, info.ino].join(':')
const accessMode = info => [info.uid, info.gid, info.mode].join(':')
const configRevision = (root, config) => revisionFor(`${root.id}:${root.access}`, config.info)

function stampsOf(rows) {
  const stamps = rows.map(({ id, documentRevision }) => [id, documentRevision])
  return stamps.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
}

const catalogRevision = (root, config, stamps) => hash(['deva-skill-catalog-v1', configRevision(root, config), stamps])
const noPreferences = Object.freeze({ enabled: true, roles: null })

function canWrite(root, config) {
  // The legacy desktop writer often produces 0644. Preserve safe owner modes, rather
  // than replacing an imported file with different access permissions as a side effect.
  return (root.info.mode & 0o700n) === 0o700n && (!config.info ||
    ((config.info.mode & 0o7133n) === 0n && (config.info.mode & 0o600n) === 0o600n))
}

function summary(raw, root, snapshot, preferences) {
  const { id, name, description, source, documentRevision } = raw
  const custom = source === 'custom'
  const revision = hash(['deva-skill-preferences-v1', id, source, documentRevision,
    custom ? configRevision(root, snapshot) : null])
  return { id, name, description, source, ...preferences, revision, canConfigure: custom && canWrite(root, snapshot) }
}

function detail(raw, projection) {
  if (raw.source === 'builtin') return { ...projection, detail: 'builtin' }
  const { instructions, trigger, license, compatibility, allowedTools, metadata } = raw
  return { ...projection, detail: 'document', instructions, trigger, license, compatibility,
    allowedTools: [...allowedTools], metadata: { ...metadata } }
}

function roleChoices(choices) {
  const ids = new Set()
  return choices.map(({ id, name, enabled }) => {
    if (!validRoleId(id) || ids.has(id) || typeof name !== 'string' || typeof enabled !== 'boolean') throw skillError()
    ids.add(id)
    return { id, name, enabled }
  })
}

function verifyRoleRoster(verify) {
  const result = verify?.()
  if (result === false) throw conflict()
  if (result && typeof result.then === 'function') {
    Promise.resolve(result).catch(() => {})
    throw skillError()
  }
}

function unchanged(preferences, { field, value }) {
  const before = preferences[field]
  return before === value || (Array.isArray(before) && Array.isArray(value) &&
    before.length === value.length && before.every((id, i) => id === value[i]))
}

/** Human-owned control plane for saved native skill preferences; no execution state. */
export function openSkillLibrary(options = {}) {
  if (!options || typeof options !== 'object') throw skillError('skill_invalid')
  const { dataDir, documents, withRoleChoices } = options
  if (typeof dataDir !== 'string' || !dataDir.isWellFormed() || !isAbsolute(dataDir) || dataDir.includes('\0') ||
    dataDir === '/' || Buffer.byteLength(dataDir) > 4095 || resolve(dataDir) !== dataDir ||
    !documents || !['list', 'get', 'stamps', 'stamp'].every(method => typeof documents[method] === 'function') ||
    typeof withRoleChoices !== 'function') throw skillError('skill_invalid')
  const path = dataDir
  let pinnedRoot, closed = false

  function verifyRoot(root) {
    if (closed) throw skillError()
    let live
    try {
      live = openAbsoluteDirectory(path)
      const info = stat(live)
      if (root.id !== rootId(info) || root.mount !== mountId(live) || root.access !== accessMode(info) ||
          (pinnedRoot !== undefined && (root.id !== rootId(stat(pinnedRoot)) || root.mount !== mountId(pinnedRoot)))) throw conflict()
      if (pinnedRoot === undefined) {
        // Keep the first inode alive so an external replacement cannot recycle it.
        // Directory ctime (and synthesized birthtime) can change on any sibling edit.
        pinnedRoot = live
        live = undefined
      }
    } finally { close(live) }
  }

  async function access(operation, metadataOnly = false) {
    try {
      if (closed) throw skillError()
      const result = await withSettingsDirectory(path, null, async directory => {
        let snapshot
        try {
          const info = stat(directory.fd)
          if ((info.mode & 0o500n) !== 0o500n) throw skillError('skill_unsupported')
          const root = { directory, info, id: rootId(info), access: accessMode(info), mount: mountId(directory.fd) }
          verifyRoot(root)
          snapshot = metadataOnly ? { info: configurationInfo(root) } : await readSkillConfiguration(root)
          return { value: await operation(root, snapshot) }
        } catch (error) {
          // Keep the shared queue's existing SettingsError behavior for other clients.
          return { error: publicSkillError(error) }
        } finally { snapshot?.bytes?.fill(0) }
      }, { create: false })
      if (result.error) throw result.error
      return result.value
    } catch (error) { throw publicSkillError(error) }
  }

  function verifySnapshot(root, snapshot) {
    verifyRoot(root)
    if (!sameConfig(snapshot.info, configurationInfo(root))) throw conflict()
  }

  async function verifyDocument(raw) {
    if (await documents.stamp(raw.id) !== raw.documentRevision) throw conflict()
  }

  async function publish(root, snapshot, raw, bytes, checkOwner, verifyChoices) {
    await assertWritable(root.directory, snapshot.info)
    const committed = await publishSettingsFile(root.directory, bytes, snapshot.info, {
      preserveAccess: true,
      async beforePublish() {
        checkOwner()
        await verifyDocument(raw)
      },
      authorize() {
        verifySnapshot(root, snapshot)
        verifyRoleRoster(verifyChoices)
        checkOwner()
      }
    })
    let observed
    try {
      observed = await readSkillConfiguration(root)
      await verifyDocument(raw)
      verifySnapshot(root, observed)
      const { info } = observed
      if (!committed.durable || !info || !sameConfig(committed.info, info) || !observed.bytes.equals(bytes) ||
          (snapshot.info && accessMode(info) !== accessMode(snapshot.info)) || !canWrite(root, observed)) throw skillError()
      return info
    } catch {
      // Publication may be visible: never acknowledge an unconfirmed save or roll back
      // over an external writer. The volume lock covers cooperating Workbench writers;
      // filesystem rename itself has no compare-and-swap precondition.
      throw skillError()
    } finally { observed?.bytes?.fill(0) }
  }

  function setPreference(id, edit, checkOwner, choices, verifyChoices) {
    return access(async (root, snapshot) => {
      // Loading a detail is unnecessary for a preference edit; read only summaries.
      const raw = (await documents.list()).find(row => row.id === id)
      if (!raw) throw skillError('skill_not_found')
      if (raw.source === 'builtin') throw skillError('skill_builtin')
      const config = parseSkillConfig(snapshot.bytes, new Set([id]))
      const current = skillPreferences(config, id)
      const skill = summary(raw, root, snapshot, current)
      if (edit.revision !== skill.revision) throw conflict()
      if (edit.field === 'roles' && edit.value?.length) {
        const known = new Set(roleChoices(choices).map(role => role.id))
        // Historical IDs can be retained verbatim from this exact CAS snapshot.
        // A newly added ID must always be present in the authoritative roster.
        const saved = new Set(current.roles ?? [])
        if (edit.value.some(role => !known.has(role) && !saved.has(role))) throw skillError('skill_unknown_role')
      }
      if (unchanged(current, edit)) {
        checkOwner()
        await verifyDocument(raw)
        verifySnapshot(root, snapshot)
        verifyRoleRoster(verifyChoices)
        checkOwner()
        return { skill, execution }
      }
      if (!skill.canConfigure) throw skillError('skill_read_only')
      const bytes = encodeSkillPreference(config, id, edit)
      try {
        const info = await publish(root, snapshot, raw, bytes, checkOwner, verifyChoices)
        checkOwner()
        try { verifyRoleRoster(verifyChoices) } catch { throw skillError() }
        const preferences = { ...current, [edit.field]: edit.value }
        return { skill: summary(raw, root, { info }, preferences), execution }
      } finally { bytes.fill(0) }
    })
  }

  return Object.freeze({
    async list() {
      return access(async (root, snapshot) => {
        const records = await documents.list()
        const config = parseSkillConfig(snapshot.bytes, new Set(records.filter(row => row.source === 'custom').map(row => row.id)))
        const skills = records.map(raw => summary(raw, root, snapshot,
          raw.source === 'builtin' ? noPreferences : skillPreferences(config, raw.id)))
        const stamps = stampsOf(records)
        if (JSON.stringify(stamps) !== JSON.stringify(stampsOf(await documents.stamps()))) throw conflict()
        verifySnapshot(root, snapshot)
        return { skills, revision: catalogRevision(root, snapshot, stamps), execution }
      })
    },
    async get(id) {
      assertSkillId(id)
      return access(async (root, snapshot) => {
        const raw = await documents.get(id)
        let skill = null
        if (raw) {
          const preferences = raw.source === 'builtin' ? noPreferences :
            skillPreferences(parseSkillConfig(snapshot.bytes, new Set([id])), id)
          skill = detail(raw, summary(raw, root, snapshot, preferences))
        }
        if (await documents.stamp(id) !== (raw?.documentRevision ?? null)) throw conflict()
        verifySnapshot(root, snapshot)
        return { skill, execution }
      })
    },
    async roles() {
      try {
        if (closed) throw skillError()
        return await withRoleChoices(async (choices, verify) => {
          const roles = roleChoices(choices)
          verifyRoleRoster(verify)
          return { roles }
        })
      } catch (error) { throw publicSkillError(error) }
    },
    async set(id, input, verifyOwner) {
      assertSkillId(id)
      const edit = skillPreferenceEdit(input)
      const checkOwner = () => assertSkillOwner(verifyOwner, id)
      checkOwner()
      try {
        // The roster gate must be outermost: its own roster read uses the same
        // settings directory queue as this preference write.
        if (edit.field === 'roles') return await withRoleChoices((choices, verify) => setPreference(id, edit, checkOwner, choices, verify))
        return await setPreference(id, edit, checkOwner)
      } catch (error) { throw publicSkillError(error) }
    },
    async revision() {
      return access(async (root, snapshot) => {
        const stamps = stampsOf(await documents.stamps())
        verifySnapshot(root, snapshot)
        return catalogRevision(root, snapshot, stamps)
      }, true)
    },
    close() {
      if (closed) return
      closed = true
      const fd = pinnedRoot
      pinnedRoot = undefined
      close(fd)
    }
  })
}
