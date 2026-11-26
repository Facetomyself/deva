import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { isDeepStrictEqual, promisify } from 'node:util'

export class GitViewCheckError extends Error {}
export function check(condition, description) {
  if (!condition) throw new GitViewCheckError(description)
}

export const alpha = 'Alpha', beta = 'Beta', notes = 'notes.txt', betaFile = 'beta-only.txt'
export const branch = 'qa-main', extraBranch = 'qa-review'
export const earlierSubject = 'QA records the initial notes', headSubject = 'QA revises the committed notes'
export const headLine = 'HEAD-only previous note', stagedLine = 'Index-only previous note', worktreeLine = 'Worktree-only new note'
const stagedLead = 'Index inserts a numbered line'
const initialText = 'QA header\nInitial committed note\nQA footer\n'
const headText = `QA header\n${headLine}\nQA footer\n`
const stagedText = `QA header\n${stagedLead}\n${stagedLine}\nQA footer\n`
const worktreeText = `QA header\n${stagedLead}\n${worktreeLine}\nQA footer\n`
const author = 'Git View QA'
export const email = 'git-view-qa@example.invalid', configMarker = 'QA-native-config-only-marker'

const exec = promisify(execFile)
const gitBin = '/usr/bin/git'
const sha1 = /^[0-9a-f]{40}$/
const mkdirPrivate = path => mkdir(path, { mode: 0o700 })

/** Only delete the original private mkdtemp inode, after its identity is rechecked. */
export async function makeGitViewRoot() {
  const parent = await realpath(tmpdir())
  const prefix = join(parent, 'deva-wb-git-view-')
  const root = await mkdtemp(prefix)
  const identity = await lstat(root)
  check(dirname(root) === parent && root.startsWith(prefix) && /^[A-Za-z0-9]{6}$/.test(root.slice(prefix.length)),
    'Unexpected Git View temporary directory')
  async function verify() {
    const current = await lstat(root)
    check(current.isDirectory() && current.uid === process.geteuid() && (current.mode & 0o777) === 0o700 &&
      current.dev === identity.dev && current.ino === identity.ino && await realpath(root) === root,
    'Git View temporary directory identity changed')
  }
  await verify()
  return { root, verify, async close() { await verify(); await rm(root, { recursive: true }) } }
}

