// PR18 browser gate: non-root native Linux, built Vite Workbench and headless cores,
// genuine matching Chrome/ChromeDriver via webdriver-local.mjs. Prepare with
// `pnpm --filter @deva/headless build` and `pnpm workbench:build`; the native store
// needs Linux /proc and its flock/metadata helpers. No Docker or external provider
// is needed. `--fixture-only` starts the same business service without Chrome or Vite.
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual as equal } from 'node:util'
import { requestControl } from '../../apps/headless/src/control/socket.mjs'
import { DEFAULT_WEB_DIR, startWorkbench } from '../../apps/headless/src/server.mjs'
import { authenticateStatus, captureDirectory, exactUsage, readNativeMarker, verifyStatusInChrome } from './e2e-conversation-status-browser.mjs'
import { alternate, buildPrerequisites, chatPath, check, configureModels, endpoint, modelRef, primary, privateFixture,
  prompts, replies, scopedRequest, startStatusModel, StatusCheckError } from './e2e-conversation-status-fixture.mjs'
import { observeStatusWire } from './e2e-conversation-status-wire.mjs'
import { startLocalWebDriver, waitFor, WebDriverError } from './webdriver-local.mjs'

async function openListObserver(origin, cookie, signal) {
  const require = createRequire(new URL('../../apps/headless/src/events/websocket.mjs', import.meta.url))
  const { WebSocket } = require('ws')
  const peer = new WebSocket(`${origin.replace(/^http:/, 'ws:')}/api/v1/chats/stream`, { origin, headers: { cookie },
    handshakeTimeout: 3000, maxPayload: 512, perMessageDeflate: false })
  const pending = []
  let fault
  peer.on('error', () => { fault = 'Authorized fixture list WebSocket failed' })
  peer.on('close', () => { fault ??= 'Authorized fixture list WebSocket closed early' })
  peer.on('message', (bytes, binary) => {
    if (binary || pending.length >= 32) { fault = 'Unexpected session-list frame'; return }
    try { pending.push(JSON.parse(bytes)) } catch { fault = 'Invalid session-list frame' }
  })
  let cursor
  return {
    async next(type) {
      const row = await waitFor(() => { check(!fault, fault); return pending.shift() }, 'scoped session-list frame over its original native socket', { signal })
      const c = row?.cursor
      check(equal(Object.keys(row).sort(), ['cursor', 't']) && row.t === type && c?.scope === 'sessions' &&
        equal(Object.keys(c).sort(), ['epoch', 'generation', 'scope', 'seq']) && Number.isSafeInteger(c.seq) &&
        typeof c.epoch === 'string' && typeof c.generation === 'string' &&
        (!cursor || (cursor.epoch === c.epoch && cursor.generation === c.generation && c.seq > cursor.seq)),
      'Session invalidation was not cursor-only, scoped or on the same monotonic stream')
      cursor = c
    },
    close() { peer.terminate() }
  }
}

