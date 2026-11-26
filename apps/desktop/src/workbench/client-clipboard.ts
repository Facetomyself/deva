// Client OS clipboard only. Neither a host bridge nor a transport is accepted here.
const maxBytes = 256 * 1024
const encoder = new TextEncoder()
const bounded = (s: string): boolean => s.length <= maxBytes && encoder.encode(s).byteLength <= maxBytes

export type ClientClipboardIssue = 'unsupported' | 'denied' | 'too-large' | 'unconfirmed'
export class ClientClipboardError extends Error {
  constructor(readonly issue: ClientClipboardIssue) { super(`client_clipboard_${issue}`) }
}

type ClipboardPage = {
  isSecureContext?: boolean
  document: { hasFocus?: () => boolean }
  navigator: { userActivation?: { isActive: boolean }; clipboard?: { writeText: (text: string) => Promise<void> } }
}

/** Call directly from a Copy click/keyboard activation, before an await. Only a confirmed
 * native write is success. There is no hidden input, clipboard polling or server fallback. */
export async function writeClientText(text: string, page: ClipboardPage = window): Promise<void> {
  if (typeof text !== 'string') throw new ClientClipboardError('unconfirmed')
  if (!bounded(text)) throw new ClientClipboardError('too-large')
  try {
    if (page.isSecureContext !== true) throw new ClientClipboardError('unsupported')
    if (page.document.hasFocus?.() === false || page.navigator.userActivation?.isActive === false) throw new ClientClipboardError('denied')
    const clipboard = page.navigator.clipboard
    if (typeof clipboard?.writeText !== 'function') throw new ClientClipboardError('unsupported')
    const receipt = clipboard.writeText(text)
    if (!receipt || typeof receipt.then !== 'function') throw new ClientClipboardError('unconfirmed')
    await receipt
  } catch (error) {
    if (error instanceof ClientClipboardError) throw error
    const name = error && typeof error === 'object' && 'name' in error ? error.name : ''
    throw new ClientClipboardError(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'unconfirmed')
  }
}

export type ClientPasteState = 'pasted' | 'unavailable' | 'not-text' | 'too-large'
type Action = { isTrusted: boolean; defaultPrevented: boolean; preventDefault(): void; clipboardData: Pick<DataTransfer,'types'|'getData'> | null }

/** Synchronous, user-initiated Paste only. The editor routes files separately first. Never
 * read navigator.clipboard, rich HTML, a URI list, another control, or a server path. All
 * non-plain cases are consumed so that a lower-priority rich/URL handler cannot reinterpret them. */
export function pasteClientText(event: Action, insert: (text: string) => boolean, report: (state: ClientPasteState) => void): boolean {
  if (event.defaultPrevented) return true
  event.preventDefault()
  if (!event.isTrusted) return true
  let status: ClientPasteState = 'unavailable'
  try {
    const data = event.clipboardData
    if (data) {
      const types = Array.from(data.types)
      if (types.includes('Files') || !types.includes('text/plain')) status = 'not-text'
      else {
        const value = data.getData('text/plain')
        if (typeof value === 'string' && value.length) {
          if (!bounded(value)) status = 'too-large'
          else if (insert(value.replace(/\r\n?/g, '\n'))) status = 'pasted'
        } else status = 'not-text'
      }
    }
  } catch { /* Redact native clipboard/DOM diagnostics; data stays in this browser. */ }
  report(status)
  return true
}
