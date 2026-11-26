import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, CheckFailure } from './container-client-interactions-docker.mjs'

export const control = '/run/deva-pty-control'
export const appCli = '/opt/deva/apps/headless/src/cli.mjs'
export const workerCli = '/opt/terminal-worker/src/cli.mjs'
export const workbench = 'workbench'
export const worker = 'terminal-viewer'
const keyInit = 'init-key'
const tags = { [workbench]: 'deva-workbench:terminal-verify', [worker]: 'deva-terminal-viewer:verify' }
const expectedLimits = { memory: 128 * 1024 * 1024, pids: 64, cpus: 1 }
const label = property => `com.docker.compose.${property}`
const repository = fileURLToPath(new URL('../../', import.meta.url))
const fullId = /^[0-9a-f]{64}$/
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const empty = value => Object.keys(value ?? {}).length === 0
const exactKeys = (value, keys) => same(Object.keys(value ?? {}).sort(), [...keys].sort())
const restrictedTmp = value => {
  const options = new Set(String(value).split(','))
  return ['rw', 'nosuid', 'nodev', 'noexec', 'mode=1777'].every(option => options.has(option)) &&
    ['size=16m', 'size=16777216', 'size=16384k'].some(option => options.has(option))
}
const cliIs = (args, cli) => same(args, ['node', cli])
const hasNNP = opts => (opts ?? []).some(option => /^no-new-privileges(?::true|=true)?$/.test(option))
const mounts = entries => Object.fromEntries(entries.map(entry => [entry.target, entry]))
const onlyRunEnv = (entries, names) => entries.every(name => !name.startsWith('DEVA_') || names.includes(name))

