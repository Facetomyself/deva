import { randomBytes } from 'node:crypto'
import {
  constants as C, fchmodSync, fsyncSync, linkSync, openSync, opendirSync, readSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { isPromise } from 'node:util/types'
import { PATH, close, decodeUtf8, fdPath, mountId, sameInode, stat } from './workspace-files-fd.mjs'
import { access, pinWorkspaceDirectory } from './workspace-files-pin.mjs'
import { workspaceTextRevision } from './workspace-files.mjs'
import {
  ProjectDocumentError, assertDocumentDisclosure, documentNameKey, projectDocumentBytes, projectDocumentPath, rejectDocument,
} from './project-document-names.mjs'

const DIR_FLAGS = C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW
const STAGE_FLAGS = C.O_RDWR | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW | C.O_NONBLOCK
const MAX_SCAN = 4096
const STAGE_PREFIX = '.project-document-'
const changed = () => rejectDocument('document_changed')
const unconfirmed = () => rejectDocument('document_unconfirmed')

function closeQuietly(fd) { try { close(fd) } catch { /* close must not mask the outcome */ } }

function report(error, opening = false) {
  if (error instanceof ProjectDocumentError) throw error
  switch (error?.code) {
    case 'ERR_WORKSPACE_UNAVAILABLE': return rejectDocument('workspace_unavailable')
    case 'ERR_WORKSPACE_FILE_LIMIT': case 'ENOSPC': case 'EDQUOT': case 'EFBIG': return rejectDocument('document_limit')
    case 'ERR_WORKSPACE_FILE_CONFLICT': case 'ESTALE': return changed()
    case 'ENOENT': return rejectDocument(opening ? 'workspace_unavailable' : 'document_changed')
    case 'ERR_WORKSPACE_FILE_UNSAFE': case 'ENOTDIR': case 'ELOOP': return rejectDocument('document_unsafe')
    case 'EROFS': case 'EACCES': case 'EPERM': return rejectDocument('document_read_only')
    default: return unconfirmed()
  }
}

function directoryAccess(scope, writable) {
  const info = stat(scope.fd)
  const mode = C.R_OK | C.X_OK | (writable ? C.W_OK : 0)
  const uid = process.geteuid()
  const ownerMode = writable ? 0o700n : 0o500n
  // access(2) checks the applicable ACL and mount. Preserve owner-mode intent
  // even when the server is uid 0 or the group/other class has broader bits.
  if (((uid === 0 || BigInt(uid) === info.uid) && (info.mode & ownerMode) !== ownerMode) || !access(scope.fd, info, mode)) {
    rejectDocument('document_read_only')
  }
}

function assertDirectory(scope, writable) {
  directoryAccess(scope, writable)
  scope.assertCurrent()
  directoryAccess(scope, writable)
}

function probe(scope, name) {
  try { return openSync(fdPath(scope.fd, name), PATH) }
  catch (error) { if (error?.code !== 'ENOENT') throw error }
}

function rejectExisting(scope, name) {
  const fd = probe(scope, name)
  try {
    if (fd === undefined) return
    const info = stat(fd)
    if (mountId(fd) !== scope.project.mount || !info.isFile() || info.nlink !== 1n) rejectDocument('document_unsafe')
    rejectDocument('document_exists')
  } finally { closeQuietly(fd) }
}

function scanAliases(scope, name, key, ownStage, installed = false) {
  const directory = opendirSync(fdPath(scope.fd, '.'), { encoding: 'buffer' })
  let scanned = 0
  try {
    for (let entry; (entry = directory.readSync()) !== null;) {
      let spelling
      try { spelling = decodeUtf8(entry.name) } catch { /* unrelated non-UTF-8 name */ }
      if (ownStage !== undefined && spelling === ownStage) continue
      // Reserve a slot so a newly published document still fits the ordinary workspace listing cap.
      if (++scanned > MAX_SCAN - Number(!installed)) rejectDocument('document_limit')
      if (spelling !== undefined && !(installed && spelling === name) && documentNameKey(spelling) === key) {
        rejectExisting(scope, spelling)
      }
    }
  } finally { directory.closeSync() }
}

function assertAbsent(scope, name, key, ownStage) {
  rejectExisting(scope, name)
  scanAliases(scope, name, key, ownStage)
  rejectExisting(scope, name)
}

function verifyOwnerNow(verifyOwner) {
  let verified
  try {
    verified = verifyOwner()
    // A rejected async callback is still a synchronous authorization failure.
    // Observe native rejections without running arbitrary thenables.
    if (isPromise(verified)) Promise.prototype.then.call(verified, undefined, () => {})
  } catch { rejectDocument('auth') }
  if (verified !== true) rejectDocument('auth')
}

function makeStage(parent) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const name = `${STAGE_PREFIX}${randomBytes(16).toString('hex')}.tmp`
    try { return { name, fd: openSync(fdPath(parent, name), STAGE_FLAGS, 0o600) } }
    catch (error) { if (error?.code !== 'EEXIST') throw error }
  }
  return unconfirmed()
}

