import { createHash } from 'node:crypto'
import { ATTACH_TEXT_PREFIX, estimateTokens, modelMessages } from '../../dist/chat-core.mjs'
import { HttpError } from '../http/policy.mjs'
import { splitModel } from './session-preferences.mjs'

export const USAGE_META = '_devaHeadlessConversationUsage'
const adapters = new Set(['openai', 'responses', 'anthropic'])
const unavailable = Object.freeze({ modelRef: null, usage: null, source: 'unavailable', compaction: 'inactive' })
const positiveInt = n => Number.isSafeInteger(n) && n > 0
const digestMessages = messages => createHash('sha256').update(JSON.stringify(messages)).digest('hex')
const isPromise = value => typeof value?.then === 'function'

function authenticate(verifyOwner, sid) {
  if (verifyOwner === undefined) return
  const result = verifyOwner(sid)
  if (isPromise(result)) void Promise.resolve(result).catch(() => {})
  if (result !== true) throw new HttpError(401, 'auth')
}

function modelInfo(value, ref) {
  if (!value || !positiveInt(value.contextWindow) || !adapters.has(value.adapter)) return null
  const { modelRef, modelId, contextWindow, adapter } = value
  try {
    if ((ref !== null && ref !== modelRef) || splitModel(modelRef).modelId !== modelId) return null
  } catch { return null }
  return { modelRef, contextWindow, adapter }
}

function matchingModel(a, b) {
  return a?.modelRef === b.modelRef && a?.adapter === b.adapter
}

// Resolve a model only once; retry the *local* projection if that read outlived a
// native transcript change or if history changed during a potentially large estimate.
// Never pair an older input count or selected model with an unverified newer history.
function finishConversationUsage({ sid, view, start, model, requested, active, refresh, check }) {
  for (let attempt=0;attempt<2;attempt++) {
    check()
    view=refresh(sid,view)
    const now=selection(view)
    const changed=now.ownerLayout!==start.ownerLayout || now.createdAt!==start.createdAt || now.pin!==start.pin || now.role!==start.role
    const report=changed || !model || (requested!==null && requested!==model.modelRef) ? unavailable : projection(view,model,active(sid))
    const confirmed=refresh(sid,view)
    check()
    if(confirmed===view) return report
    view=confirmed
  }
  throw new HttpError(409,'read_unavailable')
}

export function captureConversationUsage(slot, input, notify) {
  if (!slot.record || !slot.model || !adapters.has(slot.model.adapter) || !positiveInt(input) || input === slot.inputTokens) return
  slot.inputTokens = input
  notify()
}

export function conversationUsagePatch(slot, messages, updatedAt) {
  if (!positiveInt(slot.inputTokens)) return null
  const { session, record, model, inputTokens } = slot
  return {
    lastInputTokens: inputTokens,
    [USAGE_META]: {
      version: 1, sessionId: session.id, turnId: record.turnId, modelRef: model.modelRef, adapter: model.adapter,
      updatedAt, inputTokens, digest: digestMessages(messages)
    }
  }
}

function recordedInput(s, last, model) {
  const meta = s[USAGE_META]
  if (!meta || Object.keys(meta).length !== 8 || meta.version !== 1 || meta.sessionId !== s.id || !last || last.status === 'running' ||
      meta.turnId !== last.turnId || meta.updatedAt !== s.updatedAt || !matchingModel(meta, model) ||
      !positiveInt(s.lastInputTokens) || s.lastInputTokens !== meta.inputTokens ||
      (Object.hasOwn(last, 'model') && last.model !== meta.modelRef) || meta.digest !== digestMessages(s.messages)) return null
  return s.lastInputTokens
}

function estimate(s, attachmentIndex) {
  if (!attachmentIndex) return estimateTokens(modelMessages(s.messages))
  let approximateText = 0
  const messages = s.messages.map((message, index) => {
    const row = attachmentIndex.byMessage.get(index)
    if (!row) return message
    const content = message.content.map((part, at) => {
      const attachment = row.items[at]
      // Native image/PDF costs are already charged by their part types. Text blob bytes
      // supply only an approximate character count; include the original text-part framing.
      if (attachment?.kind !== 'text') return part
      approximateText += attachment.size / 3.5
      return { type: 'text', text: `${ATTACH_TEXT_PREFIX}${attachment.name}\n\`\`\`\n\n\`\`\`` }
    })
    return { role: message.role, content }
  })
  return Math.round(estimateTokens(modelMessages(messages)) + approximateText)
}

function projection(view, model, slot) {
  const { session, layout } = view
  const usage = (source, used, estimated = false) => ({
    modelRef: model.modelRef, usage: { used, estimated, window: model.contextWindow, trigger: null }, source, compaction: 'inactive'
  })
  if (slot && slot.session.id === session.id && slot.record && slot.record.turnId === layout.last?.turnId && layout.last.status === 'running' &&
      matchingModel(slot.model, model) && positiveInt(slot.inputTokens)) return usage('live', slot.inputTokens)
  const measured = !slot && layout.owned ? recordedInput(session, layout.last, model) : null
  if (measured !== null) return usage('measured', measured)
  if (!layout.eligible) return usage('none', null)
  return usage('estimate', estimate(session, layout.attachments), true)
}

const selection = ({ session, layout }) => ({
  ownerLayout: layout.owned,
  createdAt: session.createdAt,
  pin: typeof session.model === 'string' && session.model ? session.model : null,
  role: layout.owned ? session.personaId : undefined
})

/** A non-null request is a guard on the authoritative pin / role / global model, not an override. */
export function createConversationUsage({ settings, read, refresh, active, roleForTurn }) {
  return async function contextUsage(sid, input, verifyOwner) {
    authenticate(verifyOwner, sid)
    const item = input && Object.getOwnPropertyDescriptor(input, 'model')
    if (!item?.enumerable || !Object.hasOwn(item, 'value') || Reflect.ownKeys(input).length !== 1) {
      throw new HttpError(400, 'invalid_context_request')
    }
    const requested = item.value
    if (requested !== null) splitModel(requested)
    const view = read(sid)
    const start = selection(view)
    const finish = model => finishConversationUsage({sid,view,start,model,requested,active,refresh,
      check:()=>authenticate(verifyOwner,sid)})
    if (typeof settings.getContextModel !== 'function') return finish(null)
    let effective = start.pin
    if (!effective && start.role !== undefined) {
      let role
      try { role = await roleForTurn(start.role) } catch { /* unusable role remains unavailable */ }
      finally { authenticate(verifyOwner, sid) }
      if (!role) return finish(null)
      effective = role.model || null
    }
    if (effective !== null) {
      try { splitModel(effective) } catch { return finish(null) }
      if (requested !== null && requested !== effective) return finish(null)
    }
    let config, awaited = false
    try {
      config = settings.getContextModel(effective)
      if (isPromise(config)) {
        awaited = true
        config = await config
      }
    } catch { config = null }
    finally { if (awaited) authenticate(verifyOwner, sid) }
    return finish(modelInfo(config, effective))
  }
}
