// Native Linux/amd64 acceptance. A manual run on a disposable local runner must pin
// the expected image ID explicitly. --fixture-only never contacts Docker.
import { execFile, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { check, CheckFailure, choosePort, privateRoot } from './container-client-interactions-docker.mjs'
import { claimProgram, fixtureAclProgram, proofProgram, seedProgram } from './container-project-documents-probe.mjs'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const tag = 'deva-workbench:project-documents-verify', cli = '/opt/deva/apps/headless/src/cli.mjs'
const projectLabel = 'com.docker.compose.project', seedLabel = 'deva.workbench.project-documents-fixture'
const project = `devadoc${randomBytes(16).toString('hex')}`, seedName = `${project}-fixture`
const fullId = /^[a-f0-9]{64}$/u, revision = /^r_[a-f0-9]{64}$/u, widPattern = /^w_[a-f0-9]{32}$/u
const intentId = /^di_[a-f0-9]{32}$/u
const cookiePattern = /^deva-workbench-local=[A-Za-z0-9_-]{43}$/u
const initial = 'Original edit-only fixture\n', edited = 'Edited on native bind\r\n'
const seedCommand = ['--input-type=module', '--eval', seedProgram, initial]
const content = '\uFEFF项目文档\r\n保留原始字节\r\n'
const ordinaryPath = 'Notes/original.txt', createdPath = 'Notes/项目笔记.md', pendingPath = 'Notes/abandoned.txt'
const noGrant = { error: 'document_read_only' }, noAuth = { error: 'auth' }, noIntent = { error: 'document_intent_missing' }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const empty = value => (value?.length ?? 0) === 0
const listed = value => value.split(/\s+/u).filter(Boolean)
const only = (value, ...keys) => eq(Object.keys(value ?? {}).sort(), keys.sort())
const hostUid = process.getuid?.(), hostGid = process.getgid?.()
let root, fixture, image, port, origin, seedId, ownsDocker = false
let stage = 'preflight'

function run(executable, args, step, { env, timeout = 35_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(executable, args, { cwd: root.path, env, timeout, maxBuffer: 512 * 1024 }, (error, stdout) => {
      if (error) reject(new CheckFailure(`${step}: ${error.killed ? 'timed out' : error.code === 'ENOENT' ? 'executable missing' : 'command failed'}`))
      else resolve(stdout.trim())
    })
    child.stdin.on('error', () => {})
    child.stdin.end()
  })
}

// Only the three inner fixture directories receive an access ACL. Their owner and the
// private outer 0700 directory remain the runner's, so cleanup needs no elevated access.
async function makeFixture() {
  const mount = join(root.path, 'approved-projects'), alpha = join(mount, 'Alpha'), notes = join(alpha, 'Notes')
  const dirs = [root.path, mount, alpha, notes], fingerprints = []
  for (const dir of dirs) {
    if (dir !== root.path) { await mkdir(dir, { mode: 0o700 }); await chmod(dir, 0o700) }
    const value = await lstat(dir, { bigint: true })
    check(await realpath(dir) === dir && value.uid === BigInt(hostUid) && value.gid === BigInt(hostGid) &&
      value.isDirectory() && (value.mode & 0o7777n) === 0o700n, 'Unexpected synthetic directory or permission')
    fingerprints.push([String(value.dev), String(value.ino)])
  }
  fixture = { mount, notes, fingerprints }
}

async function acl(operation, target = 1000) {
  check(await run('python3', ['-I', '-S', '-c', fixtureAclProgram, root.path, operation, String(target), JSON.stringify(fixture.fingerprints)],
    'Check private POSIX access ACLs on the synthetic filesystem', { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, timeout: 5_000 }) ===
    'Verified private directory ACLs', 'Fixture ACL process result differed')
}

