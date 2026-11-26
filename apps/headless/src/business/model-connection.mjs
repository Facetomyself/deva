import { createProviderCore } from '../../dist/provider-core.mjs'
import { HttpError } from '../http/policy.mjs'
import { providerFetch } from './provider-fetch.mjs'

const trimBase = s => s.trim().replace(/\/+$/, '')
const text = s => typeof s === 'string' && s.trim().length > 0

/** An internal per-operation binding: key, headers, adapter and address all come from the
 * same server-side provider snapshot. Callers get protocol operations, never the key. */
export async function connectProvider(settings, id, { version, allowedOrigins, signal, expected, modelId }) {
  if (!text(id) || (expected && (!text(expected.baseURL) || !text(expected.adapter)))) throw new HttpError(400, 'invalid_provider')
  const p = await settings.getProvider(id)
  if (!p) throw new HttpError(404, 'provider_not_found')
  if (expected && (p.adapter !== expected.adapter || trimBase(p.apiHost) !== trimBase(expected.baseURL))) throw new HttpError(409, 'provider_changed')
  if (p.purpose === 'decision' || !['openai', 'anthropic', 'responses'].includes(p.adapter) || !text(p.apiHost)) throw new HttpError(422, 'not_chat_provider')
  if (modelId !== undefined && (!text(modelId) || !p.enabled || !p.models.some(m => m.id === modelId && m.enabled))) throw new HttpError(422, 'model_not_enabled')
  const cfg = { providerId: p.id, baseURL: p.apiHost, adapter: p.adapter }
  const requests = providerFetch({ baseURL: p.apiHost, allowedOrigins, maxBytes: modelId ? 32 * 1024 * 1024 : 2 * 1024 * 1024, configuredCookie: p.headers?.cookie })
  const core = createProviderCore({
    httpFetch: (url, init = {}) => {
      const signals = [signal, init.signal].filter(Boolean)
      return requests(url, { ...init, signal: signals.length ? AbortSignal.any(signals) : undefined })
    },
    describeNetError: () => '服务商连接失败', getAppVersion: () => version,
    getSecret: k => k === p.id ? p.apiKey : null,
    providerCustomHeaders: k => k === p.id ? (p.headers ?? {}) : {}
  })
  return Object.freeze({
    async listModels() {
      const result = await core.listModels(cfg)
      if (!result.ok) {
        const kind = result.kind ?? 'unknown'
        const message = kind === 'auth' ? '服务商未接受当前凭据' : kind === 'network' ? '服务商连接失败，请检查配置的地址和网络' : '服务商未返回可用的模型清单'
        return { ok: false, kind, message }
      }
      const values = [p.apiKey, ...Object.values(p.headers ?? {})].filter(text)
      const models = (result.models ?? []).filter(m => text(m) && m.length <= 512 && !/[\x00-\x1f\x7f]/.test(m) && !values.some(v => m === v || (v.length >= 4 && m.includes(v)))).slice(0, 2048)
      return { ok: true, models }
    },
    // Internal server-only: the request is assembled from authorized session state, not copied
    // from a browser. The chosen model is fixed here. Turn code consumes the desktop protocol.
    streamChat(req) {
      if (!modelId) throw new HttpError(422, 'no_selected_model')
      return core.streamChat(cfg, { ...req, model: modelId })
    }
  })
}
