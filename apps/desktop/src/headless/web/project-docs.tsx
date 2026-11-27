import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { isProjectDocsLabel, MAX_PROJECT_DETAIL_JSON, MAX_PROJECT_DOCUMENTS, MAX_PROJECT_LIST_JSON, MAX_PROJECT_TEXT_BYTES } from '../project-docs-format'
import { isTextAttachmentName, MAX_TEXT_ATTACHMENT_BYTES, textAttachmentProblem } from '../text-file'
import { SessionButton, type Translate } from './session-organizer'
import './project-docs.css'

const listPath = '/api/project-docs'
const authChannel = 'deva:project-docs:auth'
const authChanged = 'auth-changed'
const readTimeout = 15_000
const maxTtl = 28_800_000
const encoder = new TextEncoder()

type Item = { id: string; name: string; bytes: number }
type Snapshot = { project: string; generation: string; documents: Item[] }
type Selection = { list: Snapshot; row: number }
type View = { kind: 'listing' | 'stale' | 'error' } | { kind: 'list'; list: Snapshot } |
  ({ kind: 'reading' } & Selection) | ({ kind: 'detail'; text: string } & Selection)
type Read = { controller: AbortController; timeout: number }
type Time = { wall: number; monotonic: number }
const now = (): Time => ({ wall: Date.now(), monotonic: performance.now() })
const at = (start: Time, delay: number): Time => ({ wall: start.wall + delay, monotonic: start.monotonic + delay })
const remaining = (end: Time) => Math.min(end.wall - Date.now(), end.monotonic - performance.now())

function channel() {
  try { return new BroadcastChannel(authChannel) } catch { return undefined }
}

export function notifyProjectDocsAuthChange() {
  const bus = channel()
  try { bus?.postMessage(authChanged) } catch { /* Advisory browser-local signal. */ }
  finally { bus?.close() }
}

function hasKeys(value: unknown, ...keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

const validId = (id: unknown): id is string => typeof id === 'string' && id.length === 32 && !/[^0-9a-f]/u.test(id)
const validBytes = (bytes: unknown): bytes is number => typeof bytes === 'number' &&
  Number.isInteger(bytes) && bytes >= 1 && bytes <= MAX_TEXT_ATTACHMENT_BYTES

function parseList(value: unknown): Snapshot | undefined {
  if (!hasKeys(value, 'project', 'generation', 'documents')) return
  const { project, generation, documents } = value
  if (!isProjectDocsLabel(project) || !validId(generation) || !Array.isArray(documents) ||
      documents.length < 1 || documents.length > MAX_PROJECT_DOCUMENTS) return
  const items: Item[] = [], names = new Set<string>(), ids = new Set<string>()
  let total = 0
  for (const item of documents as unknown[]) {
    if (!hasKeys(item, 'id', 'name', 'bytes') || !validId(item.id) || !isTextAttachmentName(item.name) || !validBytes(item.bytes)) return
    const name = item.name.normalize('NFC').toLowerCase()
    total += item.bytes
    if (total > MAX_PROJECT_TEXT_BYTES || ids.has(item.id) || names.has(name)) return
    ids.add(item.id); names.add(name)
    items.push({ id: item.id, name: item.name, bytes: item.bytes })
  }
  return { project, generation, documents: items }
}

function parseDetail(value: unknown, generation: string, item: Item): string | undefined {
  if (!hasKeys(value, 'generation', 'id', 'name', 'bytes', 'text') || value.generation !== generation ||
      value.id !== item.id || value.name !== item.name || value.bytes !== item.bytes || typeof value.text !== 'string' ||
      textAttachmentProblem({ name: item.name, text: value.text }) || encoder.encode(value.text).length !== item.bytes) return
  return value.text
}

function ttl(response: Response) {
  const raw = response.headers.get('X-Deva-Session-Ttl-Ms')
  const ms = raw && /^[1-9][0-9]{0,7}$/u.test(raw) ? Number(raw) : 0
  return ms <= maxTtl ? ms : 0
}

async function readJson(response: Response, limit: number): Promise<unknown> {
  const type = response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase()
  if (type !== 'application/json' || !response.body || Number(response.headers.get('Content-Length')) > limit) throw new Error()
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  let raw = '', bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return JSON.parse(raw + decoder.decode())
      bytes += chunk.value.byteLength
      if (bytes > limit) throw new Error()
      raw += decoder.decode(chunk.value, { stream: true })
    }
  } finally { void reader.cancel().catch(() => {}) }
}

