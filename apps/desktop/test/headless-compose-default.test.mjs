import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Inspect only the repository's default Compose manifest, never an operator's .env, overrides or engine.
test('the base Compose service grants the chat volume, not host projects', () => {
  const file = fileURLToPath(new URL('../../../compose.yaml', import.meta.url))
  const json = execFileSync('docker', ['compose', '--env-file', '/dev/null', '-f', file, '-p', 'deva-default-check',
    'config', '--format', 'json'], { encoding: 'utf8', timeout: 10000, env: {
      PATH: process.env.PATH, DOCKER_HOST: 'unix:///dev/null', COMPOSE_DISABLE_ENV_FILE: '1',
      DEVA_WEB_TOKEN: randomBytes(32).toString('hex'), DEVA_MODEL: 'fixture', DEVA_MODEL_BASE_URL: 'https://example.invalid/v1',
      DEVA_PROJECT_DOCS_SHA256: 'a'.repeat(64) // An ambient proposal variable is not a grant in the base manifest.
    } })
  const { services, volumes } = JSON.parse(json)
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
})