function docker(args, phase, options = {}) {
  const env = { PATH: '/usr/bin:/bin:/usr/local/bin', LANG: 'C.UTF-8', DOCKER_CONFIG: root.path,
    DEVA_IMAGE: tag, DEVA_PUBLISHED_PORT: String(port), DEVA_PUBLIC_URL: origin, DEVA_WORKSPACE_PARENT: fixture.mount }
  return run('docker', ['--host=unix:///var/run/docker.sock', ...args], phase, { env, ...options })
}

function compose(mode, args, phase) {
  const files = ['compose.yaml', ...(mode === 'default' ? [] : ['compose.workspace-edit.yaml']), ...(mode === 'create' ? ['compose.workspace-create.yaml'] : [])]
  return docker(['compose', '--project-directory', repo, '--project-name', project, '--env-file', '/dev/null',
    ...files.flatMap(name => ['-f', join(repo, name)]), ...args], phase)
}

async function inspect(kind, id) {
  const rows = JSON.parse(await docker([kind, 'inspect', id], `Inspect owned ${kind}`))
  check(rows.length === 1, `Expected one ${kind} inspection`)
  return rows[0]
}

const containers = () => docker(['container', 'ls', '-aq', '--no-trunc', '--filter', `label=${projectLabel}=${project}`], 'List owned containers').then(listed)
const seeds = () => docker(['container', 'ls', '-aq', '--no-trunc', '--filter', `label=${seedLabel}=${project}`], 'List owned fixture seed').then(listed)
const volumes = () => docker(['volume', 'ls', '-q', '--filter', `label=${projectLabel}=${project}`], 'List owned volumes').then(listed)
const networks = () => docker(['network', 'ls', '-q', '--no-trunc', '--filter', `label=${projectLabel}=${project}`], 'List owned networks').then(listed)
const volumeName = role => `${project}_${role}`
const networkName = `${project}_default`

async function ownedContainer(id) {
  check(fullId.test(id), 'Invalid container identifier')
  const m = await inspect('container', id), labels = m.Config.Labels ?? {}
  const role = labels['com.docker.compose.service']
  check(m.Id === id && m.Image === image.Id && labels[projectLabel] === project && ['init-key', 'workbench'].includes(role) &&
    m.Name === `/${project}-${role}-1` && labels['com.docker.compose.container-number'] === '1', 'Container ownership changed')
  return m
}

async function ownedVolume(name) {
  const m = await inspect('volume', name), role = m.Labels?.['com.docker.compose.volume']
  check(['data', 'keys'].includes(role) && name === volumeName(role) && m.Name === name && m.Labels?.[projectLabel] === project &&
    m.Driver === 'local' && m.Scope === 'local' && only(m.Options) && m.Mountpoint?.startsWith('/'), 'Volume ownership changed')
  return m
}

async function ownedNetwork(id) {
  check(fullId.test(id), 'Invalid network identifier')
  const m = await inspect('network', id)
  check(m.Id === id && m.Name === networkName && m.Driver === 'bridge' && m.Scope === 'local' && m.Labels?.[projectLabel] === project &&
    m.Labels?.['com.docker.compose.network'] === 'default', 'Network ownership changed')
}

async function ownedSeed(id) {
  check(fullId.test(id) && (!seedId || id === seedId), 'Invalid fixture seed ID')
  const m = await inspect('container', id), labels = m.Config.Labels ?? {}
  check(m.Id === id && m.Image === image.Id && m.Name === `/${seedName}` && labels[seedLabel] === project &&
    !Object.hasOwn(labels, projectLabel), 'Fixture seed ownership changed')
  return m
}

