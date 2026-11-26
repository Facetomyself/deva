import { createHash, timingSafeEqual } from 'node:crypto'
import { openWorkerClient, WorkerControlError } from '../../../browser-worker/src/client.mjs'
import { validateInput } from '../../../browser-worker/src/engine/policy.mjs'
import { validOpaqueId, validSiteId, workerStates } from '../../../browser-worker/src/worker-control.mjs'
import { createAsyncHandoff, deny, unavailable, workerAck } from './async-handoff.mjs'
import { BrowserHandoffError } from './handoff.mjs'

export { BrowserHandoffError }

const sidPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u
const actorId = /^[A-Za-z0-9_.:-]{1,128}$/u
const noncePattern = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u
const MAX_QUEUED_IO = 16
const MAX_SESSIONS = 32
const MAX_UNCERTAIN_TARGETS = 16
const denied = () => new BrowserHandoffError('HANDOFF_DENIED')
const sameLogin = (a, b) => a.ownerId === b.ownerId && a.loginSessionId === b.loginSessionId
const tabScope = (tab) => ({ sid: tab.sessionId, tabId: tab.tabId })

/** A per-session queue; revocation removes queued private jobs and their payloads immediately. */
function serial() {
  let waiting = [], running = false
  function next() {
    if (running || !waiting.length) return
    running = true
    queueMicrotask(async () => {
      const job = waiting.shift()
      try {
        if (job) job.resolve(job.deliver(await job.work()))
      } catch (error) { job.reject(error) }
      finally { running = false; next() }
    })
  }
  return {
    submit(work, { scope, deliver = (value) => value } = {}) {
      if (scope && waiting.filter((job) => job.scope === scope).length >= MAX_QUEUED_IO) deny()
      return new Promise((resolve, reject) => {
        waiting.push({ work, scope, deliver, resolve, reject }); next()
      })
    },
    cancel(scope) {
      waiting = waiting.filter((job) => {
        if (job.scope !== scope) return true
        job.reject(denied())
        return false
      })
    },
  }
}

function siteMetadata(value) {
  if (!Array.isArray(value) || value.length > 128) return null
  const ids = new Set()
  const sites = []
  for (const entry of value) {
    const { id, label, origin } = entry ?? {}
    if (!validSiteId(id) || ids.has(id) || typeof label !== 'string' || !label.trim() || label.length > 256 ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(label) || typeof origin !== 'string' || origin.length > 4096) return null
    try {
      const url = new URL(origin)
      if (!['https:', 'http:'].includes(url.protocol) || url.origin !== origin) return null
    } catch { return null }
    ids.add(id)
    sites.push(Object.freeze({ id, label, origin }))
  }
  return Object.freeze(sites)
}

const publicTab = (tab) => Object.freeze({ sessionId: tab.sessionId, tabId: tab.tabId, siteId: tab.siteId,
  state: tab.phase, origin: tab.origin, label: tab.label })

/**
 * Domain adapter for server-authenticated actors from auth.identify(). The caller owns HTTP
 * auth/CSRF/caching. The independent worker owns tabs and private I/O; this process keeps only
 * opaque scope, lease digests, sequence and lifecycle metadata between requests.
 */
