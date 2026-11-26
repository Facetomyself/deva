import type { PreviewScheduleResult, TaskAuthorization, TaskRun, TaskSchedule, TaskStatus } from '../shared/host-conversations'
import type { Transport } from './transport'

export type TaskLocale = 'en' | 'zh-CN'
export type RecordedSchedule = { kind: 'once'; at: string; tz: string } | { kind: 'recurring'; cron: string; tz: string }
export type TaskSummary = {
  id: string; title: string; status: TaskStatus; schedule: RecordedSchedule
  createdAt: number; updatedAt: number; lastRunAt: number | null; nextRunAt: number | null; runCount: number
}
export type InspectedTask = TaskSummary & {
  prompt: string; auth: TaskAuthorization; sessionId: string; ownerSessionId: string | null; originSessionId: string | null
  consecutiveErrors: number; runs: TaskRun[]; pauseAllowed: boolean
}
export type TaskList = { tasks: TaskSummary[]; revision: string; execution: 'inactive' }
export type TaskDetail = { task: InspectedTask; revision: string; execution: 'inactive' }
export type PreviewInput = { schedule: TaskSchedule; locale: TaskLocale; allowPast: boolean }

const statuses = ['active', 'paused', 'completed', 'error'] as const
const runStatuses = ['ok', 'error', 'skipped', 'aborted'] as const
const previewErrors = ['invalid-input', 'invalid-tz', 'invalid-cron', 'invalid-once'] as const
const text = (x: unknown): x is string => typeof x === 'string'
const nullableText = (x: unknown): x is string | null => x === null || text(x)
const instant = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && Math.abs(x) <= 8_640_000_000_000_000
const nullableInstant = (x: unknown): x is number | null => x === null || instant(x)
const count = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0
const isOneOf = <T extends string>(values: readonly T[], x: unknown): x is T => values.some((value) => value === x)
const taskId = (x: unknown): x is string => text(x) && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.exec(x)?.[0] === x
const revision = (x: unknown): x is string => text(x) && /^[a-f0-9]{64}$/u.exec(x)?.[0] === x
const record = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
export class InvalidTaskReceipt extends Error {
  constructor() { super('Invalid task inspection receipt') }
}
const invalid = (): never => { throw new InvalidTaskReceipt() }

function schedule(x: unknown): RecordedSchedule {
  if (record(x) && text(x.tz)) {
    if (x.kind === 'once' && text(x.at)) return { kind: 'once', at: x.at, tz: x.tz }
    if (x.kind === 'recurring' && text(x.cron)) return { kind: 'recurring', cron: x.cron, tz: x.tz }
  }
  return invalid()
}

function summary(x: unknown): TaskSummary {
  if (!record(x)) return invalid()
  const { id, title, status, createdAt, updatedAt, lastRunAt, nextRunAt, runCount } = x
  if (!taskId(id) || !text(title) || !isOneOf(statuses, status) || !instant(createdAt) || !instant(updatedAt) ||
    !nullableInstant(lastRunAt) || !nullableInstant(nextRunAt) || !count(runCount)) return invalid()
  return { id, title, status, schedule: schedule(x.schedule), createdAt, updatedAt, lastRunAt, nextRunAt, runCount }
}

function run(x: unknown): TaskRun {
  if (!record(x)) return invalid()
  const { firedAt, finishedAt, status, summary, error, handoff } = x
  if (!instant(firedAt) || !isOneOf(runStatuses, status) || (finishedAt !== undefined && !instant(finishedAt)) ||
    (summary !== undefined && !text(summary)) || (error !== undefined && !text(error))) return invalid()
  const result: TaskRun = { firedAt, status, ...(finishedAt !== undefined && { finishedAt }),
    ...(summary !== undefined && { summary }), ...(error !== undefined && { error }) }
  if (handoff !== undefined) {
    if (!record(handoff) || !text(handoff.summary) || typeof handoff.needsAction !== 'boolean') return invalid()
    result.handoff = { summary: handoff.summary, needsAction: handoff.needsAction }
  }
  return result
}

function detail(x: unknown, id: string): InspectedTask {
  if (!record(x) || x.id !== id) return invalid()
  const { prompt, auth, sessionId, ownerSessionId, originSessionId, consecutiveErrors, runs, pauseAllowed } = x
  if (!text(prompt) || !record(auth) || !nullableText(auth.personaId) || !nullableText(auth.modelRef) || !text(sessionId) ||
    !nullableText(ownerSessionId) || !nullableText(originSessionId) || !count(consecutiveErrors) || !Array.isArray(runs) ||
    typeof pauseAllowed !== 'boolean') return invalid()
  return { ...summary(x), prompt, auth: { personaId: auth.personaId, modelRef: auth.modelRef }, sessionId, ownerSessionId,
    originSessionId, consecutiveErrors, runs: runs.map(run), pauseAllowed }
}

function receipt(x: unknown): { raw: Record<string, unknown>; revision: string; execution: 'inactive' } {
  if (!record(x) || x.execution !== 'inactive' || !revision(x.revision)) return invalid()
  return { raw: x, revision: x.revision, execution: x.execution }
}

export function createTaskInspectionTransport(transport: Transport, csrf: string) {
  const path = (id: string): string => taskId(id) ? `/tasks/${encodeURIComponent(id)}` : invalid()
  const write = (route: string, method: 'POST' | 'PATCH', body: object, signal: AbortSignal): Promise<unknown> => {
    if (!csrf) return invalid()
    // A same-origin referrer policy lets Fetch supply the real Origin on writes.
    return transport.request(route, method, body, csrf, { signal, referrerPolicy: 'same-origin' })
  }
  return {
    async list(signal: AbortSignal): Promise<TaskList> {
      const { raw, ...meta } = receipt(await transport.request('/tasks', 'GET', undefined, undefined, { signal }))
      if (!Array.isArray(raw.tasks)) return invalid()
      const tasks = raw.tasks.map(summary)
      if (new Set(tasks.map((task) => task.id)).size !== tasks.length) return invalid()
      return { ...meta, tasks }
    },
    async detail(id: string, signal: AbortSignal): Promise<TaskDetail> {
      const { raw, ...meta } = receipt(await transport.request(path(id), 'GET', undefined, undefined, { signal }))
      return { ...meta, task: detail(raw.task, id) }
    },
    async preview(input: PreviewInput, signal: AbortSignal): Promise<PreviewScheduleResult> {
      if ((input.locale !== 'en' && input.locale !== 'zh-CN') || typeof input.allowPast !== 'boolean') return invalid()
      const x = await write('/tasks/preview', 'POST', { schedule: schedule(input.schedule), locale: input.locale, allowPast: input.allowPast }, signal)
      if (record(x)) {
        if (x.ok === true && text(x.description) && nullableInstant(x.nextRunAt)) return { ok: true, description: x.description, nextRunAt: x.nextRunAt }
        if (x.ok === false && isOneOf(previewErrors, x.error)) return { ok: false, error: x.error }
      }
      return invalid()
    },
    async pause(id: string, expected: string, signal: AbortSignal): Promise<void> {
      if (!revision(expected)) return invalid()
      // Mutation responses are acknowledgments only; the controller re-reads list and detail.
      const { raw } = receipt(await write(`${path(id)}/status`, 'PATCH', { revision: expected, status: 'paused' }, signal))
      if (detail(raw.task, id).status !== 'paused') return invalid()
    }
  }
}

export type TaskInspectionTransport = ReturnType<typeof createTaskInspectionTransport>
