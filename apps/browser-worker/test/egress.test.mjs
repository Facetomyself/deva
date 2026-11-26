import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { chmod, lstat, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer, request } from 'node:http'
import { createConnection, createServer as createTcpServer } from 'node:net'
import { once } from 'node:events'
import { join } from 'node:path'
import test from 'node:test'
import { parseSites, probeEgress, startEgress, startLocalProxy } from '../src/egress/index.mjs'
import { selectAddress } from '../src/egress/address.mjs'
import { limits } from '../src/egress/lifecycle.mjs'
import { bindBrokerSocket } from '../src/egress/unix.mjs'

function listed(url, id = 'fixture') { return { id, label: `Site ${id}`, url } }

async function temporaryDir(t) {
  const path = await mkdtemp('/tmp/dsh-egress-test-')
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}

async function fixture(t, server) {
  const sockets = new Set()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve) => {
    server.close(resolve)
    for (const socket of sockets) socket.destroy()
  }))
  return { authority: `127.0.0.1:${server.address().port}`, sockets }
}

async function setup(t, runDir, sites, privateOrigins) {
  const broker = await startEgress({ runDir, sites, privateOrigins })
  t.after(() => broker.close())
  const adapter = await startLocalProxy({ socketPath: broker.socketPath })
  t.after(() => adapter.close())
  return { broker, adapter }
}

function connectTo({ host, port, socketPath }) {
  return createConnection(socketPath ? { path: socketPath } : { host, port, allowHalfOpen: true })
}

function proxyHttp(endpoint, path, { method = 'GET', headers, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(endpoint.socketPath ? { socketPath: endpoint.socketPath, path, method, headers, agent: false } :
      { host: endpoint.host, port: endpoint.port, path, method, headers, agent: false }, (res) => {
      const parts = []
      res.on('data', (part) => parts.push(part))
      res.on('error', reject)
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).toString() }))
    })
    req.setTimeout(3000, () => req.destroy(new Error('Fixture proxy request timed out')))
    req.once('error', reject)
    req.end(body)
  })
}

function proxyRaw(endpoint, data, { allowReset = false } = {}) {
  return new Promise((resolve, reject) => {
    const sock = connectTo(endpoint)
    const parts = []
    const result = () => resolve(Buffer.concat(parts).toString())
    sock.setTimeout(3000, () => sock.destroy(new Error('Fixture raw request timed out')))
    sock.on('data', (part) => parts.push(part))
    sock.once('error', (error) => {
      if (allowReset && (error.code === 'ECONNRESET' || error.code === 'EPIPE')) result()
      else reject(error)
    })
    sock.once('end', () => { sock.end(); result() })
    sock.once('close', result)
    sock.once('connect', () => sock.write(data))
  })
}

