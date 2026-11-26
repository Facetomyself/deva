import { randomBytes } from 'node:crypto'
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync,
  unlinkSync, writeFileSync, type BigIntStats
} from 'node:fs'
import { basename, dirname, isAbsolute, relative, sep } from 'node:path'

export type MemoryServiceErrorCode =
  | 'invalidScope' | 'workspaceUnavailable' | 'unsafeStorage' | 'corruptStorage' | 'storageIO' | 'invalidInput'

const messages: Record<MemoryServiceErrorCode, string> = {
  invalidScope: 'Invalid memory scope',
  workspaceUnavailable: 'Memory workspace is unavailable',
  unsafeStorage: 'Unsafe memory storage path',
  corruptStorage: 'Invalid memory storage contents',
  storageIO: 'Memory storage operation failed',
  invalidInput: 'Invalid memory input'
}

export class MemoryServiceError extends Error {
  constructor(public readonly code: MemoryServiceErrorCode, cause?: unknown) {
    super(messages[code], { cause })
    this.name = 'MemoryServiceError'
  }
}

const errno = (error: unknown) => (error as NodeJS.ErrnoException)?.code
const missing = (error: unknown) => errno(error) === 'ENOENT'
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
// Generous headroom for v1/v2 and old over-quota entries; do not allocate arbitrarily large files.
const MAX_BYTES = 8 * 1024 * 1024

const child = (fd: number, name: string) => `/proc/self/fd/${fd}/${name}`
const randomSuffix = () => randomBytes(12).toString('hex')
const sameInode = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino
const sameSnapshot = (a: BigIntStats, b: BigIntStats) =>
  sameInode(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs

function io<T>(use: () => T): T {
  try {
    return use()
  } catch (error) {
    if (error instanceof MemoryServiceError) throw error
    if (errno(error) === 'ENOTDIR' || errno(error) === 'ELOOP') throw new MemoryServiceError('unsafeStorage', error)
    throw new MemoryServiceError('storageIO', error)
  }
}

function openChildDirectory(fd: number, name: string, create: boolean, parentManaged: boolean): number | null {
  const path = child(fd, name)
  try {
    return openSync(path, DIRECTORY_FLAGS)
  } catch (error) {
    if (!missing(error)) throw error
    if (!create) return null
    if (parentManaged && (assertManagedDirectory(fd).mode & 0o200n) === 0n) throw new MemoryServiceError('storageIO')
    try {
      mkdirSync(path, { mode: 0o700 })
    } catch (mkdirError) {
      if (errno(mkdirError) !== 'EEXIST') throw mkdirError
    }
    return openSync(path, DIRECTORY_FLAGS)
  }
}

function assertManagedDirectory(fd: number): BigIntStats {
  const stat = fstatSync(fd, { bigint: true })
  if (!stat.isDirectory() || stat.uid !== BigInt(process.geteuid!()) || (stat.mode & 0o022n) !== 0n)
    throw new MemoryServiceError('unsafeStorage')
  if ((stat.mode & 0o500n) !== 0o500n) throw new MemoryServiceError('storageIO')
  return stat
}

function assertRegular(stat: BigIntStats): void {
  if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(process.geteuid!()) || (stat.mode & 0o022n) !== 0n)
    throw new MemoryServiceError('unsafeStorage')
}

function namedFile(path: string): BigIntStats | null {
  let stat: BigIntStats
  try {
    stat = lstatSync(path, { bigint: true })
  } catch (error) {
    if (missing(error)) return null
    throw error
  }
  assertRegular(stat)
  return stat
}

export interface MemoryStorageRead {
  bytes: Buffer
  stat: BigIntStats
  parent: BigIntStats
}

function readRegular(fd: number, name: string): MemoryStorageRead | null {
  const path = child(fd, name)
  const named = namedFile(path)
  if (!named) return null
  if ((named.mode & 0o400n) === 0n) throw new MemoryServiceError('storageIO')
  const file = openSync(path, READ_FLAGS)
  try {
    const stat = fstatSync(file, { bigint: true })
    assertRegular(stat)
    if (!sameSnapshot(named, stat)) throw new MemoryServiceError('storageIO')
    if (stat.size > BigInt(MAX_BYTES)) throw new MemoryServiceError('corruptStorage')
    const bytes = Buffer.alloc(Number(stat.size) + 1)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(file, bytes, offset, bytes.length - offset, offset)
      if (!count) break
      offset += count
    }
    if (offset !== bytes.length - 1 || !sameSnapshot(stat, fstatSync(file, { bigint: true }))) {
      throw new MemoryServiceError('storageIO')
    }
    return { bytes: bytes.subarray(0, offset), stat, parent: assertManagedDirectory(fd) }
  } finally {
    closeSync(file)
  }
}

