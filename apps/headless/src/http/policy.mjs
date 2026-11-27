import { isIP } from 'node:net'

export class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code }
}

/** Trust a configured public origin, never forwarded headers or an origin supplied by a client. */
export function httpPolicy(value) {
  const url = new URL(value)
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const local = host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'))
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)))
    throw new Error('Public origin must be HTTPS (or loopback HTTP) without path, credentials, query or fragment')
  const secure = url.protocol === 'https:'
  const cookieName = secure ? '__Host-deva-workbench' : 'deva-workbench-local'
  const cookieAttrs = `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`
  return Object.freeze({
    origin: url.origin,
    cookieName,
    check(req, mutating = false) {
      // Match the virtual host (also for WebSocket upgrades) before reading credentials. Behind a
      // TLS proxy the request's real Host must be preserved; X-Forwarded-Host is intentionally ignored.
      const reqHost = req.headers.host
      if (typeof reqHost !== 'string' || reqHost.toLowerCase() !== url.host.toLowerCase()) throw new HttpError(403, 'origin')
      const origin = req.headers.origin
      if ((mutating || origin !== undefined) && origin !== url.origin) throw new HttpError(403, 'origin')
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'origin')
    },
    cookie(req) {
      const parts = String(req.headers.cookie ?? '').split(';').map((s) => s.trim()).filter((s) => s.startsWith(`${cookieName}=`))
      // Ambiguous cookies should not select another session based on header order.
      if (parts.length !== 1) return undefined
      const token = parts[0].slice(cookieName.length + 1)
      return /^[A-Za-z0-9_-]{32,128}$/.test(token) ? token : undefined
    },
    issueCookie(token, expiresAt, now = Date.now()) {
      if (!/^[A-Za-z0-9_-]{32,128}$/.test(token) || !Number.isSafeInteger(expiresAt) || expiresAt <= now) throw new Error('Invalid session metadata')
      return `${cookieName}=${token}; ${cookieAttrs}; Max-Age=${Math.max(1, Math.floor((expiresAt - now) / 1000))}`
    },
    forgetCookie() { return `${cookieName}=; ${cookieAttrs}; Max-Age=0` }
  })
}

export const responseHeaders = Object.freeze({
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
})

export function json(res, status, payload, headers = {}) {
  const bytes = Buffer.from(JSON.stringify(payload))
  res.writeHead(status, { ...responseHeaders, 'content-type': 'application/json; charset=utf-8', 'content-length': bytes.length, ...headers })
  res.end(bytes)
}

// Called only on successfully parsed JSON. Count object members without interpreting
// colons in strings. JSON.parse silently chooses the last value of a duplicate key,
// including differently escaped spellings. Existing callers can opt into root checking.
function wireMemberCount(raw, nested) {
  let members=0, depth=0, quoted=false
  for (let i=0;i<raw.length;i++) {
    const ch=raw.charCodeAt(i)
    if (quoted) { if (ch===92) i++; else if (ch===34) quoted=false; continue }
    if (ch===34) quoted=true
    else if (ch===123 || ch===91) depth++
    else if (ch===125 || ch===93) depth--
    else if (ch===58 && (nested || depth===1)) members++
  }
  return members
}

// An iterative walk avoids recursion on a deeply nested but size-bounded request.
function parsedMemberCount(root) {
  let total=0
  const pending=[root]
  while (pending.length) {
    const value=pending.pop()
    if (value===null || typeof value!=='object') continue
    const children=Object.values(value)
    if (!Array.isArray(value)) total+=children.length
    for (const child of children) if (child!==null && typeof child==='object') pending.push(child)
  }
  return total
}

/** Read only an uncompressed, bounded JSON object; enforce the cap for chunked bodies as well. */
export async function readJson(req, limit = 16 * 1024, { uniqueMembers=false } = {}) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '') ||
      (req.headers['content-encoding'] ?? 'identity') !== 'identity') throw new HttpError(415, 'json_required')
  const declared = req.headers['content-length']
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new HttpError(413, 'too_large')
  const chunks = []; let size = 0
  // destroyOnReturn:false lets the route send 413 before ending the connection.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, 'too_large')
    chunks.push(chunk)
  }
  let body,raw
  try { raw=new TextDecoder('utf-8', {fatal:true}).decode(Buffer.concat(chunks));body=JSON.parse(raw) }
  catch { throw new HttpError(400, 'invalid_json') }
  const nested=uniqueMembers==='deep'
  if (!body || Array.isArray(body) || typeof body !== 'object' || (uniqueMembers &&
    wireMemberCount(raw,nested)!==(nested ? parsedMemberCount(body) : Object.keys(body).length))) {
    throw new HttpError(400,'invalid_json')
  }
  return body
}