async function checkFixtureOnly(resources, fixture, signal, stage) {
  const { app: { origin }, upstream } = resources
  const api = (path, options) => scopedRequest(origin, path, signal, options)
  const authPath = '/api/v1/auth'
  const password = randomBytes(24).toString('base64url')
  const { credential } = await requestControl({ runDir: fixture.runDir, op: 'claim' })
  const first = await api(`${authPath}/claim`, { method: 'POST', body: { credential, password } })
  const second = await api(`${authPath}/login`, { method: 'POST', body: { password } })
  check(first.status === 200 && second.status === 200 && first.cookie && second.cookie && first.cookie !== second.cookie &&
    first.body.csrf && second.body.csrf && first.body.csrf !== second.body.csrf, 'Two real independent owner HTTP sessions were not established')
  const client = (who, path, method = 'GET', body, csrf = who.body.csrf) => api(path, { method, body, cookie: who.cookie, csrf })
  const anonymous = await api(endpoint)
  check(anonymous.status === 401, `Owner read map should require authentication; got HTTP ${anonymous.status}`)
  const id = randomUUID(), route = chatPath(id)
  const created = await client(first, '/api/v1/chats', 'POST', { sessionId: id })
  check(created.status === 200 && created.body?.session?.id === id, 'Real synthetic chat fixture was not created')
  const usage = async (model, ref, source) => {
    const result = await client(first, `${route}/context-usage`, 'POST', { model })
    check(result.status === 200, `Real ${source} metadata failed at HTTP ${result.status}`)
    exactUsage(result.body, ref, source)
  }
  await usage(null, modelRef(primary), 'none')
  upstream.assertCount(0)

  stage('exercise real loopback SSE, durable token measurement and authorized read snapshots without Chrome')
  const sent = await client(first, `${route}/turns`, 'POST', { clientRequestId: randomUUID(), text: prompts[0], model: null })
  check(sent.status === 202, `Real fixture turn failed at HTTP ${sent.status}`)
  const turn = await upstream.expect(1)
  const during = await client(first, route)
  check(during.status === 200 && during.body.state.active, 'Real fixture did not expose the active turn')
  turn.complete()
  const completed = await waitFor(async () => {
    const result = await client(second, route)
    return result.status === 200 && result.body.state.lastTurn?.status === 'completed' && result.body.state.messages?.at(-1)?.content === replies[0] && result.body
  }, 'native durable fixture assistant reply', { signal })
  await usage(null, modelRef(primary), 'measured')
  await usage(modelRef('unknown-fixture'), null, 'unavailable')
  check((await readNativeMarker(fixture, id)).at === null, 'Reply or metadata read marked an unattended chat read')
  const unread = await client(second, endpoint)
  check(unread.status === 200 && unread.body.entries.some(row => row.id === id && row.updatedAt === completed.state.updatedAt && row.readAt === null && row.unread),
    'Authorized read state did not expose the unattended fixture reply as unread')

  const peer = resources.peer = await openListObserver(origin, second.cookie, signal)
  await peer.next('sessions-snapshot')
  const token = { cursor: completed.cursor, updatedAt: completed.state.updatedAt }
  check((await client(first, `${route}/read-state`, 'POST', token, second.body.csrf)).status === 401,
    'Read command did not require the matching session CSRF')
  const stale = await client(first, `${route}/read-state`, 'POST', { cursor: during.body.cursor, updatedAt: during.body.state.updatedAt })
  check(stale.status === 409 && stale.body?.error === 'read_view_stale' && (await readNativeMarker(fixture, id)).at === null,
    'Captured earlier streaming snapshot could mark the newer response read')
  const read = await client(first, `${route}/read-state`, 'POST', token)
  check(read.status === 200 && read.body.changed === true && read.body.unread === false && read.body.readAt === token.updatedAt,
    'Real read command did not persist only the captured fixture snapshot')
  const native = await readNativeMarker(fixture, id)
  check(native.at === read.body.readAt, 'Real stored read timestamp did not match the authorized read response')
  await peer.next('sessions-changed')
  const synced = await client(second, endpoint)
  check(synced.status === 200 && synced.body.entries.some(row => row.id === id && row.readAt === native.at && !row.unread),
    'Second owner on the original stream did not obtain the authoritative read')
  const duplicate = await client(first, `${route}/read-state`, 'POST', token)
  check(duplicate.status === 200 && duplicate.body.changed === false && equal(await readNativeMarker(fixture, id), native),
    'Same snapshot replaced the native marker or emitted a second read commit')
  const preference = await client(first, `${route}/preferences`)
  check(preference.status === 200 && (await client(first, `${route}/preferences`, 'PATCH', {
    revision: preference.body.revision, set: { model: modelRef(alternate) }
  })).status === 200, 'Synthetic fixture model change did not commit')
  await usage(modelRef(alternate), modelRef(alternate), 'estimate')
  upstream.assertCount(1)
  return { realLoopbackModelCalls: 1, measuredPercent: 25, unavailableClearsUsage: true, cursorOnlyScopedInvalidation: true,
    distinctOwnerSessions: true, realNativeReadTimestamp: true, sameSnapshotNoOp: true }
}