async function seedOriginal() {
  await acl('verify')
  check(!(await readdir(fixture.notes)).length, 'Fixture directory was not empty before seeding')
  const id = await docker(['create', '--name', seedName, '--label', `${seedLabel}=${project}`, '--platform', 'linux/amd64',
    '--network', 'none', '--user', '1000:1000', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--pids-limit', '32', '--entrypoint', 'node', '--mount', `type=bind,source=${fixture.mount},destination=/workspaces,bind-propagation=rprivate`,
    image.Id, ...seedCommand], 'Create isolated fixture seed')
  check(fullId.test(id), 'Fixture seed creation unconfirmed')
  seedId = id
  const m = await ownedSeed(id), h = m.HostConfig, bind = m.Mounts[0]
  check(m.State.Status === 'created' && m.Config.User === '1000:1000' && h.ReadonlyRootfs === true && h.Privileged === false &&
    h.NetworkMode === 'none' && eq(h.CapDrop, ['ALL']) && empty(h.CapAdd) && h.SecurityOpt?.length === 1 &&
    /^no-new-privileges[:=]true$/u.test(h.SecurityOpt[0]) && h.PidsLimit === 32 &&
    ![h.PidMode, h.IpcMode, h.UTSMode, h.UsernsMode, h.CgroupnsMode].includes('host') && h.PublishAllPorts === false &&
    empty(h.Devices) && empty(h.DeviceRequests) && empty(h.GroupAdd) && empty(h.VolumesFrom) && only(h.PortBindings) && only(h.Tmpfs) &&
    eq(m.Config.Entrypoint, ['node']) && eq(m.Config.Cmd, seedCommand) && eq(m.Config.Env, image.Config.Env) &&
    m.Mounts.length === 1 && bind.Type === 'bind' && bind.Source === fixture.mount && bind.Destination === '/workspaces' &&
    bind.RW === true && bind.Propagation === 'rprivate', 'Fixture seed isolation differs')
  check(await docker(['start', '--attach', id], 'Seed one ordinary file as UID/GID 1000') === 'Seeded one private fixture', 'Fixture seed output differs')
  await removeContainer(id, true, ownedSeed)
  check(!(await seeds()).length, 'Stopped fixture seed was not removed')
  await acl('verify')
  const info = await lstat(join(fixture.notes, 'original.txt'))
  check(info.isFile() && info.uid === 1000 && info.gid === 1000 && info.nlink === 1 && (info.mode & 0o7777) === 0o600 &&
    eq(await readdir(fixture.notes), ['original.txt']), 'Fixture seed did not create exactly one private file')
}

const scopeEnv = mode => mode === 'default' ? {} : { DEVA_WORKSPACE_ROOT: '/workspaces', DEVA_WORKSPACE_WRITE: '1',
  ...(mode === 'create' ? { DEVA_WORKSPACE_CREATE: '1' } : {}) }
const serviceEnv = mode => ({ DEVA_HOST: '0.0.0.0', DEVA_PROVIDER_ORIGINS: '', DEVA_PUBLIC_URL: origin, ...scopeEnv(mode) })
const envList = value => Object.entries(value).map(([k, v]) => `${k}=${v}`).sort()
const exactBind = bind => bind?.type === 'bind' && bind.source === fixture.mount && bind.target === '/workspaces' &&
  bind.read_only !== true && bind.bind?.create_host_path === false

