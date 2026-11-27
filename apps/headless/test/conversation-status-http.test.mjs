import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { IncomingMessage, request as httpRequest } from 'node:http'
import test from 'node:test'
import {
  assertPrivate, bounds, chat, modelRef, networkTimeout, observed, post, question, read, reads,
  reply, usage, workbench, writeJson
} from './conversation-status-fixture.mjs'

const fileVersion = async path => {
  const { ino, mtimeNs, ctimeNs } = await stat(path, { bigint: true })
  return { ino, mtimeNs, ctimeNs, content: await readFile(path, 'utf8') }
}
const entry = (snap, readAt = null) => ({ id: snap.state.id, updatedAt: snap.state.updatedAt,
  readAt, unread: readAt === null || readAt < snap.state.updatedAt })
const marked = (snap, changed = true) => ({ ...entry(snap, snap.state.updatedAt), changed })
const methodError = { error: 'method' }
const authError = { error: 'auth' }
const originError = { error: 'origin' }
const stale = { error: 'read_view_stale' }
const busy = { error: 'read_view_busy' }

async function listWatermark(client) {
  const peer = await client.listPeer()
  try {
    const snap = await peer.next()
    assert.deepEqual(Object.keys(snap).sort(), ['cursor', 't'])
    assert.equal(snap.t, 'sessions-snapshot')
    assert.equal(snap.cursor.scope, 'sessions')
    return snap.cursor
  } finally { peer.close() }
}

