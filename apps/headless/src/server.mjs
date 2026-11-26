import { createServer } from 'node:http'
import { isIP } from 'node:net'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import pkg from '../package.json' with { type: 'json' }
import { createAuthService } from './auth/index.mjs'
import { startControl } from './control/socket.mjs'
import { httpPolicy, HttpError, json } from './http/policy.mjs'
import { sessionRoutes } from './http/session-routes.mjs'
import { openStaticWorkbench } from './http/static-workbench.mjs'
import { acquireWriterLock } from './runtime/writer-lock.mjs'
import { openVault } from './storage/vault.mjs'

export const DEFAULT_DATA_DIR = join(homedir(), '.deva-headless')
export const DEFAULT_WEB_DIR = fileURLToPath(new URL('../../desktop/out/workbench', import.meta.url))
export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 8787
const DEFAULT_SHUTDOWN_MS = 8_000

export function workbenchPath(value, label) {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) throw Error(`${label} needs a filesystem path`)
  return resolve(value)
}

export function workbenchPolicy(publicUrl, host, port) {
  if (publicUrl !== undefined) return httpPolicy(publicUrl)
  const authority = isIP(host) === 6 ? `[${host}]` : host
  return httpPolicy(`http://${authority}:${port}`)
}

function inside(parent, child) {
  const rel = relative(parent, child)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

function options(opts) {
  const dataDir = workbenchPath(opts.dataDir ?? DEFAULT_DATA_DIR, 'Data directory')
  const keyFile = workbenchPath(opts.keyFile, 'Master key file')
  const runDir = workbenchPath(opts.runDir ?? join(dataDir, 'run'), 'Run directory')
  const webDir = workbenchPath(opts.webDir ?? DEFAULT_WEB_DIR, 'Web directory')
  const host = opts.host ?? DEFAULT_HOST
  const port = opts.port ?? DEFAULT_PORT
  const version = opts.version ?? pkg.version
  const shutdownTimeoutMs = opts.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_MS
  if (inside(webDir, keyFile) || [dataDir, runDir].some(dir => inside(dir, webDir) || inside(webDir, dir))) {
    throw Error('Web directory must be separate from private runtime paths')
  }
  if (typeof host !== 'string' || !(isIP(host) || host === 'localhost')) throw Error('Bind host must be an IP address or localhost')
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('Port must be an integer from 0 to 65535')
  if (typeof version !== 'string' || !version || !Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 0 || shutdownTimeoutMs > 60_000) {
    throw Error('Invalid workbench server options')
  }
  // Validate the origin before opening persistent state. Port 0 resolves to an
  // actual listen port before the server dispatches its first request.
  const policy = workbenchPolicy(opts.publicUrl, host, port || DEFAULT_PORT)
  return { dataDir, keyFile, runDir, webDir, host, port, version, shutdownTimeoutMs, policy }
}

function listen(server, host, port) {
  return new Promise((resolveListen, reject) => {
    const failure = error => {
      server.off('listening', ready)
      reject(error)
    }
    const ready = () => {
      server.off('error', failure)
      resolveListen()
    }
    server.once('error', failure)
    server.once('listening', ready)
    server.listen({ host, port })
  })
}

function readTarget(req) {
  const target = req.url ?? ''
  const path = target.split('?', 1)[0]
  if (!path.startsWith('/') || /[\\%#\x00-\x20\x7f]/.test(path) || path.includes('//') || path.split('/').some(part => part === '.' || part === '..')) {
    throw new HttpError(400, 'invalid_path')
  }
  return path
}

function controlHealth(req, res, body, code) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    json(res, 405, { error: 'method' }, { allow: 'GET, HEAD', connection: 'close' })
  } else {
    json(res, code, body)
  }
}

function dispatcher({ auth, policy, version, business, web, isReady }) {
  const sessions = sessionRoutes({ auth, policy, version, getConfig: () => business.getConfig(), capabilities: business.capabilities })
  const context = Object.freeze({ auth, policy })
  return async (req, res) => {
    const readOnly = req.method === 'GET' || req.method === 'HEAD'
    try {
      if ((req.headersDistinct.host?.length ?? 0) !== 1 || (req.headersDistinct.origin?.length ?? 0) > 1) {
        throw new HttpError(403, 'origin')
      }
      policy.check(req)
      const path = readTarget(req)
      if (path === '/livez' || path === '/readyz' || path === '/healthz') {
        if (req.url !== path) throw new HttpError(400, 'unexpected_query')
        const live = path === '/livez'
        const ready = live || (readOnly && await isReady() && await web.ready() && await isReady())
        controlHealth(req, res, { status: live ? 'alive' : ready ? 'ready' : 'not_ready' }, ready ? 200 : 503)
      } else if (path === '/api' || path.startsWith('/api/')) {
        if (await sessions(req, res)) return
        policy.check(req, !readOnly)
        if (!await business.handle(req, res, context)) {
          json(res, 404, { error: 'not_found' }, readOnly ? {} : { connection: 'close' })
        }
      } else if (!await web.handle(req, res, path)) {
        json(res, 404, { error: 'not_found' }, readOnly ? {} : { connection: 'close' })
      }
    } catch (error) {
      if (!res.headersSent && !res.destroyed) {
        const known = error instanceof HttpError
        const status = known ? error.status : error?.code === 'AUTH_FAILED' ? 401 : 500
        json(res, status, { error: known ? error.code : status === 401 ? 'auth' : 'internal' },
          readOnly ? {} : { connection: 'close' })
      } else if (!res.writableEnded) {
        res.destroy()
      }
    }
  }
}

