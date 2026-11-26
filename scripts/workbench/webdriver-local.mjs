import { spawn } from 'node:child_process'
import { request } from 'node:http'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'

const loopback = '127.0.0.1'
const resultLimit = 256 * 1024
const elementKey = 'element-6066-11e4-a52e-4f735466cecf'
const knownErrors = new Set([
  'element click intercepted', 'element not interactable', 'invalid argument', 'invalid session id',
  'javascript error', 'no such element', 'no such window', 'script timeout', 'session not created',
  'stale element reference', 'timeout', 'unknown command', 'unknown error', 'unsupported operation'
])

export class WebDriverError extends Error {
  constructor(operation, detail) {
    super(`${operation}: ${detail}`)
    this.detail = detail
  }
}

// This transport has no proxy, discovery, redirects, or externally supplied endpoint. Driver
// messages and request bodies can contain secrets, so only fixed command names and codes leave it.
function command(port, operation, method, path, payload, timeout, signal) {
  return new Promise((resolve, reject) => {
    const failure = detail => reject(new WebDriverError(operation, detail))
    const body = payload === undefined ? undefined : JSON.stringify(payload)
    const req = request({
      hostname: loopback, port, method, path, agent: false,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
      headers: body === undefined ? {} : { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) }
    }, res => {
      const chunks = []
      let size = 0
      res.once('error', () => failure('response interrupted'))
      res.on('data', chunk => {
        size += chunk.length
        if (size <= resultLimit) chunks.push(chunk)
        else { failure('response too large'); res.destroy() }
      })
      res.once('end', () => {
        let reply
        try { reply = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return failure('invalid response') }
        if (reply === null || typeof reply !== 'object' || !Object.hasOwn(reply, 'value')) return failure('invalid W3C response')
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(reply.value)
        else failure(knownErrors.has(reply.value?.error) ? reply.value.error : `HTTP ${res.statusCode}`)
      })
    })
    req.once('error', e => failure(e.code === 'ABORT_ERR' ? 'interrupted or timed out' : 'local connection failed'))
    req.end(body)
  })
}

function driverPort(child, signal) {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout })
    const timeout = setTimeout(() => finish(reject, new WebDriverError('start ChromeDriver', 'startup timed out')), 10_000)
    const exited = () => finish(reject, new WebDriverError('start ChromeDriver', 'process exited before listening'))
    const failed = error => finish(reject, new WebDriverError('start ChromeDriver',
      error.code === 'ENOENT' ? 'binary missing (set CHROMEDRIVER_BIN)' : 'process launch failed'))
    const interrupted = () => finish(reject, new WebDriverError('start ChromeDriver', 'interrupted'))
    function finish(settle, value) {
      clearTimeout(timeout)
      child.off('exit', exited)
      child.off('error', failed)
      signal?.removeEventListener('abort', interrupted)
      lines.close()
      child.stdout.resume() // Discard all subsequent output, including unexpected diagnostics.
      settle(value)
    }
    child.once('exit', exited)
    child.once('error', failed)
    signal?.addEventListener('abort', interrupted, { once: true })
    lines.on('line', line => {
      const port = Number(/^ChromeDriver was started successfully on port (\d+)\.?$/.exec(line.trim())?.[1])
      if (port > 0 && port <= 65535) finish(resolve, port)
    })
    if (signal?.aborted) interrupted()
  })
}

function chromeOptions(profile, binary) {
  return {
    ...(binary ? { binary } : {}),
    args: [
      '--headless', '--window-size=1280,1000', `--user-data-dir=${profile}`,
      '--remote-debugging-pipe', '--lang=en-US', '--no-first-run', '--no-default-browser-check',
      '--no-proxy-server', '--disable-background-networking', '--disable-sync', '--disable-component-update',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
    ],
    prefs: {
      'intl.accept_languages': 'en-US,en',
      'credentials_enable_service': false,
      'profile.password_manager_enabled': false
    }
  }
}

