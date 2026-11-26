import { HttpError, json, responseHeaders } from '../http/policy.mjs'

const matchResource = /^\/api\/v1\/chats\/([A-Za-z0-9_-]{1,128})\/attachments(?:\/([a-f0-9-]{36})(\/preview)?)?$/
const uuid4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp'])
const errorMap = {
  UPLOAD_INVALID:[400,'invalid_attachment'], UPLOAD_UNSUPPORTED:[415,'unsupported_attachment'], UPLOAD_NOT_FOUND:[404,'attachment_not_found'],
  UPLOAD_TOO_LARGE:[413,'attachment_too_large'], UPLOAD_QUOTA:[429,'attachment_quota'], UPLOAD_CLOSED:[503,'attachments_unavailable'],
  UPLOAD_CORRUPT:[500,'attachment_unavailable'], AUTH_FAILED:[401,'auth']
}
const maxFile = 20 * 1024 * 1024
function one(req, key) {
  const values = req.headersDistinct[key]
  if (!Array.isArray(values) || values.length !== 1) throw new HttpError(400, 'attachment_header')
  return values[0]
}
function meta(req) {
  if (one(req, 'content-type').toLowerCase() !== 'application/octet-stream' || (req.headers['content-encoding'] ?? 'identity') !== 'identity') throw new HttpError(415, 'binary_required')
  const encoded = one(req, 'x-deva-file-name')
  if (!encoded.length || encoded.length > 340 || /[^A-Za-z0-9_-]/.test(encoded)) throw new HttpError(400, 'attachment_name')
  const bytes = Buffer.from(encoded, 'base64url'); let name
  try { name = new TextDecoder('utf-8', { fatal:true }).decode(bytes) } catch { throw new HttpError(400, 'attachment_name') }
  if (bytes.toString('base64url') !== encoded || !name || name.trim() !== name || /[\x00-\x1f\x7f/\\]/.test(name)) throw new HttpError(400, 'attachment_name')
  const mime = one(req, 'x-deva-file-type')
  if (mime.length > 96) throw new HttpError(415, 'unsupported_attachment')
  const value = req.headers['content-length']
  if (value === undefined) return { name, mime }
  if (!/^\d+$/.test(value) || Number(value) > maxFile) throw new HttpError(413, 'attachment_too_large')
  return { name, mime, size:Number(value) }
}
function publicMeta(m) { const { id, name, mime, kind, size } = m; return { id, name, mime, kind, size } }

/** The upload route never opens a file based on a client path. A raw upload alone does not
 * attach anything to a model request. Only an authenticated, explicit turn can do that. */
export function attachmentRoutes({ uploads, turns }) {
  const active = new Set(); let closing = false
  return {
    async handle(req, res, { auth, policy }) {
      const path = (req.url ?? '').split('?', 1)[0], resource = matchResource.exec(path)
      if (!resource) return false
      const [, sid, id, preview] = resource
      const methods = preview ? ['GET','HEAD'] : id ? ['DELETE'] : ['POST']
      const write = req.method !== 'GET' && req.method !== 'HEAD'
      let ctrl, timer, onAbort
      try {
        policy.check(req, write)
        if (req.url !== path || (id && !uuid4.test(id))) throw new HttpError(400, 'invalid_attachment_reference')
        if (!methods.includes(req.method)) { json(res,405,{error:'method'},{allow:methods.join(', '),connection:'close'}); return true }
        const cookie = policy.cookie(req)
        function authorized() { return write ? auth.authenticate(cookie, req.headers['x-deva-csrf']) : auth.authenticate(cookie) }
        authorized()
        const scope = turns.attachmentScope(sid)
        if (!scope) throw new HttpError(404, 'session_not_found')
        if (closing) throw new HttpError(503,'attachments_unavailable')
        if (!id) {
          if (scope.writable !== true) throw new HttpError(409,'chat_read_only')
          if (active.size >= 4) throw new HttpError(429,'attachment_quota')
          const details = meta(req)
          ctrl = new AbortController(); active.add(ctrl)
          onAbort = () => ctrl.abort(new HttpError(400,'upload_aborted'))
          req.once('aborted',onAbort)
          timer = setTimeout(() => ctrl.abort(new HttpError(408,'upload_timeout')), 60000); timer.unref()
          const staged = await uploads.stage(sid, details, req.iterator({destroyOnReturn:false}), {signal:ctrl.signal})
          try { authorized(); ctrl.signal.throwIfAborted(); if (!turns.attachmentScope(sid)?.writable) throw new HttpError(409,'chat_read_only') }
          catch (err) { await uploads.remove(sid,staged.id); throw err }
          json(res,201,{attachment:publicMeta(staged)})
        } else if (!preview) {
          await uploads.remove(sid,id); json(res,200,{ok:true})
        } else {
          const committed = turns.describeCommittedAttachment(sid,id)
          const descriptor = committed ?? await uploads.describe(sid,id)
          if (!descriptor) throw new HttpError(404,'attachment_not_found')
          // Decide the type from verified, session-bound metadata before loading up to 20 MiB of PDF.
          if (descriptor.kind !== 'image' || !imageTypes.has(descriptor.mime)) throw new HttpError(415,'no_image_preview')
          const item = committed ? turns.readCommittedAttachment(sid,id) : await uploads.read(sid,id)
          if (!item || item.meta.id !== id) throw new HttpError(committed ? 500 : 404, committed ? 'attachment_unavailable' : 'attachment_not_found')
          if (item.meta.kind !== 'image' || !imageTypes.has(item.meta.mime)) throw new HttpError(415,'no_image_preview')
          if (!Buffer.isBuffer(item.bytes) || item.bytes.length !== item.meta.size || item.bytes.length > 2 * 1024 * 1024) throw new HttpError(500,'attachment_unavailable')
          authorized()
          res.writeHead(200,{...responseHeaders, 'cross-origin-resource-policy':'same-origin', 'content-disposition':'inline', 'content-type':item.meta.mime,'content-length':item.bytes.length})
          res.end(req.method === 'HEAD' ? undefined : item.bytes)
        }
      } catch (err) {
        const [status,code] = err instanceof HttpError ? [err.status,err.code] : Object.hasOwn(errorMap,err?.code) ? errorMap[err.code] : [500,'attachment_unavailable']
        if (!res.headersSent && !res.destroyed) json(res,status,{error:code},write?{connection:'close'}:{})
      } finally {
        if (timer) clearTimeout(timer)
        if (onAbort) req.off('aborted',onAbort)
        if (ctrl) active.delete(ctrl)
      }
      return true
    },
    close() { closing=true; for (const c of active) c.abort(new HttpError(503,'attachments_unavailable')) }
  }
}
