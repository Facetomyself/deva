import type { Transport } from './transport'

export const TERMINAL_DEFAULT_SIZE = { cols: 80, rows: 12 } as const
export const TERMINAL_COMPACT_SIZE = { cols: 64, rows: 8 } as const
export const TERMINAL_WAIT_MS = 5_000

const keys = ['up', 'down', 'page-up', 'page-down', 'home', 'end', 'left', 'right', 'quit'] as const
const reasons = ['quit', 'disposed', 'fault', 'worker-lost'] as const
const MAX_LINES = 4_096
const MAX_LEFT_EDGE = 524_288
const MAX_SCREEN_BYTES = 96 * 1024
const MAX_EVENTS = 8
const MAX_EXIT_STATUS = 2_147_483_647
const encoder = new TextEncoder()
// Permit ZWNJ and ZWJ for grapheme shaping, but never pass terminal/bidi controls to text rendering.
const nonRendered = /[\p{Cc}\p{Zl}\p{Zp}]|(?:(?![\u200c\u200d])\p{Cf})/gu
const loneSurrogate = /[\ud800-\udfff]/u
export type TerminalKey = typeof keys[number]
export type TerminalSize = { cols: number; rows: number }
export type TerminalTarget = { workspaceId: string; path: string; revision: string }
export type TerminalScreen = TerminalSize & { top: number; left: number; totalLines: number; lines: string[] }
export type TerminalExit = { code: number | null; signal: number | null; reason: typeof reasons[number] }
type TerminalEvent = { seq: number } & ({ type: 'screen'; screen: TerminalScreen } | { type: 'exit'; exit: TerminalExit })
type TerminalBatch = { cursor: number; reset: boolean; events: TerminalEvent[] }
type TerminalStart = { id: string; sequence: 0; cursor: 1; screen: TerminalScreen; exit: null }
type TerminalProfiles = { available: boolean; profiles: { id: 'text-view'; label: 'Read-only text viewer' }[]; reason: 'unavailable' | 'unconfigured' | null }

function invalid(): never { throw new Error('Invalid TTY text viewer request or response') }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}
export function isTerminalWorkspace(value: unknown): value is string {
  return typeof value === 'string' && /^w_[a-f0-9]{32}$/u.exec(value)?.[0] === value
}
export function isTerminalRevision(value: unknown): value is string {
  return typeof value === 'string' && /^r_[a-f0-9]{64}$/u.exec(value)?.[0] === value
}
export function isTerminalPath(value: unknown): value is string {
  return typeof value === 'string' && !/[\\\x00-\x1f\x7f-\x9f]/u.test(value) &&
    value.split('/').every(segment => segment && segment !== '.' && segment !== '..' && !/^[A-Za-z]:/u.test(segment))
}
function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^pt_[a-f0-9]{32}$/u.exec(value)?.[0] === value
}
export function isTerminalKey(value: unknown): value is TerminalKey {
  return (keys as readonly unknown[]).includes(value)
}
export function isTerminalSize(value: TerminalSize): boolean {
  return !!value && integer(value.cols, 24, 160) && integer(value.rows, 4, 50)
}
function sizeOf({ cols, rows }: Record<string, unknown>): TerminalSize {
  return integer(cols, 24, 160) && integer(rows, 4, 50) ? { cols, rows } : invalid()
}
function screenOf(value: unknown): TerminalScreen {
  const fields = object(value)
  const { top, left, totalLines, lines } = fields
  const { cols, rows } = sizeOf(fields)
  if (!integer(totalLines, 1, MAX_LINES) || !integer(top, 0, totalLines - 1) || !integer(left, 0, MAX_LEFT_EDGE - cols) ||
      !Array.isArray(lines) || !integer(lines.length, 1, Math.min(rows, totalLines - top))) return invalid()
  let bytes = 0
  let renderedBytes = 0
  const rendered: string[] = []
  for (const line of lines) {
    if (typeof line !== 'string' || line.length > MAX_SCREEN_BYTES || loneSurrogate.test(line)) return invalid()
    const size = encoder.encode(line).byteLength
    const safe = line.replace(nonRendered, '\uFFFD')
    bytes += size
    renderedBytes += safe === line ? size : encoder.encode(safe).byteLength
    if (bytes > MAX_SCREEN_BYTES || renderedBytes > MAX_SCREEN_BYTES) return invalid()
    rendered.push(safe)
  }
  return { cols, rows, top, left, totalLines, lines: rendered }
}
function exitOf(value: unknown): TerminalExit {
  const { code, signal, reason } = object(value)
  if ((code !== null && !integer(code, 0, MAX_EXIT_STATUS)) || (signal !== null && !integer(signal, 0, MAX_EXIT_STATUS))) return invalid()
  switch (reason) {
    case 'quit': case 'disposed': case 'fault': return { code, signal, reason }
    case 'worker-lost': return code === null && signal === null ? { code, signal, reason } : invalid()
    default: return invalid()
  }
}
function batchOf(value: unknown, after: number): TerminalBatch {
  const { cursor, reset, events } = object(value)
  if (!integer(cursor, after) || typeof reset !== 'boolean' || !Array.isArray(events) ||
      events.length > MAX_EVENTS || (reset && !integer(events.length, 1, 2))) return invalid()
  let last = after
  let exited = false
  const result = events.map((value, index): TerminalEvent => {
    const { seq, type, screen, exit } = object(value)
    if (exited || !integer(seq, last + 1, cursor) || (!reset && seq !== last + 1) ||
        (reset && index === 1 && type !== 'exit')) return invalid()
    last = seq
    switch (type) {
      case 'screen': return { seq, type, screen: screenOf(screen) }
      case 'exit': exited = true; return { seq, type, exit: exitOf(exit) }
      default: return invalid()
    }
  })
  if (last !== cursor) return invalid()
  return { cursor, reset, events: result }
}

