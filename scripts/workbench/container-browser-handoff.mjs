#!/usr/bin/env node
// Hosted Linux/amd64 package acceptance. The three fixed images must already be
// built from this checkout. This command never builds, pulls, or adjusts the host.
// --fixture-only opens private local HTTP listeners and tests config/fixture code;
// it never calls Docker and is separate from the published package verdict.
import { randomBytes } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { request } from 'node:http'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { deflateSync } from 'node:zlib'
import { CheckFailure, check, choosePort, privateRoot } from './container-client-interactions-docker.mjs'
import { composeFiles, createSiteFile, exactPrivateOrigin, hostedDocker, repo, safeKernel, verifyInlinePrograms } from './container-browser-handoff-docker.mjs'
import { colors, field, formPath, matchesFrame, serveFixture, siteId, siteLabel, swatchX } from './container-browser-handoff-fixture.mjs'

const offline = process.argv.length === 3 && process.argv[2] === '--fixture-only'
const label = 'container-browser-handoff'
const api = '/api/v1'
const proof = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/
const privateValue = () => randomBytes(32).toString('base64url')
const zero = state => state.peerBound && !state.failure && state.nonce === null && state.documents === 0 &&
  state.posts === 0 && state.receipts === 0 && state.credentialHeaders === 0
const browserError = (value, code) => value?.error === code && Object.keys(value).length === 1
const statusKinds = new Set(['ready', 'unconfigured', 'worker-unavailable', 'egress-unavailable', 'binary-missing', 'sandbox-startup-failure'])
const interrupted = new AbortController()
let stage = 'arguments'
function step(value) {
  interrupted.signal.throwIfAborted()
  stage = value
  console.log(`${label} ${value}`)
}
function boundedRequest(port, path, { method = 'GET', headers = {}, body, timeout = 7_000 } = {}) {
  check(Number.isInteger(port) && port > 0 && port < 65536 && /^\/[A-Za-z0-9_/-]*$/.test(path), 'LOOPBACK_HTTP_SCOPE')
  return new Promise((resolve, reject) => {
    const signal = AbortSignal.any([interrupted.signal, AbortSignal.timeout(timeout)])
    const handle = request({ hostname: '127.0.0.1', port, path, method, headers, agent: false, signal }, response => {
      const chunks = []; let size = 0
      const max = response.headers['content-type'] === 'image/png' ? 4 * 1024 * 1024 : 64 * 1024
      response.on('data', chunk => {
        if ((size += chunk.length) > max) response.destroy(new CheckFailure('HTTP_RESPONSE_LIMIT'))
        else chunks.push(chunk)
      })
      response.once('error', reject)
      response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) }))
    })
    handle.once('error', reject)
    handle.end(body)
  })
}
async function until(work, code, timeout = 12_000) {
  const stopAt = performance.now() + timeout
  while (performance.now() < stopAt) {
    interrupted.signal.throwIfAborted()
    const result = await work()
    if (result) return result
    await delay(180, undefined, { signal: interrupted.signal })
  }
  throw new CheckFailure(code)
}

