import { execFileSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const RUNNER = 'apps/desktop/test/verify-native-compose.mjs'
const INPUTS = ['.dockerignore', '.npmrc', 'Dockerfile', 'compose.yaml', 'compose.project-docs.yaml',
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'apps/desktop/package.json',
  'apps/desktop/vite.headless.config.ts', 'apps/desktop/test/headless-compose-probe.mjs',
  'apps/desktop/test/headless-compose-docs-probe.mjs']
const PREFIX = 'deva-native-compose-'
const SNAPSHOT = String.raw`{"version":1,"project":"发布手册","documents":[{"name":"入门.md","text":"首次使用：先阅读版本说明。\n"}]}` + '\n'
const CLI_OPTIONS = { stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000, maxBuffer: 64 * 1024 * 1024 }

export function requireNativeHost(platform = process.platform, arch = process.arch, machine = os.machine()) {
  if (platform !== 'linux' || arch !== 'x64' || machine !== 'x86_64') throw new Error('native_linux_amd64_required')
}

export function commandEnv(env = process.env) {
  const result = { LANG: 'C', COMPOSE_DISABLE_ENV_FILE: '1' }
  // Pin relative paths to the caller's cwd without collapsing symlink-sensitive `..` segments.
  const absolute = (value) => path.isAbsolute(value) ? value : value ? `${process.cwd()}${path.sep}${value}` : process.cwd()
  for (const key of ['PATH', 'HOME', 'XDG_RUNTIME_DIR', 'DOCKER_CONFIG']) {
    if (!Object.hasOwn(env, key) || typeof env[key] !== 'string' || env[key] === '') continue
    result[key] = key === 'PATH' ? env[key].split(path.delimiter).map(absolute).join(path.delimiter) : absolute(env[key])
  }
  return result
}

function socketUrl(host) {
  const socket = typeof host === 'string' && host.startsWith('unix://') && host.slice('unix://'.length)
  if (!socket || !socket.startsWith('/') || socket.endsWith('/') || /[\s\p{Cc}\\?#%]/u.test(socket) ||
    socket.split('/').some((part, i, parts) => part === '..' || (part === '.' && i === parts.length - 1))) {
    throw new Error('native_compose_local_unix_endpoint_required')
  }
  return `unix://${path.posix.normalize(socket)}`
}

export function localDockerEndpoint(env = process.env) {
  const { DOCKER_HOST: host, DOCKER_CONTEXT: context } = env
  if (host && context) throw new Error('native_compose_docker_context_ambiguous')
  if (host) return socketUrl(host)
  let endpoint
  try {
    // This command reads CLI metadata only. With no explicit name it inspects the selected context.
    const args = ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}']
    if (context) args.push('--', context)
    endpoint = JSON.parse(execFileSync('docker', args, { ...CLI_OPTIONS, env: commandEnv(env), encoding: 'utf8' }))
  } catch {
    throw new Error('native_compose_docker_context_inspection_failed')
  }
  return socketUrl(endpoint)
}

function exportTree(git, sha, work) {
  // Use Git's object store directly: archive attributes, checkout filters and symlinks never affect the export.
  const listing = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    .decode(git(['ls-tree', '-rz', '--full-tree', sha, '--', ...INPUTS, 'apps/desktop']))
  let runnerTracked = false
  const entries = listing.split('\0').filter(Boolean).flatMap((entry) => {
    const match = /^(\d+) (\w+) ([0-9a-f]+)\t([^]+)$/u.exec(entry)
    if (!match) throw new Error('native_compose_invalid_source_tree')
    const [, mode, type, oid, file] = match
    const regular = type === 'blob' && ['100644', '100755'].includes(mode)
    if (file === RUNNER) runnerTracked = regular
    if (!INPUTS.includes(file) && !file.startsWith('apps/desktop/src/') &&
      !/^apps\/desktop\/tsconfig[^/]*\.json$/u.test(file) && file !== 'apps/desktop/src') return []
    const parts = file.split('/')
    if (parts.some((part) => /^(?:\.git$|\.env|node_modules$)|\.(?:pem|key)$/iu.test(part))) return []
    if (!regular || file === 'apps/desktop/src' || parts.some((part) =>
      !part || part === '.' || part === '..' || part.includes('\\'))) throw new Error('native_compose_invalid_source_tree')
    return [{ oid, file, mode }]
  })
  if (!runnerTracked) throw new Error('native_compose_runner_must_be_tracked')
  const blobs = git(['cat-file', '--batch'], entries.map(({ oid }) => `${oid}\n`).join(''))
  let offset = 0
  for (const { oid, file, mode } of entries) {
    const headerEnd = blobs.indexOf(10, offset)
    const header = headerEnd >= 0 && /^([0-9a-f]+) blob (\d+)$/u.exec(blobs.toString('ascii', offset, headerEnd))
    const end = header && headerEnd + 1 + Number(header[2])
    if (!header || header[1] !== oid || blobs[end] !== 10) throw new Error('native_compose_invalid_source_blob')
    const target = path.join(work, file)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, blobs.subarray(headerEnd + 1, end), { flag: 'wx', mode: mode === '100755' ? 0o555 : 0o444 })
    offset = end + 1
  }
  if (offset !== blobs.length) throw new Error('native_compose_invalid_source_blob')
}

