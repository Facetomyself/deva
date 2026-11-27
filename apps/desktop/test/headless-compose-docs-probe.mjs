// Invoked inside the already-built CI image with the fixed synthetic snapshot, then without a grant.
import assert from 'node:assert/strict'
const { DEVA_ORIGIN: origin, DEVA_SMOKE_SESSION: sid, DEVA_REVOKED_DOC: old } = process.env
assert.equal(process.env.DEVA_MODEL, 'deva-compose-fixture')
assert.equal(process.env.DEVA_MODEL_BASE_URL, 'http://127.0.0.1:18795/v1')
assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/u); assert.match(sid, /^web_[a-f0-9-]{36}$/u)
let cookie
async function api(path, status, body) {
  const response = await fetch(`${origin}/api/${path}`, { redirect: 'error', signal: AbortSignal.timeout(5000),
    method: body ? 'POST' : 'GET', body: body && JSON.stringify(body),
    headers: { ...(cookie && { cookie }), ...(body && { Origin: origin, 'Content-Type': 'application/json' }) } })
  assert.equal(response.status, status); assert.equal(response.headers.get('cache-control'), 'no-store')
  return [await response.json(), response.headers]
}
await api('project-docs', 401)
const [, headers] = await api('login', 200, { token: process.env.DEVA_WEB_TOKEN })
cookie = headers.get('set-cookie').split(';')[0]
const [index] = await api('sessions', 200), [before] = await api(`sessions/${sid}`, 200)
if (!old) {
  assert.equal(index.projectDocs, true)
  const [list] = await api('project-docs', 200), { generation, documents } = list
  const id = documents[0].id, text = '首次使用：先阅读版本说明。\n'
  assert.match(generation, /^[0-9a-f]{32}$/u); assert.match(id, /^[0-9a-f]{32}$/u)
  assert.deepEqual(list, { project: '发布手册', generation, documents: [{ id, name: '入门.md', bytes: 40 }] })
  const link = `${generation}/${id}`
  assert.deepEqual((await api(`project-docs/${link}`, 200))[0], { generation, id, name: '入门.md', bytes: 40, text })
  assert.equal((await api('project-docs', 405, {}))[1].get('allow'), 'GET')
  console.log(link) // Synthetic IDs for checking revocation; never an authentication cookie.
} else {
  assert.match(old, /^[0-9a-f]{32}\/[0-9a-f]{32}$/u); assert.ok(!Object.hasOwn(index, 'projectDocs'))
  assert.deepEqual((await api('project-docs', 404))[0], { error: 'missing' })
  assert.deepEqual((await api(`project-docs/${old}`, 404))[0], { error: 'missing' })
}
assert.deepEqual((await api(`sessions/${sid}`, 200))[0], before)
