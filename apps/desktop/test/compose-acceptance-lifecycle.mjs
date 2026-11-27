import { request } from 'node:http'

const need = (condition, reason) => { if (!condition) throw Error(reason) }
const lines = s => s ? s.split('\n') : []

// Only inspect and clean this invocation's pre-checked random namespace, never a developer's Compose project.
async function resources(docker, project, cleanup = false) {
  need(/^deva-accept-[a-f0-9]{24}$/u.test(project), 'invalid_test_project')
  const opt = { cleanup }, tag = `${project}-deva:latest`, volume = `${project}_deva-data`, network = `${project}_default`
  const named = async (type, name) => lines(await docker([type, 'ls', '--filter', `name=${name}`, '--format', '{{.Name}}'], opt)).includes(name)
  return { tag, volume, network, hasVolume: await named('volume', volume), hasNetwork: await named('network', network),
    image: await docker(['image', 'ls', '-q', '--no-trunc', tag], opt), containers: lines(await docker(['container', 'ls', '-aq', '--no-trunc',
      '--filter', `label=com.docker.compose.project=${project}`], opt)) }
}
const empty = r => !r.hasVolume && !r.hasNetwork && !r.image && !r.containers.length
export async function checkUnused(docker, project) { need(empty(await resources(docker, project)), 'project_collision') }
export async function teardown(docker, compose, project, work, knownImage) {
  const r = await resources(docker, project, true), opt = { cleanup: true }
  const labels = async (type, id, field = '.Labels') => JSON.parse(await docker([type, 'inspect', '--format', `{{json ${field}}}`, id], opt)) ?? {}
  for (const id of r.containers) {
    const l = await labels('container', id, '.Config.Labels')
    need(l['com.docker.compose.project'] === project && l['com.docker.compose.service'] === 'deva' &&
      l['com.docker.compose.project.working_dir'] === work, 'cleanup_owner_unconfirmed')
  }
  for (const [type, present, name, key] of [['volume', r.hasVolume, r.volume, 'deva-data'], ['network', r.hasNetwork, r.network, 'default']]) {
    if (present) { const l = await labels(type, name); need(l['com.docker.compose.project'] === project && l[`com.docker.compose.${type}`] === key, 'cleanup_owner_unconfirmed') }
  }
  if (r.hasVolume || r.hasNetwork || r.containers.length) await compose(false, ['down', '--volumes', '--timeout', '10'], { ...opt, timeout: 80_000, quiet: true })
  if (r.image) {
    const current = await docker(['image', 'inspect', '--format', '{{.Id}}', r.tag], opt)
    const l = await labels('image', r.tag, '.Config.Labels')
    need(current === r.image && (current === knownImage || (l['com.docker.compose.project'] === project && l['com.docker.compose.service'] === 'deva')), 'cleanup_image_unconfirmed')
    await docker(['image', 'rm', r.tag], { ...opt, quiet: true }) // Untag exactly our name; never prune the shared build cache.
  }
  need(empty(await resources(docker, project, true)), 'cleanup_incomplete')
}

export async function publishedLogin(origin, token, previous, granted, signal) {
  function api(path, expected, { cookie, login } = {}) {
    // Direct IPv4 loopback, no redirect or environment proxy. Even the synthetic token stays local.
    return new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: new URL(origin).port, path, family: 4, agent: false,
        method: login ? 'POST' : 'GET', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
        headers: { ...(cookie && { Cookie: cookie }), ...(login && { Origin: origin, 'Content-Type': 'application/json' }) } }, async res => {
        try {
          need(res.statusCode === expected, 'published_http_status'); const chunks = []; let size = 0
          for await (const chunk of res) { size += chunk.length; need(size <= 16_384, 'published_response_limit'); chunks.push(chunk) }
          resolve({ data: JSON.parse(Buffer.concat(chunks).toString('utf8')), headers: res.headers })
        } catch (error) { res.destroy(); reject(error) }
      })
      req.on('error', () => reject(Error('published_http_unavailable'))); req.end(login ? JSON.stringify({ token }) : undefined)
    })
  }
  need((await api('/healthz', 200)).data.ok === true, 'published_health_failed')
  need((await api('/api/sessions', 401, { cookie: previous })).data.error === 'auth', 'old_login_not_rejected')
  const { headers, data } = await api('/api/login', 200, { login: true })
  const cookie = headers['set-cookie']?.length === 1 && headers['set-cookie'][0].split(';', 1)[0]
  need(data.ok === true && /^deva_web=[A-Za-z0-9_-]{43}$/u.test(cookie ?? '') && cookie !== previous, 'published_login_failed')
  const index = (await api('/api/sessions', 200, { cookie })).data
  need(index.model === 'deva-compose-fixture' && Array.isArray(index.sessions) &&
    (granted ? index.projectDocs === true : !Object.hasOwn(index, 'projectDocs')), 'published_grant_disagrees')
  return cookie // Only held between recreations; never part of a receipt or a CLI argument.
}
