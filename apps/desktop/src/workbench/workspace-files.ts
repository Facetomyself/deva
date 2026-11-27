import { HttpFailure } from './transport'
import type { WorkspaceDirectory, WorkspaceFile, WorkspaceOption, WorkspaceTransport } from './workspace-transport'

export type WorkspaceIssue = 'expired' | 'replaced' | 'readFailure' | 'saveFailure' | 'conflict' | 'readonly' | 'fileLimit'
type FetchState<T> = { data?: T; pending?: boolean; issue?: WorkspaceIssue }
export type FileDraft = {
  path: string
  disk?: WorkspaceFile
  text?: string
  pending?: 'read' | 'save'
  issue?: WorkspaceIssue
  needsReload?: boolean
  parentWritable?: boolean
  review?: boolean
  saved?: boolean
}

export type WorkspaceFilesView = {
  projects: FetchState<WorkspaceOption[]>
  projectId: string
  directories: ReadonlyMap<string, FetchState<WorkspaceDirectory>>
  expanded: ReadonlySet<string>
  file?: FileDraft
  drafts: string[]
  dirty: boolean
  anyDirty: boolean
  writable: boolean
  folder?: string
  folderFocus: number
  folderIssue?: 'missing'
  blockedDocumentPaths: ReadonlySet<string>
  issue?: 'expired' | 'replaced'
}

export function parentOf(path: string): string { return path.slice(0, Math.max(0, path.lastIndexOf('/'))) }

function folderChain(path: string): string[] | undefined {
  if (path === '') return []
  const names = path.split('/')
  if (names.some((name) => !name || name === '.' || name === '..' || /^[A-Za-z]:/u.test(name) || /[\\\x00-\x1f\x7f-\x9f]/u.test(name))) return
  return names.map((_, index) => names.slice(0, index + 1).join('/'))
}

function enumeratedFolder(view: Pick<WorkspaceFilesView, 'directories' | 'expanded'>, path: string, visible = false): boolean {
  const chain = folderChain(path)
  return !!chain && !!view.directories.get('')?.data && chain.every((child) => {
    const parent = parentOf(child)
    return (!visible || parent === '' || view.expanded.has(parent)) &&
      view.directories.get(parent)?.data?.entries.some((entry) => entry.path === child && entry.type === 'dir')
  })
}

/** Creation requires both the authorized mount and a listed, visible, writable directory. */
export function writableDocumentFolders(view: WorkspaceFilesView): string[] {
  if (view.issue || !view.projects.data?.some(({ id }) => id === view.projectId) || !view.directories.get('')?.data) return []
  return [...view.directories].filter(([path, state]) => state.data?.path === path && state.data.writable &&
    enumeratedFolder(view, path, true)).map(([path]) => path)
}


export function isDirty(file: FileDraft): boolean {
  return file.text !== undefined && (file.disk?.kind !== 'text' || file.text !== file.disk.content)
}

