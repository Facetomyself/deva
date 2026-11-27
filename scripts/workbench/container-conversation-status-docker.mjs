import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdtemp, readFile, realpath, rmdir } from 'node:fs/promises'
import { machine, tmpdir } from 'node:os'
import { join } from 'node:path'
import { CheckFailure, check } from './container-client-interactions-docker.mjs'
import { probeProgram, providerOrigin } from './container-conversation-status-probe.mjs'

export const imageSha = value => typeof value === 'string' && value.length === 71 && /^sha256:[a-f0-9]{64}$/u.test(value)
const tag = 'deva-workbench:conversation-status-verify', cli = '/opt/deva/apps/headless/src/cli.mjs'
const idPattern = /^[a-f0-9]{64}$/u, labelKey = 'deva.workbench.conversation-status'
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const empty = object => !Object.keys(object ?? {}).length
const safePath = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
const imageEnv = {
  PATH: safePath, NODE_ENV: 'production', DEVA_HOME: '/data', DEVA_HOST: '127.0.0.1', DEVA_PORT: '8787',
  DEVA_MASTER_KEY_FILE: '/keys/master.key', DEVA_RUN_DIR: '/run/deva', DEVA_WEB_DIR: '/opt/deva/web'
}
const tmpfs = { '/tmp': 'rw,nosuid,nodev,noexec,mode=1777,size=64m', '/run/deva': 'rw,nosuid,nodev,noexec,mode=0700,uid=1000,gid=1000,size=4m' }
const containerRoles = ['init', 'first', 'second'], volumeRoles = ['data', 'keys']
const probeStages = new Set(['probe-transport', 'inputs', 'real-cli-ready', 'native-isolation', 'owner-authentication',
  'synthetic-model-and-one-turn', 'measured-vs-effective-model', 'authenticated-durable-read',
  'fresh-auth-old-cursor', 'fresh-snapshot-and-native-stamp'])

async function verifyRunner(expectedImage) {
  check(expectedImage === undefined || imageSha(expectedImage), 'Expected a literal prebuilt image SHA256')
  const hosted = process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted' &&
    process.env.RUNNER_OS === 'Linux' && process.env.RUNNER_ARCH === 'X64'
  check(expectedImage || hosted, 'A disposable local runner requires --disposable-image sha256:<64 lowercase hex>')
  check(process.platform === 'linux' && process.arch === 'x64' && machine() === 'x86_64' && process.getuid() > 0 &&
    process.geteuid() === process.getuid() && process.versions.node.split('.')[0] === '22' &&
    /^vendor_id\s*:\s*(?:GenuineIntel|AuthenticAMD|HygonGenuine)\s*$/mu.test(await readFile('/proc/cpuinfo', 'utf8')),
  'Expected a native Linux/amd64 non-root Node 22 runner')
  const socket = await lstat('/var/run/docker.sock').catch(() => null)
  check(socket?.isSocket() && socket.uid === 0, 'Expected the local root-owned Docker Engine Unix socket')
}

