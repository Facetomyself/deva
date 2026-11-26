import { seedDefaults, freshSeeds } from './settings-seeds.mjs'

export const HEADER_MASK = '[deva:stored-header]'
export const MAX_PROVIDERS = 128
const MAX_MODELS = 4096
const own = Object.hasOwn
const forbidden = new Set(['__proto__', 'prototype', 'constructor'])
const themes = ['light', 'dark', 'system']
const locales = ['zh-CN', 'en']
const fontSizes = ['sm', 'md', 'lg', 'xl']
const efforts = ['default', 'low', 'medium', 'high', 'xhigh', 'max']
const kinds = ['official', 'custom']
const purposes = ['llm', 'decision']
const adapters = ['anthropic', 'openai', 'responses', 'jev']
const layoutKeys = ['sidebarWidth', 'sidebarCollapsed', 'composerHeight']
const modelKeys = ['providers', 'activeModelId', 'activeEffort']
const topKeys = ['theme', 'locale', 'chatFontSize', 'closeToTray', 'layout', 'models']
const providerKeys = ['id', 'name', 'kind', 'purpose', 'accent', 'adapter', 'apiHost', 'headers', 'docUrl', 'enabled', 'threshold', 'models']
const modelFields = ['id', 'name', 'tags', 'enabled', 'contextWindow', 'maxOutput']
const reservedHeaders = new Set([
  'authorization', 'x-api-key', 'content-type', 'content-length', 'host', 'connection', 'transfer-encoding',
  'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'upgrade', 'expect', 'keep-alive'
])

const errors = {
  INVALID: [400, 'Invalid settings input'],
  REVISION_REQUIRED: [409, 'Settings revision required'],
  CONFLICT: [409, 'Settings revision changed'],
  PROVIDER_NOT_FOUND: [404, 'Provider not found'],
  CORRUPT: [500, 'Invalid existing settings data'],
  MIGRATION_REQUIRED: [503, 'Legacy desktop headers require explicit migration'],
  READ_ONLY: [503, 'Settings storage is read-only'],
  STORAGE: [503, 'Settings storage failed'],
  UNAVAILABLE: [503, 'Settings vault is unavailable']
}

export class SettingsError extends Error {
  constructor(kind) {
    const [status, message] = errors[kind]
    super(message)
    this.name = 'SettingsError'
    this.code = `ERR_SETTINGS_${kind}`
    this.status = status
  }
}

const fail = stored => { throw new SettingsError(stored ? 'CORRUPT' : 'INVALID') }
const boolean = (value, stored) => typeof value === 'boolean' ? value : fail(stored)
const selected = (value, choices, stored) => choices.includes(value) ? value : fail(stored)
const integer = (value, min, max, stored) => Number.isSafeInteger(value) && value >= min && value <= max ? value : fail(stored)
const text = (value, max, stored) => typeof value === 'string' && Buffer.byteLength(value) <= max &&
  !/[\u0000-\u001f\u007f]/u.test(value) ? value : fail(stored)

// Request objects must be inert JSON records, even when called directly rather than via JSON.parse.
export function record(value, allowed, stored = false) {
  if (value === null || typeof value !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(stored)
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || forbidden.has(key) || !property.enumerable || !own(property, 'value') ||
      (allowed && !allowed.includes(key) && !stored)) fail(stored)
  }
  return value
}

function list(value, max, stored) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max ||
      Reflect.ownKeys(value).length !== value.length + 1) fail(stored)
  for (let i = 0; i < value.length; i++) {
    const property = Object.getOwnPropertyDescriptor(value, `${i}`)
    if (!property?.enumerable || !own(property, 'value')) fail(stored)
  }
  return value
}

export function providerId(value, stored = false) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(value) ||
      forbidden.has(value)) fail(stored)
  return value
}

function modelId(value, stored) {
  const id = text(value, 512, stored)
  if (!id.trim() || id.trim() !== id || forbidden.has(id)) fail(stored)
  return id
}