/** Fixed same-origin owner projection. Inputs are allowlisted and rebuilt, never spread into a request. */
export function createTerminalViewTransport(transport: Transport, csrf: string) {
  function resource(workspaceId: string, id?: string, action?: 'input' | 'resize' | 'events' | 'dispose'): string {
    if (!csrf || !isTerminalWorkspace(workspaceId) || (action && !isSessionId(id))) return invalid()
    return `/workspaces/${workspaceId}/terminals${action ? `/${id}/${action}` : ''}`
  }
  function post(path: string, body: object, options?: { signal?: AbortSignal; expectedStatus?: number; keepalive?: boolean }): Promise<unknown> {
    return transport.request(path, 'POST', body, csrf, { referrerPolicy: 'same-origin', ...options })
  }
  async function mutation(path: string, sequence: number, fields: { key: TerminalKey } | TerminalSize, signal: AbortSignal): Promise<{ sequence: number }> {
    if (!integer(sequence, 1)) return invalid()
    const receipt = object(await post(path, { sequence, ...fields }, { signal }))
    return receipt.sequence === sequence ? { sequence } : invalid()
  }
  async function dispose(workspaceId: string, id: string): Promise<{ closed: true; exit: TerminalExit }> {
    const receipt = object(await post(resource(workspaceId, id, 'dispose'), {}, { keepalive: true }))
    return receipt.closed === true ? { closed: true, exit: exitOf(receipt.exit) } : invalid()
  }
  return {
    async profiles(signal: AbortSignal): Promise<TerminalProfiles> {
      const { available, profiles, reason } = object(await transport.request('/terminal/profiles', 'GET', undefined, undefined, { signal }))
      if (typeof available !== 'boolean' || !Array.isArray(profiles) || profiles.length !== (available ? 1 : 0)) return invalid()
      const projected = profiles.map(value => {
        const { id, label } = object(value)
        return id === 'text-view' && label === 'Read-only text viewer' ? { id, label } as const : invalid()
      })
      if (available ? reason !== null : (reason !== 'unavailable' && reason !== 'unconfigured')) return invalid()
      return { available, profiles: projected, reason: reason as TerminalProfiles['reason'] }
    },
    async start({ workspaceId, path, revision }: TerminalTarget, { cols, rows }: TerminalSize): Promise<TerminalStart> {
      if (!isTerminalPath(path) || !isTerminalRevision(revision) || !isTerminalSize({ cols, rows })) return invalid()
      // Once dispatched, let the receipt settle even after close so we can dispose a late creation by its original ID.
      const result = object(await post(resource(workspaceId), { profile: 'text-view', path, revision, cols, rows }, { expectedStatus: 201 }))
      if (!isSessionId(result.id)) return invalid()
      const id = result.id
      try {
        if (result.sequence !== 0 || result.cursor !== 1 || result.exit !== null) return invalid()
        const screen = screenOf(result.screen)
        if (screen.cols !== cols || screen.rows !== rows || screen.top !== 0 || screen.left !== 0) return invalid()
        return { id, sequence: 0, cursor: 1, screen, exit: null }
      } catch (error) {
        void dispose(workspaceId, id).catch(() => {})
        throw error
      }
    },
    async input(workspaceId: string, id: string, sequence: number, key: TerminalKey, signal: AbortSignal): Promise<{ sequence: number }> {
      if (!isTerminalKey(key)) return invalid()
      return mutation(resource(workspaceId, id, 'input'), sequence, { key }, signal)
    },
    async resize(workspaceId: string, id: string, sequence: number, { cols, rows }: TerminalSize, signal: AbortSignal): Promise<{ sequence: number }> {
      if (!isTerminalSize({ cols, rows })) return invalid()
      return mutation(resource(workspaceId, id, 'resize'), sequence, { cols, rows }, signal)
    },
    async events(workspaceId: string, id: string, after: number, waitMs: number, signal: AbortSignal): Promise<TerminalBatch> {
      if (!integer(after) || !integer(waitMs, 0, TERMINAL_WAIT_MS)) return invalid()
      return batchOf(await post(resource(workspaceId, id, 'events'), { after, waitMs }, { signal }), after)
    },
    dispose
  }
}
export type TerminalViewTransport = ReturnType<typeof createTerminalViewTransport>
