import type { PreviewScheduleResult } from '../shared/host-conversations'
import { HttpFailure } from './transport'
import { InvalidTaskReceipt, type PreviewInput, type TaskDetail, type TaskInspectionTransport, type TaskList } from './task-inspection-transport'

export type TaskIssue = 'malformed' | 'unsupported' | 'unconfirmed' | 'forbidden' | 'missing' | 'limit' | 'busy' |
  'conflict' | 'stateChanged' | 'invalidPreview' | 'listFailed' | 'detailFailed' | 'previewFailed' | 'pauseUnconfirmed'
type Read<T> = { pending: true } | { data: T } | { issue: TaskIssue }
type SuccessfulPreview = Extract<PreviewScheduleResult, { ok: true }> & { zone: string }
type PreviewRead = Read<SuccessfulPreview> | { validation: Extract<PreviewScheduleResult, { ok: false }>['error'] }
export type TaskInspectionView = {
  open: boolean; list?: Read<TaskList>; selected?: string; detail?: Read<TaskDetail>
  preview?: PreviewRead; confirming?: boolean; pausing?: boolean; statusIssue?: TaskIssue
}
const closed: TaskInspectionView = { open: false }
type Lane = 'list' | 'detail' | 'preview' | 'pause'

function issueOf(error: unknown, fallback: TaskIssue): TaskIssue {
  if (error instanceof InvalidTaskReceipt && fallback !== 'pauseUnconfirmed') return 'malformed'
  if (error instanceof HttpFailure) {
    if (error.code === 'task_file_unsupported') return 'unsupported'
    if (error.code === 'task_storage_unconfirmed') return 'unconfirmed'
    if (error.code === 'task_state') return 'stateChanged'
    if (error.status === 409 && fallback === 'pauseUnconfirmed') return 'conflict'
    if (error.status === 403) return 'forbidden'
    if (error.status === 404 && (fallback === 'detailFailed' || fallback === 'pauseUnconfirmed')) return 'missing'
    if (error.status === 413) return 'limit'
    if (error.status === 429) return 'busy'
    if (error.status === 400 && fallback === 'previewFailed') return 'invalidPreview'
  }
  return fallback
}

export function createTaskInspection(api: TaskInspectionTransport, { expired, beforePause }: {
  expired: () => void; beforePause: () => Promise<void>
}) {
  let view = closed
  let pauseSent = false
  const requests: Partial<Record<Lane, AbortController>> = {}
  const listeners = new Set<() => void>()
  const set = (next: TaskInspectionView): void => { view = next; listeners.forEach((fn) => fn()) }
  const update = (patch: Partial<TaskInspectionView>): void => set({ ...view, ...patch })
  function abort(lane: Lane): void {
    requests[lane]?.abort()
    delete requests[lane]
  }
  function start(lane: Lane): AbortController {
    abort(lane)
    return requests[lane] = new AbortController()
  }
  function live(lane: Lane, request: AbortController): boolean {
    return view.open && requests[lane] === request && !request.signal.aborted
  }
  function finish(lane: Lane, request: AbortController): boolean {
    if (!live(lane, request)) return false
    delete requests[lane]
    return true
  }
  function close(): void {
    for (const lane of ['list', 'detail', 'preview', 'pause'] as const) abort(lane)
    pauseSent = false
    if (view.open) set(closed)
  }
  function failed(lane: Lane, request: AbortController, error: unknown, fallback: TaskIssue): TaskIssue | undefined {
    if (!finish(lane, request)) return undefined
    if (error instanceof HttpFailure && error.status === 401) {
      close()
      expired()
      return undefined
    }
    return issueOf(error, fallback)
  }

  async function readDetail(id: string): Promise<void> {
    const request = start('detail')
    update({ detail: { pending: true } })
    try {
      const data = await api.detail(id, request.signal)
      if (finish('detail', request)) update({ detail: { data } })
    } catch (error) {
      const issue = failed('detail', request, error, 'detailFailed')
      if (issue) update({ detail: { issue } })
    }
  }
  async function refresh(): Promise<void> {
    if (!view.open || view.pausing) return
    const request = start('list')
    abort('detail')
    update({ list: { pending: true }, detail: undefined, confirming: false, statusIssue: undefined })
    try {
      const data = await api.list(request.signal)
      if (!finish('list', request)) return
      const selected = data.tasks.some(({ id }) => id === view.selected) ? view.selected : undefined
      if (!selected && view.selected) clearPreview()
      update({ list: { data }, selected })
      if (selected) await readDetail(selected)
    } catch (error) {
      const issue = failed('list', request, error, 'listFailed')
      if (issue) update({ list: { issue } })
    }
  }
  async function open(): Promise<void> {
    if (view.open) return
    set({ open: true })
    await refresh()
  }
  async function select(id: string): Promise<void> {
    if (!view.open || id === view.selected || !view.list || !('data' in view.list) || !view.list.data.tasks.some((task) => task.id === id)) return
    const uncertain = view.pausing && pauseSent
    abort('pause')
    pauseSent = false
    abort('preview')
    update({ selected: id, detail: undefined, preview: undefined, confirming: false, pausing: false,
      ...(uncertain && { statusIssue: 'pauseUnconfirmed' }) })
    await readDetail(id)
  }
  function clearPreview(): void {
    abort('preview')
    if (view.preview) update({ preview: undefined })
  }
  async function preview(input: PreviewInput): Promise<void> {
    if (!view.open) return
    const request = start('preview')
    update({ preview: { pending: true } })
    try {
      const result = await api.preview(input, request.signal)
      if (finish('preview', request)) update({ preview: result.ok ? { data: { ...result, zone: input.schedule.tz } } : { validation: result.error } })
    } catch (error) {
      const issue = failed('preview', request, error, 'previewFailed')
      if (issue) update({ preview: { issue } })
    }
  }

  function canPause(): TaskDetail | undefined {
    if (!view.open || view.pausing || view.statusIssue || !view.detail || !('data' in view.detail)) return undefined
    const detail = view.detail.data
    return detail.task.pauseAllowed && detail.task.status === 'active' ? detail : undefined
  }
  function askPause(): void { if (canPause()) update({ confirming: true }) }
  function cancelPause(): void { if (view.confirming) update({ confirming: false }) }
  async function confirmPause(): Promise<void> {
    const current = view.confirming ? canPause() : undefined
    if (!current) return
    const request = start('pause')
    update({ confirming: false, pausing: true })
    try {
      await beforePause()
      if (!live('pause', request)) return
      pauseSent = true
      await api.pause(current.task.id, current.revision, request.signal)
      if (finish('pause', request)) {
        pauseSent = false
        update({ pausing: false, detail: undefined })
        await refresh()
      }
    } catch (error) {
      const issue = failed('pause', request, error, 'pauseUnconfirmed')
      if (issue) {
        pauseSent = false
        update({ pausing: false, statusIssue: issue })
      }
    }
  }
  return { snapshot: () => view, subscribe: (fn: () => void) => {
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  }, open, close, refresh, select, preview, clearPreview, askPause, cancelPause, confirmPause }
}

export type TaskInspection = ReturnType<typeof createTaskInspection>
export const closedTaskSnapshot = (): TaskInspectionView => closed
export const idleTaskSubscription = (): (() => void) => () => {}
