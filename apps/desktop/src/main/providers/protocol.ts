import { parseContextLimit, parseContextOverflow } from '../../shared/context'
import type { BrokenCallCause, ImagePart, NormalizedError, StopReason, StreamEvent } from './types'

/**
 * 工具结果图片的引子。OpenAI 两套协议的工具结果只收文本，图片只能挪进随后的 user 消息——
 * 用这句讲明它们属于上方工具结果，免得模型当成用户新发来的图。
 */
export function toolImagesNote(images: ImagePart[]): string {
  const names = images.map((i) => i.name).filter(Boolean).join('、')
  return `[以下 ${images.length} 张图片是上方工具结果的附件${names ? `：${names}` : ''}]`
}

/** 解析工具参数 JSON：空串视为无参数 `{}`；解析失败返回 undefined（多半是被截在了中途）。 */
export function parseToolArgs(raw: string): unknown {
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/**
 * 参数没能完整解析的工具调用收尾（三个适配器共用）：一律如实上报为 tool_call_truncated，按 stopReason
 * 定性。此前非截断的坏参数被当成参数为 `{}` 的完整调用交出去执行，工具只报「缺少 path 参数」——模型以为
 * 漏填了参数，原样重发同一个超长调用，反复失败也不停（连续截断的闸门管不到它）。
 */
export function* settleBrokenCalls(
  broken: { id: string; name: string; raw: string }[],
  stopReason: StopReason
): Generator<StreamEvent> {
  const cause: BrokenCallCause =
    stopReason === 'max_tokens' ? 'max_tokens' : stopReason === 'refusal' ? 'refusal' : 'invalid'
  for (const c of broken)
    yield { type: 'tool_call_truncated', id: c.id, name: c.name, partialArgs: c.raw, cause }
}

/** 响应体摘要：折叠空白、限长。中转 / 网关常把真正原因（上游额度用尽、内容拦截等）写在这里。 */
function bodyHint(body: string, en: boolean): string {
  const s = body.replace(/\s+/g, ' ').trim().slice(0, 200)
  return s ? `${en ? ': ' : '：'}${s}` : ''
}

/** 带内错误里认作上下文超限的明确句式（不用 httpError 那条按 token / length 字眼的宽匹配）。 */
const INBAND_CONTEXT = /context[ _-]?(length|window)|prompt is too long|too many (input )?tokens|exceeds? (the )?(maximum )?context/i

/**
 * 带内错误里认作「连接中途断开」的句式：中转与上游之间的连接在回复到一半时断了，网关把它包成流里的错误发来
 *（如「Codex: connection lost mid-reply (unexpectedEOF)」「stream disconnected before completion」）。
 * 本质同本地断线，只是断在中转那一段。
 */
const INBAND_DISCONNECT =
  /unexpected[ _-]?eof|connection (was )?(lost|reset|closed|aborted|terminated|interrupted|dropped)|(stream|upstream) (was )?(disconnected|closed|interrupted|terminated|reset)|disconnected before completion|premature close|socket hang up|other side closed|ECONNRESET|broken pipe|连接(已|被)?(中断|断开|丢失|重置|关闭)|上游(连接)?(已)?(中断|断开)/i

/**
 * 带内错误（HTTP 200 之后在流里报的错：网关常把上游的 400 包成这样，如「Streaming response failed: [400]
 * This model's maximum context length is …」，issue #43）：正文认得出上下文超限 / 输出上限被拒的，与 HTTP 400
 * 同样归类，引擎的自愈（调小输出预算、压缩后重发）才用得上；认得出是连接中途断开的，按可重试的网络错误处理，
 * 引擎自动重连、重发本步（同本地断线）；其余照旧按 fallback（多为服务端错误）。
 */
export function inbandError(
  isEn: () => boolean,
  text: string,
  fallback: NormalizedError
): NormalizedError {
  const contextual =
    INBAND_CONTEXT.test(text) ||
    parseContextLimit(text) !== undefined ||
    parseContextOverflow(text) !== undefined
  if (contextual) return httpError(isEn(), 400, text)
  if (INBAND_DISCONNECT.test(text)) return { kind: 'network', retryable: true, message: fallback.message }
  return fallback
}

/** 解析 retry-after 头（秒数或 HTTP 日期）→ 毫秒；无效返回 undefined。 */
function parseRetryAfter(v: string | null | undefined): number | undefined {
  if (!v) return undefined
  const sec = Number(v)
  if (Number.isFinite(sec) && sec >= 0) return Math.round(sec * 1000)
  const at = Date.parse(v)
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now())
}

/**
 * 请求被拒是否因为 max_tokens / max_output_tokens / max_completion_tokens 超出该模型允许的输出上限
 *（中转 / 老模型常见）。引擎据此把输出预算降回保守值重发，而不是整轮报错。
 */
