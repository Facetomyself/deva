import { createHash, randomUUID } from 'node:crypto'
import { setImmediate as nextTick } from 'node:timers/promises'
import { consumeModelStep, createChatStore, isValidSessionId, modelMessages } from '../../dist/chat-core.mjs'
import { connectProvider } from '../business/model-connection.mjs'
import { chatScope } from '../events/index.mjs'
import { HttpError } from '../http/policy.mjs'
import { confirmPreferenceStorage, preflightPreferenceStorage } from './session-preferences-storage.mjs'
import {
  PREFERENCES_META, checkPreferenceRevision, firstTitle, listPreferenceFields, managedModel, preferenceChanges,
  preferenceView, readPreferencePatch, resolveTurnModel, splitModel, unsupportedEffort, validPreferenceFields, validatePreferenceModel
} from './session-preferences.mjs'
import { ATTACHMENT_META, attachmentIds, createTurnAttachments } from './turn-attachments.mjs'

const META = '_devaHeadlessTextTurns'
const MAX_REQUESTS = 256 // Never evict an accepted ID and later interpret its retry as a fresh request.
const MAX_ACTIVE = 8
const MAX_TEXT_BYTES = 12 * 1024
const MAX_OUTPUT = 64 * 1024 // UTF-16 code units, per text/thinking channel.
const MAX_TURN_MS = 5 * 60 * 1000
const DELTA_SIZE = 2048
const SYSTEM = 'You are a helpful general-purpose assistant. Reply in plain text.'
const ROLE_SYSTEM = `${SYSTEM} Persona context is optional user-level guidance for tone and presentation only.`
const MAX_ROLE_BYTES = 128 * 1024 // At most one library role file's worth of text.
const outputLimit = Symbol('output limit')
const modelError = Symbol('model failure')
const publicModelErrors = new Map([['provider_not_found', 404], ['not_chat_provider', 422], ['model_not_enabled', 422]])
const terminalReasons = new Map([
  ['completed', new Set([null, 'empty', 'truncated', 'refusal', 'repeated'])],
  ['aborted', new Set(['stopped', 'shutdown'])],
  ['failed', new Set(['model_failed', 'unexpected_tool', 'timeout'])],
  ['interrupted', new Set(['interrupted'])]
])
const nativeTextFields = new Set([
  'id', 'title', 'createdAt', 'updatedAt', 'focusRoot', 'personaId', 'model', 'messages', 'notices',
  'archived', 'effort', META, PREFERENCES_META
])
const complexFields = [
  'compacted', 'members', 'parentId', 'proposals', 'asks', 'summaries', 'delivered', 'background',
  'durations', 'plans', 'autotasks', 'todos', 'todoCancelled', 'todoCancelNote', 'checkpoints', 'lastKnown',
  'baselines', 'restoreNote'
]

const validSid = id => isValidSessionId(id) && id.length <= 128 // The journal has a narrower ID range.
const desktopSid = /^sess_[0-9a-z]{1,12}_[0-9a-z]{1,8}$/
const uuidSid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const validRequestId = id => typeof id === 'string' && id.length > 0 && id.length <= 128 && !/[^A-Za-z0-9_-]/.test(id)
const validTime = n => Number.isSafeInteger(n) && n >= 0
const storageError = () => new HttpError(503, 'chat_storage_unconfirmed')
const closedError = () => new HttpError(503, 'chat_closed')
const roleUnavailable = () => new HttpError(409, 'role_unavailable')
const roleServiceError = () => new HttpError(503, 'chat_role_unavailable')
const roleId = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u
const reservedRole = new Set(['constructor', 'prototype', '__proto__', ...Object.getOwnPropertyNames(Object.prototype).map(key => key.toLowerCase())])

export function isChatRoleId(id) {
  return typeof id === 'string' && roleId.exec(id)?.[0] === id && !id.endsWith('.') && !id.includes('..') &&
    !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(id) && !reservedRole.has(id.toLowerCase()) &&
    (id === 'general' || id.toLowerCase() !== 'general')
}

