import { HttpError, json, readJson, responseHeaders } from '../http/policy.mjs'
import { createDeliveries } from './service.mjs'

const address = /^\/api\/v1\/chats\/([A-Za-z0-9_-]{1,128})\/deliveries(?:\/(reply)|\/(d_[a-f0-9]{32})\/items\/(0|[1-9][0-9]?)\/(download|preview|locate))?$/
const maxDataReplies = 4
const maxSlowTransferMs = 30_000
const fileFaults = Object.freeze({
  ERR_DELIVERY_FILE_INVALID: [400, 'invalid_delivery'], ERR_DELIVERY_FILE_CONFLICT: [409, 'delivery_changed'],
  ERR_DELIVERY_FILE_UNSUPPORTED: [415, 'delivery_unsupported'], AUTH_FAILED: [401, 'auth']
})
function fault(err) {
  if (err instanceof HttpError) return [err.status, err.code]
  if (Object.hasOwn(fileFaults, err?.code)) return fileFaults[err.code]
  if (err?.code === 'ERR_WORKSPACE_UNAVAILABLE') return [404, 'delivery_not_found']
  // Never serialize a local error message, absolute path, model reply or file contents.
  return [503, 'delivery_unavailable']
}
function getRevision(req) {
  const values = req.headersDistinct['if-match']
  if (!values?.length) throw new HttpError(428, 'delivery_revision_required')
  if (values.length !== 1 || !/^"[a-f0-9]{64}"$/u.test(values[0]) || values[0].length !== 66) throw new HttpError(400, 'invalid_delivery_revision')
  return values[0].slice(1, -1)
}
function inlineName(name) {
  const ascii = name.replace(/[^A-Za-z0-9._ -]/gu, '_')
  const encoded = encodeURIComponent(name).replace(/['()*]/g, ch => '%' + ch.codePointAt(0).toString(16).toUpperCase())
  return `filename="${ascii}"; filename*=UTF-8''${encoded}`
}
function sendFile(req, res, op, revision, result) {
  res.writeHead(200, { ...responseHeaders, 'content-security-policy': "sandbox; default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    'cross-origin-resource-policy': 'same-origin', 'content-type': result.mime, 'content-length': result.bytes.length,
    'content-disposition': `${op === 'download' ? 'attachment' : 'inline'}; ${inlineName(result.name)}`, etag: `"${revision}"` })
  res.end(req.method === 'HEAD' ? undefined : result.bytes)
}
function cursorFor(op, raw) {
  if (!raw) return null
  const match = /^\?cursor=([A-Za-z0-9_-]{1,160})$/u.exec(raw)
  if (op !== 'list' || !match || match[0] !== raw) throw new HttpError(400, 'unexpected_query')
  return match[1]
}

/** No mounted directory is directly served. Even with a valid revision clients must own the
 * exact session, record and index. A slow transfer keeps its bounded data slot until it closes. */
export function deliveryRoutes({ turns, files }) {
  const service = createDeliveries({ turns, files })
  let active = 0, dataReplies = 0
  return async (req, res, { auth, policy }) => {
    const raw = req.url ?? '', q = raw.indexOf('?'), path = q < 0 ? raw : raw.slice(0, q)
    const resource = address.exec(path)
    if (!resource || resource[0] !== path) return false
    const [, sid, reply, gid, item, action] = resource, op = reply ?? action ?? 'list'
    const write = op === 'reply' || op === 'locate', binary = op === 'download' || op === 'preview'
    const methods = write ? ['POST'] : binary ? ['GET','HEAD'] : ['GET']
    let counted = false, dataSlot = false, timer
    const releaseData = () => {
      if (!dataSlot) return
      dataSlot = false; dataReplies--; clearTimeout(timer)
      res.off('finish', releaseData); res.off('close', releaseData)
    }
    try {
      policy.check(req, write)
      const cookie = policy.cookie(req)
      const authorize = () => write ? auth.authenticate(cookie, req.headers['x-deva-csrf']) : auth.authenticate(cookie)
      authorize()
      if (!methods.includes(req.method)) { json(res, 405, { error: 'method' }, { allow: methods.join(', ') }); return true }
      const cursor = cursorFor(op, q < 0 ? '' : raw.slice(q))
      if (res.destroyed || res.writableEnded) return true
      if (active >= 8 || (binary && dataReplies >= maxDataReplies)) throw new HttpError(429, 'delivery_busy')
      active++; counted = true
      if (binary) {
        if (req.headers.range !== undefined) throw new HttpError(416, 'delivery_range_unsupported')
        dataReplies++; dataSlot = true; res.once('finish', releaseData); res.once('close', releaseData)
        timer = setTimeout(() => res.destroy(), maxSlowTransferMs); timer.unref()
        const rev = getRevision(req)
        const record = await service.resolveItem(sid, gid, Number(item), rev, op)
        authorize()
        if (!res.destroyed) sendFile(req, res, op, rev, record)
      } else {
        let result
        if (op === 'list') result = await service.list(sid, cursor)
        else {
          const body = await readJson(req, 1024)
          authorize()
          if (op === 'reply') {
            if (Object.keys(body).length !== 2 || !Object.hasOwn(body, 'turnId') || !Object.hasOwn(body, 'format')) throw new HttpError(400, 'invalid_delivery_export')
            result = await service.publish(sid, body, authorize)
          } else {
            if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'revision')) throw new HttpError(400, 'invalid_delivery_revision')
            result = await service.resolveItem(sid, gid, Number(item), body.revision, op)
          }
        }
        authorize()
        if (!res.destroyed) json(res, op === 'reply' && result.created ? 201 : 200, result)
      }
    } catch (err) {
      releaseData()
      const [status, code] = fault(err)
      if (!res.destroyed && !res.headersSent) json(res, status, { error: code }, write ? { connection: 'close' } : {})
    } finally { if (counted) active-- }
    return true
  }
}
