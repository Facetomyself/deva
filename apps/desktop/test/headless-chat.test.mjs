import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { lstat, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { json as readJson } from 'node:stream/consumers'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { assertCall, gateway, modelStream, protocols, route } from './headless-model-wire.mjs'

// pnpm --filter @deva/desktop build:headless && node --test apps/desktop/test/headless-chat.test.mjs
const bundle = process.env.DEVA_TEST_SERVER ?? fileURLToPath(new URL('../out/headless/server.mjs', import.meta.url))
const host = '127.0.0.1', model = 'fixture-chat', deadline = () => AbortSignal.timeout(8000)
const user = (text, attachment) => ({ role: 'user', text, ...(attachment === undefined ? {} : { attachment }) })
const assistant = text => ({ role: 'assistant', text })
const fallback = '请理解并处理上述附件。'
const textPart = text => ({ type: 'text', text })
const attachmentFrame = ({ name, text }) => `[附件文件] ${name}\n\`\`\`\n${text}\n\`\`\``
const nativeMessages = messages => messages.map(({ role, text, attachment }) => ({ role, content: attachment
  ? [textPart(attachmentFrame(attachment)), text ? textPart(text) : { ...textPart(fallback), display: '' }]
  : [textPart(text)] }))
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
async function finish(frames, text, terminal) {
  const events = []
  for await (const event of frames) events.push(event)
  assert.deepEqual(events.pop(), typeof terminal === 'string' ? { type: 'done', reason: terminal } : terminal)
  for (const event of events) assert.deepEqual(event, { type: 'delta', text: event.text })
  assert.equal(events.map(event => event.text).join(''), text)
}

const operatorEnv = (home, origin, port, token, upstream, key, protocol) => ({
  HOME: home, USERPROFILE: home, DEVA_HOME: home, DEVA_HOST: host, DEVA_PORT: String(port), DEVA_ORIGIN: origin,
  DEVA_WEB_TOKEN: token, DEVA_MODEL_BASE_URL: upstream, DEVA_MODEL: model, DEVA_MODEL_API_KEY: key,
  ...(protocol === undefined ? {} : { DEVA_MODEL_PROTOCOL: protocol })
})
function launch(env, guard) {
  const preloader = `data:text/javascript,${encodeURIComponent(guard)}`
  const child = spawn(process.execPath, ['--import', preloader, basename(bundle)], { cwd: dirname(bundle), env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = '', spawnError
  child.on('error', e => { spawnError = e })
  for (const pipe of [child.stdout, child.stderr]) pipe.on('data', chunk => { log += chunk })
  return { child, log: () => log, failure: () => spawnError }
}
async function halt(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit'), force = setTimeout(() => child.kill('SIGKILL'), 2000)
  child.kill('SIGTERM')
  try { await exited } finally { clearTimeout(force) }
}

for (const protocol of Object.keys(protocols)) test(`compiled headless ${protocol} authenticates, streams, stops and resumes stored history`, { timeout: 45000 }, async t => {
  assert.ok(isAbsolute(bundle))
  const home = await mkdtemp(join(await realpath(tmpdir()), 'deva-headless-chat-')), inode = await lstat(home)
  const token = randomBytes(32).toString('base64url'), key = randomBytes(24).toString('base64url')
  const attachment = { name: '会议笔记.MD', text: '\ufeff# 午后 🙂\r\n\t```text\r\n[附件文件] 嵌套.txt\r\n```\r\n保留结尾 \r\n' }
  const literal = attachmentFrame({ name: 'literal.txt', text: 'A typed question that looks like a file.' })
  const calls = [], first = [user('first question', attachment), assistant('complete answer')]
  const stopped = [...first, user(literal), assistant('visible partial')], third = [...stopped, user('follow-up')]
  const modern = protocol !== 'openai', resumedText = modern ? 'resumed answer 🙂' : 'resumed answer'
  const runs = [], cookies = []
  let completeFirst, completeThird, held, ending, edge, child, cookie, port, origin
  const fixture = createServer(async (req, res) => {
    const call = { method: req.method, path: req.url, headers: req.headers }
    const n = calls.push(call)
    if (req.method !== 'POST' || req.url !== route(protocol)) return res.writeHead(404).end()
    try {
      call.body = await readJson(req)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const wire = modelStream(res, protocol, model)
      if (n === 1) {
        completeFirst = async () => { await wire.delta('answer'); wire.terminal(); res.end() }
        return await wire.delta('complete ')
      }
      if (n === 2) { held = res; return await wire.delta(stopped[3].text) } // Held until Stop aborts it.
      if (n === 3) {
        ending = res
        completeThird = () => { wire.terminal(); if (!modern) res.end() }
        return await wire.delta(resumedText, modern)
      }
      if (!edge) return res.end()
      const { write, text } = edge
      edge.release = async () => { await write(wire, res); res.end() }
      if (text) await wire.delta(text)
      else await edge.release()
    } catch (error) { res.destroy(error) }
  })
  t.after(async () => {
    try { await halt(child) } finally {
      fixture.closeAllConnections()
      if (fixture.listening) await close(fixture)
      const current = await lstat(home)
      assert.equal(await realpath(home), home)
      assert.ok(current.isDirectory() && current.dev === inode.dev && current.ino === inode.ino)
      await rm(home, { recursive: true })
    }
  })
  assert.equal(inode.mode & 0o777, 0o700)
  const upstreamOrigin = `http://${host}:${await listen(fixture)}`, upstream = upstreamOrigin + gateway(protocol)
  // Keep real loopback traffic and native storage; flag any attempt to resolve the bogus attachment sources.
  const bait = join(home, 'fixture-unexpected-read.txt')
  const guard = `import fs from 'node:fs';
  import { syncBuiltinESMExports } from 'node:module';
  for (const [api, names] of [[fs, ['readFile', 'readFileSync', 'open', 'openSync', 'createReadStream']], [fs.promises, ['readFile', 'open']]]) {
    for (const name of names) { const original = api[name]; api[name] = function(path, ...args) {
      if (path === 0 || String(path).includes('fixture-unexpected-read.txt') || String(path).endsWith('/dev/stdin')) {
        console.error('unexpected attachment read'); throw Error('fixture only');
      }
      return original.call(this, path, ...args);
    }; }
  }
  syncBuiltinESMExports();
  const nativeFetch = globalThis.fetch; globalThis.fetch = (input, init) => {
    if (new URL(input instanceof Request ? input.url : input).origin === ${JSON.stringify(upstreamOrigin)}) return nativeFetch(input, init);
    console.error('unexpected non-fixture fetch'); throw Error('fixture only');
  }`
  const request = (path, { body, headers, postOrigin = origin } = {}) => fetch(origin + path, {
    redirect: 'manual', signal: deadline(), method: body === undefined ? 'GET' : 'POST',
    body: Buffer.isBuffer(body) ? body : JSON.stringify(body),
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
  async function boot(restart = false, retries = 2) {
    if (!port) {
      const reservation = createServer()
      port = await listen(reservation); await close(reservation)
    }
    origin = `http://${host}:${port}`
    const base = upstream + (protocol === 'anthropic' ? (restart ? '/v1/' : '/') : '/v1')
    const env = operatorEnv(home, origin, port, token, base, key, modern || restart ? protocol : undefined)
    const run = launch(env, guard)
    child = run.child; runs.push(run)
    const signal = deadline()
    while (!run.log().includes(`Deva Web listening on ${origin}\n`)) {
      if (child.exitCode === 1 && retries && run.log().includes('could not listen on the configured address')) { port = 0; return boot(restart, retries - 1) }
      if (run.failure() || child.exitCode !== null || child.signalCode !== null || signal.aborted) throw new Error(`headless CLI startup failed: ${run.failure() ?? run.log()}`)
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
    cookies.push(signed)
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
  const state = async () => (await json(session))[0]
  const input = (text, revision, attachment) => ({ text, revision, turnId: randomUUID(), ...(attachment === undefined ? {} : { attachment }) })
  const send = async (body, path = turn) => ndjson(await request(path, { body }))
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

  const opening = input(`\t ${first[0].text}\r\n`, pinned.revision, attachment)
  const file = join(home, 'data', 'chats', `${id}.json`)
  const snapshot = async path => {
    const { dev, ino, birthtimeNs, mtimeNs, ctimeNs } = await lstat(path, { bigint: true })
    return { dev, ino, birthtimeNs, mtimeNs, ctimeNs, text: await readFile(path, 'utf8') }
  }
  const pinnedDisk = await snapshot(file)
  if (!modern) await t.test('project documents stay closed on default startup', async () => {
    const docs = '/api/project-docs'
    const projectDocument = { generation: randomBytes(16).toString('hex'), document: randomBytes(16).toString('hex') }
    const detail = `${docs}/${projectDocument.generation}/${projectDocument.document}`
    const anonymous = { headers: { Cookie: '' } }, wrongOrigin = `http://localhost:${port}`
    const beforeCalls = calls.length
    // A synthetic file exists on disk; its presence is not an operator grant.
    await writeFile(bait, 'fixture-only project document\n', { flag: 'wx', mode: 0o600 })
    const originalFile = await snapshot(bait)
    for (const path of [docs, detail]) {
      await error(path, 401, 'auth', anonymous)
      await error(path, 404, 'missing')
      await error(path, 403, 'origin', { headers: { Origin: wrongOrigin } })
    }
    await error(`${docs}?check=1`, 404, 'missing', anonymous)
    const grant = { body: { path: bait } }
    await error(docs, 404, 'missing', grant) // Signed-in, correct-origin POST.
    await error(docs, 403, 'origin', { ...grant, postOrigin: wrongOrigin })
    await error(docs, 403, 'origin', { ...grant, postOrigin: null })
    await error(docs, 403, 'origin', { ...grant, headers: { 'Sec-Fetch-Site': 'cross-site' } })
    // The unmodified opening body streams successfully below in this same CLI process.
    await error(turn, 400, 'invalid_request', { body: { ...opening, projectDocument } })
    assert.equal(calls.length, beforeCalls, 'project-document probes made no model request')
    assert.deepEqual(await state(), pinned, 'session revision and messages stayed unchanged')
    assert.deepEqual(await snapshot(file), pinnedDisk, 'native session file stayed unchanged')
    assert.deepEqual(await snapshot(bait), originalFile, 'the fixture document stayed unchanged')
  })
  await error(turn, 401, 'auth', { body: opening, headers: { Cookie: '' } })
  for (const options of [{ postOrigin: `http://localhost:${port}` }, { postOrigin: null }, { headers: { 'Sec-Fetch-Site': 'cross-site' } }])
    await error(turn, 403, 'origin', { body: opening, ...options })
  for (const body of [input(first[0].text, pinned.revision), opening]) {
    for (const override of [{ protocol: 'responses' }, { endpoint: upstream + '/browser-endpoint' },
      { baseURL: upstream + '/browser-base' }, { model: 'browser-model' }]) {
      await error(turn, 400, 'invalid_request', { body: { ...body, ...override } })
    }
  }
  assert.deepEqual(await state(), pinned); assert.deepEqual(await snapshot(file), pinnedDisk); assert.equal(calls.length, 0)
  const openingFrames = await send(opening)
  assert.deepEqual((await openingFrames.next()).value, { type: 'delta', text: 'complete ' })
  const live = (await json(session, 200, other))[0], liveTitle = '流式中的标题'
  assert.deepEqual(live, { ...pinned, active: opening.turnId, messages: first.slice(0, 1), revision: pinned.revision + 1 })
  const liveRename = await post(rename, { title: liveTitle, revision: live.revision }, other)
  assert.deepEqual(liveRename, { ...live, title: liveTitle, revision: live.revision + 1 })
  await completeFirst()
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
  const savedDisk = await snapshot(file), before = JSON.parse(savedDisk.text)
  assert.deepEqual(before.messages, nativeMessages(stopped))
  await error(turn, 409, 'stale', { body: input('stale send', completed.revision) })
  await error(turn, 409, 'stale', { body: input('stale attachment', completed.revision, attachment) })
  assert.deepEqual(await state(), saved); assert.deepEqual(await snapshot(file), savedDisk); assert.equal(calls.length, 2)
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
  await error(turn, 409, 'stale', { ...other, body: input('', cleared.revision, attachment) })
  await error(archive, 409, 'stale', { ...other, body: { archived: true, revision: cleared.revision } })
  assert.deepEqual(await post(archive, { archived: true, revision: archived.revision }), archived)
  assert.deepEqual(await snapshot(file), onDisk); assert.equal(calls.length, 2)

  const oldCookie = cookie, legacyId = 'web_00000000-0000-4000-8000-000000000087', legacyRow = { id: legacyId, title: 'Legacy prompt' }
  const legacyFile = join(home, 'data', 'chats', `${legacyId}.json`), legacyMessages = [user(legacyRow.title), assistant('Legacy answer')]
  await halt(child)
  await writeFile(legacyFile, JSON.stringify({ ...legacyRow, createdAt: 1, updatedAt: 2, webText: true,
    messages: legacyMessages.map(({ role, text }) => ({ role, content: [{ type: 'text', text }] })) }), { flag: 'wx', mode: 0o600 })
  const legacyDisk = await snapshot(legacyFile)
  await boot(true); await error(sessions, 401, 'auth')
  await error(session, 401, 'auth', { headers: { Cookie: oldCookie } }); cookie = await login()
  assert.notEqual(cookie, oldCookie); assert.deepEqual(await state(), archived)
  await lists([legacyRow], [archivedRow])
  const legacy = { ...legacyRow, messages: legacyMessages, revision: 2, active: null }, legacyPath = `${sessions}/${legacyId}`
  assert.deepEqual((await json(legacyPath))[0], legacy)
  assert.deepEqual(await snapshot(legacyFile), legacyDisk); assert.deepEqual(await snapshot(file), onDisk)
  const resume = input(third[4].text, archived.revision), resumed = await send(resume), finalRow = { id, title: cleared.title }
  assert.deepEqual((await resumed.next()).value, { type: 'delta', text: resumedText })
  assert.deepEqual(await state(), { ...finalRow, messages: third, revision: archived.revision + 1, active: resume.turnId })
  await lists([finalRow, legacyRow])
  if (modern) {
    const providerClosed = once(ending, 'close')
    completeThird()
    await Promise.race([Promise.all([finish(resumed, '', 'complete'), providerClosed]),
      delay(2000, undefined, { ref: false }).then(() => assert.fail('native terminal waited for upstream HTTP EOF'))])
    assert.equal(ending.writableEnded, false, 'fixture never ended the native terminal response')
  } else {
    completeThird(); await finish(resumed, '', 'complete')
  }
  const final = await state()
  assert.deepEqual(final, { ...finalRow, messages: [...third, assistant(resumedText)], revision: archived.revision + 2, active: null })
  assert.deepEqual(await post(`${legacyPath}/title`, { title: '', revision: legacy.revision }), legacy)
  assert.deepEqual(await snapshot(legacyFile), legacyDisk); await lists([finalRow, legacyRow])
  const again = await post(archive, { archived: true, revision: final.revision })
  assert.deepEqual(await post(archive, { archived: false, revision: again.revision }), { ...final, revision: final.revision + 2 })
  await lists([finalRow, legacyRow]); assert.equal(calls.length, 3)
  const expected = [first.slice(0, 1), stopped.slice(0, 3), third]
  if (modern) {
    const privateText = ['fixture-private-marker', token, key, upstream, home, cookie].join(' ')
    const otherProtocol = protocol === 'responses' ? 'anthropic' : 'responses'
    const cases = [
      ['EOF after text', 'upstream', () => {}],
      ['bare [DONE] after text', 'upstream', wire => wire.done()],
      ['native output token limit', 'limit', wire => wire.terminal(true)],
      ['native tool item', 'upstream', wire => wire.tool()],
      ['mismatched named terminal', 'upstream', wire => wire.mismatchedTerminal()],
      ['incomplete native result presented as complete', 'upstream', wire => wire.inconsistent()],
      ...(protocol === 'responses' ? [['unsolicited item only in the final response', 'upstream', wire => wire.finalAction()]] : []),
      ['in-band provider error stays opaque', 'upstream', wire => wire.error(privateText)],
      ['foreign event family', 'upstream', async (_, res) => {
        const foreign = modelStream(res, otherProtocol, model)
        await foreign.delta('foreign text'); foreign.terminal()
      }],
      ['SSE wire budget before native terminal', 'upstream', (wire, res) => {
        const comment = `: ${'a'.repeat(8192)}\r\n\r\n`
        for (let i = 0; i < 129; i++) res.write(comment)
        wire.terminal()
      }],
      ['private thinking without visible text', 'upstream', wire => wire.thought(privateText), ''],
      ['only whitespace before native completion', 'upstream', wire => wire.terminal(), ' \t ']
    ]
    let previous = await state()
    for (const [name, code, write, text = 'safe partial'] of cases) await t.test(name, async () => {
      const body = input(name, previous.revision)
      edge = { text, write }
      const history = [...previous.messages, user(name)]
      expected.push(history)
      const frames = await send(body)
      if (text) {
        assert.deepEqual((await frames.next()).value, { type: 'delta', text })
        await edge.release()
      }
      await finish(frames, '', { type: 'error', error: code })
      edge = undefined
      const messages = text.trim() ? [...history, assistant(text)] : history
      const saved = await state()
      assert.deepEqual(saved, { ...previous, messages, active: null, revision: previous.revision + (text.trim() ? 2 : 1) })
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).messages, nativeMessages(messages))
      assert.equal(calls.length, expected.length, 'one provider POST and no automatic retries')
      previous = saved
    })
  }
  if (!modern) await t.test('file-only title, exact input bounds and inert attachment sources', async () => {
    let [previous] = await json(sessions, 201, { body: {} })
    const fileSession = `${sessions}/${previous.id}`, fileTurn = `${fileSession}/turns`
    const storage = join(home, 'data', 'chats', `${previous.id}.json`)
    const full = { name: '资料.txt', text: '记\t\r\n'.repeat(5461) + 'ab' }
    const draft = input('', previous.revision, full)
    assert.equal(Buffer.byteLength(full.text), 32768)
    const pristine = await snapshot(storage), beforeCalls = calls.length
    for (const invalid of [null, [], {}, { name: full.name }, { name: full.name, text: 1 },
      { ...attachment, path: bait }, { path: bait }, { path: '/dev/stdin' },
      { url: `${upstream}/unexpected`, text: 'inline text' }, { ...attachment, endpoint: `${upstream}/unexpected` }]) {
      await error(fileTurn, 400, 'invalid_request', { body: { ...draft, attachment: invalid } })
    }
    for (const name of [bait, '/dev/stdin', '../notes.txt', 'a/b.md', 'a\\b.md', '.notes.md', ' notes.md', 'notes.md ',
      'a:notes.md', 'bad\tname.txt', 'bidi\u202e.md', '\ud800.md', 'notes.json', `${'界'.repeat(42)}.md`]) {
      await error(fileTurn, 400, 'invalid_request', { body: { ...draft, attachment: { name, text: 'note' } } })
    }
    for (const text of ['', 'a\0b', 'a\u000bb', 'a\u001bb', 'bad\ud800', 'bad\udfff']) {
      await error(fileTurn, 400, 'invalid_request', { body: { ...draft, attachment: { name: full.name, text } } })
    }
    const badUtf8 = JSON.stringify({ ...draft, attachment: { name: 'notes.txt', text: '\xff' } })
    await error(fileTurn, 400, 'invalid_request', { body: Buffer.from(badUtf8, 'latin1') })
    await error(fileTurn, 400, 'invalid_request', { body: input(' \t\r\n ', previous.revision) })
    await error(fileTurn, 413, 'limit', { body: { ...draft, attachment: { ...full, text: full.text + 'x' } } })
    const maxQuestion = '界'.repeat(2730) + 'ab'
    for (const item of [undefined, attachment]) {
      await error(fileTurn, 413, 'limit', { body: input(maxQuestion + 'x', previous.revision, item) })
    }
    assert.deepEqual((await json(fileSession))[0], previous)
    assert.deepEqual(await snapshot(storage), pristine); assert.equal(calls.length, beforeCalls)

    const row = { id: previous.id, title: full.name }
    async function accept(text, item, display = text) {
      const body = input(text, previous.revision, item)
      const history = [...previous.messages, user(display, item)]
      expected.push(history)
      edge = { text: 'ok', write: wire => wire.terminal() }
      const frames = await send(body, fileTurn)
      assert.deepEqual((await frames.next()).value, { type: 'delta', text: 'ok' })
      const live = { ...row, messages: history, revision: previous.revision + 1, active: body.turnId }
      assert.deepEqual((await json(fileSession))[0], live)
      await edge.release()
      await finish(frames, '', 'complete')
      edge = undefined
      previous = { ...live, messages: [...history, assistant('ok')], revision: live.revision + 1, active: null }
      assert.deepEqual((await json(fileSession))[0], previous)
      assert.deepEqual(JSON.parse(await readFile(storage, 'utf8')).messages, nativeMessages(previous.messages))
      assert.equal(calls.length, expected.length)
    }
    await accept(' \t\r\n ', full, '')
    await lists([row, finalRow, legacyRow])
    await accept(fallback, { ...full, name: `${'界'.repeat(41)}a.txt` }) // The name is exactly 128 UTF-8 bytes.
    // Escaped JSON is over 64 KiB even though both decoded fields fit their byte caps.
    await accept(maxQuestion, { ...full, text: '\t'.repeat(32767) + 'x' })
    for (let i = 0; i < 2; i++) await accept('next note', full)

    const used = nativeMessages(previous.messages).flatMap(m => m.content).reduce((sum, part) => sum + Buffer.byteLength(part.text), 0)
    const question = 'at the budget', remaining = (256 - 64) * 1024 - used - Buffer.byteLength(attachmentFrame({ ...full, text: '' }) + question)
    assert.ok(remaining > 0 && remaining < 32768)
    const text = 'x'.repeat(remaining), atBudget = await snapshot(storage)
    await halt(child); await boot(true); cookie = await login()
    assert.deepEqual((await json(fileSession))[0], previous); assert.deepEqual(await snapshot(storage), atBudget)
    await lists([row, finalRow, legacyRow])
    await error(fileTurn, 413, 'limit', { body: input(question, previous.revision, { ...full, text: text + 'x' }) })
    assert.deepEqual((await json(fileSession))[0], previous)
    assert.deepEqual(await snapshot(storage), atBudget); assert.equal(calls.length, expected.length)
    await accept(question, { ...full, text })
  })
  await halt(child)
  assert.equal(calls.length, expected.length, 'only generation requests reached the fixture')
  for (const [i, call] of calls.entries()) assertCall(call, protocol, model, key, nativeMessages(expected[i]))
  const outgoing = JSON.stringify(calls)
  for (const secret of [token, ...cookies.map(value => value.split('=')[1])])
    assert.ok(!outgoing.includes(secret), 'owner credential reached the provider')
  assert.ok(!outgoing.includes(home) && !outgoing.includes('/dev/stdin'), 'local file path reached the provider')
  assert.ok(runs.every(run => !/unexpected (?:non-fixture fetch|attachment read)/.test(run.log())), 'unexpected I/O')
})

test('invalid headless protocol exits before binding or creating a volume', { timeout: 45000 }, async t => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'deva-headless-config-')), inode = await lstat(home)
  t.after(async () => {
    const current = await lstat(home)
    assert.equal(await realpath(home), home)
    assert.ok(current.isDirectory() && current.dev === inode.dev && current.ino === inode.ino)
    await rm(home, { recursive: true })
  })
  const volume = join(home, 'new-volume'), port = 8787, origin = `http://${host}:${port}`, key = randomBytes(24).toString('base64url')
  const token = randomBytes(32).toString('base64url'), upstream = 'http://127.0.0.1:9/gw/config/v1'
  const guard = `import { Server } from 'node:net'; Server.prototype.listen = () => {
    console.error('unexpected listener'); throw Error('fixture only');
  }; globalThis.fetch = () => { console.error('unexpected fetch'); throw Error('fixture only'); };`
  for (const invalid of ['Responses', 'constructor', '', `bogus-${key}`]) {
    const run = launch(operatorEnv(volume, origin, port, token, upstream, key, invalid), guard)
    let result
    try { result = await once(run.child, 'close', { signal: deadline() }) } finally { await halt(run.child) }
    assert.deepEqual(result, [1, null])
    assert.match(run.log(), /^Invalid DEVA_MODEL_PROTOCOL(?: \(openai, responses, or anthropic\))?\n$/)
    assert.deepEqual(await readdir(home), [])
  }
})