export async function runConversationStatus({ fixtureOnly = false, startBrowser = startLocalWebDriver, stage: onStage = () => {}, captureBase,
  captures = process.env.DEVA_QA_STATUS_CAPTURE === '1' } = {}) {
  const stop = new AbortController()
  const abort = () => stop.abort()
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(150_000)])
  const resources = { browsers: [] }
  let phase = 'validate Linux and built prerequisites', result, capture, failure
  const stage = next => { phase = next; signal.throwIfAborted(); onStage(next) }
  const detail = error => error instanceof StatusCheckError || error instanceof WebDriverError ? error.message :
    /^E[A-Z0-9_]+$/.test(error?.code ?? '') ? `system error ${error.code} (raw diagnostics withheld)` : 'unexpected error (raw diagnostics withheld)'
  try {
    stage(phase)
    check(process.platform === 'linux' && process.getuid?.() > 0 && process.geteuid?.() > 0, 'Use ordinary native Linux UID')
    await buildPrerequisites(fixtureOnly ? undefined : DEFAULT_WEB_DIR)
    stage('start real headless Workbench with sterile native data, vault, and loopback provider')
    const fixture = resources.fixture = await privateFixture()
    const upstream = resources.upstream = await startStatusModel(signal)
    await configureModels(fixture, upstream)
    const { dataDir, keyFile, runDir, workspaceRoot, root, staticDir } = fixture
    const app = resources.app = await startWorkbench({ host: '127.0.0.1', port: 0, webDir: fixtureOnly ? staticDir : DEFAULT_WEB_DIR,
      dataDir, keyFile, runDir, businessOptions: { workspaceRoot, allowedOrigins: [upstream.origin] } })
    check(app.address.address === '127.0.0.1' && app.origin === `http://127.0.0.1:${app.address.port}` &&
      (await scopedRequest(app.origin, '/readyz', signal)).status === 200, 'Real synthetic Workbench did not bind only its ready loopback listener')
    if (fixtureOnly) result = await checkFixtureOnly(resources, fixture, signal, stage)
    else {
      const wire = resources.wire = observeStatusWire(app, signal)
      const password = randomBytes(24).toString('base64url')
      const { credential } = await requestControl({ runDir, op: 'claim' })
      async function profile(label, claim) {
        stage(`open fresh private profile ${label} and authenticate via real owner UI`)
        const profile = join(root, label)
        await mkdir(profile, { mode: 0o700 })
        const browser = await startBrowser({ root, profile, origin: app.origin, signal, password })
        resources.browsers.push(browser)
        const ctx = { origin: app.origin, fixture, browser, signal, wire, upstream, openList: owner => wire.openList(owner, openListObserver) }
        await authenticateStatus(ctx, password, claim)
        return ctx
      }
      const first = await profile('chrome-owner-one', credential)
      check((await requestControl({ runDir, op: 'status' })).claimed === true, 'Real Workbench owner claim did not persist')
      const second = await profile('chrome-owner-two')
      if (captures) capture = await captureDirectory(captureBase)
      result = await verifyStatusInChrome(first, second, stage, capture?.save)
    }
  } catch (error) { failure = `${phase}: ${signal.aborted ? 'interrupted or timed out' : detail(error)}` }
  finally {
    for (const [name, action] of [
      ['browser profiles', async () => {
        const cleanup = await Promise.allSettled(resources.browsers.map(browser => browser.close()))
        check(cleanup.every(entry => entry.status === 'fulfilled'), 'At least one browser failed to close')
      }], ['list socket', () => resources.peer?.close()], ['business service', () => resources.app?.close()],
      ['final request guards', () => { if (!failure) { resources.wire?.assertSound(); resources.upstream?.assertCount(fixtureOnly ? 1 : 2) } }],
      ['wire observer', () => resources.wire?.close()], ['loopback provider', () => resources.upstream?.close()],
      ['private disk root', () => resources.fixture?.close()]
    ]) {
      try { await action() } catch (error) { failure = [failure, `cleanup ${name}: ${detail(error)}`].filter(Boolean).join('; ') }
    }
    process.removeListener('SIGINT', abort)
    process.removeListener('SIGTERM', abort)
  }
  if (failure || signal.aborted) throw new StatusCheckError(failure ?? 'interrupted or timed out')
  return { ...result, ...(capture && { captures: capture.path }) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  if (args.length && !(args.length === 1 && args[0] === '--fixture-only')) {
    console.error('Usage: node scripts/workbench/e2e-conversation-status.mjs [--fixture-only]')
    process.exitCode = 1
  } else {
    const fixtureOnly = args.length === 1
    try {
      const receipt = await runConversationStatus({ fixtureOnly, stage: phase => console.log(`STAGE: ${phase}`) })
      console.log(`${fixtureOnly ? 'Fixture-only (Chrome was not used)' : 'W3C WebDriver Workbench browser E2E'} PASS: ${JSON.stringify(receipt)}`)
    } catch (error) {
      console.error(`Conversation-status E2E failed: ${error.message}`)
      process.exitCode = 1
    }
  }
}
