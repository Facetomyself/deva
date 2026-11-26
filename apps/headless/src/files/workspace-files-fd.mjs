import { closeSync, constants as C, fstatSync, openSync, readFileSync } from 'node:fs'
import { TextDecoder } from 'node:util'

// Linux O_PATH: pin and inspect an inode without invoking a device/FIFO open handler.
export const PATH = 0o10000000 | C.O_NOFOLLOW
export const DIRECTORY = PATH | C.O_DIRECTORY
export const fdPath = (fd, name) => `/proc/self/fd/${fd}${name === undefined ? '' : `/${name}`}`
export const stat = fd => fstatSync(fd, { bigint: true })
// Compare the device/inode of *held* descriptors (mount ID is checked separately).
// A live fd prevents this inode from being recycled. Older Linux stat APIs may return a
// synthesized birthtime derived from ctime: creating a temp in an unchanged directory can
// legitimately change that value. Use ctime/mtime/size/digest for file revisions, not identity.
export const sameInode = (a, b) => a.dev === b.dev && a.ino === b.ino
export const close = fd => { if (fd !== undefined) closeSync(fd) }

export function mountId(fd) {
  const id = /^mnt_id:\s+(\d+)$/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'))?.[1]
  if (id === undefined) throw Error('Missing mount identity')
  return id
}

export function openAbsoluteDirectory(path) {
  let fd = openSync('/', DIRECTORY)
  try {
    for (const name of path.split('/').slice(1)) {
      const next = openSync(fdPath(fd, name), DIRECTORY)
      close(fd)
      fd = next
    }
    const result = fd
    fd = undefined
    return result
  } finally { close(fd) }
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
export const decodeUtf8 = bytes => utf8.decode(bytes)
export function validWorkspaceName(name) {
  return typeof name === 'string' && name.length > 0 && name.isWellFormed() && !name.startsWith('.') &&
    !/^[a-z]:/i.test(name) && !/[\u0000-\u001f\u007f-\u009f/\\]/.test(name) && Buffer.byteLength(name) <= 255
}
export function visibleName(bytes) {
  try {
    const name = decodeUtf8(bytes)
    return validWorkspaceName(name) ? name : undefined
  } catch { return undefined }
}
