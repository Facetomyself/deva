import { createHash } from 'node:crypto'
import { deriveTitle } from '../../dist/chat-core.mjs'
import { providerId as checkedProviderId } from '../business/settings-schema.mjs'
import { HttpError } from '../http/policy.mjs'

export const PREFERENCES_META = '_devaHeadlessSessionPreferences'
const titleMax = 100 // Match the desktop rename action's UTF-16 limit and whitespace folding.
const nativeEfforts = new Set(['default', 'low', 'medium', 'high', 'xhigh', 'max'])
const adapters = new Set(['openai', 'anthropic', 'responses'])
const preferenceKeys = ['customTitle', 'archived', 'model', 'effort']
const conflict = () => new HttpError(409, 'preferences_conflict')
const invalidPatch = () => new HttpError(400, 'invalid_preferences')
export const unsupportedEffort = () => new HttpError(422, 'effort_unsupported')

function record(value, allowed) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalidPatch()
  const fields = Object.create(null)
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key)
    if (!allowed.includes(key) || !d.enumerable || !Object.hasOwn(d, 'value')) throw invalidPatch()
    fields[key] = d.value
  }
  return fields
}

export function splitModel(ref) {
  if (typeof ref !== 'string' || ref.length > 609) throw new HttpError(400, 'invalid_model_ref')
  const colon = ref.indexOf(':')
  if (colon < 1) throw new HttpError(400, 'invalid_model_ref')
  const providerId = ref.slice(0, colon)
  const modelId = ref.slice(colon + 1)
  try { checkedProviderId(providerId) } catch { throw new HttpError(400, 'invalid_model_ref') }
  if (!modelId || modelId.length > 512 || modelId !== modelId.trim() || /[\x00-\x1f\x7f]/.test(modelId)) {
    throw new HttpError(400, 'invalid_model_ref')
  }
  return { providerId, modelId }
}

export function readPreferencePatch(input) {
  const fields = record(input, ['revision', 'set'])
  if (!Object.hasOwn(fields, 'revision')) throw new HttpError(409, 'revision_required')
  const { revision } = fields
  if (typeof revision !== 'string' || revision.length !== 64 || /[^a-f0-9]/.test(revision)) throw new HttpError(400, 'invalid_revision')
  const set = record(fields.set, preferenceKeys)
  if (!Object.keys(set).length) throw invalidPatch()
  if (Object.hasOwn(set, 'customTitle') && set.customTitle !== null) {
    if (typeof set.customTitle !== 'string' || !set.customTitle.isWellFormed()) throw invalidPatch()
    set.customTitle = set.customTitle.replace(/\s+/g, ' ').trim().slice(0, titleMax).toWellFormed() || null
  }
  if (Object.hasOwn(set, 'archived') && typeof set.archived !== 'boolean') throw invalidPatch()
  let model
  if (Object.hasOwn(set, 'model') && set.model !== null) {
    if (typeof set.model !== 'string' || !set.model.isWellFormed()) throw new HttpError(400, 'invalid_model_ref')
    model = splitModel(set.model)
  }
  if (Object.hasOwn(set, 'effort') && set.effort !== null && !nativeEfforts.has(set.effort)) throw new HttpError(400, 'invalid_effort')
  return { revision, set, model }
}

export function validPreferenceFields(s) {
  const meta = s[PREFERENCES_META]
  if (s.archived !== undefined && typeof s.archived !== 'boolean') return false
  if (s.effort !== undefined && !nativeEfforts.has(s.effort)) return false
  if (s.model !== undefined && typeof s.model !== 'string') return false
  if (meta === undefined) return true
  try {
    const fields = record(meta, ['version', 'generation', 'customTitle', 'managedModel'])
    return Object.keys(fields).length === 4 && fields.version === 1 && Number.isSafeInteger(fields.generation) && fields.generation > 0 &&
      (fields.customTitle === null || (typeof fields.customTitle === 'string' && fields.customTitle.length > 0 &&
        fields.customTitle.length <= titleMax && fields.customTitle.isWellFormed())) && typeof fields.managedModel === 'boolean'
  } catch { return false }
}