test('two owner logins mark only a confirmed observed read view, with quiet no-ops and a durable native map', bounds, async t => {
  const [sid, emptySid, orphanId, configId] = Array.from({ length: 4 }, randomUUID)
  const nativeSeed = { [orphanId]: 37, sess_external_keep: 13 }
  const fx = await workbench(t, { async seed(paths) {
    await writeJson(paths.readFilePath, nativeSeed)
    await writeJson(paths.configPath, { privateFixtureSection: { [configId]: 'private config payload' } })
  } })
  const { owner, upstream } = fx
  const tab = await fx.login()
  assert.notEqual(tab.cookie, owner.cookie)
  assert.notEqual(tab.csrf, owner.csrf)
  await fx.create(sid)
  await fx.create(emptySid)
  assert.deepEqual(await tab.request(reads), { entries: [] })
  const empty = await owner.request(chat(emptySid))
  const initialVersion = await fileVersion(fx.readFilePath)
  const beforeEmpty = await listWatermark(tab)
  assert.deepEqual(await tab.request(read(emptySid), post(observed(empty))), {
    id: emptySid, updatedAt: empty.state.updatedAt, readAt: null, unread: false, changed: false
  })
  assert.deepEqual(await listWatermark(tab), beforeEmpty)
  assert.deepEqual(await fileVersion(fx.readFilePath), initialVersion)
  assert.equal(upstream.calls.length, 0)

  const first = await fx.complete(sid, (await fx.send(sid, 'initial', modelRef('openai'))).turnId)
  assert.deepEqual(first.state.messages.map(message => message.content), [question, reply])
  const listing = await owner.request(reads)
  assert.deepEqual(listing, { entries: [entry(first)] })
  assert.deepEqual(await tab.request(reads), listing)
  assertPrivate(listing, [orphanId, configId, fx.configPath, fx.providerOrigin, 'private config payload'])
  assert.deepEqual(await tab.request(read(sid), post(observed(first), 401, { 'x-deva-csrf': owner.csrf })), authError)
  assert.deepEqual(await owner.request(read(sid), post({ ...observed(first), cursor: empty.cursor }, 400)), { error: 'invalid_read_view' })
  assert.deepEqual(await owner.request(read(sid), post({ ...observed(first), updatedAt: first.state.updatedAt + 1 }, 409)), stale)
  assert.deepEqual(await fileVersion(fx.readFilePath), initialVersion)

  const peer = await owner.listPeer()
  try {
    const initial = await peer.next()
    assert.equal(initial.t, 'sessions-snapshot')
    // The tab did not obtain this snapshot with its own cookie. Its independently owned login and CSRF suffice.
    assert.deepEqual(await tab.request(read(sid), post(observed(first))), marked(first))
    const broadcast = await peer.next()
    assert.deepEqual(broadcast, { t: 'sessions-changed', cursor: { ...initial.cursor, seq: initial.cursor.seq + 1 } })
    assertPrivate(broadcast, [sid, emptySid, orphanId, configId, fx.providerOrigin])
    assert.deepEqual(await owner.request(chat(sid)), first, 'a list mark is not a conversation event or content update')
    assert.deepEqual(await fx.nativeReads(), { ...nativeSeed, [sid]: first.state.updatedAt })
    assert.deepEqual(await owner.request(reads), { entries: [entry(first, first.state.updatedAt)] })
    const afterMark = await fileVersion(fx.readFilePath)
    assert.deepEqual(await owner.request(read(sid), post(observed(first))), marked(first, false))
    assert.deepEqual(await fileVersion(fx.readFilePath), afterMark)
    assert.deepEqual(await listWatermark(tab), broadcast.cursor, 'no-op did not invalidate the list')
    assert.equal(upstream.calls.length, 1)
  } finally { peer.close() }

  upstream.mode('hold')
  const next = await fx.send(sid, 'later', modelRef('openai'), 'Later synthetic text')
  const active = await fx.untilSnapshot(sid, state => state.active?.text === reply, tab)
  assert.deepEqual(await tab.request(reads), { entries: [] })
  assert.deepEqual(await tab.request(read(sid), post(observed(active), 409)), busy)
  assert.equal(upstream.calls.length, 2)
  upstream.release()
  const second = await fx.complete(sid, next.turnId, tab)
  assert.ok(second.state.updatedAt > first.state.updatedAt)
  const beforeLate = await fileVersion(fx.readFilePath)
  assert.deepEqual(await tab.request(read(sid), post(observed(first), 409)), stale)
  assert.deepEqual(await owner.request(reads), { entries: [entry(second, first.state.updatedAt)] })
  assert.deepEqual(await fileVersion(fx.readFilePath), beforeLate)

  const beforeRace = await listWatermark(owner)
  const raced = await Promise.all([owner.request(read(sid), post(observed(second))), tab.request(read(sid), post(observed(second)))])
  assert.deepEqual(raced.sort((a, b) => Number(a.changed) - Number(b.changed)), [marked(second, false), marked(second)])
  assert.deepEqual(await listWatermark(owner), { ...beforeRace, seq: beforeRace.seq + 1 })
  assert.deepEqual(await fx.nativeReads(), { ...nativeSeed, [sid]: second.state.updatedAt })
  const durableVersion = await fileVersion(fx.readFilePath)

  await fx.restart()
  assert.deepEqual(await owner.request(reads, { status: 401 }), authError)
  assert.deepEqual(await tab.request(read(sid), post(observed(second), 401)), authError)
  const reopened = await fx.login()
  assert.deepEqual(await reopened.request(reads), { entries: [entry(second, second.state.updatedAt)] })
  const viewAfterRestart = await reopened.request(chat(sid))
  assert.deepEqual(viewAfterRestart.state, second.state)
  assert.notEqual(viewAfterRestart.cursor.epoch, second.cursor.epoch)
  assert.deepEqual(await reopened.request(read(sid), post(observed(second), 409)), stale)
  assert.deepEqual(await reopened.request(read(sid), post(observed(viewAfterRestart))), marked(viewAfterRestart, false))
  assert.deepEqual(await fileVersion(fx.readFilePath), durableVersion)

  // A later native desktop mark can legitimately be ahead of the observed content time.
  const desktopReadAt = second.state.updatedAt + 1000
  await writeJson(fx.readFilePath, { ...nativeSeed, [sid]: desktopReadAt })
  const desktopVersion = await fileVersion(fx.readFilePath)
  const beforeNativeNoop = await listWatermark(reopened)
  assert.deepEqual(await reopened.request(reads), { entries: [entry(viewAfterRestart, desktopReadAt)] })
  assert.deepEqual(await reopened.request(read(sid), post(observed(viewAfterRestart))), {
    ...entry(viewAfterRestart, desktopReadAt), changed: false
  })
  assert.deepEqual(await fileVersion(fx.readFilePath), desktopVersion)
  assert.deepEqual(await listWatermark(reopened), beforeNativeNoop)
  assert.equal(upstream.calls.length, 2)

  // A desktop's wall clock can be ahead of ours. It must not silently consume a future reply.
  const ahead=Date.now()+60_000
  await writeJson(fx.readFilePath,{...nativeSeed,[sid]:ahead})
  const sentAt=Date.now()
  const later=await reopened.request(`${chat(sid)}/turns`,post({clientRequestId:'after-desktop-clock',model:modelRef('openai'),text:'One new observation'},202))
  const finished=await fx.complete(sid,later.turnId,reopened)
  assert.ok(finished.state.updatedAt>ahead)
  assert.ok(finished.state.lastTurn.startedAt>=sentAt && finished.state.lastTurn.startedAt<ahead)
  assert.deepEqual(await reopened.request(reads),{entries:[entry(finished,ahead)]})
  assert.deepEqual(await reopened.request(read(sid),post(observed(finished))),marked(finished))
  assert.equal(upstream.calls.length,3)

  await writeJson(fx.readFilePath,{...nativeSeed,[sid]:Number.MAX_SAFE_INTEGER})
  const impossible=await fileVersion(fx.readFilePath)
  assert.deepEqual(await reopened.request(reads,{status:409}),{error:'read_state_unsupported'})
  assert.deepEqual(await reopened.request(read(sid),post(observed(finished),409)),{error:'read_state_unsupported'})
  assert.deepEqual(await fileVersion(fx.readFilePath),impossible)
  assert.deepEqual(await reopened.request(chat(sid)),finished)
  assert.equal(upstream.calls.length,3)
})

