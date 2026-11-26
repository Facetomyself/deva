import { connectProvider } from './model-connection.mjs'
import { createEventJournal } from '../events/index.mjs'
import { createChatWebSocket } from '../events/websocket.mjs'
import { createTextTurns } from '../chat/text-turns.mjs'
import { chatRoutes } from '../chat/routes.mjs'
import { HttpError, json, readJson } from '../http/policy.mjs'
import { openSettings } from './settings.mjs'
import { allowedModelOrigins } from './provider-fetch.mjs'
import { openLibrary } from './library-routes.mjs'

const keyPath = /^\/api\/v1\/provider-keys\/([A-Za-z0-9_.-]{1,128})$/
const names = new Set(['/api/v1/settings', '/api/v1/provider-keys', '/api/v1/provider-models'])
function exact(obj, fields) {
  if (Object.keys(obj).length !== fields.length || !fields.every((key) => Object.hasOwn(obj, key))) throw new HttpError(400, 'invalid_fields')
}
function revision(value) {
  if (value === undefined) throw new HttpError(409, 'revision_required')
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new HttpError(400, 'invalid_revision')
  return value
}
const errors = Object.freeze({
  ERR_SETTINGS_INVALID: [400, 'invalid_settings'], ERR_SETTINGS_REVISION_REQUIRED: [409, 'revision_required'],
  ERR_SETTINGS_CONFLICT: [409, 'conflict'], ERR_SETTINGS_PROVIDER_NOT_FOUND: [404, 'provider_not_found'],
  ERR_SETTINGS_READ_ONLY: [503, 'storage_unavailable'], ERR_SETTINGS_UNAVAILABLE: [503, 'storage_unavailable'],
  ERR_PROVIDER_EGRESS: [422, 'provider_origin_not_permitted'], AUTH_FAILED: [401, 'auth']
})
function statusFor(err) {
  if (err instanceof HttpError) return [err.status, err.code]
  return Object.hasOwn(errors, err?.code) ? errors[err.code] : [500, 'internal']
}
const text = (str) => typeof str === 'string' && str.trim().length > 0

/** Use a single immutable provider snapshot for URL, credentials and headers. The browser may
 * request a known provider but never independently select the destination for its stored key. */
async function probe(settings, supplied, opts, signal) {
  exact(supplied, ['providerId', 'adapter', 'baseURL'])
  if (!text(supplied.providerId) || !text(supplied.baseURL) || !['openai', 'anthropic', 'responses'].includes(supplied.adapter)) throw new HttpError(400, 'invalid_probe')
  const connection = await connectProvider(settings, supplied.providerId, { ...opts, expected: supplied, signal })
  return connection.listModels()
}

export async function openBusiness({ dataDir, vault, version, allowedOrigins = [], workspaceRoot, privateRoots }) {
  const opts = { version, allowedOrigins: [...allowedModelOrigins(allowedOrigins)] }
  const settings = await openSettings({ dataDir, vault })
  const lifetime = new AbortController()
  const journal = createEventJournal()
  let library, turns
  try {
    library = await openLibrary({ dataDir, workspaceRoot, privateRoots })
    turns = createTextTurns({ dataDir, settings, journal, ...opts, resolveRole: library.resolveRole })
  } catch (err) { journal.close(); await library?.close(); throw err }
  const chats = chatRoutes(turns, { withRoleForChat: library.withRoleForChat })
  return {
    capabilities: Object.freeze({ textChat: true, library: true }),
    createRealtime: ({ auth, policy }) => createChatWebSocket({ turns, journal, auth, policy }),
    getConfig: () => settings.getPublicConfig(),
    async handle(req, res, { auth, policy }) {
      const path = (req.url ?? '').split('?', 1)[0]
      if (path === '/api/v1/chats' || path.startsWith('/api/v1/chats/')) return chats(req, res, { auth, policy })
      const match = keyPath.exec(path)
      if (!names.has(path) && !match) return library.handle(req, res, { auth, policy })
      const methods = match ? ['PUT', 'DELETE'] : path === '/api/v1/settings' ? ['GET', 'PATCH'] : path.endsWith('models') ? ['POST'] : ['GET']
      const write = req.method !== 'GET'
      try {
        policy.check(req, write)
        if (req.url !== path) throw new HttpError(400, 'unexpected_query')
        if (!methods.includes(req.method)) { json(res, 405, { error: 'method' }, { allow: methods.join(', ') }); return true }
        const cookie = policy.cookie(req)
        if (write) auth.authenticate(cookie, req.headers['x-deva-csrf']); else auth.authenticate(cookie)
        if (lifetime.signal.aborted) throw new HttpError(503, 'shutting_down')
        if (path === '/api/v1/settings' && !write) {
          const { revision: rev, ...config } = await settings.getPublicConfig()
          json(res, 200, { config, revision: rev })
        } else if (path === '/api/v1/settings') {
          const body = await readJson(req, 1024 * 1024)
          revision(body.revision)
          const { revision: rev, ...config } = await settings.patch(body)
          json(res, 200, { ok: true, revision: rev, config })
        } else if (match) {
          if (['.', '..', '__proto__', 'constructor', 'prototype'].includes(match[1])) throw new HttpError(400, 'invalid_provider')
          const body = await readJson(req, 70 * 1024); const rev = revision(body.revision)
          exact(body, req.method === 'PUT' ? ['value', 'revision'] : ['revision'])
          if (req.method === 'PUT' && typeof body.value !== 'string') throw new HttpError(400, 'invalid_fields')
          const result = req.method === 'PUT' ? await settings.setKey(match[1], body.value, rev) : await settings.deleteKey(match[1], rev)
          json(res, 200, { ok: true, available: result.available, revision: result.revision })
        } else if (path === '/api/v1/provider-keys') {
          json(res, 200, { ids: await settings.listKeys(), available: await settings.available() })
        } else {
          const ctrl = new AbortController(); const closed = () => { if (!res.writableEnded) ctrl.abort() }
          res.once('close', closed)
          try { json(res, 200, await probe(settings, await readJson(req), opts, AbortSignal.any([lifetime.signal, ctrl.signal]))) }
          finally { res.off('close', closed) }
        }
      } catch (err) {
        const [status, code] = statusFor(err)
        if (!res.destroyed && !res.headersSent) json(res, status, { error: code }, write ? { connection: 'close' } : {})
      }
      return true
    },
    async close() {
      lifetime.abort()
      try { await turns.close() } finally { journal.close(); await library.close() }
    }
  }
}