function http(port, origin) {
  return async (path, { auth, method = 'GET', payload, expected = 200, png = false, timeout } = {}) => {
    check(path === '/readyz' || path.startsWith(`${api}/`), 'WORKBENCH_HTTP_RESOURCE_SCOPE')
    const headers = { 'sec-fetch-site': 'same-origin' }
    if (auth?.cookie) headers.cookie = auth.cookie
    let body
    if (method === 'POST') {
      headers.origin = origin
      headers['content-type'] = 'application/json'
      if (auth?.csrf) headers['x-deva-csrf'] = auth.csrf
      body = Buffer.from(JSON.stringify(payload))
      headers['content-length'] = body.length
    }
    const r = await boundedRequest(port, path, { method, headers, body, timeout })
    const statuses = Array.isArray(expected) ? expected : [expected]
    check(statuses.includes(r.status), `TYPED_HTTP_EXPECTED_${statuses.join('_OR_')}_GOT_${r.status}`)
    if (png && r.status === 200) {
      check(r.headers['content-type'] === 'image/png' && r.headers['cross-origin-resource-policy'] === 'same-origin' &&
        r.headers['cache-control'] === 'no-store' && !r.headers['set-cookie'], 'PRIVATE_FRAME_HEADERS')
      return r
    }
    check(/^application\/json(?:;|$)/.test(r.headers['content-type'] ?? '') && r.headers['cache-control'] === 'no-store', 'TYPED_JSON_HEADERS')
    try { return { status: r.status, headers: r.headers, value: JSON.parse(r.bytes.toString('utf8')) } }
    catch { throw new CheckFailure('TYPED_JSON_INVALID') }
  }
}
function loginCookie(response) {
  const raw = response.headers['set-cookie'], parts = raw?.[0]?.split(/;\s*/)
  check(raw?.length === 1 && /^deva-workbench-local=[A-Za-z0-9_-]{32,128}$/.test(parts?.[0] ?? '') &&
    parts.includes('HttpOnly') && parts.includes('SameSite=Strict') && parts.includes('Path=/') &&
    !parts.some(p => /^domain=/i.test(p)) && proof.test(response.value?.csrf), 'MAIN_ORIGIN_COOKIE_POLICY')
  return { cookie: parts[0], csrf: response.value.csrf }
}
async function login(req, docker) {
  const password = `Hosted form ${privateValue()}`
  const claimURL = new URL(await docker.claimURL())
  check(claimURL.origin === docker.origin && claimURL.pathname === '/' && !claimURL.search &&
    !claimURL.username && !claimURL.password && /^#claim=[A-Za-z0-9_-]{32,128}$/.test(claimURL.hash), 'LOCAL_CLAIM_SCOPE')
  const owner = loginCookie(await req(`${api}/auth/claim`, { method: 'POST', payload: { credential: claimURL.hash.slice(7), password } }))
  const other = loginCookie(await req(`${api}/auth/login`, { method: 'POST', payload: { password } }))
  check(owner.cookie !== other.cookie && owner.csrf !== other.csrf, 'INDEPENDENT_LOGIN_REQUIRED')
  for (const auth of [owner, other]) {
    const { value } = await req(`${api}/bootstrap`, { auth })
    check(value?.capabilities?.browserPanel === true && value.csrf === auth.csrf, 'PACKAGED_BROWSER_CAPABILITY_MISSING')
  }
  return { owner, other }
}
async function readiness(req) {
  return (await req('/readyz', { expected: [200, 503] })).value?.status === 'ready'
}
async function status(req, auth) {
  const { value } = await req(`${api}/browser/status`, { auth, timeout: 33_000 })
  check(statusKinds.has(value?.state) && Object.keys(value).length === 1, 'TYPED_WORKER_STATUS_SCHEMA')
  return value.state
}
async function ensureIdle(req, auth, sid) {
  const { value } = await req(`${api}/chats/${sid}`, { auth })
  check(value?.state?.messages?.length === 0 && value.state.active === null && value.state.lastTurn === null,
    'HUMAN_HANDOFF_CREATED_CHAT_TURN')
}
async function tabList(req, path, auth, id, expected) {
  const { value } = await req(path, { auth })
  const tabs = value?.tabs
  check(Array.isArray(tabs) && (expected ? tabs.length === 1 && tabs[0].tabId === id && tabs[0].state === expected : tabs.length === 0), 'TAB_LIST_STATE_MISMATCH')
}
const open = (req, path, owner, expected) => req(`${path}/open`, { auth: owner, method: 'POST', payload: { siteId }, expected, timeout: 35_000 })
async function stopWorker(req, docker, owner) {
  await docker.stopWorker()
  check((await docker.scope('workbench')).controlGone, 'TYPED_WORKER_SOCKET_SURVIVED_GRACEFUL_STOP')
  check(await status(req, owner) === 'worker-unavailable' && await readiness(req), 'WORKBENCH_UNHEALTHY_AFTER_WORKER_STOP')
}
async function rejectSandbox({ req, docker, owner, path, sid, workerScope, openResult }) {
  step('live.sandbox-rejection')
  console.log(`${label} state=sandbox-startup-failure ${safeKernel(workerScope)}`)
  const denied = openResult ?? await open(req, path, owner, 503)
  check(denied.status === 503 && browserError(denied.value, 'browser_unavailable'), 'SANDBOX_REJECTION_DID_NOT_FAIL_CLOSED')
  await tabList(req, path, owner)
  check(await readiness(req) && zero(await docker.fixtureStatus()), 'SANDBOX_REJECTION_SIDE_EFFECTS')
  await ensureIdle(req, owner, sid)
  await stopWorker(req, docker, owner)
  check(zero(await docker.fixtureStatus()), 'SANDBOX_REJECTION_TARGET_ACTIVITY_AFTER_STOP')
  console.log(`${label} fail-closed evidence: authenticated open=503, /readyz=200, tabs=0, fixture GET=0 POST=0, worker stopped and socket removed`)
  throw new CheckFailure('WORKER_SANDBOX_STARTUP_FAILED')
}

async function assertDenied(post, prefix, owner, other, claim, old = false) {
  const attempt = async (auth, op, payload) => {
    const result = await post(auth, op, payload, 403)
    check(browserError(result, 'browser_denied'), `${prefix}_DENIAL_SCHEMA`)
  }
  await attempt(other, 'frame', claim)
  await attempt(other, 'input', { ...claim, seq: 1, action: { type: 'click', x: 512, y: 384 } })
  await attempt(other, 'lease', { intent: 'control', viewerNonce: privateValue() })
  if (old) {
    await attempt(owner, 'frame', claim)
    await attempt(owner, 'input', { ...claim, seq: 4, action: { type: 'click', x: 512, y: 384 } })
  }
}
async function operateForm({ req, docker, owner, other, path, sid, tabId }) {
  const post = async (auth, op, payload, expected = 200) => (await req(`${path}/${tabId}/${op}`, {
    auth, method: 'POST', payload, expected, png: op === 'frame',
  })).value
  const claim = async () => {
    const viewerNonce = privateValue()
    const lease = await post(owner, 'lease', { viewerNonce, intent: 'control' })
    check(proof.test(lease?.token) && Number.isSafeInteger(lease.ttlMs) && lease.ttlMs > 0 && lease.ttlMs <= 120_000, 'TYPED_HUMAN_LEASE_SCHEMA')
    return { viewerNonce, token: lease.token }
  }
  const state = await docker.fixtureStatus()
  check(state.peerBound && !state.failure && state.documents === 1 && state.posts === 0 && state.receipts === 0 &&
    state.credentialHeaders === 0 && state.nonce, 'BROKER_DOCUMENT_OR_COOKIE_ISOLATION')
  const getFrame = async (auth, phase) => until(async () => {
    const frame = await req(`${path}/${tabId}/frame`, { auth: owner, method: 'POST', payload: auth, png: true })
    try { return matchesFrame(frame.bytes, state.nonce, phase) } finally { frame.bytes.fill(0) }
  }, 'EXPECTED_LIVE_CHROMIUM_FRAME_MISSING', 7_000)
  const original = await docker.processes()
  check(original.profiles === 1 && original.identity?.length === 1 && /^\d+:\d+$/.test(original.identity[0]) && original.unsafe === false,
    'EXPECTED_ONE_SANDBOXED_CHROMIUM_PIPE_PROCESS')

  step('live.human-lease-and-private-form')
  const first = await claim()
  await tabList(req, path, owner, tabId, 'leased')
  await tabList(req, path, other)
  await getFrame(first, 'ready')
  await assertDenied(post, 'SECOND_LOGIN', owner, other, first)
  let seq = 0
  const input = async action => {
    seq++
    const value = await post(owner, 'input', { ...first, seq, action })
    check(value?.accepted === true && value.seq === seq, 'TYPED_INPUT_ACK')
  }
  await input({ type: 'click', x: 512, y: 384 })
  await getFrame(first, 'focused')
  await input({ type: 'text', text: field })
  await getFrame(first, 'typed')
  await input({ type: 'click', x: 512, y: 461 })
  await getFrame(first, 'done')
  const receipt = async () => {
    const observed = await docker.fixtureStatus()
    check(observed.peerBound && !observed.failure && observed.documents === 1 && observed.posts === 1 && observed.receipts === 1 &&
      observed.nonce === state.nonce && observed.credentialHeaders === 0, 'SAME_TAB_UNICODE_RECEIPT_OR_COOKIE_ISOLATION')
  }
  await receipt()

  step('live.return-and-same-tab-continuation')
  const finish = async auth => {
    const { tab } = await post(owner, 'finish', { ...auth, intent: 'done' })
    check(tab?.tabId === tabId && tab.state === 'returned', 'HANDOFF_RETURN_UNCONFIRMED')
    await tabList(req, path, owner, tabId, 'returned')
  }
  await finish(first)
  await assertDenied(post, 'STALE_LEASE', owner, other, first, true)
  // The public surface exposes pixels only while leased. Reclaim for one frame,
  // send no input, and return it again; same nonce, receipt, and worker PID/lifetime.
  const continued = await claim()
  check(continued.token !== first.token, 'OLD_CONTROL_GENERATION_REUSED')
  await getFrame(continued, 'done')
  const final = await docker.processes()
  check(final.profiles === 1 && final.identity?.length === 1 && final.identity[0] === original.identity[0] && !final.unsafe, 'RETURN_REPLACED_CHROMIUM')
  await finish(continued)
  await ensureIdle(req, owner, sid)
  await receipt()
  return receipt
}

async function hosted(docker, port) {
  step('live.prebuilt-and-isolated-fixture')
  await docker.prepare()
  step('live.checked-in-compose')
  await docker.composeCreate()
  await docker.start('init-key')
  await docker.start('browser-egress')
  await docker.start('workbench')
  await docker.start('browser-worker')
  const req = http(port, docker.origin)
  await until(async () => {
    try { return await readiness(req) }
    catch (e) { if (!['ECONNREFUSED', 'ECONNRESET'].includes(e.code)) throw e; return false }
  }, 'WORKBENCH_READY_TIMEOUT')
  await docker.scope('workbench')
  // These kernel checks run before the first typed status request (the blank Chromium probe).
  const peerScopes = await until(async () => {
    try { return [await docker.scope('browser-egress'), await docker.scope('browser-worker')] }
    catch (e) {
      if (!['BROWSER_PEER_FILE_SCOPE_MISMATCH', 'WORKER_NOT_PRIVATE_OR_NETWORKLESS'].includes(e.message)) throw e
      return false
    }
  }, 'BROWSER_PRIVATE_SOCKET_STARTUP_TIMEOUT')
  const workerScope = peerScopes[1]
  check(zero(await docker.fixtureStatus()), 'FIXTURE_TOUCHED_BEFORE_TYPED_WORKER_PROBE')

  step('live.auth-and-typed-worker-status')
  const { owner, other } = await login(req, docker)
  check(browserError((await req(`${api}/browser/status`, { expected: 401 })).value, 'auth'), 'PUBLIC_WORKER_STATUS_LEAK')
  const { session } = (await req(`${api}/chats`, { auth: owner, method: 'POST', payload: {} })).value
  const sid = session?.id
  check(typeof sid === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(sid), 'TYPED_CHAT_SCOPE_SCHEMA')
  const path = `${api}/chats/${sid}/browser`
  const { value: { sites } } = await req(`${api}/browser/sites`, { auth: owner })
  check(sites?.length === 1 && sites[0].id === siteId && sites[0].label === siteLabel && sites[0].origin === docker.fixtureOrigin() &&
    Object.keys(sites[0]).length === 3, 'TYPED_SITE_REGISTRY_SCOPE')
  const observed = await status(req, owner)
  const context = { req, docker, owner, other, path, sid, workerScope }
  if (observed === 'sandbox-startup-failure') await rejectSandbox(context)
  check(observed === 'ready', `WORKER_STATUS_${observed.toUpperCase().replaceAll('-', '_')}`)
  check(zero(await docker.fixtureStatus()), 'BLANK_SANDBOX_PROBE_CONTACTED_FORM')
  const csrf = await req(`${path}/open`, { auth: { cookie: owner.cookie }, method: 'POST', payload: { siteId }, expected: 401 })
  check(browserError(csrf.value, 'auth'), 'BROWSER_OPEN_CSRF_NOT_ENFORCED')
  const unregistered = await req(`${path}/open`, { auth: owner, method: 'POST', payload: { siteId: 'unregistered-handoff-site' }, expected: 403 })
  check(browserError(unregistered.value, 'browser_denied') && zero(await docker.fixtureStatus()), 'BROWSER_SITE_APPROVAL_NOT_ENFORCED')
  step('live.exact-site-open')
  const openResult = await open(req, path, owner, [200, 503])
  if (openResult.status === 503 && await status(req, owner) === 'sandbox-startup-failure') await rejectSandbox({ ...context, openResult })
  const tab = openResult.value?.tab
  check(openResult.status === 200 && tab?.state === 'open' && tab.sessionId === sid && tab.siteId === siteId &&
    tab.origin === docker.fixtureOrigin() && /^[A-Za-z0-9_-]{24}$/.test(tab.tabId), 'TYPED_FIXED_SITE_OPEN_FAILED')
  await tabList(req, path, owner, tab.tabId, 'open')
  const receipt = await operateForm({ ...context, tabId: tab.tabId })
  step('live.worker-stop-reaps-and-workbench-ready')
  // Keep the returned same tab live when stopping: the real worker has an owned
  // Chromium to reap. Stop also removes its shared typed socket, rather than
  // merely showing the main UI a disconnected status.
  await stopWorker(req, docker, owner)
  await receipt()
}

async function fixtureOnly(root) {
  step('fixture-only.config')
  const [main, browser] = await Promise.all(composeFiles.map(async file => {
    const path = join(repo, file)
    check(await realpath(path) === path && (await lstat(path)).isFile(), 'CHECKED_IN_COMPOSE_PATH_INVALID')
    return readFile(path, 'utf8')
  }))
  check(main.includes('user: "1000:1000"') && main.includes('read_only: true') && main.includes('cap_drop: [ALL]') &&
    browser.includes("user: '1000:1000'") && browser.includes('read_only: true') && browser.includes('cap_drop: [ALL]') &&
    main.includes('no-new-privileges:true') && browser.includes('no-new-privileges:true') &&
    /browser-egress:[\s\S]*?network_mode: bridge/.test(browser) && /browser-worker:[\s\S]*?network_mode: none/.test(browser), 'CHECKED_IN_COMPOSE_HARDENING_CHANGED')
  const site = await createSiteFile(root, exactPrivateOrigin('172.31.254.254'))
  await site.verify() // inert address only; no request is sent to it
  await verifyInlinePrograms()

  step('fixture-only.local-http-and-png')
  const quiet = await serveFixture({ host: '127.0.0.1', port: 0 })
  try {
    const denied = await boundedRequest(Number(new URL(quiet.origin).port), formPath)
    check(denied.status === 403 && quiet.snapshot().documents === 0, 'LOCAL_FIXTURE_MISSING_PEER_GUARD')
  } finally { await quiet.close() }
  const fixture = await serveFixture({ host: '127.0.0.1', port: 0, peer: '127.0.0.1' })
  try {
    const port = Number(new URL(fixture.origin).port)
    const page = await boundedRequest(port, formPath)
    const { nonce } = fixture.snapshot()
    const html = page.bytes.toString('utf8')
    check(page.status === 200 && page.headers['content-type'] === 'text/html; charset=utf-8' && !page.headers['set-cookie'] &&
      /^[a-f0-9]{24}$/.test(nonce) && html.includes(`name="nonce" value="${nonce}"`) && html.includes(field), 'LOCAL_FIXTURE_FORM_CONTRACT')
    const form = new URLSearchParams({ nonce, name: field }).toString()
    const headers = { origin: fixture.origin, 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(form) }
    const receipt = await boundedRequest(port, '/confirm', { method: 'POST', headers, body: form })
    const accepted = fixture.snapshot()
    check(receipt.status === 204 && !receipt.headers['set-cookie'] && accepted.documents === 1 && accepted.posts === 1 && accepted.receipts === 1 &&
      accepted.nonce === nonce && !accepted.failure && accepted.credentialHeaders === 0, 'LOCAL_FIXTURE_RECEIPT_CONTRACT')
    check((await boundedRequest(port, '/confirm', { method: 'POST', headers, body: form })).status === 400 && fixture.snapshot().receipts === 1,
      'LOCAL_FIXTURE_DUPLICATE_RECEIPT_ACCEPTED')
    check((await boundedRequest(port, formPath, { headers: { cookie: 'fixture-isolation-check=1' } })).status === 400 &&
      fixture.snapshot().credentialHeaders === 1, 'LOCAL_FIXTURE_FAILED_TO_DETECT_COOKIE')
    const sample = samplePng(nonce)
    check(matchesFrame(sample, nonce, 'done') && !matchesFrame(sample, nonce, 'ready'), 'LOCAL_PNG_PHASE_CHECK')
  } finally { await fixture.close() }
}

function samplePng(nonce) {
  // Reference byte-only PNG stream used only to exercise the sampling decoder;
  // no synthetic frame can reach the real acceptance branch.
  const header = Buffer.alloc(13); header.writeUInt32BE(1024, 0); header.writeUInt32BE(768, 4); header[8] = 8; header[9] = 2
  const stride = 1024 * 3 + 1, bytes = Buffer.alloc(stride * 768), nonceBytes = Buffer.from(nonce, 'hex')
  const rgb = [colors.done, ...Array.from({ length: 4 }, (_, i) => [...nonceBytes.subarray(i * 3, i * 3 + 3)])]
  rgb.forEach((color, i) => Buffer.from(color).copy(bytes, stride * 20 + 1 + 3 * swatchX(i)))
  const chunk = (name, buf) => {
    const out = Buffer.alloc(12 + buf.length); out.writeUInt32BE(buf.length); out.write(name, 4); buf.copy(out, 8)
    let crc = -1
    for (const b of out.subarray(4, -4)) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)) }
    out.writeUInt32BE((~crc) >>> 0, out.length - 4)
    return out
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(bytes)), chunk('IEND', Buffer.alloc(0))])
}

