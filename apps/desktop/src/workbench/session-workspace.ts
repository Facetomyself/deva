import type { AttachedWorkspace, SessionWorkspaceTransport, WorkspaceBinding } from './session-workspace-transport'
import { HttpFailure } from './transport'
import type { WorkspaceOption } from './workspace-transport'

export type SessionWorkspaceIssue = 'conflict' | 'busy' | 'permission' | 'missing' | 'readOnly' | 'unavailable' |
  'choiceUnavailable' | 'storage' | 'invalid' | 'readFailure' | 'writeFailure' | 'catalogueFailure'
type Draft = { workspaceId: string | null; revision: string }
type ProjectAction = 'files' | 'notes'
type Operation = 'read' | 'write' | ProjectAction
export type WorkspaceAccess = { kind: ProjectAction; workspace: AttachedWorkspace; signal: AbortSignal }
export type SessionWorkspaceView = {
  sid?: string
  confirmed?: WorkspaceBinding
  projects?: WorkspaceOption[]
  draft?: Draft
  pending?: Operation
  issue?: SessionWorkspaceIssue
  catalogueIssue?: SessionWorkspaceIssue
  needsReview?: boolean
  access?: WorkspaceAccess
}
const EMPTY: SessionWorkspaceView = {}
export const emptySessionWorkspace = (): SessionWorkspaceView => EMPTY

function issueFor(error: unknown, fallback: SessionWorkspaceIssue): SessionWorkspaceIssue {
  if (error instanceof HttpFailure) {
    if (error.code === 'turn_in_progress') return 'busy'
    if (error.code === 'read_only_session' || error.code === 'unsupported_history') return 'readOnly'
    if (error.code === 'chat_storage_unconfirmed') return 'storage'
    if (error.code === 'workspace_unavailable' || error.code === 'workspace_changed' || error.status === 410) return 'unavailable'
    if (error.status === 403) return 'permission'
    if (error.status === 404) return 'missing'
    if (error.status === 409) return 'conflict'
    if (error.status === 400 || error.status === 422) return 'invalid'
  }
  return fallback
}