function checkedRole(role, expectedId) {
  if (role == null) throw roleUnavailable()
  if (typeof role !== 'object' || Array.isArray(role)) throw roleServiceError()
  const { id, enabled, name, prompt, model } = role
  if (!isChatRoleId(id) || (expectedId !== undefined && id !== expectedId)) throw roleServiceError()
  if (enabled === false) throw roleUnavailable()
  if (enabled !== true || typeof name !== 'string' || !name.trim() || typeof prompt !== 'string' ||
      name.length + prompt.length > MAX_ROLE_BYTES || Buffer.byteLength(name) + Buffer.byteLength(prompt) > MAX_ROLE_BYTES ||
      !name.isWellFormed() || !prompt.isWellFormed() || (model !== undefined && typeof model !== 'string')) throw roleServiceError()
  return { id, name, prompt, model }
}

function turnMessages(messages, role) {
  const visible = modelMessages(messages)
  if (!role) return visible
  // Add context to the current user message only; it is neither history nor an instruction channel.
  const user = visible.at(-1)
  return [...visible.slice(0, -1), { role: 'user', content: [
    { type: 'text', text: `Optional persona context (tone and presentation):\n${JSON.stringify({ name: role.name, prompt: role.prompt })}\n\nUser request:` },
    ...user.content
  ] }]
}

function inputRecord(input, keys, code) {
  if (!input || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new HttpError(400, code)
  const ownKeys = Reflect.ownKeys(input)
  const fields = Object.create(null)
  if (ownKeys.length !== keys.length) throw new HttpError(400, code)
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new HttpError(400, code)
    fields[key] = descriptor.value
  }
  return fields
}

