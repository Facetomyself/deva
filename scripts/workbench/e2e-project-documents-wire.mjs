import { createHash } from 'node:crypto'
import { channel } from 'node:diagnostics_channel'
import { isDeepStrictEqual } from 'node:util'
import {
  alphaMarker, betaMarker, check, conflictDraft, content, dismissedName, docs, documentPath, guide, guideText,
  intentId, name, nested, uncertainName, uncertainPath, uncertainText
} from './e2e-project-documents-fixture.mjs'
import { waitFor } from './webdriver-local.mjs'

const workspaceRoute = /^\/api\/v1\/workspaces\/(w_[a-f0-9]{32})\/(?:(list|read|document-intents)|document-intents\/(di_[a-f0-9]{32})\/(create|status|cancel))$/
const transactions = new Set(['document-intents', 'create', 'status', 'cancel'])
const authRoute = /^\/api\/v1\/auth\/(claim|login)$/
const dangerousRead = /^\/api\/v1\/(?:terminal(?:\/|$)|provider-models(?:\/|$))/
const bodyLimit = 16 * 1024
const allowedBodies = [
  ...['', docs, nested, alphaMarker, betaMarker, guide, documentPath, uncertainPath].map(path => ({ path })),
  { directory: '', name: dismissedName }, { directory: nested, name }, { directory: nested, name: uncertainName },
  {}, ...[content, conflictDraft, uncertainText].map(content => ({ content }))
]
const allowedPaths = [documentPath, dismissedName, uncertainPath]
const allowedTexts = new Map([[guide, guideText], [documentPath, content], [uncertainPath, uncertainText]])
const parse = value => { try { return JSON.parse(value) } catch { return null } }
const hexRevision = /^r_[a-f0-9]{64}$/

