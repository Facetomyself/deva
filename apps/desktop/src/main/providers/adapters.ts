import { streamAnthropic } from './anthropic'
import { streamOpenAI } from './openai'
import { streamResponses } from './openai-responses'

// Both hosts select the same wire adapters; the registry owns no network or credentials.
export const modelAdapters = { openai: streamOpenAI, responses: streamResponses, anthropic: streamAnthropic } as const
export type AdapterKind = keyof typeof modelAdapters
export const isAdapterKind = (id: string): id is AdapterKind => Object.hasOwn(modelAdapters, id)