function ownFile(info, size, links) {
  return info.isFile() && info.size === BigInt(size) && info.nlink === BigInt(links) &&
    (info.mode & 0o7777n) === 0o600n && info.uid === BigInt(process.geteuid())
}

function sameContents(a, b) {
  return sameInode(a, b) && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid && a.size === b.size && a.mtimeNs === b.mtimeNs
}

function sameSnapshot(a, b) {
  return sameContents(a, b) && a.nlink === b.nlink && a.ctimeNs === b.ctimeNs && a.birthtimeNs === b.birthtimeNs
}

function assertNamed(scope, name, expected) {
  const fd = probe(scope, name)
  try {
    if (fd === undefined || mountId(fd) !== scope.project.mount || !sameSnapshot(expected, stat(fd))) changed()
  } finally { closeQuietly(fd) }
}

function readStable(fd, expected) {
  const bytes = Buffer.alloc(Number(expected.size))
  let offset = 0
  while (offset < bytes.length) {
    const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
    if (!count) changed()
    offset += count
  }
  if (!sameSnapshot(expected, stat(fd))) changed()
  return bytes
}

function assertStage(scope, stage, prepared, bytes, links) {
  const info = stat(stage.fd)
  if (!ownFile(info, bytes.length, links) || !sameContents(prepared, info) || !readStable(stage.fd, info).equals(bytes)) changed()
  assertNamed(scope, stage.name, info)
  return info
}

function removeStage(scope, parent, stage) {
  const fd = probe(scope, stage.name)
  try {
    if (fd === undefined || mountId(fd) !== scope.project.mount || !sameInode(stat(stage.fd), stat(fd))) return false
    // Node exposes no inode-conditional unlink. Check a held no-follow pin
    // immediately before unlink; observed replacements are left untouched.
    unlinkSync(fdPath(parent, stage.name))
    return true
  } finally { closeQuietly(fd) }
}

function readInstalled(scope, name, key, fd, info, writable) {
  assertDirectory(scope, writable)
  assertNamed(scope, name, info)
  scanAliases(scope, name, key, undefined, true)
  const bytes = readStable(fd, info)
  assertDirectory(scope, writable)
  assertNamed(scope, name, info)
  return bytes
}

