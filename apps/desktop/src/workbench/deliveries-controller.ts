import type { ChatState } from './chat-transport'
import { HttpFailure } from './transport'
import type { DeliveriesTransport, DeliveryCandidate, DeliveryFormat, DeliveryGroup, DeliveryLocation, DeliveryRef } from './deliveries-transport'

export type DeliveryIssue = 'permission' | 'missing' | 'changed' | 'failure' | 'clipboard' | 'previewFailed' | 'workspaceMissing' |
  'tooLarge' | 'unsupported' | 'busy' | 'notExportable'
type Feedback = { issue: DeliveryIssue } | { success: 'created' | 'existing' | 'download' | 'copied' }
type ItemAction = 'download' | 'preview' | 'locate' | 'copy'
type Action = { type: 'export'; turnId: string; format: DeliveryFormat } | { type: ItemAction; gid: string; index: number }
export type DeliveryPreview = DeliveryRef & { name: string; url: string }
export interface DeliveriesState {
  sid?: string
  authority?: string
  groups: DeliveryGroup[]
  candidates: DeliveryCandidate[]
  nextCursor: string | null
  loading?: 'first' | 'more'
  issue?: DeliveryIssue
  feedback?: Feedback
  pending?: Action
  preview?: DeliveryPreview
}
interface Options {
  beforeWrite: () => Promise<void>
  expired: () => void
  objectUrl: (blob: Blob) => string
  revokeUrl: (url: string) => void
  deferRelease: (release: () => void) => () => void
  saveDownload: (url: string, name: string) => void
  copyName: (name: string) => Promise<void>
  openWorkspace?: (where: DeliveryLocation, signal: AbortSignal) => Promise<boolean>
}
interface ListJob { scope: string; authority: string; abort: AbortController }
interface ActionJob { scope: string; abort: AbortController; ref?: DeliveryRef; authority?: string }

const empty = (sid?: string): DeliveriesState => ({ sid, groups: [], candidates: [], nextCursor: null })
export const emptyDeliveries = empty()

/** The collection associates a server turn ID with a message; a transcript row alone grants nothing. */
export function eligibleDeliveryReplies(state: Pick<ChatState, 'compatibility' | 'messages' | 'active' | 'lastTurn'> | undefined,
  pending: boolean, authority: string | undefined, deliveries: DeliveriesState): ReadonlyMap<number, DeliveryCandidate> {
  const eligible = new Map<number, DeliveryCandidate>()
  if (!authority || authority !== deliveries.authority || deliveries.loading === 'first' || deliveries.issue === 'permission' ||
      state?.compatibility !== 'text' || state.active || pending) return eligible
  for (const candidate of deliveries.candidates) {
    const { messageIndex, turnId } = candidate
    const message = state.messages?.[messageIndex]
    const last = state.lastTurn
    if (message?.role === 'assistant' && message.content.trim() &&
        (last?.turnId !== turnId || (last.status === 'completed' && last.reason === null))) eligible.set(messageIndex, candidate)
  }
  return eligible
}

function issue(error: unknown): DeliveryIssue {
  if (!(error instanceof HttpFailure)) return 'failure'
  if (error.status === 401 || error.status === 403) return 'permission'
  if (error.code === 'reply_not_exportable') return 'notExportable'
  if (error.code === 'turn_in_progress' || error.status === 429) return 'busy'
  if (error.code === 'delivery_no_location') return 'workspaceMissing'
  if (error.status === 404 || error.status === 410) return 'missing'
  if (error.status === 413) return 'tooLarge'
  if (error.status === 415) return 'unsupported'
  if ([409, 412, 428].includes(error.status)) return 'changed'
  return 'failure'
}
function mergeGroups(prior: DeliveryGroup[], next: DeliveryGroup[]): DeliveryGroup[] {
  const map = new Map(prior.map((group) => [group.id, group]))
  for (const group of next) map.set(group.id, group)
  return [...map.values()]
}

