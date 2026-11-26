import { workspacePathParts } from '../files/workspace-files-fd.mjs'
import { HttpError } from '../http/policy.mjs'

export const terminalError = (code, status) => new HttpError(status, `terminal_${code}`)
export const invalid = () => terminalError('invalid', 400)
export const notFound = () => terminalError('not_found', 404)
export const sequenceConflict = () => terminalError('sequence', 409)
export const sourceChanged = () => terminalError('source_changed', 409)
export const busy = () => terminalError('busy', 429)
export const unavailable = () => terminalError('unavailable', 503)

const workspaceId = /^w_[0-9a-f]{32}$/u
const terminalId = /^pt_[0-9a-f]{32}$/u
const revision = /^r_[0-9a-f]{64}$/u
const exact = (value, length, pattern) => typeof value === 'string' && value.length === length && pattern.test(value)
export const validWorkspace = value => exact(value, 34, workspaceId)
export const validTerminal = value => exact(value, 35, terminalId)
const int = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max
const dimensions = (cols, rows) => int(cols, 24, 160) && int(rows, 4, 50)
const keys = new Set(['up', 'down', 'page-up', 'page-down', 'home', 'end', 'left', 'right', 'quit'])
const control = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u
const MAX_SCREEN_BYTES = 96 * 1024
const MAX_LEFT_EDGE = 524_288

function record(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return (proto === Object.prototype || proto === null) && Reflect.ownKeys(value).length === fields.length && fields.every(key => {
    const entry = Object.getOwnPropertyDescriptor(value, key)
    return entry?.enumerable && Object.hasOwn(entry, 'value')
  })
}

export function startRequest(value) {
  if (!record(value, ['profile', 'path', 'revision', 'cols', 'rows'])) throw invalid()
  const { profile, path, revision: rev, cols, rows } = value
  if (profile !== 'text-view' || !workspacePathParts(path) || control.test(path) || !exact(rev, 66, revision) || !dimensions(cols, rows)) throw invalid()
  return { path, revision: rev, cols, rows }
}

export function actionRequest(kind, value) {
  if (!record(value, kind === 'input' ? ['sequence', 'key'] : ['sequence', 'cols', 'rows']) || !int(value.sequence, 1)) throw invalid()
  const { sequence } = value
  if (kind === 'input') {
    if (!keys.has(value.key)) throw invalid()
    return { sequence, key: value.key, digest: `input:${value.key}` }
  }
  const { cols, rows } = value
  if (!dimensions(cols, rows)) throw invalid()
  return { sequence, cols, rows, digest: `resize:${cols}:${rows}` }
}

export function eventsRequest(value) {
  if (!record(value, ['after', 'waitMs']) || !int(value.after) || !int(value.waitMs, 0, 5000)) throw invalid()
  return { after: value.after, waitMs: value.waitMs }
}

// The native viewer emits display rows, not a terminal byte stream. Accept only the
// fixed geometry and safe text, rebuilding/fixing the DTO before sharing references.
export function checkedScreen(value) {
  if (!record(value, ['cols', 'rows', 'top', 'left', 'totalLines', 'lines'])) return null
  const { cols, rows, top, left, totalLines, lines } = value
  if (!dimensions(cols, rows) || !int(totalLines, 1, 4096) || !int(top, 0, totalLines - 1) || !int(left, 0, MAX_LEFT_EDGE - cols) ||
      !Array.isArray(lines) || !int(lines.length, 1, Math.min(rows, totalLines - top))) return null
  const safe = []
  let bytes = 0
  for (let i = 0; i < lines.length; i++) {
    const field = Object.getOwnPropertyDescriptor(lines, i)
    const line = field?.value
    if (!field?.enumerable || typeof line !== 'string' || line.length > MAX_SCREEN_BYTES || !line.isWellFormed() ||
        (control.test(line) && control.test(line.replace(/[\u200c\u200d]/gu, '')))) return null
    bytes += Buffer.byteLength(line)
    if (bytes > MAX_SCREEN_BYTES) return null
    safe.push(line)
  }
  return Object.freeze({ cols, rows, top, left, totalLines, lines: Object.freeze(safe) })
}

const exitReasons = new Set(['quit', 'disposed', 'fault'])
export const lostExit = Object.freeze({ code: null, signal: null, reason: 'worker-lost' })
export function checkedExit(result) {
  if (!record(result, ['code', 'signal', 'reason'])) return null
  const { code, signal, reason } = result
  if (reason === 'worker-lost') return code === null && signal === null ? lostExit : null
  const status = value => value === null || int(value, 0, 2_147_483_647)
  if (!status(code) || !status(signal) || !exitReasons.has(reason)) return null
  return Object.freeze({ code, signal, reason })
}

// Only the deliberately public error vocabulary from the snapshot adapter crosses
// the boundary. Build a new error rather than retaining arbitrary upstream properties.
export function sourceOpenError(error) {
  if (error instanceof HttpError) {
    if (error.status === 403 && error.code === 'terminal_source_denied') return terminalError('source_denied', 403)
    if (error.status === 404 && error.code === 'terminal_not_found') return notFound()
    if (error.status === 413 && error.code === 'terminal_limit') return terminalError('limit', 413)
    if (error.status === 422 && error.code === 'terminal_unsupported') return terminalError('unsupported', 422)
    if (error.status === 409 && error.code === 'terminal_source_changed') return sourceChanged()
  }
  return unavailable()
}