/** Opt-in, single-target lease for creating a visible document in a granted project. */
export function openProjectDocumentTarget(catalog, workspaceId, input) {
  let scope, target, key
  try {
    target = projectDocumentPath(input)
    key = documentNameKey(target.name)
    if (typeof catalog?.pinProject !== 'function') rejectDocument('workspace_unavailable')
    scope = pinWorkspaceDirectory(catalog, workspaceId, target.parts)
    assertDocumentDisclosure([scope.project.name])
    assertDirectory(scope, true)
  } catch (error) {
    try { scope?.close() } catch { /* do not expose native errors */ }
    report(error, true)
  }
  const { name, path } = target
  let closed = false, busy = false, sealed = false, receipt

  function release() {
    closeQuietly(receipt?.fd)
    receipt = undefined
    try { scope.close() } catch { /* close is idempotent and non-throwing */ }
  }
  function assertOpen() { if (closed) changed() }
  function run(fn) {
    assertOpen()
    if (busy) changed()
    busy = true
    try { return fn() } catch (error) { report(error) }
    finally { busy = false; if (closed) release() }
  }
  function verifyAbsent() {
    return run(() => {
      assertDirectory(scope, true)
      assertAbsent(scope, name, key)
      assertDirectory(scope, true)
      assertOpen()
      return true
    })
  }
  function publish(content, verifyOwner) {
    return run(() => {
      if (sealed) { if (receipt) rejectDocument('document_exists'); unconfirmed() }
      const bytes = projectDocumentBytes(content)
      let parent, stage, removed = false
      try {
        verifyOwnerNow(verifyOwner)
        assertOpen()
        assertDirectory(scope, true)
        assertAbsent(scope, name, key)
        parent = openSync(fdPath(scope.fd, '.'), DIR_FLAGS)
        if (!sameInode(stat(parent), stat(scope.fd)) || mountId(parent) !== scope.project.mount) changed()
        assertDirectory(scope, true)
        stage = makeStage(parent)
        fchmodSync(stage.fd, 0o600)
        writeFileSync(stage.fd, bytes)
        fsyncSync(stage.fd)
        const prepared = stat(stage.fd)
        if (mountId(stage.fd) !== scope.project.mount) rejectDocument('document_unsafe')
        assertStage(scope, stage, prepared, bytes, 1)

        assertAbsent(scope, name, key, stage.name)
        // Put the live owner check after the bounded but potentially slow alias scan.
        // The callback can mutate state; only recheck pinned identities and the exact
        // destination after it returns, leaving the final alias scan to readback.
        verifyOwnerNow(verifyOwner)
        assertOpen()
        assertDirectory(scope, true)
        rejectExisting(scope, name)
        assertNamed(scope, stage.name, prepared)
        // link(2) is no-overwrite, including for symlinks and equal existing bytes.
        // Node's source operand is name-based: verify the original held inode both
        // sides of this call and treat an ambiguous outcome as sealed, never undo it.
        sealed = true
        try { linkSync(fdPath(parent, stage.name), fdPath(parent, name)) }
        catch (error) {
          if (error?.code === 'EEXIST') {
            const existing = probe(scope, name)
            try { if (existing !== undefined && sameInode(prepared, stat(existing))) unconfirmed() }
            finally { closeQuietly(existing) }
            sealed = false
            rejectExisting(scope, name)
            rejectDocument('document_exists')
          }
          if (['EACCES', 'EPERM', 'EROFS'].includes(error?.code)) sealed = false
          throw error
        }

        verifyOwnerNow(verifyOwner)
        assertOpen()
        assertDirectory(scope, true)
        const linked = assertStage(scope, stage, prepared, bytes, 2)
        assertNamed(scope, name, linked)
        if (!(removed = removeStage(scope, parent, stage))) unconfirmed()
        fsyncSync(stage.fd)
        fsyncSync(parent)
        const installed = stat(stage.fd)
        if (!ownFile(installed, bytes.length, 1) || !sameContents(prepared, installed)) unconfirmed()
        const readback = readInstalled(scope, name, key, stage.fd, installed, true)
        if (!readback.equals(bytes)) unconfirmed()
        assertOpen()
        const revision = workspaceTextRevision(path, installed, readback)
        receipt = { fd: stage.fd, revision, info: installed }
        return { revision }
      } catch (error) {
        if (sealed && !(error instanceof ProjectDocumentError && error.code === 'auth')) unconfirmed()
        throw error
      } finally {
        if (stage && !removed) {
          try { removeStage(scope, parent, stage) } catch { /* leave an unverified stage untouched */ }
        }
        if (stage?.fd !== receipt?.fd) closeQuietly(stage?.fd)
        closeQuietly(parent)
      }
    })
  }
  function verifyReceipt(revision) {
    return run(() => {
      if (!receipt) { if (sealed) unconfirmed(); changed() }
      if (revision !== receipt.revision) changed()
      try {
        const { fd, info } = receipt
        if (!sameSnapshot(info, stat(fd))) changed()
        const bytes = readInstalled(scope, name, key, fd, info, false)
        if (workspaceTextRevision(path, info, bytes) !== revision) changed()
        assertOpen()
        return true
      } catch (error) {
        if (error?.code === 'ERR_WORKSPACE_UNAVAILABLE') throw error
        return changed()
      }
    })
  }
  return Object.freeze({ path, verifyAbsent, publish, verifyReceipt, close() {
    if (closed) return
    closed = true
    if (!busy) release()
  } })
}
