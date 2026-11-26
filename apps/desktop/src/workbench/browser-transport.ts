import type { Transport } from './transport'

export const FRAME_WIDTH = 1024
export const FRAME_HEIGHT = 768
const PNG_LIMIT = 4 * 1024 * 1024
export const MAX_BROWSER_TEXT = 1024
export const BROWSER_KEYS = ['Backspace', 'Tab', 'Enter', 'Escape', 'End', 'Home', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Delete'] as const
export type BrowserKey = typeof BROWSER_KEYS[number]
export type BrowserAction =
  | { type: 'click'; x: number; y: number }
  | { type: 'scroll'; x: number; y: number; deltaX: number; deltaY: number }
  | { type: 'text'; text: string }
  | { type: 'key'; key: BrowserKey }

const WORKER_STATES = ['ready', 'unconfigured', 'egress-unavailable', 'binary-missing', 'sandbox-startup-failure', 'worker-unavailable'] as const
export type WorkerState = typeof WORKER_STATES[number]
export type BrowserSite = { id: string; label: string; origin: string }
export type BrowserTab = { sessionId: string; tabId: string; siteId?: string; state: 'open' | 'leased' | 'returned'; label: string; origin: string }
export type FinishIntent = 'done' | 'skip'
export type BrowserProof = { viewerNonce: string; token: string }

type Value = Record<string, unknown>
const sidPattern = /^[A-Za-z0-9_-]{1,128}$/u
const tabPattern = /^[A-Za-z0-9_-]{24}$/u
const sitePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u
const proofPattern = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u
const invalid = (): never => { throw new Error('Invalid browser panel request or response') }
const object = (value: unknown): Value => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : invalid()
const matches = (value: unknown, pattern: RegExp): value is string => typeof value === 'string' && pattern.exec(value)?.[0] === value
const bounded = (n: unknown, low: number, high: number): boolean => typeof n === 'number' && Number.isFinite(n) && n >= low && n <= high

export function isBrowserKey(key: string): key is BrowserKey {
  return (BROWSER_KEYS as readonly string[]).includes(key)
}

export function isBrowserText(text: string): boolean {
  return text.length > 0 && text.length <= MAX_BROWSER_TEXT && !/[\p{Cc}\p{Cs}]/u.test(text)
}

export function newViewerNonce(random: Pick<Crypto, 'getRandomValues'> = window.crypto): string {
  const bytes = random.getRandomValues(new Uint8Array(32))
  try {
    return btoa(String.fromCharCode(...bytes)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
  } finally { bytes.fill(0) }
}

export function pointsOnFrame(rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, clientX: number, clientY: number) {
  if (!(rect.width > 0 && rect.height > 0)) return undefined
  const x = Math.floor((clientX - rect.left) * FRAME_WIDTH / rect.width)
  const y = Math.floor((clientY - rect.top) * FRAME_HEIGHT / rect.height)
  if (!bounded(x, 0, FRAME_WIDTH - 1) || !bounded(y, 0, FRAME_HEIGHT - 1)) return undefined
  return { x, y }
}

export function wheelPixels(delta: number, mode: number, page: number): number {
  const pixels = delta * (mode === 1 ? 16 : mode === 2 ? page : 1)
  return Math.max(-2048, Math.min(2048, pixels))
}

function projectAction(action: BrowserAction): BrowserAction {
  if (action.type === 'key' && isBrowserKey(action.key)) return { type: 'key', key: action.key }
  if (action.type === 'text' && typeof action.text === 'string' && isBrowserText(action.text)) return { type: 'text', text: action.text }
  if (action.type === 'click' || action.type === 'scroll') {
    const { x, y } = action
    if (!bounded(x, 0, FRAME_WIDTH - 1) || !bounded(y, 0, FRAME_HEIGHT - 1)) return invalid()
    if (action.type === 'click') return { type: 'click', x, y }
    if (bounded(action.deltaX, -2048, 2048) && bounded(action.deltaY, -2048, 2048)) {
      return { type: 'scroll', x, y, deltaX: action.deltaX, deltaY: action.deltaY }
    }
  }
  return invalid()
}

function originOf(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096) return invalid()
  let url: URL
  try { url = new URL(value) } catch { return invalid() }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== value) return invalid()
  return value
}

function labelOf(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return invalid()
  return value
}

function tabOf(value: unknown, sid: string, expectedTab?: string): BrowserTab {
  const { sessionId, tabId, siteId, state, origin, label } = object(value)
  if (sessionId !== sid || !matches(tabId, tabPattern) || (expectedTab !== undefined && tabId !== expectedTab) ||
      (siteId !== undefined && !matches(siteId, sitePattern)) || (state !== 'open' && state !== 'leased' && state !== 'returned')) return invalid()
  return { sessionId, tabId, ...(siteId === undefined ? {} : { siteId }), state, origin: originOf(origin), label: labelOf(label) }
}

function proofOf({ viewerNonce, token }: BrowserProof): BrowserProof {
  if (!matches(viewerNonce, proofPattern) || !matches(token, proofPattern)) return invalid()
  return { viewerNonce, token }
}

