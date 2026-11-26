import { createHash } from 'node:crypto'
import { accessSync, constants as C, openSync, opendirSync, readSync } from 'node:fs'
import { DIRECTORY, PATH, close, decodeUtf8, fdPath, mountId, stat } from '../files/workspace-files-fd.mjs'
import { fail, SkillDocumentError } from './documents-errors.mjs'
import { isBuiltinAlias, isSkillId } from './documents-ids.mjs'

const MAX_ENTRIES = 512
const MAX_SKILLS = 128
const MAX_FILE_BYTES = 128 * 1024
const MAX_TOTAL_BYTES = 4 * 1024 * 1024
const SKILL_FILE = 'SKILL.md'
export const revision = parts => createHash('sha256').update(JSON.stringify(parts)).digest('hex')

function at(fd, name, flags = PATH) {
  try { return openSync(fdPath(fd, name), flags) } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return undefined
  }
}

function snapshot(fd) {
  const info = stat(fd), mount = mountId(fd)
  // Older Linux can substitute ctime for birthtime. Directory identities must
  // survive ordinary sibling entry changes; file versions retain all file times.
  const identity = [mount, info.dev, info.ino].join(':')
  const permission = [info.uid, info.gid, info.mode].join(':')
  const birthtime = info.isFile() ? info.birthtimeNs : ''
  const version = [identity, permission, info.nlink, info.size, birthtime, info.ctimeNs, info.mtimeNs].join(':')
  return { info, mount, identity, permission, version }
}

function ownedDirectory(record, fd, uid, mount) {
  const { info } = record
  if (!info.isDirectory() || (mount !== undefined && record.mount !== mount) || info.uid !== uid ||
      (info.mode & 0o7022n) !== 0n || (info.mode & 0o500n) !== 0o500n) fail()
  accessSync(fdPath(fd), C.R_OK | C.X_OK)
}

function ownedDocument(record, fd, uid, mount) {
  const { info } = record
  if (!info.isFile() || record.mount !== mount || info.uid !== uid || info.nlink !== 1n ||
      (info.mode & 0o7133n) !== 0n || (info.mode & 0o400n) === 0n) fail()
  accessSync(fdPath(fd), C.R_OK)
  if (info.size > BigInt(MAX_FILE_BYTES)) fail('skill_limit')
}

function assertEntry(parent, name, expected, compare) {
  const fd = at(parent, name)
  try {
    if (fd === undefined) { if (expected) fail(); return }
    if (!expected) fail()
    const current = snapshot(fd)
    if (current[compare] !== expected[compare] || current.permission !== expected.permission) fail()
  } finally { close(fd) }
}

function assertChain(chain) {
  for (const { parent, name, fd, record } of chain) {
    const held = snapshot(fd)
    // Changes to unrelated siblings above the data root are immaterial, but the
    // pathname binding and permissions of every traversed ancestor must stay put.
    if (held.identity !== record.identity || held.permission !== record.permission) fail()
    if (parent !== undefined) assertEntry(parent, name, record, 'identity')
  }
}

function withDataRoot(parts, task) {
  const chain = []
  let fd = openSync('/', DIRECTORY)
  try {
    chain.push({ fd })
    chain[0].record = snapshot(fd)
    for (const name of parts) {
      const parent = fd
      fd = at(parent, name, DIRECTORY)
      if (fd === undefined) fail()
      const step = { parent, name, fd }
      chain.push(step)
      step.record = snapshot(fd)
    }
    const root = chain.at(-1).record, uid = BigInt(process.geteuid())
    ownedDirectory(root, fd, uid)
    assertChain(chain)
    task({ fd, root, uid })
    assertChain(chain)
  } finally {
    for (let i = chain.length - 1; i >= 0; i--) close(chain[i].fd)
  }
}

function namesIn(skills) {
  const dir = opendirSync(fdPath(skills, '.'), { encoding: 'buffer', bufferSize: 32 })
  const names = new Set(), folded = new Set()
  let scanned = 0
  try {
    for (let entry; (entry = dir.readSync()) !== null;) {
      if (++scanned > MAX_ENTRIES) fail('skill_limit')
      if (entry.name[0] === 46) continue // Hidden native entries are outside the catalog.
      if (entry.isSymbolicLink()) fail()
      if (!entry.isDirectory()) continue // Foreign files still count against the scan bound.
      const name = decodeUtf8(entry.name)
      const lower = name.toLowerCase()
      if (!isSkillId(name) || isBuiltinAlias(name) || folded.has(lower)) fail()
      names.add(name)
      folded.add(lower)
    }
  } finally { dir.closeSync() }
  return names
}

