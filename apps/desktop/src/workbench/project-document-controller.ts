import { HttpFailure } from './transport'
import { parentOf, writableDocumentFolders, type WorkspaceFiles } from './workspace-files'
import { documentDirectory, documentPath, documentValidation, InvalidDocumentReceipt, projectDocumentWorkspaceId, type DocumentIssue,
  type PreparedDocument, type ProjectDocumentTransport } from './project-document-transport'

type Issue = DocumentIssue | 'notCreated'
type Phase = 'draft' | 'preparing' | 'prepared' | 'creating' | 'verifying' | 'unconfirmed' | 'saved'
type Draft = Readonly<{ wid: string; directory: string; name: string; content: string; issue?: Issue; uncertainPath?: string }>
type Intent = PreparedDocument & { wid: string; expires: number }
type FocusTarget = 'name' | 'status' | 'return'
export type ProjectDocumentView = {
  draft?: Draft; phase?: Phase; issue?: Issue; preview?: string; savedPath?: string;
  folders: string[]; canNew: boolean; retained: boolean; canReview: boolean; canCreate: boolean; canVerify: boolean; editable: boolean;
  focus?: { target: FocusTarget; serial: number }
}
const emptyView: ProjectDocumentView = { folders: [], canNew: false, retained: false, canReview: false, canCreate: false, canVerify: false, editable: false }

function issueFor(error: unknown, writing = false): Issue {
  if (!(error instanceof HttpFailure)) return writing ? 'unconfirmed' : 'unavailable'
  if (error.status === 401 || error.code === 'csrf_failed') return 'expired'
  switch (error.status) {
    case 400: return 'invalid'
    case 403: return error.code === 'document_unsafe' ? 'restricted' : 'readonly'
    case 404: return 'missing'
    case 409: return error.code === 'document_exists' ? 'exists' : error.code === 'document_changed' ? 'changed' : 'conflict'
    case 413: return 'limit'
    case 422: return 'restricted'
    case 429: return 'busy'
    case 503: return writing ? 'unconfirmed' : 'unavailable'
    default: return writing ? 'unconfirmed' : 'unavailable'
  }
}

