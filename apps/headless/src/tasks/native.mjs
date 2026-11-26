import { createHash } from 'node:crypto'
import { decodeUtf8 } from '../files/workspace-files-fd.mjs'
import { taskLimit, taskUnsupported } from './errors.mjs'
import { patchTaskStatus, taskRecordSpans } from './packed.mjs'

export const MAX_TASK_FILE_BYTES = 1024 * 1024
const MAX_TASKS = 128
const MAX_RUNS = 50 // Desktop MAX_RUNS_PER_TASK
const statusValues = new Set(['active', 'paused', 'completed', 'error'])
const runStatuses = new Set(['ok', 'error', 'skipped', 'aborted'])
const displayControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu
const metadataControls = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const absentRevision = digest('deva:native-tasks:v1:absent\0')

export const validTaskId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?![\s\S])/u.test(value)
export const validTaskRevision = value => typeof value === 'string' && value.length === 64 && !/[^0-9a-f]/u.test(value)
export const validTaskTime = value => Number.isSafeInteger(value) && Math.abs(value) <= 8_640_000_000_000_000
export const taskRevision = file => file ? digest(file.bytes) : absentRevision

function object(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw taskUnsupported()
  return value
}

function string(value, max, { raw = false, prompt = false } = {}) {
  if (typeof value !== 'string') throw taskUnsupported()
  if (Buffer.byteLength(value) > max) throw taskLimit()
  if (prompt) return value.toWellFormed()
  if (!value.isWellFormed() || (!raw && metadataControls.test(value))) throw taskUnsupported()
  return value
}

// Prompt syntax remains literal (including HTML/Markdown-like text). Consumers render it
// as a text node, never as HTML or Markdown; neither markup nor path-looking text is resolved.
const plainPrompt = value => string(value, 64 * 1024, { prompt: true }).replace(/\r\n?/gu, '\n').replace(displayControls, '')

function id(value) {
  string(value, 128)
  if (!validTaskId(value)) throw taskUnsupported()
  return value
}
const optionalId = value => value === undefined || value === null || value === '' ? null : id(value)
const optionalAuth = (value, max) => value === undefined || value === null || value === '' ? null : string(value, max)

function ms(value) {
  if (!validTaskTime(value)) throw taskUnsupported()
  return value
}
const optionalMs = value => value === undefined || value === null ? null : ms(value)

function scheduleView(value) {
  const { kind, at, cron, tz } = object(value)
  const timezone = string(tz, 128)
  if (!timezone.trim()) throw taskUnsupported()
  if (kind === 'once' && typeof at === 'string' && at.trim()) return { kind, at: string(at, 64), tz: timezone }
  if (kind === 'recurring' && typeof cron === 'string' && cron.trim()) return { kind, cron: string(cron, 256), tz: timezone }
  throw taskUnsupported()
}

function authView(value) {
  const { personaId, modelRef } = value === undefined ? {} : object(value)
  return { personaId: optionalAuth(personaId, 128), modelRef: optionalAuth(modelRef, 512) }
}

function runView(value) {
  const { firedAt, finishedAt, status, summary, error, handoff } = object(value)
  if (!runStatuses.has(status)) throw taskUnsupported()
  const run = { firedAt: ms(firedAt), status }
  if (finishedAt !== undefined) run.finishedAt = ms(finishedAt)
  if (summary !== undefined) run.summary = string(summary, 16 * 1024, { raw: true })
  if (error !== undefined) run.error = string(error, 16 * 1024, { raw: true })
  if (handoff !== undefined) {
    const { summary, needsAction } = object(handoff)
    if (typeof needsAction !== 'boolean') throw taskUnsupported()
    run.handoff = { summary: string(summary, 16 * 1024, { raw: true }), needsAction }
  }
  return run
}

function entryView(value, writable) {
  const task = object(value)
  if (!statusValues.has(task.status)) throw taskUnsupported()
  // Older v1 records may omit runtime defaults; a present field must have the native type.
  const { runs = [], consecutiveErrors = 0 } = task
  if (!Array.isArray(runs) || !Number.isSafeInteger(consecutiveErrors) || consecutiveErrors < 0) throw taskUnsupported()
  if (runs.length > MAX_RUNS) throw taskLimit()
  const summary = {
    id: id(task.id),
    title: string(task.title, 512, { raw: true }),
    status: task.status,
    schedule: scheduleView(task.schedule),
    createdAt: ms(task.createdAt),
    updatedAt: ms(task.updatedAt),
    lastRunAt: optionalMs(task.lastRunAt),
    nextRunAt: optionalMs(task.nextRunAt),
    runCount: runs.length
  }
  const detail = {
    ...summary,
    prompt: plainPrompt(task.prompt),
    auth: authView(task.auth),
    sessionId: id(task.sessionId),
    ownerSessionId: optionalId(task.ownerSessionId),
    originSessionId: optionalId(task.originSessionId),
    consecutiveErrors,
    runs: runs.map(runView),
    pauseAllowed: writable && task.status === 'active'
  }
  return { summary, detail }
}

export function parseNativeTasks(file) {
  if (file === null) return { entries: [] }
  let text, value
  try {
    text = decodeUtf8(file.bytes)
    value = JSON.parse(text)
  } catch { throw taskUnsupported() }
  if (!value || value.version !== 1 || !Array.isArray(value.tasks)) throw taskUnsupported()
  if (value.tasks.length > MAX_TASKS) throw taskLimit()
  const spans = taskRecordSpans(text)
  const ids = new Set()
  const entries = value.tasks.map((task, index) => {
    const entry = entryView(task, file.writable)
    const { id } = entry.summary
    if (ids.has(id) || !spans[index]?.status || !spans[index]?.updatedAt) throw taskUnsupported()
    ids.add(id)
    return { ...entry, spans: spans[index] }
  })
  return { text, entries }
}

export function pauseNativeTask(document, entry, updatedAt) {
  const bytes = patchTaskStatus(document.text, entry.spans, updatedAt)
  if (bytes.length > MAX_TASK_FILE_BYTES) throw taskLimit()
  return bytes
}
