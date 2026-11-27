import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Render only the named manifests without reading a deployment's .env or connecting to an engine.
const base = fileURLToPath(new URL('../../../compose.yaml', import.meta.url))
const overlay = fileURLToPath(new URL('../../../compose.project-docs.yaml', import.meta.url))
const source = '/unused-deva-test/selected.json', digest = 'a'.repeat(64)
const env = { PATH: process.env.PATH, DOCKER_HOST: 'unix:///dev/null', COMPOSE_DISABLE_ENV_FILE: '1',
  DEVA_WEB_TOKEN: randomBytes(32).toString('hex'), DEVA_MODEL: 'fixture', DEVA_MODEL_BASE_URL: 'https://example.invalid/v1' }
function render(files, extra) {
  return JSON.parse(execFileSync('docker', ['compose', '--env-file', '/dev/null', ...files.flatMap(file => ['-f', file]),
    '-p', 'deva-default-check', 'config', '--format', 'json'], {
    encoding: 'utf8', timeout: 10000, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe']
  }))
}

test('the base Compose service grants the chat volume, not host projects', () => {
  const { services, volumes } = render([base], { DEVA_PROJECT_DOCS_SHA256: digest, DEVA_PROJECT_DOCS_FILE: source })
  assert.deepEqual(Object.keys(services), ['deva'])
  const service = services.deva
  assert.equal(service.read_only, true)
  assert.deepEqual(service.volumes.map(({ type, source, target }) => [type, source, target]), [['volume', 'deva-data', '/data']])
  assert.deepEqual(Object.keys(volumes), ['deva-data'])
  // A named local volume with bind driver options is still a host grant.
  const data = volumes['deva-data']
  assert.ok(!data.external && !Object.keys(data.driver_opts ?? {}).length && (!data.driver || data.driver === 'local'))
  assert.ok(!data.name || data.name === 'deva-default-check_deva-data')
  assert.ok(!service.volumes_from?.length && !service.configs?.length && !service.secrets?.length)
  assert.ok(!service.privileged && !service.devices?.length && !service.cap_add?.length)
  assert.deepEqual(service.cap_drop, ['ALL']); assert.ok(service.security_opt.includes('no-new-privileges:true'))
  assert.ok(!Object.hasOwn(service.environment, 'DEVA_PROJECT_DOCS_SHA256'))
  assert.ok(!Object.hasOwn(service.environment, 'DEVA_PROJECT_DOCS_FILE'))
})

test('only the explicit overlay passes a digest and one read-only leaf bind', () => {
  const files = [base, overlay], both = { DEVA_PROJECT_DOCS_FILE: source, DEVA_PROJECT_DOCS_SHA256: digest }
  for (const missing of Object.keys(both)) {
    const rest = { ...both }; delete rest[missing]
    assert.throws(() => render(files, rest), error => error.status !== 0 && error.stderr.includes(missing))
  }
  const plain = render([base], both), enabled = render(files, both)
  const service = enabled.services.deva
  assert.deepEqual(service.volumes, [...plain.services.deva.volumes, { type: 'bind', source,
    target: '/run/deva-project-docs/snapshot.json', read_only: true, bind: { create_host_path: false, propagation: 'rprivate' } }])
  assert.deepEqual(service.environment, { ...plain.services.deva.environment, DEVA_PROJECT_DOCS_SHA256: digest })
  // The optional grant must not otherwise widen the runtime configuration.
  assert.deepEqual({ ...service, volumes: plain.services.deva.volumes, environment: plain.services.deva.environment }, plain.services.deva)
  assert.deepEqual(Object.keys(enabled.services), ['deva']); assert.deepEqual(enabled.volumes, plain.volumes)
})
