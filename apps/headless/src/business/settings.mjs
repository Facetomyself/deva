import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { assertWritable, encodeSettings, publishSettingsFile, readSettingsFile, revisionFor, withSettingsDirectory } from './settings-file.mjs'
import { HEADER_MASK, MAX_PROVIDERS, SettingsError, assertRevision, credentialBinding, headerValues,
  hydrate, patchInput, providerId, record, section, validateApiKey } from './settings-schema.mjs'

export { HEADER_MASK, SettingsError }

const META = '_devaHeadlessSettings'
const NAMESPACE = 'settings:provider:'
const REF_PATTERN = /^[a-f0-9]{32}$/
const MAX_CREDENTIAL_BYTES = 64 * 1024 // the vault's per-value capacity
const own = Object.hasOwn

const corrupt = () => new SettingsError('CORRUPT')
const invalid = () => new SettingsError('INVALID')
const slot = (id, ref) => `${NAMESPACE}${id}:${ref}`

function sameRevision(expected, current) {
  if (expected !== undefined && expected !== current) throw new SettingsError('CONFLICT')
}

function refsFrom(raw) {
  if (!own(raw, META)) return new Map()
  const meta = record(raw[META], null, true)
  if (Object.keys(meta).length !== 2 || meta.version !== 1 || !own(meta, 'credentials')) throw corrupt()
  const table = record(meta.credentials, null, true)
  if (Object.keys(table).length > MAX_PROVIDERS + 16) throw corrupt()
  return new Map(Object.entries(table).map(([id, ref]) => {
    if (typeof ref !== 'string' || !REF_PATTERN.test(ref)) throw corrupt()
    return [providerId(id, true), ref]
  }))
}

function credentialFrom(payload) {
  if (typeof payload !== 'string') throw corrupt()
  try {
    const raw = record(JSON.parse(payload), null, true)
    const { binding, apiKey, headers } = raw
    if (Object.keys(raw).length !== 3 || !own(raw, 'binding') || !own(raw, 'apiKey') || !own(raw, 'headers') ||
        (binding !== null && (typeof binding !== 'string' || binding !== credentialBinding(binding))) ||
        (apiKey !== null && (binding === null || validateApiKey(apiKey) === ''))) throw corrupt()
    const safe = headerValues(headers, true)
    if (Object.values(safe).some(value => !value || value === HEADER_MASK) ||
        (!apiKey && !Object.keys(safe).length)) throw corrupt()
    return { binding, apiKey, headers: safe }
  } catch { throw corrupt() }
}

function compactCredential(binding, apiKey, headers) {
  if (!apiKey && !Object.keys(headers).length) return null
  return { binding, apiKey, headers }
}

async function vaultCall(vault, method, ...args) {
  if (!vault) throw new SettingsError('UNAVAILABLE')
  try { return await vault[method](...args) }
  catch (error) {
    if (['ERR_VAULT_FORMAT', 'ERR_VAULT_AUTH'].includes(error?.code)) throw corrupt()
    if (['EACCES', 'EPERM', 'EROFS'].includes(error?.code)) throw new SettingsError('READ_ONLY')
    throw new SettingsError('STORAGE')
  }
}

async function loadRefs(vault, refs) {
  if (!refs.size) {
    if (vault) await vaultCall(vault, 'list', NAMESPACE)
    return new Map()
  }
  const loaded = new Map()
  for (const [id, ref] of refs) loaded.set(id, credentialFrom(await vaultCall(vault, 'get', slot(id, ref))))
  return loaded
}

function withoutHeaders(provider) {
  const { headers: _headers, ...known } = provider
  return known
}

function stripHeaders(sections) {
  if (sections.models?.providers) sections.models.providers = sections.models.providers.map(withoutHeaders)
  return sections
}

function projection(state) {
  const { models: _models, ...appearance } = state.sections
  return {
    revision: state.revision,
    ...appearance,
    models: {
      ...state.models,
      providers: state.models.providers.map(p => {
        const out = withoutHeaders(p)
        const names = Object.keys(state.credentials.get(p.id)?.headers ?? {})
        if (names.length) out.headers = Object.fromEntries(names.map(name => [name, HEADER_MASK]))
        return out
      })
    }
  }
}

async function removeSlots(vault, slots) {
  for (const name of slots) {
    try { await vault.set(name, '') } catch { /* An unreachable snapshot contains only authenticated ciphertext at rest. */ }
  }
}

