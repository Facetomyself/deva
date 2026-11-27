import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { json as readJson } from 'node:stream/consumers'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

// pnpm --filter @deva/desktop build:headless && node --test apps/desktop/test/headless-chat.test.mjs
const bundle = process.env.DEVA_TEST_SERVER ?? fileURLToPath(new URL('../out/headless/server.mjs', import.meta.url))
const host = '127.0.0.1', model = 'fixture-chat', deadline = () => AbortSignal.timeout(8000)
const user = text => ({ role: 'user', text }), assistant = text => ({ role: 'assistant', text })
const close = server => new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()))
async function listen(server) {
  await once(server.listen(0, host), 'listening', { signal: deadline() })
  return server.address().port
}
async function* ndjson(response) {
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^application\/x-ndjson\b/)
  let tail = ''
  for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
    const lines = (tail + chunk).split('\n')
    tail = lines.pop()
    for (const line of lines) yield JSON.parse(line)
  }
  assert.equal(tail, '', 'last NDJSON frame ends with a newline')
}
async function finish(frames, text, reason) {
  const events = []
  for await (const event of frames) events.push(event)
  assert.deepEqual(events.pop(), { type: 'done', reason })
  for (const event of events) assert.deepEqual(event, { type: 'delta', text: event.text })
  assert.equal(events.map(event => event.text).join(''), text)
}

