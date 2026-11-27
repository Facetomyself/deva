export type TextAttachment = { name: string; text: string }
export const MAX_TEXT_ATTACHMENT_BYTES = 32 * 1024
const encoder = new TextEncoder()
// Never interpret a displayed filename as a URL or an OS path. Reject invisible direction controls in names.
const badName = /[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069\uD800-\uDFFF]/u
const badText = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\uD800-\uDFFF]/u

export function isTextAttachmentName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && value === value.trim() && !value.startsWith('.') &&
    !badName.test(value) && /\.(?:txt|md)$/iu.test(value) && encoder.encode(value).byteLength <= 128
}

export function textAttachmentProblem(value: unknown): 'shape' | 'name' | 'empty' | 'size' | 'content' | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 ||
      !Object.hasOwn(value, 'name') || !Object.hasOwn(value, 'text')) return 'shape'
  const { name, text } = value as Partial<TextAttachment>
  if (!isTextAttachmentName(name)) return 'name'
  if (typeof text !== 'string') return 'content'
  if (!text.length) return 'empty'
  if (text.length > MAX_TEXT_ATTACHMENT_BYTES || encoder.encode(text).byteLength > MAX_TEXT_ATTACHMENT_BYTES) return 'size'
  return badText.test(text) ? 'content' : null
}
