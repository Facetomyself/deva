import { useEffect, useState, type ReactNode } from 'react'
import { useDialog } from '../renderer/src/components/DialogProvider'
import { parseAvatarSpec, PersonaFace, randomizeSpec, resolveSpec, serializeAvatarSpec, type AvatarSpec } from '../renderer/src/components/humation'
import { useI18n } from '../renderer/src/i18n/i18n'
import { AvatarEditor } from '../renderer/src/redesign/AvatarEditor'
import { PersonaPromptPage, PersonaPromptRow } from '../renderer/src/redesign/PersonaPrompt'
import { PersonaRow } from '../renderer/src/redesign/Rail'
import { useModels } from '../renderer/src/store/models'
import { libraryCopy } from './library-copy'
import { LibraryMemoryPane } from './library-memory'
import { LibraryDialog, PanelNotice, taskResult, usePanelTask } from './library-panel'
import type { Library, Role, RoleFields, RoleImage, Roster, WorkspaceOption } from './library-transport'

export function RoleRoster({ api, onClose, locked, notice, createChat, onRoster }: {
  api: Library; onClose: () => void; locked: boolean; notice: ReactNode; createChat: (role: Role) => Promise<boolean>; onRoster: (roster: Roster) => void
}): React.JSX.Element {
  const { t, locale } = useI18n()
  const c = libraryCopy(locale)
  const dialog = useDialog()
  const task = usePanelTask()
  const [roster, setLocalRoster] = useState<Roster>()
  const setRoster = (value: Roster): void => { setLocalRoster(value); onRoster(value) }
  const [selected, setSelected] = useState('')
  const [view, setView] = useState<'card' | 'memory' | 'edit' | 'avatar'>('card')
  const [editing, setEditing] = useState<Role>()
  const [avatarEdit, setAvatarEdit] = useState<{ role: Role; image: RoleImage }>()
  const [avatarPreview, setAvatarPreview] = useState<{ id: string; image: string }>()
  const [avatarPartial, setAvatarPartial] = useState(false)
  const [launching, setLaunching] = useState(false)
  const [launchFailed, setLaunchFailed] = useState(false)
  const role = roster?.roles.find((item) => item.id === selected)
  const rank = role && roster ? roster.order.indexOf(role.id) : -1
  const previewId = view === 'card' || view === 'memory' ? role?.id : undefined
  const previewRev = previewId ? role?.revision : undefined
  useEffect(() => {
    if (!previewId) return
    let active = true
    setAvatarPreview((previous) => previous?.id === previewId ? previous : undefined)
    void api.roleImage(previewId).then((picture) => {
      if (active) setAvatarPreview({ id: previewId, image: picture.image })
    }).catch(() => { /* The avatar editor offers explicit recovery. */ })
    return () => { active = false }
  }, [previewId, previewRev, api])

  function reload(): void {
    setView('card')
    setEditing(undefined)
    setAvatarEdit(undefined)
    setAvatarPartial(false)
    setLaunchFailed(false)
    taskResult(task.run('read', api.roster, (result) => {
      setRoster(result)
      setSelected((prev) => result.order.includes(prev) ? prev : '')
    }))
  }
  useEffect(() => { reload() }, [])

  const busy = !!task.pending || launching
  const writable = !!roster && !locked && !busy && task.issue !== 'stale' && task.issue !== 'readFailure'
  function choose(id: string): void {
    if (busy) return
    setSelected(id)
    setView('card')
    setLaunchFailed(false)
    if (task.issue !== 'stale' && task.issue !== 'readFailure') task.clear()
  }
  function edit(): void {
    if (!role || !writable) return
    taskResult(task.run('read', () => api.role(role.id), (latest) => {
      setEditing(latest)
      setView('edit')
    }))
  }
  function editAvatar(): void {
    if (!role || !writable) return
    setAvatarPartial(false)
    taskResult(task.run('read', () => api.roleAvatar(role.id), (value) => {
      setAvatarEdit(value)
      setView('avatar')
    }))
  }
  function closeAvatar(): void {
    setAvatarEdit(undefined)
    setView('card')
  }
  function saveAvatar(spec: AvatarSpec, dataUri: string): void {
    if (!avatarEdit || !writable) return
    const baseline = avatarEdit.role
    const avatar = serializeAvatarSpec(spec)
    const specChanged = avatar !== serializeAvatarSpec(resolveSpec(baseline.id, parseAvatarSpec(baseline.avatar)))
    const imageChanged = dataUri !== avatarEdit.image.image
    if (!specChanged && !imageChanged) { closeAvatar(); return }
    taskResult(task.run('write', async () => {
      let current = baseline
      if (specChanged) {
        const saved = await api.updateRole(baseline, { avatar })
        setRoster(saved.roster)
        current = saved.role
      }
      try {
        if (imageChanged) {
          const picture = await api.setRoleImage(current, avatarEdit.image, dataUri)
          setAvatarPreview({ id: current.id, image: picture.image })
        }
      } catch (error) {
        // The generated spec may already be committed. Keep the dialog paused
        // until explicit reload rather than retrying either mutation.
        if (specChanged) {
          setAvatarPartial(true)
          throw new Error('Role avatar spec saved but image unconfirmed')
        }
        throw error
      }
    }, closeAvatar))
  }
  function save(input: RoleFields): void {
    if (!writable) return
    const name = input.name.trim()
    const fields = { ...input, name }
    const changes = editing ? Object.fromEntries(Object.entries(fields).filter(([key, value]) => editing[key as keyof RoleFields] !== value)) as Partial<RoleFields> : undefined
    if (editing && changes && Object.keys(changes).length === 0) { setView('card'); return }
    taskResult(task.run('write', () => editing && changes ? api.updateRole(editing, changes) : api.createRole(fields), (result) => {
      setRoster(result.roster)
      setSelected(result.role.id)
      setView('card')
    }))
  }
  function move(offset: number): void {
    if (!role || !roster || !writable || rank < 0 || rank + offset < 0 || rank + offset >= roster.order.length) return
    const ids = [...roster.order]
    ;[ids[rank], ids[rank + offset]] = [ids[rank + offset], ids[rank]]
    taskResult(task.run('write', () => api.reorder(ids, roster.revision), setRoster))
  }
  function toggle(): void {
    if (!role || !writable) return
    taskResult(task.run('write', () => api.setEnabled(role, !role.enabled), (next) => setRoster(next.roster)))
  }
  async function remove(): Promise<void> {
    if (!role || !writable || role.protected) return
    const ok = await dialog.confirm({ title: c.deleteRole, message: c.confirmDelete.replace('{name}', role.name), confirmText: c.deleteRole, variant: 'danger' })
    if (ok) await task.run('write', () => api.deleteRole(role), (next) => { setRoster(next); setSelected('') })
  }
  async function launch(): Promise<void> {
    if (!role?.enabled || !writable) return
    setLaunchFailed(false)
    setLaunching(true)
    try {
      if (await createChat(role)) onClose()
      else setLaunchFailed(true)
    } finally { setLaunching(false) }
  }

  if (view === 'avatar' && avatarEdit) return <LibraryDialog title={c.editAvatar} testId="workbench-role-avatar-panel"
    busy={task.pending === 'write'} onClose={closeAvatar}>
    {notice}
    {avatarPartial && <p className="wb-library__issue" role="alert">{c.portraitPartial}</p>}
    <PanelNotice issue={task.issue} pending={task.pending} reload={reload} locked={locked} />
    <div className="cf-editor">
      <AvatarEditor seed={avatarEdit.role.id} title={avatarEdit.role.name}
        initialSpec={resolveSpec(avatarEdit.role.id, parseAvatarSpec(avatarEdit.role.avatar))} initialImage={avatarEdit.image.image}
        busy={task.pending === 'write'} saveDisabled={!writable} webTestId="workbench-role-avatar" onCancel={closeAvatar} onDone={saveAvatar} />
    </div>
  </LibraryDialog>

  if (view === 'edit') return <LibraryDialog title={t(editing ? 'cf.editorEditTitle' : 'cf.editorNewTitle')} testId="workbench-role-editor"
    busy={task.pending === 'write'} onClose={() => setView('card')}>
    {notice}
    <PanelNotice issue={task.issue} pending={task.pending} reload={reload} locked={locked} />
    <RoleForm api={api} role={editing} writable={writable} locked={locked} save={save} close={() => setView('card')} />
  </LibraryDialog>

  return <LibraryDialog title={c.roles} testId="workbench-roster-panel" busy={task.pending === 'write' || launching} onClose={onClose}>
    {notice}
    <PanelNotice issue={task.issue} pending={task.pending} reload={reload} locked={locked} />
    <div className="wb-library__roster">
      <aside className="wb-library__roles" aria-label={c.roles}>
        <button className="cf-btn is-primary" type="button" data-testid="workbench-role-add" disabled={!writable}
          onClick={() => { setEditing(undefined); setView('edit') }}>{c.newRole}</button>
        {roster?.roles.map((item) => <PersonaRow key={item.id} active={item.id === selected} testId="workbench-role-row"
          persona={{ id: item.id, name: item.name, desc: item.description, avatar: item.avatar, model: item.model }} onClick={() => choose(item.id)} />)}
        {roster?.roles.length === 0 && <p className="wb-library__hint">{c.noRoles}</p>}
      </aside>
      <section className="wb-library__role-body" aria-label={role?.name ?? c.roles}>
        <p className="wb-library__hint">{c.roleScope}</p>
        {!role ? <p className="wb-library__hint">{c.pickRole}</p> : <>
          <div className="cf-phead">
            <div className="cf-profile__ava" data-testid="workbench-role-avatar-preview"><PersonaFace seed={role.id}
              spec={parseAvatarSpec(role.avatar)} image={avatarPreview?.id === role.id ? avatarPreview.image : undefined} title={role.name} /></div>
            <div className="cf-phead__id">
              <h3 className="cf-phead__name">{role.name}</h3>
              {role.description && <p className="cf-phead__spec">{role.description}</p>}
              <p className="wb-library__hint" data-testid="workbench-role-state">{role.enabled ? c.enabled : c.disabled}{role.protected && ` · ${c.protected}`}</p>
            </div>
          </div>
          <div className="wb-library__actions">
            <button className="cf-btn is-primary" type="button" data-testid="workbench-role-start" disabled={!writable || !role.enabled} onClick={() => taskResult(launch())}>{t('cf.startChat')}</button>
            <button className="cf-btn" type="button" data-testid="workbench-role-avatar-edit" disabled={!writable} onClick={editAvatar}>{c.editAvatar}</button>
            <button className="cf-btn" type="button" data-testid="workbench-role-edit" disabled={!writable} onClick={edit}>{t('cf.editPersona')}</button>
            <button className="cf-btn" type="button" data-testid="workbench-role-enabled" disabled={!writable} onClick={toggle}>{role.enabled ? c.disable : c.enable}</button>
            <button className="cf-btn" type="button" data-testid="workbench-role-up" disabled={!writable || rank <= 0} onClick={() => move(-1)}>{c.up}</button>
            <button className="cf-btn" type="button" data-testid="workbench-role-down" disabled={!writable || !roster || rank >= roster.order.length - 1} onClick={() => move(1)}>{c.down}</button>
            <button className="cf-btn" type="button" data-testid="workbench-role-delete" disabled={!writable || role.protected} onClick={() => taskResult(remove())}>{c.deleteRole}</button>
            <button className="cf-btn" type="button" data-testid="workbench-role-memory" aria-expanded={view === 'memory'} disabled={busy}
              onClick={() => setView((prev) => prev === 'memory' ? 'card' : 'memory')}>{c.roleMemory}</button>
          </div>
          {launchFailed && <p role="alert" className="wb-library__issue">{c.startFailure} <button type="button" className="cf-btn" onClick={reload}>{c.reload}</button></p>}
          {view === 'memory' && <LibraryMemoryPane key={role.id} api={api} scope={{ kind: 'role', id: role.id }} locked={locked || !writable} />}
        </>}
      </section>
    </div>
  </LibraryDialog>
}

