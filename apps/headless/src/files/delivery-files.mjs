import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { extname } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { AVATAR_MAX_BYTES, avatarImageMime } from '../../dist/library-core.mjs'
import { officeDeliveryMime } from './delivery-office.mjs'
import { decodeUtf8 } from './workspace-files-fd.mjs'
import { assertFile, readBytes, withDirectory, withFilePin, withReadablePin } from './workspace-files-pin.mjs'

const text = { kind: 'text', mime: 'text/plain', maxBytes: 2 * 1024 * 1024 }
const raster = mime => ({ kind: 'image', mime, maxBytes: AVATAR_MAX_BYTES })
const jpeg = raster('image/jpeg')
const pdf = { kind: 'document', mime: 'application/pdf', maxBytes: 8 * 1024 * 1024 }
const office = (ext, subtype) => ({ ext, kind: 'document', mime: 'application/vnd.openxmlformats-officedocument.' + subtype, maxBytes: 8 * 1024 * 1024 })
const types = new Map([
  ['.txt', text], ['.md', text], ['.csv', text], ['.json', text],
  ['.png', raster('image/png')], ['.jpg', jpeg], ['.jpeg', jpeg], ['.webp', raster('image/webp')], ['.pdf', pdf],
  ['.docx', office('.docx', 'wordprocessingml.document')], ['.xlsx', office('.xlsx', 'spreadsheetml.sheet')],
  ['.pptx', office('.pptx', 'presentationml.presentation')],
])
const nonText = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u
const activeTextPrefix = /^(?:#!|%PDF-|<\?xml\b|<!doctype\s+html\b|<(?:html|head|body|script|iframe|svg)(?=[\s/>]))/iu
const keyPrefix = /^-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u
const pdfMagic = /^%PDF-(?:1\.[0-7]|2\.0)[\r\n]/u
const revisionPattern = /^r_[0-9a-f]{64}$/u
const cacheLimit = 128

class DeliveryFileError extends Error {
  constructor(kind, status, message) {
    super(message)
    this.code = `ERR_DELIVERY_FILE_${kind}`
    this.status = this.statusCode = status
  }
}
const invalid = () => new DeliveryFileError('INVALID', 400, 'Invalid delivery file request')
const conflict = () => new DeliveryFileError('CONFLICT', 409, 'Delivery file changed or is unavailable')
const unsupported = () => new DeliveryFileError('UNSUPPORTED', 415, 'Delivery file is not available in this format')
const equalTag = (a, b) => timingSafeEqual(Buffer.from(a), Buffer.from(b))

function metadata(name, type, info, status, revision = null) {
  const ready = status === 'ready'
  return {
    name, kind: type?.kind ?? 'document', size: info && info.size <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(info.size) : null,
    status, revision, canDownload: ready, canPreview: ready && type.kind === 'image', canLocate: ready,
  }
}
function validateBytes(type, bytes) {
  if (type === pdf) return pdfMagic.test(bytes.subarray(0, 9).toString('latin1')) ? 'ready' : 'unsupported'
  if (type.ext) return officeDeliveryMime(type.ext, bytes) === type.mime ? 'ready' : 'unsupported'
  if (type.kind === 'image') return avatarImageMime(bytes) === type.mime ? 'ready' : 'unsupported'
  let content
  try { content = decodeUtf8(bytes) } catch { return 'unsupported' }
  const prefix = content.trimStart().slice(0, 1024)
  if (keyPrefix.test(prefix)) return 'private'
  return nonText.test(content) || activeTextPrefix.test(prefix) ? 'unsupported' : 'ready'
}

/** Only accept paths taken from authenticated native history, never HTTP client input. */
export function openDeliveryFiles({ catalog }) {
  if (typeof catalog?.resolveDeliveryPath !== 'function' || typeof catalog?.pinProject !== 'function') {
    throw TypeError('A workspace catalog is required')
  }
  const signingKey = randomBytes(32)
  // Cache only validation outcomes/signatures, not file bytes or file descriptors. A hit
  // still re-pins the named entry and checks metadata/access; all reads bypass this cache.
  const settled = new Map()
  function tag(domain, key, bytes) {
    const signer = createHmac('sha256', signingKey).update(domain).update(key)
    if (bytes) signer.update(bytes)
    return signer.digest('hex').slice(0, 32)
  }
  function content(scope, name, pin, info, type, key, metaTag, full) {
    let outcome = full ? undefined : settled.get(key)
    let bytes
    if (!outcome) {
      // PDF is attachment-only. Its classifier and signature sample just magic plus
      // the versioned inode metadata; a real download re-reads and checks all bytes.
      bytes = withReadablePin(pin, info, fd => readBytes(fd, info, type === pdf && !full ? 9 : undefined), scope.project)
      const status = validateBytes(type, bytes)
      const signed = type === pdf ? bytes.subarray(0, 9) : bytes
      outcome = { status, revision: status === 'ready' ? `r_${metaTag}${tag('content\0', key, signed)}` : null }
    }
    assertFile(scope, name, info)
    settled.delete(key)
    settled.set(key, outcome)
    if (settled.size > cacheLimit) settled.delete(settled.keys().next().value)
    return { ...outcome, bytes }
  }
  function inspectPinned(absolute, expected, variant) {
    const grant = catalog.resolveDeliveryPath(absolute)
    if (!grant) return null
    const { id, path } = grant
    const parts = path.split('/')
    const name = parts.pop()
    const type = types.get(extname(name).toLowerCase())
    return withDirectory(catalog, id, parts, scope => withFilePin(scope, name, ({ pin, info }) => {
      if (!type || (info.mode & 0o7111n)) return { item: metadata(name, type, info, 'unsupported') }
      if (info.size > type.maxBytes) return { item: metadata(name, type, info, 'too-large') }
      const key = JSON.stringify([
        // The catalog ID binds the project device/inode. A directory's birth time may be
        // derived from ctime on older Linux; unrelated sibling edits must not retag this file.
        id, path, scope.project.mount,
        info.dev, info.ino, info.birthtimeNs, info.ctimeNs, info.mtimeNs, info.size, info.mode, info.uid, info.gid,
      ].map(String))
      const metaTag = tag('meta\0', key)
      if (expected && !equalTag(expected.slice(2, 34), metaTag)) return null
      const output = content(scope, name, pin, info, type, key, metaTag,
        variant === 'download' || (variant === 'preview' && type.kind === 'image'))
      if (output.status === 'private') return null
      return { item: metadata(name, type, info, output.status, output.revision), id, path, type, bytes: output.bytes }
    }, () => ({ item: metadata(name, type, null, 'missing') })))
  }
  function lookupRevision(absolute, expected, variant) {
    if (typeof expected !== 'string' || expected.length !== 66 || !revisionPattern.test(expected)) throw invalid()
    let result
    try { result = inspectPinned(absolute, expected, variant) } catch { throw conflict() }
    if (!result?.item.revision || !equalTag(result.item.revision, expected)) throw conflict()
    return result
  }
  return Object.freeze({
    async inspect(absolute) {
      // Yield between cold metadata entries in the caller's bounded page scan.
      await setImmediate()
      try { return inspectPinned(absolute)?.item ?? null } catch { return null }
    },
    async read(absolute, revision, variant) {
      if (variant !== 'download' && variant !== 'preview') throw invalid()
      const { item, type, bytes } = lookupRevision(absolute, revision, variant)
      if (variant === 'preview' && !item.canPreview) throw unsupported()
      return { bytes, mime: type.mime, name: item.name }
    },
    async locate(absolute, revision) {
      const { id, path } = lookupRevision(absolute, revision)
      return { workspaceId: id, path }
    },
  })
}
