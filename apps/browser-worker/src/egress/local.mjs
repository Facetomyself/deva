import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { basename, dirname } from 'node:path'
import { armTimeout, limits, relayPeers, trackSockets } from './lifecycle.mjs'
import { closeServer, listen, socketPathCheck } from './unix.mjs'

/** Raw loopback-to-Unix transport. HTTP and CONNECT are interpreted only by the broker. */
export async function startLocalProxy({ socketPath, host = '127.0.0.1', port = 0 } = {}) {
  socketPathCheck(socketPath)
  if (host !== '127.0.0.1' || !Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('Expected a local IPv4 loopback endpoint')
  if (process.platform !== 'linux' || await realpath(socketPath) !== socketPath) throw new Error('Expected a private Linux broker socket')
  const directoryPath = dirname(socketPath)
  const dir = await open(directoryPath, constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_RDONLY)
  try {
    const directoryStat = await dir.stat()
    const unixPath = `/proc/self/fd/${dir.fd}/${basename(socketPath)}`
    socketPathCheck(unixPath)
    const socketStat = await lstat(unixPath)
    function sameIdentity(a, b) { return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid }
    const expectedSocket = (stat) => stat.isSocket() && (stat.mode & 0o7777) === 0o600 &&
      sameIdentity(stat, socketStat) && stat.birthtimeMs === socketStat.birthtimeMs
    async function verifySocket() {
      const [visibleDir, visibleSocket, pinnedSocket] = await Promise.all([lstat(directoryPath), lstat(socketPath), lstat(unixPath)])
      if (!visibleDir.isDirectory() || (visibleDir.mode & 0o7777) !== 0o700 || !sameIdentity(visibleDir, directoryStat) ||
          socketStat.uid !== directoryStat.uid || !expectedSocket(visibleSocket) || !expectedSocket(pinnedSocket)) {
        throw new Error('Expected the original private broker socket')
      }
    }
    await verifySocket()
    const server = createServer({ allowHalfOpen: true }, (client) => {
      let upstream
      const connectDeadline = armTimeout(cleanup, limits.connectMs)
      function cleanup() { clearTimeout(connectDeadline); client.destroy(); upstream?.destroy() }
      client.once('end', cleanup)
      client.once('close', cleanup)
      void verifySocket().then(() => {
        if (client.destroyed) return
        upstream = createConnection({ path: unixPath, allowHalfOpen: true })
        upstream.once('error', cleanup)
        upstream.once('close', cleanup)
        upstream.once('connect', () => {
          // Hand over no client bytes until the destination passes the post-connect check.
          void verifySocket().then(() => {
            clearTimeout(connectDeadline)
            if (client.destroyed || upstream.destroyed) return cleanup()
            client.off('end', cleanup)
            client.off('close', cleanup)
            upstream.off('error', cleanup)
            upstream.off('close', cleanup)
            relayPeers(client, upstream, { byteLimit: limits.relayBytes })
          }).catch(cleanup)
        })
      }).catch(cleanup)
    })
    const sockets = trackSockets(server)
    let closing
    const close = () => closing ??= (async () => {
      try { await closeServer(server, sockets) } finally { await dir.close() }
    })()
    await listen(server, { host, port, exclusive: true, backlog: 32 })
    server.on('error', () => { void close().catch(() => {}) })
    const localPort = server.address().port
    return Object.freeze({ host, port: localPort, url: `http://${host}:${localPort}`, close })
  } catch (error) {
    await dir.close()
    throw error
  }
}
