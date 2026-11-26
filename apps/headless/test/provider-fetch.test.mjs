import assert from 'node:assert/strict'
import { once } from 'node:events'
import { gzipSync } from 'node:zlib'
import { createServer } from 'node:http'
import test from 'node:test'
import { allowedModelOrigins, providerFetch } from '../src/business/provider-fetch.mjs'

async function serve(t, fn) {
  const s = createServer(fn); s.listen(0, '127.0.0.1'); await once(s, 'listening')
  t.after(async () => { s.closeAllConnections(); await new Promise(ok => s.close(ok)) })
  return s.address().port
}

test('private models require an exact configured origin and one authorized DNS result set', async t => {
  const saw = []; const port = await serve(t, (req, res) => { saw.push(req.headers); res.writeHead(200, { 'content-encoding': 'gzip' }); res.end(gzipSync('fixture list')) })
  const origin = `http://model.test:${port}`; let lookups = 0
  const resolver = async () => { lookups++; return [{ address: '127.0.0.1', family: 4 }] }
  assert.throws(() => allowedModelOrigins(`${origin}/other`)); assert.throws(() => providerFetch({ baseURL: origin }))
  const fetchModel = providerFetch({ baseURL: `${origin}/v1`, allowedOrigins: [origin], resolveHost: resolver })
  const r = await fetchModel(`${origin}/v1/models`, { headers: { authorization: 'Bearer fixture', cookie: 'ignored', host: 'other.example', 'x-forwarded-for': 'ignored' } })
  assert.equal(await r.text(), 'fixture list'); assert.equal(lookups, 1); assert.equal(saw[0].host, `model.test:${port}`)
  assert.equal(saw[0].authorization, 'Bearer fixture'); assert.equal(saw[0].cookie, undefined); assert.equal(saw[0]['x-forwarded-for'], undefined)
  await assert.rejects(fetchModel(`http://127.0.0.1:${port}/v1/models`), { code: 'ERR_PROVIDER_EGRESS' })
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '::ffff:127.0.0.1', 'fe80::1', '2002:7f00:1::1']) {
    const f = providerFetch({ baseURL: 'https://model.test/v1', resolveHost: async () => [{ address: '8.8.8.8', family: 4 }, { address, family: address.includes(':') ? 6 : 4 }] })
    await assert.rejects(f('https://model.test/v1/models'), { code: 'ERR_PROVIDER_EGRESS' })
  }
  const privateRoute = providerFetch({ baseURL: origin, allowedOrigins: [origin], resolveHost: async () => [{ address: '169.254.169.254', family: 4 }] })
  await assert.rejects(privateRoute(origin), { code: 'ERR_PROVIDER_EGRESS' })
  assert.equal(saw.length, 1)
  const withVaultCookie = providerFetch({ baseURL: origin, allowedOrigins: [origin], resolveHost: resolver, configuredCookie: 'tenant=fixture' })
  await (await withVaultCookie(origin, { headers: { cookie: 'incoming-cookie-must-be-dropped' } })).arrayBuffer()
  assert.equal(saw[1].cookie, 'tenant=fixture')
})

test('redirects are never retried; decoded response bytes are bounded', async t => {
  let follow = 0
  const port = await serve(t, (req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: '/' }); return res.end() }
    if (req.url === '/large') { res.writeHead(200, { 'content-encoding': 'gzip' }); return res.end(gzipSync('a'.repeat(512))) }
    follow++; res.end()
  })
  const o = `http://127.0.0.1:${port}`; const f = providerFetch({ baseURL: o, allowedOrigins: [o], maxBytes: 32 })
  await assert.rejects(f(o + '/redirect'), { code: 'ERR_PROVIDER_EGRESS' }); assert.equal(follow, 0)
  const r = await f(o + '/large'); await assert.rejects(r.text(), /size limit/)
})

test('abort also stops a pending resolution before any connection is attempted', async () => {
  const ctrl = new AbortController()
  const f = providerFetch({ baseURL: 'https://model.test', resolveHost: () => new Promise(() => {}) })
  const promise = f('https://model.test/v1/models', { signal: ctrl.signal }); ctrl.abort()
  await assert.rejects(promise, { name: 'AbortError' })
})
