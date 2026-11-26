import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { normalizeUploadName, normalizeUploadType, UploadStoreError, validUploadId, validUploadSession } from './upload-store-types.mjs'

export const draftDirectoryName = 'upload-drafts-v1'
const stats = { bigint: true }
const dirFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const createFlags = constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK
const activeDirectories = new Set()
const magic = Buffer.from('DEVADRF1')
const footerBytes = magic.length + 4 + 32
const maxMetadata = 2048
const sha256 = bytes => createHash('sha256').update(bytes).digest()
const hexDigest = /^[0-9a-f]{64}$/u

export function corrupt(message = 'Invalid upload draft on disk', cause) {
  return new UploadStoreError('CORRUPT', message, { cause })
}

function sameInode(a, b) { return a?.dev === b?.dev && a?.ino === b?.ino }
function sameSnapshot(a, b) {
  return sameInode(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
}
function safeDir(st, exact) {
  return st?.isDirectory() && st.uid === BigInt(process.getuid()) && (st.mode & (exact ? 0o7777n : 0o077n)) === (exact ? 0o700n : 0n)
}
function safeFile(st) {
  return st?.isFile() && st.nlink === 1n && st.uid === BigInt(process.getuid()) && (st.mode & 0o7777n) === 0o600n
}
const missingPath = error => error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'ELOOP'
async function statPath(path) {
  try { return await lstat(path, stats) } catch (error) { if (!missingPath(error)) throw error; return null }
}
async function canonicalPath(path) {
  try { return await realpath(path) } catch (error) { if (!missingPath(error)) throw error; return null }
}
function fdPath(handle) { return `/proc/self/fd/${handle.fd}` }

// The caller holds the existing dataDir writer lock. Anchor all children under already-open FDs;
// checks against the named directories detect replacement without ever entering the replacement.
export async function openDraftFiles(dataDir) {
  if (process.platform !== 'linux' || typeof dataDir !== 'string' || !isAbsolute(dataDir)) {
    throw new UploadStoreError('INVALID', 'Upload storage requires an absolute Linux data directory')
  }
  dataDir = resolve(dataDir)
  const rootStat = await statPath(dataDir)
  if (!safeDir(rootStat, false) || await canonicalPath(dataDir) !== dataDir) throw corrupt('Invalid upload data directory')
  const root = await open(dataDir, dirFlags)
  let dir
  let key
  let registered = false
  try {
    const rootAnchor = await root.stat(stats)
    if (!safeDir(rootAnchor, false) || !sameInode(rootStat, rootAnchor)) throw corrupt('Upload data directory was replaced')
    const dirPath = join(fdPath(root), draftDirectoryName)
    let dirCreated = false
    try { await mkdir(dirPath, { mode: 0o700 }); dirCreated = true } catch (error) { if (error.code !== 'EEXIST') throw error }
    const dirStat = await statPath(dirPath)
    if (!safeDir(dirStat, true) || dirStat.dev !== rootAnchor.dev) throw corrupt('Invalid private draft directory')
    dir = await open(dirPath, dirFlags)
    const dirAnchor = await dir.stat(stats)
    if (!safeDir(dirAnchor, true) || !sameInode(dirStat, dirAnchor)) throw corrupt('Private draft directory was replaced')
    key = `${rootAnchor.dev}:${rootAnchor.ino}`
    if (activeDirectories.has(key)) throw new UploadStoreError('IN_USE', 'An upload store already owns this data directory')
    activeDirectories.add(key)
    registered = true
    const anchor = fdPath(dir)
    const path = name => join(anchor, name)

    async function checkDirectory() {
      const liveRoot = await statPath(dataDir)
      const liveDir = await statPath(dirPath)
      if (!safeDir(liveRoot, false) || !sameInode(liveRoot, rootAnchor) || await canonicalPath(dataDir) !== dataDir ||
          !safeDir(liveDir, true) || !sameInode(liveDir, dirAnchor)) throw corrupt('Upload directory was replaced')
    }

    async function verify(handle, name, expected, { stable = false } = {}) {
      const opened = await handle.stat(stats)
      const named = await statPath(path(name))
      if (!safeFile(opened) || !safeFile(named) || !sameSnapshot(opened, named) ||
          (expected && !(stable ? sameSnapshot(opened, expected) : sameInode(opened, expected)))) throw corrupt()
      return opened
    }

    async function openRecord(name, expected) {
      const seen = await statPath(path(name))
      if (!safeFile(seen) || (expected && !sameInode(seen, expected))) throw corrupt()
      let handle
      try {
        handle = await open(path(name), readFlags)
        return { handle, stat: await verify(handle, name, seen, { stable: true }) }
      } catch (error) {
        await handle?.close()
        if (error.code === 'ENOENT' || error.code === 'ELOOP') throw corrupt(undefined, error)
        throw error
      }
    }

    // unlink() acts on a basename, never a link target. Match the expected inode and reject links
    // before unlinking; cleanup deliberately leaves behind any unexpected or replaced entry.
    async function discard(name, expected, { missingOkay = false } = {}) {
      const seen = await statPath(path(name))
      if (!seen && missingOkay) return false
      if (!safeFile(seen) || (expected && !sameInode(seen, expected))) throw corrupt()
      await unlink(path(name))
      return true
    }

    async function create(name) {
      const handle = await open(path(name), createFlags, 0o600)
      let identity
      try {
        identity = await handle.stat(stats)
        if ((identity.mode & 0o7777n) !== 0o600n) await handle.chmod(0o600)
        return { handle, stat: await verify(handle, name, identity) }
      } catch (error) {
        try { if (identity) await discard(name, identity, { missingOkay: true }) } finally { await handle.close() }
        throw error
      }
    }

    await checkDirectory()
    if (dirCreated) await root.sync()
    return {
      checkDirectory, verify, openRecord, discard, create,
      names: () => readdir(anchor),
      stat: name => statPath(path(name)),
      rename: (source, dest) => rename(path(source), path(dest)),
      sync: () => dir.sync(),
      async close() {
        try { await dir.close() } finally { try { await root.close() } finally { activeDirectories.delete(key) } }
      },
    }
  } catch (error) {
    try { await dir?.close() } finally { try { await root.close() } finally { if (registered) activeDirectories.delete(key) } }
    throw error
  }
}

export async function writeAll(handle, bytes, position) {
  for (let offset = 0; offset < bytes.length;) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, position + offset)
    if (!bytesWritten) throw new UploadStoreError('IO', 'Upload disk write made no progress')
    offset += bytesWritten
  }
}

