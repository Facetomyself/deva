import type { Transport } from './transport'

export type DeliveryFormat = 'md' | 'txt'
export interface DeliveryItem {
  index: number
  name: string
  size: number | null
  kind: 'text' | 'image' | 'document'
  status: 'ready' | 'missing' | 'too-large' | 'unsupported'
  revision: string | null
  canDownload: boolean
  canPreview: boolean
  canLocate: boolean
}
export interface DeliveryGroup {
  id: string
  origin: 'reply' | 'desktop'
  turnId?: string
  messageIndex?: number
  items: DeliveryItem[]
}
export interface DeliveryCandidate { turnId: string; messageIndex: number }
export interface DeliveryPage { groups: DeliveryGroup[]; candidates: DeliveryCandidate[]; nextCursor: string | null }
export interface DeliveryLocation { workspaceId: string; path: string }
export interface DeliveryRef { gid: string; index: number; revision: string }

type Json = Record<string, unknown>
const sidPattern = /^[A-Za-z0-9_-]{1,128}$/u
const groupPattern = /^d_[0-9a-f]{32}$/u
const revisionPattern = /^[0-9a-f]{64}$/u
const cursorPattern = /^[A-Za-z0-9_-]{1,160}$/u
const workspacePattern = /^w_[0-9a-f]{32}$/u
const MAX_BINARY_BYTES = 8 * 1024 * 1024
const attachment = /^attachment(?:\s*;|\s*$)/iu
const inline = /^inline(?:\s*;|\s*$)/iu
const rasterTypes = new Set(['image/png', 'image/jpeg', 'image/webp'])
const controls = /[\u0000-\u001f\u007f-\u009f]/u

function invalid(): never { throw new Error('Invalid delivery request or response') }
function object(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : invalid()
}
function match(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.exec(value)?.[0] === value
}
function indexOf(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function safeName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && new TextEncoder().encode(name).length <= 255 &&
    name.trim() === name && !name.startsWith('.') && !name.endsWith('.') &&
    !/[\\/:<>"|?*\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(name) &&
    !/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\s*\.|$)/iu.test(name)
}
function isProjectPath(path: unknown): path is string {
  return typeof path === 'string' && !controls.test(path) && !path.includes('\\') &&
    path.split('/').every((segment) => segment && !segment.startsWith('.') && !/^[A-Za-z]:/u.test(segment))
}
function candidateOf(value: unknown): DeliveryCandidate {
  const { turnId, messageIndex } = object(value)
  if (!match(turnId, sidPattern) || !indexOf(messageIndex)) return invalid()
  return { turnId, messageIndex }
}
function deliveryItem(value: unknown): DeliveryItem {
  const { index, name, size, kind, status, revision, canDownload, canPreview, canLocate } = object(value)
  if (!indexOf(index) || index > 19 || !safeName(name) || (size !== null && !indexOf(size)) ||
      (kind !== 'text' && kind !== 'image' && kind !== 'document') ||
      (status !== 'ready' && status !== 'missing' && status !== 'too-large' && status !== 'unsupported') ||
      (revision !== null && !match(revision, revisionPattern)) ||
      typeof canDownload !== 'boolean' || typeof canPreview !== 'boolean' || typeof canLocate !== 'boolean' ||
      (status === 'ready' ? revision === null || size === null || size > MAX_BINARY_BYTES : revision !== null || canDownload || canPreview || canLocate) ||
      (canPreview && kind !== 'image')) return invalid()
  return { index, name, size, kind, status, revision, canDownload, canPreview, canLocate }
}
function deliveryGroup(value: unknown): DeliveryGroup {
  const { id, origin, turnId, messageIndex, items } = object(value)
  if (!match(id, groupPattern) || (origin !== 'reply' && origin !== 'desktop') || !Array.isArray(items) ||
      (turnId !== undefined && !match(turnId, sidPattern)) || (messageIndex !== undefined && !indexOf(messageIndex))) return invalid()
  const files = items.map(deliveryItem)
  if (new Set(files.map((item) => item.index)).size !== files.length) return invalid()
  return { id, origin, ...(turnId === undefined ? {} : { turnId }), ...(messageIndex === undefined ? {} : { messageIndex }), items: files }
}
function deliveryPage(value: unknown): DeliveryPage {
  const { groups, candidates, nextCursor } = object(value)
  if (!Array.isArray(groups) || (candidates !== undefined && !Array.isArray(candidates)) ||
      (nextCursor !== undefined && nextCursor !== null && !match(nextCursor, cursorPattern))) return invalid()
  const deliveries = groups.map(deliveryGroup)
  const replies = (candidates ?? []).map(candidateOf)
  if (new Set(deliveries.map((group) => group.id)).size !== deliveries.length ||
      new Set(replies.map((candidate) => candidate.turnId)).size !== replies.length ||
      new Set(replies.map((candidate) => candidate.messageIndex)).size !== replies.length) return invalid()
  return { groups: deliveries, candidates: replies, nextCursor: nextCursor ?? null }
}
function base(sid: string): string {
  if (!match(sid, sidPattern)) return invalid()
  return `/chats/${sid}/deliveries`
}
function itemPath(sid: string, ref: DeliveryRef, action: 'download' | 'preview' | 'locate'): string {
  if (!match(ref.gid, groupPattern) || !indexOf(ref.index) || ref.index > 19 || !match(ref.revision, revisionPattern)) return invalid()
  return `${base(sid)}/${ref.gid}/items/${ref.index}/${action}`
}

