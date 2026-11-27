import { constants, openSync, opendirSync, readSync } from 'node:fs'
import { resolve } from 'node:path'
import { DIRECTORY, PATH, close, decodeUtf8, fdPath, mountId, openAbsoluteDirectory, sameInode, stat } from '../files/workspace-files-fd.mjs'
import { HttpError } from '../http/policy.mjs'
import { parseNativeJSON } from './delivery-records-storage.mjs'

export const readUnavailable = () => new HttpError(409, 'read_unavailable')
export const readLimit = () => new HttpError(413, 'read_state_limit')
export const MAX_NATIVE_BYTES = 128 * 1024 * 1024
const uid = BigInt(process.geteuid())
const mode = info => info.mode & 0o7777n
const readFlags = constants.O_RDONLY | constants.O_NONBLOCK
const isMissing = error => error?.code === 'ENOENT'

function directoryInfo(fd) {
  const info = stat(fd)
  if (!info.isDirectory() || info.uid !== uid || (mode(info) & 0o7022n) !== 0n) throw readUnavailable()
  return { info, mount: mountId(fd) }
}

function fileStamp(fd, directory) {
  const info = stat(fd)
  if (!info.isFile() || info.uid !== uid || info.nlink !== 1n || info.size < 1n ||
      info.size > MAX_NATIVE_BYTES || (mode(info) & 0o7133n) !== 0n || (mode(info) & 0o400n) === 0n ||
      mountId(fd) !== directory.mount) throw readUnavailable()
  return [info.dev, info.ino, info.mode, info.uid, info.gid, info.size, info.nlink, info.mtimeNs, info.ctimeNs].join(':')
}

/** Pin the three native storage directories, and reject a renamed/remounted chain before returning.
 * Read only the exact named main file, never a legacy sidecar, media, or tool-result path. */
export function withConversationFiles(dataDir, use) {
  const root = resolve(dataDir)
  const dirs = []
  try {
    function openDirectory(parent, name) {
      return parent ? openSync(fdPath(parent.fd, name), DIRECTORY) : openAbsoluteDirectory(root)
    }
    for (const name of [null, 'data', 'chats']) {
      const parent = dirs.at(-1)
      let fd
      try { fd = openDirectory(parent, name) }
      catch (error) { if (isMissing(error)) break; throw error }
      const entry = { fd, name }
      dirs.push(entry)
      Object.assign(entry, directoryInfo(fd))
      if (parent && entry.mount !== parent.mount) throw readUnavailable()
    }

    function verifyDirs() {
      for (const [index, entry] of dirs.entries()) {
        const current = openDirectory(dirs[index - 1], entry.name)
        try {
          const { info, mount } = directoryInfo(current)
          if (!sameInode(info, entry.info) || mount !== entry.mount) throw readUnavailable()
        } finally { close(current) }
      }
    }

    const directory = dirs[2]
    const scope = directory && dirs.map(({ info, mount }) => `${info.dev}:${info.ino}:${mount}`).join('/')
    function read(sid, useFile) {
      const name = `${sid}.json` // Callers validate sid before deriving this single component.
      function pin() {
        try { return openSync(fdPath(directory.fd, name), PATH) }
        catch (error) { if (isMissing(error)) return undefined; throw error }
      }
      const fd = pin()
      if (fd === undefined) return null
      try {
        const stamp = fileStamp(fd, directory)
        const info = stat(fd)
        const result = useFile({
          stamp: `${scope}/${stamp}`, size: Number(info.size), privateMode: mode(info) === 0o600n || mode(info) === 0o400n,
          parse() {
            const input = openSync(fdPath(fd), readFlags)
            try {
              if (fileStamp(input, directory) !== stamp) throw readUnavailable()
              const bytes = Buffer.allocUnsafe(Number(info.size))
              for (let offset = 0; offset < bytes.length;) {
                const count = readSync(input, bytes, offset, bytes.length - offset, offset)
                if (!count) throw readUnavailable()
                offset += count
              }
              if (fileStamp(input, directory) !== stamp) throw readUnavailable()
              try { return parseNativeJSON(decodeUtf8(bytes)) } catch { throw readUnavailable() }
            } finally { close(input) }
          }
        })
        const named = pin()
        try {
          if (named === undefined || fileStamp(named, directory) !== stamp || fileStamp(fd, directory) !== stamp) throw readUnavailable()
        } finally { close(named) }
        return result
      } finally { close(fd) }
    }

    function *scan(limit) {
      const stream = opendirSync(fdPath(directory.fd), { bufferSize: 64 })
      try {
        for (let i = 0; ; i++) {
          const entry = stream.readSync()
          if (!entry) break
          if (i === limit) throw readLimit()
          if (entry.isFile() && entry.name.endsWith('.json')) yield entry.name.slice(0, -5)
        }
      } finally { stream.closeSync() }
    }

    verifyDirs()
    const result = use(directory ? { read, scan } : null)
    verifyDirs()
    return result
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw readUnavailable()
  } finally {
    for (const { fd } of dirs.reverse()) close(fd)
  }
}
