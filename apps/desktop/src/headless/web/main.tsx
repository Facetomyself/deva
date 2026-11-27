import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { ComposerAction } from '../../renderer/src/redesign/ComposerAction'
import { normalizeSessionTitle } from '../../shared/session-title'
import type { TextAttachment } from '../text-file'
import { SessionButton, TitleEditor, type TitleEdit } from './session-organizer'
import { attachmentIssue, TextAttachmentCard } from './text-attachment'
import { readTextAttachment } from './read-text-file'
import '../../renderer/src/styles/tokens.css'
import '../../renderer/src/redesign/redesign.css'
import './web.css'

type Row = { id: string; title: string; archived?: true }
type Message = { role: 'user'; text: string; attachment?: TextAttachment } | { role: 'assistant'; text: string }
type View = Row & { messages: Message[]; revision: number; active: string | null }
type Index = { sessions: Row[]; model: string }
type Mutation = 'title' | 'archive' | 'restore'
type DraftFile = { key: number; name: string; size: number; attachment?: TextAttachment }
type Scope = {
  id?: string; read: number; reading?: boolean; observed?: View; ready?: boolean
  sending?: boolean; stopping?: boolean; writing?: Mutation; file?: DraftFile
}
type Preview = { id: string; messages: Message[]; reply: string }
type Get = <T>(url: string, body?: object) => Promise<T>

const chinese = /^zh\b/i.test(navigator.language)
const t = (en: string, zh: string) => chinese ? zh : en
const sessionsPath = '/api/sessions'
const path = (id: string) => `${sessionsPath}/${encodeURIComponent(id)}`
const selectedKey = 'deva.selected-session'
const encoder = new TextEncoder()
const maxMessageBytes = 8 * 1024 // Headless service text limit, measured after trimming.
function selection(id?: string | null) {
  try {
    if (id === undefined) return sessionStorage.getItem(selectedKey)
    if (id) sessionStorage.setItem(selectedKey, id)
    else sessionStorage.removeItem(selectedKey)
  } catch { /* Storage is optional. */ }
  return null
}
class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
async function request(url: string, body?: object, signal?: AbortSignal) {
  const res = await fetch(url, {
    signal, cache: 'no-store', credentials: 'same-origin', redirect: 'error',
    ...(body && { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  })
  if (!res.ok) {
    const error = (await res.json().catch(() => null))?.error
    throw new HttpError(res.status, typeof error === 'string' ? error : `HTTP ${res.status}`)
  }
  return res
}
const expired = (error: unknown) => error instanceof HttpError && error.status === 401
const missing = (error: unknown) => error instanceof HttpError && error.status === 404
// These endpoint responses reject the turn before streaming; timeouts and other delivery errors are ambiguous.
const rejectedTurn = (error: unknown) => error instanceof HttpError && [400, 403, 404, 409, 413].includes(error.status)
const conflict = (error: unknown, code: 'stale' | 'busy') => error instanceof HttpError && error.status === 409 && error.message === code
function reason(error: unknown) {
  if (missing(error)) return t('This session is no longer available.', '此会话已不可用。')
  if (conflict(error, 'stale')) return t('This session changed. Review the latest version before trying again.', '此会话已更新。请查看最新版本后再重试。')
  if (conflict(error, 'busy')) return t('A reply is already running or the server is busy.', '回复正在进行，或服务器正忙。')
  if (error instanceof HttpError && error.status === 403) return t('This request was denied. Check your sign-in.', '请求未获准，请检查登录状态。')
  if (error instanceof HttpError && error.status === 413) return t('This request exceeds a server limit.', '请求超出服务器限制。')
  return t('Connection or response error.', '连接或响应异常。')
}
async function readTurn(res: Response, delta: (text: string) => void) {
  const reader = res.headers.get('content-type')?.startsWith('application/x-ndjson') && res.body?.getReader()
  if (reader) {
    const decoder = new TextDecoder()
    let tail = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        const lines = (tail + decoder.decode(value, { stream: !done })).split('\n')
        tail = done ? '' : lines.pop()!
        for (const line of lines) {
          if (!line.trim()) continue
          const event = JSON.parse(line)
          if (event?.type === 'delta' && typeof event.text === 'string') delta(event.text)
          else if (event?.type === 'done' && (event.reason === 'complete' || event.reason === 'stopped')) return event.reason
          else if (event?.type === 'error' && typeof event.error === 'string') throw new HttpError(200, event.error)
          else throw new Error('Invalid NDJSON event')
        }
        if (done) break
      }
    } finally { void reader.cancel().catch(() => {}) }
  }
  throw new Error('Missing terminal event')
}
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-')
}

