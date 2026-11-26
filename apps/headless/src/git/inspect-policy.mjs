import { createHash } from 'node:crypto'
import { decodeUtf8 } from '../files/workspace-files-fd.mjs'
import { sensitiveBytes, workPath } from './repository-paths.mjs'

export const SHA1 = /^[0-9a-f]{40}$/
export const MODE_FILE = 0o100644
export const MODE_EXEC = 0o100755
export const MODE_LINK = 0o120000
export const MODE_GITLINK = 0o160000
export const MODE_DIR = 0o040000
export const MAX_ENTRIES = 2000
export const MAX_TREE_DEPTH = 16
export const MAX_INDEX_BYTES = 4 * 1024 * 1024
export const MAX_TREE_BYTES = 4 * 1024 * 1024
export const MAX_WORK_FILE_BYTES = 2 * 1024 * 1024
export const MAX_WORK_BYTES = 32 * 1024 * 1024
export const MAX_TEXT_BYTES = 256 * 1024
export const MAX_RESULT_ROWS_BYTES = 1536 * 1024

const PRIVATE_NAME = /^(?:env(?:[._-].*)?|(?:.*[._-])?(?:credentials?|secrets?|passwords?|tokens?|private[-_ ]?keys?|keystores?|keyrings?)(?:[._-].*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:[._-].*)?|authorized_keys|known_hosts|passwd|shadow|netrc|npmrc|pypirc|git-credentials)$/i
const PRIVATE_SUFFIX = /\.(?:pem|key|p12|pfx|pkcs12|jks|keystore|kdbx|ovpn|ppk)$/i
const PRIVATE_TEXT = /-----BEGIN [A-Z0-9 -]{0,48}(?:PRIVATE KEY(?: BLOCK)?|PKCS12)-----|PuTTY-User-Key-File-[0-9]{1,2}:/i
const BINARY_CONTROL = /[\u0000-\u0008\u000e-\u001f\u007f-\u0084\u0086-\u009f]/u
const UNSAFE_DISPLAY = /[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]|[^\s<>()]@[^\s<>()]|:\/\/|\b(?:file|ssh|git|ftp|https?|mailto|data):\S|(?:^|[^\p{L}\p{N}_.\-/])(?:\/(?=\S)|[a-z]:[\\/]|\\\\|~\/)/iu
const UNSAFE_REF = /[\p{Cf}\p{Zl}\p{Zp}]|@[a-z0-9][a-z0-9.-]{0,99}\.[a-z][a-z0-9]{1,10}(?:\/|$)|[\\:]|^\/|\/\//iu

export function gitInspectError(code) {
  return Object.assign(new Error(code), { code })
}

export function fail(code) { throw gitInspectError(code) }
export function regularMode(mode) { return mode === MODE_FILE || mode === MODE_EXEC }
export function leafMode(mode) { return regularMode(mode) || mode === MODE_LINK || mode === MODE_GITLINK }
export function sha1(bytes) { return createHash('sha1').update(bytes).digest('hex') }
export function blobOid(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}
export function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }

export function safePath(bytes) {
  try {
    const rel = decodeUtf8(bytes)
    const parts = workPath(rel)
    if (!parts || parts.some(part => PRIVATE_NAME.test(part) || PRIVATE_SUFFIX.test(part) ||
      /[\u202a-\u202e\u2066-\u2069\ufeff]/u.test(part))) return null
    return rel
  } catch { return null }
}

export function diffText(bytes) {
  if (sensitiveBytes(bytes)) return { state: 'unavailable', limitation: 'sensitive_content' }
  try {
    const text = decodeUtf8(bytes)
    if (PRIVATE_TEXT.test(text)) return { state: 'unavailable', limitation: 'sensitive_content' }
    if (BINARY_CONTROL.test(text)) return { state: 'binary', limitation: 'binary_content' }
    return { state: 'ready', text }
  } catch { return { state: 'binary', limitation: 'binary_content' } }
}

export function displayRef(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || UNSAFE_REF.test(value) ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(value) || !value.isWellFormed()) return null
  return value
}

export function displayText(bytes, limit) {
  // Validate all of the bounded first line before truncating; never show part of a redacted value.
  if (bytes.length > 4096) return ''
  try {
    const value = decodeUtf8(bytes).trim()
    if (UNSAFE_DISPLAY.test(value) || PRIVATE_TEXT.test(value)) return ''
    const chars = Array.from(value)
    return chars.length > limit ? chars.slice(0, limit - 1).join('') + '…' : value
  } catch { return '' }
}

export function limitationFor(error, fallback) {
  switch (error?.code) {
    case 'git_limit': return `${fallback}_limit`
    case 'git_object_unavailable': return 'missing_object'
    case 'git_corrupt': return `${fallback}_invalid`
    case 'unsupported_git_layout': return 'unsupported_layout'
    case 'git_index_unsupported': return 'index_unsupported'
    default: return `${fallback}_unavailable`
  }
}