async function effectiveConfig(mode) {
  const { services, volumes: vols, networks: nets } = JSON.parse(await compose(mode, ['config', '--format', 'json'], 'Render checked-in Compose stack'))
  check(only(services, 'init-key', 'workbench') && only(vols, 'data', 'keys') && only(nets, 'default') &&
    vols.data?.name === volumeName('data') && vols.keys?.name === volumeName('keys') && nets.default?.name === networkName,
  'Effective Compose resource scope differs')
  for (const s of Object.values(services)) {
    check(s.image === tag && s.user === '1000:1000' && s.platform === 'linux/amd64' && s.read_only === true &&
      eq(s.cap_drop, ['ALL']) && eq(s.security_opt, ['no-new-privileges:true']) && empty(s.cap_add) && !s.privileged &&
      !s.entrypoint && empty(s.devices) && empty(s.volumes_from), 'Unsafe effective Compose isolation')
  }
  const w = services.workbench, k = services['init-key'], bind = w.volumes.filter(v => v.type === 'bind')
  check(!w.command && eq(k.command, ['init-key', '--if-missing']) && eq(envList(w.environment), envList(serviceEnv(mode))) &&
    only(k.environment) && w.init === true && k.network_mode === 'none' && only(w.networks, 'default') &&
    w.ports.length === 1 && w.ports[0].host_ip === '127.0.0.1' && String(w.ports[0].published) === String(port) &&
    w.ports[0].target === 8787 && empty(k.ports) && bind.length === (mode === 'default' ? 0 : 1) &&
    (mode === 'default' || exactBind(bind[0])), 'Effective Compose command, loopback, or creation grant differs')
  for (const [s, init] of [[k, true], [w, false]]) {
    const v = s.volumes.filter(v => v.type === 'volume')
    check(v.length === 2 && s.volumes.every(v => v.type === 'volume' || (s === w && exactBind(v))) &&
      v.some(v => v.source === 'data' && v.target === '/data' && Boolean(v.read_only) === init) &&
      v.some(v => v.source === 'keys' && v.target === '/keys' && Boolean(v.read_only) === !init), 'Unexpected effective Compose volume')
  }
}

let storage
async function verifyContainer(id, mode, init = false) {
  const m = await ownedContainer(id), h = m.HostConfig, env = new Map(image.Config.Env.map(s => [s.split('=', 1)[0], s]))
  for (const [key, value] of Object.entries(init ? {} : serviceEnv(mode))) env.set(key, `${key}=${value}`)
  check(m.Config.User === '1000:1000' && h.ReadonlyRootfs === true && h.Privileged === false && eq(h.CapDrop, ['ALL']) && empty(h.CapAdd) &&
    h.SecurityOpt?.length === 1 && /^no-new-privileges[:=]true$/u.test(h.SecurityOpt[0]) &&
    ![h.NetworkMode, h.PidMode, h.IpcMode, h.UTSMode, h.UsernsMode, h.CgroupnsMode].includes('host') &&
    empty(h.Devices) && empty(h.DeviceRequests) && empty(h.GroupAdd) && empty(h.VolumesFrom) && h.PublishAllPorts === false &&
    eq([...env.values()].sort(), [...m.Config.Env].sort()) && eq(m.Config.Entrypoint, ['node', cli]) &&
    eq(m.Config.Cmd, init ? ['init-key', '--if-missing'] : ['serve']) && (h.Init === true) === !init, 'Container hardening or CLI contract differs')
  const ports = value => only(value, '8787/tcp') && eq(value['8787/tcp'], [{ HostIp: '127.0.0.1', HostPort: String(port) }])
  check(init ? h.NetworkMode === 'none' && only(h.PortBindings) && only(h.Tmpfs) :
    h.NetworkMode === networkName && ports(h.PortBindings) && (!m.State.Running || ports(m.NetworkSettings.Ports)) &&
    only(h.Tmpfs, '/run/deva', '/tmp') && Object.values(h.Tmpfs).every(v => ['nosuid', 'nodev', 'noexec'].every(flag => v.split(',').includes(flag))),
  'Unexpected publication, network, or tmpfs')
  const [data, keys] = await Promise.all(['data', 'keys'].map(role => ownedVolume(volumeName(role))))
  const signature = [data, keys].map(v => [v.Name, v.CreatedAt, v.Mountpoint])
  if (storage) check(eq(storage, signature), 'Persistent volume identity changed')
  else storage = signature
  const bind = m.Mounts.filter(v => v.Type === 'bind'), named = m.Mounts.filter(v => v.Type === 'volume'), wantBind = !init && mode !== 'default'
  check(new Set(m.Mounts.map(v => v.Destination)).size === m.Mounts.length &&
    m.Mounts.every(v => ['volume', 'bind'].includes(v.Type) || (v.Type === 'tmpfs' && Object.hasOwn(h.Tmpfs, v.Destination))) &&
    named.length === 2 && [[data, '/data', !init], [keys, '/keys', init]].every(([vol, dest, rw]) => named.some(v =>
      v.Driver === 'local' && v.Name === vol.Name && v.Source === vol.Mountpoint && v.Destination === dest && v.RW === rw)) &&
    bind.length === (wantBind ? 1 : 0) && (!wantBind || bind[0].Source === fixture.mount && bind[0].Destination === '/workspaces' &&
      bind[0].RW === true && bind[0].Propagation === 'rprivate'), 'Unexpected container mount')
  return m
}