export function createManualBrowser({ client, runDir, auth, sessionExists, now, randomBytes } = {}) {
  client ??= openWorkerClient({ runDir })
  if (typeof auth?.isLoginActive !== 'function' || typeof auth?.onSessionRevoked !== 'function' ||
      typeof sessionExists !== 'function') unavailable()

  const slots = new Map(), pending = new Set()
  // The HTTP adapter owns the image object; retain only a weak, one-use delivery guard.
  const framePermits = new WeakMap()
  let closed = false, closing, unconfirmed = false

  function loginActive(actor) {
    try {
      return !closed && actor?.role === 'owner' && typeof actor.ownerId === 'string' && actorId.test(actor.ownerId) &&
        typeof actor.loginSessionId === 'string' && actorId.test(actor.loginSessionId) && auth.isLoginActive(actor) === true
    } catch { return false }
  }
  function sessionActive(sid) {
    try { return typeof sid === 'string' && sidPattern.test(sid) && sessionExists(sid) === true }
    catch { return false }
  }
  function requireActor(actor) { if (!loginActive(actor)) deny() }
  function requireSession(actor, sid) { if (!loginActive(actor) || !sessionActive(sid)) deny() }
  function authorized(tab) {
    return tab.phase !== 'closed' && tab.slot.tab === tab && slots.get(tab.sessionId) === tab.slot &&
      loginActive(tab.actor) && sessionActive(tab.sessionId) && tab.phase !== 'closed' && tab.slot.tab === tab
  }
  function track(task) {
    pending.add(task)
    void task.then(() => pending.delete(task), () => pending.delete(task))
    return task
  }
  function forget(slot) {
    if (!slot.tab && !slot.opening && !slot.quarantined && !slot.uncertainTargets?.size && slots.get(slot.sid) === slot) slots.delete(slot.sid)
  }
  function quarantine(slot, tabId) {
    unconfirmed = true
    if (tabId === undefined) { slot.quarantined = true; return }
    const targets = slot.uncertainTargets ??= new Set()
    targets.add(tabId)
    if (targets.size >= MAX_UNCERTAIN_TARGETS) slot.quarantined = true
  }

  const bridge = createAsyncHandoff({ client, lookup: (sid) => slots.get(sid)?.tab,
    authorized, onClose: (tab) => { retire(tab) }, now, randomBytes })

  function retire(tab) {
    if (tab.phase === 'closed') return tab.cleanup
    tab.phase = 'closed'
    tab.control = undefined
    tab.viewerDigest?.fill(0)
    tab.viewerDigest = undefined
    tab.slot.queue.cancel(tab)
    bridge.core.closeTab(tab.sessionId, tab.tabId, tab.tabId)
    const task = tab.slot.queue.submit(async () => {
      try {
        await workerAck(() => client.closeTab(tabScope(tab)), (value) => value?.closed === true)
        bridge.core.confirmClosed({ actor: tab.actor, sessionId: tab.sessionId, tabId: tab.tabId, targetId: tab.tabId })
        return Object.freeze({ closed: true })
      } catch (error) {
        quarantine(tab.slot, tab.tabId)
        throw error
      } finally {
        if (tab.slot.tab === tab) tab.slot.tab = undefined
        forget(tab.slot)
      }
    })
    tab.cleanup = track(task)
    return task
  }

  function invalidate(slot, loginSessionId) {
    const matches = (actor) => loginSessionId === undefined || actor.loginSessionId === loginSessionId
    const work = []
    if (slot.tab && matches(slot.tab.actor)) work.push(retire(slot.tab))
    if (slot.opening && matches(slot.opening.actor)) {
      slot.opening.canceled = true
      work.push(slot.opening.task)
    }
    return work
  }
  const unsubscribe = auth.onSessionRevoked((loginSessionId) => {
    if (typeof loginSessionId !== 'string') return
    for (const slot of slots.values()) invalidate(slot, loginSessionId)
  })
  if (typeof unsubscribe !== 'function') unavailable()

  function getTab(actor, sid, tabId) {
    requireActor(actor)
    const tab = slots.get(sid)?.tab
    if (!validOpaqueId(tabId) || tab?.tabId !== tabId || !sameLogin(actor, tab.actor)) deny()
    if (!authorized(tab)) { retire(tab); deny() }
    return tab
  }
  function guardTab(tab, phase) {
    if (!authorized(tab)) { retire(tab); deny() }
    if (tab.phase !== phase) deny()
  }
  function guardControl(tab, phase, permit) {
    guardTab(tab, phase)
    if (!permit.allows()) deny()
    guardTab(tab, phase)
  }
  async function availableSites() {
    let sites
    await workerAck(() => client.sites(), (value) => (sites = siteMetadata(value)) !== null)
    return sites
  }
  async function openRemote(slot, opening, site) {
    const { actor } = opening
    const { id: siteId } = site
    const guard = () => {
      requireSession(actor, slot.sid)
      if (opening.canceled || slot.opening !== opening) deny()
      if (slot.quarantined) unavailable()
    }
    guard()
    let result
    try {
      result = await client.open({ sid: slot.sid, siteId })
    } catch (error) {
      // A transport-level failure can hide an open that completed without a usable tab ID.
      if (!(error instanceof WorkerControlError) || error.code === 'CONTROL_FAILED') quarantine(slot)
      unavailable()
    }
    if (!validOpaqueId(result?.tabId) || result.siteId !== siteId || result.tabId === opening.previousId ||
        slot.uncertainTargets?.has(result.tabId)) {
      quarantine(slot)
      unavailable()
    }
    const tab = { slot, actor, sessionId: slot.sid, tabId: result.tabId, siteId, origin: site.origin, label: site.label,
      phase: 'open', control: undefined, nextSeq: 1 }
    slot.tab = tab
    try { guard(); guardTab(tab, 'open') }
    catch (error) { retire(tab); throw error }
    return tab
  }

  function verify(tab, viewerNonce, token, intent) {
    return bridge.core.verify({ actor: tab.actor, sessionId: tab.sessionId, tabId: tab.tabId, viewerNonce, token, intent })
  }
  function privateOp(tab, permit, op, action, seq) {
    const control = tab.control
    const guard = () => guardControl(tab, 'leased', permit)
    guard()
    const deliver = (result) => {
      try { guard() }
      catch (error) { if (op === 'frame') result.bytes.fill(0); throw error }
      if (op === 'frame') {
        framePermits.set(result, guard)
        return result
      }
      return Object.freeze({ accepted: true, seq })
    }
    return tab.slot.queue.submit(async () => {
      try { return await bridge.operate(tab, control, permit, guard, op, action) }
      catch (error) {
        if (error.code === 'HANDOFF_UNAVAILABLE') retire(tab)
        throw error
      }
    }, { scope: tab, deliver })
  }

  return Object.freeze({
    async status(actor) {
      requireActor(actor)
      const { state } = await workerAck(() => client.status(), (value) => workerStates.includes(value?.state))
      requireActor(actor)
      return Object.freeze({ state })
    },
    async sites(actor) {
      requireActor(actor)
      const sites = await availableSites()
      requireActor(actor)
      return sites
    },
    async open({ actor, sid, siteId } = {}) {
      requireSession(actor, sid)
      if (!validSiteId(siteId)) deny()
      const current = slots.get(sid)
      if (current?.opening || (current?.tab && !sameLogin(actor, current.tab.actor))) deny()
      const site = (await availableSites()).find(({ id }) => id === siteId)
      requireSession(actor, sid)
      if (!site) deny()
      let slot = slots.get(sid)
      if (!slot) {
        if (slots.size >= MAX_SESSIONS) unavailable()
        slot = { sid, queue: serial() }
        slots.set(sid, slot)
      }
      if (slot.quarantined) unavailable()
      if (slot.opening || (slot.tab && !sameLogin(actor, slot.tab.actor))) deny()
      const opening = { actor, canceled: false, previousId: slot.tab?.tabId }
      slot.opening = opening
      // A same-session replacement invalidates old calls at admission, not after worker open.
      if (slot.tab) retire(slot.tab)
      const task = slot.queue.submit(() => openRemote(slot, opening, site), { deliver(tab) {
        if (opening.canceled) { retire(tab); deny() }
        guardTab(tab, 'open')
        return publicTab(tab)
      } })
      opening.task = track(task)
      try { return await task }
      finally { if (slot.opening === opening) slot.opening = undefined; forget(slot) }
    },
    async lease({ actor, sid, tabId, viewerNonce, intent } = {}) {
      if (intent !== 'control' || typeof viewerNonce !== 'string' || !noncePattern.test(viewerNonce)) deny()
      const tab = getTab(actor, sid, tabId)
      const previous = tab.phase
      if (previous !== 'open' && previous !== 'returned') deny()
      const viewerDigest = createHash('sha256').update(viewerNonce).digest()
      if (tab.viewerDigest && timingSafeEqual(tab.viewerDigest, viewerDigest)) { viewerDigest.fill(0); deny() }
      tab.viewerDigest?.fill(0)
      tab.viewerDigest = viewerDigest
      tab.phase = 'starting'
      // Returned has no live channel; remove its replay proof before the next real pause.
      if (previous === 'returned') bridge.core.closeTab(tab.sessionId, tab.tabId, tab.tabId)
      const guard = () => guardTab(tab, 'starting')
      return tab.slot.queue.submit(async () => {
        try {
          const control = await bridge.pause(tab, guard)
          guard()
          const lease = bridge.core.lease({ actor: tab.actor, sessionId: sid, tabId, viewerNonce, intent })
          tab.control = control
          tab.nextSeq = 1
          tab.phase = 'leased'
          return { lease, permit: verify(tab, viewerNonce, lease.token) }
        } catch (error) { retire(tab); throw error }
      }, { scope: tab, deliver({ lease, permit }) { guardControl(tab, 'leased', permit); return lease } })
    },
    async frame({ actor, sid, tabId, viewerNonce, token } = {}) {
      const tab = getTab(actor, sid, tabId)
      return privateOp(tab, verify(tab, viewerNonce, token), 'frame')
    },
    // Call synchronously at the last transport boundary, before committing headers or pixels.
    assertFrameCurrent(frame) {
      const guard = framePermits.get(frame)
      if (!guard) deny()
      framePermits.delete(frame)
      try { guard() } catch (error) { frame.bytes.fill(0); throw error }
    },
    async input({ actor, sid, tabId, viewerNonce, token, action, seq } = {}) {
      const tab = getTab(actor, sid, tabId)
      const permit = verify(tab, viewerNonce, token)
      if (!Number.isSafeInteger(seq) || seq !== tab.nextSeq) deny()
      let safeAction
      try { safeAction = validateInput(action) } catch { deny() }
      const task = privateOp(tab, permit, 'input', safeAction, seq)
      tab.nextSeq++
      return task
    },
    async finish({ actor, sid, tabId, viewerNonce, token, intent } = {}) {
      if (intent !== 'done' && intent !== 'skip') deny()
      const tab = getTab(actor, sid, tabId)
      const permit = verify(tab, viewerNonce, token, intent)
      if (tab.phase === 'returned') { permit.finish(); return publicTab(tab) }
      guardControl(tab, 'leased', permit)
      const control = tab.control
      // Invalidate the previous generation synchronously, before queuing worker release.
      tab.phase = 'finishing'
      tab.control = undefined
      tab.slot.queue.cancel(tab)
      const guard = () => guardControl(tab, 'finishing', permit)
      return tab.slot.queue.submit(async () => {
        try {
          await bridge.release(tab, control, permit, intent, guard)
          guardTab(tab, 'finishing')
          tab.phase = 'returned'
        } catch (error) { retire(tab); throw error }
      }, { deliver() { guardTab(tab, 'returned'); return publicTab(tab) } })
    },
    async closeTab({ actor, sid, tabId } = {}) {
      requireSession(actor, sid)
      const tab = slots.get(sid)?.tab
      if (!validOpaqueId(tabId) || tab?.tabId !== tabId || !sameLogin(actor, tab.actor)) deny()
      const result = await retire(tab)
      requireSession(actor, sid)
      return result
    },
    async list({ actor, sid } = {}) {
      requireActor(actor)
      const tab = slots.get(sid)?.tab
      const owned = tab && sameLogin(actor, tab.actor)
      if (!sessionActive(sid)) { if (owned) retire(tab); deny() }
      if (!owned) return Object.freeze([])
      bridge.core.sweep()
      if (!authorized(tab)) { retire(tab); return Object.freeze([]) }
      if (!['open', 'leased', 'returned'].includes(tab.phase)) return Object.freeze([])
      return Object.freeze([publicTab(tab)])
    },
    async closeSession(sid) {
      const slot = slots.get(sid)
      if (!slot) return
      const work = invalidate(slot)
      await Promise.allSettled(work)
      if (slot.tab?.cleanup) await slot.tab.cleanup
      if (slot.quarantined || slot.uncertainTargets?.size) unavailable()
    },
    close() {
      if (closing) return closing
      closed = true
      unsubscribe()
      for (const slot of slots.values()) invalidate(slot)
      closing = (async () => {
        while (pending.size) await Promise.allSettled([...pending])
        if (unconfirmed) unavailable()
      })()
      return closing
    },
  })
}