function closeHttp(server, sockets, timeout) {
  if (!server?.listening) return Promise.resolve()
  return new Promise((resolveClose, reject) => {
    const timer = setTimeout(() => {
      for (const socket of sockets) socket.destroy()
    }, timeout)
    timer.unref()
    server.close(error => {
      clearTimeout(timer)
      if (error) reject(error)
      else resolveClose()
    })
    server.closeIdleConnections()
  })
}

/** Run one volume writer, auth service, private control endpoint, and same-origin HTTP host. */
export async function startWorkbench(opts = {}) {
  const { dataDir, keyFile, runDir, webDir, host, port, version, shutdownTimeoutMs, policy } = options(opts)
  let releaseLock, business, control, server, realtime, closing, dispatch
  let stage = 'writer lock'
  const sockets = new Set()
  const active = new Set()

  function close() {
    return closing ??= (async () => {
      const results = await Promise.allSettled([
        closeHttp(server, sockets, shutdownTimeoutMs),
        Promise.resolve().then(() => realtime?.close()),
        Promise.resolve().then(() => control?.close())
      ])
      try {
        // Aborting a connection does not cancel an in-flight database/owner write.
        // Retain the lock until each handler and the business service have drained.
        await Promise.allSettled(active)
        await business?.close?.()
        if (results.some(result => result.status === 'rejected')) throw Error('Workbench listener shutdown failed')
      } finally {
        releaseLock?.()
      }
    })()
  }

  try {
    releaseLock = acquireWriterLock(dataDir)
    stage = 'vault'
    const vault = await openVault({ dataDir, keyFile })
    stage = 'authentication'
    const auth = await createAuthService({ dataDir })
    stage = 'business service'
    const openBusiness = opts.businessFactory ?? (await import('./business/handlers.mjs')).openBusiness
    business = await openBusiness({ ...opts.businessOptions, dataDir, vault, version, privateRoots: [dataDir, keyFile, runDir, webDir] })
    if (typeof business?.getConfig !== 'function' || typeof business.handle !== 'function' || typeof business.close !== 'function') {
      throw TypeError('Invalid workbench business service')
    }
    stage = 'web assets'
    const web = await openStaticWorkbench(webDir)
    stage = 'local control'
    control = await startControl({ runDir, auth })
    stage = 'HTTP listener'
    server = createServer({ headersTimeout: 15_000, requestTimeout: 60_000, requireHostHeader: true }, (req, res) => {
      if (!dispatch || closing) {
        json(res, 503, { error: 'not_ready' }, { connection: 'close' })
        return
      }
      const work = dispatch(req, res)
      active.add(work)
      work.then(() => active.delete(work), () => { active.delete(work); res.destroy() })
    })
    server.on('connection', socket => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
    server.on('upgrade', (req, socket, head) => {
      try {
        if (closing || !realtime || (req.headersDistinct.host?.length ?? 0) !== 1 ||
            (req.headersDistinct.origin?.length ?? 0) !== 1 || !realtime.upgrade(req, socket, head)) socket.destroy()
      } catch { socket.destroy() }
    })
    await listen(server, host, port)
    server.on('error', () => { void close().catch(() => {}) })
    const address = Object.freeze(server.address())
    const activePolicy = port === 0 && opts.publicUrl === undefined ? workbenchPolicy(undefined, host, address.port) : policy
    realtime = business.createRealtime?.({ auth, policy: activePolicy })
    dispatch = dispatcher({ auth, policy: activePolicy, version, business, web, isReady: () => server.listening && !closing })
    return Object.freeze({ address, origin: activePolicy.origin, controlPath: control.path, close })
  } catch (error) {
    await close().catch(() => {})
    throw new Error(`Workbench startup failed (${stage})`, { cause: error })
  }
}
