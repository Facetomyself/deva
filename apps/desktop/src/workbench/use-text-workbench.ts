import { useCallback, useEffect, useRef, useState } from 'react'
import { createChatStream, type ChatProjection } from './chat-stream'
import type { ChatSummary, ChatTransport, TurnRequest } from './chat-transport'
import { HttpFailure } from './transport'

type ListIssue = 'listFailure' | 'createFailure'
type TurnIssue = 'turnFailure' | 'busy' | 'modelFailure' | 'stopFailure' | 'roleUnavailable'
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

export function useTextWorkbench(api: ChatTransport, beforeWrite: () => Promise<void>, onExpired: () => void) {
  const [sessions, setSessions] = useState<ChatSummary[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const selectedRef = useRef<string | null>(null)
  const [listIssue, setListIssue] = useState<ListIssue>()
  const [listLoading, setListLoading] = useState(true)
  const listRevision = useRef(0)
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

  const select = useCallback((id: string | null) => {
    if (selectedRef.current === id) return
    selectedRef.current = id
    remember(id)
    setSelected(id)
  }, [])
  const refreshList = useCallback(async () => {
    const revision = ++listRevision.current
    try {
      const next = await api.list()
      if (listRevision.current !== revision) return
      setSessions(next)
      setListIssue((current) => current === 'createFailure' ? current : undefined)
      const id = selectedRef.current ?? lastSession()
      if (!id || !next.some((s) => s.id === id)) select(next[0]?.id ?? null)
      else select(id)
    } catch (e) {
      if (listRevision.current !== revision) return
      if (e instanceof HttpFailure && e.status === 401) onExpired()
      else setListIssue('listFailure')
    } finally {
      if (listRevision.current === revision) setListLoading(false)
    }
  }, [api, onExpired, select])
  useEffect(() => {
    void refreshList()
    const onFocus = (): void => { void refreshList() }
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') onFocus() }, 20000)
    window.addEventListener('focus', onFocus)
    return () => { ++listRevision.current; window.clearInterval(timer); window.removeEventListener('focus', onFocus) }
  }, [refreshList])
  useEffect(() => {
    if (!selected) return
    const sid = selected
    const stream = createChatStream({ sid, origin: window.location.origin, read: api.read, onChange: (projection) => {
      if (selectedRef.current !== sid) return
      if (projection.status === 'expired') { onExpired(); return }
      setView({ sid, projection })
      const state = projection.snapshot?.state
      if (state) setSessions((list) => {
        const previous = list.find((entry) => entry.id === sid)
        if (!previous) return list
        const { title, writable, model, personaId = previous.personaId, updatedAt = previous.updatedAt } = state
        if (previous.title === title && previous.writable === writable && previous.model === model && previous.personaId === personaId && previous.updatedAt === updatedAt) return list
        return list.map((entry) => entry === previous ? { ...entry, title, writable, model, personaId, updatedAt } : entry)
      })
    } })
    live.current = { sid, stream }
    return () => { stream.close(); if (live.current?.stream === stream) live.current = undefined }
  }, [api, onExpired, selected])

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
      ++listRevision.current
      setSessions((list) => [session, ...list.filter((s) => s.id !== id)])
      select(id)
      void refreshList()
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
  async function send(sid: string, text: string, model: string): Promise<boolean> {
    const projection = current(sid)?.current()
    if (projection?.status !== 'ready' || !projection.snapshot?.state.writable || projection.snapshot.state.active || !begin(sid, 'send')) return false
    const previous = retrySend.get(sid)
    const request = previous?.text === text && previous.model === model ? previous : { clientRequestId: crypto.randomUUID(), text, model }
    try {
      await beforeWrite()
      retrySend.set(sid, request)
      const ack = await api.send(sid, request)
      retrySend.delete(sid)
      if (drafts.get(sid)?.trim() === text) drafts.delete(sid)
      const stream = current(sid)
      const state = stream?.current().snapshot?.state
      if (state?.active?.turnId !== ack.turnId && state?.lastTurn?.turnId !== ack.turnId) void stream?.refresh()
      return true
    } catch (e) {
      if (e instanceof HttpFailure && e.status === 401) onExpired()
      else {
        const code = e instanceof HttpFailure ? e.code : undefined
        const issue = code === 'role_unavailable' ? 'roleUnavailable' : code === 'turn_in_progress' ? 'busy' : ['provider_not_found', 'not_chat_provider', 'model_not_enabled', 'chat_model_unavailable'].includes(code ?? '') ? 'modelFailure' : 'turnFailure'
        if (e instanceof HttpFailure && e.status < 500 && e.status !== 408) retrySend.delete(sid)
        setTurnIssues((issues) => ({ ...issues, [sid]: issue }))
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
    refreshList, create, createPending, pending: selected ? pending[selected] : undefined, drafts, send, stop,
    turnIssue: selected ? turnIssues[selected] : undefined }
}