async function identify(role) {
  for (const id of await containers()) if ((await ownedContainer(id)).Config.Labels['com.docker.compose.service'] === role) return id
  throw new CheckFailure(`Owned ${role} was not created`)
}

async function serve(mode) {
  if (mode !== 'default') await acl('verify')
  await effectiveConfig(mode)
  const first = mode === 'default'
  await compose(mode, ['create', '--pull', 'never', '--no-build', '--no-recreate', ...(first ? [] : ['workbench'])], 'Create production containers from Compose')
  if (first) {
    const init = await identify('init-key')
    await verifyContainer(init, mode, true)
    check(await docker(['start', '--attach', init], 'Run native init-key CLI') === 'Master key ready', 'Native master-key initialization failed')
    const done = await ownedContainer(init)
    check(done.State.Status === 'exited' && done.State.ExitCode === 0 && !done.State.OOMKilled, 'Native init-key exit differs')
  }
  const id = await identify('workbench')
  const before = await verifyContainer(id, mode)
  check(before.State.Status === 'created', 'Workbench already started before inspection')
  await docker(['start', id], 'Start unchanged production CLI')
  check((await verifyContainer(id, mode)).State.Running, 'Workbench production CLI stopped')
  await ready()
  check((await verifyContainer(id, mode)).State.Running, 'Workbench production CLI stopped before HTTP checks')
  return id
}

async function removeContainer(id, graceful = false, identifyOwner = ownedContainer) {
  const before = await identifyOwner(id)
  if (before.State.Running) await docker(['stop', '--time', '12', id], 'Stop owned container', { timeout: 20_000 })
  const after = await identifyOwner(id)
  check(!after.State.Running && (!graceful || (after.State.Status === 'exited' && after.State.ExitCode === 0 && !after.State.OOMKilled)),
    'Production CLI failed to stop cleanly')
  await docker(['rm', id], 'Remove stopped owned container')
}

async function cleanup() {
  if (!ownsDocker) return
  let failed = false
  for (const id of await seeds().catch(() => { failed = true; return [] })) {
    try { await removeContainer(id, false, ownedSeed) } catch { failed = true }
  }
  for (const id of await containers().catch(() => { failed = true; return [] })) {
    try { await removeContainer(id) } catch { failed = true }
  }
  for (const id of await networks().catch(() => { failed = true; return [] })) {
    try { await ownedNetwork(id); await docker(['network', 'rm', id], 'Remove owned Compose network') } catch { failed = true }
  }
  for (const name of await volumes().catch(() => { failed = true; return [] })) {
    try { await ownedVolume(name); await docker(['volume', 'rm', name], 'Remove owned Compose volume') } catch { failed = true }
  }
  check(!failed && !(await seeds()).length && !(await containers()).length && !(await volumes()).length && !(await networks()).length,
    'Fixture seed or Compose cleanup unconfirmed')
}

async function ready() {
  const until = performance.now() + 16_000
  while (performance.now() < until) {
    try {
      const result = await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(900), redirect: 'error' })
      if (result.status === 200 && (await result.json()).status === 'ready') return
    } catch { /* Initial listener startup */ }
    await delay(125)
  }
  throw new CheckFailure('Real production readiness timed out')
}

