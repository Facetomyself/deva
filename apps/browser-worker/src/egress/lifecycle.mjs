import { Transform } from 'node:stream'

export const limits = Object.freeze({
  sockets: 32,
  operations: 16,
  headers: 16 * 1024,
  connectMs: 10_000,
  idleMs: 30_000,
  httpMs: 120_000,
  tunnelMs: 30 * 60_000,
  bodyBytes: 32 * 1024 * 1024,
  tunnelBytes: 128 * 1024 * 1024,
  relayBytes: 192 * 1024 * 1024,
})

export function armTimeout(callback, milliseconds) {
  const timer = setTimeout(callback, milliseconds)
  timer.unref()
  return timer
}

export function trackSockets(server) {
  const sockets = new Set()
  server.maxConnections = limits.sockets
  server.prependListener('connection', (socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
  })
  return sockets
}

export function countBytes(limit) {
  let size = 0
  return new Transform({ transform(chunk, _encoding, done) {
    size += chunk.length
    if (size > limit) done(new Error('Transfer limit exceeded'))
    else done(null, chunk)
  } })
}

/** Relay both directions with backpressure and preserve clean FIN/half-close. */
export function relayPeers(left, right, { head, byteLimit, lifetime = limits.tunnelMs, onClose = () => {} }) {
  let transferred = 0
  let idle
  let closed = 0
  let stopped = false
  const deadline = armTimeout(stop, lifetime)
  const startIdle = () => {
    clearTimeout(idle)
    idle = armTimeout(stop, limits.idleMs)
  }
  const makeMeter = () => new Transform({ transform(chunk, _encoding, done) {
    transferred += chunk.length
    if (transferred > byteLimit) return done(new Error('Transfer limit exceeded'))
    startIdle()
    done(null, chunk)
  } })
  const upload = makeMeter()
  const download = makeMeter()
  function stop() {
    if (stopped) return
    stopped = true
    clearTimeout(deadline)
    clearTimeout(idle)
    upload.destroy()
    download.destroy()
    left.destroy()
    right.destroy()
    onClose()
  }
  function closedSocket(socket, hadError) {
    closed++
    if (closed === 2 || hadError || !socket.readableEnded || !socket.writableFinished) stop()
  }
  for (const socket of [left, right]) {
    socket.setTimeout(0)
    socket.once('error', stop)
    socket.once('close', (hadError) => closedSocket(socket, hadError))
  }
  upload.once('error', stop)
  download.once('error', stop)
  startIdle()
  if (head?.length) {
    transferred += head.length
    if (transferred > byteLimit) return stop()
    // A parser head can only be a single initial read. Queue it before piping later bytes.
    right.write(head)
  }
  left.pipe(upload).pipe(right)
  right.pipe(download).pipe(left)
}