export async function readAll(handle, size, position = 0) {
  const bytes = Buffer.alloc(size)
  for (let offset = 0; offset < size;) {
    const { bytesRead } = await handle.read(bytes, offset, size - offset, position + offset)
    if (!bytesRead) throw corrupt('Truncated upload draft')
    offset += bytesRead
  }
  return bytes
}

export async function appendRecord(handle, record) {
  const encoded = Buffer.from(JSON.stringify(record), 'utf8')
  if (encoded.length > maxMetadata) throw new UploadStoreError('INVALID', 'Upload metadata is too large')
  const footer = Buffer.alloc(footerBytes)
  magic.copy(footer)
  footer.writeUInt32BE(encoded.length, magic.length)
  sha256(encoded).copy(footer, magic.length + 4)
  await writeAll(handle, Buffer.concat([encoded, footer]), record.size)
  return BigInt(record.size + encoded.length + footer.length)
}

export async function readRecord(handle, stat, id) {
  if (stat.size < BigInt(footerBytes + 1) || stat.size > BigInt(20 * 1024 * 1024 + maxMetadata + footerBytes)) throw corrupt()
  const end = Number(stat.size) - footerBytes
  const footer = await readAll(handle, footerBytes, end)
  if (!footer.subarray(0, magic.length).equals(magic)) throw corrupt()
  const length = footer.readUInt32BE(magic.length)
  if (!length || length > maxMetadata || length > end) throw corrupt()
  const bytes = await readAll(handle, length, end - length)
  if (!sha256(bytes).equals(footer.subarray(magic.length + 4))) throw corrupt('Upload draft metadata checksum mismatch')
  try {
    const record = JSON.parse(bytes.toString('utf8'))
    const { mime, kind, maxBytes } = normalizeUploadType(record.mime)
    if (!validUploadId(record.id) || record.id !== id || !validUploadSession(record.sid) ||
        record.mime !== mime || record.kind !== kind || normalizeUploadName(record.name, mime) !== record.name ||
        !Number.isSafeInteger(record.size) || record.size <= 0 || record.size > maxBytes || record.size !== end - length ||
        !Number.isSafeInteger(record.createdAt) || record.createdAt < 0 ||
        typeof record.sha256 !== 'string' || record.sha256.length !== 64 || !hexDigest.test(record.sha256)) throw corrupt()
    return record
  } catch (error) {
    if (error.code === 'UPLOAD_CORRUPT') throw error
    throw corrupt(undefined, error)
  }
}
