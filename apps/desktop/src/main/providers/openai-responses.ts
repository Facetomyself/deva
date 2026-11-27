import { iterateSSE, STREAM_IDLE_MS } from './sse'
import {
  httpError,
  inbandError,
  parseToolArgs,
  settleBrokenCalls,
  toolImagesNote,
  type AdapterConfig,
  type AdapterTransport,
  type ContentPart,
  type GenerateRequest,
  type Message,
  type StopReason,
  type StreamEvent
} from './types'
import { isEn } from '../locale'

/**
 * OpenAI Responses API 适配器（POST {baseURL}/responses，stream:true）。
 * 与 Chat Completions（openai.ts）并列的第二套 OpenAI 协议：面向 OpenAI 官方新接口。
 *
 * 归一化要点（与本应用的 Anthropic 风味 Message[] 对接）：
 *  - system → 顶层 `instructions`（无状态，每轮都发）。
 *  - 消息拍平成 Responses 的 `input` 数组：assistant 文本→{role:'assistant',content:[output_text]}，
 *    tool_use→独立 {type:'function_call',call_id,name,arguments}；user 文本/图片/PDF→{role:'user',content:[...]}，
 *    tool_result→独立 {type:'function_call_output',call_id,output}。
 *  - 工具声明用 Responses 的**扁平**形状 {type:'function',name,description,parameters}（非 Chat 的 function 嵌套）。
 *  - `call_id` 是串联 function_call ↔ function_call_output 的键：流式时取自 output_item，作 tool_call.id 上抛，
 *    结果回灌时 tool_result.toolUseId 即以此匹配。
 *
 * 无状态设计（与 anthropic.ts / openai.ts 一致）：不使用 previous_response_id、每轮重发全量历史；
 * `store:false` 不在服务端留存（隐私一致）。刻意不回传 reasoning items（本应用不持久化思维链），
 * 非推理模型与文本/单步场景完全可用；推理模型多步工具链在极端情况下可能要求 reasoning 连续性——
 * 届时可改用 Chat Completions 适配器。收到 reasoning 摘要增量仍会作为 thinking 展示（但不主动请求）。
 */

/** Responses 富内容块（input 用）。图片/文件为输入块，assistant 文本回放为 output_text。 */
type ResponsesContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string }
  | { type: 'input_file'; filename: string; file_data: string }
  | { type: 'output_text'; text: string }

