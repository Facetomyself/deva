import { constants, lstatSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs'
import { chmod, link, mkdtemp, open } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

export function socketPathCheck(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || Buffer.byteLength(path) > 107) {
    throw new TypeError('Expected an absolute Linux Unix socket path within 107 bytes')
  }
}

export function listen(server, options) {
  return new Promise((resolveListen, reject) => {
    const error = (err) => { server.off('listening', ready); reject(err) }
    const ready = () => { server.off('error', error); resolveListen() }
    server.once('error', error)
    server.once('listening', ready)
    try { server.listen(options) } catch (err) { server.off('error', error); server.off('listening', ready); reject(err) }
  })
}

export function closeServer(server, sockets) {
  return new Promise((resolveClose, reject) => {
    server.close((error) => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
      else resolveClose()
    })
    for (const socket of sockets) socket.destroy()
  })
}

const openDirFlags = constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_RDONLY
const ownedByUser = (stat) => stat?.uid === BigInt(process.geteuid())
const safeDir = (stat) => ownedByUser(stat) && stat.isDirectory() && (stat.mode & 0o7777n) === 0o700n
const safeSocket = (stat) => ownedByUser(stat) && stat.isSocket() && (stat.mode & 0o7777n) === 0o600n
const sameFile = (a, b) => Boolean(a && b && a.dev === b.dev && a.ino === b.ino)
const samePublished = (current, expected) => safeSocket(current) && sameFile(current, expected) &&
  current.ctimeNs === expected.ctimeNs && current.birthtimeNs === expected.birthtimeNs

function optionalStat(path) {
  try { return lstatSync(path, { bigint: true }) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

export async function bindBrokerSocket(server, runDir, sockets) {
  if (process.platform !== 'linux' || typeof runDir !== 'string' || !isAbsolute(runDir) || runDir.includes('\0')) {
    throw new TypeError('Expected a Linux absolute private socket directory')
  }
  const dirPath = resolve(runDir)
  const socketPath = join(dirPath, 'egress.sock')
  socketPathCheck(socketPath)
  if (realpathSync(dirPath) !== dirPath) throw new Error('Expected a socket directory without symbolic links')
  const dir = await open(dirPath, openDirFlags)
  const pinnedPath = `/proc/self/fd/${dir.fd}/egress.sock`
  let stagePath, stageStat, stage, bindPath, boundStat, published
  function releaseName() {
    if (published && samePublished(optionalStat(pinnedPath), published)) unlinkSync(pinnedPath)
  }
  function releaseStage() {
    if (!stagePath) return
    if (bindPath && boundStat && sameFile(optionalStat(bindPath), boundStat)) unlinkSync(bindPath)
    if (sameFile(optionalStat(stagePath), stageStat)) rmdirSync(stagePath)
    stagePath = null
  }
  async function closeDirectories() {
    try { await stage?.close() } finally { await dir.close() }
  }
  try {
    const ownerDir = await dir.stat({ bigint: true })
    if (!safeDir(ownerDir)) throw new Error('Expected a 0700 socket directory owned by the effective user')
    function verifyDir() {
      const visible = optionalStat(dirPath)
      if (!safeDir(visible) || !sameFile(visible, ownerDir) || realpathSync(dirPath) !== dirPath) throw new Error('Socket directory changed')
    }
    verifyDir()
    if (optionalStat(pinnedPath)) throw new Error('Socket path already exists')

    // libuv unlinks its bind address on close. Keep that address under a pinned,
    // short-lived staging inode so it never names the shared egress.sock entry.
    stagePath = await mkdtemp(`/proc/self/fd/${dir.fd}/.egress-`)
    stageStat = optionalStat(stagePath)
    if (!safeDir(stageStat)) throw new Error('Expected a private socket staging directory')
    stage = await open(stagePath, openDirFlags)
    if (!sameFile(await stage.stat({ bigint: true }), stageStat)) throw new Error('Socket staging directory changed')
    bindPath = `/proc/self/fd/${stage.fd}/s`
    await listen(server, { path: bindPath, exclusive: true, backlog: 32 })
    boundStat = optionalStat(bindPath)
    if (!boundStat?.isSocket() || !ownedByUser(boundStat)) throw new Error('Socket ownership verification failed')
    await chmod(bindPath, 0o600)
    if (!safeSocket(optionalStat(bindPath))) throw new Error('Socket mode verification failed')
    verifyDir()

    // Exclusive publication: never overwrite or adopt a pre-existing name.
    await link(bindPath, pinnedPath)
    const linked = optionalStat(pinnedPath)
    if (!safeSocket(linked) || !sameFile(linked, boundStat)) throw new Error('Socket identity verification failed')
    published = linked
    releaseStage()
    const finalStat = optionalStat(pinnedPath)
    if (!safeSocket(finalStat) || !sameFile(finalStat, linked)) throw new Error('Socket identity verification failed')
    published = finalStat // Dropping the staging name updates the underlying inode ctime.
    verifyDir()
    if (!samePublished(optionalStat(socketPath), published)) throw new Error('Visible socket identity verification failed')
    return { socketPath, releaseDirectory: async () => {
      try { releaseName() } finally { await closeDirectories() }
    } }
  } catch (error) {
    // Cleanup can fail closed on unexpected path changes without hiding the startup error.
    try { releaseName() } catch { /* foreign or changed path */ }
    try { releaseStage() } catch { /* foreign or changed staging entries */ }
    if (server.listening) await closeServer(server, sockets).catch(() => {})
    await closeDirectories().catch(() => {})
    throw error
  }
}