export async function productionGate(expectedImage, onCleanupFailure) {
  await verifyRunner(expectedImage)
  // An empty private Docker config and a fixed native socket exclude plugin contexts, auth stores, host env and proxies.
  const root = await mkdtemp(join(await realpath(tmpdir()), 'deva-conversation-docker-'))
  const rootStamp = await lstat(root, { bigint: true })
  const project = `deva-conversation-${randomUUID()}`, label = `${labelKey}=${project}`
  const name = role => `${project}-${role}`
  const ids = new Map(), tokens = new Map(), volumeStamps = new Map()
  let image

  function docker(args, stage, input) {
    return new Promise((resolve, reject) => {
      const child = execFile('docker', ['--host=unix:///var/run/docker.sock', ...args], {
        cwd: root, env: { PATH: '/usr/bin:/bin:/usr/local/bin', LANG: 'C.UTF-8', HOME: root, DOCKER_CONFIG: root },
        encoding: 'utf8', timeout: 28_000, maxBuffer: 256 * 1024
      }, (error, stdout, stderr) => {
        if (!error) return resolve((args[0] === 'logs' ? stdout + stderr : stdout).trim())
        const step = args[0] === 'exec' && /^conversation-status probe: ([a-z-]{1,48})\n?$/u.exec(stderr)?.[1]
        const cause = error.code === 'ENOENT' ? 'Docker executable missing' : error.killed ? 'Docker command timed out' : 'Docker command failed'
        reject(new CheckFailure(`${stage}: ${probeStages.has(step) ? step : cause}`))
      })
      child.stdin.on('error', () => {})
      child.stdin.end(input === undefined ? undefined : JSON.stringify(input))
    })
  }
  async function inspect(kind, value) {
    const rows = JSON.parse(await docker([kind, 'inspect', value], `Inspect ${kind}`))
    check(Array.isArray(rows) && rows.length === 1, `Expected one ${kind} inspection`)
    return rows[0]
  }
  const list = async (kind, filter) => (await docker([kind, 'ls', ...(kind === 'container' ? ['-a', '--no-trunc'] : []), '-q', '--filter', filter],
    `List scoped ${kind}`)).split('\n').filter(Boolean)
  const nameFilter = (kind, role) => `name=^${kind === 'container' ? '/' : ''}${name(role)}$`
  async function ownedVolume(role) {
    const v = await inspect('volume', name(role)), stamp = [v.CreatedAt, v.Mountpoint]
    check(v.Name === name(role) && v.Driver === 'local' && v.Scope === 'local' && empty(v.Options) &&
      v.Labels?.[labelKey] === project && tokens.has(role) && v.Labels?.[labelKey + '.nonce'] === tokens.get(role) &&
      Number.isFinite(Date.parse(stamp[0])) && stamp[1]?.startsWith('/') && (!volumeStamps.has(role) || same(volumeStamps.get(role), stamp)),
    'Volume identity changed')
    return stamp
  }
  async function ownedContainer(id, role) {
    check(idPattern.test(id), 'Invalid owned container identifier')
    const c = await inspect('container', id)
    const matched = containerRoles.find(kind => c.Name === '/' + name(kind))
    check(matched && (!role || role === matched) && c.Id === id && c.Image === image.Id && c.Config.Labels?.[labelKey] === project &&
      (!ids.has(matched) || ids.get(matched) === id), 'Container identity changed')
    return c
  }
  const volumeArg = (role, ro) => `type=volume,source=${name(role)},destination=/${role}${ro ? ',readonly' : ''}`
  async function create(role) {
    const init = role === 'init'
    check(!(await list('container', nameFilter('container', role))).length, 'Container name already exists')
    for (const volume of volumeRoles) await ownedVolume(volume)
    const provider = `DEVA_PROVIDER_ORIGINS=${providerOrigin}`
    const id = await docker(['create', '--pull=never', '--name', name(role), '--label', label, '--platform', 'linux/amd64', '--network', 'none',
      '--user', '1000:1000', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--init=false',
      '--cgroupns=private', '--pids-limit', '128', '--log-driver', 'local', ...Object.entries(tmpfs).flatMap(([path, opts]) => ['--tmpfs', `${path}:${opts}`]),
      '--mount', volumeArg('data', init), '--mount', volumeArg('keys', !init), ...(init ? [] : ['--env', provider]), image.Id,
      ...(init ? ['init-key'] : [])], `Create ${role} CLI container`)
    check(idPattern.test(id) && ![...ids.values()].includes(id), 'Fresh CLI identity unconfirmed')
    ids.set(role, id)
    const c = await ownedContainer(id, role), h = c.HostConfig
    const env = init ? image.Config.Env : [...image.Config.Env, provider]
    const command = init ? 'init-key' : 'serve'
    check(c.State.Status === 'created' && c.Config.User === '1000:1000' && c.Path === 'node' && same(c.Args, [cli, command]) &&
      same([...c.Config.Env].sort(), [...env].sort()) && h.NetworkMode === 'none' && h.ReadonlyRootfs === true && h.Privileged === false &&
      h.Init === false && h.CgroupnsMode === 'private' && ![h.PidMode, h.IpcMode, h.UTSMode, h.UsernsMode].includes('host') &&
      same(h.CapDrop, ['ALL']) && empty(h.CapAdd) && same(h.SecurityOpt, ['no-new-privileges:true']) && h.PidsLimit === 128 &&
      !h.PublishAllPorts && [h.PortBindings, h.Binds, h.VolumesFrom, h.Devices, h.DeviceRequests, h.DeviceCgroupRules, h.GroupAdd].every(empty) &&
      same(Object.entries(h.Tmpfs).sort(), Object.entries(tmpfs).sort()), 'Unexpected CLI command, environment or isolation')
    const mounts = c.Mounts.filter(m => m.Type === 'volume')
    for (const volume of volumeRoles) {
      const [, path] = await ownedVolume(volume)
      check(mounts.filter(m => m.Name === name(volume) && m.Source === path && m.Destination === '/' + volume && m.Driver === 'local' &&
        m.RW === (volume === 'data' ? !init : init)).length === 1, 'Incorrect persistent volume or mode')
    }
    check(mounts.length === 2 && c.Mounts.every(m => m.Type === 'volume' || (m.Type === 'tmpfs' && Object.hasOwn(tmpfs, m.Destination))),
      'Unexpected mount or host bind')
    return id
  }
  async function remove(id, role) {
    const before = await ownedContainer(id, role)
    if (before.State.Running) await docker(['stop', '--time', '10', id], 'Stop inspected owned CLI')
    const after = await ownedContainer(id, role)
    check(!after.State.Running, 'Owned container is still running')
    if (role) {
      check(after.State.Status === 'exited' && after.State.ExitCode === 0 && !after.State.OOMKilled, 'Expected clean production CLI exit')
      const safeLog = role === 'init' ? 'Master key ready' : 'Workbench listening on 127.0.0.1:8787 for http://127.0.0.1:8787'
      check(await docker(['logs', id], 'Verify production CLI logs') === safeLog, 'Unexpected production CLI log output')
    }
    await docker(['rm', id], 'Remove inspected owned CLI')
    if (role) check(!(await list('container', nameFilter('container', role))).length, 'Owned CLI still exists after removal')
  }
  async function runProbe(role, input) {
    const id = await create(role)
    await docker(['start', id], `Start ${role} production serve`)
    const c = await ownedContainer(id, role)
    check(c.State.Running && c.RestartCount === 0 && Object.keys(c.NetworkSettings.Networks).every(s => s === 'none') &&
      Object.values(c.NetworkSettings.Ports ?? {}).every(ports => !ports?.length), 'Unexpected production serve process or network')
    const result = JSON.parse(await docker(['exec', '-i', id, 'node', '--input-type=module', '--eval', probeProgram, role], `Probe ${role} production serve`, input))
    await remove(id, role)
    return result
  }
  async function cleanup() {
    if (!tokens.size) return
    let clean = true
    for (const id of await list('container', `label=${label}`).catch(() => { clean = false; return [] })) {
      try { await remove(id) } catch { clean = false }
    }
    for (const volume of await list('volume', `label=${label}`).catch(() => { clean = false; return [] })) {
      try {
        const role = volumeRoles.find(kind => name(kind) === volume)
        check(role && tokens.has(role), 'Unknown owned volume')
        await ownedVolume(role)
        await docker(['volume', 'rm', volume], 'Remove inspected owned volume')
      } catch { clean = false }
    }
    for (const [kind, roles] of [['container', containerRoles], ['volume', volumeRoles]]) {
      if ((await list(kind, `label=${label}`)).length) clean = false
      for (const role of roles) if ((await list(kind, nameFilter(kind, role))).length) clean = false
    }
    check(clean, 'Cleanup could not verify zero residual owned resources')
  }

  try {
    const engine = JSON.parse(await docker(['version', '--format', '{{json .Server}}'], 'Check local Docker engine'))
    const engineMajor = /^(\d+)\.\d+\.\d+(?:[+-][A-Za-z0-9.+-]{1,40})?$/u.exec(engine.Version)?.[1]
    check(engine.Os === 'linux' && engine.Arch === 'amd64' && Number(engineMajor) >= 28,
      'Expected local native Linux/amd64 Docker Engine 28+')
    const actual = await inspect('image', tag), config = actual.Config
    const env = Object.fromEntries(config.Env.map(line => [line.split('=', 1)[0], line.slice(line.indexOf('=') + 1)]))
    check(actual.Os === 'linux' && actual.Architecture === 'amd64' && imageSha(actual.Id) && (!expectedImage || actual.Id === expectedImage) &&
      Number.isSafeInteger(actual.Size) && actual.Size > 0 && same(config.Entrypoint, ['node', cli]) && same(config.Cmd, ['serve']) &&
      config.User === 'node:node' && config.WorkingDir === '/opt/deva' && empty(config.Volumes) && !config.Healthcheck &&
      config.Env.length === Object.keys(env).length && Object.entries(imageEnv).every(([k, v]) => env[k] === v) &&
      Object.keys(env).every(k => Object.hasOwn(imageEnv, k) || k === 'NODE_VERSION' || k === 'YARN_VERSION') &&
      /^22\.\d+\.\d+$/u.test(env.NODE_VERSION) && /^\d+\.\d+\.\d+$/u.test(env.YARN_VERSION), 'Expected exact prebuilt production runtime image and pinned ID')
    image = actual
    for (const role of volumeRoles) {
      check(!(await list('volume', nameFilter('volume', role))).length, 'Volume name already exists')
      const token = randomUUID(); tokens.set(role, token)
      check(await docker(['volume', 'create', '--driver', 'local', '--label', label, '--label', `${labelKey}.nonce=${token}`, name(role)],
        'Create private named volume') === name(role), 'Volume creation unconfirmed')
      volumeStamps.set(role, await ownedVolume(role))
    }
    const init = await create('init')
    check(await docker(['start', '--attach', init], 'Run production key initialization') === 'Master key ready', 'Production key initialization unconfirmed')
    await remove(init, 'init')
    const first = await runProbe('first', {}), second = await runProbe('second', first)
    check(second.verified === true && first.measured === second.measured && first.observed.updatedAt === second.readAt &&
      first.evidence.core === second.core && first.evidence.reads[0] === second.readSha && new Set(ids.values()).size === 3,
    'Distinct restored CLI and unchanged native measurement/read stamps are unconfirmed')
    await cleanup()
    return { image: image.Id, bytes: image.Size, engine: engine.Version, init, first: ids.get('first'), second: ids.get('second'),
      measured: second.measured, estimate: first.estimate, readAt: second.readAt, core: second.core, readSha: second.readSha }
  } catch (error) {
    try { await cleanup() } catch {
      onCleanupFailure(`Cleanup unconfirmed for label ${label}: containers ${containerRoles.map(name).join(', ')}, volumes ${volumeRoles.map(name).join(', ')}.`)
    }
    throw error
  } finally {
    try {
      const now = await lstat(root, { bigint: true })
      check(await realpath(root) === root && now.isDirectory() && now.ino === rootStamp.ino && now.dev === rootStamp.dev &&
        now.uid === BigInt(process.getuid()) && (now.mode & 0o777n) === 0o700n, 'Docker configuration directory identity changed')
      await rmdir(root)
    } catch { onCleanupFailure('Private Docker configuration directory cleanup is unconfirmed.') }
  }
}