async function verifyRaster(blob: Blob): Promise<void> {
  const header = new DataView(await blob.slice(0, 24).arrayBuffer())
  const size = header.byteLength
  const u32 = (n: number) => header.getUint32(n)
  const valid = blob.type === 'image/png'
    ? size >= 24 && u32(0) === 0x89504e47 && u32(4) === 0x0d0a1a0a && u32(8) === 13 && u32(12) === 0x49484452 && u32(16) > 0 && u32(20) > 0
    : blob.type === 'image/jpeg'
      ? size >= 4 && header.getUint16(0) === 0xffd8 && header.getUint8(2) === 0xff && header.getUint8(3) !== 0
      : size >= 16 && u32(0) === 0x52494646 && u32(8) === 0x57454250 && header.getUint32(4, true) + 8 === blob.size &&
        [0x56503820, 0x5650384c, 0x56503858].includes(u32(12))
  if (!valid) return invalid()
}

/** Streams only the authorized number of bytes, then labels downloads inert even if their extension is executable. */
async function binaryOf(response: Response, type: 'download' | 'preview', revision: string, expected: number): Promise<Blob> {
  const mime = response.headers.get('content-type')?.trim().toLowerCase() ?? ''
  const length = response.headers.get('content-length')
  const etag = response.headers.get('etag')
  const disposition = response.headers.get('content-disposition') ?? ''
  if (!response.body || response.status !== 200 || etag !== `"${revision}"` ||
      length === null || !/^\d+$/u.test(length) || Number(length) !== expected ||
      (type === 'download' ? !attachment.test(disposition) : !inline.test(disposition) || !rasterTypes.has(mime))) {
    void response.body?.cancel().catch(() => {})
    return invalid()
  }
  const reader = response.body.getReader()
  const chunks: ArrayBuffer[] = []
  let seen = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      seen += value.byteLength
      if (seen > expected) { void reader.cancel().catch(() => {}); return invalid() }
      chunks.push(new Uint8Array(value).buffer)
    }
  } finally { reader.releaseLock() }
  if (seen !== expected) return invalid()
  const blob = new Blob(chunks, { type: type === 'download' ? 'application/octet-stream' : mime })
  if (type === 'preview') await verifyRaster(blob)
  return blob
}

export function createDeliveriesTransport(transport: Transport, csrf: string) {
  const accept = 'application/json'
  async function bytes(sid: string, ref: DeliveryRef, expected: number, signal: AbortSignal, type: 'download' | 'preview'): Promise<Blob> {
    if (!indexOf(expected) || expected > MAX_BINARY_BYTES) return invalid()
    const response = await transport.deliveryRequest(itemPath(sid, ref, type), signal, {
      accept: type === 'download' ? 'application/octet-stream' : 'image/png, image/jpeg, image/webp', ifMatch: `"${ref.revision}"`
    })
    return binaryOf(response, type, ref.revision, expected)
  }
  return {
    async list(sid: string, cursor: string | undefined, signal: AbortSignal): Promise<DeliveryPage> {
      if (cursor !== undefined && !match(cursor, cursorPattern)) return invalid()
      const path = base(sid) + (cursor === undefined ? '' : `?cursor=${cursor}`)
      return deliveryPage(await (await transport.deliveryRequest(path, signal, { accept })).json())
    },
    async exportReply(sid: string, turnId: string, format: DeliveryFormat, signal: AbortSignal) {
      if (!match(turnId, sidPattern) || (format !== 'md' && format !== 'txt')) return invalid()
      const response = await transport.deliveryRequest(`${base(sid)}/reply`, signal, { accept, post: { csrf, body: { turnId, format } } })
      const { created, group } = object(await response.json())
      const parsed = deliveryGroup(group)
      const [file] = parsed.items
      if (typeof created !== 'boolean' || response.status !== (created ? 201 : 200) || parsed.origin !== 'reply' ||
          parsed.turnId !== turnId || parsed.messageIndex === undefined || parsed.items.length !== 1 || file.index !== 0 ||
          file.kind !== 'text' || !file.canDownload || file.canPreview || file.canLocate || !file.name.endsWith(`.${format}`)) return invalid()
      return { created, group: parsed }
    },
    download: (sid: string, ref: DeliveryRef, expected: number, signal: AbortSignal) => bytes(sid, ref, expected, signal, 'download'),
    preview: (sid: string, ref: DeliveryRef, expected: number, signal: AbortSignal) => bytes(sid, ref, expected, signal, 'preview'),
    async locate(sid: string, ref: DeliveryRef, signal: AbortSignal): Promise<DeliveryLocation> {
      const response = await transport.deliveryRequest(itemPath(sid, ref, 'locate'), signal, { accept, post: { csrf, body: { revision: ref.revision } } })
      const { workspaceId, path } = object(await response.json())
      if (!match(workspaceId, workspacePattern) || !isProjectPath(path)) return invalid()
      return { workspaceId, path }
    }
  }
}

export type DeliveriesTransport = ReturnType<typeof createDeliveriesTransport>