function App() {
  const [index, setIndex] = useState<Index | null>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const busy = useRef(false)
  async function open(token?: string) {
    if (busy.current) return
    busy.current = true
    setLoading(true)
    setError('')
    try {
      if (token !== undefined) {
        await request('/api/login', { token })
        token = undefined
        setIndex(undefined)
      }
      setIndex(await (await request(sessionsPath)).json())
    } catch (cause) {
      if (expired(cause)) setIndex(null)
      if (token !== undefined) setError(t('Sign-in failed. Check the token and try again.', '登录失败，请核对令牌后重试。'))
      else if (!expired(cause)) setError(reason(cause))
    } finally { busy.current = false; setLoading(false) }
  }
  useEffect(() => { void open() }, [])
  if (index) return <Chat initial={index} signOut={(didExpire) => {
    setError(didExpire ? t('Your sign-in expired. Sign in again.', '登录已过期，请重新登录。') : '')
    setIndex(null)
  }} />
  function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const token = String(new FormData(form).get('token') ?? '')
    form.reset()
    if (token) void open(token)
  }
  return <main className="web-login"><h1>Deva</h1>
    {index === null ? <form onSubmit={login}>
      <label htmlFor="token">{t('Access token', '访问令牌')}</label>
      <input id="token" name="token" type="password" autoComplete="off" required data-testid="login-token" />
      <ComposerAction type="submit" label={loading ? t('Signing in…', '登录中…') : t('Sign in', '登录')} disabled={loading} data-testid="login" />
    </form> : loading ? <p role="status">{t('Loading…', '载入中…')}</p> :
      <button className="web-secondary" onClick={() => void open()}>{t('Retry', '重试')}</button>}
    {error && <p role="alert">{error}</p>}
  </main>
}

function withObserved(sessions: Row[], id: string, row?: Row) {
  if (!row) return sessions.filter((v) => v.id !== id)
  return sessions.some((v) => v.id === id) ? sessions.map((v) => v.id === id ? row : v) : [row, ...sessions]
}

function useLibrary(initial: Index, get: Get, signal: AbortSignal, expire: () => void) {
  const [index, setIndex] = useState(initial)
  const [archived, setArchived] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const lane = useRef<{ archived: boolean; serial: number; observations?: Map<string, Row | undefined> }>({ archived: false, serial: 0 })
  async function reload() {
    const expected = lane.current
    const ticket = ++expected.serial
    const observations = expected.observations = new Map<string, Row | undefined>()
    const current = () => lane.current === expected && ticket === expected.serial && !signal.aborted
    setLoading(true); setError('')
    try {
      const next = await get<Index>(expected.archived ? `${sessionsPath}/archived` : sessionsPath)
      if (current()) {
        // A delayed list snapshot must not undo details accepted while it was in flight.
        for (const [id, row] of observations) next.sessions = withObserved(next.sessions, id, row)
        setIndex(next)
      }
    } catch (error) {
      if (expired(error)) expire()
      else if (current()) setError(t('Could not load sessions.', '会话列表加载失败。'))
    } finally {
      if (current()) { expected.observations = undefined; setLoading(false) }
    }
  }
  function toggle() {
    const next = !lane.current.archived
    lane.current = { archived: next, serial: 0 }
    setArchived(next)
    setIndex((prev) => ({ ...prev, sessions: [] }))
    void reload()
  }
  function observe(id: string, row?: Row) {
    const visible = row && !!row.archived === lane.current.archived ? row : undefined
    lane.current.observations?.set(id, visible)
    setIndex((prev) => ({ ...prev, sessions: withObserved(prev.sessions, id, visible) }))
  }
  return { index, archived, loading, error, reload, toggle, observe }
}