test('status transport enforces actual methods, bounded unique JSON, origin, cookies and original CSRF', bounds, async t => {
  const fx = await workbench(t)
  const { owner } = fx
  const sid = randomUUID()
  await fx.create(sid)
  const valid = observed(await owner.request(chat(sid)))
  const meterBody = { model: null }
  for (const [path, wrong, allowed] of [[reads, 'POST', 'GET'], [read(sid), 'GET', 'POST'], [usage(sid), 'PUT', 'POST']]) {
    const response = await owner.raw(path, { method: wrong })
    assert.equal(response.status, 405)
    assert.equal(response.headers.get('allow'), allowed)
    assert.deepEqual(await response.json(), methodError)
  }
  const head = await owner.raw(reads, { method: 'HEAD' })
  assert.equal(head.status, 405)
  assert.equal(await head.text(), '')
  for (const path of [reads, read(sid), usage(sid)]) {
    const isList = path === reads
    const body = isList ? undefined : path === read(sid) ? valid : meterBody
    const method = isList ? 'GET' : 'POST'
    for (const cookie of [null, `${owner.cookie}; ${owner.cookie}`, `${owner.cookie.split('=')[0]}=invalid`]) {
      assert.deepEqual(await owner.request(path, { method, body, status: 401, headers: { cookie } }), authError)
    }
    for (const headers of [{ origin: fx.providerOrigin }, { 'sec-fetch-site': 'cross-site' }]) {
      assert.deepEqual(await owner.request(path, { method, body, status: 403, headers }), originError)
    }
    assert.deepEqual(await owner.request(`${path}?extra=1`, { method, body, status: 400 }), { error: 'unexpected_query' })
    if (!isList) {
      for (const csrf of [null, 'wrong']) {
        assert.deepEqual(await owner.request(path, post(body, 401, { 'x-deva-csrf': csrf })), authError)
      }
      assert.deepEqual(await owner.request(path, post(body, 403, { origin: null })), originError)
      assert.deepEqual(await owner.request(path, post(body, 415, { 'content-type': 'text/plain' })), { error: 'json_required' })
      assert.deepEqual(await owner.request(path, post(body, 415, { 'content-encoding': 'gzip' })), { error: 'json_required' })
      assert.deepEqual(await owner.request(path, post(' '.repeat(80 * 1024) + JSON.stringify(body), 413)), { error: 'too_large' })
      for (const raw of ['[]', '{}', JSON.stringify({ ...body, extra: 1 })]) {
        const data = await owner.request(path, post(raw, 400))
        assert.equal(typeof data.error, 'string')
      }
    }
  }
  const cursor = JSON.stringify(valid.cursor)
  for (const raw of [
    `{"updatedAt":0,"updat\\u0065dAt":${valid.updatedAt},"cursor":${cursor}}`,
    `{"updatedAt":${valid.updatedAt},"cursor":{"seq":999,${cursor.slice(1)}}}`,
    `{"updatedAt":${valid.updatedAt},"cursor":${cursor},"cursor":${cursor}}`
  ]) {
    assert.deepEqual(await owner.request(read(sid), post(raw, 400)), { error: 'invalid_json' })
  }
  assert.deepEqual(await owner.request(usage(sid), post('{"model":"wrong","m\\u006fdel":null}', 400)), { error: 'invalid_json' })
  assert.deepEqual(await owner.request(reads), { entries: [] })
  assert.equal(fx.upstream.calls.length, 0)
})

