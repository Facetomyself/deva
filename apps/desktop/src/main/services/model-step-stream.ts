import type { NormalizedError, StopReason, StreamEvent } from '../providers/types'
import { watchRepetition } from './repetition'

type EventOf<T extends StreamEvent['type']> = Extract<StreamEvent, { type: T }>
type ToolCall = EventOf<'tool_call'>
type TruncatedToolCall = EventOf<'tool_call_truncated'>
type Usage = EventOf<'usage'>

type OutputOffsets = { text: number; thinking: number }

export interface ModelStepStreamOptions {
  /** 也传给 provider，由它中止请求并结束迭代。 */
  signal?: AbortSignal
  onTextDelta?: (text: string) => void
  onThinkingDelta?: (text: string) => void
  onUsage?: (event: Usage) => void
  onError?: (error: NormalizedError) => void
  /** 只分发请求；省略回调或返回 'reject' 时提前关闭迭代器。 */
  onToolCall?: (event: ToolCall, offsets: OutputOffsets) => 'reject' | void
  onTruncatedToolCall?: (event: TruncatedToolCall, offsets: OutputOffsets) => 'reject' | void
}

export interface ModelStepStreamResult {
  assistantText: string
  thinkingText: string
  /** provider 的终止原因；没有 done 事件时沿用桌面的缺省值 end_turn。 */
  stopReason: StopReason
  usage: Usage | null
  error: NormalizedError | null
  aborted: boolean
  repetition: { channel: 'text' | 'thinking'; period: number } | null
  rejectedToolCall: ToolCall | TruncatedToolCall | null
}

/**
 * 消费一次 provider 请求。增量和协议事件按原顺序同步分发；usage/error 保留最后一条，同时逐条回调。
 * 中止、复读及工具拒绝独立于 stopReason。复读在分发触发的增量后停下；复读和工具拒绝均关闭迭代器。
 * provider 的协议错误由结果报告，迭代器或回调抛出的异常原样向外传播。重试、截断、工具执行由宿主决定。
 */
export async function consumeModelStep(
  events: AsyncIterable<StreamEvent>,
  options: ModelStepStreamOptions = {}
): Promise<ModelStepStreamResult> {
  const { signal, onTextDelta, onThinkingDelta, onUsage, onError, onToolCall, onTruncatedToolCall } = options
  const watchText = watchRepetition()
  const watchThinking = watchRepetition()
  let assistantText = ''
  let thinkingText = ''
  let stopReason: StopReason = 'end_turn'
  let usage: Usage | null = null
  let error: NormalizedError | null = null
  let repetition: ModelStepStreamResult['repetition'] = null
  let rejectedToolCall: ModelStepStreamResult['rejectedToolCall'] = null
  const offsets = (): OutputOffsets => ({ text: assistantText.length, thinking: thinkingText.length })

  consume: for await (const ev of events) {
    switch (ev.type) {
      case 'text_delta': {
        assistantText += ev.text
        onTextDelta?.(ev.text)
        const hit = watchText(ev.text)
        if (hit) {
          repetition = { channel: 'text', period: hit.period }
          break consume
        }
        break
      }
      case 'thinking_delta': {
        thinkingText += ev.text
        onThinkingDelta?.(ev.text)
        const hit = watchThinking(ev.text)
        if (hit) {
          repetition = { channel: 'thinking', period: hit.period }
          break consume
        }
        break
      }
      case 'tool_call':
        if (!onToolCall || onToolCall(ev, offsets()) === 'reject') {
          rejectedToolCall = ev
          break consume
        }
        break
      case 'tool_call_truncated':
        if (!onTruncatedToolCall || onTruncatedToolCall(ev, offsets()) === 'reject') {
          rejectedToolCall = ev
          break consume
        }
        break
      case 'usage':
        usage = ev
        onUsage?.(ev)
        break
      case 'error':
        error = ev.error
        onError?.(ev.error)
        break
      case 'done':
        stopReason = ev.stopReason
        break
    }
  }

  return {
    assistantText, thinkingText, stopReason, usage, error, repetition, rejectedToolCall,
    aborted: signal?.aborted === true || stopReason === 'aborted'
  }
}
