// Fixed, credential-quiet programs run via docker exec as the packaged service user.
// No probe starts a viewer, substitutes frames, writes a mount, or joins a network.
class ProbeFailure extends Error {}
function failUnless(predicate, step) {
  if (!predicate) throw new ProbeFailure(step)
}

async function readInput() {
  const chunks = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    bytes += chunk.length
    failUnless(bytes <= 512, 'bounded synthetic input')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function cliPid(cli) {
  const { readFile } = await import('node:fs/promises')
  const children = (await readFile('/proc/1/task/1/children', 'utf8')).trim().split(/\s+/).filter(pid => /^[1-9]\d*$/.test(pid))
  const matches = []
  for (const pid of new Set(['1', ...children])) {
    const args = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')
    if (args === `node\0${cli}\0serve\0`) matches.push(pid)
  }
  failUnless(matches.length === 1, 'actual packaged serve process')
  return matches[0]
}

async function processStat(pid) {
  const { readFile } = await import('node:fs/promises')
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
  const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/)
  return { state: fields[0], tty: Number(fields[4]), start: fields[19] }
}

async function processContext(pid) {
  const { readFile, readlink } = await import('node:fs/promises')
  const [status, stat, executable] = await Promise.all([
    readFile(`/proc/${pid}/status`, 'utf8'), processStat(pid), readlink(`/proc/${pid}/exe`)
  ])
  return { ...stat, restricted: executable === process.execPath &&
    ['Uid', 'Gid'].every(key => new RegExp(`^${key}:\\s+1000\\s+1000\\s+1000\\s+1000$`, 'm').test(status)) &&
    /^NoNewPrivs:\s+1$/m.test(status) && /^Seccomp:\s+2$/m.test(status) &&
    ['Inh', 'Prm', 'Eff', 'Bnd', 'Amb'].every(key => new RegExp(`^Cap${key}:\\s+0+$`, 'm').test(status)) }
}

async function runtime() {
  const { createHash } = await import('node:crypto')
  const { lstat, readFile } = await import('node:fs/promises')
  const { release, machine } = await import('node:os')
  const { control, cli, worker, fixture, kernel } = await readInput()
  const pid = await cliPid(cli)
  const inherited = await processContext(pid)
  failUnless(process.platform === 'linux' && process.arch === 'x64' && machine() === 'x86_64' && release() === kernel &&
    process.versions.node.startsWith('22.') && inherited.restricted && inherited.tty === 0, 'native serving UID/caps/kernel context')
  const mountinfo = await readFile(`/proc/${pid}/mountinfo`, 'utf8')
  const mounts = mountinfo.trim().split('\n').map(line => line.split(' '))
  const find = target => mounts.filter(parts => parts[4] === target)
  function hasMount(target, options, type) {
    const entries = find(target)
    if (entries.length !== 1) return false
    const parts = entries[0], separator = parts.indexOf('-')
    const flags = new Set(`${parts[5]},${parts[separator + 3]}`.split(','))
    return options.every(option => flags.has(option)) && (!type || parts[separator + 1] === type)
  }
  const ro = target => find(target).length === 1 && find(target)[0][5].split(',').includes('ro')
  const rw = target => find(target).length === 1 && find(target)[0][5].split(',').includes('rw')
  const stamp = (stat, mode) => stat.uid === 1000n && stat.gid === 1000n && (stat.mode & 0o7777n) === mode
  const dir = await lstat(control, { bigint: true })
  const viewer = await lstat(`${control}/viewer.sock`, { bigint: true })
  failUnless(ro('/') && !find('/run/docker.sock').length && !find('/var/run/docker.sock').length &&
    dir.isDirectory() && stamp(dir, 0o700n) && viewer.isSocket() && stamp(viewer, 0o600n), 'read-only root and private terminal Unix socket')
  const noDocker = await Promise.all(['/run/docker.sock', '/var/run/docker.sock'].map(path =>
    lstat(path).then(() => false, error => error.code === 'ENOENT')))
  failUnless(noDocker.every(Boolean), 'Docker daemon socket missing inside runtime')
  let fixtureHash = null
  if (worker) {
    const absent = await Promise.all(['/workspaces', '/data', '/keys', '/run/deva/workbench-control.sock'].map(path =>
      lstat(path).then(() => false, error => error.code === 'ENOENT')))
    const [net, cgroup, pids, memory, cpu] = await Promise.all(['/proc/net/dev', `/proc/${pid}/cgroup`,
      '/sys/fs/cgroup/pids.max', '/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/cpu.max'].map(path => readFile(path, 'utf8')))
    const [quota, period] = cpu.trim().split(/\s+/).map(Number)
    failUnless(absent.every(Boolean) && rw(control) && hasMount('/tmp', ['nosuid', 'nodev', 'noexec', 'size=16384k'], 'tmpfs') &&
      hasMount('/dev/shm', ['nosuid', 'nodev', 'noexec', 'size=16384k'], 'tmpfs') && net.trim().split('\n').slice(2).length === 1 &&
      /^\s*lo:/.test(net.trim().split('\n')[2]) && cgroup.trim() === '0::/' &&
      pids.trim() === '64' && memory.trim() === '134217728' && period > 0 && quota === period,
    'worker has only its Unix control, local tmpfs, loopback device and bounded cgroups')
  } else {
    const owner = await lstat('/run/deva/workbench-control.sock', { bigint: true })
    failUnless(rw('/data') && ro('/keys') && ro('/workspaces') && ro(control) &&
      !mounts.some(parts => parts[4].startsWith('/workspaces/')) && owner.isSocket() && stamp(owner, 0o600n),
      'Workbench mount permissions and owner socket')
    fixtureHash = createHash('sha256').update(await readFile(fixture)).digest('hex')
  }
  return { mounts: createHash('sha256').update(mountinfo).digest('hex'), fixtureHash, socket: `${viewer.dev}:${viewer.ino}` }
}

