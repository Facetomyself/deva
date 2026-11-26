import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { TextDecoder } from 'node:util'

const VERSION = 1
const CIPHER = 'aes-256-gcm'
const AAD = Buffer.from('deva:headless-vault:v1', 'ascii')
const NONCE_BYTES = 12
const TAG_BYTES = 16
const MAX_NAME_BYTES = 512
const MAX_VALUE_BYTES = 64 * 1024
const MAX_ENTRIES = 4096
const MAX_MAP_BYTES = 1024 * 1024
export const MAX_ENVELOPE_BYTES = 4 * Math.ceil(MAX_MAP_BYTES / 3) + 256
const FIELDS = ['version', 'nonce', 'tag', 'ciphertext']
const NON_BASE64 = /[^A-Za-z0-9+/=]/
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function invalid() {
  return Object.assign(new Error('Invalid vault format'), { code: 'ERR_VAULT_FORMAT' })
}

function oversized() {
  return Object.assign(new Error('Vault size limit exceeded'), { code: 'ERR_VAULT_SIZE' })
}

function isText(value, max, allowEmpty = false) {
  return typeof value === 'string' && (allowEmpty || value.length > 0) && Buffer.byteLength(value) <= max
}

export function validateName(name, allowEmpty = false) {
  if (!isText(name, MAX_NAME_BYTES, allowEmpty)) throw new TypeError('Invalid vault name or prefix')
}

export function validateValue(value) {
  if (!isText(value, MAX_VALUE_BYTES, true)) throw new TypeError('Invalid vault value')
}

function parse(text) {
  try {
    return JSON.parse(text)
  } catch {
    throw invalid()
  }
}

function decodeUtf8(buffer) {
  try {
    return utf8.decode(buffer)
  } catch {
    throw invalid()
  }
}

function decodeBase64(value, min, max = min) {
  if (typeof value !== 'string' || value.length > 4 * Math.ceil(max / 3) ||
      value.length % 4 !== 0 || NON_BASE64.test(value)) {
    throw invalid()
  }
  const bytes = Buffer.from(value, 'base64')
  // Round-trip check rejects nonzero padding bits and Node's permissive decoder variants.
  if (bytes.length < min || bytes.length > max || bytes.toString('base64') !== value) throw invalid()
  return bytes
}

function parseEnvelope(bytes) {
  const text = decodeUtf8(bytes)
  const value = parse(text)
  if (value === null || Array.isArray(value) || typeof value !== 'object' ||
      Object.keys(value).length !== FIELDS.length || !FIELDS.every(field => Object.hasOwn(value, field)) ||
      value.version !== VERSION) {
    throw invalid()
  }
  const nonce = decodeBase64(value.nonce, NONCE_BYTES)
  const tag = decodeBase64(value.tag, TAG_BYTES)
  const ciphertext = decodeBase64(value.ciphertext, 2, MAX_MAP_BYTES)
  // All fields are ASCII names, the literal version, and canonical Base64. Comparing after removal
  // of JSON whitespace still catches duplicate/escaped field names that JSON.parse would normalize.
  if (text.replace(/[\t\n\r ]/g, '') !== JSON.stringify(value)) throw invalid()
  return { nonce, tag, ciphertext }
}

function parseMap(bytes) {
  const entries = parse(decodeUtf8(bytes))
  if (!Array.isArray(entries) || entries.length > MAX_ENTRIES) throw invalid()
  const map = new Map()
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || !isText(entry[0], MAX_NAME_BYTES) ||
        !isText(entry[1], MAX_VALUE_BYTES) || map.has(entry[0])) {
      throw invalid()
    }
    map.set(entry[0], entry[1])
  }
  return map
}

export function encryptMap(map, key) {
  if (map.size > MAX_ENTRIES) throw oversized()
  // Arrays of pairs preserve arbitrary string keys and permit rejecting duplicate keys on decode.
  const bytes = Buffer.from(JSON.stringify([...map]), 'utf8')
  try {
    if (bytes.length > MAX_MAP_BYTES) throw oversized()
    const nonce = randomBytes(NONCE_BYTES)
    const cipher = createCipheriv(CIPHER, key, nonce, { authTagLength: TAG_BYTES })
    cipher.setAAD(AAD)
    const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()])
    return Buffer.from(JSON.stringify({
      version: VERSION,
      nonce: nonce.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64')
    }), 'utf8')
  } finally {
    bytes.fill(0)
  }
}

export function decryptMap(bytes, key) {
  const { nonce, tag, ciphertext } = parseEnvelope(bytes)
  const decipher = createDecipheriv(CIPHER, key, nonce, { authTagLength: TAG_BYTES })
  decipher.setAAD(AAD)
  decipher.setAuthTag(tag)
  let decrypted
  try {
    try {
      decrypted = decipher.update(ciphertext)
      // GCM produces no trailing bytes. Authentication must finish before using the plaintext.
      decipher.final()
    } catch {
      throw Object.assign(new Error('Vault authentication failed'), { code: 'ERR_VAULT_AUTH' })
    }
    return parseMap(decrypted)
  } finally {
    decrypted?.fill(0)
  }
}