export function verifyConfig(config, project, fixture, port, origin) {
  const { services, volumes, networks } = config
  check(config.name === project && exactKeys(services, [workbench, worker, keyInit]) && exactKeys(networks, ['default']) &&
    networks.default.name === `${project}_default` && !networks.default.external && !networks.default.enable_ipv6 &&
    [undefined, 'bridge'].includes(networks.default.driver) && empty(networks.default.driver_opts), 'Compose resolved unexpected services or networks')
  for (const spec of Object.values(services)) {
    check(spec.platform === 'linux/amd64' && spec.user === '1000:1000' && spec.read_only === true && !spec.privileged &&
      same(spec.cap_drop, ['ALL']) && empty(spec.cap_add) && hasNNP(spec.security_opt) && spec.security_opt.length === 1 &&
      !spec.container_name && !spec.pid && !spec.ipc && !spec.uts && !spec.use_api_socket && empty(spec.devices) &&
      empty(spec.device_cgroup_rules) && empty(spec.volumes_from) && empty(spec.secrets) && empty(spec.configs) &&
      empty(spec.env_file) && empty(spec.post_start) && empty(spec.pre_stop) && empty(spec.deploy?.resources?.reservations?.devices),
    'Compose security or host access differs from the native fixture contract')
  }
  const app = services[workbench], peer = services[worker], init = services[keyInit]
  check(app.image === tags[workbench] && init.image === tags[workbench] && peer.image === tags[worker] &&
    !app.network_mode && exactKeys(app.networks, ['default']) && peer.network_mode === 'none' && init.network_mode === 'none' &&
    empty(peer.networks) && empty(init.networks) && empty(peer.ports) && empty(init.ports), 'Compose images or service networking differ from the package contract')
  const [publish] = app.ports ?? []
  check(app.ports?.length === 1 && publish.host_ip === '127.0.0.1' && Number(publish.published) === port &&
    publish.target === 8787 && publish.protocol === 'tcp' && app.environment?.DEVA_PUBLIC_URL === origin &&
    app.environment?.DEVA_WORKSPACE_ROOT === '/workspaces' && app.environment?.DEVA_TERMINAL_CONTROL_DIR === control &&
    app.environment?.DEVA_HOST === '0.0.0.0' && app.environment?.DEVA_PROVIDER_ORIGINS === '' && exactKeys(app.environment,
      ['DEVA_PUBLIC_URL', 'DEVA_HOST', 'DEVA_PROVIDER_ORIGINS', 'DEVA_WORKSPACE_ROOT', 'DEVA_TERMINAL_CONTROL_DIR']) &&
    empty(peer.environment) && empty(init.environment), 'Compose publication or service environment is not isolated')
  const appMount = mounts(app.volumes ?? []), workerMount = mounts(peer.volumes ?? []), initMount = mounts(init.volumes ?? [])
  check(app.volumes?.length === 4 && peer.volumes?.length === 1 && init.volumes?.length === 2 &&
    exactKeys(appMount, ['/data', '/keys', '/workspaces', control]) && exactKeys(workerMount, [control]) &&
    exactKeys(initMount, ['/data', '/keys']), 'Compose has unexpected mount destinations')
  const projectBind = appMount['/workspaces']
  check(projectBind.type === 'bind' && projectBind.source === fixture && projectBind.read_only === true &&
    projectBind.bind?.create_host_path === false && [undefined, 'rprivate'].includes(projectBind.bind?.propagation), 'Compose workspace mount is not the dedicated read-only fixture')
  const controlName = workerMount[control].source
  check(/^[a-z][a-z0-9_-]*$/.test(controlName) && controlName !== 'data' && controlName !== 'keys' &&
    exactKeys(volumes, ['data', 'keys', controlName]), 'Compose volumes do not match the isolated fixture')
  for (const [name, value] of Object.entries(volumes)) {
    check(value.name === `${project}_${name}` && !value.external && [undefined, 'local'].includes(value.driver) &&
      empty(value.driver_opts), 'Compose volume is not project-scoped local storage')
  }
  for (const [entry, name, readOnly] of [[appMount['/data'], 'data', false], [appMount['/keys'], 'keys', true],
    [appMount[control], controlName, true], [workerMount[control], controlName, false],
    [initMount['/data'], 'data', true], [initMount['/keys'], 'keys', false]]) {
    check(entry.type === 'volume' && entry.source === name && Boolean(entry.read_only) === readOnly,
      'Compose volume source or access mode is unexpected')
  }
  check(Number(peer.mem_limit) === expectedLimits.memory && peer.pids_limit === expectedLimits.pids && Number(peer.cpus) === expectedLimits.cpus &&
    Number(peer.shm_size) === 16 * 1024 * 1024 && peer.tmpfs?.length === 1 &&
    peer.tmpfs[0].startsWith('/tmp:') && restrictedTmp(peer.tmpfs[0].slice(5)) &&
    same(peer.healthcheck?.test, ['CMD', 'node', workerCli, 'check']), 'Compose worker limits, tmpfs or native healthcheck are incorrect')
  return { controlName, volumeNames: Object.keys(volumes), project, fixture, port, origin }
}