function urlText(value, stored, draft = false) {
  const input = text(value, 4096, stored).trim()
  if (draft && (input === '' || input === 'https://' || input === 'http://')) return input
  // Exclude embedded credentials and URL params, including empty user-info/query/fragment syntax.
  // Network/DNS/redirect authorization belongs to the server-side provider fetch layer.
  if (!/^https?:\/\/[^/@?#\s]+(?:\/[^?#\s]*)?$/iu.test(input) || input.includes('\\')) fail(stored)
  try {
    const parsed = new URL(input)
    if (parsed.username || parsed.password || !parsed.hostname) fail(stored)
  } catch { fail(stored) }
  return input
}

export function credentialBinding(value) {
  if (!value || value === 'https://' || value === 'http://') return null
  const url = new URL(value)
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

export function headerValues(value, stored = false) {
  const raw = record(value, null, stored)
  const out = {}
  if (Object.keys(raw).length > 32) fail(stored)
  for (const [key, entry] of Object.entries(raw)) {
    const name = key.trim().toLowerCase()
    if (name.length > 128 || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) ||
      forbidden.has(name) || reservedHeaders.has(name) || own(out, name) ||
      typeof entry !== 'string' || entry.length > 8192 || !/^[\t\x20-\x7e]*$/.test(entry)) fail(stored)
    // An omitted row (or an empty value) explicitly removes the header in the full table update.
    out[name] = entry.trim()
  }
  return out
}

function getLayout(value, stored) {
  const raw = record(value, layoutKeys, stored)
  const out = {}
  if (own(raw, 'sidebarWidth')) out.sidebarWidth = integer(raw.sidebarWidth, 220, 480, stored)
  if (own(raw, 'sidebarCollapsed')) out.sidebarCollapsed = boolean(raw.sidebarCollapsed, stored)
  if (own(raw, 'composerHeight')) out.composerHeight = integer(raw.composerHeight, 44, 400, stored)
  return out
}

function getModel(value, stored) {
  const raw = record(value, modelFields, stored)
  const id = modelId(raw.id, stored)
  const out = {
    id,
    name: stored && typeof raw.name !== 'string' ? id : text(raw.name, 512, stored),
    enabled: stored ? raw.enabled === true : boolean(raw.enabled, stored)
  }
  if (own(raw, 'tags')) out.tags = list(raw.tags, 64, stored).map(tag => text(tag, 128, stored))
  if (own(raw, 'contextWindow')) out.contextWindow = integer(raw.contextWindow, 1_000, 20_000_000, stored)
  if (own(raw, 'maxOutput')) out.maxOutput = integer(raw.maxOutput, 256, 2_000_000, stored)
  return out
}

function unique(list, stored) {
  if (new Set(list.map(item => item.id)).size !== list.length) fail(stored)
  return list
}

function getProvider(value, stored) {
  const raw = record(value, providerKeys, stored)
  const id = providerId(raw.id, stored)
  const seed = seedDefaults.get(id)
  const purpose = own(raw, 'purpose') ? selected(raw.purpose, purposes, stored) : 'llm'
  const adapter = selected(own(raw, 'adapter') || !stored ? raw.adapter :
    (purpose === 'decision' ? 'jev' : seed?.adapter ?? 'openai'), adapters, stored)
  if ((purpose === 'decision') !== (adapter === 'jev')) fail(stored)
  const accent = own(raw, 'accent') || !stored ? raw.accent : seed?.accent ?? '#8a8a94'
  if (typeof accent !== 'string' || !/^#[\da-f]{6}$/i.test(accent)) fail(stored)
  const out = {
    id,
    name: stored && typeof raw.name !== 'string' ? id : text(raw.name, 256, stored),
    kind: selected(own(raw, 'kind') || !stored ? raw.kind : seed?.kind ?? 'custom', kinds, stored),
    purpose, accent, adapter,
    apiHost: urlText(stored && typeof raw.apiHost !== 'string' ? '' : raw.apiHost, stored, true),
    enabled: stored ? raw.enabled === true : boolean(raw.enabled, stored),
    models: unique((stored && !Array.isArray(raw.models) ? [] : list(raw.models, MAX_MODELS, stored))
      .map(model => getModel(model, stored)), stored)
  }
  if (own(raw, 'docUrl')) out.docUrl = raw.docUrl === '' ? '' : urlText(raw.docUrl, stored)
  if (own(raw, 'threshold')) {
    if (typeof raw.threshold !== 'number' || !Number.isFinite(raw.threshold) || raw.threshold < 0 || raw.threshold > 1) fail(stored)
    out.threshold = raw.threshold
  }
  if (own(raw, 'headers')) out.headers = headerValues(raw.headers, stored)
  return out
}

function activeRef(value, stored) {
  if (value === null || (stored && typeof value !== 'string')) return null
  const ref = text(value, 610, stored)
  const colon = ref.indexOf(':')
  if (colon < 1) fail(stored)
  providerId(ref.slice(0, colon), stored)
  modelId(ref.slice(colon + 1), stored)
  return ref
}

function getModels(value, stored) {
  const raw = record(value, modelKeys, stored)
  const out = {}
  if (own(raw, 'providers')) out.providers = unique(list(raw.providers, MAX_PROVIDERS, stored)
    .map(provider => getProvider(provider, stored)), stored)
  if (own(raw, 'activeModelId')) out.activeModelId = activeRef(raw.activeModelId, stored)
  if (own(raw, 'activeEffort')) out.activeEffort = selected(raw.activeEffort, efforts, stored)
  return out
}

function appearance(key, value, stored) {
  switch (key) {
    case 'theme': return selected(value, themes, stored)
    case 'locale': return selected(value, locales, stored)
    case 'chatFontSize': return selected(value, fontSizes, stored)
    case 'closeToTray': return boolean(value, stored)
    case 'layout': return getLayout(value, stored)
    case 'models': return getModels(value, stored)
    default: return fail(stored)
  }
}

export function section(value, stored = false) {
  const raw = record(value, topKeys, stored)
  const out = {}
  for (const name of topKeys) if (own(raw, name)) out[name] = appearance(name, raw[name], stored)
  return out
}

export function hydrate(models = {}) {
  const saved = models.providers ?? []
  const ids = new Set(saved.map(provider => provider.id))
  return {
    providers: [...saved, ...freshSeeds().filter(provider => !ids.has(provider.id))],
    activeModelId: models.activeModelId ?? null,
    activeEffort: models.activeEffort ?? 'default'
  }
}

export function assertRevision(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(false)
  return value
}

export function patchInput(input) {
  const request = record(input, ['set', 'unset', 'revision'])
  const set = own(request, 'set') ? section(request.set) : {}
  const unset = own(request, 'unset') ? list(request.unset, 12, false) : []
  const seen = new Set()
  for (const key of unset) {
    if (typeof key !== 'string') fail(false)
    const [first, second, extra] = key.split('.')
    if (!topKeys.includes(first) || (second !== undefined && (extra !== undefined ||
        !(first === 'layout' ? layoutKeys : first === 'models' ? modelKeys : []).includes(second))) ||
        seen.has(key) || (second === undefined ? own(set, first) : own(set[first] ?? {}, second))) fail(false)
    seen.add(key)
  }
  for (const key of seen) if (key.includes('.') && seen.has(key.split('.')[0])) fail(false)
  const changesProviders = own(set.models ?? {}, 'providers') || seen.has('models') || seen.has('models.providers')
  const revision = request.revision === undefined ? undefined : assertRevision(request.revision)
  if (changesProviders && revision === undefined) throw new SettingsError('REVISION_REQUIRED')
  return { set, unset: seen, revision, changesProviders }
}

export function validateApiKey(value) {
  if (typeof value !== 'string' || value.length > 8192 || (value !== '' &&
      (!/^[\x20-\x7e]+$/.test(value) || value.trim() !== value || value === HEADER_MASK))) fail(false)
  return value
}
