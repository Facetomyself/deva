import { HttpError, json, readJson, responseHeaders } from '../http/policy.mjs'

const general = /^\/api\/v1\/browser\/(status|sites)$/
const scoped = /^\/api\/v1\/chats\/([A-Za-z0-9_-]{1,128})\/browser(?:\/(open)|\/([A-Za-z0-9_-]{24})\/(lease|frame|input|finish|close))?$/
const common = ['viewerNonce', 'token']
const fields = {
  open: ['siteId'], lease: ['viewerNonce', 'intent'], frame: common,
  input: [...common, 'seq', 'action'], finish: [...common, 'intent'], close: []
}
const proof = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/
const maxFrame = 4 * 1024 * 1024
const states = new Set(['unconfigured', 'ready', 'worker-unavailable', 'egress-unavailable', 'binary-missing', 'sandbox-startup-failure'])
const codes = {
  AUTH_FAILED: [401, 'auth'], HANDOFF_DENIED: [403, 'browser_denied'], HANDOFF_UNAVAILABLE: [503, 'browser_unavailable'],
  INVALID_REQUEST: [400, 'invalid_browser_action'], UNKNOWN_SITE: [404, 'browser_site_missing'], TAB_NOT_FOUND: [404, 'browser_tab_missing'],
  SESSION_LIMIT: [429, 'browser_busy'], BUSY: [409, 'browser_busy'], CONTROL_REQUIRED: [403, 'browser_denied']
}
function rejectBody() { throw new HttpError(400, 'invalid_browser_action') }
function verifyBody(op, body) {
  const keys = fields[op]
  if (keys.length !== Object.keys(body).length || !keys.every(k => Object.hasOwn(body, k))) rejectBody()
  for (const k of common) {
    if (keys.includes(k) && (typeof body[k] !== 'string' || body[k].length !== 43 || !proof.test(body[k]))) throw new HttpError(403, 'browser_denied')
  }
  if (op === 'open' && (typeof body.siteId !== 'string' || /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.exec(body.siteId)?.[0] !== body.siteId)) rejectBody()
  if (op === 'lease' && body.intent !== 'control') rejectBody()
  if (op === 'finish' && !['done', 'skip'].includes(body.intent)) rejectBody()
  if (op === 'input' && (!Number.isSafeInteger(body.seq) || body.seq < 1 || !body.action || typeof body.action !== 'object' || Array.isArray(body.action))) rejectBody()
}
function publicSite({ id, label, origin }) { return { id, label, origin } }
function publicTab({ sessionId, tabId, siteId, state, origin, label }) { return { sessionId, tabId, siteId, state, origin, label } }
function workerUnavailable() { throw new HttpError(503, 'browser_unavailable') }
function mapFault(err) {
  if (err instanceof HttpError) return [err.status, err.code]
  return Object.hasOwn(codes, err?.code) ? codes[err.code] : [503, 'browser_unavailable']
}

async function dispatch(controller, op, args) {
  if (op === 'status') {
    if (!controller) return { state: 'unconfigured' }
    try { const { state } = await controller.status(args.actor); return { state: states.has(state) ? state : 'worker-unavailable' } }
    catch (err) { if (err?.code === 'HANDOFF_UNAVAILABLE') return { state: 'worker-unavailable' }; throw err }
  }
  if (!controller) { if (op === 'sites') return { sites: [] }; workerUnavailable() }
  switch (op) {
    case 'sites': return { sites: (await controller.sites(args.actor)).map(publicSite) }
    case 'list': return { tabs: (await controller.list(args)).map(publicTab) }
    case 'open': return { tab: publicTab(await controller.open(args)) }
    case 'finish': return { tab: publicTab(await controller.finish(args)) }
    case 'lease': {
      const { token, ttlMs } = await controller.lease(args)
      return { token, ttlMs }
    }
    case 'input': {
      const { accepted, seq } = await controller.input(args)
      if (accepted !== true || seq !== args.seq) workerUnavailable()
      return { accepted: true, seq }
    }
    case 'close': {
      if ((await controller.closeTab(args)).closed !== true) workerUnavailable()
      return { closed: true }
    }
    case 'frame': return controller.frame(args)
    default: rejectBody()
  }
}
function sendFrame(res, frame) {
  const bytes = frame?.bytes
  if (frame?.mimeType !== 'image/png' || frame.width !== 1024 || frame.height !== 768 || !Buffer.isBuffer(bytes) ||
      bytes.length < 45 || bytes.length > maxFrame || bytes.toString('hex', 0, 8) !== '89504e470d0a1a0a' ||
      bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes.readUInt32BE(16) !== 1024 || bytes.readUInt32BE(20) !== 768) {
    throw new HttpError(503, 'browser_frame_unavailable')
  }
  res.writeHead(200, { ...responseHeaders, 'cross-origin-resource-policy': 'same-origin', 'content-type': 'image/png', 'content-length': bytes.length })
  res.end(bytes)
}

/** No raw browser protocol, URL navigation, query-string credentials or write-through WebSocket.
 * Each private request is reauthenticated after its body and before any frame leaves the host. */
export function browserRoutes(controller) {
  let inFlight = 0
  return async function handle(req, res, { auth, policy }) {
    const raw = req.url ?? '', path = raw.split('?', 1)[0]
    const simple = general.exec(path), chat = scoped.exec(path)
    if (!simple && !chat) return false
    const op = simple?.[1] ?? chat?.[2] ?? chat?.[4] ?? 'list'
    const write = Object.hasOwn(fields, op)
    let counted = false
    try {
      policy.check(req, write)
      if (path !== raw) throw new HttpError(400, 'unexpected_query')
      const method = write ? 'POST' : 'GET'
      if (req.method !== method) { json(res, 405, { error: 'method' }, { allow: method }); return true }
      const cookie = policy.cookie(req)
      const identify = () => write ? auth.identify(cookie, req.headers['x-deva-csrf']) : auth.identify(cookie)
      const actor = identify()
      if (inFlight >= 12) throw new HttpError(429, 'browser_busy')
      inFlight++; counted = true
      const body = write ? await readJson(req, 8192) : {}
      if (write) { verifyBody(op, body); identify() }
      const result = await dispatch(controller, op, { ...body, actor, sid: chat?.[1], tabId: chat?.[3] })
      if (op === 'frame') {
        try {
          identify()
          if (res.destroyed) { result.bytes.fill(0); return true }
          // The exact verified frame object is one-use; no await between the last lease check and res.end.
          controller.assertFrameCurrent(result)
          sendFrame(res, result)
        } catch (error) { if (!res.headersSent && Buffer.isBuffer(result?.bytes)) result.bytes.fill(0); throw error }
      } else {
        identify()
        if (!res.destroyed) json(res, 200, result)
      }
    } catch (err) {
      const [status, code] = mapFault(err)
      if (!res.headersSent && !res.destroyed) json(res, status, { error: code }, write ? { connection: 'close' } : {})
    } finally { if (counted) inFlight-- }
    return true
  }
}
