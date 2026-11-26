import { randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { openTerminalJournal } from './journal.mjs'
import { waitForViewer, within } from './deadline.mjs'
import {
  actionRequest, busy, checkedExit, checkedScreen, eventsRequest, lostExit, notFound, sequenceConflict,
  sourceChanged, sourceOpenError, startRequest, unavailable, validTerminal, validWorkspace,
} from './validation.mjs'

const MAX_ACTIVE = 4, MAX_PER_LOGIN = 2, MAX_TOMBSTONES = 16, MAX_PROBE_WAITERS = 16
const MAX_SOURCE_BYTES = 65_536
const profile = Object.freeze({ id: 'text-view', label: 'Read-only text viewer' })
const sameLogin = (a, b) => a.role === 'owner' && a.ownerId === b.ownerId && a.loginSessionId === b.loginSessionId
const quietly = action => { try { return action() } catch {} }

/** One fixed source and one private read-only connection per view, scoped to a login and project. */
export function openTerminalService({ auth, worker, openSource, now = () => performance.now(),
  idleMs = 75_000, maxLifetimeMs = 8 * 60_000, tombstoneMs = 15_000, sweepMs = 500,
  probeTimeoutMs = 2500, openTimeoutMs = 8000, actionTimeoutMs = 2000, disposeTimeoutMs = 1500,
  inputBurst = 16, inputRefillMs = 50,
} = {}) {
  if (typeof auth?.isLoginActive !== 'function' || typeof auth?.onSessionRevoked !== 'function' || typeof now !== 'function' ||
      ![idleMs, maxLifetimeMs, tombstoneMs, sweepMs, probeTimeoutMs, openTimeoutMs, actionTimeoutMs, disposeTimeoutMs,
        inputBurst, inputRefillMs].every(value => Number.isSafeInteger(value) && value > 0 && value < 2 ** 31 - 1)) throw unavailable()
  const configured = typeof openSource === 'function' && typeof worker?.probe === 'function' && typeof worker?.open === 'function'
  const views = new Map(), retained = new Map(), leases = new Set(), cleanupJobs = new Set()
  let closing = false, closeJob, sweeper, sharedProbe, probeWaiters = 0

  function loginActive(actor) {
    return actor?.role === 'owner' && typeof actor.ownerId === 'string' && typeof actor.loginSessionId === 'string' &&
      quietly(() => auth.isLoginActive(actor)) === true
  }
  function verifies(check) {
    if (check === undefined) return true
    if (typeof check !== 'function') return false
    try {
      const result = check()
      if (typeof result?.then === 'function') { void Promise.resolve(result).catch(() => {}); return false }
      return result !== false
    } catch { return false }
  }
  function requireOwner(actor, verify) {
    if (closing) throw unavailable()
    if (!loginActive(actor) || !verifies(verify) || !loginActive(actor)) throw notFound()
  }
  function release(view) {
    if (view.transportWork === 0 && (view.phase === 'exited' || view.phase === 'dead')) leases.delete(view)
  }
  function releaseSource(view) {
    const source = view.source
    view.source = null
    if (source) quietly(() => source.close())
  }
  function scrub(view) {
    view.journal.clear()
    releaseSource(view)
  }
  function forget(view) {
    views.delete(view.id)
    retained.delete(view.id)
  }
  function remember(view) {
    view.until = now() + tombstoneMs
    retained.set(view.id, view)
    while (retained.size > MAX_TOMBSTONES) abandon(retained.values().next().value, notFound())
  }
  function abandon(view, failure, rememberStale = false) {
    forget(view)
    if (view.phase === 'dead') return
    view.phase = 'dead'; view.failure = failure
    view.exit = null
    view.lastAck = null
    scrub(view)
    view.poll?.()
    // Give a live connection one immediate teardown call, then cancel open/action/poll waiters.
    detach(view, view.connection)
    view.actionAbort?.abort()
    view.abort.abort()
    release(view)
    if (rememberStale && !closing) { views.set(view.id, view); remember(view) }
  }
  function elapsed(view, time) {
    return time - view.created >= maxLifetimeMs || time - view.touched >= idleMs
  }
  function guard(view, verify) {
    if (closing) throw unavailable()
    if (!loginActive(view.actor) || !verifies(verify) || !loginActive(view.actor)) {
      abandon(view, notFound()); throw notFound()
    }
    if (view.phase === 'dead') throw view.failure
    const time = now()
    if (((view.phase === 'opening' || view.phase === 'live') && elapsed(view, time)) ||
        (view.until !== undefined && view.until <= time)) {
      abandon(view, notFound()); throw notFound()
    }
    const source = view.source
    const current = !source || verifies(() => source.verify())
    if (view.phase === 'dead') throw view.failure // synchronous checks may trigger revocation listeners
    if (!current) { abandon(view, sourceChanged(), true); throw sourceChanged() }
  }
  function access(actor, wid, id, verify) {
    if (closing) throw unavailable()
    const view = validTerminal(id) && views.get(id)
    if (!view?.published || view.wid !== wid || !actor || !sameLogin(actor, view.actor)) throw notFound()
    guard(view, verify)
    return view
  }
  function sweep() {
    for (const view of views.values()) {
      if (view.phase === 'dead') { if (view.until <= now()) forget(view); continue }
      quietly(() => guard(view))
    }
    if (!views.size) { clearInterval(sweeper); sweeper = undefined }
  }
  function reserve(actor, wid) {
    sweep()
    if (leases.size >= MAX_ACTIVE || [...leases].filter(view => sameLogin(actor, view.actor)).length >= MAX_PER_LOGIN) throw busy()
    let id
    do { id = 'pt_' + randomBytes(16).toString('hex') } while (views.has(id))
    const created = now()
    const view = { id, wid, actor: Object.freeze({ role: 'owner', ownerId: actor.ownerId, loginSessionId: actor.loginSessionId }),
      phase: 'opening', source: null, journal: openTerminalJournal(), created, touched: created,
      abort: new AbortController(), transportWork: 0, sequence: 0, tokens: inputBurst, refilled: created,
    }
    leases.add(view); views.set(id, view)
    sweeper ??= setInterval(sweep, sweepMs).unref()
    return view
  }
  const unsubscribe = auth.onSessionRevoked(loginSessionId => {
    for (const view of views.values()) if (view.actor.loginSessionId === loginSessionId) abandon(view, notFound())
  })

  function probe() {
    if (sharedProbe) return sharedProbe.result
    const entry = { abort: new AbortController(), result: null }
    sharedProbe = entry
    entry.result = within(probeTimeoutMs, entry.abort.signal, () => {
      let raw
      try { raw = worker.probe({ signal: entry.abort.signal }) } catch { raw = false }
      const complete = value => {
        if (sharedProbe === entry) sharedProbe = null
        return value === true
      }
      return Promise.resolve(raw).then(complete, () => complete(false))
    }).catch(() => { entry.abort.abort(); return false })
    return entry.result
  }

  function observeExit(view, exit) {
    if (view.phase === 'dead' || view.phase === 'exited') return
    try { guard(view) } catch { return }
    if (view.phase === 'opening') { abandon(view, unavailable()); return }
    view.phase = 'exited'; view.exit = exit
    view.journal.finish(exit)
    remember(view)
    view.poll?.()
    view.quitWake?.(exit)
    view.endWake?.()
    detach(view, view.connection)
    release(view)
  }
  function detach(view, connection) {
    if (!connection || typeof connection.dispose !== 'function') return
    if (view.connection === connection) view.connection = null
    view.transportWork++
    let outcome
    try { outcome = connection.dispose() } catch { outcome = undefined }
    const complete = result => {
      view.transportWork--
      const exit = quietly(() => checkedExit(result))
      if (exit) observeExit(view, exit)
      release(view)
    }
    const raw = Promise.resolve(outcome).then(complete, () => complete(undefined))
    const job = within(disposeTimeoutMs, undefined, () => raw).catch(() => view.abort.abort())
    cleanupJobs.add(job)
    void job.then(() => cleanupJobs.delete(job))
  }
  function endConnection(view) {
    if (view.phase === 'exited') return Promise.resolve()
    if (view.endJob) return view.endJob
    view.phase = 'disposing'
    view.actionAbort?.abort()
    view.endJob = within(disposeTimeoutMs, view.abort.signal, () => new Promise(resolve => { view.endWake = resolve }))
      .catch(() => {
        if (view.phase === 'disposing') {
          observeExit(view, lostExit)
          view.abort.abort()
        }
      })
      .finally(() => { view.endWake = null; view.endJob = null })
    detach(view, view.connection)
    return view.endJob
  }
  function workerScreen(view, value) {
    if (view.phase !== 'live') return
    try { guard(view) } catch { return }
    const screen = quietly(() => checkedScreen(value))
    if (!screen) { void endConnection(view); return }
    view.journal.screen(screen)
    view.poll?.()
  }
  function pinSource(view, { path, revision }) {
    let pin
    try { pin = openSource(view.wid, path, revision) } catch (error) { throw sourceOpenError(error) }
    if (view.phase === 'dead') { quietly(() => pin?.close()); throw view.failure }
    if (!pin || typeof pin.verify !== 'function' || typeof pin.close !== 'function' || typeof pin.text !== 'string' ||
        pin.text.length > MAX_SOURCE_BYTES || Buffer.byteLength(pin.text) > MAX_SOURCE_BYTES) {
      quietly(() => pin?.close()); throw unavailable()
    }
    view.source = pin
  }
  function startConnection(view, { cols, rows }) {
    view.transportWork++
    let raw
    try {
      raw = worker.open({ text: view.source.text, cols, rows, signal: view.abort.signal,
        onScreen: value => workerScreen(view, value),
        onExit: result => observeExit(view, quietly(() => checkedExit(result)) ?? lostExit),
      })
    } catch { raw = Promise.reject(unavailable()) }
    return Promise.resolve(raw).then(connection => {
      view.transportWork--
      if (view.phase === 'dead') { detach(view, connection); release(view); throw unavailable() }
      view.connection = connection
      if (!connection || ['input', 'resize', 'dispose'].some(key => typeof connection[key] !== 'function')) throw unavailable()
      return connection
    }, () => { view.transportWork--; release(view); throw unavailable() })
  }
  function consume(view) {
    const time = now(), credit = Math.floor((time - view.refilled) / inputRefillMs)
    if (credit > 0) {
      view.tokens = Math.min(inputBurst, view.tokens + credit)
      view.refilled += credit * inputRefillMs
    }
    if (!view.tokens) throw busy()
    view.tokens--
  }
  function sendChange(view, request) {
    if (request.key === undefined) return view.connection.resize(request.cols, request.rows)
    if (request.key !== 'quit') return view.connection.input(request.key)
    // A transport's write acknowledgement is not proof that the viewer exited.
    return new Promise((resolve, reject) => {
      view.quitWake = exit => {
        if (exit.reason === 'quit' && (exit.code !== null || exit.signal !== null)) resolve()
        else reject(unavailable())
      }
      void Promise.resolve(view.connection.input('quit')).then(value => {
        const exit = quietly(() => checkedExit(value))
        if (exit) observeExit(view, exit)
      }, reject)
    })
  }
  async function change(actor, wid, id, kind, body, verify) {
    const view = access(actor, wid, id, verify)
    const request = actionRequest(kind, body)
    if (!view.source) throw notFound()
    if (view.actionAbort || view.phase === 'disposing') throw busy()
    if (request.sequence === view.sequence && view.lastAck?.digest === request.digest) return { sequence: view.sequence }
    if (request.sequence !== view.sequence + 1) throw sequenceConflict()
    if (view.phase !== 'live') throw unavailable()
    consume(view); view.actionAbort = new AbortController(); view.touched = now()
    try {
      guard(view, verify)
      try { await within(actionTimeoutMs, view.actionAbort.signal, () => sendChange(view, request)) }
      catch {
        guard(view, verify)
        if (view.phase === 'live') void endConnection(view)
        throw unavailable()
      }
      guard(view, verify)
      view.sequence = request.sequence
      view.lastAck = { digest: request.digest }
      view.touched = now()
      return { sequence: view.sequence }
    } finally { view.actionAbort = null; view.quitWake = null }
  }

  return Object.freeze({
    async profiles(actor, verify) {
      requireOwner(actor, verify)
      if (!configured) return { available: false, profiles: [], reason: 'unconfigured' }
      if (probeWaiters >= MAX_PROBE_WAITERS) throw busy()
      probeWaiters++
      try {
        const available = await probe()
        requireOwner(actor, verify)
        return { available, profiles: available ? [profile] : [], reason: available ? null : 'unavailable' }
      } finally { probeWaiters-- }
    },
    async start(actor, wid, body, verify) {
      requireOwner(actor, verify)
      if (!validWorkspace(wid)) throw notFound()
      const request = startRequest(body)
      if (!configured) throw unavailable()
      const view = reserve(actor, wid)
      try {
        const available = await within(probeTimeoutMs + 1, view.abort.signal, probe)
        guard(view, verify)
        if (!available) throw unavailable()
        pinSource(view, request)
        guard(view, verify)
        const connection = await within(openTimeoutMs, view.abort.signal, () => startConnection(view, request))
        guard(view, verify)
        const screen = quietly(() => checkedScreen(connection.screen))
        if (!screen || screen.cols !== request.cols || screen.rows !== request.rows) throw unavailable()
        guard(view, verify)
        view.journal.screen(screen)
        view.phase = 'live'; view.published = true; view.touched = now()
        return { id: view.id, cursor: 1, sequence: 0, screen, exit: null }
      } catch (error) {
        // Cancellation may have won the await race; preserve only the current authority/source error.
        guard(view, verify)
        const publicError = sourceOpenError(error)
        abandon(view, publicError)
        throw publicError
      }
    },
    input(actor, wid, id, body, verify) { return change(actor, wid, id, 'input', body, verify) },
    resize(actor, wid, id, body, verify) { return change(actor, wid, id, 'resize', body, verify) },
    async events(actor, wid, id, body, verify, signal) {
      const view = access(actor, wid, id, verify)
      const { after, waitMs } = eventsRequest(body)
      if (!view.source) throw notFound()
      if (view.poll) throw busy()
      if (signal?.aborted) throw unavailable()
      let reply = view.journal.read(after)
      // Automatic reads/long polls do not renew the viewer's interaction lease.
      if (waitMs && after === reply.cursor && !view.exit) {
        try { await waitForViewer(view, waitMs, signal) }
        catch { guard(view, verify); throw unavailable() }
        finally { view.poll = null }
        guard(view, verify)
        if (!view.source) throw notFound()
        reply = view.journal.read(after)
      }
      guard(view, verify)
      return reply
    },
    async dispose(actor, wid, id, verify) {
      const view = access(actor, wid, id, verify)
      if (view.phase !== 'exited') {
        guard(view, verify)
        await endConnection(view)
      }
      guard(view, verify)
      scrub(view)
      return { closed: true, exit: view.exit }
    },
    close() {
      if (!closeJob) {
        closing = true
        quietly(() => unsubscribe())
        clearInterval(sweeper); sweeper = undefined
        sharedProbe?.abort.abort()
        sharedProbe = null
        for (const view of views.values()) abandon(view, unavailable())
        leases.clear()
        closeJob = Promise.allSettled([...cleanupJobs]).then(() => {})
      }
      return closeJob
    },
  })
}