export const managedModel = s => s[PREFERENCES_META]?.managedModel === true
const storedModel = s => typeof s.model === 'string' && s.model ? s.model : null

export function preferenceView(s, turnCount) {
  const meta = s[PREFERENCES_META]
  // A desktop rename can change the native title without understanding the headless sidecar.
  const title = s.title
  const customTitle = meta?.customTitle === title ? title : null
  const preferences = { title, customTitle, archived: s.archived === true, model: storedModel(s), effort: s.effort ?? null }
  // Include the legacy turn count to avoid ABA if successive legacy sends change the native model and change it back.
  // Once managed, the ledger has no bearing on a metadata revision.
  const revision = createHash('sha256').update(JSON.stringify([
    'headless-session-preferences-v1', s.id, s.createdAt, meta?.generation ?? 0,
    managedModel(s) ? null : turnCount, preferences
  ])).digest('hex')
  return { preferences, revision }
}

export const checkPreferenceRevision = (expected, current) => {
  if (expected !== current) throw conflict()
}

export function firstTitle(text, names = []) {
  return (deriveTitle(text) || deriveTitle(names.join(' '))).toWellFormed()
}

export function preferenceChanges(s, set, firstUser) {
  const prior = s[PREFERENCES_META]
  const generation = (prior?.generation ?? 0) + 1
  if (!Number.isSafeInteger(generation)) throw new HttpError(409, 'preferences_revision_exhausted')
  const patch = {}
  let customTitle = prior?.customTitle === s.title ? s.title : null
  if (Object.hasOwn(set, 'customTitle')) {
    customTitle = set.customTitle
    const first = customTitle === null ? firstUser() : null
    patch.title = customTitle ?? (first ? firstTitle(first.content, first.attachments?.map(a => a.name)) : '')
  }
  if (Object.hasOwn(set, 'archived')) patch.archived = set.archived ? true : undefined
  const pinChanged = Object.hasOwn(set, 'model')
  if (pinChanged) patch.model = set.model ?? '' // Desktop represents following its default as an empty native model.
  if (Object.hasOwn(set, 'effort')) patch.effort = set.effort ?? undefined
  patch[PREFERENCES_META] = { version: 1, generation, customTitle, managedModel: pinChanged || managedModel(s) }
  return patch
}

export function listPreferenceFields(s) {
  return {
    ...(s.archived === true || s.archived === false ? { archived: s.archived } : {}),
    ...(s[PREFERENCES_META]?.customTitle === s.title && s.title ? { customTitle: s.title } : {})
  }
}

export async function validatePreferenceModel(settings, ref) {
  let p
  try { p = await settings.getProvider(ref.providerId) }
  catch { throw new HttpError(503, 'chat_model_unavailable') }
  if (!p) throw new HttpError(404, 'provider_not_found')
  if (p.purpose === 'decision' || !adapters.has(p.adapter) || typeof p.apiHost !== 'string' || !p.apiHost.trim()) {
    throw new HttpError(422, 'not_chat_provider')
  }
  if (!p.enabled || !p.models?.some(m => m.id === ref.modelId && m.enabled)) throw new HttpError(422, 'model_not_enabled')
}

/** Setters make no provider requests. A later fresh send must agree with the effective model;
 * accepting a different request model would silently replace the setting or break ledger identity. */
export async function resolveTurnModel(settings, s, role, requested) {
  const isManaged = managedModel(s)
  if (!isManaged && requested !== null) return requested
  const pin = storedModel(s)
  if (pin) {
    if (requested !== pin) throw new HttpError(409, 'session_model_changed')
    return pin
  }
  let effective = role?.model
  if (!effective) {
    try { effective = (await settings.getPublicConfig()).models.activeModelId }
    catch { throw new HttpError(503, 'chat_model_unavailable') }
  }
  if (!effective) throw new HttpError(422, 'model_not_enabled')
  if (requested !== null && requested !== effective) throw new HttpError(409, 'session_model_changed')
  return effective
}