/** Responses input 顶层项：消息项，或独立的函数调用/调用结果项。 */
type ResponsesInputItem =
  | { role: 'user' | 'assistant'; content: ResponsesContentPart[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }

/** 把归一化消息展开成 Responses 的 input 序列（工具调用/结果各自成独立顶层项）。 */
function mapInput(messages: Message[], textOnly?: boolean): ResponsesInputItem[] {
  const out: ResponsesInputItem[] = []

  for (const m of messages) {
    if (typeof m.content === 'string') {
      if (m.content)
        out.push({ role: m.role, content: [{ type: textOnly && m.role === 'assistant' ? 'output_text' : 'input_text', text: m.content }] })
      continue
    }

    if (m.role === 'assistant') {
      const text = m.content
        .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join('')
      if (text) out.push({ role: 'assistant', content: [{ type: 'output_text', text }] })
      if (textOnly) continue
      for (const p of m.content) {
        if (p.type === 'tool_use')
          out.push({
            type: 'function_call',
            call_id: p.id,
            name: p.name,
            arguments: JSON.stringify(p.input ?? {})
          })
      }
      continue
    }

    // user 消息：先落工具结果（独立项），再把文本/图片/PDF 并成一条 user 消息。
    const parts: ResponsesContentPart[] = []
    for (const p of m.content) {
      if (p.type === 'text') parts.push({ type: 'input_text', text: p.text })
      else if (textOnly) continue
      else if (p.type === 'tool_result') {
        out.push({ type: 'function_call_output', call_id: p.toolUseId, output: p.content })
        // output 按字符串发（块数组形式并非所有网关都认）；工具返回的图片与 Chat 适配器同样挪进随后的 user 消息。
        if (p.images?.length) {
          parts.push({ type: 'input_text', text: toolImagesNote(p.images) })
          for (const img of p.images)
            parts.push({ type: 'input_image', image_url: `data:${img.mediaType};base64,${img.data}` })
        }
      } else if (p.type === 'image')
        parts.push({ type: 'input_image', image_url: `data:${p.mediaType};base64,${p.data}` })
      else if (p.type === 'document')
        parts.push({
          type: 'input_file',
          filename: p.name ?? 'document.pdf',
          file_data: `data:${p.mediaType};base64,${p.data}`
        })
    }
    if (parts.length) out.push({ role: 'user', content: parts })
  }

  return out
}

/** 累积中的函数调用（键为 Responses 的 output item id，如 fc_...）。 */
interface PendingCall {
  callId: string
  name: string
  args: string
}

export async function* streamResponses(
  cfg: AdapterConfig,
  req: GenerateRequest,
  transport: AdapterTransport
): AsyncGenerator<StreamEvent> {
  const { fetchModel, describeNetError, textOnly } = transport
  const url = `${cfg.baseURL.replace(/\/$/, '')}/responses`
  const body = {
    model: req.model,
    instructions: req.system,
    input: mapInput(req.messages, textOnly),
    tools: textOnly ? undefined : req.tools?.map((t) => ({
      type: 'function' as const,
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
      // 严格模式要求 schema 满足额外约束（全 required + additionalProperties:false），
      // 本应用工具 schema 未必满足，关闭以免服务端 400。
      strict: false
    })),
    // 输出上限：未指定时给 8192（与 anthropic 一致，降低长回复被截断概率）。
    max_output_tokens: req.maxTokens ?? 8192,
    temperature: req.temperature,
    // 思考等级（值已按模型能力表映射）。不请求 summary：未认证的组织请求推理摘要会被 400。
    reasoning: req.effort ? { effort: req.effort.effort } : undefined,
    // 无状态使用：不留存于服务端（隐私一致），亦不使用 previous_response_id。
    store: false,
    stream: true
  }

  let res: Response
  try {
    res = await fetchModel(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
        ...cfg.headers
      },
      body: JSON.stringify(body),
      signal: req.signal
    })
  } catch (e) {
    if ((e as Error)?.name === 'AbortError' || (textOnly && req.signal?.aborted)) {
      yield { type: 'done', stopReason: 'aborted' }
      return
    }
    if (!textOnly)
      yield { type: 'error', error: { kind: 'network', retryable: true, message: describeNetError(e) } }
    yield { type: 'done', stopReason: 'error' }
    return
  }

  if (textOnly && (!res.ok || req.signal?.aborted)) {
    void res.body?.cancel().catch(() => {})
    yield { type: 'done', stopReason: req.signal?.aborted ? 'aborted' : 'error' }
    return
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    yield {
      type: 'error',
      error: httpError(res.status, text, res.headers.get('retry-after'), Boolean(req.effort))
    }
    yield { type: 'done', stopReason: 'error' }
    return
  }

  yield* readResponses(res, req.signal, transport)
}

function isTextOutputPart(value: unknown): boolean {
  const part = value as { type?: unknown; text?: unknown; refusal?: unknown } | null | undefined
  return (part?.type === 'output_text' && typeof part.text === 'string') ||
    (part?.type === 'refusal' && typeof part.refusal === 'string')
}

function isTextOutputItem(value: unknown): boolean {
  const item = value as { type?: unknown; role?: unknown; content?: unknown } | null | undefined
  if (item?.type === 'reasoning') return true // Private reasoning is ignored, not surfaced.
  return item?.type === 'message' &&
    (item.role === undefined || item.role === 'assistant') &&
    (item.content === undefined || (Array.isArray(item.content) && item.content.every(isTextOutputPart)))
}

function rejectsTextEvent(type: unknown): boolean {
  return typeof type === 'string' && (
    type === 'error' || type === 'response.error' || type === 'response.failed' ||
    type === 'response.cancelled' ||
    // Argument and hosted-tool events may arrive without a corresponding output item.
    /^response\.(?:[^.]*_call(?:[._]|$)|mcp_|(?:output_)?audio[._])/.test(type)
  )
}

