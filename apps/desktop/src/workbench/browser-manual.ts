import { newViewerNonce, type BrowserAction, type BrowserProof, type BrowserSite, type BrowserTab, type BrowserTransport, type FinishIntent, type WorkerState } from './browser-transport'
import { HttpFailure } from './transport'

const FRAME_DELAY_MS = 500
const QUEUE_LIMIT = 16

type Phase = 'checking' | 'idle' | 'opening' | 'claiming' | 'controlling' | 'finishing' | 'closing'
type Notice = 'request-failed' | 'claim-failed' | 'frame-failed' | 'input-unconfirmed' | 'finish-unconfirmed' |
  'paused' | 'expired' | 'done' | 'skipped' | 'queue-full'
export type BrowserView = {
  worker?: WorkerState
  phase: Phase
  notice?: Notice
  sites: readonly BrowserSite[]
  tab?: BrowserTab
  frame?: string
}
type Timer = ReturnType<typeof setTimeout>
type Lease = {
  tabId: string; proof: BrowserProof; abort: AbortController; deadline: number; seq: number
  queue: BrowserAction[]; draining: boolean; poll?: Timer; expiry?: Timer
}
type Panel = { abort: AbortController; loading: boolean; lease?: Lease; claim?: { interrupted: boolean } }
const INITIAL: BrowserView = { phase: 'checking', sites: [] }

type BrowserRuntime = {
  nonce: () => string
  now: () => number
  objectUrl: (frame: Blob) => string
  revokeUrl: (url: string) => void
  delay: (run: () => void, ms: number) => Timer
  cancel: (id: Timer | undefined) => void
}
const defaults: BrowserRuntime = {
  nonce: newViewerNonce,
  now: () => performance.now(),
  objectUrl: (frame) => URL.createObjectURL(frame),
  revokeUrl: (url) => URL.revokeObjectURL(url),
  delay: (run, ms) => setTimeout(run, ms),
  cancel: (id) => clearTimeout(id)
}

