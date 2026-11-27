import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { checkUnused, publishedLogin, teardown } from './compose-acceptance-lifecycle.mjs'

const project = `deva-accept-${'2'.repeat(24)}`, work = '/synthetic/work', image = `sha256:${'3'.repeat(64)}`
// Command recorder for the cleanup boundary only. It cannot build, run, or issue an acceptance receipt.
function registry(foreign) {
  const container = '4'.repeat(64), volume = `${project}_deva-data`, network = `${project}_default`, tag = `${project}-deva:latest`
  let objects = true, tagged = true
  const changed = []
  async function docker([type, op, ...args]) {
    if (op === 'ls') return ({ container: objects ? container : '', network: objects ? network : '', volume: objects ? volume : '', image: tagged ? image : '' })[type]
    if (op === 'inspect') {
      if (args.includes('{{.Id}}')) return foreign === 'image' ? `sha256:${'5'.repeat(64)}` : image
      return JSON.stringify({ 'com.docker.compose.project': type === foreign ? 'unrelated' : project, 'com.docker.compose.volume': 'deva-data',
        'com.docker.compose.network': 'default', 'com.docker.compose.service': 'deva', 'com.docker.compose.project.working_dir': work })
    }
    assert.deepEqual([type, op, ...args], ['image', 'rm', tag]); changed.push(tag); tagged = false; return ''
  }
  async function compose(granted, args, options) {
    assert.ok(!granted && options.cleanup); assert.deepEqual(args, ['down', '--volumes', '--timeout', '10'])
    changed.push('test-project-down'); objects = false
  }
  return { docker, compose, changed, tag }
}

test('cleanup refuses foreign resources, and only removes the exact checked image tag', async () => {
  for (const owner of ['container', 'network', 'volume', 'image', undefined]) {
    const r = registry(owner)
    await assert.rejects(() => checkUnused(r.docker, project), { message: 'project_collision' })
    await assert.rejects(() => teardown(r.docker, r.compose, 'main', work, image), { message: 'invalid_test_project' })
    if (owner) {
      await assert.rejects(() => teardown(r.docker, r.compose, project, work, image),
        { message: owner === 'image' ? 'cleanup_image_unconfirmed' : 'cleanup_owner_unconfirmed' })
      assert.deepEqual(r.changed, owner === 'image' ? ['test-project-down'] : [])
    } else {
      await teardown(r.docker, r.compose, project, work, image); assert.deepEqual(r.changed, ['test-project-down', r.tag])
      await checkUnused(r.docker, project)
    }
  }
})

test('host-side login crosses real loopback HTTP and rejects reuse of the previous cookie', async () => {
  const token = randomBytes(32).toString('hex'); let cookie = '', granted = false, origin
  const server = createServer(async (req, res) => {
    if (req.url === '/healthz') return res.end('{"ok":true}')
    if (req.method === 'POST' && req.url === '/api/login') {
      let raw = ''; for await (const chunk of req) raw += chunk
      if (req.headers.origin !== origin || JSON.parse(raw).token !== token) return res.writeHead(403).end('{}')
      cookie = `deva_web=${randomBytes(32).toString('base64url')}`
      return res.writeHead(200, { 'Set-Cookie': cookie + '; HttpOnly' }).end('{"ok":true}')
    }
    if (!cookie || req.headers.cookie !== cookie) return res.writeHead(401).end('{"error":"auth"}')
    res.end(JSON.stringify({ model: 'deva-compose-fixture', sessions: [], ...(granted && { projectDocs: true }) }))
  })
  await once(server.listen(0, '127.0.0.1'), 'listening'); origin = `http://127.0.0.1:${server.address().port}`
  try {
    const first = await publishedLogin(origin, token, undefined, false); assert.equal(first, cookie)
    await assert.rejects(() => publishedLogin(origin, token, first, true), { message: 'published_http_status' })
    cookie = ''; granted = true
    const second = await publishedLogin(origin, token, first, true); assert.notEqual(second, first)
    cookie = ''; granted = false; assert.equal(await publishedLogin(origin, token, second, false), cookie)
  } finally { const done = once(server, 'close'); server.close(); server.closeAllConnections(); await done }
})