function RoleForm({ api, role, writable, locked, save, close }: {
  api: Library; role?: Role; writable: boolean; locked: boolean; save: (input: RoleFields) => void; close: () => void
}): React.JSX.Element {
  const { t, locale } = useI18n()
  const { providers } = useModels()
  const c = libraryCopy(locale)
  const workspaceTask = usePanelTask()
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>()
  const seed = role?.id ?? 'new-persona'
  const [subpage, setSubpage] = useState<'avatar' | 'prompt'>()
  const [fields, setFields] = useState<RoleFields>(() => ({ name: role?.name ?? '', description: role?.description ?? '',
    avatar: role?.avatar ?? serializeAvatarSpec(randomizeSpec()), model: role?.model ?? '', workspaceId: role?.workspaceId ?? '',
    prompt: role?.prompt ?? '', enabled: role?.enabled ?? true }))
  const value = (key: keyof Omit<RoleFields, 'enabled'>, val: string): void => setFields((prev) => ({ ...prev, [key]: val }))
  const loadWorkspaces = (): void => taskResult(workspaceTask.run('read', api.workspaces, setWorkspaces))
  useEffect(() => { loadWorkspaces() }, [])
  const spec = parseAvatarSpec(fields.avatar)
  const models = providers.filter((p) => (p.purpose ?? 'llm') === 'llm')
  const missingModel = !!fields.model && !models.some((p) => p.models.some((m) => `${p.id}:${m.id}` === fields.model))
  const missingWorkspace = !!fields.workspaceId && !workspaces?.some((item) => item.id === fields.workspaceId)
  const size = new TextEncoder()
  const tooLong = size.encode(fields.name.trim()).length > 256 || size.encode(fields.description.trim()).length > 2048 || size.encode(fields.prompt.trim()).length > 65536
  if (subpage === 'prompt') return <PersonaPromptPage initial={fields.prompt} onCancel={() => setSubpage(undefined)}
    onDone={(next) => { value('prompt', next); setSubpage(undefined) }} />
  if (subpage === 'avatar') return <div className="cf-editor"><AvatarEditor seed={seed} title={fields.name} allowImage={false}
    initialSpec={resolveSpec(seed, spec)} initialImage="" onCancel={() => setSubpage(undefined)}
    onDone={(next) => { value('avatar', serializeAvatarSpec(next)); setSubpage(undefined) }} /></div>
  return <form className="cf-editor wb-library__editor" onSubmit={(event) => { event.preventDefault(); if (writable && !tooLong && fields.name.trim()) save(fields) }}>
    <p className="wb-library__hint">{c.roleScope}</p>
    <label className="wb-library__field">{t('cf.fName')}<input className="cf-input" required maxLength={256} value={fields.name}
      data-testid="workbench-role-name" onChange={(event) => value('name', event.target.value)} /></label>
    <label className="wb-library__field">{t('cf.fSpecialty')}<input className="cf-input" maxLength={2048} value={fields.description}
      onChange={(event) => value('description', event.target.value)} /></label>
    <label className="wb-library__field">{t('cf.fModel')}<select className="cf-input" value={fields.model}
      onChange={(event) => value('model', event.target.value)}>
      <option value="">{t('cf.defaultModel')}</option>
      {missingModel && <option value={fields.model}>{c.missingModel}: {fields.model}</option>}
      {models.filter((p) => p.models.length).map((p) => <optgroup key={p.id} label={p.name}>
        {p.models.map((m) => <option key={m.id} value={`${p.id}:${m.id}`}>{m.name}</option>)}
      </optgroup>)}
    </select></label>
    <label className="wb-library__field">{c.workspace}<select className="cf-input" value={fields.workspaceId} disabled={!workspaces}
      data-testid="workbench-role-workspace" onChange={(event) => value('workspaceId', event.target.value)}>
      <option value="">{c.defaultWorkspace}</option>
      {missingWorkspace && <option value={fields.workspaceId}>{fields.workspaceId === role?.workspaceId ? role.workspaceName || c.missingWorkspace : c.missingWorkspace}</option>}
      {workspaces?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select></label>
    <PanelNotice issue={workspaceTask.issue} pending={workspaceTask.pending} locked={locked} reload={loadWorkspaces} />
    <button className="cf-avapick" type="button" onClick={() => setSubpage('avatar')}>
      <span className="cf-avapick__face"><PersonaFace seed={seed} spec={spec} title={fields.name} /></span>
      <span className="cf-avapick__hint">{c.editGeneratedAvatar}</span>
    </button>
    <PersonaPromptRow value={fields.prompt} onOpen={() => setSubpage('prompt')} />
    {tooLong && <p role="alert" className="wb-library__issue">{c.inputTooLong}</p>}
    <div className="cf-editor__actions">
      <button className="cf-btn" type="button" onClick={close}>{t('cf.cancel')}</button>
      <button className="cf-btn is-primary" type="submit" data-testid="workbench-role-save" disabled={!writable || !fields.name.trim() || tooLong}>{t('cf.save')}</button>
    </div>
  </form>
}