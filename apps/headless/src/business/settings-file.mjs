import { createHash, randomBytes } from 'node:crypto'
import { constants, fstatSync, lstatSync, promises as fs } from 'node:fs'
import { TextDecoder } from 'node:util'
import { childPath, openDirectory } from '../storage/private-files.mjs'
import { SettingsError, record } from './settings-schema.mjs'

const CONFIG = 'config.json'
export const MAX_SETTINGS_FILE_BYTES = 4 * 1024 * 1024
const decoder = new TextDecoder('utf-8', { fatal: true })
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
const queues = new Map()

export async function withSettingsDirectory(path, expectedIdentity, task, { create = !expectedIdentity } = {}) {
  let handle
  try {
    const opened = await openDirectory(path, { create, owned: true })
    handle = opened.directory
    if (expectedIdentity && opened.identity !== expectedIdentity) throw new SettingsError('STORAGE')
    // One queue per directory inode for all instances inside this server. The host takes
    // its volume writer lock before opening settings; Electron itself has no shared lock.
    const identity = opened.identity
    const result = (queues.get(identity) ?? Promise.resolve()).then(() => task(handle, identity))
    const tail = result.then(() => {}, () => {})
    queues.set(identity, tail)
    try { return await result } finally { if (queues.get(identity) === tail) queues.delete(identity) }
  } catch (error) {
    throw storageError(error)
  } finally {
    await handle?.close().catch(() => {})
  }
}

function storageError(error) {
  if (error instanceof SettingsError) return error
  if (['EACCES', 'EPERM', 'EROFS'].includes(error?.code)) return new SettingsError('READ_ONLY')
  return new SettingsError('STORAGE')
}

const sameInode = (a, b) => a.dev === b.dev && a.ino === b.ino
const sameSnapshot = (a, b) => sameInode(a, b) && a.ctimeNs === b.ctimeNs && a.mtimeNs === b.mtimeNs && a.size === b.size

function verifyFile(info) {
  if (!info.isFile() || info.nlink !== 1n || info.uid !== BigInt(process.geteuid())) throw new SettingsError('CORRUPT')
}

export function revisionFor(identity, info) {
  // Hash only filesystem metadata: never hand a browser a hash of a file that may
  // contain unrelated desktop values the browser could use to check secret guesses.
  const state = info ? [info.dev, info.ino, info.size, info.ctimeNs, info.mtimeNs].join(':') : 'missing'
  return createHash('sha256').update(`${identity}:${state}`).digest('hex')
}

export async function readSettingsFile(directory) {
  let file
  try {
    file = await fs.open(childPath(directory, CONFIG), READ_FLAGS)
  } catch (error) {
    if (error.code === 'ENOENT') return { raw: {}, info: null }
    if (error.code === 'ELOOP') throw new SettingsError('CORRUPT')
    throw error
  }
  try {
    const info = await file.stat({ bigint: true })
    verifyFile(info)
    if (info.size < 1n || info.size > BigInt(MAX_SETTINGS_FILE_BYTES)) throw new SettingsError('CORRUPT')
    const bytes = Buffer.alloc(Number(info.size) + 1)
    try {
      let offset = 0
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
        if (!bytesRead) break
        offset += bytesRead
      }
      if (offset !== Number(info.size) || !sameSnapshot(info, await file.stat({ bigint: true }))) {
        throw new SettingsError('CONFLICT')
      }
      let raw
      try { raw = JSON.parse(decoder.decode(bytes.subarray(0, offset))) }
      catch { throw new SettingsError('CORRUPT') }
      return { raw: record(raw, null, true), info }
    } finally {
      bytes.fill(0)
    }
  } finally {
    await file.close().catch(() => {})
  }
}

function expectSnapshot(expected, current) {
  if (current) verifyFile(current)
  if ((!expected !== !current) || (expected && !sameSnapshot(expected, current))) throw new SettingsError('CONFLICT')
}

export async function assertSettingsCurrent(directory, expected) {
  let current = null
  try { current = await fs.lstat(childPath(directory, CONFIG), { bigint: true }) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  expectSnapshot(expected, current)
}

function requireWritable(parent, expected) {
  if ((parent.mode & 0o300n) !== 0o300n || (expected && (expected.mode & 0o200n) === 0n)) {
    throw new SettingsError('READ_ONLY')
  }
}

export async function assertWritable(directory, expected) {
  requireWritable(await directory.stat({ bigint: true }), expected)
  await assertSettingsCurrent(directory, expected)
}

export function encodeSettings(raw) {
  // Compact encoding avoids changing the size class of an already valid desktop config
  // with large unrelated sections (MCP/skills/etc.); those values are preserved verbatim.
  let bytes
  try { bytes = Buffer.from(JSON.stringify(raw) + '\n') }
  catch { throw new SettingsError('STORAGE') }
  if (bytes.length > MAX_SETTINGS_FILE_BYTES) throw new SettingsError('INVALID')
  return bytes
}

async function cleanTemp(path, info) {
  if (!info) return
  try {
    const onDisk = await fs.lstat(path, { bigint: true })
    if (sameInode(info, onDisk)) await fs.unlink(path)
  } catch { /* Cleanup cannot undo a visible commit. */ }
}

function namedFile(path) {
  try { return lstatSync(path, { bigint: true }) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

export async function publishSettingsFile(directory, bytes, expected, { beforePublish, authorize, preserveAccess } = {}) {
  const target = childPath(directory, CONFIG)
  const tmp = childPath(directory, `.config.${randomBytes(16).toString('hex')}.tmp`)
  let file, tempInfo, info
  try {
    file = await fs.open(tmp, WRITE_FLAGS, 0o600)
    tempInfo = await file.stat({ bigint: true })
    await file.chmod(0o600)
    await file.writeFile(bytes)
    if (preserveAccess && expected) {
      if (expected.gid !== tempInfo.gid) await file.chown(Number(expected.uid), Number(expected.gid))
      if ((expected.mode & 0o777n) !== 0o600n) await file.chmod(Number(expected.mode & 0o777n))
    }
    await file.sync()
    await directory.sync()
    if (beforePublish || authorize) {
      const staged = await file.stat({ bigint: true })
      await beforePublish?.()
      authorize?.() // Intentionally synchronous: no event-loop yield until submitting rename/link.
      requireWritable(fstatSync(directory.fd, { bigint: true }), expected)
      expectSnapshot(expected, namedFile(target))
      const named = namedFile(tmp)
      verifyFile(staged)
      if (!named || !sameSnapshot(staged, named) || !sameSnapshot(staged, fstatSync(file.fd, { bigint: true })) ||
          (preserveAccess && expected && (staged.mode !== expected.mode || staged.uid !== expected.uid || staged.gid !== expected.gid))) {
        throw new SettingsError('STORAGE')
      }
    } else await assertWritable(directory, expected)
    if (expected) await fs.rename(tmp, target)
    else {
      try { await fs.link(tmp, target) }
      catch (error) { if (error.code === 'EEXIST') throw new SettingsError('CONFLICT'); throw error }
    }
  } finally {
    await cleanTemp(tmp, tempInfo)
    if (file) {
      info = await file.stat({ bigint: true }).catch(() => tempInfo)
      await file.close().catch(() => {})
    }
  }
  // Publication is the visible commit point. Only reap old credential snapshots once
  // the new reference is durable; a failed final fsync must not invalidate either version.
  const durable = await directory.sync().then(() => true, () => false)
  return { info, durable }
}
