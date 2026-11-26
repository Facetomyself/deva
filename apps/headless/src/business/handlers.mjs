import { createProviderCore } from '../../dist/provider-core.mjs'
import { HttpError, json, readJson } from '../http/policy.mjs'
import { openSettings } from './settings.mjs'
import { allowedModelOrigins, providerFetch } from './provider-fetch.mjs'

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
const normalizeBase = (value) => value.trim().replace(/\/+$/, '')

/** Use a single immutable provider snapshot for URL, credentials and headers. The browser may
 * request a known provider but never independently select the destination for its stored key. */
async function probe(settings, supplied, opts, signal) {
  exact(supplied, ['providerId', 'adapter', 'baseURL'])
  if (!text(supplied.providerId) || !text(supplied.baseURL) || !['openai', 'anthropic', 'responses'].includes(supplied.adapter)) throw new HttpError(400, 'invalid_probe')
  const p = await settings.getProvider(supplied.providerId)
  if (!p) throw new HttpError(404, 'provider_not_found')
  if (p.adapter !== supplied.adapter || normalizeBase(p.apiHost) !== normalizeBase(supplied.baseURL)) throw new HttpError(409, 'provider_changed')
  const boundedFetch = providerFetch({ baseURL: p.apiHost, allowedOrigins: opts.allowedOrigins, maxBytes: 2 * 1024 * 1024, configuredCookie: p.headers?.cookie })
  const client = createProviderCore({
    httpFetch: (url, init = {}) => boundedFetch(url, { ...init, signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal }),
    describeNetError: () => '服务商连接失败', getAppVersion: () => opts.version,
    getSecret: (id) => id === p.id ? p.apiKey : null,
    providerCustomHeaders: (id) => id === p.id ? (p.headers ?? {}) : {}
  })
  const result = await client.listModels({ providerId: p.id, baseURL: p.apiHost, adapter: p.adapter })
  if (!result.ok) {
    // A remote provider can echo our Authorization or other confidential headers in an error.
    // Only the normalized kind crosses back to the renderer.
    const kind = result.kind ?? 'unknown'
    const msg = kind === 'auth' ? '服务商未接受当前凭据' : kind === 'network' ? '服务商连接失败，请检查配置的地址和网络' : '服务商未返回可用的模型清单'
    return { ok: false, kind, message: msg }
  }
  const privateValues = [p.apiKey, ...Object.values(p.headers ?? {})].filter(text)
  const models = (result.models ?? []).filter((m) => text(m) && m.length <= 512 && !/[\x00-\x1f\x7f]/.test(m) &&
    !privateValues.some((v) => m === v || (v.length >= 4 && m.includes(v)))).slice(0, 2048)
  return { ok: true, models }
}

export async function openBusiness({ dataDir, vault, version, allowedOrigins = [] }) {
  const opts = { version, allowedOrigins: [...allowedModelOrigins(allowedOrigins)] }
  const settings = await openSettings({ dataDir, vault })
  const lifetime = new AbortController()
  return {
    getConfig: () => settings.getPublicConfig(),
    async handle(req, res, { auth, policy }) {
      const path = (req.url ?? '').split('?', 1)[0]
      const match = keyPath.exec(path)
      if (!names.has(path) && !match) return false
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
    close() { lifetime.abort() }
  }
}
