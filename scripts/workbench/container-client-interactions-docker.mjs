import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export class CheckFailure extends Error {}
export function check(condition, message) {
  if (!condition) throw new CheckFailure(message)
}

const image = 'deva-workbench:client-verify'
const labelKey = 'deva.workbench.client-interactions-ci'
const cli = '/opt/deva/apps/headless/src/cli.mjs'
const innerPort = '8787/tcp'
const loopback = '127.0.0.1'
const cid = /^[0-9a-f]{64}$/
const noArgs = value => !value?.length

export async function privateRoot() {
  const parent = await realpath(tmpdir())
  const prefix = join(parent, 'deva-client-image-')
  const path = await mkdtemp(prefix)
  const original = await lstat(path, { bigint: true })
  async function verify() {
    const current = await lstat(path, { bigint: true })
    check(path.startsWith(prefix) && path.length === prefix.length + 6 && dirname(path) === parent &&
      await realpath(path) === path && current.isDirectory() && current.dev === original.dev && current.ino === original.ino &&
      current.uid === BigInt(process.geteuid()) && (current.mode & 0o777n) === 0o700n, 'Test directory identity or mode changed')
  }
  await verify()
  return { path, async remove() { await verify(); await rm(path, { recursive: true }) } }
}

export async function choosePort() {
  // Reserve a kernel-chosen loopback port long enough to learn it. Docker must bind that
  // exact port when it starts; a racing listener causes startup failure, not a new origin.
  const server = createServer()
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, loopback, resolve))
  const { port } = server.address()
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

