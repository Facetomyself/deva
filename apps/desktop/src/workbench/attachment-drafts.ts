import { MAX_CHAT_ATTACHMENTS, type ChatAttachment, type ChatTransport } from './chat-transport'

type Kind = ChatAttachment['kind']
const FORMATS = new Map<string, { mime: string; kind: Kind }>([
  ['png', { kind: 'image', mime: 'image/png' }], ['jpg', { kind: 'image', mime: 'image/jpeg' }],
  ['jpeg', { kind: 'image', mime: 'image/jpeg' }], ['webp', { kind: 'image', mime: 'image/webp' }],
  ['pdf', { kind: 'document', mime: 'application/pdf' }]
])
// The Web service classifies these allowlisted formats as UTF-8 plain text, even when
// an OS reports a more specific MIME (e.g. application/json or video/mp2t for .ts).
const TEXT = new Set(('txt md markdown json jsonc yaml yml toml ini csv tsv log ' +
  'js jsx ts tsx mjs cjs vue svelte css scss less xml ' +
  'py rb go rs java kt kts c h cpp hpp cc cs php swift m mm sh bash zsh sql gradle properties ' +
  'env r dart lua pl dockerfile makefile cmake').split(' '))
const LIMITS = { image: 2 * 1024 * 1024, text: 512 * 1024, document: 20 * 1024 * 1024 } as const

export type AttachmentIssueCode = 'directory' | 'unreadable' | 'unsupported' | 'name' | 'empty' | 'large' | 'limit' | 'quota' |
  'uploadFailed' | 'removeFailed' | 'expired' | 'invalidContent' | 'unavailable' | 'adapter' | 'turnLimit' | 'sessionLimit'
export interface AttachmentIssue { code: AttachmentIssueCode; name?: string; kind?: Kind }
export interface BrowserFiles { files: File[]; issues: AttachmentIssue[] }

export function browserFiles(transfer: DataTransfer): BrowserFiles {
  const files: File[] = []
  const issues: AttachmentIssue[] = []
  const items = Array.from(transfer.items ?? []).filter((item) => item.kind === 'file')
  for (const item of items) {
    // Read entry metadata only; never enumerate a directory or consult a local path.
    const entry = item.webkitGetAsEntry?.()
    if (entry?.isDirectory) { issues.push({ code: 'directory', name: entry.name }); continue }
    const file = item.getAsFile()
    if (file) files.push(file)
    else issues.push({ code: 'unreadable' })
  }
  if (!items.length) files.push(...Array.from(transfer.files))
  if (!files.length && !issues.length && transfer.types.includes('Files')) issues.push({ code: 'unreadable' })
  return { files, issues }
}

export function checkBrowserFile(file: File): { kind: Kind; mime: string } | AttachmentIssue {
  const name = file.name
  if (file.webkitRelativePath) return { code: 'directory', name }
  if (!name || new TextEncoder().encode(name.normalize('NFC')).length > 255 || name.trim() !== name ||
      name.startsWith('.') || name.endsWith('.') || /[<>:"/\\|?*%#&\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(name) ||
      /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\s*\.|$)/iu.test(name)) return { code: 'name', name }
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  const text = TEXT.has(ext)
  const format = text ? { kind: 'text' as const, mime: 'text/plain' } : FORMATS.get(ext)
  if (!format || (!text && file.type && file.type !== 'application/octet-stream' && file.type !== format.mime))
    return { code: 'unsupported', name }
  if (!file.size) return { code: 'empty', name }
  if (file.size > LIMITS[format.kind]) return { code: 'large', name, kind: format.kind }
  return format
}

type DraftEntry = Pick<ChatAttachment, 'name' | 'kind' | 'size'> & { key: string; status:
  'uploading' | 'ready' | 'removing' | 'expired'; attachment?: ChatAttachment }
export interface AttachmentDraft { entries: readonly DraftEntry[]; issues: readonly AttachmentIssue[] }
export const EMPTY_ATTACHMENTS: AttachmentDraft = { entries: [], issues: [] }

/** undefined means attachments are still uploading/removing or require explicit attention. */
export function readyAttachmentIds(draft: AttachmentDraft): string[] | undefined {
  if (draft.entries.some(({ status, attachment }) => status !== 'ready' || !attachment)) return undefined
  return draft.entries.map(({ attachment }) => attachment!.id)
}

const response = (error: unknown): { status?: number; code?: string } =>
  error && typeof error === 'object' ? error : {}

function uploadIssue(error: unknown, entry: DraftEntry): AttachmentIssue {
  const { status, code } = response(error)
  const issue: AttachmentIssueCode = code === 'attachment_session_limit' ? 'sessionLimit' :
    code === 'attachment_name' ? 'name' : status === 413 ? 'large' : status === 429 ? 'quota' :
      status === 415 || code === 'invalid_attachment' ? 'unsupported' :
        status === 403 || status === 404 || status === 409 || code === 'attachments_unavailable' ? 'unavailable' : 'uploadFailed'
  return { code: issue, name: entry.name, kind: entry.kind }
}

