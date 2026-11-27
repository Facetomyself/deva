import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import * as fs from 'node:fs'
import { createServer, request } from 'node:http'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { gateway, modelStream, route } from './headless-model-wire.mjs'

const env = { PATH: '/usr/bin:/bin', LANG: 'C' }, deadline = () => AbortSignal.timeout(5000)
const ns = kind => fs.readlinkSync(`/proc/self/ns/${kind}`)
const runId = () => { const s = fs.lstatSync('/run'); assert.ok(s.isDirectory()); return `${s.dev}:${s.ino}` }
const flags = ['--user', '--map-root-user', '--mount', '--propagation', 'private', '--']
const wait = child => once(child, 'close').then(([code, signal]) => ({ code, signal }))
const cmd = (file, ...args) => execFileSync(file, args, { env, timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] })
const main = import.meta.filename
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const mountRows = () => fs.readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\n').map(row => row.split(' - ')[0].split(' '))
const docPath = '/api/project-docs', sessions = '/api/sessions'
const dir = '/run/deva-project-docs', target = `${dir}/snapshot.json`
const leaf = path => mountRows().filter(row => row[4] === path)

if (process.argv[2] === '--private') {
  const [, , , parentUser, parentMount, parentRun, parentUid, bundle] = process.argv
  assert.match(parentUser, /^user:\[\d+\]$/); assert.match(parentMount, /^mnt:\[\d+\]$/)
  assert.equal(fs.readFileSync('/proc/self/uid_map', 'utf8').trim().split(/\s+/).join(' '), `0 ${parentUid} 1`)
  assert.notEqual(ns('user'), parentUser); assert.notEqual(ns('mnt'), parentMount)
  assert.equal(runId(), parentRun); assert.equal(fs.realpathSync('/run'), '/run')
  assert.ok(mountRows().every(row => !row.slice(6).some(field => /^(shared|master|propagate_from):/.test(field))))
  process.umask(0o022)
  cmd('mount', '-t', 'tmpfs', '-o', 'mode=0755,size=12m,nosuid,nodev,noexec', 'deva-native-test', '/run')
  assert.notEqual(runId(), parentRun); assert.deepEqual(fs.readdirSync('/run'), [])
  try { await qualify(bundle) } finally { cmd('umount', '/run'); assert.equal(runId(), parentRun) }
} else test('compiled project reader requires a real private RO leaf mount and revokes on restart', { timeout: 90000 }, async t => {
  const probe = process.platform === 'linux' && spawnSync('unshare', [...flags, '/usr/bin/true'], { env, timeout: 5000, encoding: 'utf8' })
  if (!probe || probe.status !== 0) {
    const reason = `private Linux user+mount unshare unavailable: ${probe ? probe.error?.message ?? (probe.stderr.trim() || String(probe.signal)) : process.platform}`
    if (process.env.DEVA_REQUIRE_MOUNT_TEST === '1') assert.fail(reason)
    return t.skip(reason)
  }
  const original = [ns('user'), ns('mnt'), runId()]
  const bundle = resolve(process.env.DEVA_TEST_SERVER ?? fileURLToPath(new URL('../out/headless/server.mjs', import.meta.url)))
  assert.ok(fs.statSync(bundle).isFile(), 'build the headless production bundle first')
  const child = spawn('unshare', [...flags, process.execPath, main, '--private', ...original, String(process.getuid()), bundle], { env, detached: true })
  let log = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk })
  const timer = setTimeout(() => { if (child.pid) process.kill(-child.pid, 'SIGKILL') }, 80000)
  try { assert.deepEqual(await wait(child), { code: 0, signal: null }, log) } finally { clearTimeout(timer) }
  assert.deepEqual([ns('user'), ns('mnt'), runId()], original)
  t.diagnostic(log.trim())
})

