import { HttpFailure } from './transport'
import type { WorkspaceFiles, WorkspaceFilesView } from './workspace-files'
import { GIT_LOG_MAX, GIT_LOG_STEP, type GitBranches, type GitDiff, type GitDiffRequest, type GitLog,
  type GitRepoState, type GitSide, type GitStatus, type GitViewTransport } from './git-view-transport'

type Tab = 'changes' | 'branches' | 'history'
type Action = 'status' | 'branches' | 'log' | 'diff'
export type GitIssue = 'auth' | 'origin' | 'csrf' | 'not_granted' | 'workspace_unavailable' | 'unsafe' |
  'stale' | 'busy' | 'budget' | 'unsupported_layout' | 'incomplete' | 'unavailable' | 'failure'
type Block = 'auth' | 'origin' | 'csrf' | 'not_granted' | 'workspace_unavailable' | 'unsafe'
export type GitViewState = {
  workspaceId?: string; open: boolean; tab: Tab; pending?: Action; issue?: GitIssue; stale?: boolean;
  status?: GitStatus; branches?: GitBranches; log?: GitLog; limit: number;
  selection?: GitDiffRequest; diff?: GitDiff
}

function classify(error: unknown, action: Action): GitIssue {
  if (!(error instanceof HttpFailure)) return 'failure'
  if (error.status === 401) return 'auth'
  if (error.status === 403) {
    if (error.code === 'origin') return 'origin'
    if (error.code === 'git_not_granted') return 'not_granted'
    if (error.code === 'git_unsafe') return 'unsafe'
    return error.code === 'csrf_failed' ? 'csrf' : 'not_granted'
  }
  if (error.status === 404 || error.status === 410) return 'workspace_unavailable'
  if (error.status === 409) return error.code === 'git_stale' || (action === 'diff' && !error.code) ? 'stale' : 'busy'
  if (error.status === 413 || error.status === 429 || error.code === 'git_timeout') return 'budget'
  if (error.code === 'unsupported_git_layout') return 'unsupported_layout'
  if (error.status === 422) return 'incomplete'
  if (error.status === 503) return 'unavailable'
  return 'failure'
}
function blocked(issue: GitIssue): issue is Block {
  return issue === 'auth' || issue === 'origin' || issue === 'csrf' || issue === 'not_granted' || issue === 'workspace_unavailable' || issue === 'unsafe'
}
function baseline(workspaceId?: string, open = false): GitViewState {
  return { workspaceId, open, tab: 'changes', limit: GIT_LOG_STEP }
}
export function hasGitData(state?: GitRepoState): boolean { return state === 'ready' || state === 'partial' }