async function publish(vault, directory, identity, state, sections, nextCredentials) {
  // Replace only the sections that this business layer owns. All other desktop root
  // entries, including extension settings this layer never decodes or exposes, are retained.
  const rest = { ...state.raw }
  for (const name of Object.keys(state.sections)) delete rest[name]
  delete rest[META]
  const newRaw = { ...rest, ...sections }
  const nextRefs = new Map()
  const writes = []
  for (const [id, credential] of nextCredentials) {
    const oldRef = state.refs.get(id)
    if (oldRef && isDeepStrictEqual(credential, state.loaded.get(id))) {
      nextRefs.set(id, oldRef)
      continue
    }
    if (!vault) throw new SettingsError('UNAVAILABLE')
    const ref = randomBytes(16).toString('hex')
    const payload = JSON.stringify(credential)
    if (Buffer.byteLength(payload) > MAX_CREDENTIAL_BYTES) throw invalid()
    nextRefs.set(id, ref)
    writes.push([slot(id, ref), payload])
  }
  if (nextRefs.size || own(state.raw, META)) {
    newRaw[META] = { version: 1, credentials: Object.fromEntries(nextRefs) }
  }
  const result = { ...state, sections, models: hydrate(sections.models), credentials: nextCredentials }
  if (isDeepStrictEqual(newRaw, state.raw)) return result
  const bytes = encodeSettings(newRaw)
  const staged = []
  let committed
  try {
    await assertWritable(directory, state.info)
    // The old authenticated slot remains live until the config publishes new refs.
    // Each slot is one vault transaction over the key + headers + URL binding for this provider.
    for (const [name, value] of writes) {
      staged.push(name)
      await vaultCall(vault, 'set', name, value)
    }
    committed = await publishSettingsFile(directory, bytes, state.info)
  } catch (error) {
    if (staged.length) await removeSlots(vault, staged)
    throw error
  } finally {
    bytes.fill(0)
  }
  if (committed.durable && vault) {
    const retired = [...state.refs].filter(([id, oldRef]) => nextRefs.get(id) !== oldRef)
    await removeSlots(vault, retired.map(([id, ref]) => slot(id, ref)))
  }
  return { ...result, revision: revisionFor(identity, committed.info), info: committed.info, raw: newRaw, refs: nextRefs }
}

async function load(vault, directory, identity, previouslyPresent, migrateLegacyHeaders = false) {
  const { raw, info } = await readSettingsFile(directory)
  if (!info && previouslyPresent) throw corrupt()
  const sections = section(raw, true)
  const models = hydrate(sections.models)
  if (!migrateLegacyHeaders && models.providers.some(p => Object.values(p.headers ?? {}).some(Boolean))) {
    throw new SettingsError('MIGRATION_REQUIRED')
  }
  const refs = refsFrom(raw)
  const loaded = await loadRefs(vault, refs)
  const credentials = new Map()
  let migrate = false
  for (const p of models.providers) {
    const binding = credentialBinding(p.apiHost)
    const enrolled = loaded.get(p.id)
    const prior = enrolled?.binding === binding ? enrolled : null
    let headers = prior?.headers ?? {}
    if (p.headers && Object.values(p.headers).some(Boolean)) {
      // Legacy desktop values are local imports, never browser input. Once a provider's
      // recorded binding disagrees with disk we quarantine its old values instead of
      // accepting an existing desktop header copied across an address change.
      migrate = true
      if (!enrolled || prior) {
        headers = { ...headers }
        for (const [name, value] of Object.entries(p.headers)) {
          if (value === HEADER_MASK && !own(headers, name)) throw corrupt()
          if (value && value !== HEADER_MASK) headers[name] = value
        }
        if (Object.keys(headers).length > 32) throw corrupt()
      }
    }
    const credential = compactCredential(binding, prior?.apiKey ?? null, headers)
    if (credential) credentials.set(p.id, credential)
  }
  stripHeaders(sections)
  const state = { raw, info, sections, models: hydrate(sections.models), refs, loaded, credentials, revision: revisionFor(identity, info) }
  if (migrate) {
    if (!vault) throw new SettingsError('UNAVAILABLE')
    return publish(vault, directory, identity, state, sections, credentials)
  }
  return state
}

function applySections(state, { set, unset }) {
  const next = structuredClone(state.sections)
  for (const key of unset) {
    const [group, field] = key.split('.')
    if (field === undefined) delete next[group]
    else if (next[group]) delete next[group][field]
  }
  for (const [key, value] of Object.entries(set)) {
    next[key] = key === 'layout' || key === 'models' ? { ...next[key], ...value } : value
  }
  return next
}

function updateCredentials(state, providers) {
  const next = new Map()
  for (const p of providers) {
    const old = state.credentials.get(p.id)
    const binding = credentialBinding(p.apiHost)
    const same = old?.binding === binding
    const previousValues = new Set(Object.values((old ?? state.loaded.get(p.id))?.headers ?? {}))
    const headers = {}
    for (const [name, value] of Object.entries(p.headers ?? {})) {
      if (value === HEADER_MASK) {
        if (!old || !own(old.headers, name)) throw invalid()
        // A whole-table masked round trip can accompany a URL edit, but the previous
        // value is never carried over. The same rule applies to a stale literal still
        // held by an editor: saving the new URL must precede entering that value again.
        if (same) headers[name] = old.headers[name]
      } else if (value && (same || !previousValues.has(value))) headers[name] = value
    }
    const credential = compactCredential(binding, same ? old.apiKey : null, headers)
    if (credential) next.set(p.id, credential)
  }
  return next
}