async function qualify(bundle) {
  const root = fs.mkdtempSync('/run/deva-docs-native-'), home = join(root, 'home'), data = join(root, 'data')
  assert.equal(fs.realpathSync(root), root); assert.equal(fs.statSync(root).mode & 0o777, 0o700)
  fs.mkdirSync(home, { mode: 0o700 }); fs.mkdirSync(dir)
  const source = join(root, 'sealed.json'), link = join(root, 'link.json'), fifo = join(root, 'fifo'), alt = join(root, 'alt.json')
  const withheld = 'ungranted-secrets.md', secret = 'withheld synthetic text'
  fs.writeFileSync(join(root, withheld), secret, { mode: 0o444 }); cmd('mkfifo', fifo)
  const project = 'Synthetic Reading', docs = [{ name: 'Notes.MD', text: '\ufeff# 研修 🙂\r\n\t' }, { name: 'Other.txt', text: 'initial only\n' }]
  const revised = [{ name: 'Revised.md', text: 'replacement only\r\n' }]
  const wire = documents => Buffer.from(`\t ${JSON.stringify({ version: 1, project, documents })}\r\n`)
  const raw = wire(docs), raw2 = wire(revised), sha = digest(raw), sha2 = digest(raw2)
  const token = randomBytes(32).toString('base64url'), key = randomBytes(24).toString('base64url'), model = 'fixture-docs'
  const drop = ['--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs', '--']
  const traceProbe = spawnSync('setpriv', [...drop, 'strace', '-D', '-qq', '-o', join(root, 'probe'), '/usr/bin/true'], { env, timeout: 3000, encoding: 'utf8' })
  const tracing = traceProbe.status === 0
  const traceFile = join(root, 'syscalls'), reads = /\b(?:read|readv|pread\w*|mmap)\(/
  const docIO = trace => trace.split('\n').filter(line => [dir, source, fifo, alt, withheld].some(value => line.includes(value)))
  const mount = (from, to = target, ro = true) => {
    cmd('mount', '--bind', from, to)
    if (ro) cmd('mount', '-o', 'remount,bind,ro', to)
    const rows = leaf(to); assert.equal(rows.length, 1); assert.ok(rows[0][5].split(',').includes(ro ? 'ro' : 'rw'))
    const fd = fs.openSync(to, 0o10000000 | fs.constants.O_NOFOLLOW) // O_PATH also pins the FIFO without opening a reader.
    try { assert.match(fs.readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'), new RegExp(`^mnt_id:\\s+${rows[0][0]}$`, 'm')) }
    finally { fs.closeSync(fd) }
  }
  const remove = (at = target) => { if (leaf(at).length) cmd('umount', at); fs.rmSync(at, { force: true }) }
  const listen = async server => {
    await once(server.listen(0, '127.0.0.1'), 'listening', { signal: deadline() }); return server.address().port
  }
  let calls = 0, service, cookie = '', exerciseChat = false
  const upstream = createServer(async (req, res) => {
    calls++; req.resume()
    if (!exerciseChat || req.method !== 'POST' || req.url !== route('openai')) return res.writeHead(500).end()
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const stream = modelStream(res, 'openai', model)
    await stream.delta('ordinary synthetic reply'); stream.terminal(); res.end()
  })
  try {
    const base = `http://127.0.0.1:${await listen(upstream)}${gateway('openai')}/v1`, portProbe = createServer()
    const port = await listen(portProbe); await new Promise(done => portProbe.close(done))
    const origin = `http://127.0.0.1:${port}`, listening = `Deva Web listening on ${origin}\n`
    function launch(sha256, devaHome, duringRead) {
      const trace = tracing ? ['strace', '-Dfqqy', '-s', '192', '-e', 'trace=%file,read,readv,pread64,preadv,preadv2,mmap,bind,listen', '-o', traceFile] : []
      fs.rmSync(traceFile, { force: true })
      const instrumentation = duringRead ? ['--import', `data:text/javascript,${encodeURIComponent(duringRead)}`] : []
      const child = spawn('setpriv', [...drop, ...trace, process.execPath, ...instrumentation, bundle], { env: { ...env, HOME: home, DEVA_HOME: devaHome,
        DEVA_ORIGIN: origin, DEVA_PORT: String(port), DEVA_WEB_TOKEN: token, DEVA_MODEL: model, DEVA_MODEL_API_KEY: key,
        DEVA_MODEL_BASE_URL: base, DEVA_PROJECT_DOCS_PATH: join(root, withheld),
        ...(sha256 === undefined ? {} : { DEVA_PROJECT_DOCS_SHA256: sha256 }) } })
      let out = '', err = ''
      child.stdout.on('data', chunk => { out += chunk }); child.stderr.on('data', chunk => { err += chunk })
      service = { child, exited: wait(child), out: () => out, err: () => err, trace: () => tracing ? fs.readFileSync(traceFile, 'utf8') : '' }
      service.exited.catch(() => {}); return service
    }
    async function stop() {
      if (!service) return
      const run = service, { child, exited } = run; service = undefined
      const force = setTimeout(() => child.kill('SIGKILL'), 2000)
      child.kill('SIGTERM')
      try { assert.deepEqual(await exited, { code: 0, signal: null }) } finally { clearTimeout(force) }
      assert.equal(run.out(), listening); assert.equal(run.err(), '')
    }
    const boundedExit = run => Promise.race([run.exited, delay(4500, null, { ref: false })])
    const invalidHome = join(root, 'must-not-exist')
    async function reject(sha256, code, label = code, duringRead) {
      const run = launch(sha256, invalidHome, duringRead)
      assert.deepEqual(await boundedExit(run), { code: 1, signal: null }, label)
      assert.equal(run.out(), ''); assert.equal(run.err(), `Deva Web project documents: ${code}\n`, label)
      assert.equal(fs.existsSync(invalidHome), false); assert.doesNotMatch(run.trace(), /^(?:\d+\s+)?(?:listen|bind)\(/m)
      if (code === 'invalid_digest') assert.deepEqual(docIO(run.trace()), [], label)
      if (code === 'invalid_mount') assert.ok(docIO(run.trace()).every(line => !reads.test(line)), label)
    }
    async function boot(sha256) {
      const run = launch(sha256, data), end = deadline()
      while (run.out() !== listening) {
        assert.ok(run.child.exitCode === null && run.child.signalCode === null, run.err()); await delay(20, null, { signal: end })
      }
      const status = fs.readFileSync(`/proc/${run.child.pid}/status`, 'utf8')
      for (const cap of ['Inh', 'Prm', 'Eff', 'Bnd', 'Amb']) assert.match(status, new RegExp(`^Cap${cap}:\\s+0+$`, 'm'))
      assert.match(status, /^NoNewPrivs:\s+1$/m); assert.equal(run.err(), '')
    }
    async function json(path, status = 200, { body, headers } = {}) {
      const text = body === undefined ? undefined : JSON.stringify(body)
      const response = await new Promise((done, fail) => {
        const req = request(origin + path, { signal: deadline(), method: text === undefined ? 'GET' : 'POST', headers: {
          Cookie: cookie, ...(text === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' }), ...headers } }, done)
        req.on('error', fail).end(text)
      })
      const chunks = []; for await (const chunk of response) chunks.push(chunk)
      const content = Buffer.concat(chunks).toString('utf8')
      assert.equal(response.statusCode, status, path)
      for (const hidden of [root, target, withheld, secret, token, key, sha, sha2, base, cookie.split('=')[1]].filter(Boolean))
        assert.ok(!content.includes(hidden), 'private data in response')
      const dto = response.headers['content-type']?.startsWith('application/x-ndjson') ? content.trimEnd().split('\n').map(line => JSON.parse(line)) : JSON.parse(content)
      if (status >= 400) assert.deepEqual(dto, { error: { 401: 'auth', 403: 'origin', 404: 'missing', 405: 'method' }[status] })
      return [dto, response.headers]
    }
    const get = async (...args) => (await json(...args))[0]
    const login = async () => { const [dto, headers] = await json('/api/login', 200, { body: { token } })
      assert.deepEqual(dto, { ok: true }); return headers['set-cookie'][0].split(';')[0] }
    const id = /^[0-9a-f]{32}$/, detail = (generation, doc) => `${docPath}/${generation}/${doc}`
    async function listing(expected) {
      const [dto, headers] = await json(docPath), { generation, documents } = dto
      assert.match(generation, id); assert.equal(new Set(documents.map(doc => doc.id)).size, expected.length)
      assert.ok(+headers['x-deva-session-ttl-ms'] > 0 && +headers['x-deva-session-ttl-ms'] <= 28800000)
      const rows = expected.map(({ name, text }, i) => ({ id: documents[i].id, name, bytes: Buffer.byteLength(text) }))
      assert.deepEqual(dto, { project, generation, documents: rows })
      for (const [i, row] of rows.entries()) {
        assert.match(row.id, id); assert.deepEqual(await get(detail(generation, row.id)), { generation, ...row, text: expected[i].text })
      }
      return [generation, rows[0].id]
    }

    fs.symlinkSync(fifo, target)
    for (const value of ['', sha.toUpperCase(), `${sha}\n`]) await reject(value, 'invalid_digest')
    await boot(); cookie = await login()
    assert.deepEqual(await get(sessions), { model, sessions: [] }); await get(docPath, 404); await get(docPath, 404, { body: {} })
    const session = await get(sessions, 201, { body: {} }), sessionPath = `${sessions}/${session.id}`
    const sessionFile = join(data, 'data', 'chats', `${session.id}.json`)
    const volume = () => {
      const { dev, ino, mtimeNs, ctimeNs } = fs.statSync(sessionFile, { bigint: true })
      return { dev, ino, mtimeNs, ctimeNs, bytes: fs.readFileSync(sessionFile) }
    }
    const state = volume(), oldIndex = { model, sessions: [{ id: session.id, title: session.title }] }
    const off = service; await stop(); assert.deepEqual(docIO(off.trace()), []); assert.doesNotMatch(off.trace(), /\/(?:mountinfo|fdinfo)(?:[\/"<])/)
    remove(); fs.writeFileSync(source, raw, { mode: 0o444 }); fs.writeFileSync(target, raw, { mode: 0o444 })
    await reject(sha, 'invalid_mount', 'unmounted 0444 leaf'); remove()
    const dirSource = join(root, 'dir'); fs.mkdirSync(dirSource); fs.writeFileSync(join(dirSource, 'snapshot.json'), raw, { mode: 0o444 })
    mount(dirSource, dir); await reject(sha, 'invalid_mount', 'RO directory bind'); cmd('umount', dir)
    fs.writeFileSync(alt, ''); mount(source, alt); fs.symlinkSync(alt, target)
    await reject(sha, 'invalid_mount', 'symlink to a RO mount'); remove(); remove(alt)
    fs.writeFileSync(target, ''); fs.linkSync(source, link); mount(link)
    await reject(sha, 'invalid_mount', 'hardlinked RO leaf'); cmd('umount', target); fs.unlinkSync(link)
    mount(fifo); await reject(sha, 'invalid_mount', 'FIFO RO leaf'); cmd('umount', target)
    mount(source, target, false); await reject(sha, 'invalid_mount', 'RW exact leaf'); cmd('umount', target)
    mount(source); await reject(sha2, 'digest_mismatch')
    // Deterministically schedule a real mtime change on our synthetic backing inode immediately
    // after its first real kernel data read. Neither file contents nor syscall results are mocked.
    const modifyBacking = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
      const target=fs.statSync(${JSON.stringify(source)}), read=fs.readSync; let once=true;
      fs.readSync=function(fd,...args){ const n=read.call(fs,fd,...args), actual=fs.fstatSync(fd);
        if(once && n>0 && actual.ino===target.ino && actual.dev===target.dev){once=false;fs.utimesSync(${JSON.stringify(source)},1000,1000)} return n };
      syncBuiltinESMExports();`
    await reject(sha, 'mount_changed', 'file changed during verified read', modifyBacking)
    assert.equal(fs.statSync(source).mtimeMs, 1_000_000); cmd('umount', target)
    for (const [bytes, code] of [[Buffer.from('{}'), 'invalid_snapshot'], [Buffer.alloc(2 * 1024 * 1024 + 1, 32), 'snapshot_limit']]) {
      fs.writeFileSync(alt, bytes, { mode: 0o444 }); mount(alt); await reject(digest(bytes), code); cmd('umount', target); remove(alt)
    }
    mount(source); await boot(sha); cookie = await login()
    const startupIO = docIO(service.trace()); if (tracing) assert.ok(startupIO.some(line => reads.test(line)), 'trace observed the actual sealed read')
    assert.deepEqual(await get(sessions), { ...oldIndex, projectDocs: true })
    assert.deepEqual(await get(`${sessions}/archived`), { model, sessions: [] })
    const [gen, doc] = await listing(docs), previous = detail(gen, doc)
    for (const path of [docPath, previous]) {
      await get(path, 401, { headers: { Cookie: 'deva_web=wrong' } })
      for (const name of ['Host', 'Origin']) await get(path, 403, { headers: { [name]: 'http://foreign.invalid' } })
      assert.equal((await json(path, 405, { body: {} }))[1].allow, 'GET')
    }
    await get(detail(gen, 'f'.repeat(32)), 404); await get(detail('bad', doc), 404)
    fs.writeFileSync(alt, raw2, { mode: 0o444 }); fs.renameSync(alt, source)
    assert.notEqual(fs.statSync(target).ino, fs.statSync(source).ino)
    assert.deepEqual(await listing(docs), [gen, doc]); assert.deepEqual(await get(sessionPath), session)
    const old = service; await stop(); assert.deepEqual(docIO(old.trace()), startupIO, 'browsing does not reopen or reread the snapshot')
    cmd('umount', target); mount(source); await boot(sha2)
    await get(docPath, 401); await get(previous, 401); cookie = await login()
    const [newGen, newDoc] = await listing(revised)
    assert.notEqual(newGen, gen); assert.notEqual(newDoc, doc); await get(previous, 404); await get(detail(newGen, doc), 404)
    const current = detail(newGen, newDoc); await stop(); remove(); await reject(sha2, 'invalid_mount', 'missing fixed leaf')
    await boot(); await get(docPath, 401); cookie = await login()
    assert.deepEqual(await get(sessions), oldIndex); await get(docPath, 404); await get(previous, 404); await get(current, 404)
    assert.deepEqual(await get(sessionPath), session); assert.deepEqual(volume(), state); assert.equal(calls, 0)
    exerciseChat = true
    const turn = await get(`${sessionPath}/turns`, 200, { body: { text: 'ordinary synthetic turn', revision: session.revision, turnId: randomUUID() } })
    assert.deepEqual(turn, [{ type: 'delta', text: 'ordinary synthetic reply' }, { type: 'done', reason: 'complete' }])
    assert.equal(calls, 1); assert.equal((await get(sessionPath)).messages.length, 2); await stop()
    console.log(`native Linux mount matrix and restart/revoke passed; syscall trace ${tracing ? 'asserted' : `unavailable (${traceProbe.error?.message ?? (traceProbe.stderr.trim() || traceProbe.status)})`}`)
  } finally {
    if (service) { service.child.kill('SIGKILL'); await service.exited }
    upstream.closeAllConnections(); if (upstream.listening) await new Promise(done => upstream.close(done))
    for (const path of [target, alt, dir]) if (leaf(path).length) cmd('umount', path)
  }
}
