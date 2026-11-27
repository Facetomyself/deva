import { isTextAttachmentName, MAX_TEXT_ATTACHMENT_BYTES, textAttachmentProblem, type TextAttachment } from '../text-file'

export type AttachmentIssue = NonNullable<ReturnType<typeof textAttachmentProblem>> | 'utf8' | 'read'

/** This consumes only the already-selected browser File. No server or resource request is involved. */
export async function readTextAttachment(file: File): Promise<TextAttachment | AttachmentIssue> {
  const { name, size } = file
  if (!isTextAttachmentName(name)) return 'name'
  if (size < 1) return 'empty'
  if (size > MAX_TEXT_ATTACHMENT_BYTES) return 'size'
  let bytes: ArrayBuffer
  try { bytes = await file.arrayBuffer() }
  catch { return 'read' }
  if (bytes.byteLength !== size) return 'read'
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  catch { return 'utf8' }
  const attachment = { name, text }
  return textAttachmentProblem(attachment) ?? attachment
}