function sessionClient(port, sessionId, origin, signal, shutdown) {
  const base = `/session/${sessionId}`
  const send = (name, method, path, body) => command(port, name, method, base + path, body, 22_000, signal)
  function elementPath(element) {
    const id = element?.[elementKey]
    if (typeof id !== 'string' || !id || id.length > 256) throw new WebDriverError('select element', 'invalid element reference')
    return `/element/${encodeURIComponent(id)}`
  }
  return {
    navigate(url) {
      const target = new URL(url)
      if (target.origin !== origin || target.username || target.password) throw new WebDriverError('navigate', 'non-workbench URL')
      return send('navigate', 'POST', '/url', { url: target.href })
    },
    refresh: () => send('refresh', 'POST', '/refresh', {}),
    execute: (script, ...args) => send('observe page', 'POST', '/execute/sync', { script, args }),
    executeAsync: (script, ...args) => send('observe page asynchronously', 'POST', '/execute/async', { script, args }),
    click: element => send('click element', 'POST', `${elementPath(element)}/click`, {}),
    keys: (element, text) => send('enter text', 'POST', `${elementPath(element)}/value`, { text }),
    close: shutdown
  }
}

/** Start one local-only ChromeDriver (default loopback binding) and one sandboxed Chrome session. */
export async function startLocalWebDriver({ root, profile, origin, signal }) {
  if (process.platform !== 'linux' || !process.getuid?.() || !process.geteuid?.()) {
    throw new WebDriverError('start ChromeDriver', 'run on Linux as a non-root user')
  }
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new WebDriverError('start ChromeDriver', 'invalid workbench origin')
  const driver = process.env.CHROMEDRIVER_BIN || (process.env.CHROMEWEBDRIVER
    ? join(process.env.CHROMEWEBDRIVER, 'chromedriver') : 'chromedriver')
  const child = spawn(driver, ['--port=0'], {
    cwd: root, detached: true, stdio: ['ignore', 'pipe', 'ignore'],
    env: { HOME: root, TMPDIR: root, PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' }
  })
  // Keep draining output on the stdio pipe and handle errors after the startup listener is removed.
  child.on('error', () => {})
  child.stdout.on('error', () => {})
  const exited = new Promise(resolve => {
    child.once('exit', resolve)
    child.once('error', resolve)
  })
  let port, sessionId, closing
  function signalGroup(name) {
    if (!child.pid) return
    try { process.kill(-child.pid, name) } catch (error) {
      if (error.code !== 'ESRCH') throw new WebDriverError('stop ChromeDriver', 'process group cleanup failed')
    }
  }
  function shutdown() {
    return closing ??= (async () => {
      try {
        if (sessionId) await command(port, 'close browser', 'DELETE', `/session/${sessionId}`, undefined, 5_000)
      } finally {
        signalGroup('SIGTERM')
        await Promise.race([exited, delay(2_000, undefined, { ref: false })])
        if (child.exitCode === null && child.signalCode === null && child.pid) {
          signalGroup('SIGKILL')
          await exited
        }
        child.stdout.destroy()
      }
    })()
  }
  try {
    port = await driverPort(child, signal)
    const status = await command(port, 'check ChromeDriver', 'GET', '/status', undefined, 3_000, signal)
    if (status?.ready !== true) throw new WebDriverError('check ChromeDriver', 'driver is not ready')
    const created = await command(port, 'start Chrome', 'POST', '/session', {
      capabilities: { alwaysMatch: {
        browserName: 'chrome', pageLoadStrategy: 'eager', timeouts: { implicit: 0, pageLoad: 18_000, script: 6_000 },
        'goog:chromeOptions': chromeOptions(profile, process.env.CHROME_BIN)
      } }
    }, 45_000, signal)
    if (typeof created?.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(created.sessionId)) {
      throw new WebDriverError('start Chrome', 'invalid W3C session')
    }
    sessionId = created.sessionId
    return sessionClient(port, sessionId, origin, signal, shutdown)
  } catch (error) {
    await shutdown().catch(() => {})
    throw error
  }
}

export async function waitFor(probe, description, { timeout = 12_000, interval = 100, signal } = {}) {
  const deadline = performance.now() + timeout
  do {
    signal?.throwIfAborted()
    const result = await probe()
    if (result) return result
    const remaining = deadline - performance.now()
    if (remaining > 0) await delay(Math.min(remaining, interval), undefined, { signal })
  } while (performance.now() < deadline)
  throw new WebDriverError('wait for UI', description)
}
