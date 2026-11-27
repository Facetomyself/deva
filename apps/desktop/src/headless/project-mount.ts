import {
  closeSync, constants, fstatSync, lstatSync, openSync, readlinkSync, readSync, statfsSync, statSync,
  type BigIntStats,
} from 'node:fs'
import { isSnapshotDigest, MAX_SNAPSHOT_BYTES, SnapshotError, validateProjectSnapshot, type ProjectSnapshot } from './project-snapshot'

const TARGET = '/run/deva-project-docs/snapshot.json'
const PROC = '/proc/self'
const PROC_MAGIC = 0x9fa0
const PIN = 0o10000000 | constants.O_NOFOLLOW // Linux O_PATH is absent from Node's constants.
const READ = constants.O_RDONLY | constants.O_NONBLOCK
const FDINFO_LIMIT = 4096, MOUNTINFO_LIMIT = 4 * 1024 * 1024

type MountErrorCode = 'invalid_mount' | 'mount_changed'
export class SnapshotMountError extends Error {
  constructor(readonly code: MountErrorCode) { super(code) }
}

type Pin = { fd: number; stat: BigIntStats }
const sameInode = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino
const sameFile = (a: BigIntStats, b: BigIntStats): boolean => sameInode(a, b) &&
  a.mode === b.mode && a.size === b.size && a.nlink === b.nlink && a.uid === b.uid && a.gid === b.gid &&
  a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs

function boundedRead(fd: number, max: number, overflow: () => never): Buffer {
  const buffer = Buffer.allocUnsafe(max + 1)
  let used = 0
  while (used <= max) {
    const count = readSync(fd, buffer, used, buffer.length - used, null)
    if (!count) return buffer.subarray(0, used)
    used += count
  }
  return overflow()
}

