import { HttpFailure } from './transport'
import type { WorkspaceFiles, WorkspaceFilesView } from './workspace-files'
import { isTerminalKey, isTerminalPath, isTerminalRevision, isTerminalSize, isTerminalWorkspace, TERMINAL_DEFAULT_SIZE, TERMINAL_WAIT_MS,
  type TerminalExit, type TerminalKey, type TerminalScreen, type TerminalSize, type TerminalTarget, type TerminalViewTransport } from './terminal-view-transport'

type Issue = 'auth' | 'unavailable' | 'unconfigured' | 'stale' | 'disconnected' | 'uncertain' | 'failure' |
  'limit' | 'unsupported' | 'sourceDenied'
export type TerminalViewState = { phase: 'closed' } | {
  phase: 'loading' | 'active' | 'pending' | 'reconnecting' | 'exited' | 'error'
  target: TerminalTarget; screen?: TerminalScreen; exit?: TerminalExit; issue?: Issue; requestedSize?: TerminalSize
}
type Ticket = {
  target: TerminalTarget; abort: AbortController; id?: string; cursor: number; sequence: number; screen?: TerminalScreen
  requestedSize: TerminalSize; pending?: boolean; quitting?: boolean; disconnected?: boolean; exited?: boolean; lastKeyAt?: number
}
const closed: TerminalViewState = { phase: 'closed' }
const KEY_INTERVAL_MS = 75
// A lost reply can leave one server-side wait outstanding for up to TERMINAL_WAIT_MS.
const RETRY_MS = [250, 500, 1_000, 2_000, 2_000]

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return }
    const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}
const runtime = { now: () => performance.now(), delay }

export function terminalTarget(view: WorkspaceFilesView): TerminalTarget | undefined {
  const { file, projectId } = view
  if (view.issue || view.dirty || !file || file.pending || file.issue || file.needsReload || file.review ||
      file.disk?.kind !== 'text' || file.disk.path !== file.path || !isTerminalPath(file.path) || !isTerminalRevision(file.disk.revision) ||
      !isTerminalWorkspace(projectId) || !view.projects.data?.some(project => project.id === projectId)) return
  return { workspaceId: projectId, path: file.path, revision: file.disk.revision }
}
export function sameTerminalTarget(a?: TerminalTarget, b?: TerminalTarget): boolean {
  return a?.workspaceId === b?.workspaceId && a?.path === b?.path && a?.revision === b?.revision
}
function issueOf(error: unknown): Issue | undefined {
  if (!(error instanceof HttpFailure)) return
  if (error.status === 401 || error.code === 'csrf_failed') return 'auth'
  if (error.code === 'terminal_source_changed' || error.code === 'workspace_replaced') return 'stale'
  if (error.status === 413 && error.code === 'terminal_limit') return 'limit'
  if (error.status === 422 && error.code === 'terminal_unsupported') return 'unsupported'
  if (error.status === 403 && error.code === 'terminal_source_denied') return 'sourceDenied'
  if (error.status === 409 && (error.code === 'terminal_sequence' || error.code === 'terminal_cursor')) return 'uncertain'
  if (error.status === 403 || error.status === 404 || error.status === 410) return 'unavailable'
  return
}

