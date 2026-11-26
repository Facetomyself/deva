import { useLayoutEffect, useMemo, useSyncExternalStore } from 'react'
import { Folder, FolderOpen } from 'lucide-react'
import { createSessionWorkspace, emptySessionWorkspace, type SessionWorkspaceController, type SessionWorkspaceView } from './session-workspace'
import type { SessionWorkspaceTransport } from './session-workspace-transport'
import './session-workspace.css'

const copy = {
  en: {
    title: 'Conversation project', chooser: 'Project to attach', choose: 'Choose an authorized project', attach: 'Attach to this conversation',
    detach: 'Detach', notes: 'Open project notes', open: 'Open attached project files', reload: 'Reload and review', project: 'Attached project',
    conflict: 'The conversation’s project changed. Your choice was kept. Reload and review it before trying again.',
    busy: 'This conversation is busy. Wait for the turn to finish, then reload and review.',
    permission: 'Project access was denied. Reload and review the current permissions.',
    missing: 'This conversation is no longer available.', readOnly: 'This conversation’s project is read-only.',
    unavailable: 'The attached or selected project is unavailable. Reload to check its current status.',
    choiceUnavailable: 'Your project choice is no longer available. Choose another project to attach.',
    storage: 'Saving the conversation’s project was not confirmed. Reload and review.',
    invalid: 'The project change was rejected. Reload and review your choice.',
    readFailure: 'The conversation’s project could not be checked. Reload to try again.',
    writeFailure: 'The project change was not confirmed. Your choice was kept. Reload and review.',
    catalogueFailure: 'The authorized projects could not be loaded.',
    read: 'Checking the conversation’s project…', write: 'Saving the conversation’s project…',
    files: 'Checking access to the attached project…',
  },
  'zh-CN': {
    title: '对话项目', chooser: '要关联的项目', choose: '选择已授权的项目', attach: '关联到此对话',
    detach: '解除关联', notes: '打开项目记忆', open: '打开已关联项目的文件', reload: '重新加载并核对', project: '已关联项目',
    conflict: '此对话的项目已更改。所选项目仍保留，请重新加载并核对后再试。',
    busy: '此对话正在运行。等待本轮结束后，重新加载并核对。',
    permission: '项目访问遭拒。请重新加载并核对当前权限。',
    missing: '此对话已失效。', readOnly: '此对话的项目为只读。',
    unavailable: '关联或所选的项目已失效。重新加载可检查当前状态。',
    choiceUnavailable: '所选项目已失效。请选择其他项目来关联。',
    storage: '对话项目的保存尚未确认，请重新加载并核对。',
    invalid: '项目更改遭拒，请重新加载并核对所选项目。',
    readFailure: '读取对话项目失败，请重新加载。',
    writeFailure: '项目更改尚未确认。所选项目仍保留，请重新加载并核对。',
    catalogueFailure: '读取已授权项目失败。',
    read: '正在检查对话项目…', write: '正在保存对话项目…',
    files: '正在检查关联项目的访问权限…',
  }
}
const labels = (locale: string) => locale === 'zh-CN' ? copy['zh-CN'] : copy.en
const noSubscribe = () => () => undefined

export function useSessionWorkspace(api: SessionWorkspaceTransport | undefined, sid: string | undefined, listRevision: string | undefined,
  detailRevision: string | undefined, writable: boolean, beforeWrite: () => Promise<void>, expired: () => void, committed: () => void) {
  const controller = useMemo(() => api ? createSessionWorkspace(api, { beforeWrite, expired, committed }) : undefined,
    [api, beforeWrite, expired, committed])
  const snapshot = useSyncExternalStore(controller?.subscribe ?? noSubscribe, controller?.snapshot ?? emptySessionWorkspace)
  useLayoutEffect(() => () => controller?.pause(), [controller])
  useLayoutEffect(() => { controller?.watch(sid, listRevision, detailRevision, writable) }, [controller, sid, listRevision, detailRevision, writable])
  return { controller, view: sid && snapshot.sid === sid ? snapshot : emptySessionWorkspace() }
}

