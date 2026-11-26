import { createHash, randomBytes as cryptoRandomBytes, timingSafeEqual } from 'node:crypto'
import { performance } from 'node:perf_hooks'

const SECRET_BYTES = 32
const PAUSE_MS = 60_000
const LEASE_MS = 60_000
const REPLAY_MS = 60_000
const idPattern = /^[A-Za-z0-9_.:-]{1,128}$/
const secretPattern = /^[A-Za-z0-9_-]{43}$/

export class BrowserHandoffError extends Error {
  constructor(code) {
    super(code)
    this.name = 'BrowserHandoffError'
    this.code = code
  }
}

function deny() { throw new BrowserHandoffError('HANDOFF_DENIED') }
function unavailable() { throw new BrowserHandoffError('HANDOFF_UNAVAILABLE') }
function id(value) { return typeof value === 'string' && idPattern.test(value) }
function owner(actor) {
  return actor?.role === 'owner' && id(actor.ownerId) && id(actor.loginSessionId)
}
function sameLogin(actor, binding) {
  return actor.ownerId === binding.ownerId && actor.loginSessionId === binding.loginSessionId
}
function slot(sessionId, tabId) { return `${sessionId}/${tabId}` }

function digest(bytes) { return createHash('sha256').update(bytes).digest() }
function proof(value) {
  if (typeof value !== 'string' || !secretPattern.test(value)) return null
  const bytes = Buffer.from(value, 'base64url')
  const result = bytes.length === SECRET_BYTES && bytes.toString('base64url') === value ? digest(bytes) : null
  bytes.fill(0)
  return result
}

function scrub(receipt) {
  receipt?.viewerHash.fill(0)
  receipt?.tokenHash.fill(0)
}

function matches(receipt, viewerNonce, token) {
  if (!receipt) return false
  const viewerHash = proof(viewerNonce)
  const tokenHash = proof(token)
  const sameViewer = viewerHash !== null && timingSafeEqual(viewerHash, receipt.viewerHash)
  const sameToken = tokenHash !== null && timingSafeEqual(tokenHash, receipt.tokenHash)
  viewerHash?.fill(0)
  tokenHash?.fill(0)
  return sameViewer && sameToken
}

function originOnly(value) {
  if (typeof value !== 'string' || value.length > 4096) return undefined
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.origin
  } catch { /* An invalid URL contributes no public metadata. */ }
}

function publicState({ binding, state, origin, label }) {
  const out = { sessionId: binding.sessionId, tabId: binding.tabId, state }
  if (origin !== undefined) out.origin = origin
  if (label !== undefined) out.label = label
  return Object.freeze(out)
}

// A successful handoff requires synchronous, affirmative worker/authority acknowledgements.
// Adapter errors are deliberately discarded; a worker exception may contain private data.
function confirmed(call) {
  try {
    const result = call()
    if (result instanceof Promise) void result.catch(() => {})
    return result === true
  } catch { return false }
}

/**
 * In-memory domain for a single workbench owner's manually approved browser handoff.
 *
 * `actor` is built from a verified login by the server, never accepted from client JSON.
 * `authorize(binding)` synchronously checks the live owner login, exact session/tab/Target
 * and its approved handoff. Bindings are immutable; Target IDs identify one lifetime, not
 * a tab alias that a worker may resolve to a replacement. Login IDs are opaque, not cookies.
 * `offer` and lifecycle hooks are trusted server calls, not capabilities for a page or model.
 * `label` is an explicitly approved site label, never a title read from a browser page.
 *
 * The independent worker must synchronously confirm `isLive(binding)`, `pause(binding)`,
 * `attach(binding, access)`, `release(binding, intent)`, and `close(binding)` with `true`.
 * Pause reserves the exact Target, isolates manual input and frames from the ordinary view
 * and blocks automated operation on it. Release returns only that Target to ordinary view.
 * Close stops the manual path and pending I/O for that exact binding without granting access.
 * The worker/transport owns private I/O, uses the per-connection access checks immediately
 * before each input and outgoing frame (also after any async boundary), and discards pending
 * data on abort. A disconnect detaches only that channel, not its lease. Never route Target
 * payloads through this domain, ordinary event transports, a model or a journal.
 *
 * Secure transport delivers the one-time lease response privately (no caches/logs), and
 * presents token + nonce in the private transport's message/body, never in a URL. Transport
 * authentication/CSRF and any login/session deletion updates are the adapter's responsibility.
 */