async function api(path, { who, method = 'GET', body, expected = 200, exact } = {}) {
  const response = await fetch(`${origin}/api/v1/${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(6_000),
    headers: { ...(who ? { cookie: who.cookie, 'x-deva-csrf': who.csrf } : {}),
      ...(method === 'GET' ? {} : { origin, 'content-type': 'application/json' }) },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) })
  check(response.status === expected && response.headers.get('content-type') === 'application/json; charset=utf-8',
    `${method} ${path.replace(/(?:w_|di_)[a-f0-9]{32}/gu, 'id')}: expected HTTP ${expected}, got ${response.status}`)
  const value = await response.json()
  if (exact !== undefined) check(eq(value, exact), 'Unexpected HTTP response shape or value')
  return { value, cookie: response.headers.get('set-cookie')?.split(';', 1)[0] }
}
const post = (path, who, body, expected = 200, exact) => api(path, { method: 'POST', who, body, expected, exact }).then(r => r.value)
const get = (path, who) => api(path, { who }).then(r => r.value)
const password = randomBytes(24).toString('base64url')

async function login(id, first = false) {
  check((await get('auth/state')).claimed === !first, 'Native persisted authentication state differs')
  const body = { password }
  if (first) {
    await ownedContainer(id)
    body.credential = JSON.parse(await docker(['exec', id, 'node', '--input-type=module', '--eval', claimProgram], 'Read one-time claim over native Unix socket')).credential
    check(typeof body.credential === 'string' && body.credential.length > 0, 'Native Unix claim was empty')
  }
  const { cookie, value } = await api(`auth/${first ? 'claim' : 'login'}`, { method: 'POST', body })
  check(cookiePattern.test(cookie) && typeof value.csrf === 'string' && value.csrf.length > 0, 'Real HTTP login receipt differs')
  return { cookie, csrf: value.csrf }
}

async function runtime(id, mode) {
  await verifyContainer(id, mode)
  if (mode !== 'default') await acl('verify')
  return JSON.parse(await docker(['exec', id, 'node', '--input-type=module', '--eval', proofProgram, mode, String(hostUid)],
    'Check native UID, permissions, bytes and revision'))
}
const collect = wid => `workspaces/${wid}/document-intents`
const readDocument = (wid, who, path) => post(`workspaces/${wid}/read`, who, { path })

async function catalogue(who, mode) {
  const { capabilities } = await get('bootstrap', who)
  check(capabilities.workspaceDocumentCreate === (mode === 'create') && capabilities.workspaceFiles === (mode !== 'default') &&
    capabilities.browserPanel === false && capabilities.terminalViewer === false, 'Literal bootstrap capability differs')
  const { workspaces } = await get('workspaces', who)
  if (mode === 'default') { check(eq(workspaces, []), 'Default CLI exposes a workspace'); return `w_${'0'.repeat(32)}` }
  check(workspaces.length === 1 && workspaces[0].name === 'Alpha' && widPattern.test(workspaces[0].id), 'Expected only one bound project')
  return workspaces[0].id
}

async function deniedModes() {
  stage = 'default production container (no project mount)'
  const base = await serve('default'), owner = await login(base, true), defaultId = await catalogue(owner, 'default')
  await runtime(base, 'default')
  await post(collect(defaultId), owner, { directory: 'Notes', name: 'denied.txt' }, 403, noGrant)
  await removeContainer(base, true)

  stage = 'edit-only production container (real writable bind, no creation grant)'
  const edit = await serve('edit')
  await api('bootstrap', { who: owner, expected: 401, exact: noAuth })
  const editor = await login(edit), wid = await catalogue(editor, 'edit')
  const current = await readDocument(wid, editor, ordinaryPath)
  check(current.content === initial && current.writable === true && revision.test(current.revision), 'Edit-only mount lacks genuine file write permission')
  const result = await api(`workspaces/${wid}/file`, { who: editor, method: 'PUT', body: { path: ordinaryPath, revision: current.revision, content: edited } })
  check(result.value.ok === true && revision.test(result.value.revision) && result.value.revision !== current.revision, 'Edit-only update did not commit')
  await post(collect(wid), editor, { directory: 'Notes', name: 'denied.txt' }, 403, noGrant)
  const proof = await runtime(edit, 'edit')
  check(eq(proof.entries, ['original.txt']) && proof.ordinary === edited, 'Edit-only denial or real edit differs on disk')
  await removeContainer(edit, true)
  return { wid, base, edit }
}

async function persistence({ wid, base, edit }) {
  stage = 'create-enabled production container'
  const first = await serve('create'), user = await login(first)
  check(await catalogue(user, 'create') === wid, 'Approved mount project changed')
  const drafts = collect(wid)
  const prepare = async name => {
    const intent = await post(drafts, user, { directory: 'Notes', name }, 201)
    check(only(intent, 'id', 'path', 'ttlMs') && intentId.test(intent.id) && intent.path === `Notes/${name}` &&
      Number.isSafeInteger(intent.ttlMs) && intent.ttlMs > 0, 'Preparation receipt differs')
    return intent
  }
  const intent = await prepare('项目笔记.md'), pending = await prepare('abandoned.txt')
  const target = `${drafts}/${intent.id}`, unfinished = `${drafts}/${pending.id}`
  await post(`${unfinished}/status`, user, {}, 200, { state: 'prepared', path: pendingPath, revision: null })
  const receipt = await post(`${target}/create`, user, { content }, 201)
  check(eq(receipt, { created: true, path: createdPath, revision: receipt.revision, replayed: false }) && revision.test(receipt.revision), 'Creation receipt differs')
  await post(`${target}/create`, user, { content }, 200, { ...receipt, replayed: true })
  const proof = await runtime(first, 'create')
  const expectedEntries = ['original.txt', '项目笔记.md'].sort()
  check(eq(proof.entries, expectedEntries) && proof.ordinary === edited && proof.revision === receipt.revision && proof.content === content,
    'Initial native readback and revision differ')
  await removeContainer(first, true)
  check(!(await containers()).includes(first), 'Original workbench still exists')

  stage = 'replacement production container (same bind and volumes, new ID)'
  const second = await serve('create')
  check(new Set([base, edit, first, second]).size === 4, 'Workbench container ID was reused')
  await post(`${target}/status`, user, {}, 401, noAuth)
  await post(`${unfinished}/create`, user, { content: 'stale login' }, 401, noAuth)
  const next = await login(second)
  check(next.cookie !== user.cookie && next.csrf !== user.csrf && await catalogue(next, 'create') === wid, 'Replacement login or project identity differs')
  await post(`${target}/status`, next, {}, 404, noIntent)
  await post(`${unfinished}/create`, next, { content: 'old intent' }, 404, noIntent)
  const current = await readDocument(wid, next, createdPath), native = await runtime(second, 'create')
  check(current.content === content && current.writable === true && revision.test(current.revision) && current.revision === native.revision &&
    native.revision === receipt.revision && eq(native, proof), 'Replacement disk identity, exact bytes or fresh readback revision differs')
  await removeContainer(second, true)
  return `${first.slice(0, 12)} → ${second.slice(0, 12)}`
}

async function main(fixtureOnly, expectedImage) {
  check(process.platform === 'linux' && Number.isInteger(hostUid) && hostUid > 0 && hostUid < 2 ** 32 - 1 &&
    (fixtureOnly || process.arch === 'x64'), 'Expected nonroot Linux (amd64 for Docker)')
  if (!fixtureOnly && !expectedImage) {
    check(process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted', 'On a disposable local amd64 runner, supply --disposable-image sha256:<64 hex>')
  }
  root = await privateRoot()
  await makeFixture()
  for (const program of [claimProgram, proofProgram, seedProgram]) {
    check(spawnSync(process.execPath, ['--input-type=module', '--check'], { input: program, timeout: 3_000 }).status === 0, 'Inline probe syntax failed')
  }
  if (fixtureOnly) {
    const alternate = hostUid === 1000 ? 1001 : 1000
    await acl('verify', hostUid)
    await acl('grant', alternate)
    await acl('verify', alternate)
    check(!(await readdir(fixture.notes)).length, 'Local fixture unexpectedly contains a file')
    return 'fixture-only: actual access ACLs and inline program syntax verified; Docker was not contacted'
  }
  port = await choosePort(); origin = `http://127.0.0.1:${port}`
  const engine = JSON.parse(await docker(['version', '--format', '{{json .Server}}'], 'Check local Docker engine'))
  check(engine.Os === 'linux' && engine.Arch === 'amd64' && Number(engine.Version.split('.', 1)[0]) >= 28, 'Expected local Linux/amd64 Docker Engine >= 28')
  image = await inspect('image', tag)
  // Do not create any Docker resource for a mutable tag that no longer resolves to the named image.
  if (expectedImage) check(image.Id === expectedImage, 'The prebuilt tag differs from the pinned image; no Docker resource was created')
  check(image.Os === 'linux' && image.Architecture === 'amd64' && /^sha256:[a-f0-9]{64}$/u.test(image.Id) && image.Size > 0 &&
    eq(image.Config.Entrypoint, ['node', cli]) && eq(image.Config.Cmd, ['serve']) && image.Config.Env.includes('NODE_ENV=production') &&
    eq(image.Config.Env.filter(v => v.startsWith('DEVA_')).sort(), ['DEVA_HOME=/data', 'DEVA_HOST=127.0.0.1', 'DEVA_MASTER_KEY_FILE=/keys/master.key',
      'DEVA_PORT=8787', 'DEVA_RUN_DIR=/run/deva', 'DEVA_WEB_DIR=/opt/deva/web']), 'Expected immutable production runtime image')
  check(!(await seeds()).length && !(await containers()).length && !(await volumes()).length && !(await networks()).length, 'Fixture or Compose label already exists')
  for (const [kind, names] of Object.entries({ container: [seedName, `${project}-workbench-1`, `${project}-init-key-1`], volume: ['data', 'keys'].map(volumeName), network: [networkName] })) {
    for (const name of names) check(!(await docker([kind, 'ls', '-q', ...(kind === 'container' ? ['-a'] : []), '--filter', `name=^/?${name}$`],
      'Check fresh exact resource name')), 'Exact Compose resource name already exists')
  }
  stage = 'private ACL and nonroot fixture seed'
  await acl('grant')
  ownsDocker = true
  await seedOriginal()
  const ids = await persistence(await deniedModes())
  return `${image.Id} (${image.Size} bytes, linux/amd64); default vs edit-only vs create; ${ids}; native bind, HTTP readback and login invalidation verified`
}

const usage='Usage: node scripts/workbench/container-project-documents.mjs [--fixture-only | --disposable-image sha256:<64 lowercase hex>]'
let result
try {
  const args=process.argv.slice(2)
  const fixtureOnly=args.length===1 && args[0]==='--fixture-only'
  const expectedImage=args.length===2 && args[0]==='--disposable-image' && args[1].length===71 && /^sha256:[a-f0-9]{64}$/u.test(args[1]) ? args[1] : undefined
  if (args.length===1 && args[0]==='--help') { console.log(usage);process.exit(0) }
  check(fixtureOnly || expectedImage || !args.length, usage)
  result = await main(fixtureOnly,expectedImage)
} catch (error) {
  console.error(`Project documents gate (${stage}): ${error instanceof CheckFailure ? error.message : error.code ?? error.name}`)
}
let detached = false
try { await cleanup(); detached = true } catch { result = null; console.error('Project documents Docker cleanup unconfirmed; fixture left private') }
if (detached) {
  try { await root?.remove() } catch { result = null; console.error('Project documents fixture cleanup unconfirmed') }
}
if (result) console.log(`PASS ${result}`)
else process.exitCode = 1
