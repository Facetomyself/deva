// The fixed probe is passed to `docker exec node --eval`, never mounted or installed.
// In the local fixture the same logic runs against a scratch CLI and ephemeral loopback ports.
export const providerOrigin = 'http://127.0.0.1:18787'

export async function startModel(port) {
  const { createServer } = await import('node:http')
  const { once } = await import('node:events')
  const key = 'container-status-synthetic-provider-key', model = 'fixture-primary'
  const question = 'Synthetic container context question.', answer = 'Synthetic container context reply.'
  const used = 2345
  let calls = 0, failures = 0
  const server = createServer((req, res) => {
    calls++
    void (async () => {
      if (calls !== 1 || req.method !== 'POST' || req.url !== '/v1/chat/completions' ||
          req.headers.authorization !== `Bearer ${key}` || req.headersDistinct.authorization?.length !== 1 || req.headers.cookie) throw Error()
      const chunks = []; let length = 0
      for await (const chunk of req) { length += chunk.length; if (length > 32_768) throw Error(); chunks.push(chunk) }
      const body = JSON.parse(Buffer.concat(chunks).toString())
      const user = body.messages?.filter(item => item.role === 'user')
      if (!body.stream || body.model !== model || user?.length !== 1 || user[0].content !== question || body.tools?.length || body.functions?.length) throw Error()
      const chunk = (delta, finish_reason = null) => ({ id: 'chatcmpl-container-status', object: 'chat.completion.chunk',
        created: 1, model, choices: [{ index: 0, delta, finish_reason }] })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const frames = [chunk({ content: answer }), chunk({}, 'stop'), {
        ...chunk({}), choices: [], usage: { prompt_tokens: used, completion_tokens: 7, total_tokens: used + 7 }
      }]
      res.end(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n')
    })().catch(() => { failures++; if (!res.headersSent) res.writeHead(400).end(); else res.destroy() })
  })
  server.listen(port, '127.0.0.1')
  await once(server, 'listening')
  return { origin: `http://127.0.0.1:${server.address().port}`, key, model, used, question, answer,
    expectCalls: count => calls === count && failures === 0,
    close() {
      const closed = once(server, 'close')
      server.close(); server.closeAllConnections()
      return closed
    } }
}

export async function probe({ phase, origin, data, keyFile, run, app, model, input }) {
  let stage = 'inputs'
  const check = ok => { if (!ok) throw Error() }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  try {
    const { createHash, randomBytes } = await import('node:crypto')
    const { lstat, readFile, readdir, realpath, writeFile } = await import('node:fs/promises')
    const { setTimeout: delay } = await import('node:timers/promises')
    const { request } = await import('node:http')
    const { requestControl } = await import(app + '/src/control/socket.mjs')
    const first = phase === 'first', native = app === '/opt/deva/apps/headless'
    const cookiePattern = /^deva-workbench-local=[A-Za-z0-9_-]{43}$/u
    const tokenPattern = /^[A-Za-z0-9_-]{43}$/u
    const passwordPattern = /^[A-Za-z0-9_-]{32}$/u
    const sid = 'sess_packaged_status', readFilePath = data + '/read-state.json'
    const sessionFile = `${data}/data/chats/${sid}.json`
    const unrelated = 'sess_unrelated_keep', seed = '"sess_unrelated_keep" : 3.700e1'
    const chat = `chats/${sid}`, reads = 'conversation-status/reads', read = chat + '/read-state', usage = chat + '/context-usage'
    const time = n => Number.isSafeInteger(n) && n >= 0
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
    const validObservation = value => time(value?.updatedAt) && value.cursor?.scope === `chat:${sid}` &&
      uuid.test(value.cursor.epoch) && uuid.test(value.cursor.generation) && time(value.cursor.seq)
    const observed = ({ state, cursor }) => ({ updatedAt: state.updatedAt, cursor })
    const entry = (snap, readAt = null) => ({ id: sid, updatedAt: snap.state.updatedAt, readAt, unread: readAt === null })
    const digest = bytes => createHash('sha256').update(bytes).digest('hex')
    check((first || phase === 'second') && /^http:\/\/127\.0\.0\.1:\d{1,5}$/u.test(origin) &&
      /^http:\/\/127\.0\.0\.1:\d{1,5}$/u.test(model.origin))
    if (first) check(same(input, {}))
    else check(passwordPattern.test(input.password) && cookiePattern.test(input.cookie) && tokenPattern.test(input.csrf) &&
      validObservation(input.observed) && uuid.test(input.turnId) && input.measured === model.used)

    let cookie, csrf
    // Isolated loopback only; a one-shot Node HTTP connection has neither redirect handling nor inherited proxy configuration.
    function http(path, method = 'GET', headers = {}, body) {
      return new Promise((resolve, reject) => {
        const req = request(origin + path, { method, headers, agent: false, signal: AbortSignal.timeout(4000) }, res => {
          void (async () => {
            const chunks = []; let length = 0
            for await (const chunk of res) { length += chunk.length; check(length <= 128 * 1024); chunks.push(chunk) }
            check(res.headers['content-type'] === 'application/json; charset=utf-8')
            return { status: res.statusCode, cookie: res.headers['set-cookie']?.[0]?.split(';', 1)[0], body: JSON.parse(Buffer.concat(chunks)) }
          })().then(resolve, reject)
        })
        req.once('error', reject)
        req.end(body === undefined ? undefined : JSON.stringify(body))
      })
    }
    async function api(path, { body, method = body === undefined ? 'GET' : 'POST', status = 200, auth = { cookie, csrf } } = {}) {
      check(/^[a-z0-9_/-]+$/u.test(path))
      const res = await http('/api/v1/' + path, method, {
        ...(method === 'GET' ? {} : { origin, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }),
        ...(auth.cookie ? { cookie: auth.cookie } : {}), ...(auth.csrf ? { 'x-deva-csrf': auth.csrf } : {})
      }, body)
      check(res.status === status)
      if (path === 'auth/claim' || path === 'auth/login') cookie = res.cookie
      return res.body
    }
    async function waitFor(work) {
      const deadline = performance.now() + 10_000
      do {
        const found = await work()
        if (found) return found
        await delay(50)
      } while (performance.now() < deadline)
      check(false)
    }
    async function privateFile(path, uid = process.getuid()) {
      const info = await lstat(path, { bigint: true })
      check(await realpath(path) === path && info.isFile() && info.uid === BigInt(uid) && info.nlink === 1n && (info.mode & 0o7777n) === 0o600n)
      return { bytes: await readFile(path), stat: [info.dev, info.ino, info.mtimeNs, info.ctimeNs].map(String) }
    }

    stage = 'real-cli-ready'
    await waitFor(async () => {
      try { const res = await http('/readyz'); return res.status === 200 && res.body.status === 'ready' } catch { return false }
    })
    const key = await privateFile(keyFile)
    check(key.bytes.length === 32 && key.bytes.some(n => n !== 0))
    key.bytes.fill(0)
    const core = digest(await readFile(app + '/dist/chat-core.mjs'))
    if (native) {
      stage = 'native-isolation'
      check(process.platform === 'linux' && process.arch === 'x64' && process.versions.node.split('.')[0] === '22' &&
        process.getuid() === 1000 && process.getgid() === 1000 && origin === 'http://127.0.0.1:8787' && model.origin === 'http://127.0.0.1:18787')
      check((await readFile('/proc/1/cmdline', 'utf8')) === `node\0${app}/src/cli.mjs\0serve\0` &&
        await realpath('/proc/1/exe') === '/usr/local/bin/node')
      const status = await readFile('/proc/1/status', 'utf8')
      check(/^Uid:\s+1000\s+1000\s+1000\s+1000$/mu.test(status) && /^Gid:\s+1000\s+1000\s+1000\s+1000$/mu.test(status) &&
        /^NoNewPrivs:\s+1$/mu.test(status) && ['Inh', 'Eff', 'Prm', 'Bnd', 'Amb'].every(cap => new RegExp(`^Cap${cap}:\\s+0+$`, 'mu').test(status)))
      const mounts = (await readFile('/proc/1/mountinfo', 'utf8')).split('\n').map(line => line.split(' '))
      check([['/', 'ro'], ['/data', 'rw'], ['/keys', 'ro']].every(([mount, mode]) => mounts.some(row => row[4] === mount && row[5].split(',').includes(mode))) &&
        same(await readdir('/sys/class/net'), ['lo']))
      const dir = await lstat(data)
      check(dir.isDirectory() && dir.uid === 1000 && dir.gid === 1000 && (dir.mode & 0o7777) === 0o700)
    }

    stage = 'owner-authentication'
    check((await api('auth/state')).claimed === !first)
    const password = first ? randomBytes(24).toString('base64url') : input.password
    const staleAuth = first ? {} : { cookie: input.cookie, csrf: input.csrf }
    check(same(await api(reads, { auth: staleAuth, status: 401 }), { error: 'auth' }))
    const login = first
      ? await api('auth/claim', { body: { password, credential: (await requestControl({ runDir: run, op: 'claim' })).credential } })
      : await api('auth/login', { body: { password } })
    csrf = login.csrf
    check(cookiePattern.test(cookie) && tokenPattern.test(csrf) && cookie !== input.cookie && csrf !== input.csrf)
    const provider = 'packaged-status-fixture', altModel = 'fixture-alternate'
    const primary = `${provider}:${model.model}`, alternate = `${provider}:${altModel}`
    const primaryWindow = 16_000, alternateWindow = 20_000
    const context = (ref, source, used, window) => ({ modelRef: ref, usage: { used, estimated: source === 'estimate', window, trigger: null }, source, compaction: 'inactive' })
    const meter = () => api(usage, { body: { model: null } })
    const measured = context(primary, 'measured', model.used, primaryWindow)
    const settings = async models => {
      const { revision } = await api('settings')
      return api('settings', { method: 'PATCH', body: { revision, set: { models } } })
    }
    const last = state => state.lastTurn?.turnId
    let snap, estimate
    if (first) {
      stage = 'synthetic-model-and-one-turn'
      await writeFile(readFilePath, `{\n  ${seed}\n}\n`, { flag: 'wx', mode: 0o600 })
      const installed = await settings({ activeModelId: primary, activeEffort: 'default', providers: [{ id: provider,
        name: 'Synthetic container fixture', kind: 'custom', purpose: 'llm', accent: '#234567', adapter: 'openai',
        apiHost: model.origin + '/v1', enabled: true, models: [[model.model, primaryWindow], [altModel, alternateWindow]].map(([id, contextWindow]) =>
          ({ id, name: id, enabled: true, contextWindow, maxOutput: 512 })) }] })
      const configured = await api('provider-keys/' + provider, { method: 'PUT', body: { value: model.key, revision: installed.revision } })
      check(configured.available && model.expectCalls(0))
      check((await api('chats', { body: { sessionId: sid } })).session?.id === sid)
      check(same(await api(reads), { entries: [] }))
      const ack = await api(chat + '/turns', { body: { clientRequestId: 'one-packaged-turn', text: model.question, model: null }, status: 202 })
      check(ack.duplicate === false && typeof ack.turnId === 'string')
      snap = await waitFor(async () => { const view = await api(chat); return !view.state.active && last(view.state) === ack.turnId && view })
      check(snap.state.lastTurn.status === 'completed' && same(snap.state.messages.map(row => row.content), [model.question, model.answer]) && model.expectCalls(1))

      stage = 'measured-vs-effective-model'
      const before = await privateFile(sessionFile)
      check(same(await meter(), measured))
      await settings({ activeModelId: alternate })
      const approx = await meter()
      estimate = approx.usage?.used
      check(Number.isSafeInteger(estimate) && estimate > 0 && estimate !== model.used && same(approx, context(alternate, 'estimate', estimate, alternateWindow)))
      await settings({ activeModelId: primary })
      const after = await privateFile(sessionFile)
      check(same(await meter(), measured) && before.bytes.equals(after.bytes) && same(before.stat, after.stat) && model.expectCalls(1))

      stage = 'authenticated-durable-read'
      check(same(await api(reads), { entries: [entry(snap)] }))
      check(same(await api(read, { body: observed(snap) }), { ...entry(snap, snap.state.updatedAt), changed: true }))
    } else {
      stage = 'fresh-auth-old-cursor'
      check(same(await api(read, { auth: staleAuth, body: input.observed, status: 401 }), { error: 'auth' }))
      snap = await api(chat)
      check(snap.cursor.epoch !== input.observed.cursor.epoch && snap.state.updatedAt === input.observed.updatedAt && last(snap.state) === input.turnId &&
        snap.state.lastTurn.status === 'completed' && same(snap.state.messages.map(row => row.content), [model.question, model.answer]))
      check(same(await api(read, { body: input.observed, status: 409 }), { error: 'read_view_stale' }))
    }

    stage = 'fresh-snapshot-and-native-stamp'
    check(validObservation(observed(snap)) && same(await api(chat), snap) &&
      same(await api(reads), { entries: [entry(snap, snap.state.updatedAt)] }) && same(await meter(), measured))
    const nativeReads = await privateFile(readFilePath), session = await privateFile(sessionFile)
    const markers = JSON.parse(nativeReads.bytes.toString()), saved = JSON.parse(session.bytes.toString())
    const receipt = saved._devaHeadlessConversationUsage
    check(Number.isSafeInteger(markers[sid]) && markers[sid] === snap.state.updatedAt && markers[unrelated] === 37 &&
      Object.keys(markers).length === 2 && nativeReads.bytes.includes(seed) &&
      saved.lastInputTokens === model.used && saved._devaHeadlessTextTurns.requests.at(-1).turnId === last(snap.state) &&
      receipt?.inputTokens === model.used && receipt.turnId === last(snap.state) && receipt.modelRef === primary && receipt.adapter === 'openai' &&
      receipt.updatedAt === markers[sid] && receipt.digest === digest(JSON.stringify(saved.messages)))
    const evidence = { core, key: key.stat, session: [digest(session.bytes), session.stat], reads: [digest(nativeReads.bytes), nativeReads.stat] }
    if (!first) {
      check(same(evidence, input.evidence))
      check(same(await api(read, { body: observed(snap) }), { ...entry(snap, snap.state.updatedAt), changed: false }))
      const after = await privateFile(readFilePath)
      check(after.bytes.equals(nativeReads.bytes) && same(after.stat, nativeReads.stat))
    }
    if (native) check((await readFile('/proc/1/task/1/children', 'utf8')).trim() === '')
    check(model.expectCalls(first ? 1 : 0))
    return first ? { password, cookie, csrf, observed: observed(snap), turnId: last(snap.state), evidence, estimate, measured: model.used }
      : { verified: true, measured: model.used, readAt: markers[sid], core, readSha: evidence.reads[0] }
  } catch { throw Error(stage) }
}

export const probeProgram = `
let stage = 'probe-transport';
try {
  const chunks = []; let bytes = 0;
  for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > 8192) throw Error(); chunks.push(chunk); }
  const input = JSON.parse(Buffer.concat(chunks).toString());
  const model = await (${startModel.toString()})(18787);
  try {
    const result = await (${probe.toString()})({ phase: process.argv[1], origin: 'http://127.0.0.1:8787',
      data: '/data', keyFile: '/keys/master.key', run: '/run/deva', app: '/opt/deva/apps/headless', model, input });
    process.stdout.write(JSON.stringify(result));
  } catch (error) { stage = error.message; throw Error(); }
  finally { await model.close(); }
} catch { process.stderr.write('conversation-status probe: ' + stage + '\\n'); process.exitCode = 1; }
`
