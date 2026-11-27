import type { Transport } from './transport'

export const DOCUMENT_NAME_BYTES = 200
export const DOCUMENT_BODY_BYTES = 2 * 1024 * 1024
export const DOCUMENT_TTL = 120_000

const bytes = new TextEncoder()
const invisible = /[\p{C}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u
const nonText = /[\u0000-\u0008\u000e-\u001f\u007f-\u0084\u0086-\u009f\p{Cs}]/u
const workspaceId = /^w_[a-f0-9]{32}$/u
const intentId = /^di_[a-f0-9]{32}$/u
const revision = /^r_[a-f0-9]{64}$/u
const matches = (pattern: RegExp, value: unknown): value is string => typeof value === 'string' && pattern.exec(value)?.[0] === value
export const projectDocumentWorkspaceId = (value: unknown): value is string => matches(workspaceId, value)

export type DocumentIssue = 'directory' | 'name' | 'limit' | 'invalid' | 'readonly' | 'restricted' | 'expired' | 'missing' |
  'exists' | 'changed' | 'conflict' | 'busy' | 'unavailable' | 'unconfirmed'
export type PreparedDocument = { id: string; path: string; ttlMs: number }
export type DocumentStatus = { state: 'prepared' | 'unconfirmed'; path: string; revision: null } |
  { state: 'created'; path: string; revision: string }

export function documentDirectory(path: unknown): path is string {
  if (typeof path !== 'string' || path.length > 4095 || bytes.encode(path).length > 4095) return false
  if (path === '') return true
  const segments = path.split('/')
  return segments.length <= 16 && segments.every((segment) => !!segment && !segment.startsWith('.') &&
    !/\\|^[A-Za-z]:/u.test(segment) && !invisible.test(segment) && bytes.encode(segment).length <= 255)
}

export function documentValidation(name: unknown, content: unknown): 'name' | 'limit' | 'invalid' | undefined {
  if (typeof name !== 'string' || name.length > DOCUMENT_NAME_BYTES || !matches(/^.+\.(md|txt)$/iu, name) ||
      invisible.test(name) || bytes.encode(name).length > DOCUMENT_NAME_BYTES) return 'name'
  const folded = name.normalize('NFKC')
  const stem = folded.replace(/\.(md|txt)$/iu, '')
  if (!stem || /^[.\s]|[.\s]$/u.test(stem) || /[/\\<>:"|?*]/u.test(folded)) return 'name'
  if (typeof content !== 'string') return 'invalid'
  if (content.length > DOCUMENT_BODY_BYTES || bytes.encode(content).length > DOCUMENT_BODY_BYTES) return 'limit'
  return nonText.test(content) ? 'invalid' : undefined
}

export const documentPath = (directory: string, name: string): string => directory === '' ? name : `${directory}/${name}`

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function exact(value: Record<string, unknown>, ...keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function validPath(path: string): boolean {
  if (typeof path !== 'string') return false
  const slash = path.lastIndexOf('/')
  const directory = slash === -1 ? '' : path.slice(0, slash)
  return slash !== 0 && documentDirectory(directory) && !documentValidation(path.slice(slash + 1), '')
}

export class InvalidDocumentReceipt extends Error {
  constructor(readonly id?: string) { super('Invalid document intent receipt') }
}

/** Owner-session JSON only; the intent ID is never used as authority for a different workspace or target. */
export function createProjectDocumentTransport(transport: Transport, csrf: string) {
  const base = (wid: string): string => {
    if (!csrf || !projectDocumentWorkspaceId(wid)) throw new Error('Invalid project document request')
    return `/workspaces/${wid}/document-intents`
  }
  const resource = (wid: string, id: string, action: 'create' | 'status' | 'cancel'): string => {
    if (!matches(intentId, id)) throw new Error('Invalid project document intent')
    return `${base(wid)}/${id}/${action}`
  }
  const post = (path: string, body: object, expectedStatus: NonNullable<Parameters<Transport['request']>[4]>['expectedStatus'], keepalive = false) =>
    transport.request(path, 'POST', body, csrf, { referrerPolicy: 'same-origin', expectedStatus, ...(keepalive ? { keepalive: true } : {}) })
  return {
    async prepare(wid: string, directory: string, name: string): Promise<PreparedDocument> {
      if (!documentDirectory(directory) || documentValidation(name, '')) throw new Error('Invalid project document target')
      const path = documentPath(directory, name)
      const result = object(await post(base(wid), { directory, name }, (status, body) => {
        const prepared = object(body)
        const id = matches(intentId, prepared.id) ? prepared.id : undefined
        // Preserve a well-formed ID from a rejected receipt solely to release its original pin.
        if (status !== 201 || !id || !exact(prepared, 'id', 'path', 'ttlMs') || prepared.path !== path || prepared.ttlMs !== DOCUMENT_TTL)
          throw new InvalidDocumentReceipt(id)
        return true
      }))
      return { id: result.id as string, path, ttlMs: DOCUMENT_TTL }
    },
    async create(wid: string, id: string, path: string, content: string): Promise<{ path: string; revision: string; replayed: boolean }> {
      if (!validPath(path) || documentValidation(path.slice(path.lastIndexOf('/') + 1), content)) throw new Error('Invalid project document input')
      const result = object(await post(resource(wid, id, 'create'), { content }, (status, value) =>
        (status === 201 && object(value).replayed === false) || (status === 200 && object(value).replayed === true)))
      if (!exact(result, 'created', 'path', 'revision', 'replayed') || result.created !== true || result.path !== path ||
          !matches(revision, result.revision) || typeof result.replayed !== 'boolean')
        throw new InvalidDocumentReceipt()
      return { path, revision: result.revision, replayed: result.replayed }
    },
    async status(wid: string, id: string, path: string): Promise<DocumentStatus> {
      if (!validPath(path)) throw new Error('Invalid project document target')
      const result = object(await post(resource(wid, id, 'status'), {}, 200))
      if (exact(result, 'state', 'path', 'revision') && result.path === path) {
        if (result.state === 'created' && matches(revision, result.revision)) return { state: 'created', path, revision: result.revision }
        if ((result.state === 'prepared' || result.state === 'unconfirmed') && result.revision === null)
          return { state: result.state, path, revision: null }
      }
      throw new InvalidDocumentReceipt()
    },
    async cancel(wid: string, id: string): Promise<void> {
      const result = object(await post(resource(wid, id, 'cancel'), {}, 200, true))
      if (!exact(result, 'closed') || result.closed !== true) throw new InvalidDocumentReceipt()
    }
  }
}

export type ProjectDocumentTransport = ReturnType<typeof createProjectDocumentTransport>