/** One active session; every async publication and browser side effect requires the current job identity. */
export function createDeliveriesController(api: DeliveriesTransport, options: Options) {
  const listeners = new Set<() => void>()
  const downloads = new Map<string, () => void>()
  let view = emptyDeliveries
  let listJob: ListJob | undefined
  let actionJob: ActionJob | undefined

  function publish(next: DeliveriesState): void {
    view = next
    listeners.forEach((listener) => listener())
  }
  function patch(update: Partial<DeliveriesState>): void { publish({ ...view, ...update }) }
  const item = (gid: string, index: number) => view.groups.find((group) => group.id === gid)?.items.find((entry) => entry.index === index)
  function releaseDownload(url: string): void {
    const cancel = downloads.get(url)
    downloads.delete(url)
    cancel?.()
    options.revokeUrl(url)
  }
  function closePreview(failed = false, expectedUrl?: string): void {
    if (!view.preview || (expectedUrl !== undefined && view.preview.url !== expectedUrl)) return
    options.revokeUrl(view.preview.url)
    patch({ preview: undefined, ...(failed ? { feedback: { issue: 'previewFailed' } as const } : {}) })
  }
  function cancelList(): void { listJob?.abort.abort(); listJob = undefined }
  function cancelAction(): void { actionJob?.abort.abort(); actionJob = undefined }
  function reset(sid?: string): void {
    cancelList()
    cancelAction()
    if (view.preview) options.revokeUrl(view.preview.url)
    for (const url of downloads.keys()) releaseDownload(url)
    publish(empty(sid))
  }
  function select(sid?: string): void { if (view.sid !== sid) reset(sid) }
  function lostAuthorization(error: unknown): boolean {
    if (!(error instanceof HttpFailure) || (error.status !== 401 && error.status !== 403)) return false
    reset(view.sid)
    patch({ issue: 'permission' })
    if (error.status === 401 || error.code === 'csrf_failed') options.expired()
    return true
  }

  async function read(authority: string, more = false, afterCursorReset = false): Promise<void> {
    const scope = view.sid
    const cursor = more ? view.nextCursor : undefined
    if (!scope || (more && (!cursor || listJob || view.authority !== authority))) return
    cancelList()
    const staleExport = actionJob?.authority !== undefined && actionJob.authority !== authority
    if (staleExport) cancelAction()
    const job = { scope, authority, abort: new AbortController() }
    listJob = job
    patch({ loading: more ? 'more' : 'first', issue: afterCursorReset ? 'changed' : undefined,
      ...(staleExport ? { pending: undefined, feedback: { issue: 'notExportable' } as const } : {}) })
    const current = (): boolean => listJob === job && view.sid === scope && !job.abort.signal.aborted
    try {
      const page = await api.list(scope, cursor ?? undefined, job.abort.signal)
      if (!current()) return
      if (cursor && page.nextCursor === cursor) throw new Error('Repeated delivery cursor')
      const groups = more ? mergeGroups(view.groups, page.groups) : page.groups
      const same = (ref: DeliveryRef): boolean => groups.find((group) => group.id === ref.gid)?.items
        .some((entry) => entry.index === ref.index && entry.revision === ref.revision) === true
      const preview = view.preview
      if (preview && !same(preview)) options.revokeUrl(preview.url)
      const staleAction = actionJob?.ref && !same(actionJob.ref)
      if (staleAction) cancelAction()
      patch({ authority, groups, candidates: page.candidates, nextCursor: page.nextCursor, loading: undefined,
        preview: preview && same(preview) ? preview : undefined,
        ...(staleAction ? { pending: undefined, feedback: { issue: 'changed' } as const } : {}) })
    } catch (error) {
      if (!current() || lostAuthorization(error)) return
      if (cursor && error instanceof HttpFailure && error.status === 409) {
        listJob = undefined
        await read(authority, false, true)
        return
      }
      const status = issue(error)
      if (status === 'missing' && !more) reset(scope)
      patch({ loading: undefined, issue: status, ...(!more ? { authority: undefined, candidates: [], nextCursor: null } : {}) })
    } finally {
      if (listJob === job) listJob = undefined
    }
  }

  function begin(pending: Action, ref?: DeliveryRef, authority?: string): ActionJob | undefined {
    if (!view.sid || actionJob || view.issue === 'permission') return
    const job: ActionJob = { scope: view.sid, abort: new AbortController(), ref, authority }
    actionJob = job
    patch({ pending, feedback: undefined })
    return job
  }
  function active(job: ActionJob): boolean {
    return actionJob === job && view.sid === job.scope && !job.abort.signal.aborted &&
      (!job.ref || item(job.ref.gid, job.ref.index)?.revision === job.ref.revision)
  }
  function finish(job: ActionJob): void {
    if (actionJob !== job) return
    actionJob = undefined
    patch({ pending: undefined })
  }
  function report(job: ActionJob, error: unknown, fallback?: DeliveryIssue): void {
    if (!active(job) || lostAuthorization(error)) return
    patch({ feedback: { issue: error instanceof HttpFailure ? issue(error) : fallback ?? 'failure' } })
  }

  async function exportReply(candidate: DeliveryCandidate, format: DeliveryFormat, authority: string): Promise<void> {
    if (!view.sid || actionJob || view.issue === 'permission') return
    if (view.authority !== authority || view.loading === 'first' || !view.candidates.some((entry) =>
      entry.turnId === candidate.turnId && entry.messageIndex === candidate.messageIndex)) {
      patch({ feedback: { issue: 'notExportable' } })
      return
    }
    const job = begin({ type: 'export', turnId: candidate.turnId, format }, undefined, authority)
    if (!job) return
    try {
      await options.beforeWrite()
      if (!active(job) || view.authority !== authority || (listJob && listJob.authority !== authority)) return
      const { created, group } = await api.exportReply(job.scope, candidate.turnId, format, job.abort.signal)
      if (!active(job)) return
      if (group.messageIndex !== candidate.messageIndex) throw new Error('Mismatched delivery message')
      cancelList()
      patch({ groups: mergeGroups(view.groups, [group]), loading: undefined, feedback: { success: created ? 'created' : 'existing' } })
    } catch (error) { report(job, error) } finally { finish(job) }
  }

  async function runItem(type: ItemAction, gid: string, index: number): Promise<void> {
    if (!view.sid || actionJob || view.issue === 'permission') return
    const entry = item(gid, index)
    if (!entry) { patch({ feedback: { issue: 'missing' } }); return }
    const ref = entry.revision ? { gid, index, revision: entry.revision } : undefined
    if (type === 'download' && (!ref || !entry.canDownload || entry.size === null) ||
        type === 'preview' && (!ref || !entry.canPreview || entry.size === null) ||
        type === 'locate' && (!ref || !entry.canLocate || !options.openWorkspace)) return
    // Only an explicit click starts a new preview. This also releases any previously shown image.
    if (type === 'preview') closePreview()
    const job = begin({ type, gid, index }, ref)
    if (!job) return
    const signal = job.abort.signal
    try {
      if (type === 'copy') {
        await options.copyName(entry.name)
        if (active(job)) patch({ feedback: { success: 'copied' } })
      } else if (type === 'locate') {
        const location = await api.locate(job.scope, ref!, signal)
        if (!active(job)) return
        const opened = await options.openWorkspace!(location, signal)
        if (active(job) && !opened) patch({ feedback: { issue: 'workspaceMissing' } })
      } else {
        const binary = await api[type](job.scope, ref!, entry.size!, signal)
        if (!active(job)) return
        const url = options.objectUrl(binary)
        if (type === 'preview') {
          patch({ preview: { ...ref!, name: entry.name, url } })
        } else {
          try {
            options.saveDownload(url, entry.name)
            downloads.set(url, options.deferRelease(() => releaseDownload(url)))
            patch({ feedback: { success: 'download' } })
          } catch (error) { options.revokeUrl(url); throw error }
        }
      }
    } catch (error) { report(job, error, type === 'copy' ? 'clipboard' : type === 'preview' ? 'previewFailed' : undefined) }
    finally { finish(job) }
  }

  return {
    snapshot: () => view,
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } },
    select, read, exportReply, runItem, closePreview,
    dismiss() { patch({ feedback: undefined }) }
  }
}
export type DeliveriesController = ReturnType<typeof createDeliveriesController>
