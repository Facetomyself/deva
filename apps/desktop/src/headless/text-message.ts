import { ATTACHMENTS_ONLY_QUESTION, ATTACH_TEXT_PREFIX, formatTextAttachment } from '../shared/text-attachment'
import { textAttachmentProblem, type TextAttachment } from './text-file'

export const INPUT = 8 * 1024, OUTPUT = 64 * 1024
export type Role = 'user' | 'assistant'
type Part = { type: 'text'; text: string; display?: '' }
export type TextMessage = { role: Role; content: [Part] | [Part, Part] }
export type MessageView = { role: Role; text: string; attachment?: TextAttachment }
const block = (text: string): Part => ({ type: 'text', text })
export const message = (role: Role, text: string): TextMessage => ({ role, content: [block(text)] })
export function userMessage(text: string, file?: TextAttachment): TextMessage {
  if (!file) return message('user', text)
  // The native display override distinguishes a generated question from the user typing that exact sentence.
  const question: Part = text ? block(text) : { ...block(ATTACHMENTS_ONLY_QUESTION), display: '' }
  return { role: 'user', content: [block(formatTextAttachment(file.name, file.text)), question] }
}
export const messageBytes = (m: TextMessage): number => m.content.reduce((n, p) => n + Buffer.byteLength(p.text), 0)

function decodedFile(framed: string): TextAttachment | null {
  const separator = '\n```\n', end = '\n```'
  const line = framed.indexOf('\n')
  if (!framed.startsWith(ATTACH_TEXT_PREFIX) || line < ATTACH_TEXT_PREFIX.length ||
      !framed.startsWith(separator, line) || !framed.endsWith(end)) return null
  // Only strip the outer native frame; fences, BOM, CRLF and trailing newlines inside the file are literal data.
  const file = { name: framed.slice(ATTACH_TEXT_PREFIX.length, line), text: framed.slice(line + separator.length, -end.length) }
  return textAttachmentProblem(file) === null ? file : null
}
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Accept old one-block messages unchanged. Only the explicit two-block user layout denotes a file. */
export function projectMessage(m: unknown): MessageView | null {
  if (!record(m) || Object.keys(m).length !== 2 || (m.role !== 'user' && m.role !== 'assistant') ||
      !Array.isArray(m.content) || (m.content.length !== 1 && !(m.role === 'user' && m.content.length === 2))) return null
  const q: unknown = m.content.at(-1)
  if (!record(q) || q.type !== 'text' || typeof q.text !== 'string' || !q.text ||
      Buffer.byteLength(q.text) > (m.role === 'user' ? INPUT : OUTPUT) || (m.role === 'user' && q.text !== q.text.trim())) return null
  const generated = Object.hasOwn(q, 'display')
  if (Object.keys(q).length !== (generated ? 3 : 2) || (generated &&
      (m.content.length !== 2 || q.display !== '' || q.text !== ATTACHMENTS_ONLY_QUESTION))) return null
  const shown: MessageView = { role: m.role, text: generated ? '' : q.text }
  if (m.content.length === 1) return shown
  const p: unknown = m.content[0]
  if (!record(p) || Object.keys(p).length !== 2 || p.type !== 'text' || typeof p.text !== 'string') return null
  const attachment = decodedFile(p.text)
  return attachment ? { ...shown, attachment } : null
}