export function isOutputLimitRejection(status: number, body: string): boolean {
  return status === 400 && /max_(output_|completion_)?tokens/i.test(body)
}

/**
 * 请求被拒是否因为思考等级参数（reasoning_effort / output_config.effort / adaptive thinking 等）不被该模型
 * 或网关接受。只在请求确实带了这些参数时才作此判定（effortSent），否则同样字眼的 400 照常归类。
 */
function isEffortRejection(status: number, body: string): boolean {
  return status === 400 && /reasoning_effort|reasoning|effort|output_config|thinking|adaptive/i.test(body)
}

/**
 * 403：密钥多半是对的，被拒另有原因——账号没有该模型的权限、地区受限、余额 / 套餐不符，或中转只放行特定
 * 客户端（按 UA / `originator` 识别，issue #77）。此前与 401 一并报成「请检查 API 密钥」，用户照做也无济于事，
 * 真正的原因写在响应正文里却没显示。这里把正文带出来；正文为空或是整页 HTML（WAF 拦截页）时给出排查方向。
 * kind 仍为 'auth'：不重试，接入引导等按「凭据 / 权限问题」处理的地方照旧。
 */
function forbiddenError(body: string, en: boolean): NormalizedError {
  const hint = /^\s*</.test(body) ? '' : bodyHint(body, en)
  const advice = en
    ? ': check the API key, your account’s access to this model, and whether the provider restricts which clients may connect.'
    : '：请检查 API 密钥、账号对该模型的权限，以及该服务商是否限制了可接入的客户端。'
  return {
    kind: 'auth',
    retryable: false,
    message: en
      ? `The provider refused the request (403)${hint || advice}`
      : `服务商拒绝了请求（403）${hint || advice}`
  }
}

/**
 * HTTP 状态码 → 归一化错误。retryAfter 为响应头 retry-after 原值（可选）；
 * effortSent = 本次请求带了思考等级参数（见 GenerateRequest.effort）。
 * message 会直接显示给用户，由宿主选用中 / 英文。
 */
export function httpError(
  en: boolean,
  status: number,
  body: string,
  retryAfter?: string | null,
  effortSent?: boolean
): NormalizedError {
  // Anthropic 的「输入 + max_tokens 超出窗口」也落在这一类，其报错里写着真实窗口，一并带上。
  if (isOutputLimitRejection(status, body))
    return {
      kind: 'output_limit',
      retryable: false,
      message: en
        ? `The requested output limit exceeds what this model allows (${status})${bodyHint(body, en)}`
        : `请求的输出上限超出该模型允许范围（${status}）${bodyHint(body, en)}`,
      limit: parseContextLimit(body),
      overflow: parseContextOverflow(body)
    }
  if (status === 401)
    return {
      kind: 'auth',
      retryable: false,
      message: en
        ? `Authentication failed (${status}). Check your API key.`
        : `鉴权失败（${status}）：请检查 API 密钥。`
    }
  if (status === 403) return forbiddenError(body, en)
  if (status === 429)
    return {
      kind: 'rate_limit',
      retryable: true,
      message: en
        ? `Rate limited (429). Try again later${bodyHint(body, en)}`
        : `触发限流（429），请稍后重试${bodyHint(body, en)}`,
      retryAfterMs: parseRetryAfter(retryAfter)
    }
  // 须在 context_length 之前：后者的正则很宽（token / maximum…），参数被拒的报错常被它误吞。
  if (effortSent && isEffortRejection(status, body))
    return {
      kind: 'effort_unsupported',
      retryable: false,
      message: en
        ? `This model doesn't support the selected thinking level (${status})${bodyHint(body, en)}`
        : `该模型不支持所选思考等级（${status}）${bodyHint(body, en)}`
    }
  if (status === 400 && /context|token|length|maximum/i.test(body))
    return {
      kind: 'context_length',
      retryable: false,
      message: en
        ? 'The conversation is longer than this model’s context window. Start a new chat, or switch to a model with a larger context window and try again.'
        : '对话长度已超出该模型的上下文上限，无法继续。请新建对话，或换用上下文更大的模型后重试。',
      limit: parseContextLimit(body),
      overflow: parseContextOverflow(body)
    }
  if (status >= 500)
    return {
      kind: 'server',
      retryable: true,
      message: en ? `Server error (${status})${bodyHint(body, en)}` : `服务端错误（${status}）${bodyHint(body, en)}`,
      retryAfterMs: parseRetryAfter(retryAfter)
    }
  return {
    kind: 'invalid_request',
    retryable: false,
    message: en
      ? `Request failed (${status}): ${body.slice(0, 300)}`
      : `请求失败（${status}）：${body.slice(0, 300)}`
  }
}
