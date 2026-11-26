import { Buffer } from 'node:buffer'
import { types } from 'node:util'
import type { AdapterKind } from '../providers/runtime'
import type { DocumentPart, ImagePart, TextPart } from '../providers/types'
import { AVATAR_MAX_BYTES, avatarImageMime } from './avatar-image-core'

/** Shared on-disk marker and model question; the desktop entry re-exports both. */
export const ATTACH_TEXT_PREFIX = '[附件文件] '
export const ATTACHMENTS_ONLY_QUESTION = '请理解并处理上述附件。'

export const IMAGE_MIME: Readonly<Record<string, string>> = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
})

const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.csv', '.tsv', '.log',
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.svelte',
  '.html', '.htm', '.css', '.scss', '.less', '.xml', '.svg',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.c', '.h', '.cpp', '.hpp', '.cc', '.cs', '.php',
  '.swift', '.m', '.mm', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.sql', '.gradle', '.properties',
  '.env', '.r', '.dart', '.lua', '.pl', '.dockerfile', '.makefile', '.cmake'
])

export const MAX_IMAGE = 5 * 1024 * 1024
export const MAX_PDF = 20 * 1024 * 1024
export const MAX_TEXT = 512 * 1024

export type UploadedAttachmentKind = 'image' | 'document' | 'text'

/** Desktop content candidates. Its authorization, size handling and path fallback stay with Electron. */
export function classifyAttachmentExtension(ext: string): UploadedAttachmentKind | 'unsupported' {
  const e = ext.toLowerCase()
  if (Object.hasOwn(IMAGE_MIME, e)) return 'image'
  if (e === '.pdf') return 'document'
  if (TEXT_EXT.has(e)) return 'text'
  return 'unsupported'
}

export function textAttachmentPart(name: string, body: string): TextPart {
  return { type: 'text', text: `${ATTACH_TEXT_PREFIX}${name}\n\`\`\`\n${body}\n\`\`\`` }
}

export function imageAttachmentPart(name: string, mediaType: string, bytes: Buffer): ImagePart {
  return { type: 'image', mediaType, data: bytes.toString('base64'), name }
}

export function pdfAttachmentPart(name: string, bytes: Buffer): DocumentPart {
  return { type: 'document', mediaType: 'application/pdf', data: bytes.toString('base64'), name }
}

/** Pass only these fields from an upload already authorized by the caller. `name` is a leaf label. */
export interface UploadedAttachmentMeta {
  name: string
  mime: string
  size: number
}

/** Persist this separately from model parts; it is also the complete public snapshot shape. */
export interface UploadedAttachmentDisplay extends UploadedAttachmentMeta {
  kind: UploadedAttachmentKind
}

export interface BuiltUploadedAttachment {
  part: TextPart | ImagePart | DocumentPart
  display: UploadedAttachmentDisplay
}

const errors = {
  invalid_attachment_metadata: 'Expected attachment name, MIME and size fields only.',
  invalid_attachment_name: 'Expected a safe attachment filename without a path or URL.',
  unsupported_attachment_type: 'This attachment format is unavailable for uploads.',
  invalid_attachment_mime: 'Attachment MIME must match its file extension and format.',
  invalid_attachment_size: 'Expected a positive integer attachment byte count.',
  attachment_too_large: 'Attachment exceeds the byte limit for its format or adapter.',
  attachment_adapter_unsupported: 'This attachment requires a compatible adapter; PDF requires Anthropic or OpenAI Responses (rather than Chat Completions).',
  invalid_attachment_bytes: 'Expected attachment bytes as a Uint8Array.',
  attachment_size_mismatch: 'Attachment bytes differ from the declared size.',
  attachment_content_mismatch: 'Attachment bytes differ from the declared format.',
  invalid_attachment_text: 'Expected ordinary UTF-8 text.',
  invalid_attachment_display: 'Invalid attachment snapshot metadata.'
} as const

