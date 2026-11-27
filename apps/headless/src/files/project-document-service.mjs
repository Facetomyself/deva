import { createHash, randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { types } from 'node:util'
import {
  bridgeCode, contentBody, emptyBody, fault, ownData, targetBody, validIntent, validRevision, validWorkspace,
} from './project-document-resources.mjs'

const MAX_PER_LOGIN = 4, MAX_ACTIVE = 16
const ISSUE_WINDOW_MS = 10_000, ISSUE_PER_LOGIN = 12, ISSUE_GLOBAL = 48
const changed = code => code === 'document_exists' || code === 'document_changed'
// These native errors attest that publication did not make the target visible.
const PRE_PUBLICATION = new Set(['document_invalid', 'document_read_only', 'document_unsafe', 'document_limit', 'document_restricted'])
const sameLogin = (a, b) => a.ownerId === b.ownerId && a.loginSessionId === b.loginSessionId
const quietly = action => { try { return action() } catch {} }

function actorIdentity(actor) {
  const role = ownData(actor, 'role'), ownerId = ownData(actor, 'ownerId'), loginSessionId = ownData(actor, 'loginSessionId')
  if (role !== 'owner' || typeof ownerId !== 'string' || !ownerId || typeof loginSessionId !== 'string' || !loginSessionId) throw fault('auth')
  return Object.freeze({ role, ownerId, loginSessionId })
}

// Native publication always gets a literal true, not the caller's auth metadata.
function verificationFailure(verifyOwner) {
  if (typeof verifyOwner !== 'function' || types.isProxy(verifyOwner) || types.isAsyncFunction(verifyOwner)) return 'auth'
  try {
    const result = verifyOwner()
    if (result === true || result === undefined) return null
    if (types.isPromise(result)) {
      // Reject accidental async auth checks and contain their rejection.
      Promise.prototype.then.call(result, undefined, () => {})
      return 'auth'
    }
    // A synchronous auth check can return metadata. Reject thenables without invoking getters.
    if (result === null || typeof result !== 'object') return 'auth'
    for (let proto = result; proto !== null; proto = Object.getPrototypeOf(proto)) {
      if (types.isProxy(proto)) return 'auth'
      const then = Object.getOwnPropertyDescriptor(proto, 'then')
      if (then) return Object.hasOwn(then, 'value') && typeof then.value !== 'function' ? null : 'auth'
    }
    return null
  } catch (error) {
    return bridgeCode(error) === 'document_unavailable' ? 'document_unavailable' : 'auth'
  }
}

/** Manual one-shot document creation. No native target is acquired until an authorized prepare. */
export function openProjectDocumentService({ auth, openTarget, now = () => performance.now(), ttlMs = 120_000 } = {}) {
  if (typeof auth?.isLoginActive !== 'function' || typeof auth?.onSessionRevoked !== 'function' ||
      typeof openTarget !== 'function' || types.isAsyncFunction(openTarget) || typeof now !== 'function' ||
      !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 2 ** 31 - 1) throw fault('document_unavailable')

  const entries = new Map(), leases = new Set(), issuances = []
  let closed = false

  function dispose(entry) {
    const target = entry.target
    entry.target = null
    entry.digest = entry.revision = null
    try { quietly(() => ownData(target, 'close')?.call(target)) }
    finally { entry.actor = null; leases.delete(entry) }
  }

  function retire(entry, code) {
    if (entry.failure) return
    entry.failure = code
    entries.delete(entry.id)
    clearTimeout(entry.timer)
    // A revoke can fire synchronously inside the bridge. Let its stack unwind before closing FDs.
    if (!entry.running) dispose(entry)
  }

  function finish(entry) {
    if (!entry.running) return
    entry.running = false
    if (entry.failure) dispose(entry)
  }

  const unsubscribe = auth.onSessionRevoked(login => {
    for (const item of issuances) if (item.login === login) item.login = null
    for (const entry of entries.values()) if (entry.actor.loginSessionId === login) retire(entry, 'auth')
  })

  function checkLogin(actor, entry) {
    if (closed) throw fault('document_unavailable')
    if (quietly(() => auth.isLoginActive(actor)) !== true) {
      if (entry) retire(entry, 'auth')
      for (const active of entries.values()) if (sameLogin(active.actor, actor)) retire(active, 'auth')
      throw fault('auth')
    }
    if (closed) throw fault('document_unavailable')
  }

  function authorize(actor, verifyOwner, entry) {
    checkLogin(actor, entry)
    const failure = verificationFailure(verifyOwner)
    checkLogin(actor, entry)
    if (failure) throw fault(failure)
  }

  function checkpoint(entry, verifyOwner) {
    authorize(entry.actor, verifyOwner, entry)
    if (!entry.failure && now() >= entry.expires) retire(entry, 'document_intent_missing')
    if (entry.failure) throw fault(entry.failure)
    return true
  }

  function armExpiry(entry) {
    const left = entry.expires - now()
    if (left <= 0) retire(entry, 'document_intent_missing')
    else entry.timer = setTimeout(() => armExpiry(entry), Math.ceil(left)).unref()
  }

  function reserve(actor, workspaceId) {
    const time = now()
    for (const entry of entries.values()) if (entry.expires <= time) retire(entry, 'document_intent_missing')
    if (closed) throw fault('document_unavailable')
    if (leases.size >= MAX_ACTIVE || [...leases].filter(entry => entry.actor && sameLogin(entry.actor, actor)).length >= MAX_PER_LOGIN) {
      throw fault('document_busy')
    }
    while (issuances.length && time - issuances[0].time >= ISSUE_WINDOW_MS) issuances.shift()
    if (issuances.length >= ISSUE_GLOBAL || issuances.filter(item => item.login === actor.loginSessionId).length >= ISSUE_PER_LOGIN) {
      throw fault('document_busy')
    }
    issuances.push({ time, login: actor.loginSessionId })
    let id
    do { id = 'di_' + randomBytes(16).toString('hex') } while (entries.has(id))
    const entry = { id, actor, workspaceId, expires: time + ttlMs, state: 'opening', running: true, target: null, revision: null, digest: null }
    entries.set(id, entry)
    leases.add(entry)
    armExpiry(entry)
    return entry
  }

  function use(actor, workspaceId, intentId, verifyOwner, run) {
    const identity = actorIdentity(actor)
    checkLogin(identity)
    const entry = validIntent(intentId) && entries.get(intentId)
    if (!entry || entry.state === 'opening' || entry.workspaceId !== workspaceId || !sameLogin(entry.actor, identity)) {
      authorize(identity, verifyOwner)
      throw fault('document_intent_missing')
    }
    if (entry.running) {
      authorize(identity, verifyOwner)
      throw fault('document_busy')
    }
    entry.running = true
    try {
      checkpoint(entry, verifyOwner)
      return run(entry, verifyOwner)
    } finally { finish(entry) }
  }

  function stale(entry, code) {
    entry.state = 'stale'
    entry.staleCode = code
    entry.digest = entry.revision = null
  }

  function quarantine(entry) {
    entry.state = 'unconfirmed'
    entry.digest = entry.revision = null
  }

  function call(entry, verifyOwner, action, fallback, observe) {
    checkpoint(entry, verifyOwner)
    let result, failure
    try { result = action() } catch (error) { failure = bridgeCode(error, fallback) }
    // Once acquired, an invalidated project identifier is a lost binding, not an absent intent.
    if (entry.target && failure === 'workspace_unavailable') failure = 'document_changed'
    const code = observe(result, failure)
    checkpoint(entry, verifyOwner)
    if (code) throw fault(code)
    return result
  }

  function verifyAbsent(entry, verifyOwner, unconfirmed = false) {
    call(entry, verifyOwner, () => entry.target.verifyAbsent(), 'document_unavailable', (result, failure) => {
      const code = failure ?? (result !== true ? 'document_unavailable' : undefined)
      // An unknown leaf after an ambiguous publish may be our own. It is neither a receipt nor permission to retry.
      if (unconfirmed && code === 'document_exists') return
      if (changed(code)) stale(entry, code)
      return code
    })
  }

  function verifyReceipt(entry, verifyOwner) {
    call(entry, verifyOwner, () => entry.target.verifyReceipt(entry.revision), 'document_unconfirmed', (result, failure) => {
      const code = failure === 'document_unavailable' ? 'document_unconfirmed' : failure ?? (result !== true ? 'document_unconfirmed' : undefined)
      if (changed(code)) stale(entry, code)
      else if (code) quarantine(entry)
      return code
    })
  }

  function prepare(actor, workspaceId, body, verifyOwner) {
    const identity = actorIdentity(actor)
    authorize(identity, verifyOwner)
    if (!validWorkspace(workspaceId)) throw fault('workspace_unavailable')
    const request = Object.freeze(targetBody(body))
    const entry = reserve(identity, workspaceId)
    try {
      call(entry, verifyOwner, () => { entry.target = openTarget(workspaceId, request) }, 'document_unavailable', (_, failure) => failure)
      const path = ownData(entry.target, 'path')
      const expectedPath = request.directory === '' ? request.name : `${request.directory}/${request.name}`
      if (typeof path !== 'string' || path !== expectedPath || !['verifyAbsent', 'publish', 'verifyReceipt', 'close'].every(key =>
        typeof ownData(entry.target, key) === 'function')) throw fault('document_unavailable')
      verifyAbsent(entry, verifyOwner)
      entry.path = path
      entry.state = 'prepared'
      return { id: entry.id, path, ttlMs }
    } catch (error) {
      retire(entry, 'document_intent_missing')
      finish(entry)
      authorize(identity, verifyOwner)
      throw error
    } finally { finish(entry) }
  }

  function publicationGuard(entry, verifyOwner) {
    return {
      verify() {
        if (!entry) throw fault('document_intent_missing')
        return checkpoint(entry, verifyOwner)
      },
      close() { entry = verifyOwner = null },
    }
  }

  function publish(entry, verifyOwner, content, digest) {
    const guard = publicationGuard(entry, verifyOwner)
    try {
      call(entry, verifyOwner, () => entry.target.publish(content, guard.verify), 'document_unconfirmed', (result, failure) => {
        const revision = ownData(result, 'revision')
        if (!failure && validRevision(revision)) {
          entry.state = 'created'
          entry.revision = revision
          entry.digest = digest
          return
        }
        if (changed(failure)) { stale(entry, failure); return failure }
        if (PRE_PUBLICATION.has(failure)) return failure
        quarantine(entry)
        return failure === 'auth' ? 'auth' : 'document_unconfirmed'
      })
    } finally { guard.close() }
  }

  function create(entry, verifyOwner, body) {
    const content = contentBody(body)
    if (entry.state === 'stale') throw fault(entry.staleCode)
    if (entry.state === 'unconfirmed') throw fault('document_unconfirmed')
    const digest = createHash('sha256').update(content, 'utf8').digest('hex')
    const replayed = entry.state === 'created'
    if (replayed) {
      if (digest !== entry.digest) throw fault('document_conflict')
    } else {
      verifyAbsent(entry, verifyOwner)
      publish(entry, verifyOwner, content, digest)
    }
    verifyReceipt(entry, verifyOwner)
    return { created: true, path: entry.path, revision: entry.revision, replayed }
  }

  return Object.freeze({
    prepare,
    create(actor, workspaceId, intentId, body, verifyOwner) {
      return use(actor, workspaceId, intentId, verifyOwner, (entry, verify) => create(entry, verify, body))
    },
    status(actor, workspaceId, intentId, body, verifyOwner) {
      return use(actor, workspaceId, intentId, verifyOwner, (entry, verify) => {
        emptyBody(body)
        if (entry.state === 'stale') throw fault(entry.staleCode)
        if (entry.state === 'created') verifyReceipt(entry, verify)
        else verifyAbsent(entry, verify, entry.state === 'unconfirmed')
        return { state: entry.state, path: entry.path, revision: entry.revision }
      })
    },
    cancel(actor, workspaceId, intentId, body, verifyOwner) {
      return use(actor, workspaceId, intentId, verifyOwner, (entry, verify) => {
        emptyBody(body)
        const identity = entry.actor
        retire(entry, 'document_intent_missing')
        finish(entry)
        authorize(identity, verify)
        return { closed: true }
      })
    },
    close() {
      if (closed) return
      closed = true
      quietly(() => unsubscribe())
      for (const entry of entries.values()) retire(entry, 'document_unavailable')
      issuances.length = 0
    },
  })
}