function Chat({ initial, signOut }: { initial: Index; signOut: (didExpire: boolean) => void }) {
  const [view, setView] = useState<View | null>(null)
  const [draft, setDraft] = useState('')
  const [file, setFile] = useState<DraftFile>()
  const [fileError, setFileError] = useState('')
  const [notice, setNotice] = useState('')
  const [readError, setReadError] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [working, setWorking] = useState(false)
  const [reading, setReading] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [writing, setWriting] = useState<Mutation>()
  const [reviewing, setReviewing] = useState(false)
  const [edit, setEdit] = useState<TitleEdit>()
  const edits = useRef(new Map<string, TitleEdit>())
  const [navigation, setNavigation] = useState<'new' | 'logout' | ''>('')
  const nav = useRef(false)
  const scope = useRef<Scope>({ read: 0 })
  const [life] = useState(() => new AbortController())
  const scroll = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const attachButton = useRef<HTMLButtonElement>(null)
  const fileKey = useRef(0)
  const scopeToggle = useRef<HTMLButtonElement>(null)
  const rename = useRef<HTMLButtonElement>(null)
  const returnTitleFocus = useRef(false)
  const follow = useRef(true)
  const current = (s: Scope) => scope.current === s && !life.signal.aborted
  const get: Get = async (url, body) => (await request(url, body, life.signal)).json()
  function leave(didExpire: boolean) {
    if (life.signal.aborted) return
    life.abort()
    selection(null)
    signOut(didExpire)
  }
  const library = useLibrary(initial, get, life.signal, () => leave(true))
  const { index, archived } = library

  function setDraftFile(s: Scope, next?: DraftFile) {
    s.file = next
    setFile(next); setFileError('')
  }
  function clearComposer(s: Scope) {
    setDraft('')
    setDraftFile(s)
  }
  function saved(s: Scope, next: View) {
    if (next.archived && !s.observed?.archived) clearComposer(s)
    s.id = next.id
    s.observed = next
    s.ready = true
    selection(next.archived ? null : next.id)
    setReadError('')
    setView(next)
    library.observe(next.id, { id: next.id, title: next.title, archived: next.archived })
  }
  async function sync(s: Scope): Promise<View | undefined> {
    if (!s.id || !current(s)) return undefined
    const id = s.id
    const serial = ++s.read
    const latest = () => current(s) && s.read === serial
    s.reading = true
    setReading(true)
    try {
      const next = await get<View>(path(id))
      if (!latest()) return undefined
      if (!s.observed || next.revision >= s.observed.revision) saved(s, next)
      return s.observed
    } catch (error) {
      if (expired(error)) leave(true)
      else if (latest()) {
        s.ready = false
        setReadError(reason(error))
        if (missing(error)) {
          clearComposer(s)
          setView(null); s.observed = undefined; selection(null); library.observe(id)
        }
      }
    } finally {
      if (latest()) { s.reading = false; setReading(false) }
    }
    return undefined
  }
  async function refresh(s: Scope) {
    const next = await sync(s)
    if (current(s)) void library.reload()
    return current(s) ? next : undefined
  }
  function select(id?: string) {
    const s = scope.current = { id, read: 0 }
    selection(archived ? null : id ?? null)
    follow.current = true
    returnTitleFocus.current = false
    clearComposer(s)
    setView(null); setNotice(''); setReadError(''); setPreview(null)
    setWorking(false); setReading(false); setStopping(false); setWriting(undefined); setReviewing(false)
    setEdit(id && !archived ? edits.current.get(id) : undefined)
    if (id) void sync(s)
    return s
  }
  useEffect(() => {
    const id = selection()
    if (initial.sessions.some((row) => row.id === id)) select(id!)
    return () => life.abort()
  }, [])
  useLayoutEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [view?.id, view?.messages.length, preview])
  useLayoutEffect(() => {
    if (edit || writing || reading || !returnTitleFocus.current) return
    returnTitleFocus.current = false
    if (document.activeElement === document.body) {
      (rename.current && !rename.current.disabled ? rename.current : scopeToggle.current)?.focus()
    }
  }, [edit, writing, reading])

  async function navigate(kind: 'new' | 'logout') {
    if (nav.current) return
    nav.current = true
    setNavigation(kind)
    const s = scope.current
    setNotice('')
    try {
      if (kind === 'logout') { await get('/api/logout', {}); leave(false) }
      else {
        const next = await get<View>(sessionsPath, {})
        if (current(s)) { saved(select(), next); void library.reload() }
      }
    } catch (error) {
      if (expired(error)) leave(true)
      else if (current(s)) { setNotice(reason(error)); if (kind === 'new') void library.reload() }
    } finally { nav.current = false; if (!life.signal.aborted) setNavigation('') }
  }
  function updateEdit(s: Scope, next?: TitleEdit) {
    if (!s.id || !current(s)) return
    if (next) edits.current.set(s.id, next)
    else { edits.current.delete(s.id); returnTitleFocus.current = true }
    setEdit(next)
  }
  function startTitle() {
    const s = scope.current
    if (!s.observed || s.observed.archived || archived || s.writing || s.reading || !s.ready || nav.current) return
    updateEdit(s, { draft: s.observed.title, revision: s.observed.revision })
  }
  async function reviewTitle() {
    const s = scope.current
    if (!edit || edit.revision !== null || s.writing || s.reading || nav.current || archived || s.observed?.archived) return
    setReviewing(true)
    const seenTitle = view?.title
    const next = await refresh(s)
    if (!current(s)) return
    setReviewing(false)
    const latestEdit = s.id ? edits.current.get(s.id) : undefined
    if (!next || next.archived || !latestEdit) return
    if (next.title !== seenTitle) {
      updateEdit(s, { ...latestEdit, issue: t('The title changed again. Review the current title before saving.', '标题再次变更。请查看当前标题后再保存。') })
      return
    }
    updateEdit(s, { draft: latestEdit.draft, revision: next.revision })
  }
  async function organize(action: Mutation) {
    const s = scope.current, before = s.observed
    if (!before || !s.ready || s.reading || s.writing || nav.current || !!before.archived !== archived) return
    if (action === 'title') {
      if (archived || !edit || edit.revision === null) return
      // Keep the draft reviewable if navigation interrupts receipt of the POST result.
      updateEdit(s, { ...edit, revision: null, issue: t('Check the latest title before saving again.', '再次保存前，请查看最新标题。') })
    } else if ((action === 'archive' && edit) || s.sending || s.stopping || before.active) return
    s.writing = action
    setWriting(action); setNotice('')
    const target = action === 'archive'
    const moved = () => target ? t('Session archived.', '会话已归档。') : t('Session restored to active sessions.', '会话已移回当前会话列表。')
    try {
      const next = action === 'title' && edit
        ? await get<View>(`${path(before.id)}/title`, { revision: edit.revision, title: normalizeSessionTitle(edit.draft) })
        : await get<View>(`${path(before.id)}/archive`, { revision: before.revision, archived: target })
      if (!current(s)) return
      if (s.observed === before || next.revision > (s.observed?.revision ?? -1)) saved(s, next)
      if (action === 'title') { updateEdit(s); await refresh(s) }
      else { select(); setNotice(moved()); scopeToggle.current?.focus(); void library.reload() }
    } catch (error) {
      if (expired(error)) { leave(true); return }
      if (!current(s)) return
      const next = await refresh(s)
      if (!current(s)) return
      if (action === 'title' && edit) {
        const issue = conflict(error, 'stale')
          ? t('Title save conflicted with a newer revision. Review the current title before saving your draft.', '保存标题时发现更新的版本。请查看当前标题后再保存草稿。')
          : t('Title save was not confirmed. Review the current title before saving again.', '标题保存结果未确认。请查看当前标题后再保存。')
        updateEdit(s, { ...edit, revision: null, issue })
      } else if (next && !!next.archived === target) {
        // Observed the target state (including when the ACK was lost). Never replay the write.
        select(); setNotice(moved()); scopeToggle.current?.focus()
      } else {
        setNotice(conflict(error, 'stale') || conflict(error, 'busy') ? reason(error) :
          t('Change was not confirmed. Check the session before trying again.', '操作结果未确认。请检查会话后再重试。'))
      }
    } finally {
      if (current(s)) { s.writing = undefined; setWriting(undefined) }
    }
  }

  async function chooseFile(s: Scope, chosen: File) {
    if (!current(s) || !s.ready || !s.observed || s.observed.archived || s.sending || s.writing || nav.current) return
    const pending = { key: ++fileKey.current, name: chosen.name, size: chosen.size }
    setDraftFile(s, pending)
    const result = await readTextAttachment(chosen)
    if (!current(s) || s.file !== pending) return
    if (typeof result === 'string') {
      setDraftFile(s)
      setFileError(attachmentIssue(result, t))
    } else setDraftFile(s, { ...pending, attachment: result })
  }

  const text = draft.trim(), overLimit = encoder.encode(text).length > maxMessageBytes
  async function send(s: Scope) {
    const before = s.observed, selected = s.file, attachment = selected?.attachment
    // Scope and file identity are updated synchronously, before React can repaint the composer.
    if (!current(s) || !before || before.archived || archived || !s.ready || s.sending || s.stopping || s.reading || s.writing || nav.current || before.active ||
        (selected && !attachment) || (!text && !attachment) || overLimit || !index.model) return
    s.sending = true
    clearComposer(s)
    setWorking(true); setNotice('')
    follow.current = true
    let note = '', accepted = false, restoreDraft = false
    try {
      const turnId = uuid()
      const payload = attachment ? { text, revision: before.revision, turnId, attachment } : { text, revision: before.revision, turnId }
      const res = await request(`${path(before.id)}/turns`, payload, life.signal)
      accepted = true
      if (current(s)) {
        const message: Message = attachment ? { role: 'user', text, attachment } : { role: 'user', text }
        setPreview({ id: turnId, messages: [...before.messages, message], reply: '' })
        // The accepted user turn advances the durable revision before streaming finishes.
        void sync(s)
      }
      const result = await readTurn(res, (part) => {
        if (current(s)) setPreview((prev) => prev && { ...prev, reply: prev.reply + part })
      })
      if (result === 'stopped') note = t('Reply stopped.', '回复已停止。')
    } catch (error) {
      if (expired(error)) { leave(true); return }
      restoreDraft = !accepted && rejectedTurn(error)
      note = accepted ? t('Reply interrupted. Check the saved history.', '回复中断，请查看已保存的记录。') :
        restoreDraft ? reason(error) : t('Delivery was not confirmed. Check saved history before sending again.', '发送结果未确认。请查看已保存的记录后再发送。')
    }
    if (current(s)) {
      const latest = await refresh(s)
      if (current(s)) {
        if (restoreDraft && latest?.id === before.id && !latest.archived) { setDraft(draft); setDraftFile(s, selected) }
        s.sending = false; setPreview(null); setWorking(false); if (note) setNotice(note)
      }
    }
  }
  const active = preview?.id ?? view?.active
  async function stop() {
    const s = scope.current
    if (!s.id || !active || s.stopping || nav.current) return
    s.stopping = true
    setStopping(true)
    let note = t('Stop requested.', '已请求停止。'), failed = false
    try { await get(`${path(s.id)}/stop`, { turnId: active }) }
    catch (error) {
      if (expired(error)) { leave(true); return }
      note = reason(error)
      failed = true
    }
    if (current(s)) {
      if (!s.sending || failed) await refresh(s)
      if (current(s)) { setNotice(note); s.stopping = false; setStopping(false) }
    }
  }
  const composerScope = scope.current, id = composerScope.id
  const readOnly = archived || !!view?.archived
  const metadataDisabled = reading || !!readError || !!writing || !!navigation
  const messages = preview ? [...preview.messages, ...(preview.reply ? [{ role: 'assistant', text: preview.reply } as const] : [])] : view?.messages ?? []
  return <div className="cf-shell web-chat">
    <aside className="cf-rail" aria-label={t('Sessions', '会话')}>
      <header className="cf-rail__top"><strong>Deva</strong><div className="web-header-actions">
        <button type="button" ref={scopeToggle} className="web-secondary web-archive-toggle" data-testid="archive-view" aria-pressed={archived}
          aria-controls="web-session-list" disabled={!!navigation} onClick={() => {
            if (!nav.current) { select(); library.toggle() }
          }}>{t('Archived', '已归档')}</button>
        {!archived && <SessionButton data-testid="new-session" pending={navigation === 'new'} disabled={!!navigation}
          onClick={() => void navigate('new')}>{navigation === 'new' ? t('Creating…', '新建中…') : t('+ New', '＋ 新建')}</SessionButton>}
      </div></header>
      <nav id="web-session-list" className="cf-list" aria-label={archived ? t('Archived sessions', '已归档会话') : t('Session history', '会话历史')}>
        {library.loading && <p className="web-list-state web-muted" role="status">{t('Loading sessions…', '正在载入会话…')}</p>}
        {library.error && <p className="web-list-state web-muted" role="alert">{library.error}</p>}
        {!library.loading && !library.error && !index.sessions.length && <p className="web-list-state web-muted">
          {archived ? t('No archived sessions.', '暂无已归档会话。') : t('No active sessions.', '暂无当前会话。')}
        </p>}
        {index.sessions.map((row) => <button type="button" key={row.id} className={`cf-thread${id === row.id ? ' is-active' : ''}`}
          aria-current={id === row.id || undefined} data-testid="session-row" disabled={!!navigation}
          onClick={() => { if (!nav.current && id !== row.id) select(row.id) }}>{row.title}</button>)}
      </nav>
    </aside>
    <main className="cf-conv">
      <header className="cf-conv__head">
        <div className="web-conv-top">
          <h1>{view?.title || t('Chat', '对话')}</h1>
          <div className="web-header-actions">
            {view && !readOnly && !edit && <button type="button" ref={rename} className="web-secondary" data-testid="rename-session"
              disabled={metadataDisabled} onClick={startTitle}>{t('Rename', '重命名')}</button>}
            {view && !archived && !view.archived && <SessionButton data-testid="archive-session" pending={writing === 'archive'}
              disabled={metadataDisabled || !!edit || working || stopping || !!active}
              title={working || active ? t('Wait for the reply to finish or stop it first.', '请先等待回复结束，或停止回复。') : undefined}
              onClick={() => void organize('archive')}>{writing === 'archive' ? t('Archiving…', '归档中…') : t('Archive', '归档')}</SessionButton>}
            {view?.archived && archived && <SessionButton data-testid="restore-session" pending={writing === 'restore'}
              disabled={metadataDisabled || working || stopping || !!active}
              onClick={() => void organize('restore')}>{writing === 'restore' ? t('Restoring…', '恢复中…') : t('Restore', '移回会话列表')}</SessionButton>}
            <SessionButton pending={!working && (reading || library.loading)} disabled={working || !!writing || !!navigation}
              onClick={() => { if (!nav.current) void refresh(scope.current) }}>{t('Refresh', '刷新')}</SessionButton>
            <SessionButton data-testid="logout" pending={navigation === 'logout'} disabled={!!navigation} onClick={() => void navigate('logout')}>
              {navigation === 'logout' ? t('Signing out…', '退出中…') : t('Sign out', '退出')}</SessionButton>
          </div>
        </div>
        {edit && <TitleEditor edit={edit} title={view?.title ?? t('Unavailable', '未取得')} t={t} pending={writing === 'title'} reviewing={reviewing}
          disabled={!!navigation || !!writing && writing !== 'title'} readOnly={readOnly} saveDisabled={metadataDisabled || !view}
          change={(typed) => updateEdit(scope.current, { ...edit, draft: typed })} review={() => void reviewTitle()}
          save={() => void organize('title')} cancel={() => updateEdit(scope.current)} />}
      </header>
      <div className="cf-msgs" ref={scroll} onScroll={(e) => {
        const el = e.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64
      }}><div className="cf-msgs__inner">
        {view && !!view.archived !== archived && <p className="web-notice" role="status">
          {view.archived ? t('This session moved to Archived. Open it there to restore it.', '此会话已移至「已归档」。请到那里打开并恢复。') :
            t('This session moved to active sessions. Open it there to continue.', '此会话已移回当前会话。请到那里打开并继续。')}
        </p>}
        {!messages.length && !readError && <p className="web-muted">{reading ? t('Loading…', '载入中…') : view ?
          readOnly ? t('No messages.', '暂无消息。') : t('Send a message to begin.', '发送消息以开始对话。') : !id ?
            archived ? t('Select an archived session to view or restore it.', '选择已归档会话查看或恢复。') :
              t('Select a session or create a new one.', '选择会话或新建会话。') : ''}</p>}
        {messages.map((message, n) => <article className={`cf-msg${message.role === 'user' ? ' is-user' : ''}`} data-testid="message" data-role={message.role} key={`${id}:${n}`}>
          <div className="cf-msg__body"><div className="cf-msg__head"><span className="cf-msg__name">{message.role === 'user' ? t('You', '你') : 'Deva'}</span></div>
            {message.role === 'user' && message.attachment && <div className="cf-sent">
              <TextAttachmentCard name={message.attachment.name} text={message.attachment.text} t={t} />
            </div>}
            {(message.text || message.role !== 'user' || !message.attachment) && <div className="cf-msg__text">{message.text}</div>}</div></article>)}
      </div></div>
      <div className="cf-composer"><div className="cf-composer__inner">
        {readError && <p className="web-notice" role="alert">{readError}</p>}
        {notice && <p className="web-notice" role="status">{notice}</p>}
        {view?.archived && archived && <p className="web-notice">{t('Restore this session to send a message.', '恢复此会话后可发送消息。')}</p>}
        {!readOnly && (view || preview) && <form key={id} className="cf-box" onSubmit={(e) => { e.preventDefault(); void send(composerScope) }}>
          {file && <TextAttachmentCard key={file.key} name={file.name} size={file.size} text={file.attachment?.text} t={t} onRemove={() => {
            if (current(composerScope) && composerScope.file?.key === file.key) { setDraftFile(composerScope); attachButton.current?.focus() }
          }} />}
          {fileError && <p className="web-attachment-error" role="alert" data-testid="attachment-error">{fileError}</p>}
          <textarea aria-label={t('Message', '消息')} placeholder={t('Message Deva', '给 Deva 发消息')} data-testid="composer" value={draft}
            readOnly={working || !!navigation} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); void send(composerScope) }
            }} />
          <div className="cf-box__bar">
            <input ref={fileInput} hidden type="file" accept=".txt,.md" data-testid="attachment-input" onChange={(e) => {
              const chosen = e.currentTarget.files?.[0]
              e.currentTarget.value = ''
              if (chosen) void chooseFile(composerScope, chosen)
            }} />
            <button ref={attachButton} type="button" className="web-secondary" data-testid="attach-file"
              disabled={working || metadataDisabled} onClick={() => fileInput.current?.click()}>{t('Attach file', '添加文件')}</button>
            <span className="web-muted web-composer-model">{active || working ? t('Reply in progress…', '正在回复…') :
              overLimit ? t('Message exceeds 8 KiB.', '消息超过 8 KiB。') : index.model || t('No model configured on the server.', '服务端尚未配置模型。')}</span>
            {active ? <ComposerAction stop label={t('Stop', '停止')} data-testid="stop" disabled={stopping || !!navigation} onClick={() => void stop()} /> :
              <ComposerAction type="submit" label={t('Send', '发送')} data-testid="send"
                disabled={working || stopping || metadataDisabled || (file ? !file.attachment : !text) || overLimit || !index.model} />}</div>
        </form>}
      </div></div>
    </main>
  </div>
}

const theme = matchMedia('(prefers-color-scheme: dark)')
const applyTheme = () => { document.documentElement.dataset.theme = theme.matches ? 'dark' : 'light' }
document.documentElement.lang = chinese ? 'zh-CN' : 'en'
applyTheme()
theme.addEventListener('change', applyTheme)
createRoot(document.getElementById('root')!).render(<App />)
