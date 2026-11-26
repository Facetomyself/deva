import { execFile, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, lstat, readFile, realpath, writeFile } from 'node:fs/promises'
import { isIPv4 } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSites, sitePolicy } from '../../apps/browser-worker/src/egress/sites.mjs'
import { selectAddress } from '../../apps/browser-worker/src/egress/address.mjs'
import { CheckFailure, check } from './container-client-interactions-docker.mjs'
import { fixturePort, fixtureProgram, fixtureQuery, formPath, siteId, siteLabel } from './container-browser-handoff-fixture.mjs'

export const repo = fileURLToPath(new URL('../../', import.meta.url))
export const composeFiles = ['compose.yaml', 'compose.browser.yaml']
const wbCLI = '/opt/deva/apps/headless/src/cli.mjs'
const browserCLI = '/opt/browser-worker/src/cli.mjs'
const siteTarget = '/etc/deva-browser/sites.json'
const projectKey = 'com.docker.compose.project'
const fixtureKey = 'deva.workbench.browser-handoff-fixture'
const cid = /^[a-f0-9]{64}$/
const digest = /^sha256:[a-f0-9]{64}$/
const configMode = 0o644 // Inert configuration; host parent is private and container mount is RO.
const expectedServices = {
  'init-key': { image: 'main', cli: wbCLI, cmd: ['init-key', '--if-missing'], network: 'none', init: false },
  workbench: { image: 'main', cli: wbCLI, cmd: ['serve'], init: true },
  'browser-egress': { image: 'broker', cli: browserCLI, cmd: ['egress'], network: 'bridge', init: true },
  'browser-worker': { image: 'worker', cli: browserCLI, cmd: ['worker'], network: 'none', init: true },
}
const imageTags = { main: 'deva-workbench:browser-verify', broker: 'deva-browser-broker:verify', worker: 'deva-browser-worker:verify' }
const volumeRoles = ['data', 'keys', 'browser-control', 'browser-egress']
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const only = (v, ...keys) => Object.keys(v ?? {}).sort().join(',') === keys.sort().join(',')
const empty = v => (v?.length ?? 0) === 0
const nonePublished = ports => Object.values(ports ?? {}).every(p => p === null)

export function exactPrivateOrigin(ip) {
  const n = ip?.split('.').map(Number)
  check(isIPv4(ip ?? '') && (n[0] === 10 || (n[0] === 172 && n[1] >= 16 && n[1] <= 31) || (n[0] === 192 && n[1] === 168)) &&
    selectAddress([{ address: ip, family: 4 }], true)?.address === ip && selectAddress([{ address: ip, family: 4 }], false) === null,
  'FIXTURE_REQUIRES_NATIVE_PRIVATE_DOCKER_IP')
  return `http://${ip}:${fixturePort}`
}

export async function createSiteFile(root, origin) {
  const data = JSON.stringify([{ id: siteId, label: siteLabel, url: origin + formPath }]) + '\n'
  const path = join(root, 'browser-sites.json')
  check(dirname(path) === root && resolve(path) === path && await realpath(root) === root, 'SITE_PATH_SCOPE')
  check(exactPrivateOrigin(new URL(origin).hostname) === origin, 'SITE_ORIGIN_SCOPE')
  await writeFile(path, data, { flag: 'wx', mode: 0o600 })
  await chmod(path, configMode)
  const initial = await lstat(path, { bigint: true })
  async function verify() {
    const [info, parent] = await Promise.all([lstat(path, { bigint: true }), lstat(root, { bigint: true })])
    check(info.isFile() && info.uid === BigInt(process.geteuid()) && info.nlink === 1n &&
      (info.mode & 0o7777n) === BigInt(configMode) && (parent.mode & 0o7777n) === 0o700n && parent.uid === info.uid &&
      info.dev === initial.dev && info.ino === initial.ino && await realpath(path) === path &&
      await readFile(path, 'utf8') === data, 'SITE_FILE_IDENTITY_OR_MODE')
    const sites = parseSites(data), policy = sitePolicy(sites, [origin])
    check(sites.length === 1 && policy.registered.size === 1 && policy.privateAllowed.size === 1 &&
      policy.registered.has(origin) && policy.privateAllowed.has(origin), 'SITE_POLICY_NOT_EXACT')
  }
  await verify()
  return { path, data, verify }
}

