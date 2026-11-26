import { opencodeModelsURL, providerHeaders } from './opencode'
import { httpError } from './protocol'
import type { ProviderRuntime, ProviderTransport, StreamChatConfig } from './runtime'
import type { ErrorKind, NormalizedError } from './types'

export interface ListModelsResult {
  ok: boolean
  models?: string[]
  kind?: ErrorKind
  message?: string
}

const TIMEOUT_MS = 15_000

function normalizeBase(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

/** 带超时的 fetch；超时按 AbortError 抛出，交由 networkError 归一。 */
async function fetchWithTimeout(
  httpFetch: ProviderTransport['httpFetch'],
  url: string,
  init: RequestInit
): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    return await httpFetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

function networkError(e: unknown, describeNetError: ProviderTransport['describeNetError']): NormalizedError {
  const aborted = (e as Error)?.name === 'AbortError'
  return {
    kind: 'network',
    retryable: true,
    message: aborted ? `请求超时（${TIMEOUT_MS / 1000}s）` : describeNetError(e)
  }
}

/** 从各家 /models 响应中抽取模型 ID（OpenAI: data[].id；个别实现: models[].id/name）。 */
function extractModelIds(json: unknown): string[] {
  const root = json as { data?: unknown[]; models?: unknown[] } | null
  const arr = Array.isArray(root?.data)
    ? root!.data
    : Array.isArray(root?.models)
      ? root!.models
      : []
  const ids = arr
    .map((it) => {
      const o = it as { id?: unknown; name?: unknown }
      const v = typeof o?.id === 'string' ? o.id : typeof o?.name === 'string' ? o.name : ''
      return v
    })
    .filter((v): v is string => Boolean(v))
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b))
}

/** 拉取模型清单：失败结果与桌面 IPC 相同。 */
export async function listModels(deps: ProviderRuntime, cfg: StreamChatConfig): Promise<ListModelsResult> {
  const apiKey = (await deps.getSecret(cfg.providerId)) ?? ''
  const base = normalizeBase(cfg.baseURL)
  // 清单地址：opencode 网关只在推理根下给 /v1/models（各 API 路径下没有清单，照常规拼法必 404）；
  // 同一份清单服务三套协议——网关对每个模型都提供了跨协议翻译，故不按适配器筛选。
  const url =
    opencodeModelsURL(base) ?? (cfg.adapter === 'anthropic' ? `${base}/v1/models` : `${base}/models`)
  const authHeaders: Record<string, string> =
    cfg.adapter === 'anthropic'
      ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
      : { authorization: `Bearer ${apiKey}` }
  try {
    const res = await fetchWithTimeout(deps.httpFetch, url, {
      headers: { ...authHeaders, ...providerHeaders(deps, base, cfg.providerId) }
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const err = httpError(deps.isEn(), res.status, text)
      return { ok: false, kind: err.kind, message: err.message }
    }
    const json = await res.json().catch(() => null)
    return { ok: true, models: extractModelIds(json) }
  } catch (e) {
    const err = networkError(e, deps.describeNetError)
    return { ok: false, kind: err.kind, message: err.message }
  }
}