function textOnlyTerminal(evt: Record<string, unknown>): 'end_turn' | 'max_tokens' | 'error' | undefined {
  const { type } = evt
  const response = evt.response as {
    status?: unknown
    error?: unknown
    output?: unknown
    incomplete_details?: { reason?: unknown } | null
  } | null | undefined

  if (rejectsTextEvent(type) || evt.error != null || response?.error != null) return 'error'
  if ((type === 'response.output_item.added' || type === 'response.output_item.done') &&
      !isTextOutputItem(evt.item)) return 'error'
  if ((type === 'response.content_part.added' || type === 'response.content_part.done') &&
      !isTextOutputPart(evt.part)) return 'error'
  // A terminal snapshot can be the first place an unsolicited output item appears.
  if (response?.output !== undefined &&
      (!Array.isArray(response.output) || !response.output.every(isTextOutputItem))) return 'error'

  if (type === 'response.completed') {
    if (response?.status !== 'completed' || response.incomplete_details != null) return 'error'
    const unfinished = Array.isArray(response.output) && response.output.some(item =>
      item?.type === 'message' && item.status !== undefined && item.status !== 'completed')
    return unfinished ? 'error' : 'end_turn'
  }
  if (type === 'response.incomplete')
    return response?.status === 'incomplete' && response.incomplete_details?.reason === 'max_output_tokens'
      ? 'max_tokens' : 'error'
  return undefined
}