const scopeProgram = `import{readFile,lstat,realpath}from'node:fs/promises';import{networkInterfaces}from'node:os';
const read=(p)=>readFile(p,'utf8').catch(()=>null);
const status=await read('/proc/self/status');
const field=key=>status?.split('\\n').find(line=>line.startsWith(key+':'))?.slice(key.length+1).trim();
const pick=key=>/^\\d+$/.test(field(key)??'')?Number(field(key)):-1;
const zeroCap=key=>/^0+$/.test(field(key)??'');
const bucket=async p=>{const s=(await read(p))?.trim();return /^\\d+$/.test(s??'')?(Number(s)>0?'positive':'zero'):'unavailable'};
async function mode(p,kind,m){const s=await lstat(p).catch(e=>{if(e.code!=='ENOENT')throw e});return !!s&&s[kind]()&&s.uid===1000&&s.gid===1000&&(s.mode&0o7777)===m&&await realpath(p)===p}
const one=async(p)=> (await read(p))?.trim()??null;
const kernel={arch:process.arch,uid:process.getuid(),gid:process.getgid(),nnp:pick('NoNewPrivs'),seccomp:pick('Seccomp'),
  cap:['CapEff','CapPrm','CapBnd'].every(zeroCap),unprivUserns:await bucket('/proc/sys/kernel/unprivileged_userns_clone'),
  maxUserns:await bucket('/proc/sys/user/max_user_namespaces'),apparmorUserns:await bucket('/proc/sys/kernel/apparmor_restrict_unprivileged_userns')};
console.log(JSON.stringify(process.argv[1]==='kernel-only'?kernel:{...kernel,
  noNet:Object.values(networkInterfaces()).flat().every(a=>a.internal),
  data:await mode('/data','isDirectory',0o700),keys:await mode('/keys','isDirectory',0o700),key:await mode('/keys/master.key','isFile',0o600),
  mainSocket:await mode('/run/deva/workbench-control.sock','isSocket',0o600),
  controlDir:await mode('/run/deva-browser-control','isDirectory',0o700),control:await mode('/run/deva-browser-control/worker.sock','isSocket',0o600),
  controlGone:await lstat('/run/deva-browser-control/worker.sock').then(()=>false,e=>e.code==='ENOENT'),
  egressDir:await mode('/run/deva-browser-egress','isDirectory',0o700),egress:await mode('/run/deva-browser-egress/egress.sock','isSocket',0o600),
  sites:await one('/etc/deva-browser/sites.json')}));`

// Read-only PID namespace inventory in the exact worker: no argv, profiles or PIDs are logged.
const processesProgram = `import{lstat,readFile,readdir}from'node:fs/promises';
const profiles=(await readdir('/tmp')).filter(n=>/^deva-browser-[a-z0-9]{6}$/i.test(n));const identity=[];let unsafe=false;
for(const id of (await readdir('/proc')).filter(x=>/^\\d+$/.test(x))){
  try {if((await lstat('/proc/'+id)).uid!==1000)continue;const args=(await readFile('/proc/'+id+'/cmdline','utf8')).split('\\0');
    const profile=args.find(a=>/^--user-data-dir=\\/tmp\\/deva-browser-[a-z0-9]{6}$/i.test(a));
    if(!profile)continue;if(args.some(a=>/^--(?:no-sandbox|disable-seccomp-filter-sandbox|disable-namespace-sandbox|disable-gpu-sandbox|remote-debugging-port)(?:=|$)/.test(a)))unsafe=true;
    if(args.includes('--remote-debugging-pipe')&&!args.some(a=>a.startsWith('--type='))){const s=await readFile('/proc/'+id+'/stat','utf8');const start=s.slice(s.lastIndexOf(')')+2).split(' ')[19];identity.push(id+':'+start)}
  } catch(e){if(!['ENOENT','ESRCH','EACCES','EPERM'].includes(e.code))throw e}
}console.log(JSON.stringify({profiles:profiles.length,identity,unsafe}));`