async function seedRepository({ temp, alphaDir, signal }) {
  const { root } = temp
  const home = join(root, 'git-home'), empty = join(root, 'git-no-hooks')
  await mkdirPrivate(home)
  await mkdirPrivate(empty)
  const file = join(alphaDir, notes)
  const env = {
    PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: home, XDG_CONFIG_HOME: home, TMPDIR: root,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1',
    GIT_ALLOW_PROTOCOL: '', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
    GIT_AUTHOR_NAME: author, GIT_COMMITTER_NAME: author, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email
  }
  async function git(args, date = '2024-01-01T12:00:00Z') {
    await temp.verify()
    check(await realpath(alphaDir) === alphaDir && (await lstat(alphaDir)).isDirectory(), 'Git fixture project escaped its directory')
    try {
      const { stdout } = await exec(gitBin, ['-c', `core.hooksPath=${empty}`, '-c', 'core.autocrlf=false',
        '-c', 'commit.gpgSign=false', '-c', 'gc.auto=0', ...args], {
        cwd: alphaDir, env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
        signal, timeout: 12_000, maxBuffer: 128 * 1024
      })
      return stdout
    } catch {
      throw new GitViewCheckError(`Synthetic fixture git ${args[0]} failed (requires ${gitBin})`)
    }
  }
  await git(['init', '--quiet', '--template=', '--object-format=sha1', `--initial-branch=${branch}`])
  await git(['config', '--local', 'qa.nativeConfigOnly', configMarker])
  await writeFile(file, initialText, { mode: 0o600, flag: 'wx' })
  await git(['add', '--', notes])
  await git(['commit', '--quiet', '-m', earlierSubject])
  const first = (await git(['rev-parse', 'HEAD'])).trim()
  await git(['branch', '--', extraBranch, first])
  await writeFile(file, headText)
  await git(['add', '--', notes])
  await git(['commit', '--quiet', '-m', headSubject], '2024-01-02T12:00:00Z')
  const head = (await git(['rev-parse', 'HEAD'])).trim()
  check(sha1.test(first) && sha1.test(head) && first !== head && await git(['status', '--porcelain=v1']) === '',
    'Expected two SHA-1 commits and a clean baseline')
  await writeFile(file, stagedText)
  await git(['add', '--', notes])
  await writeFile(file, worktreeText)
  await git(['gc', '--quiet'])

  const gitDir = join(alphaDir, '.git')
  const packNames = await readdir(join(gitDir, 'objects', 'pack'))
  const pack = packNames.find(name => /^pack-[0-9a-f]{40}\.pack$/.test(name))
  const stats = await git(['count-objects', '-v'])
  check((await lstat(gitDir)).isDirectory() && await realpath(gitDir) === gitDir &&
    pack !== undefined && packNames.includes(`${basename(pack, '.pack')}.idx`) && /^count: 0$/m.test(stats) &&
    /^in-pack: [1-9]\d*$/m.test(stats), 'Git gc did not leave the real SHA-1 repository backed by a pack and index')
  check(await git(['rev-parse', '--show-object-format']) === 'sha1\n' &&
    await git(['rev-list', '--first-parent', 'HEAD']) === `${head}\n${first}\n` &&
    await git(['for-each-ref', '--sort=refname', '--format=%(refname:short):%(objectname)', 'refs/heads']) ===
      `${branch}:${head}\n${extraBranch}:${first}\n` && await git(['remote']) === '', 'Unexpected synthetic Git history or configuration')
  check(await git(['log', '-2', '--format=%s']) === `${headSubject}\n${earlierSubject}\n` &&
    await git(['status', '--porcelain=v1', '--untracked-files=all']) === `MM ${notes}\n` &&
    await git(['show', `HEAD:${notes}`]) === headText && await git(['show', `:${notes}`]) === stagedText &&
    await readFile(file, 'utf8') === worktreeText, 'Expected one tracked file with three distinct Git baselines')
  return { first, head }
}

/** Capture every directory and regular file in both projects, including HEAD, config, index,
 * refs, the pack, and worktree files. Reads may advance atime; content and mtime must stay put. */
async function snapshotProjects(workspaceRoot) {
  check(await realpath(workspaceRoot) === workspaceRoot, 'Workspace parent identity changed')
  const entries = []
  async function visit(relative) {
    const path = join(workspaceRoot, relative)
    const stat = await lstat(path, { bigint: true })
    const identity = { relative, ino: stat.ino, dev: stat.dev, mode: stat.mode, mtime: stat.mtimeNs }
    if (stat.isDirectory()) {
      entries.push(identity)
      for (const name of (await readdir(path)).sort()) await visit(join(relative, name))
    } else {
      check(stat.isFile() && stat.nlink === 1n, 'Unexpected special or hard-linked Git fixture file')
      entries.push({ ...identity, size: stat.size, hash: createHash('sha256').update(await readFile(path)).digest('hex') })
    }
  }
  await visit('')
  return entries
}

export async function seedGitViewFixture(temp, signal) {
  await temp.verify()
  const workspaceRoot = join(temp.root, 'projects')
  const alphaDir = join(workspaceRoot, alpha), betaDir = join(workspaceRoot, beta)
  await mkdirPrivate(workspaceRoot)
  await mkdirPrivate(alphaDir)
  await mkdirPrivate(betaDir)
  await writeFile(join(betaDir, betaFile), 'Synthetic Beta project; Git access is not granted.\n', { mode: 0o600, flag: 'wx' })
  const commits = await seedRepository({ temp, alphaDir, signal })
  const before = await snapshotProjects(workspaceRoot)
  return {
    workspaceRoot, ...commits,
    privateMarkers: [temp.root, email, configMarker, '[core]', 'repositoryformatversion'],
    async assertUnchanged() {
      await temp.verify()
      check(isDeepStrictEqual(await snapshotProjects(workspaceRoot), before),
        'Git inspection changed workspace contents, metadata, or file timestamps')
    }
  }
}
