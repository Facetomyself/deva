import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { HttpError } from '../http/policy.mjs'

const mainPath = (dataDir, sid) => join(dataDir, 'data', 'chats', `${sid}.json`)
const unconfirmed = () => new HttpError(503, 'chat_storage_unconfirmed')
// 256 turns × (64 Ki UTF-16 assistant + 12 KiB user) × six JSON bytes per escaped unit,
// plus receipts and media references. Native blobs themselves are never read here.
const maxFile = 128n * 1024n * 1024n
const signature = ['dev', 'ino', 'size', 'mode', 'nlink', 'uid', 'gid', 'mtimeNs', 'ctimeNs']
const same = (a, b) => signature.every(key => a[key] === b[key])
const readStat = { bigint: true }
const validPrivateFile = (stat, writable) => stat.isFile() && stat.nlink === 1n && stat.uid === BigInt(process.geteuid()) &&
  ((stat.mode & 0o7777n) === 0o600n || (!writable && (stat.mode & 0o7777n) === 0o400n)) &&
  stat.size > 0n && stat.size <= maxFile

function loadPrivateFile(path, writable) {
  const named = lstatSync(path, readStat)
  if (!validPrivateFile(named, writable)) throw unconfirmed()
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const opened = fstatSync(fd, readStat)
    if (!validPrivateFile(opened, writable) || !same(named, opened)) throw unconfirmed()
    const bytes = Buffer.allocUnsafe(Number(opened.size))
    for (let offset = 0; offset < bytes.length;) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (!count) throw unconfirmed()
      offset += count
    }
    if (!same(fstatSync(fd, readStat), opened) || !same(lstatSync(path, readStat), opened)) throw unconfirmed()
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } finally { closeSync(fd) }
}

/** Check a cold target's size before the core loads its cache. Non-Web native files still
 * reach the existing history classification; private mode is required for Web mutation. */
export function preflightPreferenceStorage(dataDir, sid) {
  let stat
  try { stat = lstatSync(mainPath(dataDir, sid), readStat) }
  catch (err) {
    if (err?.code === 'ENOENT') return false
    throw unconfirmed()
  }
  if (!stat.isFile() || stat.nlink !== 1n || stat.size <= 0n || stat.size > maxFile) throw unconfirmed()
  return true
}

/** The workbench already holds the volume's writer lock. Compare the native file with the
 * core's cached session before writing, and verify the native readback after saveStrict.
 * This also detects out-of-band drift already visible on disk without silently merging it.
 * Call only after SID and native history compatibility checks; no paths are returned. */
export function confirmPreferenceStorage(dataDir, s, conflictOnDrift = false) {
  let disk
  try { disk = loadPrivateFile(mainPath(dataDir, s.id), conflictOnDrift) }
  catch { throw unconfirmed() }
  // The core's new-session defaults may contain undefined top-level properties; the on-disk
  // object omits those. Known native nested fields have already been JSON-loaded or persisted.
  const expected = Object.fromEntries(Object.entries(s).filter(([, value]) => value !== undefined))
  if (!isDeepStrictEqual(disk, expected)) throw conflictOnDrift
    ? new HttpError(409, 'preferences_conflict') : unconfirmed()
}
