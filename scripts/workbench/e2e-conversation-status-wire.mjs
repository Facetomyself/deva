import { createHash } from 'node:crypto'
import { channel } from 'node:diagnostics_channel'
import { check, scopedRequest } from './e2e-conversation-status-fixture.mjs'
import { waitFor } from './webdriver-local.mjs'

const cookieName = 'deva-workbench-local'
const tokenPattern = /^[A-Za-z0-9_-]{43}$/
const digest = token => createHash('sha256').update(token).digest('base64url')
const cookieFrom = header => new RegExp(`(?:^|;\\s*)${cookieName}=([A-Za-z0-9_-]{43})(?:;|$)`).exec(header ?? '')?.[1]
const authPath = /^\/api\/v1\/auth\/(claim|login)$/
const chatRoute = /^\/api\/v1\/chats(?:\/([A-Za-z0-9_-]{1,128})(?:\/(read-state|context-usage|preferences|turns))?)?$/
const parse = bytes => {
  try { return bytes && Buffer.byteLength(bytes) <= 64 * 1024 ? JSON.parse(bytes.toString()) : null }
  catch { return null }
}

// The observer tees bounded data without consuming the request stream or changing a
// response; all route handling, WebSocket delivery and native commits remain production code.
export function observeStatusWire({ address, origin }, signal) {
  const source = channel('http.server.request.start')
  const auth = [], records = [], manual = new Set()
  let overflow = false
  function observe({ request: req, response: res }) {
    if (req.socket.localPort !== address.port) return
    const path = req.url ?? ''
    const login = authPath.exec(path)
    if (login && req.method === 'POST') {
      const entry = { action: login[1], fresh: !req.headers.cookie, sameOrigin: req.headers.origin === origin }
      if (auth.length >= 2) { overflow = true; return }
      auth.push(entry)
      let session
      const writeHead = res.writeHead
      res.writeHead = function (status, headers, ...rest) {
        session = cookieFrom(headers?.['set-cookie']?.toString())
        return Reflect.apply(writeHead, this, [status, headers, ...rest])
      }
      const end = res.end
      res.end = function (bytes, ...rest) {
        const csrf = parse(bytes)?.csrf
        if (session && tokenPattern.test(csrf ?? '')) {
          entry.cookie = `${cookieName}=${session}`
          entry.owner = digest(session)
          entry.csrf = digest(csrf)
        }
        return Reflect.apply(end, this, [bytes, ...rest])
      }
      res.once('finish', () => { entry.status = res.statusCode })
      return
    }
    const route = chatRoute.exec(path)
    const kind = path === '/api/v1/conversation-status/reads' ? 'reads' : !route ? null
      : route[2] ?? (route[1] ? 'snapshot' : req.method === 'POST' ? 'create' : 'list')
    if (!kind) return
    const cookie = cookieFrom(req.headers.cookie)
    const owner = cookie && digest(cookie)
    if (req.method === 'GET' && manual.has(`${owner}:${path}`) && req.headers['sec-fetch-site'] === undefined) return
    if (records.length >= 350) { overflow = true; return }
    const csrf = req.headers['x-deva-csrf']
    const row = { kind, method: req.method, sid: route?.[1], owner,
      authenticated: Boolean(owner && req.headers.origin === origin && req.headers['sec-fetch-site'] === 'same-origin' &&
        req.headersDistinct['x-deva-csrf']?.length === 1 && tokenPattern.test(csrf ?? '') &&
        auth.find(a => a.owner === owner)?.csrf === digest(csrf) && /^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) }
    records.push(row)
    let length = 0
    const chunks = []
    if (req.method === 'POST' && ['read-state', 'context-usage', 'turns'].includes(kind)) {
      const push = req.push
      req.push = function (chunk, ...rest) {
        if (chunk !== null) {
          length += Buffer.byteLength(chunk)
          if (length <= 8 * 1024) chunks.push(Buffer.from(chunk))
        }
        return Reflect.apply(push, this, [chunk, ...rest])
      }
    }
    const end = res.end
    res.end = function (bytes, ...rest) {
      if (length && length <= 8 * 1024) row.request = parse(Buffer.concat(chunks))
      chunks.length = 0
      if (['create', 'reads', 'context-usage', 'read-state'].includes(kind)) row.response = parse(bytes)
      return Reflect.apply(end, this, [bytes, ...rest])
    }
    res.once('finish', () => { row.status = res.statusCode })
    res.once('close', () => { if (!res.writableFinished) row.interrupted = true })
  }
  source.subscribe(observe)
  return {
    assertAuth() {
      check(auth.length === 2 && auth[0].action === 'claim' && auth[1].action === 'login' &&
        auth.every(a => a.status === 200 && a.owner && a.csrf && a.fresh && a.sameOrigin) &&
        auth[0].owner !== auth[1].owner && auth[0].csrf !== auth[1].csrf, 'Expected two independent real owner sessions')
      return auth.map(a => a.owner)
    },
    mark: () => records.length,
    rows(kind) { return records.filter(row => row.kind === kind) },
    after(mark, kind, predicate = () => true, timeout = 8_000) {
      return waitFor(() => records.slice(mark).find(row => row.kind === kind && row.status && predicate(row)),
        `real scoped HTTP ${kind} after the browser action`, { signal, timeout })
    },
    async get(owner, path) {
      const login = auth.find(a => a.owner === owner)
      check(login?.cookie && (path === '/api/v1/conversation-status/reads' || /^\/api\/v1\/chats\/[A-Za-z0-9_-]{1,128}$/.test(path)),
        'Private wire check expected an independent owner cookie and a fixed read-only route')
      const id = `${owner}:${path}`
      manual.add(id)
      try { return await scopedRequest(origin, path, signal, { cookie: login.cookie }) }
      finally { manual.delete(id) }
    },
    openList(owner, attach) {
      const login = auth.find(a => a.owner === owner)
      check(login?.cookie, 'Passive scoped invalidation requires the idle profile credential')
      return attach(origin, login.cookie, signal)
    },
    assertSound() {
      check(!overflow && records.filter(r => ['read-state', 'context-usage', 'turns'].includes(r.kind)).every(r =>
        r.method === 'POST' && r.authenticated && ((r.kind === 'context-usage' && r.interrupted) ||
          (r.request && (r.status === 200 || (r.kind === 'turns' && r.status === 202))))) &&
        records.filter(r => r.kind === 'reads').every(r => r.method === 'GET' && r.owner && (r.status === 200 || r.interrupted)),
      'Unexpected unscoped status request or incomplete wire observation')
    },
    close() { source.unsubscribe(observe); auth.length = 0; manual.clear() }
  }
}