/** The only roots of requests are explicit actions. Changes in workspace/visibility only cancel and clear. */
export function createWorkspaceGitView(api: GitViewTransport, onExpired: () => void) {
  let view = baseline()
  let active: AbortController | undefined
  let block: Block | undefined
  const listeners = new Set<() => void>()
  function publish(next: GitViewState): void {
    view = next
    listeners.forEach((listener) => listener())
  }
  function cancel(): void {
    const previous = active
    active = undefined
    previous?.abort()
  }
  function selectWorkspace(workspaceId?: string): void {
    if (workspaceId === view.workspaceId) return
    cancel()
    block = undefined
    publish(baseline(workspaceId))
  }
  function dismiss(): void {
    cancel()
    publish(baseline(view.workspaceId))
  }
  async function run<T>(action: Action, next: GitViewState,
    request: (id: string, signal: AbortSignal) => Promise<T>, complete: (data: T) => Partial<GitViewState>): Promise<void> {
    const id = view.workspaceId
    if (!id || block) return
    cancel()
    const ticket = new AbortController()
    active = ticket
    publish({ ...next, pending: action, issue: undefined })
    if (active !== ticket) return
    try {
      const data = await request(id, ticket.signal)
      if (active !== ticket) return
      const patch = complete(data)
      active = undefined
      publish({ ...view, ...patch, pending: undefined })
    } catch (error) {
      if (active !== ticket) return
      active = undefined
      const issue = classify(error, action)
      if (blocked(issue)) {
        block = issue
        publish({ ...baseline(id, true), issue })
        if (issue === 'auth') onExpired()
      } else if (issue === 'stale') {
        publish({ ...view, status: view.status && { ...view.status, viewId: null }, pending: undefined, issue, stale: true })
      } else {
        publish({ ...view, pending: undefined, issue })
      }
    }
  }
  function refresh(): Promise<void> | undefined {
    if (!view.open || view.pending === 'status') return
    return run('status', baseline(view.workspaceId, true), api.status, (status) => ({ status }))
  }
  function open(): Promise<void> | undefined {
    if (!view.workspaceId || view.open) return
    if (block) { publish({ ...baseline(view.workspaceId, true), issue: block }); return }
    return run('status', baseline(view.workspaceId, true), api.status, (status) => ({ status }))
  }
  function canInspect(): boolean { return view.open && hasGitData(view.status?.state) && !view.stale && !block }
  function changes(): void {
    if (!canInspect() || view.tab === 'changes') return
    cancel()
    publish({ ...view, tab: 'changes', branches: undefined, log: undefined, pending: undefined, issue: undefined })
  }
  function branches(): Promise<void> | undefined {
    if (!canInspect() || view.pending === 'branches') return
    return run('branches', { ...view, tab: 'branches', branches: undefined, log: undefined, selection: undefined, diff: undefined },
      api.branches, (branches) => ({ branches }))
  }
  function history(more = false): Promise<void> | undefined {
    if (!canInspect() || view.pending === 'log' || (more && (view.tab !== 'history' || !view.log?.more || view.limit >= GIT_LOG_MAX))) return
    const limit = more ? Math.min(view.limit + GIT_LOG_STEP, GIT_LOG_MAX) : GIT_LOG_STEP
    return run('log', { ...view, tab: 'history', branches: undefined, log: more ? view.log : undefined, limit: more ? view.limit : limit,
      selection: undefined, diff: undefined }, (id, signal) => api.log(id, limit, signal), (log) => ({ log, limit }))
  }
  function diff(entryId: string, side: GitSide): Promise<void> | undefined {
    const viewId = view.status?.viewId
    const entry = view.status?.entries.find((item) => item.entryId === entryId)
    if (!canInspect() || view.tab !== 'changes' || !viewId || !entry?.diffSides.includes(side) ||
      (view.pending === 'diff' && view.selection?.entryId === entryId && view.selection.side === side)) return
    const selection = { viewId, entryId, side }
    return run('diff', { ...view, selection, diff: undefined }, (id, signal) => api.diff(id, selection, signal), (diff) => {
      if (diff.rel !== entry.rel || diff.side !== side) throw new Error('Unexpected Git diff projection')
      return { diff }
    })
  }
  return {
    snapshot: () => view,
    subscribe(notify: () => void): () => void { listeners.add(notify); return () => { listeners.delete(notify) } },
    selectWorkspace, open, dismiss, refresh, changes, branches, history, diff
  }
}
export type WorkspaceGitView = ReturnType<typeof createWorkspaceGitView>

export function authorizedWorkspaceId(view: WorkspaceFilesView): string | undefined {
  return !view.issue && view.projects.data?.some((project) => project.id === view.projectId) ? view.projectId : undefined
}

/** Subscribe to the selector itself so a change (including delivery reveal) aborts immediately. */
export function bindWorkspaceGitView(git: WorkspaceGitView, files: WorkspaceFiles): () => void {
  const sync = (): void => git.selectWorkspace(authorizedWorkspaceId(files.snapshot()))
  const unsubscribe = files.subscribe(sync)
  sync()
  return () => { unsubscribe(); git.selectWorkspace(undefined) }
}
