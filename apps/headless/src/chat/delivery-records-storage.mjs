import { randomBytes } from 'node:crypto'
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync,
  renameSync, unlinkSync, writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { DIRECTORY, PATH, fdPath, mountId, sameInode } from '../files/workspace-files-fd.mjs'
import { HttpError } from '../http/policy.mjs'

const stats = { bigint: true }
const dirFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const readFlags = constants.O_RDONLY | constants.O_NONBLOCK
const writeFlags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK
const uid = BigInt(process.geteuid())
const nativeLimit = 32 * 1024 * 1024 // Full native history, including any declared compacted prefix.
const metadataLimit = 128 * 1024 // 256 ledger rows × two formats; no document bytes.
const signature = ['mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs']
const same = (a, b) => sameInode(a, b) && signature.every(key => a[key] === b[key])
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
export const deliveryStorageError = () => new HttpError(503, 'chat_storage_unconfirmed')
export const deliveryLimitError = () => new HttpError(413, 'delivery_history_limit')
const corrupted = () => { throw deliveryStorageError() }

function stat(path) {
  try { return lstatSync(path, stats) } catch (err) { if (err?.code !== 'ENOENT') throw err; return null }
}

const safeDir = (st, privateMode) => st?.isDirectory() && st.uid === uid && (st.mode & (privateMode ? 0o077n : 0o022n)) === 0n
const safeFile = (st, privateMode) => st?.isFile() && st.uid === uid && st.nlink === 1n &&
  (privateMode ? (st.mode & 0o7777n) === 0o600n : (st.mode & 0o022n) === 0n)

/** The workbench holds its data directory's writer lock throughout this synchronous operation.
 * Use directory FDs so neither native reads nor writes ever follow a replacement directory. */