export async function verifyInlinePrograms() {
  for (const input of [scopeProgram, processesProgram, fixtureProgram, fixtureQuery]) {
    const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], { input, timeout: 3_000 })
    check(syntax.status === 0, 'PACKAGED_INLINE_PROGRAM_SYNTAX')
  }
  if (process.platform !== 'linux') return
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', scopeProgram, 'kernel-only'], { encoding: 'utf8', timeout: 3_000 })
  check(result.status === 0, 'LOCAL_KERNEL_SAMPLE_FAILED')
  const observed = JSON.parse(result.stdout), source = await readFile('/proc/self/status', 'utf8')
  const kernel = Object.fromEntries(source.split('\n').filter(row => row.includes(':')).map(row => {
    const i = row.indexOf(':'); return [row.slice(0, i), row.slice(i + 1).trim()]
  }))
  check(observed.uid === process.getuid() && observed.gid === process.getgid() && observed.arch === process.arch &&
    [0, 1].includes(observed.nnp) && observed.nnp === Number(kernel.NoNewPrivs) && [0, 1, 2].includes(observed.seccomp) &&
    observed.seccomp === Number(kernel.Seccomp) && observed.cap === ['CapEff', 'CapPrm', 'CapBnd'].every(key => /^0+$/.test(kernel[key])),
  'LOCAL_KERNEL_SAMPLE_MISMATCH')
}

export function safeKernel(scope) {
  const val = s => ['zero', 'positive', 'unavailable'].includes(s) ? s : 'unavailable'
  return `arch=${scope.arch === 'x64' ? 'amd64' : 'unexpected'} nnp=${scope.nnp === 1 ? 'on' : 'other'} seccomp=${scope.seccomp === 2 ? 'filter' : 'other'} unprivileged_userns_clone=${val(scope.unprivUserns)} max_user_namespaces=${val(scope.maxUserns)} apparmor_restrict_unprivileged_userns=${val(scope.apparmorUserns)}`
}

