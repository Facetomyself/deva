import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024
export const AVATAR_MIME_BY_EXT = Object.freeze({ webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg' } as const)
export type AvatarMime = (typeof AVATAR_MIME_BY_EXT)[keyof typeof AVATAR_MIME_BY_EXT]
export const LEGACY_AVATAR_FILES = Object.freeze(Object.keys(AVATAR_MIME_BY_EXT).map(ext => `avatar.${ext}`))
// One atomically replaced slot for every MIME. A 0-byte slot is an explicit clear,
// so an old extension can never become active again after a clear or format switch.
export const AVATAR_SLOT = 'avatar'
export const PERSONA_AVATAR_SLOT_DIR = '.managed-v1'

const roleIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u
const windowsDevice = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu
const reservedRole = new Set(['prototype', ...Object.getOwnPropertyNames(Object.prototype).map(key => key.toLowerCase())])

export function validPersonaAvatarId(id: unknown): id is string {
  if (typeof id !== 'string' || roleIdPattern.exec(id)?.[0] !== id || id.endsWith('.') || id.includes('..') || windowsDevice.test(id)) return false
  const folded = id.toLowerCase()
  return !reservedRole.has(folded) && (folded !== 'general' || id === 'general')
}

/** Only validated IDs reach storage; hashing removes case and extension ambiguities in the slot path. */
export function personaAvatarSlotName(id: string): string {
  return createHash('sha256').update(id).digest('hex')
}

const MAX_BASE64 = 4 * Math.ceil(AVATAR_MAX_BYTES / 3)
const MAX_DIMENSION = 4096
const pngMagic = Buffer.from('89504e470d0a1a0a', 'hex')
const pngEnd = Buffer.from('0000000049454e44ae426082', 'hex')
const dimensions = (width: number, height: number): boolean =>
  width > 0 && height > 0 && width <= MAX_DIMENSION && height <= MAX_DIMENSION

function isPng(bytes: Buffer): boolean {
  if (bytes.length < 57 || !bytes.subarray(0, 8).equals(pngMagic) || bytes.readUInt32BE(8) !== 13 ||
      bytes.toString('latin1', 12, 16) !== 'IHDR' || !dimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20)) ||
      !bytes.subarray(-12).equals(pngEnd)) return false
  let hasData = false
  for (let offset = 33; offset + 12 <= bytes.length;) {
    const size = bytes.readUInt32BE(offset)
    const tag = bytes.toString('latin1', offset + 4, offset + 8)
    if (tag === 'IEND') return hasData && offset === bytes.length - 12
    if (tag === 'IHDR' || tag === 'acTL' || tag === 'fcTL' || tag === 'fdAT') return false
    if (tag === 'IDAT' && size) hasData = true
    offset += size + 12
  }
  return false
}

function isJpeg(bytes: Buffer): boolean {
  if (bytes.length < 16 || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) return false
  // A JPEG frame marker gives dimensions without inflating or decoding the image.
  let frame = false
  for (let offset = 2; offset + 4 < bytes.length;) {
    if (bytes[offset++] !== 0xff) return false
    while (bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]
    if (offset + 2 > bytes.length) return false
    const length = bytes.readUInt16BE(offset)
    if (length < 2 || offset + length > bytes.length - 2) return false
    if (marker === 0xda) return frame && length >= 6 && offset + length < bytes.length - 2
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 8 || !dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3))) return false
      frame = true
    } else if (marker === 0 || marker === 1 || (marker >= 0xd0 && marker <= 0xd9)) return false
    offset += length
  }
  return false
}

function webpChunkImage(bytes: Buffer, start: number, size: number, tag: string): boolean {
  if (tag === 'VP8 ' && size > 10 && bytes[start] % 2 === 0 && bytes.toString('hex', start + 3, start + 6) === '9d012a') {
    return dimensions(bytes.readUInt16LE(start + 6) & 0x3fff, bytes.readUInt16LE(start + 8) & 0x3fff)
  }
  if (tag === 'VP8L' && size > 5 && bytes[start] === 0x2f) {
    const info = bytes.readUInt32LE(start + 1)
    return (info >>> 29) === 0 && dimensions((info & 0x3fff) + 1, ((info >>> 14) & 0x3fff) + 1)
  }
  return false
}

function isWebp(bytes: Buffer): boolean {
  if (bytes.length < 26 || bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WEBP' ||
      bytes.readUInt32LE(4) !== bytes.length - 8) return false
  const extended = bytes.toString('latin1', 12, 16) === 'VP8X'
  let hasImage = false
  let offset = 12
  for (; offset + 8 <= bytes.length;) {
    const tag = bytes.toString('latin1', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const start = offset + 8
    const next = start + size + size % 2
    if (next > bytes.length) return false
    if (tag === 'VP8X') {
      if (offset !== 12 || size !== 10 || (bytes[20] & 0x02) !== 0 ||
          !dimensions(bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1)) return false
    } else if (tag === 'VP8 ' || tag === 'VP8L') {
      if (hasImage || !webpChunkImage(bytes, start, size, tag)) return false
      hasImage = true
    } else if (!extended || tag === 'ANIM' || tag === 'ANMF') return false
    offset = next
  }
  return hasImage && offset === bytes.length
}

/** Identify and bound the raster header/container, without decoding pixel data. */
export function avatarImageMime(bytes: Buffer): AvatarMime | null {
  if (bytes.length > AVATAR_MAX_BYTES) return null
  if (isPng(bytes)) return AVATAR_MIME_BY_EXT.png
  if (isJpeg(bytes)) return AVATAR_MIME_BY_EXT.jpg
  if (isWebp(bytes)) return AVATAR_MIME_BY_EXT.webp
  return null
}

export function avatarDataUri(bytes: Buffer, mime: AvatarMime): string {
  return `data:${mime};base64,${bytes.toString('base64')}`
}

export function decodeAvatarDataUri(value: unknown): { bytes: Buffer; mime: AvatarMime } | null {
  if (typeof value !== 'string' || value.length > MAX_BASE64 + 23) return null
  const sep = value.indexOf(',')
  if (sep < 0 || sep > 22) return null
  const header = /^data:(image\/(?:png|webp|jpeg|jpg));base64$/i.exec(value.slice(0, sep))
  if (!header || header[0].length !== sep) return null
  const encoded = value.slice(sep + 1)
  if (!encoded.length || encoded.length > MAX_BASE64 || encoded.length % 4 || /[^A-Za-z0-9+/=]/.test(encoded)) return null
  const bytes = Buffer.from(encoded, 'base64')
  const requested = header[1].toLowerCase()
  const mime = avatarImageMime(bytes)
  if (!mime || (requested === 'image/jpg' ? AVATAR_MIME_BY_EXT.jpg : requested) !== mime || bytes.toString('base64') !== encoded) return null
  return { bytes, mime }
}