let root, docker, failed = false
const stop = () => interrupted.abort()
process.once('SIGINT', stop); process.once('SIGTERM', stop)
try {
  check(offline || process.argv.length === 2, 'USAGE_NODE_CONTAINER_BROWSER_HANDOFF_OPTIONAL_FIXTURE_ONLY')
  check(offline || (process.platform === 'linux' && process.arch === 'x64'), 'HOST_LINUX_AMD64_REQUIRED')
  root = await privateRoot()
  if (offline) await fixtureOnly(root.path)
  else {
    const port = await choosePort()
    docker = hostedDocker(root.path, port)
    await hosted(docker, port)
    interrupted.signal.throwIfAborted()
  }
} catch (error) {
  failed = true
  const code = interrupted.signal.aborted ? 'INTERRUPTED' : error instanceof CheckFailure && /^[A-Z0-9_-]+$/.test(error.message) ? error.message : 'UNEXPECTED_FAILURE'
  console.error(`${label} FAIL ${stage} ${code}`)
} finally {
  if (docker) {
    try {
      if (await docker.cleanup()) console.log(`${label} cleanup verified: exact project containers, network and volumes removed`)
    } catch {
      failed = true
      console.error(`${label} FAIL cleanup EXACT_DOCKER_RESOURCE_CLEANUP_UNCONFIRMED`)
    }
  }
  if (root) {
    try {
      await root.remove()
      check(await lstat(root.path).then(() => false, e => e.code === 'ENOENT'), 'TEMP_ROOT_SURVIVED')
      console.log(`${label} cleanup verified: private temp root removed`)
    } catch {
      failed = true
      console.error(`${label} FAIL cleanup PRIVATE_TEMP_ROOT_CLEANUP_UNCONFIRMED`)
    }
  }
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop)
}
if (failed || interrupted.signal.aborted) process.exitCode = 1
else if (offline) console.log(`${label} FIXTURE_ONLY_PASS: checked-in config, private site file, local receipt, credential and PNG checks; real Docker/Chromium not run`)
else console.log(`${label} LIVE_PASS: packaged authenticated manual form, nonce-bound PNG and receipt, second-login denial, same-tab return, worker teardown`)
