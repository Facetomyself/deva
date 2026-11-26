import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { attachmentTurnIssue, createAttachmentDrafts, readyAttachmentIds, type BrowserFiles } from './attachment-drafts'
import { createChatStream, type ChatProjection } from './chat-stream'
import { sameTurnDraft, type ChatSummary, type ChatTransport, type TurnRequest } from './chat-transport'
import { createListRefresh, sessionAfterRefresh } from './session-list'
import { createSessionPreferences, type createPreferenceTransport } from './session-preferences'
import { createSessionsStream } from './sessions-stream'
import { HttpFailure } from './transport'

type ListIssue = 'listFailure' | 'createFailure'
type TurnIssue = 'turnFailure' | 'busy' | 'modelFailure' | 'stopFailure' | 'roleUnavailable' | 'preferencesChanged' | 'effortUnavailable'
const savedSelection = 'deva-workbench.chat'
function lastSession(): string | null {
  try { return window.sessionStorage.getItem(savedSelection) } catch { return null }
}
function remember(id: string | null): void {
  try {
    if (id) window.sessionStorage.setItem(savedSelection, id)
    else window.sessionStorage.removeItem(savedSelection)
  } catch { /* storage availability does not affect selection in the current page */ }
}

export function useTextWorkbench(api: ChatTransport, beforeWrite: () => Promise<void>, onExpired: () => void, uploadsEnabled: boolean,
  preferenceApi?: ReturnType<typeof createPreferenceTransport>) {
  const [sessions, setSessions] = useState<ChatSummary[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const selectedRef = useRef<string | null>(null)
  const [listIssue, setListIssue] = useState<ListIssue>()
  const [listLoading, setListLoading] = useState(true)
  const list = useRef<ReturnType<typeof createListRefresh<ChatSummary[]>>>()
  const creating = useRef<string>()
  const [createPending, setCreatePending] = useState(false)
  const retryCreate = useRef(new Map<string, string>()).current
  const [view, setView] = useState<{ sid: string; projection: ChatProjection }>()
  const live = useRef<{ sid: string; stream: ReturnType<typeof createChatStream> }>()
  const [pending, setPending] = useState<Record<string, 'send' | 'stop'>>({})
  const operations = useRef(new Map<string, 'send' | 'stop'>())
  const drafts = useRef(new Map<string, string>()).current
  const retrySend = useRef(new Map<string, TurnRequest>()).current
  const [turnIssues, setTurnIssues] = useState<Record<string, TurnIssue | undefined>>({})
  const attachments = useMemo(() => uploadsEnabled ? createAttachmentDrafts(api, onExpired, beforeWrite) : undefined,
    [uploadsEnabled, api, beforeWrite, onExpired])

  const select = useCallback((id: string | null) => {
    if (selectedRef.current === id) return
    selectedRef.current = id
    remember(id)
    setSelected(id)
  }, [])
  const managed = !!preferenceApi
  const refreshList = useCallback(() => list.current?.request(), [])
  const preferences = useMemo(() => preferenceApi && createSessionPreferences(preferenceApi, {
    beforeWrite,
    expired: onExpired,
    committed(sid, { title, model, archived, customTitle }) {
      setSessions((rows) => rows.map((row) => row.id === sid ? { ...row, title, model, archived, customTitle: customTitle ?? undefined } : row))
      list.current?.afterWrite()
    },
    blocked(sid, issue) {
      if (issue === 'busy' || issue === 'storage' || issue === 'readOnly' || issue === 'missing') {
        if (live.current?.sid === sid) void live.current.stream.refresh()
      }
      refreshList()
    }
  }), [preferenceApi, beforeWrite, onExpired, refreshList])
  useEffect(() => {
    const refresh = createListRefresh(api.list, (next) => {
      setSessions(next)
      setListIssue((current) => current === 'createFailure' ? current : undefined)
      select(sessionAfterRefresh(next, selectedRef.current, lastSession(), managed))
      setListLoading(false)
    }, (error) => {
      if (error instanceof HttpFailure && error.status === 401) onExpired()
      else setListIssue('listFailure')
      setListLoading(false)
    })
    list.current = refresh
    const link = managed ? createSessionsStream({ origin: window.location.origin, invalidate: refresh.request, expired: onExpired }) : undefined
    if (!link) refresh.request()
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') refresh.request() }, 20000)
    window.addEventListener('focus', refresh.request)
    return () => { link?.close(); refresh.close(); list.current = undefined; window.clearInterval(timer); window.removeEventListener('focus', refresh.request) }
  }, [api, managed, onExpired, select])
  useEffect(() => {
    if (!selected) return
    const sid = selected
    const stream = createChatStream({ sid, origin: window.location.origin, read: api.read, onChange: (projection) => {
      if (selectedRef.current !== sid) return
      if (projection.status === 'expired') { onExpired(); return }
      setView({ sid, projection })
      const state = projection.snapshot?.state
      if (!managed && state) setSessions((list) => {
        const previous = list.find((entry) => entry.id === sid)
        if (!previous) return list
        const { title, writable, model, personaId = previous.personaId, updatedAt = previous.updatedAt } = state
        if (previous.title === title && previous.writable === writable && previous.model === model && previous.personaId === personaId && previous.updatedAt === updatedAt) return list
        return list.map((entry) => entry === previous ? { ...entry, title, writable, model, personaId, updatedAt } : entry)
      })
    } })
    live.current = { sid, stream }
    return () => { stream.close(); if (live.current?.stream === stream) live.current = undefined }
  }, [api, managed, onExpired, selected])

  const current = (sid: string): ReturnType<typeof createChatStream> | undefined => live.current?.sid === sid ? live.current.stream : undefined
  async function create(personaId?: string): Promise<boolean> {
    if (creating.current) return false
    const scope = personaId ?? ''
    const id = retryCreate.get(scope) ?? crypto.randomUUID()
    creating.current = id
    retryCreate.set(scope, id)
    setCreatePending(true)
    setListIssue(undefined)
    try {
      await beforeWrite()
      const session = await api.create(id, personaId)
      retryCreate.delete(scope)
      setSessions((list) => [session, ...list.filter((s) => s.id !== id)])
      select(id)
      list.current?.afterWrite()
      return true
    } catch (e) {
      if (e instanceof HttpFailure && e.status < 500 && e.status !== 408) retryCreate.delete(scope)
      if (e instanceof HttpFailure && e.status === 401) onExpired()
      else if (!personaId) setListIssue('createFailure')
      return false
    } finally {
      creating.current = undefined
      setCreatePending(false)
    }
  }
  function begin(sid: string, kind: 'send' | 'stop'): boolean {
    if (selectedRef.current !== sid || operations.current.has(sid)) return false
    operations.current.set(sid, kind)
    setPending(Object.fromEntries(operations.current))
    setTurnIssues((issues) => ({ ...issues, [sid]: undefined }))
    return true
  }
  function end(sid: string): void {
    operations.current.delete(sid)
    setPending(Object.fromEntries(operations.current))
  }
  function addAttachments(sid: string, files: BrowserFiles, locked: boolean): void {
    if (!attachments || selectedRef.current !== sid || (!files.files.length && !files.issues.length)) return
    const projection = current(sid)?.current()
    if (locked || projection?.status !== 'ready' || !projection.snapshot?.state.writable || projection.snapshot.state.active || operations.current.has(sid)) {
      attachments.warn(sid, { code: 'unavailable' })
      return
    }
    attachments.add(sid, files)
  }
  async function send(sid: string, text: string, model: string | null): Promise<boolean> {
    const projection = current(sid)?.current()
    if (projection?.status !== 'ready' || !projection.snapshot?.state.writable || projection.snapshot.state.active) return false
    const preference = preferences?.get(sid)
    if (preference && (preference.pending || preference.reading || preference.needsRead || preference.confirmed?.preferences.model !== model)) return false
    const ids = attachments ? readyAttachmentIds(attachments.get(sid)) : []
    if (!ids || (!text && !ids.length) || !begin(sid, 'send')) return false
    const previous = retrySend.get(sid)
    const draft = { text, model, ...(ids.length ? { attachments: ids } : {}) }
    const request = previous && sameTurnDraft(previous, draft) ? previous : { clientRequestId: crypto.randomUUID(), ...draft }
    try {
      await beforeWrite()
      retrySend.set(sid, request)
      const ack = await api.send(sid, request)
      retrySend.delete(sid)
      if (ids.length) attachments?.committed(sid, ids)
      if (drafts.get(sid)?.trim() === text) drafts.delete(sid)
      const stream = current(sid)
      const state = stream?.current().snapshot?.state
      if (state?.active?.turnId !== ack.turnId && state?.lastTurn?.turnId !== ack.turnId) void stream?.refresh()
      return true
    } catch (e) {
      if (e instanceof HttpFailure && e.status === 401) onExpired()
      else {
        const code = e instanceof HttpFailure ? e.code : undefined
        const issue = code === 'role_unavailable' ? 'roleUnavailable' : code === 'turn_in_progress' ? 'busy' : code === 'session_model_changed' ? 'preferencesChanged'
          : code === 'effort_unsupported' ? 'effortUnavailable'
            : ['provider_not_found', 'not_chat_provider', 'model_not_enabled', 'chat_model_unavailable'].includes(code ?? '') ? 'modelFailure' : 'turnFailure'
        if (e instanceof HttpFailure && e.status < 500 && e.status !== 408) retrySend.delete(sid)
        if (issue === 'preferencesChanged') { void preferences?.read(sid); refreshList() }
        const uploadIssue = ids.length ? attachmentTurnIssue(e) : undefined
        if (uploadIssue) attachments?.reportTurn(sid, ids, uploadIssue)
        else setTurnIssues((issues) => ({ ...issues, [sid]: issue }))
        const stream = current(sid)
        if (stream?.current().status === 'ready') void stream.refresh()
      }
      return false
    } finally { end(sid) }
  }
  async function stop(sid: string, turnId: string): Promise<void> {
    const projection = current(sid)?.current()
    if (projection?.status !== 'ready' || projection.snapshot?.state.active?.turnId !== turnId || !begin(sid, 'stop')) return
    try { await api.stop(sid, turnId) }
    catch (e) {
      if (e instanceof HttpFailure && e.status === 401) onExpired()
      else setTurnIssues((issues) => ({ ...issues, [sid]: 'stopFailure' }))
    } finally {
      const stream = current(sid)
      if (stream?.current().snapshot?.state.active?.turnId === turnId) void stream.refresh()
      end(sid)
    }
  }
  return { sessions, selected, select, projection: view?.sid === selected ? view?.projection : undefined, listIssue, listLoading,
    refreshList, preferences, create, createPending, pending: selected ? pending[selected] : undefined, drafts, attachments, addAttachments, send, stop,
    turnIssue: selected ? turnIssues[selected] : undefined }
}
