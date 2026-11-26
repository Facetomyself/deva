type Cursor = { epoch: string; generation: string; scope: 'sessions'; seq: number }
type Frame = { t: 'sessions-snapshot' | 'sessions-changed'; cursor: Cursor }
type Socket = Pick<WebSocket, 'onmessage' | 'onclose' | 'close'>

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
export function parseSessionsFrame(data: unknown): Frame | null {
  if (typeof data !== 'string') return null
  try {
    const value: unknown = JSON.parse(data)
    if (!record(value) || Object.keys(value).length !== 2 || (value.t !== 'sessions-snapshot' && value.t !== 'sessions-changed')) return null
    const c = value.cursor
    if (!record(c) || Object.keys(c).length !== 4 || c.scope !== 'sessions' || typeof c.epoch !== 'string' || !c.epoch ||
        typeof c.generation !== 'string' || !c.generation || typeof c.seq !== 'number' || !Number.isSafeInteger(c.seq) || c.seq < 0) return null
    return { t: value.t, cursor: { scope: c.scope, epoch: c.epoch, generation: c.generation, seq: c.seq } }
  } catch { return null }
}
function streamUrl(origin: string): string {
  const url = new URL('/api/v1/chats/stream', origin)
  if (url.protocol === 'https:') url.protocol = 'wss:'
  else if (url.protocol === 'http:') url.protocol = 'ws:'
  else throw new Error('Invalid workbench origin')
  return url.href
}

/** Only the GET supplies list data. Each connection begins with a fresh authoritative invalidation. */
export function createSessionsStream({ origin, invalidate, expired, open = (url) => new WebSocket(url),
  schedule = (fn, ms) => { const id = setTimeout(fn, ms); return () => clearTimeout(id) }
}: {
  origin: string
  invalidate: () => void
  expired: () => void
  open?: (url: string) => Socket
  schedule?: (callback: () => void, ms: number) => () => void
}) {
  let active = true
  let socket: Socket | undefined
  let timer: (() => void) | undefined
  let failures = 0
  function clearTimer(): void { timer?.(); timer = undefined }
  function disconnect(): void {
    clearTimer()
    const old = socket
    socket = undefined
    if (old) { old.onmessage = old.onclose = null; old.close() }
  }
  function retry(recheck: boolean): void {
    disconnect()
    if (!active) return
    if (recheck) invalidate() // Also checks cookie expiry if the browser hides the failed upgrade's HTTP status.
    timer = schedule(connect, Math.min(500 * 2 ** failures++, 8000))
  }
  function connect(): void {
    if (!active) return
    disconnect()
    let ws: Socket
    try { ws = open(streamUrl(origin)) } catch { retry(true); return }
    socket = ws
    let cursor: Cursor | undefined
    ws.onmessage = ({ data }) => {
      if (!active || socket !== ws) return
      const frame = parseSessionsFrame(data)
      if (!frame || (!cursor && frame.t !== 'sessions-snapshot')) { retry(true); return }
      const next = frame.cursor
      if (cursor && (next.epoch !== cursor.epoch || next.generation !== cursor.generation)) {
        if (frame.t !== 'sessions-snapshot') { retry(true); return }
      } else if (cursor && next.seq <= cursor.seq) return
      // A gap is legal when the server coalesces invalidations; one GET reads through that watermark.
      cursor = next
      clearTimer()
      failures = 0
      invalidate()
    }
    ws.onclose = ({ code, reason }) => {
      if (!active || socket !== ws) return
      if (code === 1008 && reason === 'auth') { active = false; disconnect(); expired(); return }
      retry(!cursor)
    }
    timer = schedule(() => retry(true), 5000)
  }
  connect()
  return { close() { active = false; disconnect() } }
}
