import { createHash, randomBytes } from 'node:crypto'
import { constants as C, fchmodSync, fsyncSync, linkSync, mkdirSync, openSync, readSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DIRECTORY, PATH, close, fdPath, mountId, sameInode, stat } from '../files/workspace-files-fd.mjs'

export const mediaHash = value => typeof value === 'string' && value.length === 64 && /^[0-9a-f]+$/.test(value)
export const digestBytes = bytes => createHash('sha256').update(bytes).digest('hex')

export function desktopBlob(part, name, bytes) {
  // Match the desktop binary key convention; text uses a separate hash domain.
  const blob = part.type === 'text'
    ? createHash('sha256').update('deva text attachment\0').update(bytes).digest('hex')
    : digestBytes(part.data)
  return blobPart({ kind: part.type, name, mime: part.mediaType, blob })
}

export function blobPart({ kind, name, mime, blob }) {
  return kind === 'text' ? { type: 'text', name, blob } : { type: kind, mediaType: mime, name, blob }
}

const invalid = () => new Error('Unconfirmed attachment blob')
const missing = error => error?.code === 'ENOENT'
const MAX_BYTES = 20 * 1024 * 1024
const CHUNK_BYTES = 64 * 1024
const CREATE = C.O_RDWR | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW
const SYNC_DIR = C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW
const LINK_WAIT_MS = 200
const linkWait = new Int32Array(new SharedArrayBuffer(4))
const AVAILABILITY_TTL_MS = 30_000
const AVAILABILITY_CACHE_SIZE = 256

function checkedEntry(entry) {
  const { blob, sha256, size } = entry
  if (!mediaHash(blob) || !mediaHash(sha256) || !Number.isSafeInteger(size) || size < 1 || size > MAX_BYTES) throw invalid()
  return { blob, sha256, size }
}

function checkDirectory(info, owned, uid) {
  // Only a root-owned sticky ancestor such as /tmp may be writable by another UID:
  // sticky semantics and the checks on its child protect the next path component.
  const stickyAncestor = !owned && info.uid === 0n && (info.mode & 0o1000n) !== 0n
  if (!info.isDirectory() || (info.uid !== uid && (owned || info.uid !== 0n)) ||
      (!stickyAncestor && (info.mode & 0o022n) !== 0n)) throw invalid()
}

function verifyDirectories({ chain, uid }) {
  for (const { fd, path, mount, owned } of chain) {
    const probe = openSync(path, DIRECTORY)
    try {
      const current = stat(probe)
      checkDirectory(current, owned, uid)
      if (!sameInode(current, stat(fd)) || mountId(probe) !== mount) throw invalid()
    } finally { close(probe) }
  }
}

function withDirectories(home, create, fn) {
  if (process.platform !== 'linux' || !home.length) throw invalid()
  const scope = { chain: [], uid: BigInt(process.geteuid()) }
  const { chain, uid } = scope
  const names = ['', ...home, 'data', 'media']
  try {
    for (const [depth, name] of names.entries()) {
      const parent = chain.at(-1)
      const path = parent ? fdPath(parent.fd, name) : '/'
      let fd
      try { fd = openSync(path, DIRECTORY) } catch (error) {
        if (!create || depth <= home.length || !missing(error)) throw error
        verifyDirectories(scope)
        try { mkdirSync(path, { mode: 0o700 }) } catch (err) { if (err?.code !== 'EEXIST') throw err }
        fd = openSync(path, DIRECTORY)
      }
      const anchor = { fd, path, owned: depth >= home.length }
      chain.push(anchor)
      checkDirectory(stat(fd), anchor.owned, uid)
      anchor.mount = mountId(fd)
      if (depth > home.length && anchor.mount !== parent.mount) throw invalid()
    }
    scope.media = chain.at(-1)
    verifyDirectories(scope)
    return fn(scope)
  } finally {
    for (const { fd } of chain.reverse()) close(fd)
  }
}

