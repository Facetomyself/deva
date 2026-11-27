import type { ContentPart, Message } from '../main/providers/types'
import { estimateTextTokens } from './context'

// Media estimates count model-visible parts, not their wire encoding.
const IMAGE_TOKENS = 1600
const DOC_TOKENS = 3000

function partTokens(p: ContentPart): number {
  switch (p.type) {
    case 'text':
      return estimateTextTokens(p.text)
    case 'tool_use':
      return estimateTextTokens(JSON.stringify(p.input ?? {})) + 8
    case 'tool_result':
      return estimateTextTokens(p.content) + 8 + (p.images?.length ?? 0) * IMAGE_TOKENS
    case 'image':
      return IMAGE_TOKENS
    case 'document':
      return DOC_TOKENS
    default:
      return 0
  }
}

export function messageTokens(m: Message): number {
  if (typeof m.content === 'string') return estimateTextTokens(m.content) + 4
  let t = 4
  for (const p of m.content) t += partTokens(p)
  return t
}

/** Character-based fallback for a model-visible message sequence. */
export function estimateTokens(messages: Message[]): number {
  let t = 0
  for (const m of messages) t += messageTokens(m)
  return Math.round(t)
}