async function* readResponses(
  res: Response,
  signal: AbortSignal | undefined,
  { describeNetError, textOnly }: AdapterTransport
): AsyncGenerator<StreamEvent> {
  // output item id -> 累积中的函数调用
  const calls = new Map<string, PendingCall>()
  /** 参数 JSON 解析失败的调用，流结束后按截断与否定性（见 settleBrokenCalls）。 */
  const broken: { id: string; name: string; raw: string }[] = []
  // Without an authoritative terminal, EOF and the [DONE] sentinel are failures in text-only mode.
  let stopReason: StopReason = textOnly ? 'error' : 'end_turn'
  let sawTool = false
  let inputTokens = 0
  let outputTokens = 0
  let cacheRead = 0

  const takeUsage = (evt: Record<string, unknown>): void => {
    const usage = (
      evt.response as {
        usage?: {
          input_tokens?: number
          output_tokens?: number
          input_tokens_details?: { cached_tokens?: number }
        }
      }
    )?.usage
    if (usage?.input_tokens && (!textOnly || typeof usage.input_tokens === 'number'))
      inputTokens = usage.input_tokens
    if (usage?.output_tokens && (!textOnly || typeof usage.output_tokens === 'number'))
      outputTokens = usage.output_tokens
    // Responses API 的 input_tokens 已是含缓存命中的总量，cached_tokens 只是其中命中的那部分。
    const hit = usage?.input_tokens_details?.cached_tokens
    if (hit && (!textOnly || typeof hit === 'number')) cacheRead = hit
  }

  try {
    // The text-only host supplies its own deadline via the fetch signal.
    for await (const { data, event } of iterateSSE(res, textOnly ? 0 : STREAM_IDLE_MS)) {
      if (data === '[DONE]' || (textOnly && signal?.aborted)) break
      let evt: Record<string, unknown>
      try {
        evt = JSON.parse(data)
      } catch {
        if (textOnly) break
        continue
      }
      if (textOnly) {
        // A named SSE frame must agree with the payload. A different protocol's native events
        // cannot confirm completion, even on an HTTP 200 from the configured host.
        const kind = evt?.type
        if (typeof kind !== 'string' || (event !== undefined && event !== 'message' && event !== kind)) break
        if (kind === 'ping' && evt.error == null) continue
        if (!kind.startsWith('response.') && kind !== 'error') break
        const terminal = textOnlyTerminal(evt)
        if (terminal) {
          stopReason = terminal
          if (terminal !== 'error') takeUsage(evt)
          break // Cancel the SSE reader before emitting the terminal to the caller.
        }
      }
      const type = evt.type as string

      if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
        // 结构化拒绝文本（同 Chat Completions 的 delta.refusal）：作为正文展示，别丢。
        const delta = evt.delta
        if (textOnly && typeof delta !== 'string') break
        if (typeof delta === 'string' && delta) yield { type: 'text_delta', text: delta }
      } else if (textOnly) {
        // Ignore private reasoning and keep rich desktop tool handling entirely out of this path.
        continue
      } else if (
        type === 'response.reasoning_summary_text.delta' ||
        type === 'response.reasoning_text.delta'
      ) {
        // 推理模型的思维摘要（仅在服务端产出时到达）——作为思考展示，本应用不持久化。
        const delta = evt.delta
        if (typeof delta === 'string' && delta) yield { type: 'thinking_delta', text: delta }
      } else if (type === 'response.output_item.added') {
        const item = evt.item as { id?: string; type?: string; call_id?: string; name?: string }
        if (item?.type === 'function_call' && item.id)
          calls.set(item.id, { callId: item.call_id ?? '', name: item.name ?? '', args: '' })
      } else if (type === 'response.function_call_arguments.delta') {
        const c = calls.get(evt.item_id as string)
        if (c && typeof evt.delta === 'string') c.args += evt.delta
      } else if (type === 'response.output_item.done') {
        const item = evt.item as {
          id?: string
          type?: string
          call_id?: string
          name?: string
          arguments?: string
        }
        if (item?.type === 'function_call') {
          const acc = item.id ? calls.get(item.id) : undefined
          const callId = item.call_id ?? acc?.callId ?? ''
          const name = item.name ?? acc?.name ?? ''
          // done 事件里的 arguments 为权威全量；缺失时回落流式累积。
          const rawArgs = typeof item.arguments === 'string' ? item.arguments : (acc?.args ?? '')
          if (item.id) calls.delete(item.id)
          const parsed = parseToolArgs(rawArgs)
          // 解析不了先扣下：截断原因（response.incomplete）在其后才到，届时再定性。
          if (parsed === undefined) broken.push({ id: callId, name, raw: rawArgs })
          else {
            sawTool = true
            yield { type: 'tool_call', id: callId, name, args: parsed }
          }
        }
      } else if (type === 'response.completed') {
        takeUsage(evt)
      } else if (type === 'response.incomplete') {
        takeUsage(evt)
        const reason = (evt.response as { incomplete_details?: { reason?: string } })
          ?.incomplete_details?.reason
        if (reason === 'max_output_tokens') stopReason = 'max_tokens'
        else if (reason === 'content_filter') stopReason = 'refusal'
      } else if (type === 'response.failed') {
        takeUsage(evt)
        const err = (evt.response as { error?: { message?: string; code?: string } })?.error
        const message = err?.message ?? (isEn() ? 'Generation failed' : '生成失败')
        yield {
          type: 'error',
          error: inbandError(`${message} ${err?.code ?? ''}`, { kind: 'server', retryable: false, message })
        }
        yield { type: 'done', stopReason: 'error' }
        return
      } else if (type === 'error') {
        const message =
          typeof evt.message === 'string'
            ? evt.message
            : ((evt.error as { message?: string })?.message ?? (isEn() ? 'Stream error' : '流式错误'))
        yield { type: 'error', error: inbandError(message, { kind: 'server', retryable: false, message }) }
        yield { type: 'done', stopReason: 'error' }
        return
      }
    }
  } catch (e) {
    if ((e as Error)?.name === 'AbortError' || (textOnly && signal?.aborted)) {
      yield { type: 'done', stopReason: 'aborted' }
      return
    }
    if (!textOnly)
      yield { type: 'error', error: { kind: 'network', retryable: true, message: describeNetError(e) } }
    yield { type: 'done', stopReason: 'error' }
    return
  }

  if (textOnly && signal?.aborted) {
    yield { type: 'done', stopReason: 'aborted' }
    return
  }

  // 残缺的调用：截断时连 output_item.done 都没等到的也算上；非截断的坏 JSON 同样如实上报（见 settleBrokenCalls）。
  if (stopReason === 'max_tokens')
    for (const c of calls.values()) broken.push({ id: c.callId, name: c.name, raw: c.args })
  else if (broken.length) sawTool = true
  yield* settleBrokenCalls(broken, stopReason)

  // 有工具调用即按 tool_use 收尾——但不覆盖 max_tokens：截断须如实上报（带着工具调用时
  // 主循环本来就会继续，不靠这个 stopReason）。
  if (sawTool && stopReason !== 'max_tokens') stopReason = 'tool_use'

  if (inputTokens || outputTokens)
    yield { type: 'usage', input: inputTokens, output: outputTokens, cacheRead }
  yield { type: 'done', stopReason }
}
