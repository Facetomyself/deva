import { withQuote } from '../renderer/src/redesign/ConvMessage'
import { inputBytes, MAX_TEXT_INPUT } from './chat-transport'

export type QuoteDraft = Readonly<{ body: string; quote: string }>
const emptyDraft: QuoteDraft = Object.freeze({ body: '', quote: '' })

export const composedDraft = ({ body, quote }: QuoteDraft): string => withQuote(quote, body.trim())
export const exceedsDraftLimit = (draft: QuoteDraft): boolean => inputBytes(composedDraft(draft)) > MAX_TEXT_INPUT

/** The lifetime of this store is one authenticated workbench, not the document or module. */
export function createQuoteDrafts() {
  const drafts = new Map<string, QuoteDraft>()
  const listeners = new Set<() => void>()
  const changed = (): void => { for (const listener of listeners) listener() }
  const read = (sid: string): QuoteDraft => drafts.get(sid) ?? emptyDraft
  const write = (sid: string, draft: QuoteDraft): void => { drafts.set(sid, draft); changed() }
  return {
    read,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    setBody(sid: string, body: string): QuoteDraft {
      const current = read(sid)
      if (body === current.body) return current
      const next = { ...current, body }
      write(sid, next)
      return next
    },
    setQuote(sid: string, quote: string): void {
      const current = read(sid)
      if (quote || current.quote) write(sid, { ...current, quote })
    },
    commit(sid: string, sent: QuoteDraft): boolean {
      // Identity is the receipt generation. Editing and then restoring identical bytes still creates a new draft.
      if (read(sid) !== sent || !drafts.delete(sid)) return false
      changed()
      return true
    }
  }
}
