import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import * as fs from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))
const exec = promisify(execFile)
const script = '/usr/bin/script'

async function fixture(t) {
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'deva-cli-'))
  const dataDir = join(root, 'data')
  const keyFile = join(root, 'keys', 'master.key')
  const runDir = join(root, 'run')
  const webDir = join(root, 'web')
  const children = []
  t.after(async () => {
    for (const { child, closed } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      await closed.catch(() => {})
    }
    await fs.rm(root, { recursive: true, force: true })
  })
  await fs.mkdir(join(root, 'keys'), { mode: 0o700 })
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DEVA_')))
  const run = (...args) => exec(process.execPath, [cli, ...args], { env, timeout: 10_000 })
  return { root, dataDir, keyFile, runDir, webDir, env, children, run }
}

function reply(port, origin, rawPath, payload) {
  const headers = { host: new URL(origin).host }
  if (payload !== undefined) { headers.origin = origin; headers['content-type'] = 'application/json' }
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: rawPath, headers, method: payload === undefined ? 'GET' : 'POST', agent: false }, res => {
      const bytes = []
      res.on('data', chunk => bytes.push(chunk))
      res.on('error', reject)
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(bytes)) }))
    })
    req.once('error', reject)
    req.end(payload === undefined ? undefined : JSON.stringify(payload))
  })
}

function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'` }

test('init-key validates existing raw key permissions and preserves a populated instance without its key', async t => {
  const paths = await fixture(t)
  const args = ['init-key', '--home', paths.dataDir, '--master-key-file', paths.keyFile]
  const env = { ...paths.env, DEVA_HOME: '/env-home-should-not-be-used', DEVA_MASTER_KEY_FILE: '/env-key-should-not-be-used' }
  const provision = (...extra) => exec(process.execPath, [cli, ...args, ...extra], { env, timeout: 10_000 })
  assert.equal((await provision()).stdout, 'Master key ready\n')
  const initial = await fs.readFile(paths.keyFile)
  assert.equal(initial.length, 32)
  assert.equal((await fs.stat(paths.keyFile)).mode & 0o777, 0o600)
  assert.equal((await provision('--if-missing')).stdout, 'Master key ready\n')
  assert.equal(initial.equals(await fs.readFile(paths.keyFile)), true)
  await assert.rejects(provision(), error => error.code === 1 && error.stderr.includes('already exists'))

  await fs.chmod(paths.keyFile, 0o640)
  await assert.rejects(provision('--if-missing'), error => error.code === 1 && error.stderr.includes('private permissions'))
  assert.equal(initial.equals(await fs.readFile(paths.keyFile)), true)
  await fs.chmod(paths.keyFile, 0o600)

  await fs.mkdir(paths.dataDir, { mode: 0o700 })
  await fs.writeFile(join(paths.dataDir, 'headless-vault.json'), 'fixture already persisted', { mode: 0o600 })
  await fs.rename(paths.keyFile, join(paths.root, 'master.saved'))
  await fs.chmod(paths.dataDir, 0o500)
  try {
    await assert.rejects(provision('--if-missing'), error => error.code === 1 && error.stderr.includes('restore its master key'))
    await assert.rejects(fs.lstat(paths.keyFile), { code: 'ENOENT' })
    assert.equal(await fs.readFile(join(paths.dataDir, 'headless-vault.json'), 'utf8'), 'fixture already persisted')
  } finally {
    await fs.chmod(paths.dataDir, 0o700)
  }
})

