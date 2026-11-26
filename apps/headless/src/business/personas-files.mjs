import { randomBytes } from 'node:crypto'
import { constants as C, promises as fs } from 'node:fs'
import { TextDecoder } from 'node:util'
import { childPath } from '../storage/private-files.mjs'
import { SettingsError } from './settings-schema.mjs'

const codes = {
  INVALID: [400, 'Invalid persona input'],
  NOT_FOUND: [404, 'Persona not found'],
  REVISION_REQUIRED: [409, 'Persona revision required'],
  CONFLICT: [409, 'Persona or roster changed'],
  PROTECTED: [409, 'Default persona is protected'],
  REFERENCED: [409, 'Persona has references or reference status is unavailable'],
  LIMIT: [409, 'Persona storage limit reached'],
  CORRUPT: [500, 'Invalid existing persona storage']
}

// settings-file's inode queue preserves this subclass while mapping raw I/O errors.
export class PersonaError extends SettingsError {
  constructor(kind) {
    super('STORAGE')
    const [status, message] = codes[kind]
    this.name = 'PersonaError'
    this.code = `ERR_PERSONA_${kind}`
    this.status = status
    this.message = message
  }
}
export const fail = kind => { throw new PersonaError(kind) }

const directoryFlags = C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW | C.O_NONBLOCK
const readFlags = C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK
const writeFlags = C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const uid = () => BigInt(process.geteuid())
const bigint = { bigint: true }

export async function optional(task) {
  try { return await task() }
  catch (error) {
    if (error.code === 'ENOENT') return null
    if (error.code === 'ELOOP' || error.code === 'ENOTDIR') fail('CORRUPT')
    throw error
  }
}

export const sameInode = (a, b) => a.dev === b.dev && a.ino === b.ino
export const statKey = info => [info.dev, info.ino, info.ctimeNs, info.mtimeNs, info.size].join(':')
export const sameSnapshot = (a, b) => (!a || !b) ? a === b : statKey(a) === statKey(b)

function checkDirectory(info) {
  if (!info.isDirectory() || info.uid !== uid() || (info.mode & 0o7022n) !== 0n) fail('CORRUPT')
}

function checkFile(info, max, min) {
  if (!info.isFile() || info.nlink !== 1n || info.uid !== uid() || (info.mode & 0o7022n) !== 0n ||
      info.size > BigInt(max) || info.size < BigInt(min)) fail('CORRUPT')
}

export async function assertWritable(parent, old = null) {
  if (((await parent.stat(bigint)).mode & 0o300n) !== 0o300n || (old && (old.mode & 0o200n) === 0n)) {
    throw new SettingsError('READ_ONLY')
  }
}

export async function withChildDirectory(parent, name, create, task) {
  const path = childPath(parent, name)
  let directory = await optional(() => fs.open(path, directoryFlags))
  if (!directory && create) {
    await assertWritable(parent)
    try { await fs.mkdir(path, { mode: 0o700 }) }
    catch (error) { if (error.code !== 'EEXIST') throw error; fail('CONFLICT') }
    await parent.sync()
    directory = await optional(() => fs.open(path, directoryFlags))
    if (!directory) fail('CONFLICT')
  }
  try {
    const info = directory ? await directory.stat(bigint) : null
    if (info) checkDirectory(info)
    const verify = async () => {
      const current = await optional(() => fs.lstat(path, bigint))
      if (current) checkDirectory(current)
      if (Boolean(current) !== Boolean(info) || (info && !sameInode(current, info))) fail('CONFLICT')
    }
    await verify()
    return await task(directory, verify, info)
  } finally { await directory?.close().catch(() => {}) }
}

export async function fileSnapshot(directory, name, max, min = 1) {
  const info = await optional(() => fs.lstat(childPath(directory, name), bigint))
  if (info) checkFile(info, max, min)
  return info
}

export async function verifyFile(directory, name, expected, max, min = 1) {
  if (!sameSnapshot(await fileSnapshot(directory, name, max, min), expected)) fail('CONFLICT')
}

export async function readCheckedText(directory, name, max) {
  const expected = await fileSnapshot(directory, name, max)
  if (!expected) return null
  if ((expected.mode & 0o400n) === 0n) throw new SettingsError('READ_ONLY')
  const file = await optional(() => fs.open(childPath(directory, name), readFlags))
  if (!file) fail('CONFLICT')
  try {
    const info = await file.stat(bigint)
    checkFile(info, max, 1)
    if (!sameSnapshot(info, expected)) fail('CONFLICT')
    const size = Number(info.size)
    const buf = Buffer.alloc(size + 1)
    let offset = 0
    while (offset < buf.length) {
      const { bytesRead } = await file.read(buf, offset, buf.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset !== size || !sameSnapshot(info, await file.stat(bigint))) fail('CONFLICT')
    await verifyFile(directory, name, info, max)
    let raw
    try { raw = decoder.decode(buf.subarray(0, offset)) }
    catch { fail('CORRUPT') }
    return { raw, info }
  } finally { await file.close().catch(() => {}) }
}

async function cleanStage(path, info) {
  if (!info) return
  try {
    if (sameInode(info, await fs.lstat(path, bigint))) await fs.unlink(path)
  } catch { /* Cleanup must not override the visible result. */ }
}

// Publish only exclusively created staged bytes. For a first install link(2) is a
// no-clobber publish of our own staged inode; the transient staging name is removed
// under the same queue, and existing multi-link targets are never read or mutated.
export async function publishCheckedFile(directory, name, raw, expected, max, verify) {
  const bytes = Buffer.from(raw, 'utf8')
  if (bytes.length > max || !bytes.length) fail('LIMIT')
  const target = childPath(directory, name)
  const tmp = childPath(directory, `.persona.${randomBytes(16).toString('hex')}.tmp`)
  await assertWritable(directory, expected)
  const file = await fs.open(tmp, writeFlags, 0o600)
  let staged
  let published
  try {
    staged = await file.stat(bigint)
    await file.chmod(0o600)
    await file.writeFile(bytes)
    await file.sync()
    staged = await file.stat(bigint)
    await directory.sync()
    await verify()
    await verifyFile(directory, name, expected, max)
    const current = await fs.lstat(tmp, bigint)
    checkFile(current, max, 1)
    if (!sameSnapshot(staged, current)) fail('CONFLICT')
    if (expected) await fs.rename(tmp, target)
    else {
      try { await fs.link(tmp, target) }
      catch (error) { if (error.code === 'EEXIST') fail('CONFLICT'); throw error }
    }
    published = true
  } finally {
    await cleanStage(tmp, staged)
    await file.close().catch(() => {})
  }
  if (published) await directory.sync().catch(() => {})
  const info = await fileSnapshot(directory, name, max)
  if (!info || !sameInode(staged, info) || info.size !== staged.size || info.mtimeNs !== staged.mtimeNs) fail('CONFLICT')
  return info
}

export async function removeCheckedFile(directory, name, expected, max, verify) {
  await assertWritable(directory, expected)
  await verify()
  await verifyFile(directory, name, expected, max)
  await fs.unlink(childPath(directory, name))
  await directory.sync().catch(() => {})
}
