import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { openWorkspaceCatalog } from '../../apps/headless/src/business/workspace-catalog.mjs'
import { openWorkspaceFiles } from '../../apps/headless/src/files/workspace-files.mjs'
import { initializeMasterKey } from '../../apps/headless/src/storage/vault.mjs'

export class ProjectDocumentsFailure extends Error {}
export function check(ok, reason) {
  if (!ok) throw new ProjectDocumentsFailure(reason)
}

export const alpha = 'Alpha', beta = 'Beta', docs = 'docs', nested = 'docs/nested'
export const guide = 'docs/nested/guide.md', alphaMarker = 'alpha.txt', betaMarker = 'beta.txt'
export const excluded = 'docs/nested/excluded-link.md'
export const guideText = '# Field guide\n\nAn unchanged café note.\n'
export const name = 'Café 记录.md', documentPath = `${nested}/${name}`
export const content = '# Café 记录\n\nFirst line.\n  Indented second line.\nEnd.\n'
export const conflictDraft = '# Separate draft\n\nLeave the first note intact.\n'
export const dismissedName = 'Discarded draft.md', dismissedText = '# Discarded\nNo file should appear.\n'
export const uncertainName = 'Readback check.md', uncertainPath = `${nested}/${uncertainName}`
export const uncertainText = '# Readback check\n\nOne explicit create.\n'
export const workId = /^w_[0-9a-f]{32}$/
export const intentId = /^di_[0-9a-f]{32}$/

const uid = () => BigInt(process.geteuid())
const metadata = path => lstat(path, { bigint: true })
const mode = info => Number(info.mode & 0o7777n)
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.gid === b.gid
const nativeDir = path => mkdir(path, { mode: 0o700 })
const nativeFile = (path, text) => writeFile(path, text, { flag: 'wx', mode: 0o600 })

async function directory(path) {
  const info = await metadata(path)
  check(info.isDirectory() && mode(info) === 0o700 && info.uid === uid() && await realpath(path) === path,
    'Expected an owned, canonical mode 0700 fixture directory')
  return info
}

async function file(path, exactText) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await handle.stat({ bigint: true })
    const current = await metadata(path)
    check(info.isFile() && info.nlink === 1n && mode(info) === 0o600 && info.uid === uid() &&
      sameIdentity(info, current) && await realpath(path) === path, 'Expected a private, ordinary, singly linked fixture file')
    check((await handle.readFile()).equals(Buffer.from(exactText)), 'Native read-only file bytes differed from the exact fixture text')
    return info
  } finally { await handle.close() }
}

export async function makePrivateRoot() {
  const prefix = join(await realpath(tmpdir()), 'deva-wb-project-documents-')
  const root = await mkdtemp(prefix)
  check(root.startsWith(prefix) && root.length === prefix.length + 6, 'Unexpected private test directory name')
  const id = await directory(root)
  return {
    root,
    async close() {
      check(sameIdentity(id, await directory(root)), 'Private test directory identity changed before cleanup')
      await rm(root, { recursive: true })
    }
  }
}

async function absent(path) {
  try { await metadata(path) } catch (error) { if (error.code === 'ENOENT') return; throw error }
  check(false, 'A fixture destination appeared without the expected explicit Create')
}