function syncDirectories(scope) {
  verifyDirectories(scope)
  // Sync the published name, the media directory entry, and the data directory entry.
  for (const { fd, mount } of scope.chain.slice(-3).reverse()) {
    const sync = openSync(fdPath(fd, '.'), SYNC_DIR)
    try {
      if (!sameInode(stat(sync), stat(fd)) || mountId(sync) !== mount) throw invalid()
      fsyncSync(sync)
    } finally { close(sync) }
  }
  verifyDirectories(scope)
}

function validFile(info, scope, entry) {
  // Desktop has historically written ordinary 0644 files. Deny writes by other UIDs
  // and special/executable files, but preserve readable legacy modes and their raw format.
  return info.isFile() && info.uid === scope.uid && (info.mode & 0o7133n) === 0n &&
    (info.mode & 0o400n) !== 0n && info.size === BigInt(entry.size)
}

function sameContents(a, b) {
  return sameInode(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.uid === b.uid && a.mode === b.mode
}

function sameVersion(a, b) {
  return sameContents(a, b) && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink
}

function verifyName(scope, name, fd, before) {
  const probe = openSync(fdPath(scope.media.fd, name), PATH)
  try {
    if (!sameVersion(before, stat(probe)) || !sameVersion(before, stat(fd)) || mountId(probe) !== scope.media.mount) throw invalid()
  } finally { close(probe) }
}

function verifyDigest(fd, entry, buffer, retain) {
  const hash = createHash('sha256')
  for (let offset = 0; offset < entry.size;) {
    const start = retain ? offset : 0
    const count = readSync(fd, buffer, start, Math.min(entry.size - offset, buffer.length - start), offset)
    if (count === 0) throw invalid()
    hash.update(buffer.subarray(start, start + count))
    offset += count
  }
  if (hash.digest('hex') !== entry.sha256) throw invalid()
}

// Availability is advisory: cache only a recent digest proof for the exact stat
// revision. Reads, publication, and collision checks always recompute the digest.
function recentProof(cache, entry, scope, info) {
  const proof = cache.get(entry.blob)
  cache.delete(entry.blob)
  if (!proof || proof.expires <= performance.now() || proof.sha256 !== entry.sha256 ||
      proof.mount !== scope.media.mount || !sameVersion(proof.info, info)) return false
  cache.set(entry.blob, proof)
  return true
}

function rememberProof(cache, entry, scope, info) {
  if (cache.size >= AVAILABILITY_CACHE_SIZE) cache.delete(cache.keys().next().value)
  cache.set(entry.blob, { info, sha256: entry.sha256, mount: scope.media.mount, expires: performance.now() + AVAILABILITY_TTL_MS })
}

function inspectBlob(scope, entry, { retain = false, scratch, confirm = false, writing = false, cache } = {}) {
  const path = fdPath(scope.media.fd, entry.blob)
  let deadline
  for (;;) {
    let pin
    try { pin = openSync(path, PATH) } catch (err) {
      if (writing && missing(err)) return null
      throw err
    }
    try {
      const info = stat(pin)
      if (!validFile(info, scope, entry) || mountId(pin) !== scope.media.mount) throw invalid()
      if (info.nlink === 1n) {
        if (cache && recentProof(cache, entry, scope, info)) {
          verifyName(scope, entry.blob, pin, info)
          return true
        }
        // Follow only our own O_PATH descriptor, never an untrusted name/device/FIFO.
        const fd = openSync(fdPath(pin), C.O_RDONLY | C.O_NONBLOCK)
        try {
          if (!sameVersion(info, stat(fd)) || mountId(fd) !== scope.media.mount) throw invalid()
          const buffer = retain ? Buffer.allocUnsafe(entry.size) : (scratch ?? Buffer.allocUnsafe(CHUNK_BYTES))
          verifyDigest(fd, entry, buffer, retain)
          if (confirm || writing) fsyncSync(fd)
          if (writing) syncDirectories(scope)
          verifyName(scope, entry.blob, fd, info)
          if (cache) rememberProof(cache, entry, scope, info)
          return retain ? buffer : true
        } finally { close(fd) }
      }
      // A concurrent no-clobber publication temporarily has both its staging and final
      // names. Only a writer waits for this to clear; all successful checks require nlink=1.
      if (!writing || info.nlink !== 2n) throw invalid()
    } finally { close(pin) }
    deadline ??= performance.now() + LINK_WAIT_MS
    const remaining = deadline - performance.now()
    if (remaining <= 0) throw invalid()
    Atomics.wait(linkWait, 0, 0, Math.min(remaining, 5))
  }
}

function discardStage(scope, name, fd) {
  const path = fdPath(scope.media.fd, name)
  let probe
  try {
    try { probe = openSync(path, PATH) } catch (err) { if (missing(err)) return false; throw err }
    if (!sameInode(stat(fd), stat(probe)) || mountId(probe) !== scope.media.mount) return false
    // Node has no inode-conditional unlink. Only the service UID may mutate this directory;
    // holding both descriptors and checking immediately avoids deleting an observed replacement.
    unlinkSync(path)
    return true
  } finally { close(probe) }
}

function publish(scope, entry, bytes) {
  const stage = `.${entry.blob}.${randomBytes(16).toString('hex')}.tmp`
  const source = fdPath(scope.media.fd, stage)
  const target = fdPath(scope.media.fd, entry.blob)
  const fd = openSync(source, CREATE, 0o600)
  try {
    let staged, published, removed
    try {
      fchmodSync(fd, 0o600)
      writeFileSync(fd, bytes)
      fsyncSync(fd)
      staged = stat(fd)
      if (!validFile(staged, scope, entry) || staged.nlink !== 1n || mountId(fd) !== scope.media.mount) throw invalid()
      verifyDigest(fd, entry, Buffer.allocUnsafe(CHUNK_BYTES), false)
      verifyDirectories(scope)
      verifyName(scope, stage, fd, staged)
      // Node link is no-clobber but is still name-based, not linkat from the creating FD.
      try { linkSync(source, target); published = true } catch (err) { if (err?.code !== 'EEXIST') throw err }
      if (published) {
        const linked = stat(fd)
        if (!sameContents(staged, linked) || linked.nlink !== 2n) throw invalid()
        verifyName(scope, entry.blob, fd, linked)
      }
    } finally { removed = discardStage(scope, stage, fd) }
    if (!removed) throw invalid()
    if (!published) {
      if (!inspectBlob(scope, entry, { writing: true })) throw invalid()
      return
    }
    const installed = stat(fd)
    if (!sameContents(staged, installed) || installed.nlink !== 1n) throw invalid()
    fsyncSync(fd)
    syncDirectories(scope)
    verifyName(scope, entry.blob, fd, installed)
  } finally { close(fd) }
}

// Each operation holds a verified chain of Linux directory descriptors. No descriptor
// survives a call; the service owns the live data directory and its immutability contract.
export function createTurnMedia(dataDir) {
  const home = resolve(dataDir).split('/').filter(Boolean)
  const availableProofs = new Map()

  function available(entries) {
    if (!entries.length) return true
    try {
      return withDirectories(home, false, scope => {
        const scratch = Buffer.allocUnsafe(CHUNK_BYTES)
        const ok = entries.every(entry => inspectBlob(scope, checkedEntry(entry), { scratch, cache: availableProofs }))
        verifyDirectories(scope)
        return ok
      })
    } catch { return false }
  }

  function read(entry, confirm = false) {
    entry = checkedEntry(entry)
    return withDirectories(home, false, scope => {
      const bytes = inspectBlob(scope, entry, { retain: true, confirm })
      verifyDirectories(scope)
      return bytes
    })
  }

  function write(entry, bytes) {
    entry = checkedEntry(entry)
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== entry.size) throw invalid()
    bytes = Buffer.copyBytesFrom(bytes)
    if (digestBytes(bytes) !== entry.sha256) throw invalid()
    withDirectories(home, true, scope => {
      if (!inspectBlob(scope, entry, { writing: true })) publish(scope, entry, bytes)
      verifyDirectories(scope)
    })
  }

  return { available, read, write }
}
