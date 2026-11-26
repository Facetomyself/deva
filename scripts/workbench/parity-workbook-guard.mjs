import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

const fullSha = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
export const validSha = (sha) => typeof sha === 'string' && fullSha.test(sha)
const plainDir = (stat) => stat?.isDirectory() && !stat.isSymbolicLink()
const sameFile = (a, b) => !!a && !!b && a.dev === b.dev && a.ino === b.ino
const singleFile = (stat) => stat?.isFile() && stat.nlink === 1n

function noEntry(path) {
  try { return lstatSync(path, { bigint: true }) } catch (error) { if (error.code !== 'ENOENT') throw error }
}

function gitAt(root, args) {
  // Use this checkout only, without replacement objects, external transports, or Git diagnostics that may contain remote details.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)))
  Object.assign(env, {
    GIT_ALLOW_PROTOCOL: '', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  })
  try {
    return execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], {
      cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024,
    })
  } catch {
    throw new Error(`Git ${args[0]} failed in the exporter checkout`)
  }
}

function entries(raw, index) {
  const map = new Map()
  for (const line of raw.split('\0')) {
    if (!line) continue
    const tab = line.indexOf('\t')
    const [mode, first, second] = line.slice(0, tab).split(' ')
    if (index ? second === '0' : first === 'blob') map.set(line.slice(tab + 1), `${mode} ${index ? first : second}`)
  }
  return map
}

export function snapshotFromEntries(root, sha, tree, index) {
  if (!validSha(sha)) throw new Error('Expected an exact Git commit SHA')
  const base = realpathSync(root)
  const verified = new Map()
  return {
    sha,
    verified,
    read(file) {
      if (verified.has(file)) return verified.get(file)
      if (typeof file !== 'string' || /[\\:\x00-\x1f\x7f]/.test(file) || file.split('/').some((part) => !part || part === '.' || part === '..')) {
        throw new Error(`Invalid repository path: ${JSON.stringify(file)}`)
      }
      const committed = tree.get(file)
      if (!/^100(?:644|755) [0-9a-f]+$/.test(committed ?? '') || committed !== index.get(file)) {
        throw new Error(`HEAD/index mismatch or missing exact-case tracked file: ${file}`)
      }
      const parts = file.split('/')
      let path = base
      for (const part of parts.slice(0, -1)) {
        path = join(path, part)
        if (!plainDir(noEntry(path))) throw new Error(`Expected a real worktree directory for: ${file}`)
      }
      path = join(path, parts.at(-1))
      if (!noEntry(path)?.isFile() || realpathSync(path) !== path) throw new Error(`Expected a real, exact-case worktree file: ${file}`)
      const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
      let bytes
      try {
        if (!fstatSync(fd).isFile()) throw new Error(`Expected a regular worktree file: ${file}`)
        bytes = readFileSync(fd)
      } finally { closeSync(fd) }
      const blob = createHash(sha.length === 40 ? 'sha1' : 'sha256').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
      if (blob !== committed.split(' ')[1]) throw new Error(`Worktree bytes differ from HEAD/index: ${file}`)
      verified.set(file, bytes)
      return bytes
    },
  }
}

export function openSnapshot(root) {
  const base = realpathSync(root)
  if (realpathSync(gitAt(base, ['rev-parse', '--show-toplevel']).replace(/\r?\n$/, '')) !== base) throw new Error('Expected exporter at the checkout root')
  const head = () => gitAt(base, ['rev-parse', '--verify', 'HEAD']).trim()
  const staged = () => entries(gitAt(base, ['ls-files', '--stage', '-z']), true)
  const sha = head()
  if (!validSha(sha)) throw new Error('Expected an exact Git commit SHA from HEAD')
  const tree = entries(gitAt(base, ['ls-tree', '-r', '-z', sha]), false)
  const index = staged()
  const snapshot = snapshotFromEntries(base, sha, tree, index)
  return Object.assign(snapshot, {
    assertCurrent() {
      if (head() !== sha) throw new Error('HEAD changed during workbook export')
      const current = snapshotFromEntries(base, sha, tree, staged())
      for (const file of snapshot.verified.keys()) current.read(file)
      if (head() !== sha) throw new Error('HEAD changed during workbook export')
    },
  })
}

function outputDirectory(root, sha) {
  const base = realpathSync(root)
  const dirs = new Map([[base, noEntry(base)]])
  const intact = () => [...dirs].every(([dir, initial]) => {
    const state = noEntry(dir)
    return plainDir(state) && sameFile(initial, state)
  })
  let next = base
  for (const part of ['test-results', `parity-${sha.slice(0, 7)}`]) {
    if (!intact()) throw new Error('Workbook output directory changed')
    next = join(next, part)
    if (!noEntry(next)) {
      try { mkdirSync(next, { mode: 0o755 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
    }
    const state = noEntry(next)
    if (!plainDir(state) || realpathSync(next) !== next) throw new Error(`Unsafe workbook output directory: ${next}`)
    dirs.set(next, state)
  }
  if (!intact()) throw new Error('Workbook output directory changed')
  return { path: next, intact }
}

function confirmExisting(output, bytes, initial, intact) {
  if (!singleFile(initial) || initial.size !== BigInt(bytes.length)) throw new Error(`Workbook target already exists or is unsafe: ${output}`)
  const fd = openSync(output, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const current = fstatSync(fd, { bigint: true })
    if (intact() && singleFile(current) && sameFile(initial, current) && current.size === initial.size &&
        readFileSync(fd).equals(bytes)) {
      const after = noEntry(output)
      if (intact() && singleFile(after) && sameFile(current, after) && after.ctimeNs === current.ctimeNs) return
    }
  } finally { closeSync(fd) }
  throw new Error(`Workbook target already exists with different bytes or changed: ${output}`)
}

export function publishWorkbook(root, sha, methodCount, payload) {
  if (!validSha(sha) || !Number.isSafeInteger(methodCount) || methodCount < 1) throw new Error('Invalid workbook output identity')
  const dir = outputDirectory(resolve(root), sha)
  const output = join(dir.path, `Deva-Web-${methodCount}项能力验收清单.xlsx`)
  const bytes = Buffer.from(payload)
  const existing = noEntry(output)
  if (existing) {
    confirmExisting(output, bytes, existing, dir.intact)
    return { output, reused: true }
  }
  // Publish complete bytes without a replace operation; removing the staging link restores nlink=1.
  const stage = join(dir.path, `.parity-workbook-${randomUUID()}.tmp`)
  if (!dir.intact()) throw new Error('Workbook output directory changed')
  const fd = openSync(stage, 'wx', 0o644)
  const staged = fstatSync(fd, { bigint: true })
  let created = false
  try {
    writeFileSync(fd, bytes)
    if (!dir.intact() || !sameFile(staged, noEntry(stage))) throw new Error('Workbook staging file or directory changed')
    try { linkSync(stage, output); created = true } catch (error) { if (error.code !== 'EEXIST') throw error }
  } finally {
    closeSync(fd)
    if (dir.intact() && sameFile(staged, noEntry(stage))) unlinkSync(stage)
  }
  const final = noEntry(output)
  if (created && !sameFile(staged, final)) throw new Error('Published workbook target changed')
  confirmExisting(output, bytes, final, dir.intact)
  return { output, reused: !created }
}
