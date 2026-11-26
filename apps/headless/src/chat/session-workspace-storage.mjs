import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { HttpError } from '../http/policy.mjs'
import { parseNativeJSON } from './delivery-records-storage.mjs'

export const workspaceStorageError = () => new HttpError(503, 'chat_storage_unconfirmed')
const mainPath = (dataDir, sid) => join(dataDir, 'data', 'chats', `${sid}.json`)
const maxFile = 128n * 1024n * 1024n
const statOptions = { bigint: true }
const signature = stat => [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.uid, stat.gid, stat.mtimeNs, stat.ctimeNs].join(':')
const fileMode = stat => stat.mode & 0o7777n
const regular = stat => stat.isFile() && stat.nlink === 1n && stat.size > 0n && stat.size <= maxFile &&
  stat.uid === BigInt(process.geteuid()) && (fileMode(stat) & 0o7022n) === 0n
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function statMain(path) {
  try {
    const stat = lstatSync(path, statOptions)
    if (!regular(stat)) throw workspaceStorageError()
    return stat
  } catch (err) {
    if (err?.code === 'ENOENT') return null
    throw workspaceStorageError()
  }
}

export function workspaceFileStamp(dataDir, sid) {
  const stat = statMain(mainPath(dataDir, sid))
  return stat ? signature(stat) : null
}

function validSession(value, sid) {
  return value && value.id === sid && typeof value.title === 'string' && Number.isFinite(value.createdAt) &&
    Number.isFinite(value.updatedAt) && Array.isArray(value.messages) && value.messages.every(message =>
      message && ['user', 'assistant'].includes(message.role) && (typeof message.content === 'string' ||
        (Array.isArray(message.content) && message.content.every(part => part && typeof part.type === 'string'))))
}

/** Independently confirm the native session without the store's cache or sidecar cleanup. */
export function readWorkspaceNative(dataDir, sid) {
  const path = mainPath(dataDir, sid)
  const named = statMain(path)
  if (!named) return null
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const opened = fstatSync(fd, statOptions)
      const stamp = signature(opened)
      if (!regular(opened) || signature(named) !== stamp) throw workspaceStorageError()
      const bytes = Buffer.allocUnsafe(Number(opened.size))
      for (let offset = 0; offset < bytes.length;) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
        if (!count) throw workspaceStorageError()
        offset += count
      }
      if (signature(fstatSync(fd, statOptions)) !== stamp || signature(lstatSync(path, statOptions)) !== stamp) throw workspaceStorageError()
      const value = parseNativeJSON(decoder.decode(bytes))
      if (!validSession(value, sid)) throw workspaceStorageError()
      const mode = fileMode(opened)
      return { value, stamp, writable: mode === 0o600n, privateMode: mode === 0o600n || mode === 0o400n }
    } finally { closeSync(fd) }
  } catch { throw workspaceStorageError() }
}

export const matchesWorkspaceNative = (native, s) => isDeepStrictEqual(native.value,
  Object.fromEntries(Object.entries(s).filter(([, value]) => value !== undefined)))

export function confirmWorkspaceNative(dataDir, s) {
  const native = readWorkspaceNative(dataDir, s.id)
  if (!native?.writable || !matchesWorkspaceNative(native, s)) throw workspaceStorageError()
  return native.stamp
}