export async function seedDocuments(root) {
  const [dataDir, keyFile, runDir, workspaceRoot] = ['data', 'master.key', 'run', 'projects'].map(name => join(root, name))
  const alphaDir = join(workspaceRoot, alpha), betaDir = join(workspaceRoot, beta)
  const outside = join(root, 'outside-synthetic.md')
  const originals = [
    [join(alphaDir, guide), guideText], [join(alphaDir, alphaMarker), 'Alpha original.\n'],
    [join(betaDir, betaMarker), 'Beta original.\n'], [outside, 'Outside synthetic sentinel.\n']
  ]
  const link = join(alphaDir, excluded)
  const dirs = [workspaceRoot, alphaDir, join(alphaDir, docs), join(alphaDir, nested), betaDir]
  for (const path of dirs) await nativeDir(path)
  for (const [path, text] of originals) await nativeFile(path, text)
  await symlink(outside, link)
  const linkStat = await metadata(link)
  const fileStats = await Promise.all(originals.map(([path, text]) => file(path, text)))
  const dirStats = await Promise.all(dirs.map(directory))
  await initializeMasterKey(keyFile)
  const keyStat = await metadata(keyFile)
  check(keyStat.isFile() && keyStat.uid === uid() && keyStat.nlink === 1n && mode(keyStat) === 0o600,
    'The explicitly initialized fixture key is not a private regular file')

  const allowed = new Map([[documentPath, content], [uncertainPath, uncertainText]])
  const creationTarget = path => {
    check(allowed.has(path), 'Unexpected synthetic creation target')
    return join(alphaDir, path)
  }
  return {
    root, dataDir, keyFile, runDir, workspaceRoot,
    checkAbsent: path => absent(creationTarget(path)),
    async created(path, before = undefined) {
      const target = creationTarget(path)
      const current = await file(target, allowed.get(path))
      check(!fileStats.some(old => current.dev === old.dev && current.ino === old.ino) &&
        (!before || (sameIdentity(current, before) && current.mtimeNs === before.mtimeNs && current.ctimeNs === before.ctimeNs)),
      'Created file was not a new inode, or a later action changed that file')
      check(sameIdentity(dirStats[3], await directory(dirname(target))), 'The listed nested parent changed identity')
      return current
    },
    async assertLayout(created = []) {
      check(created.every(path => allowed.has(path)), 'Unexpected path in synthetic layout assertion')
      const expected = [[alpha, beta], [alphaMarker, docs], ['nested'],
        [guide.split('/').at(-1), excluded.split('/').at(-1), ...created.map(path => path.split('/').at(-1))], [betaMarker]]
      for (const [i, path] of dirs.entries()) {
        check(sameIdentity(dirStats[i], await directory(path)) && isDeepStrictEqual((await readdir(path)).sort(), expected[i].sort()),
          'Fixture directory identity, intended parent, or exact sibling set changed')
      }
      for (const [i, [path, text]] of originals.entries()) {
        const current = await file(path, text), before = fileStats[i]
        check(sameIdentity(before, current) && before.mtimeNs === current.mtimeNs && before.ctimeNs === current.ctimeNs,
          'A pre-existing fixture file changed identity, timestamps, or bytes')
      }
      const currentLink = await metadata(link)
      check(currentLink.isSymbolicLink() && sameIdentity(linkStat, currentLink) && await readlink(link) === outside,
        'The excluded symlink changed')
    }
  }
}

/** Exercise the real Linux catalog and file readers without built assets/Chrome. */
export async function checkFixture(fixture) {
  const catalog = openWorkspaceCatalog({ root: fixture.workspaceRoot, privateRoots: [fixture.dataDir, fixture.keyFile, fixture.runDir] })
  try {
    const rows = catalog.list()
    const first = rows.find(row => row.name === alpha), second = rows.find(row => row.name === beta)
    check(rows.length === 2 && workId.test(first?.id) && workId.test(second?.id) && first.id !== second.id,
      'Production catalog did not resolve exactly two independent synthetic projects')
    const readonly = openWorkspaceFiles({ catalog })
    const writable = openWorkspaceFiles({ catalog, writable: true })
    const root = await writable.list(first.id, '')
    const parent = await writable.list(first.id, nested)
    const other = await readonly.list(second.id, '')
    const read = await readonly.read(first.id, guide)
    check(root.path === '' && root.writable && parent.path === nested && parent.writable &&
      isDeepStrictEqual(parent.entries, [{ name: 'guide.md', path: guide, type: 'file' }]) &&
      other.entries.length === 1 && other.entries[0].path === betaMarker && !other.writable &&
      read.path === guide && read.content === guideText && !read.writable,
    'Production catalog/tree did not isolate the expected writable parent and unchanged read-only source')
  } finally { catalog.close() }
  await fixture.assertLayout()
}