async function frameOf(response: Response): Promise<Blob> {
  if (response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'image/png' ||
      Number(response.headers.get('content-length')) > PNG_LIMIT || !response.body) {
    void response.body?.cancel().catch(() => {})
    return invalid()
  }
  const reader = response.body.getReader()
  const chunks: ArrayBuffer[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > PNG_LIMIT) { void reader.cancel().catch(() => {}); return invalid() }
      chunks.push(new Uint8Array(value).buffer)
    }
  } finally { reader.releaseLock() }
  if (size < 45) return invalid()
  const frame = new Blob(chunks, { type: 'image/png' })
  const header = new DataView(await frame.slice(0, 24).arrayBuffer())
  if (header.getUint32(0) !== 0x89504e47 || header.getUint32(4) !== 0x0d0a1a0a || header.getUint32(8) !== 13 ||
      header.getUint32(12) !== 0x49484452 || header.getUint32(16) !== FRAME_WIDTH || header.getUint32(20) !== FRAME_HEIGHT) return invalid()
  return frame
}

/** Web-only HTTP projection; all proof and action data travels in same-origin POST bodies. */
export function createBrowserTransport(transport: Transport, csrf: string) {
  const chat = (sid: string): string => matches(sid, sidPattern) ? `/chats/${encodeURIComponent(sid)}/browser` : invalid()
  const resource = (sid: string, tabId: string, op: 'lease' | 'frame' | 'input' | 'finish' | 'close'): string =>
    matches(tabId, tabPattern) ? `${chat(sid)}/${tabId}/${op}` : invalid()
  const json = async (path: string, signal?: AbortSignal, body?: unknown) =>
    object(await (await transport.browserRequest(path, csrf, signal, body)).json())

  return {
    async status(signal: AbortSignal): Promise<WorkerState> {
      const { state } = await json('/browser/status', signal)
      return typeof state === 'string' && (WORKER_STATES as readonly string[]).includes(state) ? state as WorkerState : invalid()
    },
    async sites(signal: AbortSignal): Promise<BrowserSite[]> {
      const { sites } = await json('/browser/sites', signal)
      if (!Array.isArray(sites) || sites.length > 128) return invalid()
      const seen = new Set<string>()
      return sites.map((item) => {
        const { id, label, origin } = object(item)
        if (!matches(id, sitePattern) || seen.has(id)) return invalid()
        seen.add(id)
        return { id, label: labelOf(label), origin: originOf(origin) }
      })
    },
    async tabs(sid: string, signal: AbortSignal): Promise<BrowserTab[]> {
      const { tabs } = await json(chat(sid), signal)
      if (!Array.isArray(tabs) || tabs.length > 128) return invalid()
      return tabs.map((tab) => tabOf(tab, sid))
    },
    async open(sid: string, site: BrowserSite, signal: AbortSignal): Promise<BrowserTab> {
      if (!matches(site.id, sitePattern)) return invalid()
      const tab = tabOf((await json(`${chat(sid)}/open`, signal, { siteId: site.id })).tab, sid)
      if ((tab.siteId !== undefined && tab.siteId !== site.id) || tab.origin !== site.origin || tab.state !== 'open') return invalid()
      return tab
    },
    async lease(sid: string, tabId: string, viewerNonce: string, signal?: AbortSignal): Promise<{ token: string; ttlMs: number }> {
      if (!matches(viewerNonce, proofPattern)) return invalid()
      const { token, ttlMs } = await json(resource(sid, tabId, 'lease'), signal, { viewerNonce, intent: 'control' })
      if (!matches(token, proofPattern) || typeof ttlMs !== 'number' || !Number.isSafeInteger(ttlMs) || !bounded(ttlMs, 1, 2_147_483_647)) return invalid()
      return { token, ttlMs }
    },
    async frame(sid: string, tabId: string, proof: BrowserProof, signal: AbortSignal): Promise<Blob> {
      return frameOf(await transport.browserRequest(resource(sid, tabId, 'frame'), csrf, signal, proofOf(proof), true))
    },
    async input(sid: string, tabId: string, proof: BrowserProof, seq: number, action: BrowserAction, signal: AbortSignal): Promise<void> {
      if (!Number.isSafeInteger(seq) || seq < 1) return invalid()
      const ack = await json(resource(sid, tabId, 'input'), signal, { ...proofOf(proof), seq, action: projectAction(action) })
      if (ack.accepted !== true || ack.seq !== seq) return invalid()
    },
    async finish(sid: string, tabId: string, proof: BrowserProof, intent: FinishIntent): Promise<BrowserTab> {
      if (intent !== 'done' && intent !== 'skip') return invalid()
      const tab = tabOf((await json(resource(sid, tabId, 'finish'), undefined, { ...proofOf(proof), intent })).tab, sid, tabId)
      return tab.state === 'returned' ? tab : invalid()
    },
    async close(sid: string, tabId: string, signal: AbortSignal): Promise<void> {
      if ((await json(resource(sid, tabId, 'close'), signal, {})).closed !== true) return invalid()
    }
  }
}

export type BrowserTransport = ReturnType<typeof createBrowserTransport>