function verifyContainer(meta, service, spec, imageId) {
  const host = meta.HostConfig, config = meta.Config
  check(meta.Image === imageId && config.User === '1000:1000' && host.ReadonlyRootfs && !host.Privileged &&
    same(host.CapDrop, ['ALL']) && empty(host.CapAdd) && hasNNP(host.SecurityOpt) &&
    ![host.PidMode, host.IpcMode, host.UTSMode, host.CgroupnsMode].includes('host') && empty(host.VolumesFrom) &&
    empty(host.Devices) && empty(host.DeviceRequests) && empty(host.DeviceCgroupRules) && !host.PublishAllPorts,
  'Container image, user or isolation differs from verified Compose configuration')
  const isApp = service === workbench, isWorker = service === worker
  const entry = isWorker ? workerCli : appCli
  const args = service === keyInit ? ['init-key', '--if-missing'] : ['serve']
  check(cliIs(config.Entrypoint, entry) && same(config.Cmd, args) && meta.Path === 'node' && same(meta.Args, [entry, ...args]),
    'Container does not invoke the exact packaged CLI')
  const expected = isApp ? { '/data': ['volume', 'data', true], '/keys': ['volume', 'keys', false],
    '/workspaces': ['bind', spec.fixture, false], [control]: ['volume', spec.controlName, false] } : isWorker ?
    { [control]: ['volume', spec.controlName, true] } : { '/data': ['volume', 'data', false], '/keys': ['volume', 'keys', true] }
  const tmpfs = host.Tmpfs ?? {}
  const nonTmp = meta.Mounts.filter(mount => mount.Type !== 'tmpfs')
  check(Object.keys(expected).length === nonTmp.length && new Set(nonTmp.map(m => m.Destination)).size === nonTmp.length &&
    meta.Mounts.filter(mount => mount.Type === 'tmpfs').every(mount => Object.hasOwn(tmpfs, mount.Destination)) &&
    exactKeys(tmpfs, isApp ? ['/run/deva', '/tmp'] : isWorker ? ['/tmp'] : []), 'Container has an unexpected mount or tmpfs')
  for (const mount of nonTmp) {
    const [kind, source, writable] = expected[mount.Destination] ?? []
    check(mount.Type === kind && mount.RW === writable && (kind === 'volume' ?
      mount.Name === `${spec.project}_${source}` && mount.Driver === 'local' :
      mount.Source === source && mount.Propagation === 'rprivate'), 'Container has an unexpected mount source or mode')
  }
  if (isApp) {
    const publication = ports => exactKeys(ports, ['8787/tcp']) && same(ports['8787/tcp'], [{ HostIp: '127.0.0.1', HostPort: String(spec.port) }])
    check(host.NetworkMode === `${spec.project}_default` && publication(host.PortBindings) &&
      (!meta.State.Running || publication(meta.NetworkSettings.Ports)) &&
      [`DEVA_PUBLIC_URL=${spec.origin}`, 'DEVA_HOST=0.0.0.0', 'DEVA_WORKSPACE_ROOT=/workspaces',
        `DEVA_TERMINAL_CONTROL_DIR=${control}`, 'DEVA_PROVIDER_ORIGINS='].every(value => config.Env.includes(value)),
    'Actual Workbench networking or workspace environment is not isolated')
  } else {
    check(host.NetworkMode === 'none' && empty(host.PortBindings) && (!isWorker || empty(config.ExposedPorts)) &&
      Object.keys(meta.NetworkSettings.Networks ?? {}).every(name => name === 'none') &&
      Object.values(meta.NetworkSettings.Ports ?? {}).every(ports => !ports?.length), 'Unexpected network access in an isolated service')
  }
  if (isWorker) {
    check(host.Memory === expectedLimits.memory && host.PidsLimit === expectedLimits.pids && host.NanoCpus === expectedLimits.cpus * 1e9 &&
      host.ShmSize === 16 * 1024 * 1024 && restrictedTmp(tmpfs['/tmp']) && onlyRunEnv(config.Env.map(item => item.split('=', 1)[0]), ['DEVA_TERMINAL_CONTROL_DIR']) &&
      same(config.Healthcheck?.Test, ['CMD', 'node', workerCli, 'check']), 'Actual worker isolation limits or environment are incorrect')
    check(!config.Env.some(item => /^(?:.*(?:TOKEN|KEY|PASSWORD|CREDENTIAL|PROXY|GIT_CONFIG)|SSH_AUTH_SOCK)=/i.test(item)),
      'Worker inherited an unexpected credential or network variable')
  }
}

