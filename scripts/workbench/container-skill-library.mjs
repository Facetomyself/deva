// Native hosted Linux/amd64 gate. Requires only Node, the local Docker socket, and the prebuilt tag.
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdtemp, realpath, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeProgram } from './container-skill-library-probe.mjs'

const tag = 'deva-workbench:skills-verify'
const cli = '/opt/deva/apps/headless/src/cli.mjs'
const project = `deva-skill-ci-${randomUUID()}`
const labelKey = 'deva.workbench.skill-library-ci'
const label = `${labelKey}=${project}`
const names = Object.fromEntries(['data', 'keys', 'init', 'first', 'second'].map(kind => [kind, `${project}-${kind}`]))
const ids = new Map(), volumes = new Map(), volumeTokens = new Map()
const fullId = /^[a-f0-9]{64}$/u
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const lines = text => text.split('\n').filter(Boolean)
class Failure extends Error {}
function check(ok, message) { if (!ok) throw new Failure(message) }
let root, rootIdentity, image, stage = 'runner preflight'

function docker(args, { input, logs = false } = {}) {
  return new Promise((resolve, reject) => {
    // Ignore the runner's Docker contexts, default credential stores, proxies and CI environment.
    const child = execFile('docker', ['--host=unix:///var/run/docker.sock', ...args], {
      env: { PATH: '/usr/bin:/bin:/usr/local/bin', LANG: 'C.UTF-8', DOCKER_CONFIG: root }, cwd: root,
      encoding: 'utf8', timeout: 45_000, maxBuffer: 512 * 1024
    }, (error, out, err) => {
      if (!error) return resolve(logs ? (out + err).trim() : out.trim())
      // Arguments, output and thrown causes can contain private probe data. Expose only fixed phase labels.
      const probe = /^skill-library probe: ([a-z-]{1,32})$/mu.exec(err)?.[1]
      const cause = error.code === 'ENOENT' ? 'Docker executable missing' : error.killed ? 'Docker command timed out' : 'Docker command failed'
      reject(new Failure(probe ? `probe failed at ${probe}` : `${args[0]}: ${cause}`))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input))
  })
}
async function inspect(kind, id) {
  const result = JSON.parse(await docker([kind, 'inspect', id]))
  check(Array.isArray(result) && result.length === 1, `Expected one ${kind}`)
  return result[0]
}
const listContainers = filter => docker(['container', 'ls', '-aq', '--no-trunc', '--filter', filter]).then(lines)
const listVolumes = filter => docker(['volume', 'ls', '-q', '--filter', filter]).then(lines)
const containerName = kind => `name=^/${names[kind]}$`