async function initialOwner() {
  const { request } = await import('node:http')
  const { requestControl } = await import('/opt/deva/apps/headless/src/control/socket.mjs')
  const { password, origin } = await readInput()
  failUnless(/^http:\/\/127\.0\.0\.1:\d+$/.test(origin) && /^[A-Za-z0-9_-]{43}$/.test(password), 'synthetic owner input')
  async function local(path, { payload, headers = {} } = {}) {
    const body = payload === undefined ? undefined : JSON.stringify(payload)
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: 8787, path, method: payload === undefined ? 'GET' : 'POST', agent: false,
        signal: AbortSignal.timeout(5_000), headers: { host: new URL(origin).host, ...headers,
          ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }) } }, res => {
        const chunks = []
        let size = 0
        res.on('data', bytes => {
          size += bytes.length
          if (size > 16 * 1024) res.destroy(Error('unbounded response'))
          else chunks.push(bytes)
        })
        res.once('error', reject)
        res.once('end', () => {
          try {
            resolve({ status: res.statusCode, cookie: res.headers['set-cookie']?.[0]?.split(';', 1)[0],
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
          } catch (error) { reject(error) }
        })
      })
      req.once('error', reject)
      req.end(body)
    })
  }
  const runDir = '/run/deva'
  failUnless((await requestControl({ runDir, op: 'status' })).claimed === false &&
    (await local('/api/v1/bootstrap')).status === 401, 'fresh instance requires owner enrollment')
  const { credential } = await requestControl({ runDir, op: 'claim' })
  const enrollment = await local('/api/v1/auth/claim', { payload: { credential, password }, headers: { origin } })
  failUnless(enrollment.status === 200 && typeof enrollment.body.csrf === 'string' && typeof enrollment.cookie === 'string' &&
    (await requestControl({ runDir, op: 'status' })).claimed === true, 'normal private owner enrollment')
  const loggedOut = await local('/api/v1/auth/logout', { payload: {},
    headers: { origin, cookie: enrollment.cookie, 'x-deva-csrf': enrollment.body.csrf } })
  failUnless(loggedOut.status === 200 && (await local('/api/v1/bootstrap', { headers: { cookie: enrollment.cookie } })).status === 401,
    'enrollment session revoked before fresh Chrome login')
  return { enrolled: true }
}