test('logout of an original login during an authenticated read POST defeats its pending native write', bounds, async t => {
  const fx = await workbench(t)
  const { owner } = fx
  const tab = await fx.login()
  const sid = randomUUID()
  await fx.create(sid)
  const snap = await fx.complete(sid, (await fx.send(sid, 'revocation')).turnId)
  const payload = JSON.stringify(observed(snap)), path = `/api/v1/${read(sid)}`

  // Observe the real JSON reader starting after authentication; hold the final bytes on the wire.
  // This hook neither fakes the authentication service nor moves the commit point.
  const admitted = Promise.withResolvers()
  const iterator = IncomingMessage.prototype.iterator
  const trace = t.mock.method(IncomingMessage.prototype, 'iterator', function (...args) {
    if (this.url === path) admitted.resolve()
    return iterator.apply(this, args)
  })
  const transport = Promise.withResolvers()
  const req = httpRequest(`${fx.origin}${path}`, { method: 'POST', agent: false, signal: networkTimeout(), headers: {
    origin: fx.origin, cookie: owner.cookie, 'x-deva-csrf': owner.csrf,
    'content-type': 'application/json', 'content-length': Buffer.byteLength(payload)
  } }, res => {
    void (async () => {
      const chunks = []; for await (const chunk of res) chunks.push(chunk)
      return [res.statusCode, JSON.parse(Buffer.concat(chunks))]
    })().then(transport.resolve, transport.reject)
  })
  req.once('error', transport.reject)
  t.after(() => req.destroy())
  req.write(payload.slice(0, 1))
  assert.equal(await Promise.race([admitted.promise.then(() => 'reading'), transport.promise]), 'reading')
  trace.mock.restore()
  assert.deepEqual(await owner.request('auth/logout', post(undefined)), { ok: true })
  req.end(payload.slice(1))
  assert.deepEqual(await transport.promise, [401, authError])
  assert.deepEqual(await tab.request(reads), { entries: [entry(snap)] })
  await assert.rejects(stat(fx.readFilePath), { code: 'ENOENT' })
  assert.deepEqual(await tab.request(read(sid), post(observed(snap))), marked(snap))
  assert.equal(fx.upstream.calls.length, 1)
})

test('unsupported history and a broken native read map are surfaced without changing ordinary conversations', bounds, async t => {
  const [sid, unsupported] = Array.from({ length: 2 }, randomUUID)
  const privatePath = '/status-fixture/private-focus-root'
  const fx = await workbench(t, { async seed({ sessionFile }) {
    await writeJson(sessionFile(unsupported), { id: unsupported, title: 'Synthetic desktop-only chat',
      createdAt: 10, updatedAt: 11, focusRoot: privatePath,
      messages: [{ role: 'user', content: question }], members: [{ sessionId: sid }] })
  } })
  const { owner } = fx
  await fx.create(sid)
  const snap = await fx.complete(sid, (await fx.send(sid, 'unaffected-native')).turnId)
  const unsupportedSnap = await owner.request(chat(unsupported))
  assert.equal(unsupportedSnap.state.compatibility, 'unsupported')
  assert.deepEqual(await owner.request(read(unsupported), post(observed(unsupportedSnap), 409)), { error: 'unsupported_history' })
  assert.deepEqual(await owner.request(usage(unsupported), post({ model: null }, 409)), { error: 'unsupported_history' })
  assert.deepEqual(await owner.request(reads), { entries: [entry(snap)] })

  const broken = '{"truncated-map":';
  await fx.restart(() => writeFile(fx.readFilePath, broken, { mode: 0o600 }))
  const newLogin = await fx.login()
  const fresh = await newLogin.request(chat(sid))
  assert.deepEqual(fresh.state, snap.state)
  const error = await newLogin.request(reads, { status: 503 })
  assert.deepEqual(error, { error: 'read_state_unconfirmed' })
  assertPrivate(error, [privatePath, fx.readFilePath, 'truncated-map'])
  assert.deepEqual(await newLogin.request(read(sid), post(observed(fresh), 503)), error)
  assert.equal(await readFile(fx.readFilePath, 'utf8'), broken)
  assert.deepEqual((await newLogin.request(chat(sid))).state.messages.map(message => message.content), [question, reply])

  await writeJson(fx.readFilePath, {})
  const prior = await newLogin.request(chat(unsupported))
  const damaged = '{"incomplete-chat":'
  await writeFile(fx.sessionFile(unsupported), damaged)
  assert.deepEqual(await newLogin.request(usage(unsupported), post({ model: null }, 409)), { error: 'read_unavailable' })
  assert.deepEqual(await newLogin.request(read(unsupported), post(observed(prior), 409)), { error: 'read_unavailable' })
  assert.equal(await readFile(fx.sessionFile(unsupported), 'utf8'), damaged)
  assert.deepEqual(await newLogin.request(reads), { entries: [entry(fresh)] })
  assert.equal(fx.upstream.calls.length, 1)
})
