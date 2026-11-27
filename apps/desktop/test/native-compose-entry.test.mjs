import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { machine } from 'node:os'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const runner = fileURLToPath(new URL('./verify-native-compose.mjs', import.meta.url))
// Deliberately unusable CLI path: help, bad arguments, wrong arch and remote endpoints must never reach Docker.
const env = { HOME: '/unused', PATH: '/unused-acceptance-path', DOCKER_HOST: 'ssh://example.invalid',
  DEVA_WEB_TOKEN: 'private-test-marker', COMPOSE_PROJECT_NAME: 'unrelated-operator-project' }
const invoke = args => spawnSync(process.execPath, [runner, ...args], { encoding: 'utf8', timeout: 5000, env })
test('operator help and argument errors cannot produce a successful native receipt', () => {
  const help = invoke(['--help']); assert.equal(help.status, 0); assert.equal(help.stderr, '')
  assert.match(help.stdout, /^Usage: .*verify-native-compose\.mjs /u); assert.ok(!help.stdout.includes('"status":"passed"'))
  for (const args of [['--platform', 'linux/amd64'], ['--preflight', '--skip-engine']]) {
    const invalid = invoke(args); assert.equal(invalid.status, 2); assert.equal(invalid.stdout, '')
    assert.deepEqual(JSON.parse(invalid.stderr), { status: 'failed', phase: 'arguments', reason: 'invalid_arguments' })
  }
})

test('a foreign host or remote context fails before an engine command or receipt', () => {
  const native = process.platform === 'linux' && process.arch === 'x64' && machine() === 'x86_64'
  const expected = native ? { phase: 'local_engine', reason: 'native_compose_local_unix_endpoint_required' } :
    { phase: 'native_host', reason: 'native_linux_amd64_required' }
  for (const args of [[], ['--preflight']]) {
    const denied = invoke(args); assert.equal(denied.status, 1); assert.equal(denied.stdout, '')
    assert.deepEqual(JSON.parse(denied.stderr), { status: 'failed', ...expected })
  }
})
