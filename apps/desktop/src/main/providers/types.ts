/**
 * Provider 归一化类型（主进程内部）。
 * Agent 引擎只面向这套接口与 StreamEvent 编程，各家模型以适配器接入。
 * 对应 docs/architecture/providers.md §3。跨 IPC 的「线缆类型」另在 preload 声明（结构一致）。
 */

/** 归一化消息内容块（Anthropic 风味：工具结果放在 user 消息里）。 */
export interface TextPart {
  type: 'text'
  text: string
  /**
   * 引擎附带的清单块（技能清单 / 记忆条目，见 services/listing.ts）：记下本块告知了哪些条目，供从历史推算
   * 「已告知的状态」。只在主进程内部使用，适配器只发 text，不会发给模型。
   */
  listing?: ListingRecord
  /**
   * 气泡里显示的原话（只用于提问正文块）：text 被引擎改写过时才有——如「/技能名」把技能全文展开进 text，
   * 这里留用户实际打的字。只在主进程内部使用，适配器只发 text，不会发给模型。
   */
  display?: string
}
/**
 * 随消息下发的清单种类。guide：按需加载工具的完整用法（tool_search 等给出，见 tool-search.ts）；
 * members：本对话的项目成员名单（见 listing.ts memberListingPart）。
 */
export type ListingKind = 'skills' | 'memory' | 'guide' | 'members'
/** 清单块的结构化记录：本块告知（新增或更新）的条目及其内容摘要、本块告知移除的条目。 */
export interface ListingRecord {
  kind: ListingKind
  /** key：技能名 / 记忆 id / 工具名。 */
  listed: { key: string; digest: string }[]
  removed?: string[]
}
export interface ToolUsePart {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
  /**
   * 模型随这次调用给出的思考签名（目前只有 Gemini，见 providers/openai.ts）：回放历史时须原样带回，
   * 缺了该模型会以 400 拒收。别家模型没有此项。
   */
  signature?: string
}
export interface ToolResultPart {
  type: 'tool_result'
  toolUseId: string
  content: string
  isError?: boolean
  /**
   * 工具返回的图片（read_file 读图、MCP 图片块）。与 content 分列而非把 content 改成块数组：
   * 历史重建 / 压缩摘要 / 边车等处都把 content 当字符串读，分列后它们原样可用，只有适配器与
   * token 估算需要认识这个字段。content 里应留一句文字说明（图片是什么、从哪来）。
   */
  images?: ImagePart[]
  /** 本次调用的结果已把清单变化告诉了模型（memory_write / memory_delete）：同 TextPart.listing 计入折叠，不发给模型。 */
  listing?: ListingRecord
}
/** 图片附件（base64）。Anthropic → image 块；OpenAI → image_url(data URI)。 */
export interface ImagePart {
  type: 'image'
  /** MIME，如 image/png、image/jpeg */
  mediaType: string
  /** base64（不含 data: 前缀） */
  data: string
  /** 原始文件名（仅用于展示/重建气泡，不发给模型） */
  name?: string
}
/** 文档附件（base64），当前用于 PDF。仅 Anthropic 可原生读取（document 块）。 */
export interface DocumentPart {
  type: 'document'
  /** MIME，如 application/pdf */
  mediaType: string
  /** base64（不含 data: 前缀） */
  data: string
  name?: string
}
export type ContentPart =
  | TextPart
  | ToolUsePart
  | ToolResultPart
  | ImagePart
  | DocumentPart

export interface Message {
  role: 'user' | 'assistant'
  content: string | ContentPart[]
}

/** 归一化工具声明（JSON Schema 为准）。 */
export interface ToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export type { StopReason } from '../../shared/chat-protocol'

// 思考等级的档位定义与模型能力表在主进程 / 渲染层共用模块里（见 shared/effort.ts）。
export { isEffortLevel, type EffortLevel } from '../../shared/effort'
import type { StopReason } from '../../shared/chat-protocol'
import type { EffortRequest } from '../../shared/effort'
import type { ContextOverflow } from '../../shared/context'
import { isEn } from '../locale'
import { httpError as localizedHttpError, inbandError as localizedInbandError } from './protocol'

