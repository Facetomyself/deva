import { assetKind, isSupported, maxUploadedAttachmentBytes } from '../../dist/chat-core.mjs'
import { avatarImageMime } from '../../dist/library-core.mjs'

const kindsByMime = Object.freeze({
  'text/plain': 'text', 'image/png': 'image', 'image/jpeg': 'image', 'image/webp': 'image', 'application/pdf': 'document',
})
export const UPLOAD_MIME_LIMITS = Object.freeze(Object.fromEntries(
  Object.entries(kindsByMime).map(([mime, kind]) => [mime, maxUploadedAttachmentBytes(kind)]),
))
const allowedFields = new Set(['name', 'mime', 'size'])

const uploadIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const unsafeName = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}<>:"/\\|?*%#&]/u
const deviceName = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\s*\.|$)/iu
const nonText = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u
const pdfMagic = /^%PDF-(?:1\.[0-7]|2\.0)[\r\n]/u

export class UploadStoreError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.name = 'UploadStoreError'
    this.code = `UPLOAD_${code}`
  }
}

export function validUploadId(id) {
  return typeof id === 'string' && id.length === 36 && uploadIdPattern.test(id)
}

export function validUploadSession(sid) {
  return typeof sid === 'string' && sid.length > 0 && sid.length <= 256 && sid.isWellFormed() &&
    !/[\p{Cc}\p{Cf}]/u.test(sid) && Buffer.byteLength(sid) <= 256
}

export function normalizeUploadType(value) {
  if (typeof value !== 'string' || value.length > 64 || /[^\x20-\x7e]/u.test(value)) {
    throw new UploadStoreError('UNSUPPORTED', 'Unsupported upload MIME type')
  }
  const type = value.trim().toLowerCase()
  const mime = /^text\/plain *; *charset *= *(?:utf-8|"utf-8")$/u.test(type) ? 'text/plain' : type
  if (!Object.hasOwn(UPLOAD_MIME_LIMITS, mime)) {
    throw new UploadStoreError('UNSUPPORTED', 'Unsupported upload MIME type')
  }
  return { mime, kind: kindsByMime[mime], maxBytes: UPLOAD_MIME_LIMITS[mime] }
}

export function normalizeUploadName(value, mime) {
  if (typeof value !== 'string' || value.length > 1024 || unsafeName.test(value)) {
    throw new UploadStoreError('INVALID', 'Invalid upload filename')
  }
  const name = value.normalize('NFC')
  if (!name || name !== name.trim() || name.startsWith('.') || name.endsWith('.') ||
      deviceName.test(name) || Buffer.byteLength(name) > 255) {
    throw new UploadStoreError('INVALID', 'Invalid upload filename')
  }
  if (mime && assetKind({ name, mime, size: 1 }) === 'unsupported') {
    if (Object.keys(UPLOAD_MIME_LIMITS).some(candidate => assetKind({ name, mime: candidate, size: 1 }) !== 'unsupported')) {
      throw new UploadStoreError('INVALID', 'Upload filename type disagrees with MIME type')
    }
    throw new UploadStoreError('UNSUPPORTED', 'Unsupported upload filename type')
  }
  return name
}

export function normalizeUploadInput(input) {
  if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    throw new UploadStoreError('INVALID', 'Invalid upload metadata')
  }
  const fields = Object.create(null)
  for (const key of Reflect.ownKeys(input)) {
    const field = Object.getOwnPropertyDescriptor(input, key)
    if (!allowedFields.has(key) || !field?.enumerable || !Object.hasOwn(field, 'value')) {
      throw new UploadStoreError('INVALID', 'Only upload name, MIME and optional size metadata are accepted')
    }
    fields[key] = field.value
  }
  if (!Object.hasOwn(fields, 'name') || !Object.hasOwn(fields, 'mime')) {
    throw new UploadStoreError('INVALID', 'Upload metadata requires name and MIME')
  }
  const type = normalizeUploadType(fields.mime)
  const name = normalizeUploadName(fields.name, type.mime)
  const declared = fields.size
  if (declared !== undefined && (!Number.isSafeInteger(declared) || declared <= 0)) {
    throw new UploadStoreError('INVALID', 'Invalid declared upload size')
  }
  if (declared > type.maxBytes) throw new UploadStoreError('TOO_LARGE', 'Upload exceeds its MIME byte limit')
  return { type, name, declared }
}

export function validateUploadMetadata(name, mime, size) {
  if (!isSupported({ name, mime, size })) throw new UploadStoreError('INVALID', 'Unsupported upload metadata')
}

function badBytes() {
  return new UploadStoreError('INVALID', 'Upload bytes disagree with the declared MIME type')
}

// Validate plain text and PDF once through the stream; only raster validation needs a bounded readback.
export function uploadContentValidator({ mime, kind }) {
  let textPrefix = ''
  let pdfPrefix = Buffer.alloc(0)
  const decoder = kind === 'text' ? new TextDecoder('utf-8', { fatal: true }) : null
  function checkText(chunk) {
    let text
    try { text = decoder.decode(chunk, { stream: chunk !== undefined }) } catch { throw badBytes() }
    if (nonText.test(text)) throw badBytes()
    if (textPrefix.length < 5) textPrefix += text.slice(0, 5 - textPrefix.length)
    if (textPrefix === '%PDF-') throw badBytes()
  }
  return {
    accept(chunk) {
      if (decoder) checkText(chunk)
      else if (kind === 'document' && pdfPrefix.length < 9) {
        pdfPrefix = Buffer.concat([pdfPrefix, chunk.subarray(0, 9 - pdfPrefix.length)])
        if (pdfPrefix.length === 9 && !pdfMagic.test(pdfPrefix.toString('latin1'))) throw badBytes()
      }
    },
    async finish(readRaster) {
      if (decoder) checkText(undefined)
      else if (kind === 'document') {
        if (!pdfMagic.test(pdfPrefix.toString('latin1'))) throw badBytes()
      } else if (avatarImageMime(await readRaster()) !== mime) throw badBytes()
    },
  }
}