function createInput(input) {
  if (input === undefined) return randomUUID()
  if (!input || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new HttpError(400, 'invalid_create')
  if (Reflect.ownKeys(input).length === 0) return randomUUID()
  const { sessionId } = inputRecord(input, ['sessionId'], 'invalid_create')
  if (!validSid(sessionId) || !(desktopSid.test(sessionId) || uuidSid.test(sessionId))) {
    throw new HttpError(400, 'invalid_session_id')
  }
  return sessionId
}

function sendInput(input, supportsAttachments) {
  const keys = ['sid', 'clientRequestId', 'text', 'model']
  if (supportsAttachments && input && Object.hasOwn(input, 'attachments')) keys.push('attachments')
  const fields = inputRecord(input, keys, 'invalid_send')
  const { sid, clientRequestId, text, model } = fields
  if (!validSid(sid)) throw new HttpError(400, 'invalid_session_id')
  if (!validRequestId(clientRequestId)) throw new HttpError(400, 'invalid_client_request_id')
  const attachments = Object.hasOwn(fields, 'attachments') ? attachmentIds(fields.attachments) : undefined
  if (typeof text !== 'string' || text.length > MAX_TEXT_BYTES || (!attachments?.length && !text.trim()) || Buffer.byteLength(text) > MAX_TEXT_BYTES) {
    throw new HttpError(400, 'invalid_text')
  }
  if (model !== null) splitModel(model)
  // Preserve existing receipts byte-for-byte. A null model records the intention to follow current defaults.
  const fingerprint = createHash('sha256').update(JSON.stringify(attachments?.length ? [model, text, attachments] : [model, text])).digest('hex')
  return { sid, clientRequestId, text, model, fingerprint, attachments }
}

function plainText(content) {
  if (typeof content === 'string') return /^⟦deva:(compaction|auto)⟧/.test(content) ? null : content
  if (!content.length || content.some(p => p.type !== 'text' || typeof p.text !== 'string')) return null
  return content.map(p => p.text).join('\n')
}

function validNotices(s) {
  if (s.notices === undefined) return true
  const codes = ['aborted', 'empty', 'truncated', 'refused', 'repeated']
  return Array.isArray(s.notices) && s.notices.length <= MAX_REQUESTS && s.notices.every(n =>
    n && validTime(n.after) && n.after <= s.messages.length && (
      (n.kind === 'error' && n.message === '模型回复未能完成。') || (n.kind === 'notice' && codes.includes(n.code))
    ))
}

function validLedger(value, messageCount) {
  const rows = value?.requests
  if (value?.version !== 1 || value.messageCount !== messageCount ||
      !Array.isArray(rows) || rows.length > MAX_REQUESTS || rows.length > messageCount || messageCount > 2 * rows.length) return false
  const ids = new Set()
  const turns = new Set()
  return rows.every((row, i) => {
    if (!row || !validRequestId(row.clientRequestId) || typeof row.fingerprint !== 'string' ||
        row.fingerprint.length !== 64 || /[^0-9a-f]/.test(row.fingerprint) || !validSid(row.turnId) || !validTime(row.startedAt) ||
        ids.has(row.clientRequestId) || turns.has(row.turnId)) return false
    ids.add(row.clientRequestId)
    turns.add(row.turnId)
    return row.status === 'running' ? i === rows.length - 1 && row.reason === null : terminalReasons.get(row.status)?.has(row.reason)
  })
}

function result(record) {
  const { turnId, startedAt, status, reason } = record
  return { turnId, startedAt, status, reason }
}

function interrupted(record) {
  return { ...record, status: 'interrupted', reason: 'interrupted' }
}

function disposition(step, signal) {
  if (signal.aborted && signal.reason === 'timeout') return ['failed', 'timeout', 'error']
  if (signal.aborted || step?.aborted) return ['aborted', signal.reason === 'shutdown' ? 'shutdown' : 'stopped', 'aborted']
  if (step?.rejectedToolCall || step?.stopReason === 'tool_use') return ['failed', 'unexpected_tool', 'error']
  if (step?.repetition) return ['completed', 'repeated', 'repeated']
  if (step?.stopReason === 'max_tokens') return ['completed', 'truncated', 'max_tokens']
  if (step?.stopReason === 'refusal') return ['completed', 'refusal', 'refusal']
  if (step && ['end_turn', 'stop'].includes(step.stopReason)) {
    return ['completed', step.assistantText.trim() ? null : 'empty', step.stopReason]
  }
  return ['failed', 'model_failed', 'error']
}

function appendNotice(notices, after, status, reason, text) {
  if (status === 'failed') return [...notices, { after, kind: 'error', message: '模型回复未能完成。' }]
  const code = status === 'aborted' || status === 'interrupted' ? 'aborted'
    : reason === 'refusal' ? (text.trim() ? null : 'refused')
      : ['empty', 'truncated', 'repeated'].includes(reason) ? reason : null
  return code ? [...notices, { after, kind: 'notice', code }] : notices
}

/** One instance per data directory and journal. The owner closes the journal after awaiting close().
 * resolveRole only reads trusted library state and returns the current enabled role projection. */
export function createTextTurns({ dataDir, settings, journal, version, allowedOrigins, resolveRole, uploads }) {
  if (typeof settings?.getProvider !== 'function' || !['snapshot', 'snapshotAndSubscribe', 'publishChat', 'publishSessionsChanged']
    .every(fn => typeof journal?.[fn] === 'function')) throw new TypeError('Text turns require settings and an event journal')
  if (resolveRole !== undefined && typeof resolveRole !== 'function') throw new TypeError('resolveRole must be a function')
  const attachments = uploads === undefined ? undefined : createTurnAttachments({ dataDir, uploads })
  let warned = false
  const incomplete = new WeakSet()
  const mediaUnconfirmed = new WeakSet()
  const classifications = new WeakMap()
  const store = createChatStore({
    dataDir, onWarning() { warned = true },
    // Keep native blob refs in the cache. Only a selected turn or preview reads media bytes.
    media: { hydrateMessages() {}, mediaReplacer: (_key, value) => value }
  })
  const active = new Map()
  const unconfirmed = new Map() // Quarantine ambiguous writes until restart; never replay a charged request.
  const hidden = new Set() // A failed create may leave a session only in the core's cache.
  let closing

  function lookupSession(sid) {
    warned = false
    const s = hidden.has(sid) ? undefined : store.getSession(sid)
    if (s && warned) incomplete.add(s)
    return s
  }

  function getSession(sid) {
    if (!validSid(sid)) throw new HttpError(400, 'invalid_session_id')
    const s = lookupSession(sid)
    if (!s) throw new HttpError(404, 'session_not_found')
    return s
  }

  function attachedIndex(s) {
    return attachments && s[ATTACHMENT_META] && attachments.index(s, s[META].requests)
  }

  function compatibility(s) {
    if (s[ATTACHMENT_META] !== undefined) {
      return attachments && !incomplete.has(s) && s.focusRoot == null &&
        (s.personaId === undefined || isChatRoleId(s.personaId)) && validLedger(s[META], s.messages.length) && validNotices(s) &&
        validPreferenceFields(s) &&
        Object.keys(s).every(key => s[key] === undefined || key === ATTACHMENT_META || nativeTextFields.has(key)) &&
        attachedIndex(s) ? 'text' : 'unsupported'
    }
    if (classifications.has(s)) return classifications.get(s)
    const owns = Object.hasOwn(s, META)
    const complex = incomplete.has(s) || complexFields.some(key => {
      const value = s[key]
      return value && (typeof value !== 'object' || Object.keys(value).length)
    }) || s.messages.some(m => plainText(m.content) === null)
    const legacyNotices = !owns && s.notices !== undefined && (!Array.isArray(s.notices) || s.notices.length > 0)
    const kind = complex || legacyNotices || (owns && (
      !validLedger(s[META], s.messages.length) || !validNotices(s) || !validPreferenceFields(s) || s.focusRoot != null ||
      (s.personaId !== undefined && !isChatRoleId(s.personaId)) ||
      Object.keys(s).some(key => s[key] !== undefined && !nativeTextFields.has(key))
    )) ? 'unsupported' : owns ? 'text' : 'legacy_text'
    classifications.set(s, kind)
    return kind
  }

  function summary(s, kind = compatibility(s)) {
    const index = kind === 'text' && attachedIndex(s)
    if (index && (mediaUnconfirmed.has(s) || !attachments.available(index))) kind = 'unsupported'
    let writeBlockReason = null
    if (kind === 'unsupported') writeBlockReason = 'unsupported_history'
    else if (kind !== 'text') writeBlockReason = 'read_only_session'
    else if (closing) writeBlockReason = 'chat_closed'
    else if (unconfirmed.has(s.id)) writeBlockReason = 'chat_storage_unconfirmed'
    else if (s[META].requests.length >= MAX_REQUESTS) writeBlockReason = 'session_turn_limit'
    return {
      id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt,
      ...(isChatRoleId(s.personaId) ? { personaId: s.personaId } : {}),
      model: kind === 'text' && typeof s.model === 'string' && s.model ? s.model : null,
      ...listPreferenceFields(s),
      compatibility: kind, writable: writeBlockReason === null, writeBlockReason,
      turnLimit: kind === 'text' ? MAX_REQUESTS : null
    }
  }

  function create(input, trustedRole) {
    if (closing) throw closedError()
    const id = createInput(input)
    const role = trustedRole === undefined ? undefined : checkedRole(trustedRole)
    if (role && !resolveRole) throw roleServiceError()
    if (hidden.has(id)) throw storageError()
    const existing = lookupSession(id)
    if (existing) {
      if (compatibility(existing) !== 'text' || (role && existing.personaId !== role.id)) {
        throw new HttpError(409, 'session_id_conflict')
      }
      return summary(existing)
    }
    let s
    try {
      s = store.ensureSession(id, role ? { personaId: role.id, model: role.model || undefined } : undefined)
      s[META] = { version: 1, messageCount: 0, requests: [] }
      store.saveStrict(id)
    } catch {
      hidden.add(id)
      throw storageError()
    }
    publishSessionsChanged()
    return summary(s)
  }

  function list() {
    let entries
    try { entries = store.listSessions() } catch { throw storageError() }
    return entries.filter(s => validSid(s.id) && !hidden.has(s.id)).map(meta => {
      try { return summary(getSession(meta.id)) }
      catch { return summary(meta, 'unsupported') }
    })
  }

  function preferencesSession(sid) {
    if (closing) throw closedError()
    if (!validSid(sid)) throw new HttpError(400, 'invalid_session_id')
    if (unconfirmed.has(sid) || hidden.has(sid)) throw storageError()
    const exists = preflightPreferenceStorage(dataDir, sid)
    const s = lookupSession(sid)
    if (!exists && !s) throw new HttpError(404, 'session_not_found')
    if (!exists || !s) throw storageError()
    const kind = compatibility(s)
    if (kind === 'legacy_text') throw new HttpError(409, 'read_only_session')
    if (kind !== 'text') throw new HttpError(409, 'unsupported_history')
    const index = attachedIndex(s)
    if (index && (mediaUnconfirmed.has(s) || !attachments.available(index))) throw new HttpError(409, 'unsupported_history')
    return s
  }

  function getPreferences(sid) {
    const s = preferencesSession(sid)
    confirmPreferenceStorage(dataDir, s)
    return preferenceView(s, s[META].requests.length)
  }

  function firstUser(s) {
    const at = s.messages.findIndex(m => m.role === 'user')
    if (at < 0) return null
    const message = s.messages[at]
    const row = attachedIndex(s)?.byMessage.get(at)
    return row ? attachments.snapshot(message, row) : { content: plainText(message.content) }
  }

  async function patchPreferences(sid, input, verifyOwner) {
    const { revision, set, model } = readPreferencePatch(input)
    function checkedCurrent() {
      if (active.has(sid)) throw new HttpError(409, 'turn_in_progress')
      const s = preferencesSession(sid)
      checkPreferenceRevision(revision, preferenceView(s, s[META].requests.length).revision)
      return s
    }
    checkedCurrent()
    if (set.effort != null && set.effort !== 'default') throw unsupportedEffort()
    // The settings lookup can outlive the login. Recheck even when validation itself fails.
    try { if (model) await validatePreferenceModel(settings, model) }
    finally { verifyOwner?.() }
    // A competing editor or turn can also have committed while the lookup awaited. Nothing awaits from here.
    const s = checkedCurrent()
    confirmPreferenceStorage(dataDir, s, true)
    const previous = preferenceView(s, s[META].requests.length).preferences
    const wasManaged = managedModel(s)
    const patch = preferenceChanges(s, set, () => firstUser(s))
    commit(s, patch, null, () => confirmPreferenceStorage(dataDir, s))
    const after = preferenceView(s, s[META].requests.length)
    if (wasManaged !== managedModel(s) || Object.keys(previous).some(key => previous[key] !== after.preferences[key])) {
      publishSessionsChanged()
    }
    return after
  }

  function readState(s) {
    const base = summary(s)
    const slot = active.get(s.id)
    const running = slot?.record
    const last = base.compatibility === 'text' ? s[META].requests.at(-1) : null
    const terminal = unconfirmed.get(s.id) ?? last
    const index = base.compatibility === 'text' && attachedIndex(s)
    return {
      ...base,
      messages: base.compatibility === 'unsupported' ? null : s.messages.map((m, i) => {
        const row = index && index.byMessage.get(i)
        return row ? attachments.snapshot(m, row) : { role: m.role, content: plainText(m.content) }
      }),
      active: running ? { turnId: running.turnId, startedAt: running.startedAt, text: slot.text } : null,
      lastTurn: terminal ? result(terminal.status === 'running' && !running ? interrupted(terminal) : terminal) : null
    }
  }

  function snapshot(sid) {
    const s = getSession(sid)
    return journal.snapshot(chatScope(sid), () => readState(s))
  }

  function attach(sid, callbacks) {
    if (callbacks === undefined) return snapshot(sid)
    const s = getSession(sid)
    return journal.snapshotAndSubscribe(chatScope(sid), () => readState(s), callbacks)
  }

  function attachmentScope(sid) {
    if (!attachments || !validSid(sid)) return null
    const s = lookupSession(sid)
    if (!s) return null
    return { writable: summary(s).writable && attachments.canStage(attachedIndex(s)) }
  }

  function describeCommittedAttachment(sid, id) {
    if (!attachments || !validSid(sid)) return null
    const s = lookupSession(sid)
    if (!s || compatibility(s) !== 'text') return null
    const item = attachedIndex(s)?.byId.get(id)
    if (!item) return null
    const { name, kind, mime, size } = item
    return { id, name, kind, mime, size }
  }

  function readCommittedAttachment(sid, id) {
    if (!attachments || !validSid(sid)) return null
    const s = lookupSession(sid)
    if (!s || compatibility(s) !== 'text') return null
    const index = attachedIndex(s)
    const committed = attachments.preview(index, id)
    if (!committed && index?.byId.has(id)) mediaUnconfirmed.add(s)
    return committed
  }

  function publishSessionsChanged() {
    try { journal.publishSessionsChanged() } catch { /* invalidate on the next client snapshot */ }
  }

  function publish(slot, event) {
    try { journal.publishChat({ sessionId: slot.session.id, turnId: slot.record.turnId, event }) }
    catch { /* a journal fault does not change the outcome of the confirmed store write */ }
  }

  function priorResult(record, fingerprint) {
    if (record.fingerprint !== fingerprint) throw new HttpError(409, 'client_request_conflict')
    return { ...result(record), duplicate: true }
  }

  // On a strict-save failure the main JSON might already be published, with only its index repair failing.
  // Restore the last confirmed in-memory view, block further mutation here, and let the next process read disk.
  function commit(s, patch, terminal = null, verify) {
    const before = new Map(Object.keys(patch).map(key => [key, Object.getOwnPropertyDescriptor(s, key)]))
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete s[key]
      else s[key] = value
    }
    try { store.saveStrict(s.id); verify?.() }
    catch {
      for (const [key, descriptor] of before) {
        if (descriptor) Object.defineProperty(s, key, descriptor)
        else delete s[key]
      }
      unconfirmed.set(s.id, terminal)
      throw storageError()
    }
  }

  async function roleForTurn(id) {
    if (!resolveRole) throw roleServiceError()
    let role
    try { role = checkedRole(await resolveRole(id), id) } catch (err) {
      if (closing) throw closedError()
      // Only the explicit unavailable code crosses the lookup boundary; other errors may contain private details.
      if (err instanceof HttpError && err.status === 409 && err.code === 'role_unavailable') throw roleUnavailable()
      throw roleServiceError()
    }
    if (closing) throw closedError()
    return role
  }

  async function admit(slot, input) {
    const { session: s, controller } = slot
    // Only fresh requests reach admission; retries use the durable ledger before inspecting the role or drafts.
    const previous = attachedIndex(s)
    const withMedia = previous || input.attachments?.length
    if (previous && (mediaUnconfirmed.has(s) || !attachments.available(previous))) {
      throw new HttpError(409, 'unsupported_history')
    }
    const role = s.personaId === undefined ? undefined : await roleForTurn(s.personaId)
    if (s.effort !== undefined && s.effort !== 'default') throw unsupportedEffort()
    const model = await resolveTurnModel(settings, s, role, input.model)
    const { providerId, modelId } = splitModel(model)
    let client, adapter
    // Capture the adapter from the same trusted provider snapshot that binds credentials, model and URL.
    const binding = withMedia ? { async getProvider(id) {
      const provider = await settings.getProvider(id)
      if (provider == null) return provider
      adapter = provider.adapter
      return { ...provider, adapter }
    } } : settings
    try {
      client = await connectProvider(binding, providerId, { version, allowedOrigins, signal: controller.signal, modelId })
    } catch (err) {
      if (closing) throw closedError()
      const knownStatus = err instanceof HttpError ? publicModelErrors.get(err.code) : undefined
      throw knownStatus ? new HttpError(knownStatus, err.code) : new HttpError(503, 'chat_model_unavailable')
    }
    if (closing) throw closedError()
    const record = {
      clientRequestId: input.clientRequestId, fingerprint: input.fingerprint,
      ...(input.model === null || managedModel(s) ? { model } : {}),
      turnId: randomUUID(), startedAt: Date.now(), status: 'running', reason: null
    }
    const requests = [...s[META].requests]
    let notices = s.notices ?? []
    if (requests.at(-1)?.status === 'running') {
      requests[requests.length - 1] = interrupted(requests.at(-1))
      notices = appendNotice(notices, s.messages.length, 'interrupted', 'interrupted', '')
    }
    requests.push(record)
    let prepared
    if (withMedia) {
      try { prepared = await attachments.prepare(s, input, adapter, record, previous, requests) }
      catch (err) {
        if (previous && err instanceof HttpError && err.code === 'unsupported_history') mediaUnconfirmed.add(s)
        throw err
      }
      if (closing) throw closedError()
    }
    prepared?.persist?.() // Publish immutable media before the confirmed JSON and before streamChat.
    // Native text part avoids interpreting a literal desktop compaction/auto marker as metadata.
    const messages = prepared?.messages ?? [...s.messages, { role: 'user', content: [{ type: 'text', text: input.text }] }]
    const itemNames = prepared?.patch[ATTACHMENT_META]?.rows.at(-1)?.items.map(item => item.name)
    const title = s.title || firstTitle(input.text, itemNames)
    const modelPatch = managedModel(s) ? {} : input.model === null
      ? preferenceChanges(s, { model: null }, () => null) : { model }
    const modelChanged = Object.hasOwn(modelPatch, 'model') && (modelPatch.model || null) !== (s.model || null)
    const listChanged = title !== s.title || modelChanged || record.startedAt !== s.updatedAt || requests.length === MAX_REQUESTS
    commit(s, {
      ...modelPatch, messages, notices, title, updatedAt: record.startedAt,
      [META]: { version: 1, messageCount: messages.length, requests }, ...prepared?.patch
    })
    slot.record = record
    publish(slot, { type: 'turn_start' })
    if (listChanged) publishSessionsChanged()
    // The session now owns durable bytes. Retire spent draft reservations after commit,
    // never before: a failed save must keep the user's files available for a retry.
    if (input.attachments?.length && typeof uploads?.remove === 'function') {
      await Promise.allSettled(input.attachments.map(id => Promise.resolve().then(() => uploads.remove(s.id, id))))
    }
    return { client, record, role, modelContext: prepared?.modelContext }
  }

  function streamText(slot, delta) {
    if (slot.controller.signal.aborted || typeof delta !== 'string') throw modelError
    let end = Math.min(delta.length, MAX_OUTPUT - slot.text.length)
    if (end < delta.length && /[\uD800-\uDBFF]/.test(delta[end - 1] ?? '')) end--
    for (let i = 0; i < end;) {
      let pieceEnd = Math.min(i + DELTA_SIZE, end)
      if (pieceEnd < end && /[\uD800-\uDBFF]/.test(delta[pieceEnd - 1])) pieceEnd--
      const text = delta.slice(i, pieceEnd)
      slot.text += text // Live snapshot projection; shared reducer still owns normal step output/termination.
      publish(slot, { type: 'text_delta', text })
      i = pieceEnd
    }
    if (end < delta.length) throw outputLimit
  }

  async function run(slot, client, role, modelContext) {
    const { session: s, controller, record } = slot
    const clock = setTimeout(() => controller.abort('timeout'), MAX_TURN_MS)
    clock.unref()
    let step
    let truncated = false
    try {
      // Leave a cancellation point between the strict commit/ACK and starting an upstream request.
      await nextTick()
      if (!controller.signal.aborted) {
        let thinkingSize = 0
        const events = client.streamChat({
          system: role ? ROLE_SYSTEM : SYSTEM, messages: turnMessages(modelContext ?? s.messages, role), tools: [], maxTokens: 4096,
          sessionId: s.id, signal: controller.signal
        })
        step = await consumeModelStep(events, {
          signal: controller.signal,
          onTextDelta: delta => streamText(slot, delta),
          onThinkingDelta(delta) {
            if (typeof delta !== 'string') throw modelError
            if ((thinkingSize += delta.length) > MAX_OUTPUT) throw outputLimit
          },
          onError() { throw modelError }
          // No tool callbacks: the shared consumer closes at the first normalized tool call.
        })
      }
    } catch (err) { truncated = err === outputLimit }
    finally { clearTimeout(clock) }

    let [status, reason, stopReason] = truncated && !controller.signal.aborted
      ? ['completed', 'truncated', 'max_tokens'] : disposition(step, controller.signal)
    const text = step?.assistantText ?? slot.text
    const messages = text ? [...s.messages, { role: 'assistant', content: [{ type: 'text', text }] }] : s.messages
    const notices = appendNotice(s.notices ?? [], messages.length, status, reason, text)
    const ended = { ...record, status, reason }
    try {
      const index = attachedIndex(s)
      if (index && (mediaUnconfirmed.has(s) || !attachments.available(index))) throw storageError()
      const updatedAt = Date.now()
      const listChanged = updatedAt !== s.updatedAt
      commit(s, {
        messages, notices, updatedAt,
        [META]: { version: 1, messageCount: messages.length, requests: [...s[META].requests.slice(0, -1), ended] }
      }, { ...record, status: 'failed', reason: 'storage_unconfirmed' })
      if (listChanged) publishSessionsChanged()
    } catch {
      status = 'failed'
      stopReason = 'error'
    } finally {
      active.delete(s.id)
    }
    if (status === 'failed') publish(slot, { type: 'error' })
    publish(slot, { type: 'done', stopReason, durationMs: Math.max(0, Date.now() - record.startedAt) })
  }

  async function send(raw) {
    if (closing) throw closedError()
    const input = sendInput(raw, Boolean(attachments))
    const s = getSession(input.sid)
    const kind = compatibility(s)
    if (kind === 'unsupported') throw new HttpError(409, 'unsupported_history')
    if (kind !== 'text') throw new HttpError(409, 'read_only_session')
    if (unconfirmed.has(input.sid)) throw storageError()
    const current = active.get(input.sid)
    const previous = s[META].requests.find(r => r.clientRequestId === input.clientRequestId)
    if (previous) return priorResult(previous.status === 'running' && !current?.record ? interrupted(previous) : previous, input.fingerprint)
    if (current) {
      if (current.clientRequestId !== input.clientRequestId) throw new HttpError(409, 'turn_in_progress')
      if (current.fingerprint !== input.fingerprint) throw new HttpError(409, 'client_request_conflict')
      return priorResult((await current.admission).record, input.fingerprint)
    }
    if (s[META].requests.length >= MAX_REQUESTS) throw new HttpError(409, 'session_turn_limit')
    if (active.size >= MAX_ACTIVE) throw new HttpError(503, 'chat_busy')
    const slot = {
      session: s, clientRequestId: input.clientRequestId, fingerprint: input.fingerprint,
      controller: new AbortController(), text: '', record: null
    }
    active.set(input.sid, slot) // Exclusivity is acquired before the first await, including credential lookup.
    slot.admission = admit(slot, input)
    slot.finished = slot.admission.then(({ client, role, modelContext }) => run(slot, client, role, modelContext), () => { active.delete(input.sid) })
    const { record } = await slot.admission
    return { ...result(record), duplicate: false }
  }

  function stop(raw) {
    const { sid, turnId } = inputRecord(raw, ['sid', 'turnId'], 'invalid_stop')
    if (!validSid(sid)) throw new HttpError(400, 'invalid_session_id')
    if (!validSid(turnId)) throw new HttpError(400, 'invalid_turn_id')
    getSession(sid)
    const slot = active.get(sid)
    if (slot?.record?.turnId !== turnId || slot.controller.signal.aborted) return { stopped: false }
    slot.controller.abort('stopped')
    return { stopped: true }
  }

  function close() {
    if (closing) return closing
    const slots = [...active.values()]
    closing = Promise.allSettled(slots.map(slot => slot.finished)).then(() => {})
    for (const slot of slots) slot.controller.abort('shutdown')
    return closing
  }

  // Human browser sessions are registered only on confirmed workbench conversations. A
  // tab does not change the native conversation or grant browser access to the model.
  function hasBrowserSession(sid) {
    if (closing || !validSid(sid) || unconfirmed.has(sid) || hidden.has(sid)) return false
    const s = lookupSession(sid)
    return !!s && compatibility(s) === 'text'
  }
  return Object.freeze({
    create, list, attach, snapshot, send, stop, close, getPreferences, patchPreferences,
    attachmentScope, describeCommittedAttachment, readCommittedAttachment, hasBrowserSession
  })
}