test('production serve accepts flag-over-env settings, claim is terminal-only, and SIGTERM releases socket and lock', { timeout: 25_000 }, async t => {
  const paths = await fixture(t)
  const ttyAvailable = await fs.access(script).then(() => true, () => false)
  await paths.run('init-key', '--home', paths.dataDir, '--master-key-file', paths.keyFile)
  await fs.mkdir(paths.webDir)
  await Promise.all([
    fs.writeFile(join(paths.webDir, 'index.html'), '<!doctype html><script type="module" src="./workbench.js"></script>'),
    fs.writeFile(join(paths.webDir, 'workbench.js'), 'export const hello = 1;'),
    fs.writeFile(join(paths.webDir, 'manifest.json'), JSON.stringify({ 'entry.ts': { file: 'workbench.js', isEntry: true } }))
  ])
  const publicUrl = 'https://example.invalid'
  const env = {
    ...paths.env, DEVA_HOME: join(paths.root, 'decoy'), DEVA_MASTER_KEY_FILE: join(paths.root, 'wrong.key'),
    DEVA_RUN_DIR: join(paths.root, 'wrong-run'), DEVA_WEB_DIR: join(paths.root, 'wrong-web'),
    DEVA_HOST: 'example.invalid', DEVA_PORT: '65536', DEVA_PUBLIC_URL: 'https://ignored.invalid',
    DEVA_PROVIDER_ORIGINS: 'http://127.0.0.1:20001, http://127.0.0.1:20002'
  }
  const serveArgs = [cli, 'serve', '--home', paths.dataDir, '--master-key-file', paths.keyFile, '--run-dir', paths.runDir,
    '--web-dir', paths.webDir, '--host', '127.0.0.1', '--port', '0', '--public-url', publicUrl]
  let log = ''
  async function start() {
    const child = spawn(process.execPath, serveArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    const closed = once(child, 'close')
    paths.children.push({ child, closed })
    child.stdout.on('data', bytes => { log += bytes })
    child.stderr.on('data', bytes => { log += bytes })
    const lines = createInterface({ input: child.stdout })
    const [line] = await Promise.race([once(lines, 'line', { signal: AbortSignal.timeout(10_000) }), closed])
    lines.close()
    const match = /^Workbench listening on 127\.0\.0\.1:(\d+) for https:\/\/example\.invalid$/.exec(line)
    assert.ok(match, 'the production child listener started and reported its selected origin')
    return { child, closed, port: Number(match[1]) }
  }
  const status = async () => JSON.parse((await exec(process.execPath, [cli, 'status'], {
    env: { ...paths.env, DEVA_RUN_DIR: paths.runDir }, timeout: 10_000
  })).stdout)
  const claimArgs = ['claim', '--run-dir', paths.runDir, '--public-url', publicUrl]
  const svc = await start()
  assert.deepEqual(await reply(svc.port, publicUrl, '/healthz'), { status: 200, body: { status: 'ready' } })
  assert.deepEqual(await status(), { claimed: false })
  assert.equal((await reply(svc.port, publicUrl, '/api/v1/settings')).status, 401)
  await assert.rejects(paths.run(...claimArgs), error => error.code === 1 && error.stdout === '' && error.stderr.includes('interactive terminal'))

  if (ttyAvailable) {
    const terminal = [process.execPath, cli, ...claimArgs].map(shellQuote).join(' ')
    const { stdout } = await exec(script, ['-q', '-e', '-c', terminal, '/dev/null'], { env: paths.env, timeout: 10_000 })
    const claimUrl = new URL(stdout.trim())
    assert.equal(claimUrl.origin, publicUrl)
    assert.equal(claimUrl.pathname, '/')
    assert.equal(claimUrl.search, '')
    assert.ok(/^#claim=[A-Za-z0-9_-]{43}$/.test(claimUrl.hash))
    const credential = claimUrl.hash.slice('#claim='.length)
    const claimed = await reply(svc.port, publicUrl, '/api/v1/auth/claim', { credential, password: 'a long CLI test passphrase' })
    assert.equal(claimed.status, 200)
    assert.deepEqual(await status(), { claimed: true })
    assert.equal(log.includes(credential), false)
  } else {
    t.diagnostic('No util-linux script command: terminal success is covered by the Unix control and HTTP suite.')
  }
  svc.child.kill('SIGTERM')
  assert.deepEqual(await svc.closed, [0, null])
  await assert.rejects(fs.lstat(join(paths.runDir, 'workbench-control.sock')), { code: 'ENOENT' })
  const restarted = await start()
  assert.deepEqual(await status(), { claimed: ttyAvailable })
  restarted.child.kill('SIGTERM')
  assert.deepEqual(await restarted.closed, [0, null])
  assert.equal(log.includes('#claim='), false)
})
