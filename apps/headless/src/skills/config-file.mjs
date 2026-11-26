import { constants, openSync, promises as fs } from 'node:fs'
import { MAX_SETTINGS_FILE_BYTES } from '../business/settings-file.mjs'
import { PATH, close, fdPath, mountId, stat } from '../files/workspace-files-fd.mjs'
import { skillError } from './errors.mjs'

const readFlags = constants.O_RDONLY | constants.O_NONBLOCK
const fields = ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'ctimeNs', 'mtimeNs']
export const sameConfig = (a, b) => a && b ? fields.every(field => a[field] === b[field]) : a === b

function openPin(root) {
  try { return openSync(fdPath(root.directory.fd, 'config.json'), PATH) }
  catch (error) { if (error.code === 'ENOENT') return; throw error }
}

function verify(root, pin) {
  const info = stat(pin)
  if (!info.isFile() || mountId(pin) !== root.mount || info.nlink !== 1n || info.uid !== root.info.uid ||
      (info.mode & 0o7133n) !== 0n || (info.mode & 0o400n) === 0n || info.size === 0n) throw skillError('skill_unsupported')
  if (info.size > BigInt(MAX_SETTINGS_FILE_BYTES)) throw skillError('skill_limit')
  return info
}

/** Metadata-only observation for the watcher and final inode checks; no config payload is opened. */
export function configurationInfo(root) {
  const pin = openPin(root)
  try { return pin === undefined ? null : verify(root, pin) }
  finally { close(pin) }
}

/** Hold the regular inode before opening it for an exact-byte read. */
export async function readSkillConfiguration(root) {
  const pin = openPin(root)
  if (pin === undefined) return { info: null, bytes: null }
  let file, bytes
  try {
    const info = verify(root, pin)
    file = await fs.open(fdPath(pin), readFlags)
    if (!sameConfig(info, stat(file.fd)) || mountId(file.fd) !== root.mount) throw skillError('skill_conflict')
    const size = Number(info.size)
    bytes = Buffer.alloc(size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset !== size || !sameConfig(info, stat(file.fd)) || !sameConfig(info, configurationInfo(root))) {
      throw skillError('skill_conflict')
    }
    return { info, bytes: bytes.subarray(0, size) }
  } catch (error) {
    bytes?.fill(0)
    throw error
  } finally {
    try { await file?.close().catch(() => {}) }
    finally { close(pin) }
  }
}
