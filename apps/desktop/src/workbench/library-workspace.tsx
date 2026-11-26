import { useEffect, useState, type ReactNode } from 'react'
import { parseAvatarSpec, resolveSpec, serializeAvatarSpec, USER_AVATAR_SEED, type AvatarSpec } from '../renderer/src/components/humation'
import { useI18n } from '../renderer/src/i18n/i18n'
import { ProfilePanelView } from '../renderer/src/redesign/ProfilePanel'
import { ProfileStateProvider } from '../renderer/src/store/profile'
import { libraryCopy } from './library-copy'
import { GLOBAL_MEMORY, LibraryMemoryEditor, ProjectMemoryDialog, useLibraryMemory } from './library-memory'
import { LibraryDialog, PanelNotice, taskResult, usePanelTask } from './library-panel'
import { RoleRoster } from './library-roster'
import type { Library, ProfileSnapshot, Role, Roster } from './library-transport'
import './library.css'

export type LibraryPanel = 'profile' | 'roster' | 'projects'

export function LibraryWorkspace({ api, locked, notice, createChat, children, close, openProjects, panel, onRoster }: {
  api: Library; locked: boolean; notice: ReactNode; createChat: (role: Role) => Promise<boolean>; children: ReactNode
  close: () => void; openProjects: () => void; panel?: LibraryPanel; onRoster: (roster: Roster) => void
}): React.JSX.Element {
  const [profile, setProfile] = useState<ProfileSnapshot>()
  const task = usePanelTask()
  const [confirmed, setConfirmed] = useState(false)
  const isOpen = panel === 'profile'
  const [openVersion, setOpenVersion] = useState(0)
  const read = (resetDraft = false): void => {
    setConfirmed(false)
    if (resetDraft) setOpenVersion((version) => version + 1)
    taskResult(task.run('read', api.profile, (next) => { setProfile(next); setConfirmed(isOpen) }))
  }
  useEffect(() => { read() }, [])
  useEffect(() => {
    if (isOpen && !confirmed && !task.pending && !task.issue && !locked) read()
  }, [isOpen, confirmed, task.pending, task.issue, locked])

  const saveAvatar = async (spec: AvatarSpec, image: string): Promise<boolean> => {
    if (locked || !profile || !confirmed || task.pending || task.issue === 'stale') return false
    const baseline = profile.profile
    const choice = serializeAvatarSpec(spec)
    const initial = serializeAvatarSpec(resolveSpec(USER_AVATAR_SEED, parseAvatarSpec(baseline.avatar)))
    const avatar = initial === choice ? baseline.avatar : choice
    try {
      await task.run('write', () => api.saveProfile(profile, avatar, image), setProfile)
      return true
    } catch { return false }
  }
  return <ProfileStateProvider value={{ avatar: parseAvatarSpec(profile?.profile.avatar), avatarImage: profile?.profile.avatarImage ?? '', saveAvatar }}>
    {children}
    {isOpen && <PersonalProfile key={openVersion} api={api} locked={locked} close={() => { setConfirmed(false); close() }}
      openProjects={() => { setConfirmed(false); openProjects() }}
      avatarLocked={locked || !confirmed || !!task.pending || task.issue === 'stale'}
      notice={<>{notice}<PanelNotice issue={task.issue} pending={task.pending} locked={locked} reload={() => read(true)} /></>} />}
    {panel === 'projects' && <ProjectMemoryDialog api={api} locked={locked} notice={notice} onClose={close} />}
    {panel === 'roster' && <RoleRoster api={api} locked={locked} notice={notice} onClose={close} createChat={createChat} onRoster={onRoster} />}
  </ProfileStateProvider>
}

function PersonalProfile({ api, locked, avatarLocked, notice, close, openProjects }: {
  api: Library; locked: boolean; avatarLocked: boolean; notice: ReactNode; close: () => void; openProjects: () => void
}): React.JSX.Element {
  const { locale } = useI18n()
  const c = libraryCopy(locale)
  const [adding, setAdding] = useState(false)
  const memory = useLibraryMemory(api, GLOBAL_MEMORY, locked)
  const voice = <>{notice}<PanelNotice issue={memory.task.issue} pending={memory.pending} locked={locked} reload={() => {
    setAdding(false); memory.reload()
  }} /></>
  if (adding) return <LibraryDialog title={c.addMemory} testId="workbench-memory-add-panel" onClose={() => setAdding(false)} busy={memory.pending === 'write'}>
    {voice}
    <LibraryMemoryEditor memory={memory} defaultType="user" close={() => setAdding(false)} />
  </LibraryDialog>
  return <ProfilePanelView key={memory.generation} onClose={close} memory={{ mem: memory.state?.snapshot ?? null,
    apply: () => undefined, pending: !memory.writable, clearAll: memory.clear }} web={{ avatarLocked,
      notice: voice, overviewActions: <>
        <p className="wb-library__hint wb-library__manual">{c.memoryManual}</p>
        <button type="button" className="cf-btn" data-testid="workbench-memory-add" disabled={!memory.writable} onClick={() => setAdding(true)}>{c.addMemory}</button>
        <button type="button" className="cf-btn" data-testid="workbench-project-open" onClick={openProjects}>{c.projectMemory}</button>
      </>, renderDetail: (entry, closeDetail) => <LibraryMemoryEditor memory={memory} entry={entry} defaultType="user" close={closeDetail} />,
      busy: memory.pending === 'write' }} />
}