test('compiled headless chat authenticates, streams, stops and resumes stored history', { timeout: 45000 }, async t => {
  assert.ok(isAbsolute(bundle))
  const home = await mkdtemp(join(await realpath(tmpdir()), 'deva-headless-chat-')), inode = await lstat(home)
  const token = randomBytes(32).toString('base64url'), key = randomBytes(24).toString('base64url')
  const calls = [], first = [user('first question'), assistant('complete answer')]
  const stopped = [...first, user('second question'), assistant('visible partial')], third = [...stopped, user('follow-up')]
  let completeFirst, completeThird, held, child, cookie, port, origin
  const fixture = createServer(async (req, res) => {
    const call = { method: req.method, path: req.url, auth: req.headers.authorization }
    const n = calls.push(call)
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return res.writeHead(404).end()
    try {
      let input = ''
      for await (const chunk of req) input += chunk
      call.body = JSON.parse(input)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const sse = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
        id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason }]
      })}\n\n`)
      sse({ role: 'assistant', content: ['complete ', stopped[3].text, 'resumed answer'][n - 1] })
      const done = () => { sse({}, 'stop'); res.end('data: [DONE]\n\n') }
      if (n === 1) { completeFirst = () => { sse({ content: 'answer' }); done() }; return }
      if (n === 2) { held = res; return } // Leave the actual provider response open until the server aborts it.
      if (n === 3) { completeThird = done; return }
      done()
    } catch (error) { res.destroy(error) }
  })
  async function halt() {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit'), force = setTimeout(() => child.kill('SIGKILL'), 2000)
    child.kill('SIGTERM')
    try { await exited } finally { clearTimeout(force) }
  }
  t.after(async () => {
    try { await halt() } finally {
      fixture.closeAllConnections()
      if (fixture.listening) await close(fixture)
      const current = await lstat(home)
      assert.equal(await realpath(home), home)
      assert.ok(current.isDirectory() && current.dev === inode.dev && current.ino === inode.ino)
      await rm(home, { recursive: true })
    }
  })
  assert.equal(inode.mode & 0o777, 0o700)
  const upstream = `http://${host}:${await listen(fixture)}/v1`
  const request = (path, { body, headers, postOrigin = origin } = {}) => fetch(origin + path, {
    redirect: 'manual', signal: deadline(), method: body === undefined ? 'GET' : 'POST', body: JSON.stringify(body),
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(body !== undefined && postOrigin ? { Origin: postOrigin } : {}), ...headers }
  })
  async function json(path, status = 200, options) {
    const res = await request(path, options), text = await res.text()
    assert.equal(res.status, status, `${res.url} status`)
    assert.ok([token, key, upstream, home, cookie?.split('=')[1]].filter(Boolean).every(value => !text.includes(value)), `${path} exposed a private value`)
    return [JSON.parse(text), res.headers]
  }
  const error = async (path, status, code, options) => assert.deepEqual((await json(path, status, options))[0], { error: code })
  async function boot(retries = 2) {
    if (!port) {
      const reservation = createServer()
      port = await listen(reservation); await close(reservation)
    }
    origin = `http://${host}:${port}`
    const env = { HOME: home, USERPROFILE: home, DEVA_HOME: home, DEVA_HOST: host, DEVA_PORT: String(port),
      DEVA_ORIGIN: origin, DEVA_WEB_TOKEN: token, DEVA_MODEL_BASE_URL: upstream, DEVA_MODEL: model, DEVA_MODEL_API_KEY: key }
    child = spawn(process.execPath, [basename(bundle)], { cwd: dirname(bundle), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = '', spawnError
    child.on('error', e => { spawnError = e })
    for (const pipe of [child.stdout, child.stderr]) pipe.on('data', chunk => { log += chunk })
    const signal = deadline()
    while (!log.includes(`Deva Web listening on ${origin}\n`)) {
      if (child.exitCode === 1 && retries && log.includes('could not listen on the configured address')) { port = 0; return boot(retries - 1) }
      if (spawnError || child.exitCode !== null || child.signalCode !== null || signal.aborted) throw new Error(`headless CLI startup failed: ${spawnError ?? log}`)
      await delay(25)
    }
    assert.deepEqual((await json('/healthz'))[0], { ok: true })
  }
  const login = async () => {
    const [data, headers] = await json('/api/login', 200, { body: { token } }), value = headers.get('set-cookie')
    assert.deepEqual(data, { ok: true })
    assert.match(value, /;\s*HttpOnly(?:;|$)/i); assert.match(value, /;\s*SameSite=Strict(?:;|$)/i)
    const signed = value.split(';')[0]
    assert.match(signed, /^[^=;]+=[^=;]+$/)
    return signed
  }
  const sessions = '/api/sessions', archivedList = `${sessions}/archived`
  await boot()
  const web = await request('/')
  assert.equal(web.status, 200); assert.match(web.headers.get('content-type'), /^text\/html\b/)
  assert.match(await web.text(), /<script[^>]+src="\/assets\/[^"/]+\.js"/)
  await error(sessions, 401, 'auth'); await error(sessions, 401, 'auth', { body: {} })
  await error(archivedList, 401, 'auth'); await error('/api/login', 401, 'auth', { body: { token: 'wrong' } })
  cookie = await login()
  await error(sessions, 401, 'auth', { headers: { Cookie: `${cookie.split('=')[0]}=wrong` } })
  for (const options of [{ postOrigin: `http://localhost:${port}` }, { postOrigin: null }, { headers: { 'Sec-Fetch-Site': 'cross-site' } }])
    await error(sessions, 403, 'origin', { body: {}, ...options })
  await error(`${sessions}?check=1`, 404, 'missing'); await error(`${sessions}-other`, 404, 'missing')
  assert.deepEqual((await json(sessions))[0], { sessions: [], model })
  const [created] = await json(sessions, 201, { body: {} }), { id, title } = created
  assert.match(id, /^web_[0-9a-f-]{36}$/); assert.ok(typeof title === 'string' && title)
  assert.deepEqual(created, { id, title, messages: [], revision: 0, active: null })
  const session = `${sessions}/${id}`, turn = `${session}/turns`, stop = `${session}/stop`
  const state = async () => (await json(session))[0], input = (text, revision) => ({ text, revision, turnId: randomUUID() })
  const send = async body => ndjson(await request(turn, { body }))
  const rename = `${session}/title`, archive = `${session}/archive`
  const post = async (path, body, options) => (await json(path, 200, { body, ...options }))[0]
  const lists = async (active, archived = []) => {
    assert.deepEqual((await json(sessions))[0], { model, sessions: active })
    assert.deepEqual((await json(archivedList))[0], { model, sessions: archived })
  }
  const other = { headers: { Cookie: await login() } }
  assert.notEqual(other.headers.Cookie, cookie)
  const stale = (await json(session, 200, other))[0]
  assert.deepEqual(stale, created); assert.deepEqual(await state(), created)
  await lists([{ id, title }])
  const cap = `会话 ${'🙂'.repeat(48)}`, name = { title: `\t会话\r\n  ${'🙂'.repeat(49)} overflow `, revision: 0 }
  for (const [path, body] of [[rename, name], [archive, { archived: true, revision: 0 }]]) {
    await error(path, 401, 'auth', { body, headers: { Cookie: `${cookie.split('=')[0]}=wrong` } })
    await error(path, 403, 'origin', { body, postOrigin: `http://localhost:${port}` })
    await error(path, 403, 'origin', { body, headers: { 'Sec-Fetch-Site': 'cross-site' } })
    await error(path, 400, 'invalid_request', { body: { ...body, extra: true } })
  }
  const renamed = await post(rename, name)
  assert.deepEqual(renamed, { ...created, title: cap, revision: 1 })
  await error(rename, 409, 'stale', { ...other, body: { title: 'stale owner edit', revision: stale.revision } })
  await error(rename, 409, 'stale', { ...other, body: { title: cap, revision: stale.revision } })
  const empty = await post(rename, { title: '', revision: renamed.revision })
  assert.deepEqual(empty, { ...created, revision: 2 })
  const fullTitle = `${cap}界`, pinned = await post(rename, { title: fullTitle, revision: empty.revision })
  assert.deepEqual(pinned, { ...renamed, title: fullTitle, revision: 3 }); assert.equal(calls.length, 0)

  const opening = input(first[0].text, pinned.revision), openingFrames = await send(opening)
  assert.deepEqual((await openingFrames.next()).value, { type: 'delta', text: 'complete ' })
  const live = (await json(session, 200, other))[0], liveTitle = '流式中的标题'
  assert.deepEqual(live, { ...pinned, active: opening.turnId, messages: first.slice(0, 1), revision: pinned.revision + 1 })
  const liveRename = await post(rename, { title: liveTitle, revision: live.revision }, other)
  assert.deepEqual(liveRename, { ...live, title: liveTitle, revision: live.revision + 1 })
  completeFirst()
  await finish(openingFrames, 'answer', 'complete')
  const completed = await state()
  assert.deepEqual(completed, { ...liveRename, messages: first, revision: liveRename.revision + 1, active: null })

  // Wait for the CLI to accept these headers, but withhold the body until the second turn is active.
  const race = httpRequest(origin + archive, { method: 'POST', signal: deadline(), headers: {
    ...other.headers, Origin: origin, 'Content-Type': 'application/json', Expect: '100-continue'
  } })
  const continued = once(race, 'continue'), result = once(race, 'response')
  race.flushHeaders(); await continued
  const second = input(stopped[2].text, completed.revision), frames = await send(second)
  assert.deepEqual((await frames.next()).value, { type: 'delta', text: stopped[3].text })
  const inFlight = await state()
  assert.equal(inFlight.active, second.turnId)
  race.end(JSON.stringify({ archived: true, revision: inFlight.revision }))
  const [busy] = await result
  assert.equal(busy.statusCode, 409); assert.deepEqual(await readJson(busy), { error: 'busy' })
  assert.deepEqual(await state(), inFlight); assert.equal(calls.length, 2)
  const socket = held.socket
  await error(stop, 409, 'stale', { body: { turnId: randomUUID() } })
  assert.equal(socket.destroyed, false)
  const [, [ack]] = await Promise.all([once(held, 'close', { signal: deadline() }), json(stop, 200, { body: { turnId: second.turnId } })])
  assert.deepEqual(ack, { ok: true }); assert.ok(socket.destroyed && !held.writableEnded, 'upstream closed before fixture finish')
  await finish(frames, '', 'stopped')
  const saved = await state()
  assert.deepEqual(saved, { ...completed, messages: stopped, revision: completed.revision + 2 })
  await error(turn, 409, 'stale', { body: input('stale send', completed.revision) }); assert.equal(calls.length, 2)
  const file = join(home, 'data', 'chats', `${id}.json`)
  const snapshot = async path => {
    const { dev, ino, birthtimeNs, mtimeNs, ctimeNs } = await lstat(path, { bigint: true })
    return { dev, ino, birthtimeNs, mtimeNs, ctimeNs, text: await readFile(path, 'utf8') }
  }
  const before = JSON.parse((await snapshot(file)).text)
  const cleared = await post(rename, { title: ' \t\n ', revision: saved.revision })
  assert.deepEqual(cleared, { ...saved, title: first[0].text, revision: saved.revision + 1 })
  const archived = await post(archive, { archived: true, revision: cleared.revision })
  assert.deepEqual(archived, { ...cleared, archived: true, revision: cleared.revision + 1 })
  const archivedRow = { id, title: cleared.title, archived: true }
  await lists([], [archivedRow])
  const onDisk = await snapshot(file), native = JSON.parse(onDisk.text)
  assert.equal(native.archived, true)
  for (const key of ['createdAt', 'updatedAt', 'messages']) assert.deepEqual(native[key], before[key])
  await error(turn, 409, 'stale', { ...other, body: input('stale archived send', cleared.revision) })
  await error(archive, 409, 'stale', { ...other, body: { archived: true, revision: cleared.revision } })
  assert.deepEqual(await post(archive, { archived: true, revision: archived.revision }), archived)
  assert.deepEqual(await snapshot(file), onDisk); assert.equal(calls.length, 2)

  const oldCookie = cookie, legacyId = 'web_00000000-0000-4000-8000-000000000087', legacyRow = { id: legacyId, title: 'Legacy prompt' }
  const legacyFile = join(home, 'data', 'chats', `${legacyId}.json`), legacyMessages = [user(legacyRow.title), assistant('Legacy answer')]
  await halt()
  await writeFile(legacyFile, JSON.stringify({ ...legacyRow, createdAt: 1, updatedAt: 2, webText: true,
    messages: legacyMessages.map(({ role, text }) => ({ role, content: [{ type: 'text', text }] })) }), { flag: 'wx', mode: 0o600 })
  const legacyDisk = await snapshot(legacyFile)
  await boot(); await error(sessions, 401, 'auth'); cookie = await login()
  assert.notEqual(cookie, oldCookie); assert.deepEqual(await state(), archived)
  await lists([legacyRow], [archivedRow])
  const legacy = { ...legacyRow, messages: legacyMessages, revision: 2, active: null }, legacyPath = `${sessions}/${legacyId}`
  assert.deepEqual((await json(legacyPath))[0], legacy)
  assert.deepEqual(await snapshot(legacyFile), legacyDisk); assert.deepEqual(await snapshot(file), onDisk)
  const resume = input(third[4].text, archived.revision), resumed = await send(resume), finalRow = { id, title: cleared.title }
  assert.deepEqual((await resumed.next()).value, { type: 'delta', text: 'resumed answer' })
  assert.deepEqual(await state(), { ...finalRow, messages: third, revision: archived.revision + 1, active: resume.turnId })
  await lists([finalRow, legacyRow]); completeThird(); await finish(resumed, '', 'complete')
  const final = await state()
  assert.deepEqual(final, { ...finalRow, messages: [...third, assistant('resumed answer')], revision: archived.revision + 2, active: null })
  assert.deepEqual(await post(`${legacyPath}/title`, { title: '', revision: legacy.revision }), legacy)
  assert.deepEqual(await snapshot(legacyFile), legacyDisk); await lists([finalRow, legacyRow])
  const again = await post(archive, { archived: true, revision: final.revision })
  assert.deepEqual(await post(archive, { archived: false, revision: again.revision }), { ...final, revision: final.revision + 2 })
  await lists([finalRow, legacyRow])
  await halt(); assert.equal(calls.length, 3)
  for (const [i, { method, path, auth, body }] of calls.entries()) {
    assert.deepEqual({ method, path, auth }, { method: 'POST', path: '/v1/chat/completions', auth: `Bearer ${key}` })
    assert.equal(body.model, model); assert.equal(body.stream, true)
    assert.deepEqual(body.stream_options, { include_usage: true }); assert.equal(Object.hasOwn(body, 'tools'), false)
    assert.deepEqual(body.messages, [first.slice(0, 1), stopped.slice(0, 3), third][i].map(({ role, text }) => ({ role, content: text })))
  }
})
