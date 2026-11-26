import { constants } from 'node:fs'
import { chmod, lstat, open, realpath } from 'node:fs/promises'
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

const safeDir = (stat) => stat.isDirectory() && stat.uid === process.geteuid() && (stat.mode & 0o7777) === 0o700
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino

export async function bindBrokerSocket(server, runDir, sockets) {
  if (process.platform !== 'linux' || typeof runDir !== 'string' || !isAbsolute(runDir) || runDir.includes('\0')) {
    throw new TypeError('Expected a Linux absolute private socket directory')
  }
  const dirPath = resolve(runDir)
  const socketPath = join(dirPath, 'egress.sock')
  socketPathCheck(socketPath)
  if (await realpath(dirPath) !== dirPath) throw new Error('Expected a socket directory without symbolic links')
  const dir = await open(dirPath, constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_RDONLY)
  let bound = false
  try {
    const ownerDir = await dir.stat()
    if (!safeDir(ownerDir)) throw new Error('Expected a 0700 socket directory owned by the effective user')
    const verifyDir = async () => {
      const visible = await lstat(dirPath)
      if (!safeDir(visible) || !sameFile(visible, ownerDir)) throw new Error('Socket directory changed')
    }
    await verifyDir()
    // Pin the directory across bind/chmod/automatic libuv unlink. A renamed path cannot
    // redirect these operations to a different directory. Keep the FD until server close.
    const bindPath = `/proc/self/fd/${dir.fd}/egress.sock`
    try {
      await lstat(bindPath)
      throw new Error('Socket path already exists')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await listen(server, { path: bindPath, exclusive: true, backlog: 32 })
    bound = true
    await chmod(bindPath, 0o600)
    await verifyDir()
    const [boundStat, visibleStat] = await Promise.all([lstat(bindPath), lstat(socketPath)])
    if (!boundStat.isSocket() || boundStat.uid !== process.geteuid() || (boundStat.mode & 0o7777) !== 0o600 || !sameFile(boundStat, visibleStat)) {
      throw new Error('Socket ownership or mode verification failed')
    }
    return { socketPath, releaseDirectory: () => dir.close() }
  } catch (error) {
    if (bound) await closeServer(server, sockets).catch(() => {})
    await dir.close()
    throw error
  }
}