export class UploadedAttachmentError extends Error {
  constructor(readonly code: keyof typeof errors) {
    super(errors[code])
    this.name = 'UploadedAttachmentError'
  }
}

// Browser uploads have a stricter content-only policy. GIF, standalone HTML/SVG and these
// executable-file extensions are desktop-only; Office/ZIP have no upload path fallback.
const UPLOAD_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp'])
const DESKTOP_ONLY_TEXT = new Set(['.html', '.htm', '.svg', '.bat', '.ps1'])
// Match the upload service's static-raster byte/dimension/animation policy. The 5 MiB desktop
// picker threshold remains independent, while 2 MiB also fits the provider base64 budget.
const maxBytesByKind = { image: Math.min(MAX_IMAGE, AVATAR_MAX_BYTES), document: MAX_PDF, text: MAX_TEXT } as const
const META_FIELDS = ['name', 'mime', 'size'] as const
const DISPLAY_FIELDS = [...META_FIELDS, 'kind'] as const
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** Read only own data fields: no paths, URLs, tokens, accessors, or implicit coercions. */
function exactFields<K extends string>(value: unknown, keys: readonly K[]): Record<K, unknown> | undefined {
  if (value === null || typeof value !== 'object' ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== keys.length) return
  const result = Object.create(null) as Record<K, unknown>
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key)
    if (!field?.enumerable || !Object.hasOwn(field, 'value')) return
    result[key] = field.value
  }
  return result
}

function isAttachmentName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && name.length <= 255 && name.isWellFormed() &&
    Buffer.byteLength(name) <= 255 && name.trim() === name && name.normalize('NFC') === name &&
    !name.startsWith('.') && !name.endsWith('.') && !/[<>:"/\\|?*%#&\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name) &&
    !/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\s*\.|$)/iu.test(name)
}

function uploadKind(name: string): { kind: UploadedAttachmentKind; ext: string } | undefined {
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : ''
  const kind = classifyAttachmentExtension(ext)
  if (kind === 'unsupported' || (kind === 'image' && !UPLOAD_IMAGE_MIME.has(IMAGE_MIME[ext])) ||
      (kind === 'text' && DESKTOP_ONLY_TEXT.has(ext))) return
  return { kind, ext }
}

function mimeMatches(kind: UploadedAttachmentKind, ext: string, mime: unknown): mime is string {
  if (kind === 'image') return mime === IMAGE_MIME[ext]
  if (kind === 'document') return mime === 'application/pdf'
  return mime === 'text/plain'
}

/** Server kind by name/MIME only; size and adapter are checked by isSupported. */
export function assetKind(meta: UploadedAttachmentMeta): UploadedAttachmentKind | 'unsupported' {
  const fields = exactFields(meta, META_FIELDS)
  if (!fields || !isAttachmentName(fields.name)) return 'unsupported'
  const classified = uploadKind(fields.name)
  return classified && mimeMatches(classified.kind, classified.ext, fields.mime) ? classified.kind : 'unsupported'
}

/** Protocol capability, not a promise about the selected model's vision features. */
export function supportsAttachmentAdapter(kind: UploadedAttachmentKind, adapter: AdapterKind): boolean {
  return (adapter === 'anthropic' || adapter === 'responses' || adapter === 'openai') &&
    (kind === 'text' || kind === 'image' || (kind === 'document' && adapter !== 'openai'))
}

/** Raw upload byte cap; zero means the format is unavailable for this adapter. */
export function maxUploadedAttachmentBytes(kind: UploadedAttachmentKind, adapter?: AdapterKind): number {
  if (!Object.hasOwn(maxBytesByKind, kind) || (adapter !== undefined && !supportsAttachmentAdapter(kind, adapter))) return 0
  return maxBytesByKind[kind]
}

