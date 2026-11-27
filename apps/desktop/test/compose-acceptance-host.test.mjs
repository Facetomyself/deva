import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { commandEnv, localDockerEndpoint, prepareSource, requireNativeHost } from './compose-acceptance-host.mjs'

const desktop = 'apps/desktop', runner = `${desktop}/test/verify-native-compose.mjs`, src = `${desktop}/src`
const included = ['Dockerfile', 'compose.yaml', `${src}/fixed`, `${desktop}/tsconfig.node.json`,
  `${desktop}/test/headless-compose-probe.mjs`, `${desktop}/test/headless-compose-docs-probe.mjs`]
const excluded = ['.env', `${src}/.env.local`, `${src}/test.pem`, `${src}/test.key`,
  'remote-deployment.yaml', `${desktop}/test/unrelated-fixture`]
const temp = fs.realpathSync('/tmp')
function verifyDir(dir, identity) {
  const st = fs.lstatSync(dir)
  assert.ok(path.dirname(dir) === temp && fs.realpathSync(dir) === dir && st.isDirectory() &&
    st.dev === identity.dev && st.ino === identity.ino && st.uid === process.getuid() && (st.mode & 0o777) === 0o700)
}
function repository(t, trackRunner = true) {
  const root = fs.mkdtempSync(path.join(temp, 'compose-host-test-')), identity = fs.lstatSync(root)
  t.after(() => { verifyDir(root, identity); fs.rmSync(root, { recursive: true }) })
  const env = { ...commandEnv(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    '-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
  const put = (file, contents = file) => {
    const target = path.join(root, file)
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, contents)
  }
  git('init', '-q')
  for (const file of [...included, ...excluded]) put(file)
  put('.gitignore', '*.local\n'); put('.gitattributes', 'Dockerfile export-ignore\n')
  if (trackRunner) put(runner)
  git('add', '--force', `${src}/.env.local`)
  git('add', '--all'); git('commit', '-qm', 'synthetic fixture')
  return { root, git, put }
}

test('native architecture, explicit local Unix endpoints, and the child environment allowlist', () => {
  requireNativeHost('linux', 'x64', 'x86_64')
  for (const args of [['darwin', 'x64', 'x86_64'], ['linux', 'arm64', 'aarch64'], ['linux', 'x64', 'aarch64']]) {
    assert.throws(() => requireNativeHost(...args), { message: 'native_linux_amd64_required' })
  }
  assert.equal(localDockerEndpoint({ DOCKER_HOST: 'unix:////run/user/1000/./docker.sock' }), 'unix:///run/user/1000/docker.sock')
  for (const DOCKER_HOST of ['ssh://docker.example', 'tcp://127.0.0.1:2375', 'npipe:////./pipe/docker_engine',
    'unix://host/run/docker.sock', 'unix:///run/../docker.sock', 'unix:///run/docker.sock?ignored', 'unix:///']) {
    assert.throws(() => localDockerEndpoint({ DOCKER_HOST }), /native_compose_local_unix_endpoint_required/u)
  }
  assert.throws(() => localDockerEndpoint({ DOCKER_HOST: 'unix:///run/docker.sock', DOCKER_CONTEXT: 'default' }), /ambiguous/u)
  assert.throws(() => localDockerEndpoint({ PATH: '/dev/null', DOCKER_CONTEXT: 'missing' }), /inspection_failed/u)
  const vars = { PATH: '/bin', HOME: '/home/test', DOCKER_CONFIG: '/conf', XDG_RUNTIME_DIR: '/run/user/1000' }
  assert.deepEqual(commandEnv({ ...vars, LANG: 'fr', DOCKER_HOST: 'tcp://other', DOCKER_CONTEXT: 'other',
    DOCKER_DEFAULT_PLATFORM: 'linux/arm64', DEVA_WEB_TOKEN: 'private', COMPOSE_FILE: 'remote.yaml',
    COMPOSE_PROJECT_NAME: 'deployed', COMPOSE_ENV_FILES: '.env', GITHUB_TOKEN: 'private', TMPDIR: '/checkout' }),
  { ...vars, LANG: 'C', COMPOSE_DISABLE_ENV_FILE: '1' })
  const cwd = process.cwd()
  assert.deepEqual(commandEnv({ PATH: 'bin::/usr/bin', HOME: 'home', XDG_RUNTIME_DIR: 'run', DOCKER_CONFIG: 'link/../config' }),
    { PATH: `${cwd}/bin:${cwd}:/usr/bin`, HOME: `${cwd}/home`, XDG_RUNTIME_DIR: `${cwd}/run`, DOCKER_CONFIG: `${cwd}/link/../config`,
      LANG: 'C', COMPOSE_DISABLE_ENV_FILE: '1' })
})

test('stage exact checked-in bytes and fixture outside checkout/context; replacement cleanup fails closed', (t) => {
  const { root, git, put } = repository(t)
  put(`${src}/untracked`); put(`${src}/ignored.local`)
  const prior = process.env.TMPDIR
  process.env.TMPDIR = root
  let stage
  try { stage = prepareSource(root) } finally { if (prior === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prior }
  const { sha, dir, work, snapshotFile, dispose } = stage
  t.after(dispose)
  assert.equal(sha, git('rev-parse', 'HEAD'))
  assert.equal(path.dirname(dir), path.dirname(root)); assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
  for (const file of included) assert.equal(fs.readFileSync(path.join(work, file), 'utf8'), file)
  for (const file of [...excluded, '.git', `${src}/ignored.local`, `${src}/untracked`, runner]) {
    assert.equal(fs.existsSync(path.join(work, file)), false, file)
  }
  assert.equal(path.dirname(snapshotFile), dir); assert.notEqual(path.dirname(snapshotFile), work)
  assert.equal(fs.statSync(snapshotFile).mode & 0o777, 0o444)
  assert.equal(createHash('sha256').update(fs.readFileSync(snapshotFile)).digest('hex'),
    '17abef945c4669dcd7d6162cd1dd65084490d4249b1b6c6b9b8bf477ba0879f5')
  const moved = `${dir}.moved`, identity = fs.lstatSync(dir)
  verifyDir(dir, identity); assert.equal(path.dirname(moved), temp); assert.ok(!fs.existsSync(moved))
  fs.renameSync(dir, moved); fs.mkdirSync(dir, { mode: 0o700 }); const replacement = fs.lstatSync(dir)
  try { assert.throws(dispose, /staging_identity_changed/u); assert.ok(fs.existsSync(dir)) }
  finally {
    verifyDir(dir, replacement); fs.rmdirSync(dir); verifyDir(moved, identity)
    assert.ok(!fs.existsSync(dir)); fs.renameSync(moved, dir)
  }
  dispose(); dispose(); assert.equal(fs.existsSync(dir), false)
  git('update-index', '--assume-unchanged', 'Dockerfile'); put('Dockerfile', 'dirty')
  assert.throws(() => prepareSource(root), /clean_tracked_checkout_required/u)
})

test('missing tracked runner and failed staging leave no extracted project', (t) => {
  const untracked = repository(t, false)
  untracked.put(runner)
  assert.throws(() => prepareSource(untracked.root), /runner_must_be_tracked/u)
  const { root } = repository(t)
  let stage
  const writeFile = t.mock.method(fs, 'writeFileSync', (file) => {
    stage = path.dirname(path.dirname(file))
    throw new Error('synthetic write failure with private data')
  })
  syncBuiltinESMExports()
  try { assert.throws(() => prepareSource(root), { message: 'native_compose_source_preparation_failed' }) }
  finally { writeFile.mock.restore(); syncBuiltinESMExports() }
  assert.ok(stage); assert.equal(fs.existsSync(stage), false)
})