export function productionDocker(root) {
  const identity = `deva-client-ci-${randomBytes(16).toString('hex')}`
  const label = `${labelKey}=${identity}`
  const data = `${identity}-data`, keys = `${identity}-keys`
  const names = Object.fromEntries(['key', 'seed', 'serve'].map(kind => [kind, `${identity}-${kind}`]))
  const volumeNames = new Set([data, keys])
  const containerNames = new Set(Object.values(names))
  const containerIds = new Map()
  let pinnedImage, ownsResources = false

  // No inherited daemon/context, proxies, Docker credentials, or host env forwarded to the image.
  // Docker is used only over the local Unix socket; it is never mounted into a container.
  function docker(args, step, { input, timeout = 30_000 } = {}) {
    return new Promise((resolve, reject) => {
      const child = execFile('docker', ['--host=unix:///var/run/docker.sock', ...args], {
        cwd: root, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', DOCKER_CONFIG: root },
        encoding: 'utf8', maxBuffer: 256 * 1024, timeout
      }, (error, stdout) => {
        if (!error) return resolve(stdout.trim())
        // Some exec stdout transfers a claim; neither it nor raw stderr/args can reach CI logs.
        const cause = error.code === 'ENOENT' ? 'Docker executable missing' : error.killed ? 'Docker command timed out' : 'Docker command failed'
        reject(new CheckFailure(`${step}: ${cause}`))
      })
      child.stdin.on('error', () => {})
      child.stdin.end(input === undefined ? undefined : JSON.stringify(input))
    })
  }

  async function inspect(kind, target) {
    const result = JSON.parse(await docker([kind, 'inspect', target], `Inspect ${kind}`))
    check(Array.isArray(result) && result.length === 1, `Expected one ${kind} inspection`)
    return result[0]
  }

  async function ownedContainer(id) {
    check(cid.test(id), 'Invalid container identifier')
    const meta = await inspect('container', id)
    const name = meta.Name?.slice(1)
    check(meta.Name === `/${name}` && containerNames.has(name) && meta.Id === id && meta.Image === pinnedImage &&
      meta.Config.Labels?.[labelKey] === identity && (!containerIds.has(name) || containerIds.get(name) === id), 'Container ownership check failed')
    return meta
  }

  async function ownedVolume(name) {
    check(volumeNames.has(name), 'Unrecognized volume name')
    const meta = await inspect('volume', name)
    check(meta.Name === name && meta.Labels?.[labelKey] === identity && meta.Driver === 'local' && meta.Scope === 'local' &&
      !Object.keys(meta.Options ?? {}).length, 'Volume ownership check failed')
  }

  async function init() {
    const version = JSON.parse(await docker(['version', '--format', '{{json .Server}}'], 'Connect to local Docker Engine'))
    // Engine <28 had a same-L2 localhost publication leak. Fail closed rather than using it.
    check(version?.Os === 'linux' && version.Arch === 'amd64' && Number(/^([0-9]+)\./.exec(version.Version)?.[1]) >= 28,
      'Need local Linux/amd64 Docker Engine 28 or newer for loopback publication')
    check(await docker(['info', '--format', '{{.CgroupVersion}}'], 'Check local Docker cgroup version') === '2', 'Need Docker with cgroup v2')
    const built = await inspect('image', image)
    check(built.Os === 'linux' && built.Architecture === 'amd64' && /^sha256:[a-f0-9]{64}$/.test(built.Id) &&
      JSON.stringify(built.Config.Entrypoint) === JSON.stringify(['node', cli]) && built.Config.Env.includes('NODE_ENV=production'),
    'Expected the production Linux/amd64 runtime image and real CLI entrypoint')
    pinnedImage = built.Id // Use this immutable ID in all subsequent invocations.
    ownsResources = true
    for (const name of volumeNames) {
      check(await docker(['volume', 'ls', '-q', '--filter', `name=^${name}$`], 'Check fresh volume name') === '', 'Test volume name already exists')
      await docker(['volume', 'create', '--driver', 'local', '--label', label, name], 'Create isolated named volume')
      await ownedVolume(name)
    }
    return { id: built.Id, bytes: built.Size }
  }

  function limits(kind) {
    return ['--name', names[kind], '--label', label, '--platform', 'linux/amd64', '--user', '1000:1000', '--read-only',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--cgroupns', 'private', '--pids-limit', '128', '--memory', '512m', '--cpus', '2',
      '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,mode=1777,size=64m',
      '--tmpfs', '/run/deva:rw,nosuid,nodev,noexec,mode=0700,uid=1000,gid=1000,size=4m']
  }

  function volume(name, dest, readOnly = false) {
    return ['--mount', `type=volume,source=${name},destination=${dest}${readOnly ? ',readonly' : ''}`]
  }

  async function create(kind, options, command) {
    const value = await docker(['create', ...limits(kind), ...options, pinnedImage, ...command], `Create ${kind} container`)
    check(cid.test(value), 'Expected Docker container ID')
    containerIds.set(names[kind], value)
    return value
  }

  async function prepare(seedProgram, fixture) {
    const key = await create('key', ['--network', 'none', ...volume(data, '/data', true), ...volume(keys, '/keys')], ['init-key', '--if-missing'])
    check(await docker(['start', '--attach', key], 'Initialize production master key') === 'Master key ready', 'Master key initialization unconfirmed')
    const seed = await create('seed', ['--network', 'none', '--interactive', '--entrypoint', 'node', ...volume(data, '/data')],
      ['--input-type=module', '--eval', seedProgram])
    return JSON.parse(await docker(['start', '--attach', '--interactive', seed], 'Seed one ordinary native text history', { input: fixture }))
  }

  function verifyServing(meta, port) {
    const host = meta.HostConfig
    const declared = host.PortBindings
    const live = meta.NetworkSettings.Ports
    const expectedOrigin = `${loopback}:${port}`
    const oneLoopbackPort = ports => Object.keys(ports ?? {}).length === 1 && ports[innerPort]?.length === 1 &&
      ports[innerPort][0].HostIp === loopback && ports[innerPort][0].HostPort === String(port)
    check(host.NetworkMode === 'bridge' && Object.keys(meta.NetworkSettings.Networks).join() === 'bridge' &&
      oneLoopbackPort(declared) && oneLoopbackPort(live) && host.PublishAllPorts === false &&
      meta.Config.Env.includes(`DEVA_PUBLIC_URL=http://${expectedOrigin}`), 'Expected the sole Docker publication on the exact host IPv4 loopback origin')
    check(meta.State.Running && host.Init === true && meta.Config.User === '1000:1000' && host.ReadonlyRootfs === true && host.Privileged === false &&
      host.CapDrop?.includes('ALL') && noArgs(host.CapAdd) && host.SecurityOpt?.includes('no-new-privileges:true') &&
      host.NanoCpus === 2e9 && host.Memory === 512 * 1024 * 1024 && host.PidsLimit === 128 &&
      host.CgroupnsMode === 'private' && ![host.PidMode, host.IpcMode, host.UTSMode].includes('host') &&
      noArgs(host.Binds) && noArgs(host.VolumesFrom) && noArgs(host.Devices) && noArgs(host.DeviceRequests) &&
      meta.Config.Env.includes('DEVA_PROVIDER_ORIGINS=') && !meta.Config.Env.some(item => /^DEVA_(?:WORKSPACE|BROWSER|GIT)_/.test(item)),
    'Runtime security, resource or upstream restrictions differ from the QA contract')
    const permitted = { '/data': [data, true], '/keys': [keys, false] }
    const tmpfs = host.Tmpfs ?? {}
    const mountedVolumes = meta.Mounts.filter(mount => mount.Type === 'volume')
    check(Object.keys(tmpfs).sort().join() === '/run/deva,/tmp' && Object.values(tmpfs).every(x => /(?:^|,)nosuid,nodev,noexec(?:,|$)/.test(x)) &&
      meta.Mounts.filter(mount => mount.Type !== 'volume').every(mount => mount.Type === 'tmpfs' && Object.hasOwn(tmpfs, mount.Destination)) &&
      mountedVolumes.length === 2 && mountedVolumes.every(mount => mount.Driver === 'local' &&
        permitted[mount.Destination]?.[0] === mount.Name && permitted[mount.Destination][1] === mount.RW) &&
      new Set(meta.Mounts.map(mount => mount.Destination)).size === meta.Mounts.length, 'Unexpected mount or host device/socket access')
  }

  async function serve(port) {
    const id = await create('serve', ['--init', '--network', 'bridge', '--publish', `${loopback}:${port}:${innerPort}`,
      '--env', 'DEVA_HOST=0.0.0.0', '--env', `DEVA_PUBLIC_URL=http://${loopback}:${port}`, '--env', 'DEVA_PROVIDER_ORIGINS=',
      ...volume(data, '/data'), ...volume(keys, '/keys', true)], ['serve'])
    await docker(['start', id], 'Start production workbench CLI')
    verifyServing(await ownedContainer(id), port)
  }

  async function probe(program, description, input) {
    const id = containerIds.get(names.serve)
    await ownedContainer(id)
    return JSON.parse(await docker(['exec', ...(input === undefined ? [] : ['-i']), id, 'node', '--input-type=module', '--eval', program], description, { input }))
  }

  async function stopAndRemoveContainer(id, expectGraceful = false) {
    const before = await ownedContainer(id)
    if (before.State.Running) await docker(['stop', '--time', '12', id], 'Stop owned container', { timeout: 20_000 })
    const after = await ownedContainer(id)
    check(after.State.Running === false && (!expectGraceful || (after.State.ExitCode === 0 && !after.State.OOMKilled)),
      'Production CLI did not exit cleanly')
    await docker(['rm', id], 'Remove stopped owned container')
  }

  const containers = async () => (await docker(['container', 'ls', '-aq', '--no-trunc', '--filter', `label=${label}`], 'List owned containers')).split(/\s+/).filter(Boolean)
  const volumes = async () => (await docker(['volume', 'ls', '-q', '--filter', `label=${label}`], 'List owned volumes')).split(/\s+/).filter(Boolean)

  async function cleanup() {
    if (!ownsResources) return
    // Rediscover by random label as creation may have reached the daemon before a CLI timeout.
    // Reinspect exact allowed names/IDs before each removal; never prune, force-remove, touch
    // mountpoint paths, or address an object merely by a user-supplied name.
    let failures = 0
    const foundContainers = await containers().catch(() => { failures++; return [] })
    for (const id of foundContainers) {
      try { await stopAndRemoveContainer(id) } catch { failures++ }
    }
    const foundVolumes = await volumes().catch(() => { failures++; return [] })
    for (const name of foundVolumes) {
      try { await ownedVolume(name); await docker(['volume', 'rm', name], 'Remove owned named volume') } catch { failures++ }
    }
    check(failures === 0 && (await containers()).length === 0 && (await volumes()).length === 0, 'Owned Docker resource cleanup unconfirmed')
  }

  return { init, prepare, serve, probe, cleanup, stop: () => stopAndRemoveContainer(containerIds.get(names.serve), true) }
}