export function createBrowserHandoff({ worker, authorize, now = () => performance.now(), randomBytes = cryptoRandomBytes } = {}) {
  const methods = ['isLive', 'pause', 'attach', 'release', 'close']
  const enabled = typeof authorize === 'function' && methods.every((method) => typeof worker?.[method] === 'function')
  const jobs = enabled ? Object.fromEntries(methods.map((method) => [method, worker[method].bind(worker)])) : null
  const entries = new Map()
  const targets = new Map()
  // A worker that cannot confirm cleanup must not get a second reservation for the same Target.
  const quarantine = new Map()
  let lastTime = 0

  function clock() {
    try {
      const value = now()
      if (!Number.isFinite(value) || value < lastTime || value > Number.MAX_SAFE_INTEGER - LEASE_MS) return null
      lastTime = value
      return value
    } catch { return null }
  }

  function ownsEntry(entry) { return entries.get(entry.key) === entry && entry.state !== 'closed' }
  function clearTimer(entry) { clearTimeout(entry.timer); entry.timer = undefined }

  function detach(entry, connection = entry.connection) {
    if (!connection || entry.connection !== connection) return false
    entry.connection = null
    connection.abort.abort()
    return true
  }

  function closeEntry(entry) {
    if (!ownsEntry(entry)) return false
    const wasReturned = entry.state === 'returned'
    entry.state = 'closed'
    clearTimer(entry)
    scrub(entry.receipt)
    entry.receipt = null
    // Invalidate before abort listeners or worker code run. Keep the indexes during cleanup.
    detach(entry)
    if (!wasReturned && !confirmed(() => jobs.close(entry.binding))) quarantine.set(entry.binding.targetId, entry.binding)
    entries.delete(entry.key)
    targets.delete(entry.binding.targetId)
    return true
  }

  function checkTime(entry) {
    const value = clock()
    if (value !== null && value < entry.deadline) return value
    if (value !== null && entry.state === 'returned') {
      // Retain only public metadata and the exact tab/Target reservation after replay expires.
      clearTimer(entry)
      scrub(entry.receipt)
      entry.receipt = null
      entry.deadline = Infinity
      return value
    }
    closeEntry(entry)
    return null
  }

  function current(entry) {
    if (!ownsEntry(entry) || checkTime(entry) === null) return false
    const checks = confirmed(() => authorize(entry.binding)) && ownsEntry(entry) &&
      confirmed(() => jobs.isLive(entry.binding))
    if (!checks) { closeEntry(entry); return false }
    return ownsEntry(entry) && checkTime(entry) !== null
  }

  function schedule(entry, time) {
    clearTimer(entry)
    const delay = Math.max(1, Math.ceil(entry.deadline - time))
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      if (!current(entry) || entry.deadline === Infinity) return
      const observed = checkTime(entry)
      if (observed !== null && entry.deadline !== Infinity) schedule(entry, observed)
    }, delay)
    entry.timer.unref()
  }

  function checkRequest(actor, sessionId, tabId) {
    if (!enabled) unavailable()
    if (!owner(actor) || !id(sessionId) || !id(tabId)) deny()
  }

  function get(actor, sessionId, tabId) {
    checkRequest(actor, sessionId, tabId)
    const entry = entries.get(slot(sessionId, tabId))
    if (!entry || !sameLogin(actor, entry.binding) || entry.transiting || !current(entry) || entry.transiting) deny()
    return entry
  }

  function offer({ actor, sessionId, tabId, targetId, origin, label } = {}) {
    checkRequest(actor, sessionId, tabId)
    if (!id(targetId) || quarantine.has(targetId)) deny()
    const key = slot(sessionId, tabId)
    const existing = entries.get(key)
    if (existing) {
      if (existing.binding.targetId !== targetId) deny()
      return publicState(get(actor, sessionId, tabId))
    }
    if (targets.has(targetId)) deny()
    const time = clock()
    if (time === null) unavailable()
    const binding = Object.freeze({ ownerId: actor.ownerId, loginSessionId: actor.loginSessionId, sessionId, tabId, targetId })
    if (!confirmed(() => authorize(binding)) || !confirmed(() => jobs.isLive(binding))) deny()
    if (entries.has(key) || targets.has(targetId) || quarantine.has(targetId)) deny()
    const entry = { key, binding, origin: originOnly(origin),
      label: typeof label === 'string' && label.length <= 80 && /^[\p{L}\p{M}\p{N} ._-]+$/u.test(label) ? label : undefined,
      state: 'paused', deadline: time + PAUSE_MS, transiting: true, receipt: null, connection: null }
    entries.set(key, entry)
    targets.set(targetId, entry)
    if (!confirmed(() => jobs.pause(binding)) || !current(entry)) {
      closeEntry(entry)
      unavailable()
    }
    entry.transiting = false
    schedule(entry, lastTime)
    return publicState(entry)
  }

  function lease({ actor, sessionId, tabId, viewerNonce, intent } = {}) {
    if (intent !== 'control') deny()
    const entry = get(actor, sessionId, tabId)
    if (entry.state !== 'paused') deny()
    const viewerHash = proof(viewerNonce)
    if (viewerHash === null) deny()
    let supplied
    try { supplied = randomBytes(SECRET_BYTES) } catch { unavailable() }
    if (!(supplied instanceof Uint8Array) || supplied.byteLength !== SECRET_BYTES) unavailable()
    const bytes = Buffer.from(supplied)
    const tokenHash = digest(bytes)
    const token = bytes.toString('base64url')
    bytes.fill(0)
    if (entry.state !== 'paused' || entry.transiting || !current(entry) || entry.state !== 'paused') deny()
    entry.receipt = { tokenHash, viewerHash }
    entry.state = 'leased'
    entry.deadline = lastTime + LEASE_MS
    schedule(entry, lastTime)
    return Object.freeze({ token, ttlMs: LEASE_MS })
  }

  function attach({ actor, sessionId, tabId, viewerNonce, token } = {}) {
    const entry = get(actor, sessionId, tabId)
    if (entry.state !== 'leased' || entry.connection || !matches(entry.receipt, viewerNonce, token)) deny()
    return openChannel(entry)
  }

  // Keep the access closures in a scope that never receives the raw credentials.
  function openChannel(entry) {
    const connection = { abort: new AbortController(), ready: false }
    entry.connection = connection
    const attached = () => entry.state === 'leased' && entry.connection === connection && connection.ready
    const allows = () => attached() && current(entry) && attached()
    const access = Object.freeze({ signal: connection.abort.signal, allowsInput: allows, allowsFrame: allows,
      disconnect: () => detach(entry, connection) })
    entry.transiting = true
    if (!confirmed(() => jobs.attach(entry.binding, access)) || !current(entry) || entry.connection !== connection) {
      closeEntry(entry)
      unavailable()
    }
    entry.transiting = false
    connection.ready = true
    return access
  }

  // Trusted adapters may authenticate before an asynchronous operation, without retaining
  // the raw credentials. The handle is pinned to exactly this receipt and lifecycle state.
  function verify({ actor, sessionId, tabId, viewerNonce, token, intent } = {}) {
    if (intent !== undefined && intent !== 'done' && intent !== 'skip') deny()
    const entry = get(actor, sessionId, tabId)
    if (!matches(entry.receipt, viewerNonce, token) || (entry.state !== 'leased' &&
        (entry.state !== 'returned' || intent === undefined || entry.receipt.intent !== intent))) deny()
    return verifiedHandle(entry, intent)
  }

  function verifiedHandle(entry, intent) {
    const { receipt, state } = entry
    const pinned = () => !entry.transiting && entry.state === state && entry.receipt === receipt
    const allows = () => pinned() && current(entry) && pinned()
    return Object.freeze({ state, allows,
      attach() { if (state !== 'leased' || !allows() || entry.connection) deny(); return openChannel(entry) },
      finish() { if (intent === undefined || !allows()) deny(); return finishEntry(entry, intent) },
    })
  }

  function finish(args) { return verify(args).finish() }

  function finishEntry(entry, intent) {
    if (entry.state === 'returned' && entry.receipt.intent === intent) return publicState(entry)
    if (entry.state !== 'leased') deny()
    entry.transiting = true
    detach(entry)
    if (!current(entry) || !confirmed(() => jobs.release(entry.binding, intent)) || !current(entry)) {
      closeEntry(entry)
      unavailable()
    }
    entry.state = 'returned'
    entry.receipt.intent = intent
    entry.transiting = false
    entry.deadline = lastTime + REPLAY_MS
    schedule(entry, lastTime)
    return publicState(entry)
  }

  function list({ actor, sessionId } = {}) {
    if (!owner(actor) || !id(sessionId)) deny()
    return Object.freeze(Array.from(entries.values()).filter((entry) => entry.binding.sessionId === sessionId &&
      sameLogin(actor, entry.binding) && !entry.transiting && current(entry) && !entry.transiting).map(publicState))
  }

  function closeWhere(matchesBinding) {
    let count = 0
    for (const entry of Array.from(entries.values())) {
      if (matchesBinding(entry.binding) && closeEntry(entry)) count++
    }
    return count
  }

  // A trusted adapter may settle its quarantine only after the exact worker close acknowledges.
  function confirmClosed({ actor, sessionId, tabId, targetId }) {
    const binding = quarantine.get(targetId)
    if (binding && owner(actor) && sameLogin(actor, binding) && binding.sessionId === sessionId && binding.tabId === tabId) {
      quarantine.delete(targetId)
    }
  }

  return Object.freeze({ available: enabled, offer, lease, attach, verify, finish, list, confirmClosed,
    // Update the authoritative registry before notifying these hooks. Outstanding access is
    // invalidated immediately, and future offers also have to pass the updated registry.
    revokeLogin: (loginSessionId) => id(loginSessionId) ? closeWhere((binding) => binding.loginSessionId === loginSessionId) : 0,
    closeSession: (sessionId) => id(sessionId) ? closeWhere((binding) => binding.sessionId === sessionId) : 0,
    closeTab: (sessionId, tabId, targetId) => id(sessionId) && id(tabId) && id(targetId) ? closeWhere((binding) =>
      binding.sessionId === sessionId && binding.tabId === tabId && binding.targetId === targetId) : 0,
    sweep: () => { for (const entry of Array.from(entries.values())) current(entry) },
  })
}