async function descendants(root) {
  const { readFile, readdir } = await import('node:fs/promises')
  const found = new Set(), queue = [root]
  const absent = error => {
    if (['ENOENT', 'ESRCH'].includes(error.code)) return undefined
    throw error
  }
  for (const pid of queue) {
    for (const task of await readdir(`/proc/${pid}/task`).catch(absent) ?? []) {
      const value = await readFile(`/proc/${pid}/task/${task}/children`, 'utf8').catch(absent)
      for (const child of (value ?? '').trim().split(/\s+/).filter(id => /^[1-9]\d*$/.test(id))) {
        if (found.has(child)) continue
        found.add(child)
        queue.push(child)
        failUnless(found.size <= 64, 'bounded worker descendants')
      }
    }
  }
  return [...found]
}

async function viewerChildren() {
  const { readFile, readdir, readlink } = await import('node:fs/promises')
  const { setTimeout: delay } = await import('node:timers/promises')
  const { cli, mode, observed = [] } = await readInput()
  const pid = await cliPid(cli)
  if (mode === 'idle') {
    failUnless(Array.isArray(observed) && observed.length <= 4 && observed.every(value =>
      /^[1-9]\d{0,6}$/.test(value.pid) && /^\d{1,20}$/.test(value.start)), 'only previously observed viewer identities')
    const children = await descendants(pid)
    const stage = (await readdir('/dev/shm')).filter(name => /^deva-terminal-viewer-/.test(name))
    const reaped = await Promise.all(observed.map(async identity => {
      try { return (await processStat(identity.pid)).start !== identity.start } catch (error) {
        if (['ENOENT', 'ESRCH'].includes(error.code)) return true
        throw error
      }
    }))
    return { idle: children.length === 0 && stage.length === 0 && reaped.every(Boolean) }
  }
  failUnless(mode === 'active', 'known viewer observation phase')
  const deadline = performance.now() + 2_000
  let found
  while (performance.now() < deadline) {
    const ttyChildren = []
    for (const child of await descendants(pid)) {
      try {
        const path = `/proc/${child}`
        const argv = (await readFile(`${path}/cmdline`, 'utf8')).trim().split('\0').filter(Boolean)
        const fixed = argv.length === 3 && argv[0] === process.execPath && argv[1] === '--no-addons' && argv[2] === '/opt/terminal-worker/src/viewer.mjs'
        if (!fixed) continue
        const [ctx, cwd, environment, ...fds] = await Promise.all([processContext(child), readlink(`${path}/cwd`),
          readFile(`${path}/environ`, 'utf8'), ...[0, 1, 2].map(fd => readlink(`${path}/fd/${fd}`))])
        const env = environment.split('\0').filter(Boolean)
        const fixedEnv = ['TERM=dumb', 'HOME=/', 'LANG=C.UTF-8', 'PATH=/usr/bin:/bin']
        if (ctx.restricted && ctx.state !== 'Z' && ctx.tty > 0 && /^\d{1,20}$/.test(ctx.start) &&
          /^\/dev\/shm\/deva-terminal-viewer-[^/]+$/.test(cwd) && fixedEnv.every(entry => env.includes(entry)) &&
          env.every(entry => fixedEnv.includes(entry) || entry === `PWD=${cwd}`) &&
          fds.every(fd => fd === fds[0] && /^\/dev\/pts\/\d+$/.test(fd))) ttyChildren.push({ pid: child, start: ctx.start })
      } catch (error) {
        if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error
      }
    }
    const [only] = ttyChildren
    if (ttyChildren.length === 1) {
      if (found?.pid === only.pid && found.start === only.start) {
        if (performance.now() - found.time >= 240) return { liveTty: true, identity: only }
      } else found = { ...only, time: performance.now() }
    } else found = undefined
    await delay(45)
  }
  return { liveTty: false }
}

const source = (fn, ...dependencies) => `${[ProbeFailure, failUnless, readInput, ...dependencies].map(dep => dep.toString()).join('\n')};
let report; try { report = await (${fn.toString()})(); } catch (error) { report = { probeFailure: error instanceof ProbeFailure ? error.message : 'native probe error' }; }
process.stdout.write(JSON.stringify(report));`
export const probes = Object.freeze({ runtime: source(runtime, cliPid, processContext, processStat), owner: source(initialOwner),
  children: source(viewerChildren, cliPid, processContext, processStat, descendants) })