function checkedMeta(fields: Record<(typeof META_FIELDS)[number], unknown>, adapter?: AdapterKind): UploadedAttachmentDisplay {
  const { name, mime, size } = fields
  if (!isAttachmentName(name)) throw new UploadedAttachmentError('invalid_attachment_name')
  const classified = uploadKind(name)
  if (!classified) throw new UploadedAttachmentError('unsupported_attachment_type')
  const { kind, ext } = classified
  if (!mimeMatches(kind, ext, mime)) throw new UploadedAttachmentError('invalid_attachment_mime')
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) throw new UploadedAttachmentError('invalid_attachment_size')
  if (adapter !== undefined && !supportsAttachmentAdapter(kind, adapter)) throw new UploadedAttachmentError('attachment_adapter_unsupported')
  if (size > maxUploadedAttachmentBytes(kind, adapter)) throw new UploadedAttachmentError('attachment_too_large')
  return { name, kind, mime, size }
}

/** Preflight only. buildUploadedPart additionally validates the bytes and requires an adapter. */
export function isSupported(meta: UploadedAttachmentMeta, adapter?: AdapterKind): boolean {
  const fields = exactFields(meta, META_FIELDS)
  if (!fields) return false
  try {
    checkedMeta(fields, adapter)
    return true
  } catch (err) {
    if (err instanceof UploadedAttachmentError) return false
    throw err
  }
}

/** Check and copy persisted display metadata before using it in a public snapshot. */
export function uploadedAttachmentSnapshot(value: unknown): UploadedAttachmentDisplay {
  const fields = exactFields(value, DISPLAY_FIELDS)
  if (!fields) throw new UploadedAttachmentError('invalid_attachment_display')
  const display = checkedMeta(fields)
  if (fields.kind !== display.kind) throw new UploadedAttachmentError('invalid_attachment_display')
  return display
}

const pdfHeader = (bytes: Buffer): boolean => /^%PDF-(?:1\.[0-7]|2\.0)[\r\n]/.test(bytes.toString('latin1', 0, 9))

function buildContent(display: UploadedAttachmentDisplay, bytes: Buffer): BuiltUploadedAttachment['part'] {
  const { name, mime, kind } = display
  if (kind === 'image') {
    if (avatarImageMime(bytes) !== mime) throw new UploadedAttachmentError('attachment_content_mismatch')
    return imageAttachmentPart(name, mime, bytes)
  }
  if (kind === 'document') {
    // Match stage's signature check; PDF commands and image pixel data are never interpreted here.
    if (!pdfHeader(bytes)) throw new UploadedAttachmentError('attachment_content_mismatch')
    return pdfAttachmentPart(name, bytes)
  }
  let body: string
  try {
    body = utf8.decode(bytes)
  } catch {
    throw new UploadedAttachmentError('invalid_attachment_text')
  }
  if (/^\uFEFF?%PDF-/.test(body)) throw new UploadedAttachmentError('attachment_content_mismatch')
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(body)) throw new UploadedAttachmentError('invalid_attachment_text')
  return textAttachmentPart(name, body)
}

/** Authorized bytes -> provider parts. Throws before any model call; never builds a path/reference part. */
export function buildUploadedPart(meta: UploadedAttachmentMeta, bytes: Uint8Array, adapter: AdapterKind): BuiltUploadedAttachment {
  const fields = exactFields(meta, META_FIELDS)
  if (!fields) throw new UploadedAttachmentError('invalid_attachment_metadata')
  if (adapter === undefined) throw new UploadedAttachmentError('attachment_adapter_unsupported')
  const display = checkedMeta(fields, adapter)
  if (!types.isUint8Array(bytes)) throw new UploadedAttachmentError('invalid_attachment_bytes')
  // Use the native TypedArray getter, including for subclasses with an own byteLength.
  if (Reflect.get(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength', bytes) !== display.size)
    throw new UploadedAttachmentError('attachment_size_mismatch')
  // Copy only this view, never the caller's entire backing buffer. Base64 is produced by the
  // shared byte constructors, so padded canonical base64 (rather than user input) reaches providers.
  const source = Buffer.copyBytesFrom(bytes)
  if (source.length !== display.size) throw new UploadedAttachmentError('attachment_size_mismatch')
  return { part: buildContent(display, source), display }
}