async function ownedVolume(kind) {
  const name = names[kind], volume = await inspect('volume', name)
  const signature = [volume.CreatedAt, volume.Mountpoint]
  check(volume.Name === name && volume.Labels?.[labelKey] === project && volume.Labels?.[labelKey + '.volume'] === volumeTokens.get(kind) &&
    volume.Driver === 'local' && volume.Scope === 'local' && !Object.keys(volume.Options ?? {}).length &&
    Number.isFinite(Date.parse(signature[0])) && signature[1]?.startsWith('/') &&
    (!volumes.has(kind) || same(volumes.get(kind), signature)), 'Volume identity changed')
  return signature
}
async function createVolume(kind) {
  const name = names[kind]
  check(!(await listVolumes(`name=^${name}$`)).length, 'Volume name already exists')
  const token = randomUUID()
  volumeTokens.set(kind, token)
  check(await docker(['volume', 'create', '--driver', 'local', '--label', label, '--label', `${labelKey}.volume=${token}`, name]) === name,
    'Volume creation was unconfirmed')
  volumes.set(kind, await ownedVolume(kind))
}
async function ownedContainer(id) {
  check(fullId.test(id), 'Invalid container ID')
  const meta = await inspect('container', id)
  const kind = ['init', 'first', 'second'].find(key => meta.Name === '/' + names[key])
  check(kind && meta.Id === id && meta.Image === image.Id && meta.Config.Labels?.[labelKey] === project &&
    (!ids.has(kind) || ids.get(kind) === id), 'Container identity changed')
  return meta
}
const mount = (kind, ro) => `type=volume,src=${names[kind]},dst=/${kind}${ro ? ',readonly' : ''}`
async function createContainer(kind) {
  const init = kind === 'init'
  check(!(await listContainers(containerName(kind))).length, 'Container name already exists')
  await ownedVolume('data'); await ownedVolume('keys')
  const id = await docker(['create', '--name', names[kind], '--label', label, '--platform', 'linux/amd64',
    '--network', 'none', '--user', '1000:1000', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--init=false', '--pids-limit', '128', '--log-driver', 'local',
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,mode=1777,size=64m',
    '--tmpfs', '/run/deva:rw,nosuid,nodev,noexec,mode=0700,uid=1000,gid=1000,size=4m',
    '--mount', mount('data', init), '--mount', mount('keys', !init), image.Id, ...(init ? ['init-key'] : [])])
  check(fullId.test(id), 'Container creation was unconfirmed')
  check(![...ids.values()].includes(id), 'Container ID was reused')
  ids.set(kind, id)
  const m = await ownedContainer(id), h = m.HostConfig
  await ownedVolume('data'); await ownedVolume('keys')
  check(m.Path === 'node' && same(m.Args, [cli, init ? 'init-key' : 'serve']) && same(m.Config.Env, image.Config.Env) &&
    m.Config.User === '1000:1000' && h.NetworkMode === 'none' && h.ReadonlyRootfs && !h.Privileged &&
    same(h.CapDrop, ['ALL']) && !h.CapAdd?.length && h.SecurityOpt.includes('no-new-privileges:true') &&
    !h.PublishAllPorts && !Object.keys(h.PortBindings ?? {}).length && !h.Binds?.length && !h.VolumesFrom?.length &&
    !h.Devices?.length && !h.DeviceRequests?.length, 'Container isolation or default command differs')
  const mounts = m.Mounts.filter(v => v.Type === 'volume')
  check(mounts.length === 2 && ['data', 'keys'].every(key => mounts.some(v => v.Name === names[key] && v.Destination === '/' + key &&
    v.Driver === 'local' && v.Source === volumes.get(key)[1] && v.RW === (key === 'data' ? !init : init))) &&
    m.Mounts.every(v => v.Type === 'volume' || (v.Type === 'tmpfs' && Object.hasOwn(h.Tmpfs, v.Destination))), 'Unexpected container mounts')
  return id
}
async function removeContainer(id, kind) {
  const before = await ownedContainer(id)
  if (before.State.Running) await docker(['stop', '--time', '12', id])
  const after = await ownedContainer(id)
  check(!after.State.Running, 'Owned container is still running')
  if (kind) check(after.State.Status === 'exited' && after.State.ExitCode === 0 && !after.State.OOMKilled, 'Production CLI did not close cleanly')
  if (kind && kind !== 'init') {
    // An exact benign banner also catches credentials in either app log stream without exposing them.
    check(await docker(['logs', id], { logs: true }) === 'Workbench listening on 127.0.0.1:8787 for http://127.0.0.1:8787',
      'Unexpected production CLI log output')
  }
  await docker(['rm', id])
  if (kind) check(!(await listContainers(containerName(kind))).length, 'Stopped container was not removed')
}
async function runProbe(kind, input) {
  const id = await createContainer(kind)
  await docker(['start', id])
  check((await ownedContainer(id)).State.Running, 'Production CLI is not running')
  const result = JSON.parse(await docker(['exec', '-i', id, 'node', '--input-type=module', '--eval', probeProgram, kind], { input }))
  await removeContainer(id, kind)
  return result
}
async function cleanup() {
  let failed = false
  if (volumeTokens.size) {
    for (const id of await listContainers('label=' + label).catch(() => { failed = true; return [] })) {
      try { await removeContainer(id) } catch { failed = true }
    }
    for (const name of await listVolumes('label=' + label).catch(() => { failed = true; return [] })) {
      try {
        const kind = ['data', 'keys'].find(key => names[key] === name)
        check(kind && volumeTokens.has(kind), 'Unrecognized owned volume')
        await ownedVolume(kind)
        await docker(['volume', 'rm', name])
      } catch { failed = true }
    }
    check(!failed && !(await listContainers('label=' + label)).length && !(await listVolumes('label=' + label)).length &&
      !(await Promise.all([...ids.keys()].map(key => listContainers(containerName(key))))).flat().length &&
      !(await Promise.all([...volumeTokens.keys()].map(key => listVolumes(`name=^${names[key]}$`)))).flat().length, 'Docker cleanup unconfirmed')
  }
}
async function main() {
  check(process.argv.length === 2 && process.platform === 'linux' && process.arch === 'x64' && process.getuid() > 0, 'Expected nonroot Linux/amd64 runner')
  root = await mkdtemp(join(await realpath(tmpdir()), 'deva-skill-docker-'))
  rootIdentity = await lstat(root, { bigint: true })
  const server = JSON.parse(await docker(['version', '--format', '{{json .Server}}']))
  check(server.Os === 'linux' && server.Arch === 'amd64', 'Expected a native Linux/amd64 Docker Engine')
  const built = await inspect('image', tag)
  check(built.Os === 'linux' && built.Architecture === 'amd64' && /^sha256:[a-f0-9]{64}$/u.test(built.Id) &&
    Number.isSafeInteger(built.Size) && built.Size > 0 && same(built.Config.Entrypoint, ['node', cli]) && same(built.Config.Cmd, ['serve']) &&
    built.Config.Env.includes('NODE_ENV=production') && same(built.Config.Env.filter(v => v.startsWith('DEVA_')).sort(), [
      'DEVA_HOME=/data', 'DEVA_HOST=127.0.0.1', 'DEVA_MASTER_KEY_FILE=/keys/master.key', 'DEVA_PORT=8787',
      'DEVA_RUN_DIR=/run/deva', 'DEVA_WEB_DIR=/opt/deva/web']), 'Expected the prebuilt production runtime image')
  image = built
  stage = 'provision private volumes and key'
  await createVolume('data'); await createVolume('keys')
  const init = await createContainer('init')
  check(await docker(['start', '--attach', init]) === 'Master key ready', 'CLI master key initialization unconfirmed')
  await removeContainer(init, 'init')
  stage = 'first production container'
  const first = await runProbe('first', {})
  stage = 'recreated production container'
  const second = await runProbe('second', first)
  check(second?.verified === true && ids.get('first') !== ids.get('second'), 'Recreation was unconfirmed')
}
let passed = false
try { await main(); passed = true }
catch (error) { console.error(`Skill library image gate (${stage}): ${error instanceof Failure ? error.message : 'verification failed'}`) }
try { await cleanup() }
catch { passed = false; console.error('Skill library Docker cleanup unconfirmed') }
try {
  if (root) {
    const now = await lstat(root, { bigint: true })
    check(await realpath(root) === root && now.isDirectory() && now.ino === rootIdentity?.ino && now.dev === rootIdentity?.dev &&
      now.uid === BigInt(process.getuid()) && (now.mode & 0o777n) === 0o700n, 'Docker configuration directory identity changed')
    await rmdir(root) // Private empty configuration directory only; no recursive deletion.
  }
} catch { passed = false; console.error('Skill library private directory cleanup unconfirmed') }
if (passed) console.log(`PASS skill library ${image.Id} (${image.Size} bytes, linux/amd64); CLI ${ids.get('first').slice(0, 12)} → ${ids.get('second').slice(0, 12)}; authenticated native persistence, stale cookie revoked, packaged web/CSP; zero residual owned containers or volumes.`)
else process.exitCode = 1
