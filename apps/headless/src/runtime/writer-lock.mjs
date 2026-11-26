import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { spawnSync } from 'node:child_process'

/** Exclusive writer for the *volume*, not for a PID or container network namespace.
 * Linux flock attaches to the open file description. The short-lived helper locks inherited
 * fd 3; this Node process keeps the same description alive until it closes its fd or exits.
 * Leave the lock file in place; unlinking it would permit another writer on a new inode. */
export function acquireWriterLock(dataDir) {
  if (process.platform !== 'linux' || !isAbsolute(dataDir)) throw Error('A Linux host and an absolute data directory are required')
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const dir = lstatSync(dataDir)
  if (!dir.isDirectory() || dir.uid !== process.getuid() || (dir.mode & 0o077)) throw Error('Data directory must be private and owned by the service user')
  const path = join(dataDir, '.workbench-writer.lock')
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid() || (st.mode & 0o077)) throw Error('Invalid writer lock file')
    const result = spawnSync('/usr/bin/flock', ['-n', '-x', '-E', '73', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd], timeout: 3000, env: {} })
    if (result.error || result.signal || result.status !== 0) {
      throw Error(result.status === 73 ? 'Another writer holds this data directory' : 'Cannot acquire Linux advisory file lock')
    }
  } catch (e) { closeSync(fd); throw e }
  let released = false
  return () => { if (!released) { released = true; closeSync(fd) } }
}