/** Page-memory draft per authorized project. An intent, by contrast, lives only within its current review. */
export function createProjectDocuments(files: WorkspaceFiles, api: ProjectDocumentTransport, now = Date.now) {
  const listeners = new Set<() => void>()
  const kept = new Map<string, Draft>()
  let open = false
  let unsubscribe: (() => void) | undefined
  let phase: Phase | undefined
  let draft: Draft | undefined
  let intent: Intent | undefined
  let saved: { wid: string; path: string } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let focus: ProjectDocumentView['focus']
  let folderCheck: AbortController | undefined
  let serial = 0
  let view = emptyView

  function folders(): string[] {
    const workspace = files.snapshot()
    return projectDocumentWorkspaceId(workspace.projectId) ? writableDocumentFolders(workspace).filter(documentDirectory) : []
  }
  function validTarget(value: Draft): boolean {
    return files.snapshot().projectId === value.wid && folders().includes(value.directory)
  }
  function defaultFolder(): string {
    const { file, folder } = files.snapshot()
    return folder ?? (file ? parentOf(file.path) : '')
  }
  function emit(): void {
    const workspace = files.snapshot()
    const choices = folders()
    const current = open && !!draft && workspace.projectId === draft.wid
    const scoped = current && choices.includes(draft!.directory)
    const path = current && documentDirectory(draft!.directory) && !documentValidation(draft!.name, '') ?
      documentPath(draft!.directory, draft!.name) : undefined
    const validation = current && draft!.name ? documentValidation(draft!.name, draft!.content) : undefined
    const blocked = phase === 'draft' && !!path && workspace.blockedDocumentPaths.has(path)
    const status = saved?.wid === workspace.projectId ? saved : undefined
    view = {
      draft: current ? draft : undefined, phase: current ? phase : status ? 'saved' : undefined,
      issue: current ? workspace.issue === 'expired' ? 'expired' : draft!.issue ?? (!scoped ? 'directory' : blocked ? 'unconfirmed' : validation) : undefined,
      preview: path || undefined, savedPath: status?.path, folders: choices,
      canNew: open && !current && choices.includes(defaultFolder()), retained: kept.has(workspace.projectId),
      editable: current && !workspace.issue && (phase === 'draft' || phase === 'preparing' || phase === 'prepared'),
      canReview: scoped && phase === 'draft' && !!path && !blocked && draft!.uncertainPath !== path && !validation,
      canCreate: scoped && phase === 'prepared' && !!intent && intent.path === path && intent.expires > now(),
      canVerify: current && !workspace.issue && !!intent && phase === 'unconfirmed', focus
    }
    listeners.forEach((notify) => notify())
  }
  function requestFocus(target: FocusTarget): void { focus = { target, serial: ++serial } }
  function keep(next: Draft): void { kept.set(next.wid, next); draft = next }
  function release(wid: string, id: string): void { void api.cancel(wid, id).catch(() => {}) }
  function detachIntent(): Intent | undefined {
    clearTimeout(timer)
    timer = undefined
    const previous = intent
    intent = undefined
    return previous
  }
  function backToDraft(issue?: Issue, unconfirmed = false): void {
    const previous = detachIntent()
    if (!draft) return
    keep({ ...draft, issue, ...(unconfirmed && previous ? { uncertainPath: previous.path } : {}) })
    phase = unconfirmed ? 'unconfirmed' : 'draft'
    if (previous) {
      if (!unconfirmed) files.blockDocumentPath(previous.wid, previous.path, false)
      release(previous.wid, previous.id)
    }
    emit()
  }
  function dismiss(returnFocus = false): void {
    folderCheck?.abort()
    folderCheck = undefined
    if (!returnFocus) focus = undefined
    const old = draft
    const previous = detachIntent()
    const uncertain = previous && (phase === 'creating' || phase === 'verifying' || phase === 'unconfirmed') ? previous.path : undefined
    if (old) {
      if (old.name || old.content || old.uncertainPath) kept.set(old.wid, {
        ...old, issue: uncertain ? 'unconfirmed' : old.issue, uncertainPath: uncertain ?? old.uncertainPath
      })
      else kept.delete(old.wid)
      draft = undefined
      phase = undefined
    }
    saved = undefined
    if (returnFocus) {
      requestFocus('return')
      // An explicit Cancel leaves ordinary browsing available while the kept draft still fences that create target.
      if (old?.uncertainPath) files.blockDocumentPath(old.wid, old.uncertainPath, false)
      if (previous && uncertain) files.blockDocumentPath(previous.wid, uncertain, false)
    }
    if (previous) release(previous.wid, previous.id)
    emit()
  }
  function workspaceChanged(): void {
    const workspace = files.snapshot()
    if (saved && (saved.wid !== workspace.projectId || saved.path !== workspace.file?.path || !workspace.file.saved)) saved = undefined
    if (draft && draft.wid !== workspace.projectId) { dismiss(); return }
    if (draft && workspace.issue && (intent || phase === 'preparing')) {
      backToDraft(workspace.issue === 'expired' ? 'expired' : 'missing',
        phase === 'creating' || phase === 'verifying' || phase === 'unconfirmed')
      return
    }
    if (draft && (phase === 'preparing' || phase === 'prepared') && !validTarget(draft)) {
      backToDraft('directory')
      return
    }
    emit()
  }
  function setOpen(enabled: boolean): void {
    if (open === enabled) return
    open = enabled
    if (enabled) { unsubscribe = files.subscribe(workspaceChanged); emit() }
    else { unsubscribe?.(); unsubscribe = undefined; dismiss() }
  }
  function begin(): void {
    if (!view.canNew) return
    const wid = files.snapshot().projectId
    draft = kept.get(wid) ?? { wid, directory: defaultFolder(), name: '', content: '' }
    saved = undefined
    phase = 'draft'
    requestFocus('name')
    emit()
  }
  function update(patch: Partial<Pick<Draft, 'directory' | 'name' | 'content'>>): void {
    if (!draft || !view.editable || (patch.directory !== undefined && !folders().includes(patch.directory))) return
    const candidate = { ...draft, ...patch }
    if (candidate.directory === draft.directory && candidate.name === draft.name && candidate.content === draft.content) return
    const target = documentPath(candidate.directory, candidate.name)
    const previous = detachIntent()
    keep({ ...candidate, issue: target === candidate.uncertainPath ? 'unconfirmed' : undefined })
    phase = 'draft'
    if (candidate.uncertainPath && target !== candidate.uncertainPath)
      files.blockDocumentPath(candidate.wid, candidate.uncertainPath, false)
    if (previous) release(previous.wid, previous.id)
    emit()
  }
  function expire(review: Intent): void {
    if (phase === 'prepared' && intent === review) backToDraft('missing')
  }
  async function prepare(): Promise<void> {
    if (!draft || !view.canReview || !validTarget(draft)) return
    const original = draft
    const started = now()
    phase = 'preparing'
    emit()
    try {
      const result = await api.prepare(original.wid, original.directory, original.name)
      if (draft !== original || phase !== 'preparing' || !open || !validTarget(original)) { release(original.wid, result.id); return }
      const next = { ...result, wid: original.wid, expires: started + result.ttlMs }
      if (next.expires <= now()) { release(original.wid, next.id); backToDraft('missing'); return }
      intent = next
      phase = 'prepared'
      keep({ ...original, issue: undefined })
      timer = setTimeout(() => expire(next), next.expires - now())
      requestFocus('status')
      emit()
    } catch (error) {
      if (error instanceof InvalidDocumentReceipt && error.id) release(original.wid, error.id)
      if (draft !== original || phase !== 'preparing') return
      requestFocus('status')
      backToDraft(issueFor(error))
      files.reportDocumentFailure(error, original.wid)
    }
  }
  const same = (target: Intent): boolean => open && intent === target && draft?.wid === target.wid &&
    files.snapshot().projectId === target.wid && !files.snapshot().issue

  async function readback(target: Intent, content: string, revision: string): Promise<void> {
    phase = 'verifying'
    emit()
    const confirmed = await files.verifyCreatedDocument(target.wid, target.path, content, revision, () => same(target))
    if (!same(target)) return
    if (!confirmed) { phase = 'unconfirmed'; keep({ ...draft!, issue: 'unconfirmed' }); emit(); return }
    detachIntent()
    release(target.wid, target.id)
    kept.delete(target.wid)
    saved = { wid: target.wid, path: target.path }
    phase = 'saved'
    draft = undefined
    emit()
  }
  function uncertain(issue: Issue): void {
    if (!draft) return
    phase = 'unconfirmed'
    keep({ ...draft, issue })
    requestFocus('status')
    emit()
  }
  async function create(): Promise<void> {
    if (!intent || !draft || phase !== 'prepared') return
    const target = intent
    if (target.expires <= now()) { expire(target); return }
    if (!view.canCreate || !validTarget(draft)) return
    const { content } = draft
    clearTimeout(timer)
    phase = 'creating'
    files.blockDocumentPath(target.wid, target.path, true)
    emit()
    let result: Awaited<ReturnType<ProjectDocumentTransport['create']>>
    try {
      result = await api.create(target.wid, target.id, target.path, content)
    } catch (error) {
      if (!same(target)) return
      const issue = issueFor(error, true)
      if (issue === 'unconfirmed') uncertain(issue)
      else {
        requestFocus('status')
        // Authorization or the intent TTL can lapse after publication but before the receipt.
        backToDraft(issue, issue === 'expired' || issue === 'missing')
      }
      files.reportDocumentFailure(error, target.wid)
      return
    }
    if (same(target)) await verifyReadback(target, content, result.revision)
  }
  async function verifyReadback(target: Intent, content: string, revision: string): Promise<void> {
    try { await readback(target, content, revision) }
    catch (error) {
      if (!same(target)) return
      uncertain(issueFor(error, true))
      files.reportDocumentFailure(error, target.wid)
    }
  }
  async function verify(): Promise<void> {
    if (!view.canVerify || !intent || !draft) return
    const target = intent
    const { content } = draft
    phase = 'verifying'
    emit()
    try {
      const status = await api.status(target.wid, target.id, target.path)
      if (!same(target)) return
      if (status.state === 'created') await verifyReadback(target, content, status.revision)
      else if (status.state === 'prepared') { backToDraft('notCreated'); requestFocus('status'); emit() }
      else uncertain('unconfirmed')
    } catch (error) {
      if (!same(target)) return
      const issue = issueFor(error, true)
      if (['expired', 'missing', 'readonly', 'restricted', 'changed', 'exists', 'conflict'].includes(issue)) backToDraft(issue, true)
      else uncertain(issue)
      files.reportDocumentFailure(error, target.wid)
    }
  }
  function checkFolder(): Promise<boolean> | undefined {
    if (!draft || !open || draft.wid !== files.snapshot().projectId) return undefined
    folderCheck?.abort()
    folderCheck = new AbortController()
    return files.revealFolder(draft.wid, draft.directory, folderCheck.signal)
  }
  return { snapshot: () => view, subscribe: (report: () => void) => { listeners.add(report); return () => { listeners.delete(report) } },
    setOpen, begin, update, prepare, create, verify, checkFolder, dismiss, anyDirty: () => kept.size > 0 }
}

export type ProjectDocuments = ReturnType<typeof createProjectDocuments>