/** A launch owns a fixed workspace, file revision, handle, abort generation, and read cursor. */
export function createTerminalView(api: TerminalViewTransport, onExpired: () => void, clock: typeof runtime = runtime) {
  let view = closed
  let target: TerminalTarget | undefined
  let current: Ticket | undefined
  const listeners = new Set<() => void>()
  function publish(next: TerminalViewState): void {
    view = next
    listeners.forEach(notify => notify())
  }
  function dispose({ workspaceId }: TerminalTarget, id: string): void {
    void api.dispose(workspaceId, id).catch(() => { /* Best effort; never repeat or adopt the new project. */ })
  }
  function detach(ticket: Ticket): void {
    if (current !== ticket) return
    current = undefined
    ticket.abort.abort()
    ticket.screen = undefined
    if (ticket.id) dispose(ticket.target, ticket.id)
  }
  function dismiss(): void {
    if (current) detach(current)
    if (view !== closed) publish(closed)
  }
  function selectTarget(next?: TerminalTarget): void {
    if (sameTerminalTarget(target, next)) return
    target = next && { ...next }
    dismiss()
  }
  function fail(ticket: Ticket, issue: Issue): void {
    if (current !== ticket) return
    detach(ticket)
    publish({ phase: 'error', target: ticket.target, issue })
    if (issue === 'auth') onExpired()
  }
  function disconnect(): void {
    if (current) fail(current, 'disconnected')
  }
  function live(ticket: Ticket): void {
    if (current !== ticket) return
    publish({ phase: ticket.disconnected ? 'reconnecting' : ticket.pending || ticket.quitting ? 'pending' : 'active',
      target: ticket.target, ...(ticket.disconnected ? {} : { screen: ticket.screen }), requestedSize: ticket.requestedSize })
  }
  function exited(ticket: Ticket, exit: TerminalExit): void {
    ticket.exited = true
    ticket.abort.abort()
    // The process is already stopped. Retain its receipt until the user dismisses the panel.
    publish({ phase: 'exited', target: ticket.target, screen: ticket.screen, exit })
  }
  async function poll(ticket: Ticket, id: string): Promise<void> {
    const { signal } = ticket.abort
    let failures = 0
    while (current === ticket) {
      const started = clock.now()
      try {
        const data = await api.events(ticket.target.workspaceId, id, ticket.cursor, TERMINAL_WAIT_MS, signal)
        if (current !== ticket) return
        failures = 0
        ticket.cursor = data.cursor
        if (data.reset) ticket.screen = undefined
        for (const event of data.events) {
          if (event.type === 'exit') { exited(ticket, event.exit); return }
          ticket.screen = event.screen
        }
        if (ticket.disconnected || data.reset || data.events.length) {
          ticket.disconnected = false
          live(ticket)
        }
        // A real long poll waits up to five seconds; cap the rate of immediate empty receipts, too.
        if (data.events.length === 0 && clock.now() - started < 100) await clock.delay(100, signal)
      } catch (error) {
        if (current !== ticket) return
        const issue = issueOf(error)
        const transient = error instanceof TypeError || (error instanceof HttpFailure && (error.status === 429 || error.status >= 500))
        if (issue || !transient) { fail(ticket, issue ?? 'failure'); return }
        if (failures === RETRY_MS.length) { fail(ticket, 'disconnected'); return }
        ticket.disconnected = true
        live(ticket)
        await clock.delay(RETRY_MS[failures++], signal)
        // Retry only the event read, from the last successfully decoded cursor.
      }
    }
  }
  async function open(selected: TerminalTarget): Promise<void> {
    if (!target || !sameTerminalTarget(target, selected) || view.phase !== 'closed') return
    const ticket: Ticket = { target: { ...target }, abort: new AbortController(), cursor: 0, sequence: 0, requestedSize: TERMINAL_DEFAULT_SIZE }
    current = ticket
    publish({ phase: 'loading', target: ticket.target })
    if (current !== ticket) return
    let creating = false
    try {
      const profiles = await api.profiles(ticket.abort.signal)
      if (current !== ticket) return
      if (!profiles.available) { fail(ticket, profiles.reason ?? 'unavailable'); return }
      creating = true
      const receipt = await api.start(ticket.target, TERMINAL_DEFAULT_SIZE)
      if (current !== ticket) { dispose(ticket.target, receipt.id); return }
      ticket.id = receipt.id
      ticket.cursor = receipt.cursor
      ticket.sequence = receipt.sequence
      ticket.screen = receipt.screen
      live(ticket)
      void poll(ticket, receipt.id)
    } catch (error) {
      if (current !== ticket) return
      const confirmedFailure = error instanceof HttpFailure && error.status >= 400 && error.status < 500
      fail(ticket, issueOf(error) ?? (creating && !confirmedFailure ? 'uncertain' : 'failure'))
    }
  }
  async function mutate(action: { key: TerminalKey } | { size: TerminalSize }): Promise<void> {
    const ticket = current
    const id = ticket?.id
    if (!ticket || !id || view.phase !== 'active') return
    if ('key' in action && !isTerminalKey(action.key)) return
    if ('size' in action && !isTerminalSize(action.size)) return
    const key = 'key' in action ? action.key : undefined
    if (key !== undefined) {
      if (key !== 'quit') {
        const now = clock.now()
        if (ticket.lastKeyAt !== undefined && now - ticket.lastKeyAt < KEY_INTERVAL_MS) return
        ticket.lastKeyAt = now
      }
    }
    const size = 'size' in action ? { cols: action.size.cols, rows: action.size.rows } : undefined
    ticket.pending = true
    ticket.quitting = key === 'quit'
    live(ticket)
    if (current !== ticket) return
    const sequence = ticket.sequence + 1
    const { signal } = ticket.abort
    try {
      const result = size ? await api.resize(ticket.target.workspaceId, id, sequence, size, signal) :
        await api.input(ticket.target.workspaceId, id, sequence, key!, signal)
      if (current !== ticket || ticket.exited) return
      if (result.sequence !== sequence) { fail(ticket, 'uncertain'); return }
      ticket.sequence = sequence
      if (size) ticket.requestedSize = size
      ticket.pending = false
      live(ticket)
    } catch (error) {
      if (!ticket.exited) fail(ticket, issueOf(error) ?? 'uncertain')
    }
  }
  return {
    snapshot: () => view,
    subscribe(notify: () => void): () => void { listeners.add(notify); return () => { listeners.delete(notify) } },
    selectTarget, open, dismiss, disconnect,
    key: (key: TerminalKey) => mutate({ key }), resize: (size: TerminalSize) => mutate({ size })
  }
}
export type TerminalView = ReturnType<typeof createTerminalView>

/** Take file/project invalidation synchronously from the actual selector; this binding never starts the viewer. */
export function bindTerminalView(viewer: TerminalView, files: WorkspaceFiles): () => void {
  const sync = (): void => viewer.selectTarget(terminalTarget(files.snapshot()))
  const unsubscribe = files.subscribe(sync)
  sync()
  return () => { unsubscribe(); viewer.selectTarget(undefined) }
}