function clearSelection(dialog: HTMLDialogElement | null) {
  const selection = document.getSelection()
  if (selection && (dialog?.contains(selection.anchorNode) || dialog?.contains(selection.focusNode))) selection.removeAllRanges()
}

export function ProjectDocs({ t, session, disabled, onExpire }: {
  t: Translate; session: AbortSignal; disabled: boolean; onExpire: () => void
}) {
  const [view, setView] = useState<View | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const opener = useRef<HTMLButtonElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const backButton = useRef<HTMLButtonElement>(null)
  const reloadButton = useRef<HTMLButtonElement>(null)
  const returnRow = useRef<number>()
  const pending = useRef<Read>()
  const lease = useRef<Time>()
  const leaseTimer = useRef<number>()

  const cancelRead = useCallback(() => {
    const previous = pending.current
    pending.current = undefined
    if (previous) { window.clearTimeout(previous.timeout); previous.controller.abort() }
  }, [])
  const clear = useCallback(() => {
    cancelRead()
    window.clearTimeout(leaseTimer.current)
    lease.current = undefined
    returnRow.current = undefined
    clearSelection(dialog.current)
    dialog.current?.close()
    setView(null)
  }, [cancelRead])

  useLayoutEffect(() => {
    const scrub = () => flushSync(clear)
    const visibility = () => { if (document.hidden) scrub() }
    const pageshow = (event: PageTransitionEvent) => { if (event.persisted) scrub() }
    const bus = channel()
    if (bus) bus.onmessage = (event) => { if (event.data === authChanged) scrub() }
    session.addEventListener('abort', clear)
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('pagehide', scrub)
    window.addEventListener('pageshow', pageshow)
    return () => {
      cancelRead()
      window.clearTimeout(leaseTimer.current)
      bus?.close()
      session.removeEventListener('abort', clear)
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('pagehide', scrub)
      window.removeEventListener('pageshow', pageshow)
    }
  }, [cancelRead, clear, session])
  useLayoutEffect(() => { if (disabled) clear() }, [clear, disabled])
  useLayoutEffect(() => {
    if (view && (document.hidden || session.aborted || (lease.current && remaining(lease.current) <= 0))) {
      clear()
      return
    }
    if (view?.kind === 'reading') backButton.current?.focus()
    if (view?.kind === 'stale' || view?.kind === 'error') reloadButton.current?.focus()
    if (view?.kind === 'list' && returnRow.current !== undefined) {
      dialog.current?.querySelectorAll<HTMLButtonElement>('[data-testid="project-doc-row"]')[returnRow.current]?.focus()
      returnRow.current = undefined
    }
  }, [clear, session, view])

  const allowed = () => !document.hidden && !session.aborted && !!dialog.current?.open
  const expired = () => !!lease.current && remaining(lease.current) <= 0
  function armLease(start: Time, ms: number) {
    const end = at(start, ms), old = lease.current
    lease.current = old ? { wall: Math.min(old.wall, end.wall), monotonic: Math.min(old.monotonic, end.monotonic) } : end
    window.clearTimeout(leaseTimer.current)
    const tick = () => {
      if (!lease.current) return
      const delay = remaining(lease.current)
      if (delay <= 0) clear()
      else leaseTimer.current = window.setTimeout(tick, Math.ceil(delay))
    }
    tick()
  }

  async function load(list?: Snapshot, row?: number) {
    if (!allowed() || disabled || pending.current) return
    if (expired()) { clear(); return }
    const item = row === undefined ? undefined : list?.documents[row]
    const detail = list && item && row !== undefined ? { list, item, row } : undefined
    const url = detail ? `${listPath}/${detail.list.generation}/${detail.item.id}` : listPath
    const start = now(), end = at(start, readTimeout)
    const read: Read = { controller: new AbortController(), timeout: window.setTimeout(() => fail('error'), readTimeout) }
    pending.current = read
    const current = () => pending.current === read && allowed()
    function fail(kind: 'stale' | 'error') {
      if (!current()) return
      if (expired()) { clear(); return }
      cancelRead()
      setView({ kind })
    }
    if (!detail && view && view.kind !== 'listing') closeButton.current?.focus()
    setView(detail ? { kind: 'reading', list: detail.list, row: detail.row } : { kind: 'listing' })
    try {
      const response = await fetch(url, { signal: read.controller.signal, method: 'GET', mode: 'same-origin',
        credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
      if (!current()) return
      if (remaining(end) <= 0) throw new Error()
      if (response.status === 401) { clear(); onExpire(); return }
      if (response.status === 404) { fail('stale'); return }
      const ms = ttl(response)
      if (response.status !== 200 || !ms) throw new Error()
      armLease(start, ms)
      if (!current()) return
      const value = await readJson(response, detail ? MAX_PROJECT_DETAIL_JSON : MAX_PROJECT_LIST_JSON)
      if (!current()) return
      if (expired()) { clear(); return }
      if (remaining(end) <= 0) throw new Error()
      if (detail) {
        const text = parseDetail(value, detail.list.generation, detail.item)
        if (text === undefined) throw new Error()
        setView({ kind: 'detail', list: detail.list, row: detail.row, text })
      } else {
        const next = parseList(value)
        if (!next) throw new Error()
        setView({ kind: 'list', list: next })
      }
    } catch { fail('error') }
    finally { if (pending.current === read) cancelRead() }
  }

  function open() {
    if (disabled || session.aborted || document.hidden || !dialog.current || dialog.current.open) return
    dialog.current.showModal()
    closeButton.current?.focus()
    void load()
  }
  function close() {
    clear()
    opener.current?.focus()
  }
  const selected = view?.kind === 'detail' || view?.kind === 'reading' ? view : undefined
  function back() {
    if (!selected || !allowed()) return
    if (expired()) { clear(); return }
    cancelRead()
    clearSelection(dialog.current)
    returnRow.current = selected.row
    setView({ kind: 'list', list: selected.list })
  }
  const label = t('Project documents', '项目资料')
  const loading = view?.kind === 'listing' || view?.kind === 'reading'
  return <>
    <button type="button" className="web-secondary" ref={opener} data-testid="project-docs-open" aria-haspopup="dialog" disabled={disabled} onClick={open}>{label}</button>
    <dialog className="web-project-docs" ref={dialog} aria-labelledby="web-project-docs-title" onCancel={(event) => { event.preventDefault(); close() }}>
      <header className="web-project-docs__head">
        <h2 id="web-project-docs-title">{label}</h2>
        <div className="web-header-actions">
          {selected && <button type="button" className="web-secondary" ref={backButton} data-testid="project-docs-back" onClick={back}>{t('Back to list', '返回列表')}</button>}
          <button type="button" className="web-secondary" ref={closeButton} data-testid="project-docs-close" onClick={close}>{t('Close', '关闭')}</button>
        </div>
      </header>
      <div className="web-project-docs__content">
        {loading && <p role="status" className="web-muted"><span className="web-spinner" aria-hidden="true" />{view.kind === 'listing' ?
          t('Loading document list…', '正在载入资料列表…') : t('Loading document…', '正在载入文档…')}</p>}
        {(view?.kind === 'stale' || view?.kind === 'error') && <>
          <p role="alert" className="web-muted">{view.kind === 'stale' ? t('The published documents changed or are no longer available.', '已发布的项目资料有变更或已失效。') :
            t('Could not read project documents.', '读取项目资料失败。')}</p>
          <button type="button" className="web-secondary" ref={reloadButton} data-testid="project-docs-reload" onClick={() => void load()}>{t('Reload list', '重新载入列表')}</button>
        </>}
        {view?.kind === 'list' && <>
          <h3><bdi>{view.list.project}</bdi></h3>
          <ul className="web-project-docs__list">{view.list.documents.map((item, row) => <li key={item.id}>
            <SessionButton className="web-secondary web-project-docs__row" data-testid="project-doc-row" onClick={() => void load(view.list, row)}>
              <bdi>{item.name}</bdi><span className="web-muted web-project-docs__bytes" dir="ltr">{item.bytes} {t('bytes', '字节')}</span>
            </SessionButton>
          </li>)}</ul>
        </>}
        {view?.kind === 'detail' && <>
          <h3 id="web-project-doc-name"><bdi>{view.list.documents[view.row].name}</bdi></h3>
          <pre data-testid="project-doc-body" aria-labelledby="web-project-doc-name" tabIndex={0}>{view.text}</pre>
        </>}
      </div>
    </dialog>
  </>
}