/** The workspace endpoint confirms authority. Summary/detail revisions only signal a recheck. */
export function createSessionWorkspace(api: SessionWorkspaceTransport, options: {
  beforeWrite: () => Promise<void>; expired: () => void; committed: () => void
}) {
  type Job = { sid: string; abort: AbortController }
  let view = EMPTY
  let job: Job | undefined
  let access: AbortController | undefined
  let writable = false
  let expired = false
  let recheck = false
  let hints: readonly [string | undefined, string | undefined] = [undefined, undefined]
  const drafts = new Map<string, Pick<SessionWorkspaceView, 'draft' | 'issue' | 'needsReview'>>()
  const listeners = new Set<() => void>()
  function replace(next: SessionWorkspaceView): void {
    view = next
    listeners.forEach((notify) => notify())
  }
  function put(patch: Partial<SessionWorkspaceView>): void { replace({ ...view, ...patch }) }
  function closeProject(): void {
    access?.abort()
    access = undefined
    if (view.access) put({ access: undefined })
  }
  function cancel(): void {
    job?.abort.abort()
    job = undefined
    closeProject()
  }
  function begin(sid: string, pending: Operation): Job {
    closeProject()
    const next = { sid, abort: new AbortController() }
    job = next
    put({ pending })
    return next
  }
  const current = (candidate: Job): boolean => job === candidate && !expired && view.sid === candidate.sid && !candidate.abort.signal.aborted
  function finish(candidate: Job): void {
    if (!current(candidate)) return
    job = undefined
    put({ pending: undefined })
    if (recheck) { recheck = false; void read(candidate.sid) }
  }
  function expire(error: unknown): boolean {
    if (!(error instanceof HttpFailure) || error.status !== 401) return false
    expired = true
    cancel()
    drafts.clear()
    replace(EMPTY)
    options.expired()
    return true
  }
  function report(error: unknown, fallback: SessionWorkspaceIssue, clearAuthority = false): void {
    if (expire(error)) return
    const issue = issueFor(error, fallback)
    put({ issue, needsReview: true, ...(clearAuthority && (issue === 'missing' || issue === 'permission') ? { confirmed: undefined } : {}) })
  }
  async function read(sid: string, explicit = false): Promise<void> {
    if (expired || view.sid !== sid || job) return
    const candidate = begin(sid, 'read')
    const signal = candidate.abort.signal
    try {
      const [binding, catalogue] = await Promise.allSettled([api.read(sid, signal), api.projects(signal)])
      if (!current(candidate)) return
      if (catalogue.status === 'rejected' && expire(catalogue.reason)) return
      if (binding.status === 'rejected') { report(binding.reason, 'readFailure', true); return }
      const confirmed = binding.value
      const projects = catalogue.status === 'fulfilled' ? catalogue.value : undefined
      const draft = view.draft
      const needsReview = !explicit && (!!view.needsReview || (!!draft && draft.revision !== confirmed.revision))
      const missingChoice = !!draft?.workspaceId && !!projects && !projects.some(({ id }) => id === draft.workspaceId)
      put({ confirmed, projects, draft: explicit && draft ? { ...draft, revision: confirmed.revision } : draft,
        needsReview, issue: needsReview ? view.issue ?? 'conflict' : missingChoice ? 'choiceUnavailable' : undefined,
        catalogueIssue: catalogue.status === 'rejected' ? issueFor(catalogue.reason, 'catalogueFailure') : undefined })
    } finally { finish(candidate) }
  }
  function watch(sid: string | undefined, listRevision: string | undefined, detailRevision: string | undefined, canWrite: boolean): void {
    if (expired) return
    writable = canWrite
    const next = [listRevision, detailRevision] as const
    const changed = next.some((hint, i) => hint !== hints[i] &&
      (hint === undefined || (hint !== view.confirmed?.revision && !hints.includes(hint))))
    hints = next
    if (view.sid !== sid) {
      if (view.sid && view.draft) drafts.set(view.sid, { draft: view.draft,
        needsReview: view.needsReview || view.pending === 'write',
        issue: view.pending === 'write' ? 'writeFailure' : view.issue })
      recheck = false
      cancel()
      const saved = sid ? drafts.get(sid) : undefined
      if (sid) drafts.delete(sid)
      view = { sid, ...saved }
      if (sid) void read(sid)
      else put({})
    } else if (sid && changed) {
      if (view.pending === 'write') { recheck = true; return }
      if (view.access || view.pending === 'notes' || view.pending === 'files') put({ issue: 'conflict', needsReview: true })
      cancel()
      void read(sid)
    }
  }
  function choose(sid: string, workspaceId: string | undefined): void {
    if (view.sid !== sid || !view.confirmed || job || (workspaceId && !view.projects?.some(({ id }) => id === workspaceId))) return
    const draft = workspaceId ? { workspaceId, revision: view.draft?.revision ?? view.confirmed.revision } : undefined
    put({ draft, ...(view.needsReview ? {} : { issue: undefined }) })
  }
  async function change(sid: string, detach = false): Promise<boolean> {
    const { confirmed, draft, needsReview, projects } = view
    const workspaceId = detach ? null : draft?.workspaceId
    if (view.sid !== sid || expired || !writable || job || needsReview || !confirmed || workspaceId === undefined ||
        (workspaceId === null ? !detach || !confirmed.workspace : workspaceId === confirmed.workspace?.id || !projects?.some(({ id }) => id === workspaceId))) return false
    const revision = detach ? confirmed.revision : draft!.revision
    if (revision !== confirmed.revision) { put({ issue: 'conflict', needsReview: true }); return false }
    const candidate = begin(sid, 'write')
    put({ draft: { workspaceId, revision }, issue: undefined })
    try {
      await options.beforeWrite()
      if (!current(candidate)) return false
      if (!writable) { put({ issue: 'busy', needsReview: true }); return false }
      const next = await api.patch(sid, revision, workspaceId, candidate.abort.signal)
      if (!current(candidate)) return false
      put({ confirmed: next, draft: undefined, issue: undefined, needsReview: false })
      options.committed()
      return true
    } catch (error) {
      if (current(candidate)) report(error, 'writeFailure')
      return false
    } finally { finish(candidate) }
  }
  async function open(sid: string, kind: ProjectAction, prepare?: (approved: WorkspaceAccess) => Promise<boolean>): Promise<boolean> {
    const prior = view.confirmed
    if (view.sid !== sid || expired || job || view.needsReview || prior?.workspace?.state !== 'available') return false
    const candidate = begin(sid, kind)
    const signal = candidate.abort.signal
    try {
      const binding = await api.read(sid, signal)
      if (!current(candidate)) return false
      const workspace = binding.workspace
      if (workspace?.id !== prior.workspace.id || workspace.state !== 'available' || binding.revision !== prior.revision) {
        put({ confirmed: binding, issue: workspace?.state === 'unavailable' || !workspace ? 'unavailable' : 'conflict', needsReview: true })
        return false
      }
      const approved = { kind, workspace, signal }
      if (prepare) {
        const ready = await prepare(approved)
        if (!current(candidate)) return false
        if (!ready) { put({ issue: 'unavailable', needsReview: true }); return false }
      }
      access = candidate.abort
      put({ confirmed: binding, access: approved })
      return true
    } catch (error) {
      if (current(candidate)) report(error, 'readFailure', true)
      return false
    } finally {
      finish(candidate)
      if (access !== candidate.abort) candidate.abort.abort()
    }
  }
  return {
    snapshot: () => view,
    subscribe(notify: () => void) { listeners.add(notify); return () => { listeners.delete(notify) } },
    watch, choose, change, open, closeProject,
    refresh: (sid: string) => read(sid, true),
    pause() { watch(undefined, undefined, undefined, false) }
  }
}
export type SessionWorkspaceController = ReturnType<typeof createSessionWorkspace>