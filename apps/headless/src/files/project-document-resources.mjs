import { types } from 'node:util'
import { HttpError } from '../http/policy.mjs'
import { PROJECT_DOCUMENT_MAX_BYTES } from './project-document-names.mjs'

const codes = new Map(Object.entries({
  auth: 401,
  workspace_unavailable: 404,
  document_invalid: 400,
  document_read_only: 403,
  document_unsafe: 403,
  document_intent_missing: 404,
  document_exists: 409,
  document_changed: 409,
  document_conflict: 409,
  document_limit: 413,
  document_restricted: 422,
  document_busy: 429,
  document_unconfirmed: 503,
  document_unavailable: 503,
}))
export const fault = code => new HttpError(codes.get(code), code)
export function bridgeCode(error, fallback) {
  if (error && !types.isProxy(error) && error instanceof HttpError) {
    const code = ownData(error, 'code')
    if (codes.has(code) && ownData(error, 'status') === codes.get(code)) return code
  }
  return fallback
}

const exact = (value, length, pattern) => typeof value === 'string' && value.length === length && pattern.test(value)
export const validWorkspace = v => exact(v, 34, /^w_[\da-f]{32}$/)
export const validIntent = v => exact(v, 35, /^di_[\da-f]{32}$/)
export const validRevision = v => exact(v, 66, /^r_[\da-f]{64}$/)

const record = value => value !== null && typeof value === 'object' && !types.isProxy(value)
export function ownData(value, key) {
  if (!record(value)) return undefined
  const entry = Object.getOwnPropertyDescriptor(value, key)
  return entry && Object.hasOwn(entry, 'value') ? entry.value : undefined
}

function fields(value, keys) {
  if (!record(value)) throw fault('document_invalid')
  const proto = Object.getPrototypeOf(value)
  if ((proto !== Object.prototype && proto !== null) || Reflect.ownKeys(value).length !== keys.length) throw fault('document_invalid')
  return keys.map(key => {
    const entry = Object.getOwnPropertyDescriptor(value, key)
    if (!entry?.enumerable || !Object.hasOwn(entry, 'value')) throw fault('document_invalid')
    return entry.value
  })
}

export const emptyBody = value => { fields(value, []) }
export function targetBody(value) {
  const [directory, name] = fields(value, ['directory', 'name'])
  if (typeof directory !== 'string' || typeof name !== 'string') throw fault('document_invalid')
  return { directory, name }
}

export function contentBody(value) {
  const [content] = fields(value, ['content'])
  if (typeof content !== 'string') throw fault('document_invalid')
  if (content.length > PROJECT_DOCUMENT_MAX_BYTES || Buffer.byteLength(content, 'utf8') > PROJECT_DOCUMENT_MAX_BYTES) throw fault('document_limit')
  if (!content.isWellFormed()) throw fault('document_invalid')
  return content
}