/** Drafts are in memory for this owner page only. All async results are scoped by project and file. */
export function createWorkspaceFiles(api: WorkspaceTransport) {
  const listeners = new Set<() => void>()
  const files = new Map<string, Map<string, FileDraft>>()
  const activePaths = new Map<string, string>()
  const unavailable = new Set<string>()
  let projects: FetchState<WorkspaceOption[]> = {}
  let projectRequest: Promise<boolean> | undefined
  let projectId = ''
  let directories = new Map<string, FetchState<WorkspaceDirectory>>()
  let expanded = new Set<string>()
  let folder: string | undefined
  let folderFocus = 0
  let folderIssue: WorkspaceFilesView['folderIssue']
  let folderAction = 0
  const blockedDocuments = new Map<string, Set<string>>()
  let directoryRequests = new Map<string, Promise<void>>()
  let expired = false
  let dirGeneration = 0
  let reading: { id: string; path: string } | undefined
  let view = snapshot()

  function getFile(id: string, path: string): FileDraft | undefined { return files.get(id)?.get(path) }
  function setFile(id: string, path: string, file: FileDraft): void {
    if (!files.has(id)) files.set(id, new Map())
    files.get(id)!.set(path, file)
  }
  function projectIssue(): WorkspaceFilesView['issue'] {
    return expired ? 'expired' : unavailable.has(projectId) ? 'replaced' : undefined
  }
  function snapshot(): WorkspaceFilesView {
    const file = getFile(projectId, activePaths.get(projectId) ?? '')
    const issue = projectIssue()
    return {
      projects, projectId, directories, expanded, file, issue, folder, folderFocus, folderIssue,
      blockedDocumentPaths: new Set(blockedDocuments.get(projectId)),
      drafts: Array.from(files.get(projectId)?.values() ?? []).filter(isDirty).map((d) => d.path),
      dirty: file ? isDirty(file) : false,
      anyDirty: Array.from(files.values()).some((docs) => Array.from(docs.values()).some(isDirty)),
      writable: !issue && !!directories.get('')?.data && file?.disk?.writable === true && file.issue !== 'readonly' &&
        (directories.get(parentOf(file.path))?.data?.writable ?? file.parentWritable) === true
    }
  }
  function emit(): void {
    view = snapshot()
    listeners.forEach((notify) => notify())
  }

  function cancelRead(): void {
    if (!reading) return
    const { id, path } = reading
    const file = getFile(id, path)
    if (file?.pending === 'read') setFile(id, path, { ...file, pending: undefined })
    reading = undefined
  }
  function failed(error: unknown, fallback: WorkspaceIssue, id?: string): WorkspaceIssue {
    if (!(error instanceof HttpFailure)) return fallback
    if (error.status === 401 || error.code === 'csrf_failed') {
      expired = true
      cancelRead()
      dirGeneration++
      return 'expired'
    }
    if (id && (error.code === 'workspace_unavailable' || error.code === 'workspace_replaced' || error.status === 410)) {
      unavailable.add(id)
      if (id === projectId) {
        cancelRead()
        dirGeneration++
        directories = new Map()
        expanded = new Set()
        directoryRequests = new Map()
        folder = undefined
      }
      return 'replaced'
    }
    if (fallback === 'saveFailure') {
      if (error.status === 409) return 'conflict'
      if (error.code === 'workspace_read_only') return 'readonly'
      if (error.status === 413) return 'fileLimit'
    }
    return fallback
  }

  async function loadProjects(refresh = false, signal?: AbortSignal): Promise<void> {
    if (expired || signal?.aborted) return
    if (projectRequest) {
      if (!await projectRequest) await loadProjects(refresh, signal)
      return
    }
    if (!refresh && projects.data) return
    const previous = projects
    projectRequest = Promise.resolve().then(async () => {
      if (signal?.aborted) { projects = previous; return false }
      try {
        const data = await (signal ? api.projects(signal) : api.projects())
        projects = signal?.aborted ? previous : { data }
      } catch (error) {
        projects = signal?.aborted ? previous : { issue: failed(error, 'readFailure') }
      }
      return !signal?.aborted
    }).finally(() => { projectRequest = undefined; emit() })
    projects = { pending: true }
    emit()
    await projectRequest
  }

  function directory(path: string, state: FetchState<WorkspaceDirectory>): void {
    directories = new Map(directories).set(path, state)
    emit()
  }
  async function list(path: string, refresh = false, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || !projectId || projectIssue() || (!refresh && directories.get(path)?.data)) return
    const existing = directoryRequests.get(path)
    if (existing) return existing
    const id = projectId
    const generation = dirGeneration
    const requests = directoryRequests
    const previous = directories.get(path)
    const request = Promise.resolve().then(async (): Promise<void> => {
      try {
        const data = await (signal ? api.list(id, path, signal) : api.list(id, path))
        if (generation === dirGeneration && requests.get(path) === request)
          directory(path, signal?.aborted ? previous ?? {} : { data })
      } catch (error) {
        if (signal?.aborted) {
          if (generation === dirGeneration && requests.get(path) === request) directory(path, previous ?? {})
          return
        }
        if (generation === dirGeneration && requests.get(path) !== request) return
        const issue = failed(error, 'readFailure', id)
        if (generation === dirGeneration) directory(path, { issue })
        else emit()
      } finally { if (requests.get(path) === request) requests.delete(path) }
    })
    requests.set(path, request)
    directory(path, { pending: true })
    return request
  }

  function select(id: string, signal?: AbortSignal, browse = true): Promise<void> | undefined {
    if (signal?.aborted || id === projectId || (id && !projects.data?.some((project) => project.id === id))) return
    cancelRead()
    projectId = id
    dirGeneration++
    directories = new Map()
    directoryRequests = new Map()
    expanded = new Set()
    folder = undefined
    folderIssue = undefined
    folderAction++
    emit()
    return browse ? list('', false, signal) : undefined
  }
  function chooseFolder(path: string): void {
    if (projectIssue() || !enumeratedFolder(view, path, true)) return
    folder = path
    folderIssue = undefined
    folderAction++
    emit()
  }
  function toggle(path: string): Promise<void> | undefined {
    if (projectIssue() || !path || !folderChain(path)) return
    const next = new Set(expanded)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    expanded = next
    if (enumeratedFolder(view, path, true)) chooseFolder(path)
    else emit()
    return next.has(path) ? list(path) : undefined
  }

  async function reload(): Promise<void> {
    const id = projectId
    const path = activePaths.get(id)
    if (projectIssue() || !path || view.file?.pending || blockedDocuments.get(id)?.has(path)) return
    const previous = getFile(id, path) ?? { path }
    const token = { id, path }
    reading = token
    setFile(id, path, { ...previous, issue: undefined, pending: 'read', saved: false })
    emit()
    try {
      const disk = await api.read(id, path)
      if (reading !== token) return
      reading = undefined
      const keep = isDirty(previous)
      const text = keep ? previous.text : disk.kind === 'text' ? disk.content : undefined
      setFile(id, path, { path, disk, text, parentWritable: directories.get(parentOf(path))?.data?.writable ?? previous.parentWritable,
        review: keep && disk.kind === 'text' && text !== disk.content &&
          (previous.needsReload === true || previous.review === true || previous.disk?.kind !== 'text' || disk.revision !== previous.disk.revision) })
      emit()
    } catch (error) {
      const current = reading === token
      const issue = failed(error, 'readFailure', id)
      if (current && reading === token) {
        reading = undefined
        setFile(id, path, { ...previous, pending: undefined, issue, saved: false })
      }
      emit()
    }
  }
  function openFile(path: string): Promise<void> | undefined {
    if (!projectId || !path || blockedDocuments.get(projectId)?.has(path) || (projectIssue() && !getFile(projectId, path))) return
    if (activePaths.get(projectId) !== path || folder !== undefined || folderIssue) {
      cancelRead()
      activePaths.set(projectId, path)
      folder = undefined
      folderIssue = undefined
      folderAction++
      emit()
    }
    return !view.file?.disk && !view.file?.issue ? reload() : undefined
  }

  function markFolder(path: string, chain: string[]): void {
    expanded = new Set([...expanded, ...chain])
    folder = path
    folderIssue = undefined
    folderFocus++
    emit()
  }

  /** Resolve only a project-relative directory that the owner list can actually enumerate. */
  async function revealFolder(id: string, path: string, signal?: AbortSignal): Promise<boolean> {
    const chain = folderChain(path)
    if (!chain || id !== projectId || !projects.data?.some((project) => project.id === id)) return false
    const action = ++folderAction
    const generation = dirGeneration
    const current = (): boolean => !signal?.aborted && action === folderAction && generation === dirGeneration &&
      id === projectId && !projectIssue() && !!projects.data?.some((project) => project.id === id)
    if (!current()) return false
    const fresh = new Map<string, WorkspaceDirectory>()
    let missing: string | undefined
    for (const target of ['', ...chain]) {
      missing = target
      if (target && !fresh.get(parentOf(target))?.entries.some((entry) => entry.type === 'dir' && entry.path === target)) break
      try {
        const listing = await (signal ? api.list(id, target, signal) : api.list(id, target))
        if (!current()) return false
        if (listing.path !== target) break
        fresh.set(target, listing)
        missing = undefined
      } catch (error) {
        if (!current()) return false
        failed(error, 'readFailure', id)
        if (projectIssue()) { emit(); return false }
        break
      }
    }
    const next = new Map(directories)
    if (missing !== undefined) {
      for (const candidate of next.keys()) {
        if (missing === '' || candidate === missing || candidate.startsWith(`${missing}/`)) {
          next.delete(candidate)
          directoryRequests.delete(candidate)
        }
      }
    }
    for (const [target, listing] of fresh) {
      directoryRequests.delete(target)
      next.set(target, { data: listing })
    }
    directories = next
    if (missing !== undefined) {
      if (folder !== undefined && (!directories.get(folder)?.data || !enumeratedFolder({ directories, expanded }, folder))) folder = undefined
      folderIssue = 'missing'
      emit()
      return false
    }
    markFolder(path, chain)
    return true
  }

  function revealContainingFolder(signal?: AbortSignal): Promise<boolean> | undefined {
    const path = view.file?.path
    if (!path || !folderChain(path)) return
    return revealFolder(projectId, parentOf(path), signal)
  }

  function reportDocumentFailure(error: unknown, id: string): void {
    if (id === projectId) { failed(error, 'readFailure', id); emit() }
  }

  function blockDocumentPath(id: string, path: string, block: boolean): void {
    let paths = blockedDocuments.get(id)
    if (!paths && block) blockedDocuments.set(id, paths = new Set())
    if (paths?.has(path) === block || !paths) return
    if (block) paths.add(path)
    else paths.delete(path)
    if (id === projectId) emit()
  }

  /** Re-read the directory row and text receipt. An ordinary file read never substitutes for a create receipt. */
  async function verifyCreatedDocument(id: string, path: string, content: string, revision: string, active: () => boolean): Promise<boolean> {
    const parent = parentOf(path)
    const chain = folderChain(parent)
    const generation = dirGeneration
    const current = (): boolean => generation === dirGeneration && projectId === id && !projectIssue() && active() &&
      !!projects.data?.some((project) => project.id === id) && enumeratedFolder(view, parent)
    if (!current() || !chain) return false
    const directory = await api.list(id, parent)
    if (!current() || directory.path !== parent || !directory.entries.some((entry) => entry.type === 'file' && entry.path === path)) return false
    const disk = await api.read(id, path)
    if (!current() || disk.kind !== 'text' || disk.path !== path || disk.content !== content || disk.revision !== revision) return false
    const pendingList = directoryRequests.get(parent)
    if (pendingList) {
      await pendingList
      if (!current()) return false
    }
    const cached = getFile(id, path)
    // A kept edit for that path belongs to the old file, not to a newly confirmed one.
    if (cached && isDirty(cached)) return false
    cancelRead()
    directories = new Map(directories).set(parent, { data: directory })
    blockedDocuments.get(id)?.delete(path)
    setFile(id, path, { path, disk, text: disk.content, parentWritable: directory.writable, saved: true })
    activePaths.set(id, path)
    folderAction++
    markFolder(parent, chain)
    return true
  }

  // Reuse the same project, directory and reader checks as the manual file panel.
  async function reveal(id: string, path: string, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false
    await loadProjects()
    if (signal.aborted || !projects.data?.some((project) => project.id === id)) return false
    await (select(id) ?? list(''))
    const current = (): boolean => !signal.aborted && projectId === id && !projectIssue()
    if (!current()) return false
    const segments = path.split('/')
    let parent = ''
    for (const [index, name] of segments.entries()) {
      const target = parent ? `${parent}/${name}` : name
      const last = index === segments.length - 1
      let entry = directories.get(parent)?.data?.entries.find((node) => node.path === target)
      if (!entry) {
        // Manual browsing may have cached the directory before this file was produced.
        await list(parent, true)
        if (!current()) return false
        entry = directories.get(parent)?.data?.entries.find((node) => node.path === target)
      }
      if (entry?.type !== (last ? 'file' : 'dir')) return false
      if (last) {
        await openFile(target)
        return current() && view.file?.path === target && !!view.file.disk && !view.file.issue
      }
      await (expanded.has(target) ? list(target) : toggle(target))
      if (!current()) return false
      parent = target
    }
    return false
  }

  function edit(text: string): void {
    const file = view.file
    if (!view.writable || file?.disk?.kind !== 'text' || file.pending === 'read') return
    setFile(projectId, file.path, { ...file, text, saved: false })
    emit()
  }
  function review(useDisk: boolean): void {
    const file = view.file
    if (!file?.review || file.disk?.kind !== 'text') return
    setFile(projectId, file.path, { ...file, review: false, text: useDisk ? file.disk.content : file.text })
    emit()
  }
  function canSave(): boolean {
    const file = view.file
    return view.writable && view.dirty && !!file && !file.pending && !file.needsReload && !file.review
  }
  async function save(): Promise<void> {
    const id = projectId
    const original = view.file
    if (!canSave() || original?.disk?.kind !== 'text' || original.text === undefined) return
    const { path, disk, text } = original
    setFile(id, path, { ...original, issue: undefined, pending: 'save', saved: false })
    emit()
    try {
      const revision = await api.save(id, path, text, disk.revision)
      const current = getFile(id, path)!
      if (expired || unavailable.has(id)) {
        setFile(id, path, { ...current, pending: undefined })
      } else {
        setFile(id, path, { ...current, disk: { ...disk, content: text, revision }, pending: undefined, saved: current.text === text })
      }
    } catch (error) {
      const issue = failed(error, 'saveFailure', id)
      const current = getFile(id, path)!
      setFile(id, path, { ...current, pending: undefined, issue, needsReload: issue === 'conflict' || issue === 'readonly' })
    }
    emit()
  }

  return {
    snapshot: () => view,
    subscribe(notify: () => void): () => void { listeners.add(notify); return () => { listeners.delete(notify) } },
    loadProjects, select, list, toggle, openFile, reveal, reload, edit, review, canSave, save,
    chooseFolder, revealFolder, revealContainingFolder, reportDocumentFailure, blockDocumentPath, verifyCreatedDocument
  }
}

export type WorkspaceFiles = ReturnType<typeof createWorkspaceFiles>

/** Called only after an explicit open and a fresh conversation binding check. */
export async function openWorkspaceProject(files: WorkspaceFiles, id: string, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false
  await files.loadProjects(true, signal)
  if (signal.aborted) return false
  if (files.snapshot().projects.issue === 'expired') throw new HttpFailure(401)
  if (!files.snapshot().projects.data?.some((project) => project.id === id)) return false
  signal.addEventListener('abort', () => {
    if (files.snapshot().projectId === id) void files.select('')
  }, { once: true })
  void files.select(id, signal, false)
  const revealed = await files.revealFolder(id, '', signal)
  if (signal.aborted) return false
  if (files.snapshot().issue === 'expired') throw new HttpFailure(401)
  return revealed
}
