// Fixed QA programs for the local Docker invocation in container-client-interactions.mjs.
// They run as uid 1000 against the pinned image and its own volumes, without a shell,
// host mounts, user-supplied code, or access to the host clipboard.

async function input() {
  const chunks = []
  let length = 0
  for await (const chunk of process.stdin) {
    length += chunk.length
    if (length > 512) throw Error('fixture input too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

// A fenced Markdown block's rendered code includes the terminal LF. The search input
// can remove that LF from its value, but the native paste event must carry it unchanged.
export function formatCodeFixture(word) {
  const plain = `code ${word} Ω\n`
  return { plain, markdown: `\`\`\`text\n${plain}\`\`\`` }
}

async function seed() {
  const { createHash } = await import('node:crypto')
  const { readFile, readdir } = await import('node:fs/promises')
  const { createChatStore } = await import('/opt/deva/apps/headless/dist/chat-core.mjs')
  const { sid, title, word } = await input()
  if (!/^[0-9a-f-]{36}$/.test(sid) || !/^Packaged QA [0-9a-f]{16}$/.test(title) || !/^deva[a-f0-9]{16}$/.test(word) ||
      process.geteuid() !== 1000 || (await readdir('/data')).length !== 0) throw Error('invalid fixture')
  const store = createChatStore({ dataDir: '/data' })
  const record = store.ensureSession(sid)
  record.title = title
  record.messages = [{ role: 'user', content: word }, { role: 'assistant', content: formatCodeFixture(word).markdown }]
  store.saveStrict(sid)
  const bytes = await readFile(`/data/data/chats/${sid}.json`)
  return { digest: createHash('sha256').update(bytes).digest('hex') }
}

async function inspectRuntime() {
  const { createHash } = await import('node:crypto')
  const { lstat, readFile } = await import('node:fs/promises')
  const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex')
  // docker-init owns PID 1. Check the actual CLI child, not just this docker-exec process.
  const children = (await readFile('/proc/1/task/1/children', 'utf8')).trim().split(/\s+/).filter(p => /^[1-9][0-9]*$/.test(p))
  const processes = await Promise.all(children.map(async pid => {
    const args = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean)
    return { pid, args }
  }))
  const services = processes.filter(p => p.args[0] === 'node' && p.args[1] === '/opt/deva/apps/headless/src/cli.mjs' && p.args[2] === 'serve')
  if (services.length !== 1) throw Error('unexpected main process')
  const { pid } = services[0]
  const status = await readFile(`/proc/${pid}/status`, 'utf8')
  const mounts = (await readFile(`/proc/${pid}/mountinfo`, 'utf8')).split('\n').map(line => line.split(' '))
  const [cgroup, pids, memory, cpu] = await Promise.all([
    `/proc/${pid}/cgroup`, '/sys/fs/cgroup/pids.max', '/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/cpu.max'
  ].map(path => readFile(path, 'utf8').then(value => value.trim())))
  const [quota, period] = cpu.split(/\s+/).map(Number)
  const privateMode = (entry, mode) => entry.uid === 1000 && entry.gid === 1000 && (entry.mode & 0o777) === mode
  const runDir = await lstat('/run/deva')
  const socket = await lstat('/run/deva/workbench-control.sock')
  const clipboardPaths = await Promise.all(['/tmp/.X11-unix', '/run/user/1000', '/run/dbus/system_bus_socket'].map(path =>
    lstat(path).then(() => false, error => error.code === 'ENOENT')))
  return {
    platform: process.platform,
    arch: process.arch,
    node: Number(process.versions.node.split('.')[0]),
    production: process.env.NODE_ENV === 'production',
    restricted: /^Uid:\s+1000\s+1000\s+1000\s+1000$/m.test(status) &&
      /^Gid:\s+1000\s+1000\s+1000\s+1000$/m.test(status) && /^NoNewPrivs:\s+1$/m.test(status) &&
      /^Seccomp:\s+2$/m.test(status) && ['Eff', 'Prm', 'Bnd', 'Amb'].every(key => new RegExp(`^Cap${key}:\\s+0+$`, 'm').test(status)) &&
      mounts.some(parts => parts[4] === '/' && parts[5].split(',').includes('ro')) &&
      mounts.some(parts => parts[4] === '/data' && parts[5].split(',').includes('rw')) &&
      mounts.some(parts => parts[4] === '/keys' && parts[5].split(',').includes('ro')),
    cgroupLimits: cgroup === '0::/' && pids === '128' && memory === '536870912' && period > 0 && quota === 2 * period,
    privateControl: runDir.isDirectory() && privateMode(runDir, 0o700) && socket.isSocket() && privateMode(socket, 0o600),
    noClipboardIntegration: clipboardPaths.every(Boolean) &&
      ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'].every(name => !process.env[name]),
    html: await digest('/opt/deva/web/index.html'),
    js: await digest('/opt/deva/web/workbench.js')
  }
}

async function claim() {
  const { requestControl } = await import('/opt/deva/apps/headless/src/control/socket.mjs')
  return requestControl({ runDir: '/run/deva', op: 'claim' })
}

async function verifyNative() {
  const { createHash } = await import('node:crypto')
  const { readFile, readdir } = await import('node:fs/promises')
  const { sid, freshId, digest } = await input()
  if (![sid, freshId].every(id => /^[0-9a-f-]{36}$/.test(id)) || sid === freshId || !/^[a-f0-9]{64}$/.test(digest)) throw Error('invalid IDs')
  const root = '/data/data/chats'
  const actual = (await readdir(root)).filter(name => name !== '_index.json')
  const before = await readFile(`${root}/${sid}.json`)
  const fresh = JSON.parse(await readFile(`${root}/${freshId}.json`, 'utf8'))
  return {
    fixtureUnchanged: createHash('sha256').update(before).digest('hex') === digest,
    onlyExpectedChats: actual.length === 2 && actual.includes(`${sid}.json`) && actual.includes(`${freshId}.json`),
    freshEmpty: fresh.id === freshId && Array.isArray(fresh.messages) && fresh.messages.length === 0
  }
}

const source = (fn, ...dependencies) => `${[input, ...dependencies].map(dep => dep.toString()).join('\n')}; const result = await (${fn.toString()})(); process.stdout.write(JSON.stringify(result))`
export const probes = Object.freeze({ seed: source(seed, formatCodeFixture), runtime: source(inspectRuntime), claim: source(claim), native: source(verifyNative) })