export function loadMountedProjectSnapshot(expected: string | undefined): ProjectSnapshot | undefined {
  if (expected === undefined) return undefined
  if (!isSnapshotDigest(expected)) throw new SnapshotError('invalid_digest')
  if (process.platform !== 'linux') throw new SnapshotMountError('invalid_mount')

  let code: MountErrorCode = 'invalid_mount'
  const fail = (): never => { throw new SnapshotMountError(code) }
  const descriptors: number[] = []
  function open(path: string, flags: number): number {
    const fd = openSync(path, flags)
    descriptors.push(fd)
    return fd
  }
  function release(keep = 0): void {
    while (descriptors.length > keep) {
      try { closeSync(descriptors.pop()!) } catch { /* Continue closing the other descriptors. */ }
    }
  }
  function pin(path: string, directory = false): Pin {
    const fd = open(path, PIN | (directory ? constants.O_DIRECTORY : 0))
    return { fd, stat: fstatSync(fd, { bigint: true }) }
  }

  try {
    const proc = pin('/proc', true)
    const fds = pin(`${PROC}/fd`, true), fdinfo = pin(`${PROC}/fdinfo`, true)
    const mounts = pin(`${PROC}/mountinfo`)
    const pid = `/proc/${process.pid}`
    function checkProc(): void {
      if (statfsSync('/proc').type !== PROC_MAGIC || proc.stat.ino !== 1n ||
          !sameInode(lstatSync('/proc', { bigint: true }), proc.stat) || readlinkSync(PROC) !== String(process.pid)) fail()
      for (const [entry, held] of [['fd', fds], ['fdinfo', fdinfo], ['mountinfo', mounts]] as const) {
        if (held.stat.dev !== proc.stat.dev || !sameInode(lstatSync(`${pid}/${entry}`, { bigint: true }), held.stat)) fail()
      }
    }
    function ref(held: Pin): string {
      const path = `${PROC}/fd/${held.fd}`
      const link = lstatSync(path, { bigint: true })
      if (link.dev !== proc.stat.dev || !link.isSymbolicLink() || !sameInode(statSync(path, { bigint: true }), held.stat)) fail()
      return path
    }
    function procText(held: Pin, max: number): string {
      if (held.stat.dev !== proc.stat.dev || !held.stat.isFile()) fail()
      const fd = open(ref(held), READ)
      if (!sameInode(fstatSync(fd, { bigint: true }), held.stat)) fail()
      const text = boundedRead(fd, max, fail).toString('latin1')
      if (!text.endsWith('\n') || text.includes('\0')) fail()
      return text
    }
    function mountId(fd: number): string {
      const keep = descriptors.length
      try {
        const info = pin(`${ref(fdinfo)}/${fd}`)
        const ids = procText(info, FDINFO_LIMIT).split('\n').filter(line => line.startsWith('mnt_id:'))
        const match = /^mnt_id:[\t ]+([1-9][0-9]{0,9})$/.exec(ids[0] ?? '')
        if (ids.length !== 1 || !match) return fail()
        return match[1]
      } finally { release(keep) }
    }
    function checkMount(leaf: string, parent: string): void {
      const keep = descriptors.length
      try {
        checkProc()
        const procId = mountId(proc.fd)
        if ([fds, fdinfo, mounts].some(entry => mountId(entry.fd) !== procId) || leaf === parent) fail()
        let procFound = false, leafFound = false
        for (const line of procText(mounts, MOUNTINFO_LIMIT).split('\n')) {
          const [id, , , root, point, flags, ...tail] = line.split(' ')
          // A genuine proc root can contain unrelated mounts, but not over our metadata paths.
          if (point === pid || point?.startsWith(`${pid}/`) || point === PROC || point?.startsWith(`${PROC}/`)) fail()
          if (id === procId) {
            const separator = tail.indexOf('-')
            if (procFound || root !== '/' || point !== '/proc' || separator < 0 || tail[separator + 1] !== 'proc') fail()
            procFound = true
          }
          if (id === leaf) {
            const options = flags?.split(',') ?? []
            if (leafFound || point !== TARGET || !options.includes('ro') || options.includes('rw')) fail()
            leafFound = true
          }
        }
        if (!procFound || !leafFound) fail()
      } finally { release(keep) }
    }
    function namedChain(): Pin[] {
      const root = pin('/', true)
      const run = pin(`${ref(root)}/run`, true)
      const parent = pin(`${ref(run)}/deva-project-docs`, true)
      return [root, run, parent, pin(`${ref(parent)}/snapshot.json`)]
    }

    checkProc()
    const chain = namedChain(), leaf = chain[3]
    const ids = chain.map(({ fd }) => mountId(fd))
    checkMount(ids[3], ids[2])
    if (!leaf.stat.isFile() || leaf.stat.nlink !== 1n || leaf.stat.size <= 0n) fail()
    const overflow = (): never => { throw new SnapshotError('snapshot_limit') }
    if (leaf.stat.size > MAX_SNAPSHOT_BYTES) overflow()

    code = 'mount_changed'
    const data = open(ref(leaf), READ)
    const unchanged = (): boolean => sameFile(fstatSync(data, { bigint: true }), leaf.stat) && mountId(data) === ids[3]
    if (!unchanged()) fail()
    const bytes = boundedRead(data, MAX_SNAPSHOT_BYTES, overflow)
    try {
      return validateProjectSnapshot(bytes, expected)
    } finally {
      bytes.fill(0)
      checkProc()
      const current = namedChain()
      if (current.some((entry, i) => !sameInode(entry.stat, chain[i].stat) || mountId(entry.fd) !== ids[i]) ||
          !sameFile(current[3].stat, leaf.stat) || BigInt(bytes.length) !== leaf.stat.size) fail()
      checkMount(ids[3], ids[2])
      if (!unchanged() || !sameFile(fstatSync(leaf.fd, { bigint: true }), leaf.stat)) fail()
    }
  } catch (error) {
    if (error instanceof SnapshotError || error instanceof SnapshotMountError) throw error
    return fail()
  } finally { release() }
}