function writeExclusive(path: string, bytes: string | Buffer): void {
  const fd = openSync(path, WRITE_FLAGS, 0o600)
  try {
    try {
      writeFileSync(fd, bytes)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    try { unlinkSync(path) } catch { /* preserve the original failure */ }
    throw error
  }
}

function assertUnchanged(fd: number, path: string, previous: MemoryStorageRead | null): void {
  const named = namedFile(path)
  const current = assertManagedDirectory(fd)
  if (previous ? !named || !sameSnapshot(previous.stat, named) || !sameInode(previous.parent, current) : named) {
    throw new MemoryServiceError('storageIO')
  }
  // Atomic replacement uses directory permissions. Preserve an independently read-only file.
  if ((current.mode & 0o200n) === 0n || (named && (named.mode & 0o200n) === 0n)) {
    throw new MemoryServiceError('storageIO')
  }
}

function saveLegacyBackup(fd: number, raw: Buffer): void {
  const backup = openChildDirectory(fd, 'memory-backups', true, true)!
  try {
    if ((assertManagedDirectory(backup).mode & 0o200n) === 0n) throw new MemoryServiceError('storageIO')
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    writeExclusive(child(backup, `memory-v1-${timestamp}-${randomSuffix()}.json`), raw)
    fsyncSync(backup)
    fsyncSync(fd)
  } finally {
    closeSync(backup)
  }
}

/** Linux headless storage; the desktop compatibility adapter uses the original portable I/O. */
export function createStrictMemoryStorage(home: string) {
  // Hold each parent open while opening its child. O_NOFOLLOW on the final name alone would
  // still follow a symlink replacing personas/, projects/, the profile, or an ancestor.
  function withDirectory<T>(path: string, create: boolean, use: (fd: number) => T): T | null {
    if (process.platform !== 'linux') throw new MemoryServiceError('unsafeStorage')
    const outside = relative(home, path)
    if (isAbsolute(outside) || outside === '..' || outside.startsWith(`..${sep}`)) throw new MemoryServiceError('unsafeStorage')
    const managedDepth = home.split(sep).filter(Boolean).length
    const names = path.split(sep).filter(Boolean)
    let fd = openSync(sep, DIRECTORY_FLAGS)
    try {
      for (const [index, name] of names.entries()) {
        const next = openChildDirectory(fd, name, create, index >= managedDepth)
        if (next === null) return null
        closeSync(fd)
        fd = next
        if (index + 1 >= managedDepth) assertManagedDirectory(fd)
      }
      return use(fd)
    } finally {
      closeSync(fd)
    }
  }

  return {
    read(path: string): MemoryStorageRead | null {
      return io(() => withDirectory(dirname(path), false, (fd) => readRegular(fd, basename(path))))
    },
    write(path: string, bytes: string, previous: MemoryStorageRead | null, legacy: boolean): void {
      if (Buffer.byteLength(bytes) > MAX_BYTES) throw new MemoryServiceError('storageIO')
      io(() => withDirectory(dirname(path), true, (fd) => {
        const name = basename(path)
        const target = child(fd, name)
        assertUnchanged(fd, target, previous)
        // Backup must be complete before publishing v2, including for an intentional clear.
        if (legacy && previous) saveLegacyBackup(fd, previous.bytes)
        const temp = child(fd, `.${name}.${randomSuffix()}.tmp`)
        writeExclusive(temp, bytes)
        try {
          assertUnchanged(fd, target, previous)
          // The profile's single-writer lease covers this check + atomic publication; rename
          // cannot dereference a destination symlink or leave a committed hard-link pair after a crash.
          renameSync(temp, target)
        } finally {
          try { unlinkSync(temp) } catch { /* publication or its error takes precedence */ }
        }
        try { fsyncSync(fd) } catch { /* already committed; a sync error cannot undo it */ }
      }))
    }
  }
}