function reader(file, expected, use) {
  // Reopen only the held, checked inode, never an untrusted pathname. In particular,
  // stat-only callers never open a document for reading (or invoke a device handler).
  const fd = openSync(fdPath(file), C.O_RDONLY | C.O_NONBLOCK)
  try {
    if (snapshot(fd).version !== expected.version) fail()
    const result = use(Number(expected.info.size), (bytes, offset, length, pos) => {
      let done = 0
      while (done < length) {
        const n = readSync(fd, bytes, offset + done, length - done, pos + done)
        if (n === 0) fail()
        done += n
      }
    })
    if (snapshot(fd).version !== expected.version) fail()
    return result
  } finally { close(fd) }
}

function inspect(skills, scope, id, visit) {
  const dir = at(skills, id, DIRECTORY)
  if (dir === undefined) fail()
  let file
  try {
    const directory = snapshot(dir)
    ownedDirectory(directory, dir, scope.uid, scope.root.mount)
    file = at(dir, SKILL_FILE)
    if (file === undefined) return { id, directory, document: null }
    const document = snapshot(file)
    ownedDocument(document, file, scope.uid, scope.root.mount)
    const documentRevision = revision(['deva-skill-document-v1', id, scope.root.identity,
      scope.skillsRoot.identity, directory.identity, document.version])
    visit(id, documentRevision, Number(document.info.size), use => reader(file, document, use))
    if (snapshot(file).version !== document.version) fail()
    return { id, directory, document }
  } finally { close(file); close(dir) }
}

function assertInspected(skills, { id, directory, document }) {
  const dir = at(skills, id, DIRECTORY)
  if (dir === undefined) fail()
  try {
    if (snapshot(dir).version !== directory.version) fail()
    assertEntry(dir, SKILL_FILE, document, 'version')
    if (snapshot(dir).version !== directory.version) fail()
  } finally { close(dir) }
}

function inspectSkills(scope, selected, visit) {
  const skills = at(scope.fd, 'skills', DIRECTORY)
  try {
    if (skills === undefined) {
      assertEntry(scope.fd, 'skills', null, 'version')
      return
    }
    scope.skillsRoot = snapshot(skills)
    ownedDirectory(scope.skillsRoot, skills, scope.uid, scope.root.mount)
    const names = namesIn(skills)
    const inspected = []
    let count = 0, total = 0
    for (const id of selected === undefined ? names : names.has(selected) ? [selected] : []) {
      inspected.push(inspect(skills, scope, id, (id, rev, bytes, read) => {
        total += bytes
        if (++count > MAX_SKILLS || total > MAX_TOTAL_BYTES) fail('skill_limit')
        visit(id, rev, read)
      }))
    }
    for (const entry of inspected) assertInspected(skills, entry)
    assertEntry(scope.fd, 'skills', scope.skillsRoot, 'version')
  } finally { close(skills) }
}

/** Hold one canonical data-root inode after the first successful native access. */
export function nativeSkillDocuments(parts) {
  let rootPin, closed = false
  function assertOpen() { if (closed) fail() }
  function inspect(selected, visit) {
    assertOpen()
    let candidate
    try {
      if (process.platform !== 'linux' || typeof process.geteuid !== 'function') fail()
      withDataRoot(parts, scope => {
        if (rootPin !== undefined && snapshot(rootPin).identity !== scope.root.identity) fail()
        inspectSkills(scope, selected, visit)
        if (rootPin === undefined) {
          candidate = openSync(fdPath(scope.fd, '.'), DIRECTORY)
          if (snapshot(candidate).identity !== scope.root.identity) fail()
        }
      })
      if (candidate !== undefined) {
        rootPin = candidate
        candidate = undefined
      }
    } catch (error) {
      if (error instanceof SkillDocumentError) throw error
      fail() // Kernel paths and raw filesystem error text never reach callers.
    } finally { close(candidate) }
  }
  return {
    assertOpen,
    inspect,
    close() {
      if (closed) return
      closed = true
      const fd = rootPin
      rootPin = undefined
      close(fd)
    }
  }
}