/** One controller per mounted panel and chat. The view never contains a proof or input payload. */
export function createManualBrowserPanel(api: BrowserTransport, sid: string, onExpired: () => void, runtime: BrowserRuntime = defaults) {
  let panel: Panel | undefined
  let view = INITIAL
  const listeners = new Set<() => void>()
  const current = (scope: Panel): boolean => panel === scope

  function update(patch: Partial<BrowserView>): void {
    view = { ...view, ...patch }
    for (const listener of listeners) listener()
  }

  function takeLease(scope: Panel): Lease | undefined {
    const lease = scope.lease
    scope.lease = undefined
    if (lease) {
      lease.queue.length = 0
      runtime.cancel(lease.poll)
      runtime.cancel(lease.expiry)
      lease.abort.abort()
    }
    if (view.frame) runtime.revokeUrl(view.frame)
    return lease
  }

  function dispose(releaseLease = true): void {
    const scope = panel
    if (!scope) return
    panel = undefined
    scope.abort.abort()
    if (scope.claim) scope.claim.interrupted = true
    const lease = takeLease(scope)
    view = INITIAL
    // Safety release only; it has no completion handler that can publish into the old chat.
    if (lease && releaseLease) void api.finish(sid, lease.tabId, lease.proof, 'skip').catch(() => {})
  }

  function loggedOut(error: unknown): boolean {
    if (!(error instanceof HttpFailure) || error.status !== 401) return false
    dispose(false)
    onExpired()
    return true
  }

  async function load(): Promise<void> {
    const scope = panel ?? (panel = { abort: new AbortController(), loading: false })
    const signal = scope.abort.signal
    if (scope.loading || scope.lease || (view.phase !== 'checking' && view.phase !== 'idle')) return
    scope.loading = true
    update({ ...INITIAL, worker: undefined, notice: undefined, tab: undefined, frame: undefined })
    try {
      const worker = await api.status(signal)
      if (!current(scope)) return
      if (worker !== 'ready') { update({ worker, phase: 'idle' }); return }
      const [sites, tabs] = await Promise.all([api.sites(signal), api.tabs(sid, signal)])
      if (current(scope)) update({ worker, sites, tab: tabs[0], phase: 'idle' })
    } catch (error) {
      if (current(scope) && !loggedOut(error)) update({ worker: 'worker-unavailable', phase: 'idle' })
    } finally { scope.loading = false }
  }

  async function open(siteId: string): Promise<void> {
    const scope = panel
    const site = view.sites.find((entry) => entry.id === siteId)
    if (!scope || view.worker !== 'ready' || view.phase !== 'idle' || view.tab || !site) return
    update({ phase: 'opening', notice: undefined })
    try {
      const tab = await api.open(sid, site, scope.abort.signal)
      if (current(scope)) update({ tab, phase: 'idle' })
    } catch (error) {
      if (current(scope) && !loggedOut(error)) update({ phase: 'idle', notice: 'request-failed' })
    }
  }

  async function release(scope: Panel, lease: Pick<Lease, 'tabId' | 'proof'>, intent: FinishIntent, notice: Notice): Promise<void> {
    if (current(scope)) update({ frame: undefined, phase: 'finishing', notice: undefined })
    try {
      const tab = await api.finish(sid, lease.tabId, lease.proof, intent)
      if (current(scope)) update({ tab, phase: 'idle', notice })
    } catch (error) {
      if (current(scope) && !loggedOut(error)) update({ phase: 'idle', notice: 'finish-unconfirmed' })
    }
  }

  function end(scope: Panel, intent: FinishIntent, notice: Notice): void {
    const lease = takeLease(scope)
    if (lease) void release(scope, lease, intent, notice)
  }

  function live(scope: Panel, lease: Lease): boolean {
    if (!current(scope) || scope.lease !== lease) return false
    if (runtime.now() < lease.deadline) return true
    end(scope, 'skip', 'expired')
    return false
  }

  async function capture(scope: Panel, lease: Lease): Promise<void> {
    if (!live(scope, lease)) return
    try {
      const frame = await api.frame(sid, lease.tabId, lease.proof, lease.abort.signal)
      if (!live(scope, lease)) return
      const url = runtime.objectUrl(frame)
      if (view.frame) runtime.revokeUrl(view.frame)
      update({ frame: url })
      if (live(scope, lease)) lease.poll = runtime.delay(() => void capture(scope, lease), FRAME_DELAY_MS)
    } catch (error) {
      if (live(scope, lease) && !loggedOut(error)) end(scope, 'skip', 'frame-failed')
    }
  }

  async function claim(): Promise<void> {
    const scope = panel
    const tab = view.tab
    if (!scope || !tab || view.worker !== 'ready' || view.phase !== 'idle') return
    const claim = scope.claim = { interrupted: false }
    update({ phase: 'claiming', notice: undefined })
    try {
      const viewerNonce = runtime.nonce()
      const started = runtime.now()
      // Keep this one in-flight request observable so a late receipt can be released, never displayed.
      const { token, ttlMs } = await api.lease(sid, tab.tabId, viewerNonce)
      const deadline = started + ttlMs
      const proof = { viewerNonce, token }
      if (!current(scope) || claim.interrupted || runtime.now() >= deadline) {
        await release(scope, { tabId: tab.tabId, proof }, 'skip', claim.interrupted ? 'paused' : 'expired')
        return
      }
      const lease: Lease = { tabId: tab.tabId, proof, deadline, abort: new AbortController(), queue: [], draining: false, seq: 1 }
      scope.lease = lease
      lease.expiry = runtime.delay(() => { if (current(scope) && scope.lease === lease) end(scope, 'skip', 'expired') }, deadline - runtime.now())
      update({ tab: { ...tab, state: 'leased' }, phase: 'controlling' })
      void capture(scope, lease)
    } catch (error) {
      if (current(scope) && !loggedOut(error)) update({ phase: 'idle', notice: 'claim-failed' })
    } finally { if (scope.claim === claim) scope.claim = undefined }
  }

  async function drain(scope: Panel, lease: Lease): Promise<void> {
    if (lease.draining) return
    lease.draining = true
    try {
      while (live(scope, lease)) {
        const action = lease.queue.shift()
        if (!action) break
        const seq = lease.seq++
        await api.input(sid, lease.tabId, lease.proof, seq, action, lease.abort.signal)
      }
      if (current(scope) && scope.lease === lease && view.notice === 'queue-full') update({ notice: undefined })
    } catch (error) {
      // An unconfirmed ack is never replayed, and all following gestures are discarded.
      if (live(scope, lease) && !loggedOut(error)) end(scope, 'skip', 'input-unconfirmed')
    } finally { lease.draining = false }
  }

  function input(action: BrowserAction): boolean {
    const scope = panel
    const lease = scope?.lease
    if (!scope || !lease || !view.frame || !live(scope, lease)) return false
    if (lease.queue.length >= QUEUE_LIMIT) { update({ notice: 'queue-full' }); return false }
    lease.queue.push(action)
    void drain(scope, lease)
    return true
  }

  async function close(): Promise<void> {
    const scope = panel
    const tab = view.tab
    if (!scope || !tab || view.worker !== 'ready' || (view.phase !== 'idle' && view.phase !== 'controlling')) return
    takeLease(scope)
    update({ frame: undefined, phase: 'closing', notice: undefined })
    try {
      await api.close(sid, tab.tabId, scope.abort.signal)
      if (current(scope)) update({ phase: 'idle', tab: undefined })
    } catch (error) {
      if (current(scope) && !loggedOut(error)) update({ phase: 'idle', notice: 'request-failed' })
    }
  }

  return {
    load, open, claim, input, close, dispose,
    suspend(): void {
      if (!panel) return
      if (panel.claim) panel.claim.interrupted = true
      end(panel, 'skip', 'paused')
    },
    finish(intent: FinishIntent): void {
      if (panel?.lease) end(panel, intent, intent === 'done' ? 'done' : 'skipped')
    },
    frameFailed(url: string): void {
      if (panel?.lease && view.frame === url) end(panel, 'skip', 'frame-failed')
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    snapshot: () => view
  }
}

export type ManualBrowserPanel = ReturnType<typeof createManualBrowserPanel>