function cookieFingerprint(req) {
  const token = /(?:^|;\s*)deva-workbench-local=([a-zA-Z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1]
  return token && createHash('sha256').update(token).digest('base64url')
}

function prepareReceipt(body) {
  return body && Object.keys(body).length === 3 && intentId.test(body.id) && allowedPaths.includes(body.path) &&
    Number.isSafeInteger(body.ttlMs) && body.ttlMs > 0 ? { id: body.id, path: body.path } : null
}

// Per-request diagnostic hooks are attached only to the private real listener. They do not read
// from the request stream, add a competing body consumer, or replace business dispatch. Only
// allowlisted synthetic fields and status codes are retained; authentication bodies stay untouched.
export function observeDocumentWire({ address, origin }, signal) {
  const observations = channel('http.server.request.start')
  const events = [], auth = [], expectedWrites = []
  let forbidden = 0, truncation, didTruncate = false
  function capture(req, res, entry) {
    let size = 0
    const chunks = []
    const push = req.push
    req.push = function (chunk, ...args) {
      if (chunk !== null) {
        size += Buffer.byteLength(chunk)
        if (size <= bodyLimit) chunks.push(Buffer.from(chunk))
      }
      return Reflect.apply(push, this, [chunk, ...args])
    }
    const fault = truncation && entry.wid === truncation.wid && entry.intent === truncation.intent && entry.action === 'create'
    if (fault) {
      const writeHead = res.writeHead
      res.writeHead = function (status, headers) {
        if (status === 201 && headers && typeof headers === 'object') headers = { ...headers, connection: 'close' }
        return Reflect.apply(writeHead, this, [status, headers])
      }
    }
    const end = res.end
    res.end = function (chunk, ...args) {
      const requestBody = size <= bodyLimit ? parse(Buffer.concat(chunks)) : null
      entry.body = allowedBodies.find(body => isDeepStrictEqual(body, requestBody))
      chunks.length = 0
      const responseBody = (typeof chunk === 'string' || Buffer.isBuffer(chunk)) && Buffer.byteLength(chunk) <= bodyLimit
        ? parse(chunk) : null
      if (entry.action === 'document-intents' && res.statusCode === 201) entry.receipt = prepareReceipt(responseBody)
      if (entry.action === 'status' && res.statusCode === 200) entry.confirmedReceipt = Boolean(responseBody?.state === 'created' &&
        responseBody.path === uncertainPath && hexRevision.test(responseBody.revision))
      if (entry.action === 'cancel' && res.statusCode === 200) entry.retired = isDeepStrictEqual(responseBody, { closed: true })
      if (entry.action === 'create' && res.statusCode === 409) entry.conflict = responseBody?.error === 'document_exists'
      if (entry.action === 'read' && res.statusCode === 200)
        entry.exactRead = Boolean(responseBody && entry.body && allowedTexts.has(entry.body.path) &&
          responseBody.path === entry.body.path && responseBody.content === allowedTexts.get(entry.body.path) && hexRevision.test(responseBody.revision))
      if (fault && res.statusCode === 201 && Buffer.isBuffer(chunk) && chunk.length > 1) {
        // The real handler has already committed and sent the authentic 201 headers, including
        // the full length. Shorten only the final bytes and close this connection, exactly once.
        didTruncate = true
        truncation = undefined
        return Reflect.apply(end, this, [chunk.subarray(0, 1), ...args])
      }
      return Reflect.apply(end, this, [chunk, ...args])
    }
    res.once('finish', () => { entry.status = res.statusCode })
  }
  function observe({ request: req, response: res }) {
    if (req.socket.localPort !== address.port) return
    const path = req.url ?? ''
    const match = workspaceRoute.exec(path)
    if (match && req.method === 'POST' && events.length < 200) {
      const [, wid, directAction, intent, createAction] = match
      const entry = { wid, action: directAction ?? createAction, intent, owner: cookieFingerprint(req),
        authenticatedTransport: req.headers.origin === origin && req.headers['sec-fetch-site'] === 'same-origin' &&
          /^[a-zA-Z0-9_-]{43}$/.test(req.headers['x-deva-csrf'] ?? '') &&
          /^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '') }
      events.push(entry)
      capture(req, res, entry)
    } else if (req.method === 'POST' && authRoute.test(path) && auth.length < 4) {
      const entry = { action: authRoute.exec(path)[1], origin: req.headers.origin === origin, fresh: !cookieFingerprint(req) }
      auth.push(entry)
      res.once('finish', () => { entry.status = res.statusCode })
    } else if (!['GET', 'HEAD'].includes(req.method) || dangerousRead.test(path) || /\/terminals(?:[/?]|$)/.test(path)) forbidden++
  }
  observations.subscribe(observe)
  return {
    mark: () => events.length,
    async after(mark, { wid, action, body, status, owner, intent }) {
      const row = await waitFor(() => events.slice(mark).find(entry => entry.action === action && entry.status),
        `real ${action} response for the explicit workspace action`, { signal })
      const matching = events.slice(mark).filter(entry => entry.action === action && isDeepStrictEqual(entry.body, body))
      check(row.wid === wid && row.intent === intent && row.status === status && row.owner &&
        (!owner || row.owner === owner) && row.authenticatedTransport && isDeepStrictEqual(row.body, body) && matching.length === 1,
      `Unexpected method, owner scope, payload, or status for ${action}`)
      if (transactions.has(action)) expectedWrites.push(row)
      return row
    },
    cutOneCreate(wid, intent) {
      check(!truncation && !didTruncate && intentId.test(intent), 'Expected one deliberate truncated create acknowledgement')
      truncation = { wid, intent }
    },
    assertTruncated() { check(didTruncate && !truncation, 'The selected authentic 201 response was not truncated') },
    assertAuth() {
      check(auth.length === 2 && auth[0].action === 'claim' && auth[1].action === 'login' &&
        auth.every(entry => entry.origin && entry.fresh && entry.status === 200),
      'Both fresh profiles must complete real, independent owner authentication')
    },
    idle() {
      const writes = events.filter(entry => transactions.has(entry.action))
      check(!forbidden && events.every(entry => entry.owner && entry.authenticatedTransport && entry.body) &&
        writes.length === expectedWrites.length && writes.every((entry, index) => entry === expectedWrites[index]),
      'The browser dispatched an extra document transaction, chat/model/terminal command, or unscoped workspace request')
    },
    close: () => observations.unsubscribe(observe)
  }
}