export function terminalDocker({ root, fixture, port, origin }) {
  const project = `deva-terminal-verify-${randomBytes(12).toString('hex')}`
  const ownedServices = [workbench, worker, keyInit]
  const ids = new Map()
  const imageIds = {}
  let composeArgs, spec, created = false
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: root, DOCKER_CONFIG: root,
    DEVA_IMAGE: tags[workbench], DEVA_TERMINAL_IMAGE: tags[worker], DEVA_PUBLISHED_PORT: String(port),
    DEVA_PUBLIC_URL: origin, DEVA_WORKSPACE_PARENT: fixture }

  function docker(args, stage, { input, timeout = 25_000, signal } = {}) {
    return new Promise((resolve, reject) => {
      const child = execFile('docker', ['--host=unix:///var/run/docker.sock', ...args], {
        cwd: root, env, encoding: 'utf8', maxBuffer: 256 * 1024, timeout, signal
      }, (error, stdout) => {
        // Raw output and argv can carry private paths or environment. Only fixed diagnostics leave QA.
        if (!error) resolve(stdout.trim())
        else reject(new CheckFailure(`${stage}: ${error.code === 'ENOENT' ? 'Docker executable missing' : error.killed ? 'Docker command terminated' : 'Docker command failed'}`))
      })
      child.stdin.on('error', () => {})
      child.stdin.end(input === undefined ? undefined : JSON.stringify(input))
    })
  }

  const json = async (...args) => JSON.parse(await docker(...args))
  async function inspect(kind, value) {
    const rows = await json([kind, 'inspect', value], `Inspect ${kind}`)
    check(rows.length === 1, 'Expected exactly one Docker inspection result')
    return rows[0]
  }
  const list = async kind => (await docker([kind, 'ls', ...(kind === 'container' ? ['-a'] : []), '-q',
    ...(kind !== 'volume' ? ['--no-trunc'] : []), '--filter', `label=${label('project')}=${project}`], `List isolated ${kind} resources`))
    .split(/\s+/).filter(Boolean)
  const compose = (args, stage, opts) => docker(['compose', ...composeArgs, ...args], stage, opts)

  async function ownedContainer(id) {
    check(fullId.test(id), 'Invalid owned container ID')
    const meta = await inspect('container', id)
    const labels = meta.Config.Labels ?? {}, service = labels[label('service')]
    check(ownedServices.includes(service) && meta.Id === id && meta.Name === `/${project}-${service}-1` &&
      labels[label('project')] === project && labels[label('container-number')] === '1' && (!ids.has(service) || ids.get(service) === id),
    'Container failed exact Compose ownership check')
    return { meta, service }
  }
  async function ownedVolume(name) {
    const logical = spec.volumeNames.find(candidate => `${project}_${candidate}` === name)
    check(logical, 'Unexpected volume name in the isolated project')
    const volume = await inspect('volume', name)
    check(volume.Name === name && volume.Scope === 'local' && volume.Driver === 'local' && empty(volume.Options) &&
      volume.Labels?.[label('volume')] === logical && volume.Labels?.[label('project')] === project, 'Volume failed exact Compose ownership check')
  }
  async function ownedNetwork(id) {
    check(fullId.test(id), 'Invalid isolated network identifier')
    const network = await inspect('network', id)
    check(network.Id === id && network.Name === `${project}_default` && network.Driver === 'bridge' && network.Scope === 'local' &&
      !network.EnableIPv6 && network.Labels?.[label('project')] === project && network.Labels?.[label('network')] === 'default',
    'Network failed exact Compose ownership check')
    return network
  }
  async function verifyNetwork(running) {
    const [id, ...extra] = await list('network')
    check(id && !extra.length, 'Expected a single isolated project bridge')
    const network = await ownedNetwork(id)
    check(exactKeys(network.Containers, running ? [ids.get(workbench)] : []), 'Unexpected running peer on the Compose project bridge')
  }

  async function initialize() {
    const version = await json(['version', '--format', '{{json .Server}}'], 'Connect to local Docker Engine')
    check(version.Os === 'linux' && version.Arch === 'amd64' && Number(/^\d+/.exec(version.Version)?.[0]) >= 28,
      'Need native Linux/amd64 Docker Engine 28+ for IPv4 loopback publication')
    check(await docker(['info', '--format', '{{.CgroupVersion}}'], 'Check Docker kernel cgroups') === '2', 'Need a cgroup v2 Docker runner')
    for (const [service, image] of Object.entries(tags)) {
      const built = await inspect('image', image)
      check(built.Os === 'linux' && built.Architecture === 'amd64' && /^sha256:[a-f0-9]{64}$/.test(built.Id) &&
        cliIs(built.Config.Entrypoint, service === worker ? workerCli : appCli) &&
        (service !== workbench || built.Config.Env.includes('NODE_ENV=production')), 'Expected both exact Linux/amd64 production image tags and their real CLI entrypoints')
      imageIds[service] = built.Id
    }
    const envFile = join(root, 'compose.env')
    await writeFile(envFile, '', { flag: 'wx', mode: 0o600 })
    const files = ['compose.yaml', 'compose.workspaces.yaml', 'compose.terminal.yaml'].map(name => join(repository, name))
    for (const file of files) await access(file).catch(() => { throw new CheckFailure('Checked-in base, workspaces and terminal Compose files are required') })
    composeArgs = ['--project-name', project, '--project-directory', repository, '--env-file', envFile, '--profile', 'init',
      ...files.flatMap(file => ['-f', file])]
    spec = verifyConfig(JSON.parse(await compose(['config', '--format', 'json'], 'Resolve checked-in Compose files')), project, fixture, port, origin)
    for (const kind of ['container', 'volume', 'network']) check(!(await list(kind)).length, 'Isolated Docker project name collision')
    return imageIds
  }

  async function start() {
    created = true
    await compose(['create', '--no-build', '--pull', 'never', workbench, worker], 'Create isolated Compose services', { timeout: 60_000 })
    const containers = await list('container')
    check(containers.length === ownedServices.length, 'Expected Workbench, terminal worker and normal key init containers')
    for (const id of containers) {
      const { meta, service } = await ownedContainer(id)
      check(!meta.State.Running && !ids.has(service), 'Unexpected service before Compose start')
      verifyContainer(meta, service, spec, imageIds[service === keyInit ? workbench : service])
      ids.set(service, id)
    }
    const volumes = await list('volume')
    check(volumes.length === spec.volumeNames.length, 'Expected exactly three isolated named volumes')
    for (const volume of volumes) await ownedVolume(volume)
    await verifyNetwork(false)
    await compose(['up', '-d', '--no-build', '--no-recreate', '--pull', 'never', workbench, worker], 'Start existing Compose containers and normal key init', { timeout: 60_000 })
    const { meta: init } = await ownedContainer(ids.get(keyInit))
    check(!init.State.Running && init.State.Status === 'exited' && init.State.ExitCode === 0 && !init.State.OOMKilled, 'Packaged key initialization failed')
  }

  async function running() {
    const states = {}
    for (const service of [workbench, worker]) {
      const { meta } = await ownedContainer(ids.get(service))
      check(meta.State.Running && !meta.State.OOMKilled && meta.RestartCount === 0, 'A packaged service stopped or restarted unexpectedly')
      verifyContainer(meta, service, spec, imageIds[service])
      states[service] = meta.State.Health?.Status
    }
    await verifyNetwork(true)
    check(Object.values(states).every(state => ['starting', 'healthy'].includes(state)), 'A Compose healthcheck is missing or unhealthy')
    return Object.values(states).every(state => state === 'healthy')
  }

  async function probe(service, code, stage, { input, timeout, signal } = {}) {
    const id = ids.get(service)
    check(id && [workbench, worker].includes(service), 'Invalid service for native probe')
    const result = await json(['exec', ...(input === undefined ? [] : ['-i']), id, 'node', '--input-type=module', '-e', code], stage, { input, timeout, signal })
    check(!Object.hasOwn(result, 'probeFailure'), `${stage}: ${/^[\w /-]{1,120}$/.test(result.probeFailure) ? result.probeFailure : 'native probe error'}`)
    return result
  }

  async function stopContainer(id, expectClean) {
    const { meta: before } = await ownedContainer(id)
    if (expectClean) check(before.State.Running, 'Packaged service stopped before graceful shutdown')
    if (before.State.Running) await docker(['stop', '--time', '12', id], 'Stop owned Compose service')
    const { meta: after } = await ownedContainer(id)
    check(after.State.Status === 'exited' && !after.State.Running && (!expectClean || (after.State.ExitCode === 0 && !after.State.OOMKilled)) ||
      (!expectClean && after.State.Status === 'created' && !after.State.Running), 'Clean packaged service shutdown was not observed')
  }

  async function cleanup() {
    if (!created) return
    let errors = 0
    for (const kind of ['container', 'volume', 'network']) {
      for (const id of await list(kind).catch(() => { errors++; return [] })) {
        try {
          if (kind === 'container') await stopContainer(id, false)
          if (kind === 'volume') await ownedVolume(id)
          if (kind === 'network') await ownedNetwork(id)
          await docker([kind, 'rm', id], `Remove exact owned Compose ${kind}`)
        } catch { errors++ }
      }
    }
    check(errors === 0 && !(await list('container')).length && !(await list('volume')).length && !(await list('network')).length,
      'Isolated Compose resource cleanup was not confirmed')
  }

  return { initialize, start, running, probe, cleanup, async stop() {
    for (const service of [workbench, worker]) await stopContainer(ids.get(service), true)
  } }
}
