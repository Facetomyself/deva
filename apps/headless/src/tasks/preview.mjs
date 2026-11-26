import { addAbortListener } from 'node:events'
import { Worker } from 'node:worker_threads'

const workerFile = new URL('./preview-worker.mjs', import.meta.url)
const MAX_WORKERS = 2
const BUDGET_MS = 2_000
const MAX_CRON_LENGTH = 512
const MAX_ZONE_LENGTH = 128
const qualifiedZone = /^[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)+$/u
// IANA tzdb also has unqualified names/links. ICU accepts additional strings
// such as PST and fixed offset syntax, which are not IANA identifiers.
const unqualifiedZones = new Set((
  'UTC GMT GMT+0 GMT-0 GMT0 Greenwich UCT Universal Zulu CET CST6CDT Cuba EET Egypt Eire EST EST5EDT ' +
  'GB GB-Eire Hongkong HST Iceland Iran Israel Jamaica Japan Kwajalein Libya MET MST MST7MDT Navajo ' +
  'NZ NZ-CHAT Poland Portugal PRC PST8PDT ROC ROK Singapore Turkey W-SU WET'
).toLowerCase().split(' '))

export class TaskPreviewError extends Error {
  constructor(code) {
    super(code)
    this.name = 'TaskPreviewError'
    this.code = code
  }
}

function exactRecord(value, fields) {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  if ((proto !== Object.prototype && proto !== null) || Reflect.ownKeys(value).length !== fields.length) return false
  return fields.every(key => {
    const field = Object.getOwnPropertyDescriptor(value, key)
    return field?.enumerable && Object.hasOwn(field, 'value')
  })
}

function validWallMinute(at) {
  if (typeof at !== 'string' || (at.length !== 16 && at.length !== 19)) return false
  const parts = /^(\d{4})-(\d{2})-(\d{2})[T ]([01]\d|2[0-3]):[0-5]\d(?::00)?$/u.exec(at)
  if (!parts) return false
  const [, year, month, day] = parts.map(Number)
  // Date.UTC in the shared Desktop engine maps 00–99 to 1900–1999.
  if (year < 100) return false
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day
}

const failure = error => ({ ok: false, error })

function validate(input) {
  if (!exactRecord(input, ['schedule', 'locale', 'allowPast'])) return failure('invalid-input')
  const { schedule, locale, allowPast } = input
  if ((locale !== 'en' && locale !== 'zh-CN') || typeof allowPast !== 'boolean') return failure('invalid-input')
  const once = exactRecord(schedule, ['kind', 'tz', 'at']) && schedule.kind === 'once'
  const recurring = exactRecord(schedule, ['kind', 'tz', 'cron']) && schedule.kind === 'recurring'
  if (!once && !recurring) return failure('invalid-input')
  const { kind, tz } = schedule
  if (typeof tz !== 'string' || tz.length > MAX_ZONE_LENGTH ||
    (!qualifiedZone.test(tz) && !unqualifiedZones.has(tz.toLowerCase()))) return failure('invalid-tz')
  if (once) {
    if (!validWallMinute(schedule.at)) return failure('invalid-once')
    return { ok: true, request: { schedule: { kind, tz, at: schedule.at }, locale, allowPast } }
  }
  const { cron } = schedule
  if (typeof cron !== 'string' || cron.length === 0 || cron.length > MAX_CRON_LENGTH) return failure('invalid-cron')
  return { ok: true, request: { schedule: { kind, tz, cron }, locale, allowPast } }
}

function startPreview(workerData, signal, release) {
  const deadline = performance.now() + BUDGET_MS
  const worker = new Worker(workerFile, {
    workerData, execArgv: [], env: {}, stdout: true, stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 }
  })
  worker.stdout.resume()
  worker.stderr.resume()
  const { promise: result, resolve, reject } = Promise.withResolvers()
  const { promise: exited, resolve: finishExit } = Promise.withResolvers()
  let settled = false, response, abortListener
  const timer = setTimeout(() => stop('preview_timeout'), Math.max(0, Math.ceil(deadline - performance.now())))

  function settle(error) {
    if (settled) return
    settled = true
    clearTimeout(timer)
    abortListener?.[Symbol.dispose]()
    if (error) reject(new TaskPreviewError(error))
    else resolve(response)
  }

  function stop(error) {
    if (settled) return
    settle(error)
    // The caller receives cancellation immediately; capacity stays occupied until exit.
    void worker.terminate().catch(() => {})
  }

  worker.once('message', value => { response = value })
  worker.once('error', () => stop('preview_unavailable'))
  worker.once('messageerror', () => stop('preview_unavailable'))
  worker.once('exit', code => {
    if (!settled) {
      if (performance.now() >= deadline) settle('preview_timeout')
      else settle(code === 0 && response ? undefined : 'preview_unavailable')
    }
    release()
    finishExit()
  })
  if (signal) abortListener = addAbortListener(signal, () => stop('preview_aborted'))
  return { result, exited, stop }
}

/**
 * Open a read-only preview runner. Supply one instance per HTTP host. Responses
 * use the Desktop result union; lifecycle and capacity faults reject separately.
 * `now` is a trusted host clock (epoch ms), never taken from the request body.
 */
export function openTaskPreview({ now = Date.now } = {}) {
  if (typeof now !== 'function') throw TypeError('Task preview clock must be a function')
  const active = new Set()
  let closed = false, draining

  async function preview(input, signal) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw TypeError('Expected an AbortSignal')
    if (closed) throw new TaskPreviewError('preview_closed')
    if (signal?.aborted) throw new TaskPreviewError('preview_aborted')
    const checked = validate(input)
    if (!checked.ok) return checked
    if (active.size >= MAX_WORKERS) throw new TaskPreviewError('preview_busy')
    let timestamp
    try { timestamp = now() } catch { throw new TaskPreviewError('preview_unavailable') }
    if (!Number.isSafeInteger(timestamp)) throw new TaskPreviewError('preview_unavailable')
    if (closed) throw new TaskPreviewError('preview_closed')
    if (signal?.aborted) throw new TaskPreviewError('preview_aborted')
    if (active.size >= MAX_WORKERS) throw new TaskPreviewError('preview_busy')

    let job
    try {
      job = startPreview({ request: checked.request, timestamp }, signal, () => active.delete(job))
    } catch {
      throw new TaskPreviewError('preview_unavailable')
    }
    active.add(job)
    return job.result
  }

  function close() {
    if (!draining) {
      closed = true
      const jobs = [...active]
      for (const job of jobs) job.stop('preview_closed')
      draining = Promise.all(jobs.map(job => job.exited)).then(() => {})
    }
    return draining
  }

  return { preview, close }
}