async function startTunnel(endpoint, authority, head = Buffer.alloc(0)) {
  const client = connectTo(endpoint)
  client.setTimeout(3000, () => client.destroy(new Error('Fixture tunnel timed out')))
  await once(client, 'connect')
  let observed = Buffer.alloc(0)
  const receive = new Promise((resolve, reject) => {
    const fail = () => reject(new Error('Fixture tunnel ended before its handshake'))
    client.once('error', reject)
    client.once('close', fail)
    const data = (chunk) => {
      observed = Buffer.concat([observed, chunk])
      const at = observed.indexOf('\r\n\r\n')
      if (at < 0 || observed.length < at + 4 + head.length) return
      client.off('data', data)
      client.off('error', reject)
      client.off('close', fail)
      client.on('error', () => {})
      resolve({ client, status: observed.subarray(0, at).toString(), echoed: observed.subarray(at + 4) })
    }
    client.on('data', data)
  })
  client.write(Buffer.concat([Buffer.from(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`), head]))
  return receive
}

test('deployment sites are explicit, normalized, immutable snapshots', () => {
  const sites = parseSites('[{"id":"docs","label":"文档","url":"https://EXAMPLE.test:443/start"}]')
  assert.deepEqual(sites, [{ id: 'docs', label: '文档', url: 'https://example.test/start', origin: 'https://example.test' }])
  assert.ok(Object.isFrozen(sites) && Object.isFrozen(sites[0]))
  for (const url of [
    'https://*.example.test/', 'https://name@example.test/', 'https://@example.test/', 'https://example.test/?',
    'https://example.test/#', 'https://example.test/?k=v', 'https://example.test:0/', 'https://example.test:0443/',
    'https://example.test./', 'https://ex%61mple.test/', 'https://0177.0.0.1/', 'https://[fe80::1%eth0]/',
    'https://example.test\\@other.test/', 'file:///etc/hosts', 'https://example.test/\n',
  ]) assert.throws(() => parseSites([listed(url)]), TypeError, url)
  assert.throws(() => parseSites([listed('https://x.test'), listed('https://y.test')]), TypeError)
  assert.throws(() => parseSites([{ ...listed('https://x.test'), origin: 'https://example.test' }]), TypeError)
  assert.throws(() => parseSites('{"url":"https://example.test"}'), TypeError)
})

test('address selection rejects metadata, malformed and mixed DNS answers before any dial', () => {
  const v4 = (address) => ({ address, family: 4 })
  const v6 = (address) => ({ address, family: 6 })
  const publicIPv4 = v4('93.184.216.34')
  const publicIPv6 = v6('2606:2800:220:1:248:1893:25c8:1946')
  assert.deepEqual(selectAddress([publicIPv4, publicIPv6], false), publicIPv4)
  assert.equal(selectAddress([v4('127.0.0.1')], false), null)
  assert.deepEqual(selectAddress([v4('127.0.0.1'), v6('::1')], true), v4('127.0.0.1'))
  assert.equal(selectAddress([publicIPv6, v4('192.168.0.1')], true), null)
  assert.equal(selectAddress([v4('127.0.0.1'), v4('192.168.0.1')], true), null)
  assert.equal(selectAddress([{ address: '127.0.0.1', family: 6 }], true), null)
  assert.equal(selectAddress([], true), null)
  assert.equal(selectAddress([{ address: 'invalid', family: 4 }], true), null)
  for (const address of [
    v4('100.100.100.200'), v4('168.63.129.16'), v4('169.254.169.254'), v4('224.0.0.1'), v4('0.0.0.0'),
    v6('::'), v6('::ffff:127.0.0.1'), v6('fe80::1'), v6('fe80::1%lo'), v6('ff02::1'), v6('fd00:ec2::254'), v6('fd20:ce::254'),
  ]) {
    assert.equal(selectAddress([address], true), null, address.address)
    assert.equal(selectAddress([publicIPv4, address], true), null, address.address)
  }
})

test('Unix broker requires 0700, reserves a 0600 socket, and supports transport readiness', async (t) => {
  const dir = await temporaryDir(t)
  const socketPath = join(dir, 'egress.sock')
  assert.equal(await probeEgress(socketPath), false)
  await chmod(dir, 0o755)
  await assert.rejects(startEgress({ runDir: dir, sites: [] }), /0700/)
  await assert.rejects(lstat(socketPath), { code: 'ENOENT' })
  await chmod(dir, 0o700)
  const aliasParent = await temporaryDir(t)
  const alias = join(aliasParent, 'alias')
  await symlink(dir, alias)
  await assert.rejects(startEgress({ runDir: alias, sites: [] }), /symbolic links/)
  await writeFile(socketPath, 'fixture')
  await assert.rejects(startEgress({ runDir: dir, sites: [] }), /already exists/)
  assert.equal(await readFile(socketPath, 'utf8'), 'fixture')
  await rm(socketPath)
  const { broker, adapter } = await setup(t, dir, [], [])
  const stat = await lstat(socketPath)
  assert.deepEqual(await readdir(dir), ['egress.sock'])
  assert.equal(broker.socketPath, socketPath)
  assert.ok(stat.isSocket())
  assert.equal(stat.mode & 0o7777, 0o600)
  assert.equal(await probeEgress(socketPath), true)
  assert.equal(await probeEgress(socketPath, { signal: AbortSignal.abort() }), false)
  assert.equal(adapter.host, '127.0.0.1')
  assert.equal(adapter.url, `http://127.0.0.1:${adapter.port}`)
  await assert.rejects(startLocalProxy({ socketPath, host: '0.0.0.0' }), /loopback/)
  await assert.rejects(startEgress({ runDir: dir, sites: [] }), /already exists/)
  assert.equal(await probeEgress(socketPath), true)
  await adapter.close()
  await Promise.all([broker.close(), broker.close()])
  await assert.rejects(lstat(socketPath), { code: 'ENOENT' })
  assert.equal(await probeEgress(socketPath), false)
})

test('an existing local adapter never relays to a replacement socket', async (t) => {
  const dir = await temporaryDir(t)
  const { broker, adapter } = await setup(t, dir, [], [])
  const probe = 'OPTIONS * HTTP/1.1\r\nHost: egress.invalid\r\n\r\n'
  // Closing a rejected stream with unread client data can yield EOF or a reset.
  // Keep asserting zero response bytes, including any received before a reset.
  const dropped = () => proxyRaw(adapter, probe, { allowReset: true })
  assert.match(await proxyRaw(adapter, probe), /^HTTP\/1\.1 204 /)
  await broker.close()
  const replacement = await startEgress({ runDir: dir, sites: [] })
  t.after(() => replacement.close())
  assert.equal(await probeEgress(replacement.socketPath), true)
  assert.equal(await dropped(), '')
})

test('a foreign file at the published path survives broker close', async (t) => {
  const dir = await temporaryDir(t)
  const { broker, adapter } = await setup(t, dir, [], [])
  const probe = 'OPTIONS * HTTP/1.1\r\nHost: egress.invalid\r\n\r\n'
  const moved = join(dir, 'moved.sock')
  await chmod(broker.socketPath, 0o660)
  assert.equal(await proxyRaw(adapter, probe, { allowReset: true }), '')
  await chmod(broker.socketPath, 0o600)
  assert.match(await proxyRaw(adapter, probe), /^HTTP\/1\.1 204 /)
  await rename(broker.socketPath, moved)
  await writeFile(broker.socketPath, 'foreign-file', { flag: 'wx' })
  assert.equal(await proxyRaw(adapter, probe, { allowReset: true }), '')
  await broker.close()
  assert.equal(await readFile(broker.socketPath, 'utf8'), 'foreign-file')
  assert.ok((await lstat(moved)).isSocket())
  assert.deepEqual((await readdir(dir)).sort(), ['egress.sock', 'moved.sock'])
})

test('a foreign listener at the published path survives broker close and sees no adapter traffic', async (t) => {
  const dir = await temporaryDir(t)
  const { broker, adapter } = await setup(t, dir, [], [])
  await rename(broker.socketPath, join(dir, 'moved.sock'))
  let accepted = 0
  let received = 0
  const foreign = createTcpServer((socket) => {
    accepted++
    socket.once('data', (chunk) => { received += chunk.length; socket.end('foreign-listener') })
  })
  foreign.listen(broker.socketPath)
  await once(foreign, 'listening')
  t.after(() => new Promise((resolve) => foreign.close(resolve)))
  await chmod(broker.socketPath, 0o600)
  const identity = await lstat(broker.socketPath, { bigint: true })
  const probe = 'OPTIONS * HTTP/1.1\r\nHost: egress.invalid\r\n\r\n'
  assert.equal(await proxyRaw(adapter, probe, { allowReset: true }), '')
  await broker.close()
  const remaining = await lstat(broker.socketPath, { bigint: true })
  assert.equal(remaining.ino, identity.ino)
  assert.equal(remaining.dev, identity.dev)
  assert.equal(accepted, 0)
  assert.equal(received, 0)
  assert.equal(await proxyRaw({ socketPath: broker.socketPath }, 'direct fixture check'), 'foreign-listener')
})

test('failed publication preserves a file created after the broker preflight', async (t) => {
  const dir = await temporaryDir(t)
  const socketPath = join(dir, 'egress.sock')
  const server = createHttpServer()
  server.once('listening', () => writeFileSync(socketPath, 'racing-file', { flag: 'wx' }))
  await assert.rejects(bindBrokerSocket(server, dir, new Set()), { code: 'EEXIST' })
  assert.equal(server.listening, false)
  assert.equal(await readFile(socketPath, 'utf8'), 'racing-file')
  assert.deepEqual(await readdir(dir), ['egress.sock'])
})

test('ordinary HTTP preserves site and CSRF semantics while stripping hop headers', async (t) => {
  const seen = []
  const { authority } = await fixture(t, createHttpServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    seen.push({ method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() })
    res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': ['site=one', 'csrf=two'], 'x-response-hop': 'remove', connection: 'x-response-hop' })
    res.end('response body')
  }))
  const origin = `http://${authority}`
  const dir = await temporaryDir(t)
  await assert.rejects(startEgress({ runDir: dir, sites: [listed(origin)] }), /private origin/)
  await assert.rejects(startEgress({ runDir: dir, sites: [listed(origin)], privateOrigins: [`${origin}/wrong`] }), /exact private origin/)
  await assert.rejects(startEgress({ runDir: dir, sites: [], privateOrigins: [origin] }), /registered exact private origin/)
  const { adapter } = await setup(t, dir, [listed(`${origin}/start`)], [origin])
  assert.equal((await proxyHttp(adapter, `${origin}/download?q=a%2Bb`, { headers: { host: authority } })).status, 200)
  const headers = {
    host: authority, origin, referer: `${origin}/control`, 'sec-fetch-site': 'same-origin',
    cookie: 'site=one; csrf=two', authorization: 'Basic explicit-browser-value', 'x-csrf-token': 'two',
    connection: 'x-request-hop', 'x-request-hop': 'remove', 'proxy-connection': 'x-proxy-hop', 'x-proxy-hop': 'remove',
    'proxy-authorization': 'Basic proxy-only', forwarded: 'for=browser', 'x-forwarded-host': 'not-target',
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const result = await proxyHttp(adapter, `${origin}/actions`, { method, body: 'request body', headers: { ...headers, 'content-length': '12' } })
    assert.equal(result.status, 200)
    assert.equal(result.body, 'response body')
    assert.deepEqual(result.headers['set-cookie'], ['site=one', 'csrf=two'])
    assert.equal(result.headers['x-response-hop'], undefined)
    const event = seen.at(-1)
    assert.equal(event.method, method)
    assert.equal(event.body, 'request body')
    for (const name of ['host', 'origin', 'referer', 'sec-fetch-site', 'cookie', 'authorization', 'x-csrf-token']) assert.equal(event.headers[name], headers[name], name)
    for (const name of ['x-request-hop', 'x-proxy-hop', 'proxy-authorization', 'forwarded', 'x-forwarded-host']) assert.equal(event.headers[name], undefined, name)
  }
  const chunked = await proxyRaw(adapter, `DELETE ${origin}/chunked HTTP/1.1\r\nHost: ${authority}\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nbody\r\n0\r\n\r\n`)
  assert.match(chunked, /^HTTP\/1\.1 200 /)
  assert.equal(seen.at(-1).body, 'body')
  assert.equal(seen[0].path, '/download?q=a%2Bb')
  const head = await proxyHttp(adapter, `${origin}/head`, { method: 'HEAD', headers: { host: authority } })
  assert.equal(head.status, 200)
  assert.equal(head.body, '')
  assert.equal(seen.at(-1).method, 'HEAD')
  assert.match(await proxyRaw(adapter, `TRACE ${origin}/x HTTP/1.1\r\nHost: ${authority}\r\n\r\n`), /^HTTP\/1\.1 405 /)
})

test('rejects unregistered exact origins and malformed authority without an upstream request', async (t) => {
  let hits = 0
  const allowed = await fixture(t, createHttpServer((_req, res) => { hits++; res.end() }))
  const rejected = await fixture(t, createHttpServer((_req, res) => { hits++; res.end() }))
  const origin = `http://${allowed.authority}`
  const other = `http://${rejected.authority}`
  const { broker, adapter } = await setup(t, await temporaryDir(t), [listed(origin)], [origin])
  assert.equal((await proxyHttp(broker, `${other}/x`, { headers: { host: rejected.authority } })).status, 403)
  for (const [target, host] of [
    [origin + '/', rejected.authority], [origin + '/', `${allowed.authority},${allowed.authority}`],
    [`http://user:pass@${allowed.authority}/x`, allowed.authority], [`http://@${allowed.authority}/x`, allowed.authority],
    [`http://${allowed.authority}/x#fragment`, allowed.authority], ['/x', allowed.authority],
    [`http://${allowed.authority}\\@example.test/x`, allowed.authority],
  ]) assert.match(await proxyRaw(adapter, `GET ${target} HTTP/1.1\r\nHost: ${host}\r\n\r\n`), /^HTTP\/1\.1 400 /)
  assert.match(await proxyRaw(adapter, `GET ${origin}/ HTTP/1.1\r\nHost: ${allowed.authority}\r\nhOsT: ${allowed.authority}\r\n\r\n`), /^HTTP\/1\.1 400 /)
  assert.match(await proxyRaw(adapter, `GET ${origin}/ HTTP/1.1\r\n\r\n`), /^HTTP\/1\.1 400 /)
  assert.match(await proxyRaw(adapter, `POST ${origin}/ HTTP/1.1\r\nHost: ${allowed.authority}\r\nContent-Length: 999999999\r\n\r\n`), /^HTTP\/1\.1 413 /)
  assert.match(await proxyRaw(adapter, `CONNECT ${allowed.authority} HTTP/1.1\r\nHost: ${allowed.authority}\r\n\r\n`), /^HTTP\/1\.1 403 /)
  assert.equal(hits, 0)
})

test('CONNECT tunnels only a registered HTTPS authority and closes both peers', async (t) => {
  const target = await fixture(t, createTcpServer({ allowHalfOpen: true }, (socket) => socket.pipe(socket)))
  const other = await fixture(t, createTcpServer((socket) => socket.destroy()))
  const origin = `https://${target.authority}`
  const { adapter, broker } = await setup(t, await temporaryDir(t), [listed(origin), listed(`https://${other.authority}`, 'public-default')], [origin])
  const connect = (dest, host = dest) => proxyRaw(adapter, `CONNECT ${dest} HTTP/1.1\r\nHost: ${host}\r\n\r\n`)
  assert.match(await connect(other.authority), /^HTTP\/1\.1 403 /) // Registered HTTPS backed by a private IP, with no private exception.
  assert.match(await connect(target.authority, '127.0.0.1'), /^HTTP\/1\.1 400 /)
  assert.match(await connect('127.0.0.1'), /^HTTP\/1\.1 400 /) // CONNECT requires an explicit port.
  assert.match(await connect(`user@${target.authority}`), /^HTTP\/1\.1 400 /)
  assert.match(await connect('127.0.0.1:1'), /^HTTP\/1\.1 403 /)
  assert.equal(target.sockets.size, 0)
  assert.equal(other.sockets.size, 0)
  const opaque = Buffer.from([0x16, 3, 1, 0, 5, 0, 255])
  const first = await startTunnel(adapter, target.authority, opaque)
  assert.match(first.status, /^HTTP\/1\.1 200 /)
  assert.deepEqual(first.echoed, opaque)
  const [later] = await Promise.all([once(first.client, 'data'), first.client.write('next')])
  assert.equal(later[0].toString(), 'next')
  const targetClosed = once([...target.sockets][0], 'close')
  const clientClosed = once(first.client, 'close')
  first.client.end()
  await Promise.all([targetClosed, clientClosed])
  assert.equal(target.sockets.size, 0)
  const second = await startTunnel(adapter, target.authority)
  second.client.once('end', () => second.client.end())
  const closed = once(second.client, 'close')
  await broker.close()
  await closed
  assert.equal(await probeEgress(broker.socketPath), false)
})

test('active CONNECT operations are capped and release the slot on close', async (t) => {
  const targetServer = createTcpServer({ allowHalfOpen: true }, (socket) => socket.pipe(socket))
  const allAccepted = new Promise((resolve) => {
    let accepted = 0
    targetServer.on('connection', () => { if (++accepted === limits.operations) resolve() })
  })
  const target = await fixture(t, targetServer)
  const origin = `https://${target.authority}`
  const { adapter } = await setup(t, await temporaryDir(t), [listed(origin)], [origin])
  const tunnels = await Promise.all(Array.from({ length: limits.operations }, () => startTunnel(adapter, target.authority)))
  t.after(() => { for (const { client } of tunnels) client.destroy() })
  await allAccepted
  assert.equal(target.sockets.size, limits.operations)
  assert.match(await proxyRaw(adapter, `CONNECT ${target.authority} HTTP/1.1\r\nHost: ${target.authority}\r\n\r\n`), /^HTTP\/1\.1 503 /)
  const released = once(tunnels[0].client, 'close')
  tunnels[0].client.end()
  await released
  const next = await startTunnel(adapter, target.authority)
  assert.match(next.status, /^HTTP\/1\.1 200 /)
  next.client.end()
  await once(next.client, 'close')
})

test('client abort tears down an incomplete proxied HTTP upload', async (t) => {
  let onRequest
  const upstreamStarted = new Promise((resolve) => { onRequest = resolve })
  const { authority } = await fixture(t, createHttpServer((req) => {
    req.on('error', () => {})
    req.once('data', () => onRequest({ closed: new Promise((resolve) => req.socket.once('close', resolve)) }))
  }))
  const origin = `http://${authority}`
  const { adapter } = await setup(t, await temporaryDir(t), [listed(origin)], [origin])
  const client = connectTo(adapter)
  client.once('error', () => {})
  await once(client, 'connect')
  client.write(`POST ${origin}/abort HTTP/1.1\r\nHost: ${authority}\r\nContent-Length: 100\r\n\r\na`)
  const { closed } = await upstreamStarted
  client.destroy()
  await closed
})
