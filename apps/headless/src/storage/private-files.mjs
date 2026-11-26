import { randomBytes } from 'node:crypto'
import { constants, promises as fs } from 'node:fs'
import { sep } from 'node:path'

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW

function unsafe() {
  return Object.assign(new Error('Unsafe vault storage path or permissions'), { code: 'ERR_VAULT_UNSAFE' })
}

function assertOwnedDirectory(info) {
  if (info.uid !== BigInt(process.geteuid()) || (info.mode & 0o022n) !== 0n) throw unsafe()
}

// Linux: resolve child paths through an open directory rather than looking up its ancestors again.
export function childPath(directory, name) {
  return `/proc/self/fd/${directory.fd}/${name}`
}

export async function openDirectory(path, { create = false, owned = false } = {}) {
  let directory = await fs.open(sep, DIRECTORY_FLAGS)
  try {
    for (const name of path.split(sep).filter(Boolean)) {
      const child = childPath(directory, name)
      let next
      try {
        next = await fs.open(child, DIRECTORY_FLAGS)
      } catch (error) {
        if (!create || error.code !== 'ENOENT') throw error
        try {
          await fs.mkdir(child, { mode: 0o700 })
          await directory.sync()
        } catch (error) {
          if (error.code !== 'EEXIST') throw error
        }
        next = await fs.open(child, DIRECTORY_FLAGS)
      }
      const previous = directory
      directory = next
      await previous.close()
    }
    const info = await directory.stat({ bigint: true })
    if (owned) assertOwnedDirectory(info)
    return { directory, identity: `${info.dev}:${info.ino}` }
  } catch (error) {
    await directory.close().catch(() => {})
    throw error
  }
}

function assertPrivateFile(info, singleLink) {
  if (!info.isFile() || info.uid !== BigInt(process.geteuid()) || (info.mode & 0o7177n) !== 0n ||
      (singleLink && info.nlink !== 1n)) {
    throw unsafe()
  }
}

export async function readPrivateFile(path, { minSize, maxSize, singleLink = false, absent = false }) {
  let handle
  try {
    handle = await fs.open(path, READ_FLAGS)
  } catch (error) {
    if (absent && error.code === 'ENOENT') return null
    throw error
  }
  try {
    const info = await handle.stat({ bigint: true })
    assertPrivateFile(info, singleLink)
    if (info.size < BigInt(minSize) || info.size > BigInt(maxSize)) {
      throw Object.assign(new Error('Invalid vault storage file size'), { code: 'ERR_VAULT_SIZE' })
    }
    // Read only the checked size plus one byte and reject a changing file instead of reading unbounded data.
    const size = Number(info.size)
    const buffer = Buffer.alloc(size + 1)
    try {
      let offset = 0
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
        if (bytesRead === 0) break
        offset += bytesRead
      }
      if (offset !== size || !sameSnapshot(info, await handle.stat({ bigint: true }))) throw changed()
      return { bytes: buffer.subarray(0, size), info }
    } catch (error) {
      buffer.fill(0)
      throw error
    }
  } finally {
    await handle.close()
  }
}

function changed() {
  return Object.assign(new Error('Vault storage changed during the operation'), { code: 'ERR_VAULT_CHANGED' })
}

function sameInode(a, b) {
  return a.dev === b.dev && a.ino === b.ino
}

function sameSnapshot(a, b) {
  return sameInode(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
}

async function unlinkOwned(path, info) {
  if (!info) return
  try {
    if (sameInode(info, await fs.lstat(path, { bigint: true }))) await fs.unlink(path)
  } catch {
    // The original error or successful publication takes precedence over cleanup of our private file.
  }
}

async function writeExclusive(path, bytes) {
  const handle = await fs.open(path, CREATE_FLAGS, 0o600)
  let info
  try {
    info = await handle.stat({ bigint: true })
    await handle.chmod(0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    return info
  } catch (error) {
    await handle.close().catch(() => {})
    await unlinkOwned(path, info)
    throw error
  }
}

export async function createPrivateFile(directory, name, bytes) {
  await directory.sync()
  await writeExclusive(childPath(directory, name), bytes)
  // Once the file is complete, a directory sync error cannot undo publication.
  await directory.sync().catch(() => {})
}

export async function publishPrivateFile(directory, name, bytes, previous) {
  const target = childPath(directory, name)
  const temporary = childPath(directory, `.${name}.${randomBytes(16).toString('hex')}.tmp`)
  const info = await writeExclusive(temporary, bytes)
  try {
    await directory.sync()
    assertOwnedDirectory(await directory.stat({ bigint: true }))
    if (previous) {
      const current = await fs.lstat(target, { bigint: true })
      assertPrivateFile(current, false)
      if (!sameSnapshot(previous, current)) throw changed()
      await fs.rename(temporary, target)
    } else {
      // An exclusive first install: even a target created after the initial lookup stays intact.
      await fs.link(temporary, target)
    }
  } finally {
    await unlinkOwned(temporary, info)
  }
  // Publication is the commit point. A later directory sync error affects crash durability,
  // not the visible contents, and must not be reported as a failed (uncommitted) mutation.
  await directory.sync().catch(() => {})
}
