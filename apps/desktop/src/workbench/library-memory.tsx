import { useEffect, useState } from 'react'
import { useDialog } from '../renderer/src/components/DialogProvider'
import { useI18n } from '../renderer/src/i18n/i18n'
import { MemoryDetail } from '../renderer/src/redesign/MemoryDetail'
import type { MemoryEntry, MemoryIpcResult, MemoryType } from '../shared/host-settings'
import { libraryCopy } from './library-copy'
import { LibraryDialog, PanelNotice, taskResult, usePanelTask } from './library-panel'
import { MEMORY_TYPES, type Library, type MemoryInput, type MemoryResult, type MemoryState, type Scope, type WorkspaceOption } from './library-transport'
import { HttpFailure } from './transport'

export const GLOBAL_MEMORY: Scope = { kind: 'global' }

export function useLibraryMemory(api: Library, scope: Scope, locked: boolean) {
  const { t } = useI18n()
  const dialog = useDialog()
  const task = usePanelTask()
  const [state, setState] = useState<MemoryState>()
  const [generation, setGeneration] = useState(0)
  const reload = (): void => {
    setState(undefined)
    setGeneration((value) => value + 1)
    taskResult(task.run('read', () => api.memory(scope), setState))
  }
  // Each mounted editor belongs to one scope; callers key the panel by workspace or role ID.
  useEffect(() => { reload() }, [])
  const writable = !!state && !locked && !task.pending && task.issue !== 'stale'
  async function mutate(op: (state: MemoryState) => Promise<MemoryResult>): Promise<MemoryIpcResult> {
    if (!writable || !state) throw new Error('Reload memory before writing')
    return task.run('write', async () => {
      const result = await op(state)
      if (!result.ok && result.code === 'notFound') throw new HttpFailure(409, 'conflict')
      return result
    }, (result) => {
      if (result.ok) setState({ snapshot: result.snapshot, revision: result.revision })
    })
  }
  const clear = async (): Promise<void> => {
    if (!writable || !state?.snapshot.entries.length) return
    if (!await dialog.confirm({ title: t('cf.profile.memClear'), message: t('cf.profile.memClearConfirm'),
      confirmText: t('cf.profile.memClear'), variant: 'danger' })) return
    await mutate(async (prev) => {
      const result = await api.deleteMemory(scope, prev.revision)
      if (!result.ok) throw new Error('Memory clear was not confirmed')
      return result
    })
  }
  return { state, generation, pending: task.pending, writable, task, reload, clear: () => taskResult(clear()),
    save: (input: MemoryInput, id?: string) => mutate((prev) => api.writeMemory(scope, input, prev.revision, id)),
    remove: (id: string) => mutate((prev) => api.deleteMemory(scope, prev.revision, id)) }
}

type Memory = ReturnType<typeof useLibraryMemory>

export function LibraryMemoryEditor({ memory, entry, defaultType, close }: {
  memory: Memory; entry?: MemoryEntry; defaultType: MemoryType; close: () => void
}): React.JSX.Element | null {
  const { locale } = useI18n()
  const c = libraryCopy(locale)
  if (!memory.state) return null
  return <MemoryDetail key={entry?.id ?? 'new'} entry={entry ?? { id: '', title: '', body: '', type: defaultType, createdAt: 0, updatedAt: 0 }}
    onClose={close} onChanged={() => undefined} web={{ types: MEMORY_TYPES.map((value) => ({ value, label: c.types[value] })),
      typeLabel: c.memoryType, limits: memory.state.snapshot, locked: !memory.writable,
      write: (input) => memory.save(input, entry?.id), remove: entry ? () => memory.remove(entry.id) : undefined }} />
}

export function LibraryMemoryPane({ api, scope, locked }: { api: Library; scope: Scope; locked: boolean }): React.JSX.Element {
  const { t, locale } = useI18n()
  const c = libraryCopy(locale)
  const memory = useLibraryMemory(api, scope, locked)
  const [edit, setEdit] = useState<{ entry?: MemoryEntry }>()
  return <div className="wb-library__memory">
    <PanelNotice issue={memory.task.issue} pending={memory.pending} locked={locked} reload={() => { setEdit(undefined); memory.reload() }} />
    {edit && memory.state ? <LibraryMemoryEditor memory={memory} entry={edit.entry} defaultType={scope.kind === 'project' ? 'project' : 'user'} close={() => setEdit(undefined)} /> : <>
      <p className="wb-library__hint">{c.memoryManual}</p>
      {memory.state && (memory.state.snapshot.entries.length ? <div className="cf-me__tags">
        {memory.state.snapshot.entries.map((entry) => <button key={entry.id} className="cf-me__tag" type="button" title={entry.title}
          disabled={!!memory.pending} onClick={() => setEdit({ entry })}><span className="cf-me__tagtext">{entry.title}</span></button>)}
      </div> : <p className="cf-me__tagsempty">{t('cf.profile.memEmpty')}</p>)}
      <div className="cf-editor__actions">
        <button className="cf-btn" type="button" disabled={!memory.writable || !memory.state?.snapshot.entries.length} onClick={memory.clear}>{t('cf.profile.memClear')}</button>
        <button className="cf-btn is-primary" type="button" data-testid="workbench-memory-add" disabled={!memory.writable} onClick={() => setEdit({})}>{c.addMemory}</button>
      </div>
    </>}
  </div>
}

export function ProjectMemoryDialog({ api, locked, notice, onClose }: {
  api: Library; locked: boolean; notice: React.ReactNode; onClose: () => void
}): React.JSX.Element {
  const { locale } = useI18n()
  const c = libraryCopy(locale)
  const task = usePanelTask()
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>()
  const [id, setId] = useState('')
  const load = (): void => taskResult(task.run('read', api.workspaces, (next) => {
    setWorkspaces(next)
    setId((prev) => next.some((item) => item.id === prev) ? prev : '')
  }))
  useEffect(() => { load() }, [])
  return <LibraryDialog title={c.projectMemory} testId="workbench-project-memory" onClose={onClose}>
    {notice}
    <div className="cf-editor wb-library__editor">
      <PanelNotice issue={task.issue} pending={task.pending} reload={load} locked={locked} />
      {workspaces && (workspaces.length ? <label className="wb-library__field">{c.workspace}
        <select className="cf-input" value={id} data-testid="workbench-project-select" onChange={(event) => setId(event.target.value)}>
          <option value="">{c.selectWorkspace}</option>
          {workspaces.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label> : <p className="wb-library__hint">{c.noWorkspace}</p>)}
      {id && <LibraryMemoryPane key={id} api={api} scope={{ kind: 'project', id }} locked={locked} />}
    </div>
  </LibraryDialog>
}