export function hostedDocker(root, port) {
  const project = `devawb${randomBytes(16).toString('hex')}`
  const fixtureName = `${project}-fixture`
  const networkName = `${project}_default`
  const origin = `http://127.0.0.1:${port}`
  const composeNames = Object.fromEntries(Object.keys(expectedServices).map(s => [s, `${project}-${s}-1`]))
  const volumes = Object.fromEntries(volumeRoles.map(role => [role, `${project}_${role}`]))
  const pinned = {}, registered = new Map()
  let active = false, site, fixtureOrigin, bridgeId

  function docker(args, code, { timeout = 20_000 } = {}) {
    return new Promise((resolve, reject) => {
      execFile('docker', ['--host=unix:///var/run/docker.sock', ...args], {
        cwd: root, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', DOCKER_CONFIG: root },
        encoding: 'utf8', maxBuffer: 512 * 1024, timeout,
      }, (error, stdout) => {
        if (!error) { resolve(stdout.trim()); return }
        const category = error.code === 'ENOENT' ? 'EXEC_MISSING' : error.killed ? 'TIMEOUT' : 'FAILED'
        reject(new CheckFailure(`${code}_${category}`))
      }).stdin.end()
    })
  }
  const rows = async (args, code) => (await docker(args, code)).split(/\s+/).filter(Boolean)
  async function inspect(kind, id) {
    const out = JSON.parse(await docker([kind, 'inspect', id], `INSPECT_${kind.toUpperCase()}`))
    check(Array.isArray(out) && out.length === 1, 'INSPECT_EXPECTED_ONE')
    return out[0]
  }
  const filter = (k, val) => ['--filter', `label=${k}=${val}`]
  const containers = async () => [...new Set([
    ...await rows(['container', 'ls', '-aq', '--no-trunc', ...filter(projectKey, project)], 'LIST_COMPOSE_CONTAINERS'),
    ...await rows(['container', 'ls', '-aq', '--no-trunc', ...filter(fixtureKey, project)], 'LIST_FIXTURE_CONTAINERS'),
  ])]
  const volumeList = () => rows(['volume', 'ls', '-q', ...filter(projectKey, project)], 'LIST_COMPOSE_VOLUMES')
  const networks = () => rows(['network', 'ls', '-q', '--no-trunc', ...filter(projectKey, project)], 'LIST_COMPOSE_NETWORKS')

  async function ownContainer(id) {
    check(cid.test(id), 'CONTAINER_ID_INVALID')
    const meta = await inspect('container', id), labels = meta.Config.Labels ?? {}
    const service = labels['com.docker.compose.service']
    const kind = labels[fixtureKey] === project && meta.Name === `/${fixtureName}` ? 'fixture' : service
    const expected = kind === 'fixture' ? fixtureName : composeNames[kind]
    check(expected && meta.Id === id && meta.Name === `/${expected}` &&
      (kind === 'fixture' ? !labels[projectKey] : labels[projectKey] === project && labels['com.docker.compose.container-number'] === '1') &&
      (!registered.has(kind) || registered.get(kind) === id), 'CONTAINER_OWNERSHIP_MISMATCH')
    return { meta, kind }
  }
  async function ownVolume(name) {
    check(Object.values(volumes).includes(name), 'VOLUME_NAME_INVALID')
    const meta = await inspect('volume', name)
    check(meta.Name === name && meta.Driver === 'local' && meta.Scope === 'local' && only(meta.Options) &&
      meta.Labels?.[projectKey] === project && volumes[meta.Labels?.['com.docker.compose.volume']] === name, 'VOLUME_OWNERSHIP_MISMATCH')
  }
  async function ownNetwork(id) {
    check(cid.test(id) && id !== bridgeId, 'NETWORK_ID_INVALID')
    const meta = await inspect('network', id)
    check(meta.Id === id && meta.Name === networkName && meta.Driver === 'bridge' && meta.Scope === 'local' &&
      meta.Labels?.[projectKey] === project && meta.Labels?.['com.docker.compose.network'] === 'default', 'NETWORK_OWNERSHIP_MISMATCH')
    return meta
  }
  async function assertFresh() {
    check(!(await containers()).length && !(await volumeList()).length && !(await networks()).length, 'PROJECT_LABEL_ALREADY_EXISTS')
    for (const [kind, names] of Object.entries({ container: [...Object.values(composeNames), fixtureName], volume: Object.values(volumes), network: [networkName] })) {
      // Docker's name filter is regex-backed; Docker container names may carry a slash.
      for (const name of names) check(!(await rows([kind, 'ls', ...(kind === 'container' ? ['-aq'] : ['-q']),
        '--filter', `name=^/?${name}$`], 'CHECK_FRESH_RESOURCE')).length, 'PROJECT_NAME_ALREADY_EXISTS')
    }
  }

  function hardened(meta) {
    const h = meta.HostConfig
    check(meta.Config.User === '1000:1000' && h.ReadonlyRootfs === true && h.Privileged === false &&
      same(h.CapDrop, ['ALL']) && empty(h.CapAdd) && same(h.SecurityOpt, ['no-new-privileges:true']) &&
      ![h.PidMode, h.IpcMode, h.UTSMode, h.CgroupnsMode, h.UsernsMode, h.NetworkMode].includes('host') &&
      h.PublishAllPorts === false && empty(h.VolumesFrom) && empty(h.Devices) && empty(h.DeviceRequests) && empty(h.GroupAdd), 'CONTAINER_HARDENING_MISMATCH')
  }
  const permittedVolumes = {
    'init-key': { '/data': ['data', false], '/keys': ['keys', true] },
    workbench: { '/data': ['data', true], '/keys': ['keys', false], '/run/deva-browser-control': ['browser-control', false] },
    'browser-egress': { '/run/deva-browser-egress': ['browser-egress', true] },
    'browser-worker': { '/run/deva-browser-control': ['browser-control', true], '/run/deva-browser-egress': ['browser-egress', false] },
  }
  function verifyService(meta, kind) {
    const { image, cli, cmd, network = networkName, init } = expectedServices[kind], h = meta.HostConfig
    hardened(meta)
    check(meta.Image === pinned[image] && same(meta.Config.Entrypoint, ['node', cli]) && same(meta.Config.Cmd, cmd) &&
      h.NetworkMode === network && (h.Init === true) === init, 'PRODUCTION_ENTRYPOINT_OR_NETWORK_MISMATCH')
    if (meta.State.Running) check(only(meta.NetworkSettings.Networks, network), 'EXTRA_SERVICE_NETWORK')
    const workbench = kind === 'workbench', peer = kind.startsWith('browser-'), broker = kind === 'browser-egress', worker = kind === 'browser-worker'
    const oneLoopback = ports => only(ports, '8787/tcp') && same(ports['8787/tcp'], [{ HostIp: '127.0.0.1', HostPort: String(port) }])
    check(workbench ? oneLoopback(h.PortBindings) && (!meta.State.Running || oneLoopback(meta.NetworkSettings.Ports))
      : only(h.PortBindings) && nonePublished(meta.NetworkSettings.Ports), 'UNEXPECTED_PORT_PUBLICATION')
    const env = meta.Config.Env
    const appEnv = env.filter(item => /^DEVA_(?:BROWSER|PROVIDER|PUBLIC_URL)/.test(item)).sort()
    check(same(appEnv, workbench ? ['DEVA_BROWSER_CONTROL_DIR=/run/deva-browser-control', 'DEVA_PROVIDER_ORIGINS=', `DEVA_PUBLIC_URL=${origin}`] :
      broker ? [`DEVA_BROWSER_PRIVATE_ORIGINS=${fixtureOrigin}`] : []), 'SERVICE_ENVIRONMENT_SCOPE')
    const tmpfs = h.Tmpfs ?? {}, permitted = permittedVolumes[kind]
    const mountedVolumes = meta.Mounts.filter(m => m.Type === 'volume')
    const binds = meta.Mounts.filter(m => m.Type === 'bind')
    check(only(tmpfs, ...(workbench ? ['/run/deva', '/tmp'] : worker ? ['/tmp'] : [])) &&
      Object.values(tmpfs).every(flags => ['rw', 'nosuid', 'nodev', 'noexec'].every(flag => flags.split(',').includes(flag))) &&
      mountedVolumes.length === Object.keys(permitted).length && mountedVolumes.every(m => m.Driver === 'local' &&
        volumes[permitted[m.Destination]?.[0]] === m.Name && permitted[m.Destination][1] === m.RW) &&
      new Set(meta.Mounts.map(m => m.Destination)).size === meta.Mounts.length &&
      meta.Mounts.every(m => ['volume', 'bind'].includes(m.Type) || (m.Type === 'tmpfs' && Object.hasOwn(tmpfs, m.Destination))) &&
      binds.length === (peer ? 1 : 0) && (!peer || binds[0].Source === site.path && binds[0].Destination === siteTarget &&
        binds[0].RW === false && binds[0].Propagation === 'rprivate'), 'PRIVATE_MOUNTS_MISMATCH')
    check(workbench ? h.PidsLimit === 128 : broker ? h.PidsLimit === 64 && h.Memory === 160 * 1024 ** 2 :
      !worker || (h.PidsLimit === 256 && h.Memory === 1536 * 1024 ** 2 && h.NanoCpus === 2e9 && h.ShmSize === 256 * 1024 ** 2), 'SERVICE_RESOURCE_LIMITS_MISMATCH')
  }
  async function verifyFixture(id, running = true) {
    const { meta, kind } = await ownContainer(id), h = meta.HostConfig
    hardened(meta)
    check(kind === 'fixture' && meta.Image === pinned.broker && same(meta.Config.Entrypoint, ['node']) &&
      same(meta.Config.Cmd, ['--input-type=module', '--eval', fixtureProgram]) && h.NetworkMode === 'bridge' && h.Init === true &&
      only(h.PortBindings) && nonePublished(meta.NetworkSettings.Ports) && empty(h.Binds) &&
      only(h.Tmpfs, '/tmp') && meta.Mounts.every(m => m.Type === 'tmpfs' && m.Destination === '/tmp') &&
      h.PidsLimit === 48 && h.Memory === 96 * 1024 ** 2 && (!running || (meta.State.Running && only(meta.NetworkSettings.Networks, 'bridge'))), 'FIXTURE_CONTAINER_SCOPE')
    return meta
  }
  function bridgeIP(meta) {
    const net = meta.NetworkSettings.Networks.bridge
    check(net?.NetworkID === bridgeId && cid.test(net.EndpointID), 'NATIVE_DOCKER_BRIDGE_MISMATCH')
    exactPrivateOrigin(net.IPAddress)
    return net.IPAddress
  }
  async function exec(kind, program, code, args = []) {
    const id = registered.get(kind)
    const owned = await ownContainer(id)
    check(owned.kind === kind && owned.meta.State.Running, 'PROBE_TARGET_NOT_RUNNING')
    return docker(['exec', id, 'node', '--input-type=module', '--eval', program, ...args], code)
  }
  async function fixtureStatus(peerIP) {
    await verifyFixture(registered.get('fixture'))
    const state = JSON.parse(await exec('fixture', fixtureQuery, 'FIXTURE_STATE', peerIP ? [peerIP] : []))
    check(state?.origin === fixtureOrigin && typeof state.peerBound === 'boolean' && typeof state.failure === 'boolean' &&
      ['documents', 'posts', 'receipts', 'credentialHeaders'].every(k => Number.isSafeInteger(state[k]) && state[k] >= 0) &&
      (state.nonce === null || /^[a-f0-9]{24}$/.test(state.nonce)), 'FIXTURE_STATE_SCHEMA')
    return state
  }
  async function waitFixture() {
    const deadline = Date.now() + 10_000
    do {
      try { return await fixtureStatus() } catch (error) {
        if (!(error instanceof CheckFailure) || error.message !== 'FIXTURE_STATE_FAILED') throw error
      }
      await new Promise(resolve => setTimeout(resolve, 125))
    } while (Date.now() < deadline)
    throw new CheckFailure('FIXTURE_STARTUP_TIMEOUT')
  }
  async function prepare() {
    const version = JSON.parse(await docker(['version', '--format', '{{json .Server}}'], 'DOCKER_ENGINE'))
    check(version?.Os === 'linux' && version.Arch === 'amd64' && Number(/^([0-9]+)\./.exec(version.Version)?.[1]) >= 28,
      'LOCAL_LINUX_AMD64_DOCKER_ENGINE_28_REQUIRED')
    check(await docker(['info', '--format', '{{.CgroupVersion}}'], 'DOCKER_CGROUP') === '2', 'DOCKER_CGROUP_V2_REQUIRED')
    await docker(['compose', 'version', '--short'], 'DOCKER_COMPOSE')
    const bridge = await inspect('network', 'bridge')
    check(bridge.Name === 'bridge' && bridge.Driver === 'bridge' && bridge.Scope === 'local' && cid.test(bridge.Id), 'NATIVE_DOCKER_BRIDGE_REQUIRED')
    bridgeId = bridge.Id
    for (const [kind, tag] of Object.entries(imageTags)) {
      const img = await inspect('image', tag)
      check(img.Os === 'linux' && img.Architecture === 'amd64' && digest.test(img.Id) && img.Config.User === 'node:node' &&
        same(img.Config.Entrypoint, ['node', kind === 'main' ? wbCLI : browserCLI]) &&
        same(img.Config.Cmd, [kind === 'main' ? 'serve' : kind === 'broker' ? 'egress' : 'worker']) &&
        (kind !== 'main' || img.Config.Env.includes('NODE_ENV=production')), 'PREBUILT_PRODUCTION_IMAGE_MISMATCH')
      pinned[kind] = img.Id
    }
    check(new Set(Object.values(pinned)).size === 3, 'IMAGE_IDENTITIES_MUST_BE_DISTINCT')
    await assertFresh()
    active = true
    const fixtureId = await docker(['create', '--name', fixtureName, '--label', `${fixtureKey}=${project}`, '--platform', 'linux/amd64',
      '--network', 'bridge', '--init', '--user', '1000:1000', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
      '--pids-limit', '48', '--memory', '96m', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,mode=1777,size=4m',
      '--entrypoint', 'node', pinned.broker, '--input-type=module', '--eval', fixtureProgram], 'CREATE_FIXTURE')
    check(cid.test(fixtureId), 'FIXTURE_ID_INVALID')
    registered.set('fixture', fixtureId)
    await verifyFixture(fixtureId, false)
    await docker(['start', fixtureId], 'START_FIXTURE')
    fixtureOrigin = exactPrivateOrigin(bridgeIP(await verifyFixture(fixtureId)))
    check(!(await waitFixture()).peerBound, 'FIXTURE_ALREADY_BOUND')
    site = await createSiteFile(root, fixtureOrigin)
  }
  async function composeCreate() {
    await site.verify()
    // Keep all inherited Docker, Compose and interpolation variables out. No .env,
    // override YAML, build, pull or additional service enters this project.
    const interpolation = {
      DEVA_IMAGE: imageTags.main, DEVA_BROWSER_BROKER_IMAGE: imageTags.broker, DEVA_BROWSER_IMAGE: imageTags.worker,
      DEVA_PUBLISHED_PORT: String(port), DEVA_PUBLIC_URL: origin, DEVA_PROVIDER_ORIGINS: '',
      DEVA_BROWSER_SITES: site.path, DEVA_BROWSER_PRIVATE_ORIGINS: fixtureOrigin,
    }
    const envFile = join(root, 'compose.env')
    check(resolve(envFile) === envFile && dirname(envFile) === root && !/[\r\n$'"\\]/.test(site.path), 'COMPOSE_ENV_PATH_SCOPE')
    await writeFile(envFile, Object.entries(interpolation).map(([k, v]) => `${k}='${v}'\n`).join(''), { flag: 'wx', mode: 0o600 })
    const base = ['compose', '--ansi', 'never', '--project-name', project, '--project-directory', repo, '--env-file', envFile,
      ...composeFiles.flatMap(file => ['-f', join(repo, file)])]
    await docker([...base, 'up', '--no-start', '--no-build', '--pull', 'never', ...Object.keys(expectedServices)], 'COMPOSE_CREATE', { timeout: 45_000 })
    for (const id of await containers()) {
      const { meta, kind } = await ownContainer(id)
      if (kind === 'fixture') continue
      check(!meta.State.Running, 'COMPOSE_CONTAINER_STARTED_EARLY')
      verifyService(meta, kind)
      registered.set(kind, id)
    }
    check(registered.size === 5, 'COMPOSE_SERVICES_MISSING')
    const volumeIds = await volumeList(), networkIds = await networks()
    check(volumeIds.length === 4 && networkIds.length === 1, 'COMPOSE_RESOURCES_MISSING')
    for (const name of volumeIds) await ownVolume(name)
    await ownNetwork(networkIds[0])
  }
  async function start(kind) {
    const id = registered.get(kind)
    const { meta } = await ownContainer(id)
    verifyService(meta, kind)
    if (kind !== 'workbench') await site.verify()
    const key = kind === 'init-key'
    await docker(['start', ...(key ? ['--attach'] : []), id], `START_${kind.toUpperCase()}`)
    const after = (await ownContainer(id)).meta
    verifyService(after, kind)
    check(key ? !after.State.Running && after.State.ExitCode === 0 && !after.State.OOMKilled : after.State.Running, 'COMPOSE_SERVICE_DID_NOT_START')
    if (kind === 'browser-egress') {
      const ip = bridgeIP(after)
      check(ip !== new URL(fixtureOrigin).hostname && (await fixtureStatus(ip)).peerBound, 'FIXTURE_BROKER_BIND_FAILED')
    }
  }
  async function scope(kind) {
    const value = JSON.parse(await exec(kind, scopeProgram, 'SCOPE_PROBE'))
    check(value.arch === 'x64' && value.uid === 1000 && value.gid === 1000 && value.nnp === 1 && value.seccomp === 2 && value.cap === true, 'KERNEL_HARDENING_NOT_ACTIVE')
    if (kind === 'workbench') check(value.data && value.keys && value.key && value.mainSocket && value.controlDir && value.sites === null, 'WORKBENCH_PRIVATE_FILES_MISMATCH')
    if (kind.startsWith('browser-')) {
      check(value.sites === site.data.trim() && !value.data && !value.keys && !value.key && !value.mainSocket && value.egressDir && value.egress,
        'BROWSER_PEER_FILE_SCOPE_MISMATCH')
      if (kind === 'browser-worker') check(value.noNet && value.controlDir && value.control, 'WORKER_NOT_PRIVATE_OR_NETWORKLESS')
    }
    return value
  }
  async function stopExact(id, graceful = false) {
    const before = (await ownContainer(id)).meta
    if (before.State.Running || before.State.Restarting) await docker(['stop', '--time', '12', id], 'STOP_OWN_CONTAINER')
    const after = (await ownContainer(id)).meta
    check(!after.State.Running && !after.State.Restarting && after.State.Pid === 0 &&
      (!graceful || (after.State.ExitCode === 0 && !after.State.OOMKilled)), 'CONTAINER_STOP_UNCONFIRMED')
  }
  async function cleanup() {
    if (!active) return false
    let failures = 0
    const attempt = async fn => { try { return await fn() } catch { failures++; return null } }
    const ids = await attempt(containers)
    const ordered = []
    for (const id of ids ?? []) {
      const owned = await attempt(() => ownContainer(id))
      if (owned) ordered.push([id, ['workbench', 'browser-worker', 'browser-egress', 'init-key', 'fixture'].indexOf(owned.kind)])
    }
    ordered.sort((a, b) => a[1] - b[1])
    for (const [id] of ordered) await attempt(async () => {
      await stopExact(id); await ownContainer(id); await docker(['rm', id], 'REMOVE_OWN_CONTAINER')
    })
    for (const id of await attempt(networks) ?? []) await attempt(async () => {
      const meta = await ownNetwork(id)
      check(only(meta.Containers), 'PROJECT_NETWORK_STILL_ATTACHED')
      await docker(['network', 'rm', id], 'REMOVE_OWN_NETWORK')
    })
    for (const name of await attempt(volumeList) ?? []) await attempt(async () => {
      await ownVolume(name); await docker(['volume', 'rm', name], 'REMOVE_OWN_VOLUME')
    })
    const remaining = await attempt(async () => (await containers()).length + (await volumeList()).length + (await networks()).length)
    check(failures === 0 && remaining === 0, 'EXACT_DOCKER_RESOURCE_CLEANUP_UNCONFIRMED')
    return true
  }
  return { origin, prepare, composeCreate, start, scope, cleanup, fixtureStatus, fixtureOrigin: () => fixtureOrigin,
    stopWorker: () => stopExact(registered.get('browser-worker'), true),
    processes: async () => JSON.parse(await exec('browser-worker', processesProgram, 'WORKER_PROCESS_PROBE')),
    claimURL: async () => {
      const id = registered.get('workbench'), { meta } = await ownContainer(id)
      verifyService(meta, 'workbench')
      check(meta.State.Running, 'CLAIM_MAIN_NOT_RUNNING')
      // The real CLI requires a TTY. Its output remains in the private exec buffer.
      return docker(['exec', '-t', id, 'node', wbCLI, 'claim'], 'ISSUE_LOCAL_OWNER_CLAIM')
    } }
}