export function attachmentTurnIssue(error: unknown): AttachmentIssueCode | undefined {
  const { code } = response(error)
  switch (code) {
    case 'attachment_not_found':
    case 'invalid_attachment_reference': return 'expired'
    case 'invalid_attachment_content': return 'invalidContent'
    case 'attachment_adapter_unsupported': return 'adapter'
    case 'attachment_too_large':
    case 'attachment_turn_limit': return 'turnLimit'
    case 'attachment_session_limit': return 'sessionLimit'
    case 'attachment_quota': return 'quota'
    case 'attachments_unavailable': return 'unavailable'
    case 'invalid_attachments': return 'unsupported'
    default: return undefined
  }
}

/** One memory-only draft per chat. Only confirmed IDs can enter an explicit turn request. */
export function createAttachmentDrafts(api: Pick<ChatTransport, 'uploadAttachment' | 'removeAttachment'>, onExpired: () => void,
  beforeUpload?: () => Promise<void>) {
  const states = new Map<string, AttachmentDraft>()
  const jobs = new Map<string, Promise<void>>()
  const listeners = new Set<() => void>()
  let serial = 0
  let expired = false
  function expire(): void {
    if (expired) return
    expired = true
    onExpired()
  }
  const get = (sid: string) => states.get(sid) ?? EMPTY_ATTACHMENTS
  function update(sid: string, draft: AttachmentDraft): void {
    if (draft.entries.length || draft.issues.length) states.set(sid, draft)
    else states.delete(sid)
    for (const listener of listeners) listener()
  }
  function warn(sid: string, issue: AttachmentIssue): void {
    const draft = get(sid)
    update(sid, { ...draft, issues: [...draft.issues.slice(-7), issue] })
  }
  function change(sid: string, key: string, replace?: DraftEntry): void {
    const draft = get(sid)
    if (draft.entries.some((entry) => entry.key === key)) update(sid, { ...draft,
      entries: draft.entries.flatMap((entry) => entry.key === key ? replace ? [replace] : [] : [entry]) })
  }
  async function revoke(sid: string, id: string): Promise<boolean> {
    try { await api.removeAttachment(sid, id); return true }
    catch (error) {
      const { status } = response(error)
      if (status === 401) expire()
      return status === 404 || status === 410
    }
  }
  function queue(sid: string, file: File, mime: string, entry: DraftEntry): void {
    const pending = (jobs.get(sid) ?? Promise.resolve()).then(async () => {
      const present = () => get(sid).entries.some((current) => current.key === entry.key)
      if (expired || !present()) return
      try {
        if (beforeUpload) await beforeUpload()
        if (expired || !present()) return
        const attachment = await api.uploadAttachment(sid, file, mime)
        if (expired) return
        if (present()) {
          const { name, kind, size } = attachment
          change(sid, entry.key, { ...entry, name, kind, size, attachment, status: 'ready' })
        } else if (!await revoke(sid, attachment.id)) {
          // An in-flight cancel drops the local card immediately. Drain the response so a
          // server-accepted upload can still be revoked using its now-known ID.
          warn(sid, { code: 'removeFailed', name: entry.name })
        }
      } catch (error) {
        if (response(error).status === 401) expire()
        else if (present()) {
          change(sid, entry.key)
          warn(sid, uploadIssue(error, entry))
        }
      }
    }).finally(() => { if (jobs.get(sid) === pending) jobs.delete(sid) })
    jobs.set(sid, pending)
  }
  function add(sid: string, incoming: BrowserFiles): void {
    if (expired) return
    const entries = [...get(sid).entries]
    const issues = [...incoming.issues]
    for (const file of incoming.files) {
      const format = checkBrowserFile(file)
      if ('code' in format) { issues.push(format); continue }
      if (entries.length >= MAX_CHAT_ATTACHMENTS) { issues.push({ code: 'limit' }); break }
      const entry: DraftEntry = { key: String(++serial), name: file.name, kind: format.kind, size: file.size, status: 'uploading' }
      entries.push(entry)
      queue(sid, file, format.mime, entry)
    }
    update(sid, { entries, issues: issues.slice(0, 8) })
  }
  async function remove(sid: string, key: string): Promise<void> {
    if (expired) return
    const entry = get(sid).entries.find((row) => row.key === key)
    if (!entry || entry.status === 'removing') return
    if (!entry.attachment) { change(sid, key); return }
    change(sid, key, { ...entry, status: 'removing' })
    if (await revoke(sid, entry.attachment.id)) change(sid, key)
    else {
      // A dropped DELETE response must not silently make a cancelled file sendable again.
      change(sid, key, { ...entry, status: 'expired' })
      warn(sid, { code: 'removeFailed', name: entry.name })
    }
  }
  function committed(sid: string, ids: readonly string[]): void {
    const draft = get(sid)
    update(sid, { entries: draft.entries.filter((entry) => !entry.attachment || !ids.includes(entry.attachment.id)), issues: [] })
  }
  function reportTurn(sid: string, ids: readonly string[], code: AttachmentIssueCode): void {
    const draft = get(sid)
    // The response may not say which ID disappeared. Require review before resending this draft.
    const entries = code === 'expired' || code === 'invalidContent' ? draft.entries.map((entry) => entry.attachment && ids.includes(entry.attachment.id)
      ? { ...entry, status: 'expired' as const } : entry) : draft.entries
    update(sid, { entries, issues: [{ code }] })
  }
  return { get, add, remove, warn, committed, reportTurn,
    dismiss: (sid: string) => update(sid, { ...get(sid), issues: [] }),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } }
}

export type AttachmentDrafts = ReturnType<typeof createAttachmentDrafts>
