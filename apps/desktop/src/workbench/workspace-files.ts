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
  issue?: 'expired' | 'replaced'
}

function parentOf(path: string): string { return path.slice(0, Math.max(0, path.lastIndexOf('/'))) }

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
      projects, projectId, directories, expanded, file, issue,
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
    if (signal?.aborted || !projectId || projectIssue() || directories.get(path)?.pending || (!refresh && directories.get(path)?.data)) return
    const id = projectId
    const generation = dirGeneration
    directory(path, { pending: true })
    try {
      const data = await (signal ? api.list(id, path, signal) : api.list(id, path))
      if (!signal?.aborted && generation === dirGeneration) directory(path, { data })
    } catch (error) {
      if (signal?.aborted) return
      const issue = failed(error, 'readFailure', id)
      if (generation === dirGeneration) directory(path, { issue })
      else emit()
    }
  }

  function select(id: string, signal?: AbortSignal): Promise<void> | undefined {
    if (signal?.aborted || id === projectId || (id && !projects.data?.some((project) => project.id === id))) return
    cancelRead()
    projectId = id
    dirGeneration++
    directories = new Map()
    expanded = new Set()
    emit()
    return list('', false, signal)
  }
  function toggle(path: string): Promise<void> | undefined {
    if (projectIssue() || !path) return
    const next = new Set(expanded)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    expanded = next
    emit()
    return next.has(path) ? list(path) : undefined
  }

  async function reload(): Promise<void> {
    const id = projectId
    const path = activePaths.get(id)
    if (projectIssue() || !path || view.file?.pending) return
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
    if (!projectId || !path || (projectIssue() && !getFile(projectId, path))) return
    if (activePaths.get(projectId) !== path) {
      cancelRead()
      activePaths.set(projectId, path)
      emit()
    }
    return !view.file?.disk && !view.file?.issue ? reload() : undefined
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
    loadProjects, select, list, toggle, openFile, reveal, reload, edit, review, canSave, save
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
  await (files.select(id, signal) ?? files.list('', false, signal))
  if (signal.aborted) return false
  const view = files.snapshot()
  if (view.issue === 'expired') throw new HttpFailure(401)
  return view.projectId === id && !view.issue
}