export function prepareSource(root) {
  try {
    return stageSource(root)
  } catch (error) {
    // Child-process and filesystem diagnostics can carry operator paths or data.
    const code = /^native_compose_[a-z_]+$/u.test(error?.message) ? error.message : 'native_compose_source_preparation_failed'
    throw new Error(code)
  }
}

function stageSource(root) {
  const repo = realpathSync(root)
  // A missing object in a partial clone must fail locally, including with older Git versions.
  const env = { ...commandEnv(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' }
  const git = (args, input) => execFileSync('git', ['--no-replace-objects', '--no-optional-locks',
    '-c', 'core.fsmonitor=false', '-c', 'core.ignoreStat=false', '-c', 'core.fileMode=true', ...args],
  { ...CLI_OPTIONS, cwd: repo, env, input })
  const top = git(['rev-parse', '--show-toplevel']).toString('utf8').replace(/\n$/u, '')
  if (realpathSync(top) !== repo) throw new Error('native_compose_repository_root_required')
  const sha = git(['rev-parse', '--verify', 'HEAD^{commit}']).toString('ascii').trim()
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(sha)) throw new Error('native_compose_commit_required')
  // Lowercase tags and S are assume-unchanged and skip-worktree; neither can establish a clean checkout.
  if (git(['ls-files', '-vz']).toString('utf8').split('\0').some((entry) => /^[a-zS] /u.test(entry)) ||
    git(['status', '--porcelain=v1', '--untracked-files=no', '--ignore-submodules=none']).length) {
    throw new Error('native_compose_clean_tracked_checkout_required')
  }

  // Ignore ambient TMPDIR; this project must live outside the checkout, even if TMPDIR points inside it.
  const tmp = realpathSync('/tmp')
  const relative = path.relative(repo, tmp)
  if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    throw new Error('native_compose_staging_outside_repository_required')
  }
  const dir = mkdtempSync(path.join(tmp, PREFIX))
  const identity = lstatSync(dir, { bigint: true })
  const uid = BigInt(process.getuid())
  let disposed = false
  function checkStage() {
    try {
      const current = lstatSync(dir, { bigint: true })
      if (path.dirname(dir) === tmp && path.basename(dir).startsWith(PREFIX) && current.isDirectory() &&
        current.dev === identity.dev && current.ino === identity.ino && current.uid === uid &&
        (current.mode & 0o777n) === 0o700n && realpathSync(dir) === dir) return
    } catch { /* A missing or inaccessible directory cannot establish identity. */ }
    throw new Error('native_compose_staging_identity_changed')
  }
  function dispose() {
    if (disposed) return
    checkStage()
    try { rmSync(dir, { recursive: true }) } catch { throw new Error('native_compose_staging_cleanup_failed') }
    disposed = true
  }
  const work = path.join(dir, 'work'), snapshotFile = path.join(dir, 'snapshot.json')
  try {
    checkStage()
    mkdirSync(work, { mode: 0o700 })
    exportTree(git, sha, work)
    writeFileSync(snapshotFile, SNAPSHOT, { flag: 'wx', mode: 0o444 })
    chmodSync(snapshotFile, 0o444) // Readable by the container UID even when the operator has a restrictive umask.
    return { sha, dir, work, snapshotFile, dispose }
  } catch (error) {
    try { dispose() } catch { throw new Error('native_compose_staging_cleanup_failed') }
    throw error
  }
}