export function AttachedWorkspaceLabel({ view, locale, open }: {
  view: SessionWorkspaceView; locale: string; open?: () => void
}): React.JSX.Element | null {
  const workspace = view.confirmed?.workspace
  if (!workspace) return null
  const c = labels(locale)
  const name = workspace.name ?? c.project
  const available = workspace.state === 'available'
  const contents = <>{available ? <FolderOpen size={15} aria-hidden="true" /> : <Folder size={15} aria-hidden="true" />}
    <span className="cf-wschip__name">{name}</span></>
  return <span className={`cf-wschip cf-wschip--mounted wb-session-workspace__label${available ? ' is-on' : ''}`} data-testid="workbench-session-workspace-label"
    data-state={workspace.state} data-source={workspace.source}>
    {available && open ? <button className="cf-wschip__main" type="button" aria-haspopup="dialog" aria-label={`${c.open}: ${name}`}
      title={`${c.open}: ${name}`} data-testid="workbench-session-workspace-open" disabled={!!view.pending || view.needsReview} onClick={open}>{contents}</button>
      : <span className="cf-wschip__main" title={available ? `${c.project}: ${name}` : c.unavailable}>{contents}</span>}
  </span>
}

export function SessionWorkspaceControls({ controller, view, locale, writable, openNotes }: {
  controller: SessionWorkspaceController; view: SessionWorkspaceView; locale: string; writable: boolean; openNotes?: () => void
}): React.JSX.Element | null {
  const { sid, confirmed, draft, pending, projects, needsReview } = view
  if (!sid) return null
  const workspace = confirmed?.workspace
  const c = labels(locale)
  const issue = view.issue ?? (workspace?.state === 'unavailable' ? 'unavailable' : view.catalogueIssue)
  const options = projects ?? []
  const value = draft?.workspaceId ?? ''
  const present = options.some(({ id }) => id === value)
  const blocked = !writable || !!pending || !!needsReview || !confirmed
  if (!workspace && !issue && !options.length && !value) return null
  return <section className="wb-session-workspace" aria-label={c.title} data-testid="workbench-session-workspace" data-state={workspace?.state ?? 'unbound'}>
    <div className="wb-session-workspace__actions">
      {!!(options.length || value) && <>
        <select className="cf-input" value={value} aria-label={c.chooser} data-testid="workbench-session-workspace-chooser" disabled={!!pending || !confirmed}
          onChange={(event) => controller.choose(sid, event.currentTarget.value || undefined)}>
          <option value="">{c.choose}</option>
          {value && !present && <option value={value} disabled>{c.choiceUnavailable}</option>}
          {options.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
        </select>
        <button className="cf-btn" type="button" data-testid="workbench-session-workspace-bind" disabled={blocked || !present || value === workspace?.id}
          onClick={() => void controller.change(sid)}>{c.attach}</button>
      </>}
      {workspace && <button className="cf-btn" type="button" data-testid="workbench-session-workspace-release" disabled={blocked}
        onClick={() => void controller.change(sid, true)}>{c.detach}</button>}
      {workspace?.state === 'available' && openNotes && <button className="cf-btn" type="button" aria-haspopup="dialog"
        data-testid="workbench-session-workspace-open-notes" disabled={!!pending || needsReview} onClick={openNotes}>{c.notes}</button>}
      <button className="cf-btn" type="button" data-testid="workbench-session-workspace-refresh" disabled={!!pending}
        onClick={() => void controller.refresh(sid)}>{c.reload}</button>
    </div>
    {issue && <p role="alert" data-testid="workbench-session-workspace-status" data-status={issue}>{c[issue]}</p>}
    {pending && <p role="status">{pending === 'notes' ? c.files : c[pending]}</p>}
  </section>
}