export function withDeliveryFiles(dataDir, sid, use) {
  const root = resolve(dataDir)
  const dirs = []
  function directory(path, privateMode) {
    const named = stat(path)
    if (!named) return null
    if (!safeDir(named, privateMode)) corrupted()
    const parent = dirs.at(-1)
    const fd = openSync(path, dirFlags)
    const entry = { path, fd, named, privateMode, mount: null }
    dirs.push(entry)
    const opened = fstatSync(fd, stats)
    entry.mount = mountId(fd)
    if (!safeDir(opened, privateMode) || !sameInode(named, opened) || (parent && parent.mount !== entry.mount)) corrupted()
    return fdPath(fd)
  }
  function stableDirs() {
    if (realpathSync(root) !== root) corrupted()
    for (const { path, named, privateMode, mount } of dirs) {
      const pin = openSync(path, DIRECTORY)
      try {
        const live = fstatSync(pin, stats)
        if (!safeDir(live, privateMode) || !sameInode(live, named) || mountId(pin) !== mount) corrupted()
      } finally { closeSync(pin) }
    }
  }
  try {
    const home = directory(root, true)
    const data = home && directory(join(home, 'data'), false)
    const chats = data && directory(join(data, 'chats'), false)
    if (!chats) return use(null)
    stableDirs()
    const mount = dirs.at(-1).mount
    const nativeName = `${sid}.json`
    const metadataName = `${sid}.deliveries-v1`
    let nativeBytes = 0
    const native = new Map()
    let metadata

    function read(name, limit, privateMode) {
      const path = join(chats, name)
      const named = stat(path)
      if (!named) return null
      if (!safeFile(named, privateMode) || named.size < 1n) corrupted()
      if (named.size > BigInt(limit)) throw privateMode ? deliveryStorageError() : deliveryLimitError()
      // O_PATH pins the inode before a data open, even if the name races to a device/FIFO.
      const pin = openSync(path, PATH)
      try {
        const pinned = fstatSync(pin, stats)
        if (!safeFile(pinned, privateMode) || !same(named, pinned) || mountId(pin) !== mount) corrupted()
        const fd = openSync(fdPath(pin), readFlags)
        try {
          const opened = fstatSync(fd, stats)
          if (!same(pinned, opened) || mountId(fd) !== mount) corrupted()
          const bytes = Buffer.allocUnsafe(Number(opened.size))
          for (let offset = 0; offset < bytes.length;) {
            const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
            if (!count) corrupted()
            offset += count
          }
          unchanged(name, opened)
          if (!same(opened, fstatSync(fd, stats))) corrupted()
          return { identity: opened, text: decoder.decode(bytes), bytes: bytes.length }
        } finally { closeSync(fd) }
      } finally { closeSync(pin) }
    }

    function readNative(name) {
      const source = read(name, nativeLimit - nativeBytes, false)
      native.set(name, source?.identity ?? null)
      nativeBytes += source?.bytes ?? 0
      return source
    }

    function unchanged(name, expected) {
      const path = join(chats, name)
      if (expected === null) {
        if (stat(path) !== null) corrupted()
        return
      }
      const pin = openSync(path, PATH)
      try {
        if (!same(expected, fstatSync(pin, stats)) || mountId(pin) !== mount) corrupted()
      } finally { closeSync(pin) }
    }

    function validate() {
      stableDirs()
      for (const [name, identity] of native) unchanged(name, identity)
      if (metadata !== undefined) unchanged(metadataName, metadata)
    }

    function readMetadata() {
      const file = read(metadataName, metadataLimit, true)
      metadata = file?.identity ?? null
      return file?.text ?? null
    }

    function saveMetadata(text) {
      if (metadata === undefined || Buffer.byteLength(text) > metadataLimit) corrupted()
      const tmp = join(chats, `${metadataName}.${randomBytes(12).toString('hex')}.tmp`)
      const fd = openSync(tmp, writeFlags, 0o600)
      let pending = true
      try {
        fchmodSync(fd, 0o600)
        writeFileSync(fd, text, 'utf8')
        fsyncSync(fd)
        validate()
        const created = fstatSync(fd, stats)
        const named = stat(tmp)
        if (!safeFile(created, true) || !named || !same(created, named)) corrupted()
        renameSync(tmp, join(chats, metadataName))
        pending = false
        fsyncSync(dirs.at(-1).fd)
        const saved = read(metadataName, metadataLimit, true)
        // rename can change ctime. Still require the inode we published, exact bytes and stable readback.
        if (!saved || !sameInode(saved.identity, created) || saved.text !== text) corrupted()
        metadata = saved.identity
        validate()
      } finally {
        try {
          if (pending) {
            const named = stat(tmp)
            if (named && sameInode(named, fstatSync(fd, stats))) unlinkSync(tmp)
          }
        } finally { closeSync(fd) }
      }
    }

    const result = use({
      readMain() {
        const file = readNative(nativeName)
        return file && { value: parseNativeJSON(file.text), privateMode: (file.identity.mode & 0o7777n) === 0o600n ||
          (file.identity.mode & 0o7777n) === 0o400n }
      },
      readCompacted: name => readNative(name)?.text ?? null,
      readMetadata, saveMetadata
    })
    validate()
    return result
  } finally {
    for (const { fd } of dirs.reverse()) closeSync(fd)
  }
}

// Native JSON is strict about shape at the projection layer. Also reject duplicate object
// keys (JSON.parse would silently choose the last one), and bound nesting / structural work
// before comparisons with the native in-memory view. Ignore syntax inside quoted strings.
export function parseNativeJSON(text) {
  const token = /["[\]{},:\\]/g
  const quote = /["\\]/g
  const scopes = []
  let count = 0
  for (let match; (match = token.exec(text));) {
    if (++count > 1_000_000) throw deliveryLimitError()
    const char = match[0]
    const scope = scopes.at(-1)
    if (char === '"') {
      quote.lastIndex = token.lastIndex
      for (;;) {
        const end = quote.exec(text)
        if (!end) corrupted()
        if (end[0] === '"') break
        quote.lastIndex++
      }
      token.lastIndex = quote.lastIndex
      if (scope?.key) {
        const key = JSON.parse(text.slice(match.index, token.lastIndex))
        if (scope.keys.has(key)) corrupted()
        scope.keys.add(key)
        scope.key = false
      }
    } else if (char === '{' || char === '[') {
      if (scopes.length >= 32) throw deliveryLimitError()
      scopes.push(char === '{' ? { keys: new Set(), key: true } : null)
    } else if (char === '}' || char === ']') {
      scopes.pop()
    } else if (char === ',' && scope) {
      scope.key = true
    }
  }
  return JSON.parse(text)
}
