import { chatStreamUrl, parseChatFrame, type ChatFrame, type ChatSnapshot, type ChatTransport } from './chat-transport'

/** Return null when a frame needs a new authority snapshot. Never acknowledge it as applied. */
export function applyChatFrame(current: ChatSnapshot | undefined, frame: ChatFrame): ChatSnapshot | null {
  if (frame.t === 'snapshot') return { cursor: frame.cursor, state: frame.state }
  if (!current || current.state.id !== frame.sessionId) return null
  const { cursor, state } = current
  const next = frame.cursor
  if (cursor.epoch !== next.epoch || cursor.generation !== next.generation || cursor.scope !== next.scope) return null
  if (next.seq <= cursor.seq) return current
  if (next.seq !== cursor.seq + 1) return null
  const { turnId, event } = frame
  if (['turn_start', 'done', 'error', 'stream_reset'].includes(event.type)) return null
  if (event.type !== 'text_delta') return { state, cursor: next } // No desktop-only features are projected into the text view.
  if (!state.active || state.active.turnId !== turnId || event.text === undefined) return null
  return { cursor: next, state: { ...state, active: { ...state.active, text: state.active.text + event.text } } }
}

export type ChatLink = 'loading' | 'ready' | 'reconnecting' | 'missing' | 'expired'
export interface ChatProjection { status: ChatLink; snapshot?: ChatSnapshot }

type ChatSocket = Pick<WebSocket, 'onopen' | 'onmessage' | 'onclose' | 'close'>
type Options = {
  sid: string
  origin: string
  read: ChatTransport['read']
  onChange: (projection: ChatProjection) => void
  open?: (url: string) => ChatSocket
  schedule?: (callback: () => void, ms: number) => () => void
}

/** One projection per selected session. Writes and transport reconnect are deliberately independent. */
export function createChatStream({ sid, origin, read, onChange, open = (url) => new WebSocket(url),
  schedule = (fn, ms) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer) }
}: Options) {
  let current: ChatSnapshot | undefined
  let status: ChatLink = 'loading'
  let alive = true
  let socket: ChatSocket | undefined
  let timer: (() => void) | undefined
  let revision = 0
  let failures = 0

  function notify(next: ChatLink): void {
    status = next
    onChange({ status, snapshot: current })
  }
  function disconnect(): void {
    timer?.()
    timer = undefined
    if (!socket) return
    const old = socket
    socket = undefined
    old.onopen = old.onclose = old.onmessage = null
    old.close()
  }
  function halt(next: 'expired' | 'missing'): void {
    disconnect()
    alive = false
    current = undefined
    notify(next)
  }
  function retry(refresh: boolean): void {
    if (!alive) return
    disconnect()
    notify('reconnecting')
    const delay = Math.min(500 * 2 ** failures++, 8000)
    timer = schedule(refresh ? () => void refreshSnapshot() : connect, delay)
  }
  function connect(): void {
    if (!alive) return
    disconnect()
    let ws: ChatSocket
    try { ws = open(chatStreamUrl(origin, sid, current?.cursor)) } catch { retry(true); return }
    socket = ws
    const isCurrent = (): boolean => alive && socket === ws
    ws.onopen = () => {
      if (!isCurrent()) return
      timer?.()
      timer = undefined
      if (current) notify('ready')
    }
    ws.onmessage = ({ data }) => {
      if (!isCurrent()) return
      const frame = parseChatFrame(data, sid)
      const applied = frame && applyChatFrame(current, frame)
      if (!applied) { void refreshSnapshot(); return }
      if (applied === current && status === 'ready') return
      failures = 0
      current = applied
      notify('ready')
    }
    ws.onclose = ({ code, reason }) => {
      if (!isCurrent()) return
      if (code === 1008 && reason === 'auth') { halt('expired'); return }
      // A failed upgrade is exposed to browsers as 1006, including auth expiry. Re-check
      // authorization over REST after repeated failures; the first retry replays from the applied cursor.
      retry(!current || (code === 1006 && failures > 0) || reason === 'snapshot_required')
    }
    timer = schedule(() => retry(true), 10000)
  }
  async function refreshSnapshot(): Promise<void> {
    if (!alive) return
    const job = ++revision
    disconnect()
    notify(current ? 'reconnecting' : 'loading')
    try {
      const next = await read(sid)
      if (!alive || job !== revision) return
      current = next
      if (next.state.compatibility !== 'text') { notify('ready'); return }
      // The GET cursor and state describe the same point. Opening with that cursor closes the
      // GET/upgrade race and avoids reappending any output present in the authorized snapshot.
      notify('reconnecting')
      connect()
    } catch (error) {
      if (!alive || job !== revision) return
      const httpStatus = (error as { status?: number } | null)?.status
      if (httpStatus === 401) halt('expired')
      else if (httpStatus === 404) halt('missing')
      else retry(true)
    }
  }
  void refreshSnapshot()
  return {
    refresh: refreshSnapshot,
    close() { alive = false; disconnect() },
    current: () => ({ status, snapshot: current })
  }
}
