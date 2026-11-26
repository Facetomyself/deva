import { lookup } from 'node:dns/promises'
import { request as http } from 'node:http'
import { request as https } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { Readable, Transform, pipeline } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'

// Only for the server's configured model provider. This is not a network proxy or a client URL fetch API.
const privateV4 = new BlockList(); const excludedV4 = new BlockList(); const privateV6 = new BlockList()
const globalV6 = new BlockList(); const excludedV6 = new BlockList()
for (const [ip, bits] of [['10.0.0.0', 8], ['127.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10]]) privateV4.addSubnet(ip, bits)
for (const [ip, bits] of [['0.0.0.0', 8], ['169.254.0.0', 16], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) excludedV4.addSubnet(ip, bits)
privateV6.addAddress('::1', 'ipv6'); privateV6.addSubnet('fc00::', 7, 'ipv6')
globalV6.addSubnet('2000::', 3, 'ipv6')
for (const [ip, bits] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) excludedV6.addSubnet(ip, bits, 'ipv6')

function denied() { return Object.assign(new Error('Model destination is not permitted'), { code: 'ERR_PROVIDER_EGRESS' }) }
function validAddress(address, privateAllowed) {
  if (address.includes('%')) return false
  if (isIP(address) === 4) return !excludedV4.check(address) && (!privateV4.check(address) || privateAllowed)
  if (isIP(address) !== 6) return false
  return (privateAllowed && privateV6.check(address, 'ipv6')) || (globalV6.check(address, 'ipv6') && !excludedV6.check(address, 'ipv6'))
}

export function allowedModelOrigins(raw = []) {
  const parts = typeof raw === 'string' ? raw.split(',').map((s) => s.trim()).filter(Boolean) : raw
  if (!Array.isArray(parts) || parts.length > 64) throw Error('Invalid model origin list')
  return new Set(parts.map((s) => {
    const u = new URL(s)
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw Error('Expected exact model origin')
    return u.origin
  }))
}

const forbiddenHeaders = new Set(['cookie', 'cookie2', 'set-cookie', 'proxy-authorization', 'proxy-connection', 'connection', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'accept-encoding', 'forwarded', 'trailer', 'te'])
function wireHeaders(input, configuredCookie) {
  const out = Object.create(null)
  for (const [name, value] of new Headers(input)) if (!forbiddenHeaders.has(name) && !name.startsWith('x-forwarded-')) out[name] = value
  // Only the cookie separately obtained from this provider's bound vault entry is eligible.
  // In particular a caller's Cookie header is discarded above, never inherited from the Web session.
  if (configuredCookie) out.cookie = configuredCookie
  out['accept-encoding'] = 'gzip, deflate, br'
  return out
}

const decoder = { gzip: createGunzip, deflate: createInflate, br: createBrotliDecompress }
function webResponse(res, maxBytes) {
  const status = res.statusCode
  if (!status || status < 200 || status > 599) { res.destroy(); throw Error('Invalid model response status') }
  // Never follow an HTTP redirect with the first provider's authorization or custom headers.
  if (status >= 300 && status < 400) { res.destroy(); throw denied() }
  const headers = new Headers()
  for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string' && !['set-cookie', 'content-encoding', 'content-length'].includes(k)) headers.set(k, v)
  if (status === 204 || status === 205) { res.resume(); return new Response(null, { status, headers }) }
  const encoding = String(res.headers['content-encoding'] ?? 'identity').trim().toLowerCase()
  if (encoding !== 'identity' && !Object.hasOwn(decoder, encoding)) { res.destroy(); throw Error('Unsupported model response encoding') }
  let count = 0
  const bounded = new Transform({ transform(chunk, _enc, cb) {
    count += chunk.length
    if (count > maxBytes) cb(Error('Model response exceeds size limit'))
    else cb(null, chunk)
  } })
  const streams = encoding === 'identity' ? [res, bounded] : [res, decoder[encoding](), bounded]
  pipeline(streams, () => {}) // all stream errors are observable by the Response reader; cancellation tears down the upstream
  return new Response(Readable.toWeb(bounded), { status, headers })
}

/** Resolve once per request and pin the address passed to http(s).request. Public HTTPS is the
 * normal path; an operator must explicitly list each private/loopback model origin. There is no
 * fallback to global agents, system proxies, redirects or an unfiltered second lookup. */
export function providerFetch({ baseURL, allowedOrigins = [], resolveHost = lookup, maxBytes = 32 * 1024 * 1024, configuredCookie }) {
  if (configuredCookie !== undefined && (typeof configuredCookie !== 'string' || configuredCookie.length > 8192 || !/^[\t\x20-\x7e]*$/.test(configuredCookie))) throw denied()
  const base = new URL(baseURL)
  const allow = allowedModelOrigins(allowedOrigins)
  const privateAllowed = allow.has(base.origin)
  if (base.username || base.password || base.search || base.hash || !['http:', 'https:'].includes(base.protocol) || (base.protocol === 'http:' && !privateAllowed)) throw denied()
  return async (input, init = {}) => {
    const url = new URL(input)
    if (url.origin !== base.origin || url.username || url.password || url.hash) throw denied()
    const method = (init.method || 'GET').toUpperCase()
    if (!['GET', 'POST'].includes(method) || (init.body != null && typeof init.body !== 'string')) throw denied()
    init.signal?.throwIfAborted()
    const name = url.hostname.replace(/^\[|\]$/g, '')
    const family = isIP(name)
    // Bound both the DNS wait and connection setup, including an operator-supplied resolver
    // that ignores AbortSignal. Do not leave listeners registered on a long-lived session.
    const records = family ? [{ address: name, family }] : await new Promise((ok, fail) => {
      const timer = setTimeout(() => finish(fail, Error('Model DNS resolution timed out')), 10000)
      timer.unref()
      const aborted = () => finish(fail, init.signal.reason ?? Error('Model request aborted'))
      let finished = false
      function finish(settle, value) {
        if (finished) return
        finished = true; clearTimeout(timer); init.signal?.removeEventListener('abort', aborted); settle(value)
      }
      init.signal?.addEventListener('abort', aborted, { once: true })
      if (init.signal?.aborted) return aborted()
      Promise.resolve().then(() => resolveHost(name, { all: true, verbatim: true })).then((r) => finish(ok, r), (e) => finish(fail, e))
    })
    if (!Array.isArray(records) || !records.length || !records.every((r) => r.family === isIP(r.address) && validAddress(r.address, privateAllowed))) throw denied()
    init.signal?.throwIfAborted()
    const address = records[0]
    return new Promise((ok, fail) => {
      const req = (url.protocol === 'https:' ? https : http)(url, {
        agent: false, method, headers: wireHeaders(init.headers, configuredCookie), signal: init.signal,
        family: address.family, autoSelectFamily: false,
        lookup: (_hostname, options, cb) => options.all ? cb(null, [address]) : cb(null, address.address, address.family)
      }, (res) => {
        clearTimeout(deadline)
        try { ok(webResponse(res, maxBytes)) } catch (err) { fail(err) }
      })
      const deadline = setTimeout(() => req.destroy(Error('Model response headers timed out')), 15000)
      deadline.unref()
      req.setTimeout(90000, () => req.destroy(Error('Model stream timed out')))
      req.once('error', (err) => { clearTimeout(deadline); fail(err) })
      req.once('close', () => clearTimeout(deadline))
      req.end(init.body ?? undefined)
    })
  }
}