export interface GenerateRequest {
  model: string
  system?: string
  messages: Message[]
  tools?: ToolSpec[]
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
  /**
   * 是否给本次请求打**提示缓存断点**。目前只有 Anthropic 协议支持显式断点；
   * OpenAI / DeepSeek 是服务端自动前缀缓存，无需请求参数，此开关对其无作用也无副作用。
   * **只有「带着同一前缀反复重发」的场景才该开**：Agent 循环每步都重发全量历史，正是典型；
   * 一次性调用（压缩摘要、生成提交信息）打了断点只会白付 1.25 倍缓存写入费，故默认关闭。
   */
  cache?: boolean
  /**
   * 所属对话 id（供需要「每对话一个稳定会话 id」的网关使用，如 OpenCode Go 的
   * x-opencode-session，缺失即 400 MissingSessionID）。不经对话的一次性调用留空，由
   * providers/opencode.ts 退回本次运行 id。
   */
  sessionId?: string
  /**
   * 思考参数（已按模型能力表收敛、映射好，见 shared/effort.ts 的 effortRequest）。
   * 缺省 = 不发任何思考 / 推理参数，请求体与改造前逐字节一致。适配器按 format 放进各家字段：
   * standard → Anthropic adaptive thinking + output_config.effort / OpenAI Chat reasoning_effort /
   * Responses reasoning.effort；deepseek / zai / qwen（仅 OpenAI Chat）→ 各家私有开关 + 可选 reasoning_effort；
   * compat（仅 Anthropic，国产兼容端点）→ output_config.effort + 必要时 thinking.type。
   */
  effort?: EffortRequest
}

export type ErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'context_length'
  | 'network'
  | 'invalid_request'
  /** max_tokens 超出模型允许的输出上限：引擎会自动降档重发。 */
  | 'output_limit'
  /** 模型 / 网关不认所发的思考等级参数：引擎会记住并去掉该参数重发。 */
  | 'effort_unsupported'
  | 'server'
  | 'aborted'
  | 'unknown'

export interface NormalizedError {
  kind: ErrorKind
  retryable: boolean
  message: string
  /** 服务端建议的重试等待（毫秒，来自 retry-after 头）；缺省由调用方按指数退避自定。 */
  retryAfterMs?: number
  /** 上下文超限报错里写明的真实窗口（token，见 shared/context.ts 的 parseContextLimit）；认不出则缺省。 */
  limit?: number
  /** 「输入 + 输出预留超出窗口」报错里的三个数（见 parseContextOverflow）；引擎据此判断是不是输出预留太大。 */
  overflow?: ContextOverflow
}

/**
 * 工具参数没能完整解析的原因。max_tokens = 写到一半撞上输出上限；refusal = 被服务端内容策略截断；
 * invalid = 流正常结束参数却不是合法 JSON——多见于超长参数（个别中转截断了却不报 length，或模型在
 * 长内容里写坏了转义）。
 */
export type BrokenCallCause = 'max_tokens' | 'refusal' | 'invalid'

/** 统一流式事件——Agent 引擎只消费这套。 */
export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown; /** 思考签名，见 ToolUsePart.signature。 */ signature?: string }
  /**
   * 参数没能完整解析的工具调用：参数原文残缺、不可执行，cause 说明原因（见 BrokenCallCause）。
   * 循环把它记成一次失败的工具调用，按原因回灌纠正提示（见 agent-loop.ts runAgentLoop）。
   */
  | {
      type: 'tool_call_truncated'
      id: string
      name: string
      partialArgs: string
      cause: BrokenCallCause
    }
  /**
   * 用量。input = 本次请求的**总提示 token**（已含缓存命中/写入部分）。
   * 注意 Anthropic 协议的 input_tokens 只是「未命中缓存的余量」，适配器已在此把三段相加归一，
   * 保证跨服务商语义一致——上下文压缩的触发判定依赖它，不会因日后开启提示缓存而失真。
   * cacheRead / cacheWrite = 提示缓存的命中 / 写入 token 数；缺省表示该服务商未报告该项。
   */
  | { type: 'usage'; input: number; output: number; cacheRead?: number; cacheWrite?: number }
  | { type: 'error'; error: NormalizedError }
  | { type: 'done'; stopReason: StopReason }

/** 单个适配器的连接配置（密钥已解密，仅在主进程内传递）。 */
export interface AdapterConfig {
  baseURL: string
  apiKey: string
  /**
   * 追加的请求头：自有 UA、服务商专有头、用户填的自定义请求头（由 providers/core.ts 现算，见
   * providers/opencode.ts 的 providerHeaders）。适配器原样并进 fetch headers 末尾，无须知道其来源。
   */
  headers?: Record<string, string>
}

// 保留桌面内部原入口（如决策模型），纯适配器直接使用 protocol.ts 并显式传语言。
export { isOutputLimitRejection, parseToolArgs, settleBrokenCalls, toolImagesNote } from './protocol'

export function httpError(
  status: number,
  body: string,
  retryAfter?: string | null,
  effortSent?: boolean
): NormalizedError {
  return localizedHttpError(isEn(), status, body, retryAfter, effortSent)
}

export function inbandError(text: string, fallback: NormalizedError): NormalizedError {
  return localizedInbandError(isEn, text, fallback)
}
