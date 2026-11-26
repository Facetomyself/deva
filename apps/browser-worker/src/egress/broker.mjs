import { createServer, request as requestHttp } from 'node:http'
import { request as requestHttps } from 'node:https'
import { createConnection, isIP } from 'node:net'
import { pinnedAddress } from './address.mjs'
import { armTimeout, countBytes, limits, relayPeers, trackSockets } from './lifecycle.mjs'
import { sitePolicy } from './sites.mjs'
import { bindBrokerSocket, closeServer, socketPathCheck } from './unix.mjs'
import { endToEndHeaders, headerValues, requestDestination } from './wire.mjs'

const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
const phrases = { 400: 'Bad Request', 403: 'Forbidden', 405: 'Method Not Allowed', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' }
const probeHost = 'egress.invalid'

function reply(res, status) {
  if (res.destroyed || res.writableEnded) return
  if (res.headersSent) return res.destroy()
  res.shouldKeepAlive = false
  res.writeHead(status, status === 204 ? { connection: 'close' } : { connection: 'close', 'content-length': '0' })
  res.end()
}

function socketReply(socket, status) {
  if (!socket.destroyed && socket.writable) {
    socket.end(`HTTP/1.1 ${status} ${phrases[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy())
  } else socket.destroy()
}

function framing(message) {
  const lengths = headerValues(message, 'content-length')
  const encodings = headerValues(message, 'transfer-encoding')
  if (encodings.length) return encodings.length === 1 && !lengths.length && encodings[0].toLowerCase() === 'chunked' ? { chunked: true } : null
  if (lengths.length) return lengths.length === 1 && /^[0-9]+$/.test(lengths[0]) ? { length: Number(lengths[0]) } : null
  return {}
}

function operation(operations) {
  const controller = new AbortController()
  const { signal } = controller
  const finish = () => {
    if (!operations.delete(finish)) return false
    controller.abort()
    return true
  }
  operations.add(finish)
  return { signal, finish }
}

function forwardHttp(req, res, destination, privateAllowed, framingInfo, headers, expect, operations) {
  const { signal, finish } = operation(operations)
  let upstream, incoming, upload, download
  const deadline = armTimeout(() => fail(504), limits.httpMs)
  const connectDeadline = armTimeout(() => fail(504), limits.connectMs)
  const abort = () => finish()
  const clear = () => {
    clearTimeout(deadline)
    clearTimeout(connectDeadline)
    req.off('aborted', abort)
    res.off('close', abort)
    if (upload) { req.unpipe(upload); upload.destroy() }
    if (download) { incoming.unpipe(download); download.destroy() }
    upstream?.destroy()
    incoming?.destroy()
  }
  signal.addEventListener('abort', clear, { once: true })
  req.once('aborted', abort)
  req.once('error', abort)
  res.once('close', abort)
  res.once('finish', finish)
  function fail(status) {
    if (finish()) reply(res, status)
  }

  void (async () => {
    const target = await pinnedAddress(destination.hostname, privateAllowed, signal)
    if (!target) return fail(403)
    if (signal.aborted) return
    if (expect) res.writeContinue()
    const secure = destination.protocol === 'https:'
    delete headers.expect // this broker has already handled 100-continue
    headers.host = destination.host
    headers.connection = 'close'
    if (framingInfo.length !== undefined) headers['content-length'] = String(framingInfo.length)
    if (framingInfo.chunked) headers['transfer-encoding'] = 'chunked'
    upstream = (secure ? requestHttps : requestHttp)({
      host: target.address, family: target.family, port: destination.port, autoSelectFamily: false,
      agent: false, setHost: false, method: req.method, path: destination.path, headers, maxHeaderSize: limits.headers,
      ...(secure && { rejectUnauthorized: true, servername: isIP(destination.hostname) ? '' : destination.hostname }),
    }, (response) => {
      incoming = response
      response.on('error', () => fail(502))
      if (signal.aborted) return response.destroy()
      const status = response.statusCode
      const responseHeaders = endToEndHeaders(response)
      const body = framing(response)
      const noBody = req.method === 'HEAD' || status === 204 || status === 304
      if (!responseHeaders || !body || status < 200 || status > 599 || (!noBody && body.length > limits.bodyBytes)) return fail(502)
      responseHeaders.connection = 'close'
      res.shouldKeepAlive = false
      try { res.writeHead(status, responseHeaders) } catch { return fail(502) }
      response.once('close', () => { if (!response.complete) fail(502) })
      download = countBytes(limits.bodyBytes)
      download.once('error', () => fail(502))
      response.pipe(download).pipe(res)
    })
    upstream.maxHeadersCount = 0
    upstream.once('error', () => fail(502))
    upstream.once('upgrade', (_res, socket) => { socket.destroy(); fail(502) })
    upstream.once('socket', (socket) => {
      socket.once(secure ? 'secureConnect' : 'connect', () => clearTimeout(connectDeadline))
      socket.setTimeout(limits.idleMs, () => fail(504))
    })
    upload = countBytes(limits.bodyBytes)
    upload.once('error', () => fail(413))
    req.pipe(upload).pipe(upstream)
  })().catch(() => fail(502))
}

function forwardConnect(client, head, destination, privateAllowed, operations) {
  const { signal, finish } = operation(operations)
  let upstream, established = false
  const deadline = armTimeout(() => fail(504), limits.connectMs)
  const clientClosed = () => finish()
  const cleanup = () => {
    clearTimeout(deadline)
    client.off('close', clientClosed)
    upstream?.destroy()
    if (established) client.destroy()
  }
  signal.addEventListener('abort', cleanup, { once: true })
  client.once('close', clientClosed)
  function fail(status) { if (finish()) socketReply(client, status) }

  void (async () => {
    const target = await pinnedAddress(destination.hostname, privateAllowed, signal)
    if (!target) return fail(403)
    if (signal.aborted || client.destroyed) return finish()
    upstream = createConnection({ host: target.address, port: destination.port, family: target.family, autoSelectFamily: false, allowHalfOpen: true })
    const failed = () => fail(502)
    upstream.once('error', failed)
    upstream.once('connect', () => {
      if (signal.aborted || client.destroyed) return finish()
      clearTimeout(deadline)
      upstream.off('error', failed)
      established = true
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      relayPeers(client, upstream, { head, byteLimit: limits.tunnelBytes, onClose: finish })
    })
  })().catch(() => fail(502))
}

export async function startEgress({ runDir, sites, privateOrigins = [] } = {}) {
  const { registered, privateAllowed } = sitePolicy(sites, privateOrigins)
  const operations = new Set()
  const usedSockets = new WeakSet()
  let ready = false
  const server = createServer({
    maxHeaderSize: limits.headers, headersTimeout: limits.connectMs, requestTimeout: limits.httpMs,
    connectionsCheckingInterval: 1000, keepAliveTimeout: 1000,
  })
  server.maxHeadersCount = 0 // inspect every raw Host field; header bytes are still bounded
  server.setTimeout(limits.idleMs, (socket) => socket.destroy())
  const sockets = trackSockets(server)
  const firstRequest = (socket) => {
    if (usedSockets.has(socket)) { socket.destroy(); return false }
    usedSockets.add(socket)
    return true
  }
  function handleHttp(req, res, expect = false) {
    req.on('error', () => {})
    if (!firstRequest(req.socket)) return
    if (!ready) return reply(res, 503)
    const frame = framing(req)
    if (!frame) return reply(res, 400)
    if (!expect && req.method === 'OPTIONS' && req.url === '*' && frame.length === undefined && !frame.chunked) {
      const hosts = headerValues(req, 'host')
      if (hosts.length === 1 && hosts[0] === probeHost) return reply(res, 204)
    }
    const destination = requestDestination(req)
    const headers = endToEndHeaders(req)
    if (!destination || !headers) return reply(res, 400)
    if (!methods.has(req.method)) return reply(res, 405)
    if (!registered.has(destination.origin)) return reply(res, 403)
    if (frame.length > limits.bodyBytes) return reply(res, 413)
    if (operations.size >= limits.operations) return reply(res, 503)
    forwardHttp(req, res, destination, privateAllowed.has(destination.origin), frame, headers, expect, operations)
  }
  server.on('request', handleHttp)
  server.on('checkContinue', (req, res) => handleHttp(req, res, true))
  server.on('checkExpectation', (req, res) => { req.on('error', () => {}); if (firstRequest(req.socket)) reply(res, 417) })
  server.on('upgrade', (_req, socket) => { if (firstRequest(socket)) socketReply(socket, 405) })
  server.on('clientError', (error, socket) => {
    if (error.code?.startsWith('HPE_') && firstRequest(socket)) socketReply(socket, 400)
    else socket.destroy()
  })
  server.on('connect', (req, socket, head) => {
    if (!firstRequest(socket)) return
    if (!ready) return socketReply(socket, 503)
    const destination = requestDestination(req, true)
    const frame = framing(req)
    if (!destination || !frame || frame.length > 0 || frame.chunked || headerValues(req, 'expect').length) return socketReply(socket, 400)
    if (!registered.has(destination.origin)) return socketReply(socket, 403)
    if (operations.size >= limits.operations) return socketReply(socket, 503)
    forwardConnect(socket, head, destination, privateAllowed.has(destination.origin), operations)
  })
  const { socketPath, releaseDirectory } = await bindBrokerSocket(server, runDir, sockets)
  ready = true
  let closing
  const close = () => closing ??= (async () => {
    ready = false
    for (const finish of operations) finish()
    try { await closeServer(server, sockets) } finally { await releaseDirectory() }
  })()
  server.on('error', () => { void close().catch(() => {}) })
  return Object.freeze({ socketPath, close })
}

/** Private transport readiness only; makes no target request and runs no DNS lookup. */
export async function probeEgress(socketPath, { signal } = {}) {
  try { socketPathCheck(socketPath) } catch { return false }
  if (signal?.aborted) return false
  return new Promise((resolve) => {
    let settled = false
    let req
    const abort = () => done(false)
    const timer = armTimeout(abort, 1000)
    function done(result) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      req?.destroy()
      resolve(result)
    }
    try {
      req = requestHttp({ socketPath, path: '*', method: 'OPTIONS', agent: false, headers: { host: probeHost, connection: 'close' } }, (res) => {
        res.once('error', abort)
        res.once('end', () => done(res.statusCode === 204 && res.complete))
        res.resume()
      })
      signal?.addEventListener('abort', abort, { once: true })
      req.once('error', abort)
      req.end()
    } catch { done(false) }
  })
}