function cleanupActiveOnProviderChanges(next, previous) {
  const active = next.models?.activeModelId
  if (!active) return
  const colon = active.indexOf(':')
  const id = active.slice(0, colon)
  const modelId = active.slice(colon + 1)
  const old = previous.models.providers.find(p => p.id === id)
  const current = hydrate(next.models).providers.find(p => p.id === id)
  if (old && (!current || (old.enabled && !current.enabled) ||
      (old.models.some(m => m.id === modelId) && !current.models.some(m => m.id === modelId)))) {
    next.models.activeModelId = null
  }
}

/**
 * Pure-Node settings business layer. `dataDir` overrides DEVA_HOME (default ~/.deva).
 * Its JSON-compatible public snapshot is safe to serialize; getProvider is process-internal only.
 * URL resolution, network policy, HTTP authentication, CSRF and redirect handling belong to the server.
 * migrateLegacyHeaders is a one-time operator action on a private copy, not a browser setting.
 */
export async function openSettings(options = {}) {
  const {
    dataDir = process.env.DEVA_HOME?.trim() || join(homedir(), '.deva'), vault, migrateLegacyHeaders = false
  } = record(options)
  if (typeof dataDir !== 'string' || !dataDir || dataDir.includes('\0') || typeof migrateLegacyHeaders !== 'boolean' ||
      (vault != null && !['list', 'get', 'set'].every(method => typeof vault[method] === 'function'))) throw invalid()
  const path = resolve(dataDir)
  let seen = false
  const identity = await withSettingsDirectory(path, null, async (directory, id) => {
    seen = Boolean((await load(vault, directory, id, false, migrateLegacyHeaders)).info)
    return id
  })
  const access = task => withSettingsDirectory(path, identity, async directory => {
    const state = await load(vault, directory, identity, seen)
    if (state.info) seen = true
    return task(directory, state)
  })
  const commit = async (directory, current, next, credentials) => {
    const result = await publish(vault, directory, identity, current, next, credentials)
    if (result.info) seen = true
    return result
  }
  const changeKey = (id, key, expectedRevision, deleting = false) => access(async (directory, state) => {
    sameRevision(expectedRevision, state.revision)
    const provider = state.models.providers.find(p => p.id === id)
    if (!provider && !deleting) throw new SettingsError('PROVIDER_NOT_FOUND')
    if (!vault) throw new SettingsError('UNAVAILABLE')
    // Whole-table provider deletion already drops its credentials. A follow-up DELETE
    // is idempotent, with the same revision check as writes; an unreachable old slot
    // from an out-of-band desktop edit is also retired by publish.
    const binding = credentialBinding(provider?.apiHost)
    if (key && !binding) throw invalid()
    const credentials = new Map(state.credentials)
    const entry = compactCredential(binding, key || null, credentials.get(id)?.headers ?? {})
    if (entry) credentials.set(id, entry)
    else credentials.delete(id)
    const current = await commit(directory, state, state.sections, credentials)
    return { ok: true, available: true, revision: current.revision }
  })
  return Object.freeze({
    async getPublicConfig() {
      return access((_directory, state) => projection(state))
    },
    async patch(input) {
      const edit = patchInput(input)
      return access(async (directory, state) => {
        sameRevision(edit.revision, state.revision)
        const next = applySections(state, edit)
        const credentials = edit.changesProviders ? updateCredentials(state, next.models?.providers ?? []) : state.credentials
        if (edit.changesProviders) cleanupActiveOnProviderChanges(next, state)
        return projection(await commit(directory, state, stripHeaders(next), credentials))
      })
    },
    // The returned URL and secrets are obtained from one revision. The caller must
    // use that exact URL under server authorization, never a request-supplied override.
    async getProvider(id) {
      providerId(id)
      return access((_directory, state) => {
        const provider = state.models.providers.find(p => p.id === id)
        if (!provider) return null
        const credential = state.credentials.get(id)
        const headers = credential?.binding ? credential.headers : {}
        return { ...withoutHeaders(provider), apiKey: credential?.apiKey ?? null, ...(
          Object.keys(headers).length ? { headers: { ...headers } } : {}) }
      })
    },
    async listKeys() {
      return access((_directory, state) => [...state.credentials].filter(([, value]) => value.apiKey).map(([id]) => id).sort())
    },
    async hasKey(id) {
      providerId(id)
      return access((_directory, state) => Boolean(state.credentials.get(id)?.apiKey))
    },
    async setKey(id, key, expectedRevision) {
      providerId(id)
      validateApiKey(key)
      if (expectedRevision !== undefined) assertRevision(expectedRevision)
      return changeKey(id, key, expectedRevision)
    },
    async deleteKey(id, expectedRevision) {
      providerId(id)
      if (expectedRevision !== undefined) assertRevision(expectedRevision)
      return changeKey(id, '', expectedRevision, true)
    },
    async available() {
      return access(() => Boolean(vault))
    }
  })
}
