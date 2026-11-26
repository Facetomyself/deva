import { useEffect, useId, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, X } from 'lucide-react'
import { useI18n } from '../renderer/src/i18n/i18n'
import { authorizedWorkspaceId, bindWorkspaceGitView, type WorkspaceGitView } from './git-view-controller'
import { WorkspaceGitPanel } from './git-view-panel'
import { bindTerminalView, terminalTarget, type TerminalView } from './terminal-view-controller'
import { TerminalViewer } from './terminal-view-panel'
import { type FileDraft, type WorkspaceFiles, type WorkspaceFilesView } from './workspace-files'
import { workspaceEditorText } from './workspace-line-endings'
import './workspace-dialog.css'

const copy = {
  'zh-CN': {
    title: '工作区文件', project: '工作区', choose: '选择已授权的工作区', none: '没有可用的授权工作区。',
    manual: '仅供手动浏览和编辑。工作区和文件内容与当前对话分开。', tree: '文件和目录', empty: '此目录为空。',
    loading: '正在读取…', selectFile: '从左侧选择文件。', drafts: '保留的草稿', editor: '文件文本',
    readonly: '只读', dirty: '有未保存的修改', saving: '正在保存…', saved: '已保存',
    binary: '这是二进制文件，仅显示文件详情。', tooLarge: '文件超过预览大小上限，仅显示文件详情。',
    expired: '所有者会话已过期。草稿仍留在此页面，可在重新登录前复制。',
    replaced: '此工作区已移除或更换。草稿仍留在此页面，文件操作已停用。',
    readFailure: '读取失败，请重试。', saveFailure: '保存未获确认，草稿已保留。', fileLimit: '文件超过保存大小上限，草稿已保留。',
    conflict: '文件在磁盘上已更改。草稿已保留，请重新读取并核对磁盘版本。',
    reviewing: '已读取磁盘版本。核对后可继续使用草稿，或用磁盘版本替换草稿。',
    disk: '最新磁盘版本', useDraft: '继续使用草稿', useDisk: '丢弃草稿并使用磁盘版本',
    save: '保存', reload: '重新读取', retry: '重试', close: '关闭',
  },
  en: {
    title: 'Workspace files', project: 'Workspace', choose: 'Choose an authorized workspace', none: 'No authorized workspaces are available.',
    manual: 'Browse and edit files manually. The workspace and its contents stay separate from this chat.', tree: 'Files and folders', empty: 'This folder is empty.',
    loading: 'Reading…', selectFile: 'Select a file on the left.', drafts: 'Kept drafts', editor: 'File text',
    readonly: 'Read-only', dirty: 'Unsaved changes', saving: 'Saving…', saved: 'Saved',
    binary: 'Binary file. Only file details are available.', tooLarge: 'File exceeds the preview limit. Only file details are available.',
    expired: 'The owner session expired. Your drafts are still on this page; copy them before signing in again.',
    replaced: 'This workspace was removed or replaced. Your drafts are still on this page; file operations are disabled.',
    readFailure: 'Reading failed. Try again.', saveFailure: 'The save was not confirmed. Your draft was kept.', fileLimit: 'File exceeds the save limit. Your draft was kept.',
    conflict: 'The file changed on disk. Your draft was kept. Reload and review the disk version.',
    reviewing: 'The disk version has been loaded. Review it before keeping your draft or replacing it with the disk version.',
    disk: 'Latest disk version', useDraft: 'Keep draft', useDisk: 'Discard draft and use disk version',
    save: 'Save', reload: 'Reload from disk', retry: 'Retry', close: 'Close',
  }
}
type Copy = (typeof copy)['en']

export function WorkspaceFilesPanel({ open, close, controller, git, terminal }: {
  open: boolean; close: () => void; controller: WorkspaceFiles; git?: WorkspaceGitView; terminal?: TerminalView
}): React.JSX.Element | null {
  const view = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot)
  useLayoutEffect(() => open && git ? bindWorkspaceGitView(git, controller) : undefined, [open, git, controller])
  useLayoutEffect(() => {
    if (!open || !terminal) return
    const unbind = bindTerminalView(terminal, controller)
    window.addEventListener('pagehide', terminal.dismiss)
    window.addEventListener('offline', terminal.disconnect)
    return () => {
      window.removeEventListener('pagehide', terminal.dismiss)
      window.removeEventListener('offline', terminal.disconnect)
      unbind()
    }
  }, [open, terminal, controller])
  useEffect(() => {
    if (!view.anyDirty) return
    const warn = (event: BeforeUnloadEvent): void => { event.preventDefault(); event.returnValue = true }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [view.anyDirty])
  return open ? <WorkspaceFilesDialog view={view} api={controller} close={() => { terminal?.dismiss(); close() }} git={git} terminal={terminal} /> : null
}

function WorkspaceFilesDialog({ view, api, close, git, terminal }: {
  view: WorkspaceFilesView; api: WorkspaceFiles; close: () => void; git?: WorkspaceGitView; terminal?: TerminalView
}): React.JSX.Element {
  const labels = copy[useI18n().locale === 'zh-CN' ? 'zh-CN' : 'en']
  const title = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const element = dialog.current!
    element.showModal()
    return () => { if (element.open) element.close() }
  }, [])
  const projectList = view.projects.data ?? []
  const gitWorkspaceId = git ? authorizedWorkspaceId(view) : undefined
  return <dialog ref={dialog} className="modal__card wb-workspace" aria-labelledby={title} data-testid="workbench-workspace-dialog"
    onCancel={(event) => { event.preventDefault(); close() }} onKeyDown={(event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        event.stopPropagation()
        if (!(event.target instanceof Element) || !event.target.closest('[data-workspace-git], [data-workspace-tty]')) void api.save()
      }
    }}>
    <div className="wb-workspace__head">
      <h2 className="modal__title" id={title}>{labels.title}</h2>
      <button type="button" className="cf-modal__close" data-testid="workbench-workspace-close" aria-label={labels.close} onClick={close}><X size={17} /></button>
    </div>
    <p className="wb-workspace__muted">{labels.manual}</p>
    <div className="wb-workspace__project-picker">
      <label className="wb-workspace__project">
        {labels.project}
        <select className="input" data-testid="workbench-workspace-select" value={view.projectId} disabled={!projectList.length}
          onChange={(event) => void api.select(event.currentTarget.value)}>
          <option value="">{labels.choose}</option>
          {projectList.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      {git && gitWorkspaceId && <WorkspaceGitPanel controller={git} workspaceId={gitWorkspaceId} />}
    </div>
    {view.issue && <p className="wb-workspace__alert" role="alert" data-testid="workbench-workspace-status" data-status={view.issue}>{labels[view.issue]}</p>}
    {!view.issue && view.projects.pending && <p role="status">{labels.loading}</p>}
    {!view.issue && view.projects.issue && <p className="wb-workspace__alert" role="alert">{labels[view.projects.issue]}{' '}
      <button type="button" className="cf-btn" onClick={() => void api.loadProjects()}>{labels.retry}</button>
    </p>}
    {view.projects.data?.length === 0 && <p className="wb-workspace__muted">{labels.none}</p>}
    {!!view.projectId && <div className="wb-workspace__body">
      <nav className="wb-workspace__tree" aria-label={labels.tree}>
        {!view.issue && <Directory path="" view={view} api={api} labels={labels} />}
        {!!view.drafts.length && <div className="wb-workspace__drafts">
          <span className="wb-workspace__muted">{labels.drafts}</span>
          <ul>{view.drafts.map((path) => <li key={path}>
            <button type="button" className="wb-workspace__entry" title={path} aria-current={view.file?.path === path || undefined}
              onClick={() => void api.openFile(path)}><FileText size={14} /><span>{path}</span></button>
          </li>)}</ul>
        </div>}
      </nav>
      {view.file ? <FileDetails file={view.file} view={view} api={api} labels={labels} terminal={terminal} /> : <p className="wb-workspace__muted">{labels.selectFile}</p>}
    </div>}
  </dialog>
}

function Directory({ path, view, api, labels }: { path: string; view: WorkspaceFilesView; api: WorkspaceFiles; labels: Copy }): React.JSX.Element | null {
  const directory = view.directories.get(path)
  if (directory?.pending) return <p className="wb-workspace__muted" role="status">{labels.loading}</p>
  if (directory?.issue) return <p className="wb-workspace__alert" role="alert">{labels[directory.issue]}{' '}
    <button type="button" className="cf-btn" onClick={() => void api.list(path)}>{labels.retry}</button>
  </p>
  if (!directory?.data) return null
  if (!directory.data.entries.length) return <p className="wb-workspace__muted">{labels.empty}</p>
  return <ul>{directory.data.entries.map((entry) => {
    const dir = entry.type === 'dir'
    const expanded = dir && view.expanded.has(entry.path)
    return <li key={entry.path}>
      <button type="button" className="wb-workspace__entry" title={entry.path}
        aria-expanded={dir ? expanded : undefined} aria-current={!dir && view.file?.path === entry.path || undefined}
        data-testid="workbench-workspace-entry" data-path={entry.path} data-type={entry.type}
        onClick={() => void (dir ? api.toggle(entry.path) : api.openFile(entry.path))}>
        {dir ? expanded ? <><ChevronDown size={12} /><FolderOpen size={15} /></> : <><ChevronRight size={12} /><Folder size={15} /></> : <FileText size={15} />}
        <span>{entry.name}</span>
      </button>
      {expanded && <Directory path={entry.path} view={view} api={api} labels={labels} />}
    </li>
  })}</ul>
}

function FileDetails({ file, view, api, labels, terminal }: {
  file: FileDraft; view: WorkspaceFilesView; api: WorkspaceFiles; labels: Copy; terminal?: TerminalView
}): React.JSX.Element {
  const target = terminal && terminalTarget(view)
  const editing = view.writable && file.pending !== 'read'
  const nonText = file.disk?.kind === 'text' ? undefined : file.disk?.kind
  const status = file.pending === 'save' ? 'saving' : file.pending === 'read' ? 'loading' :
    file.issue ?? (file.review ? 'reviewing' : nonText ?? (file.saved ? 'saved' : view.dirty ? 'dirty' : file.disk && !view.writable ? 'readonly' : undefined))
  return <section className="wb-workspace__file" aria-label={file.path}>
    <div className="wb-workspace__filebar">
      <strong title={file.path}>{file.path}</strong>
      {!view.issue && <>
        <button className="cf-btn" type="button" data-testid="workbench-workspace-reload" disabled={!!file.pending} onClick={() => void api.reload()}>{labels.reload}</button>
        <button className="btn btn--primary" type="button" data-testid="workbench-workspace-save" title={`${labels.save} (Ctrl / Cmd + S)`}
          disabled={!api.canSave()} onClick={() => void api.save()}>{labels.save}</button>
      </>}
    </div>
    {status && !view.issue && <p className={file.issue && file.issue !== 'readonly' ? 'wb-workspace__alert' : 'wb-workspace__muted'}
      role={file.issue && file.issue !== 'readonly' ? 'alert' : 'status'} data-testid="workbench-workspace-status" data-status={status}>{labels[status]}</p>}
    <TerminalViewer api={terminal} target={target}>
      {file.text !== undefined && <textarea className="input wb-workspace__editor" data-testid="workbench-workspace-editor"
        aria-label={labels.editor} spellCheck={false} value={file.text} readOnly={!editing} onChange={(event) => api.edit(workspaceEditorText(file.text ?? '', event.currentTarget.value))} />}
    </TerminalViewer>
    {file.review && file.disk?.kind === 'text' && !view.issue && <div className="wb-workspace__review">
      <label>{labels.disk}<textarea className="input wb-workspace__editor" aria-label={labels.disk} value={file.disk.content} readOnly /></label>
      <div className="wb-workspace__review-actions">
        <button className="cf-btn" type="button" disabled={!!file.pending} onClick={() => api.review(false)}>{labels.useDraft}</button>
        <button className="cf-btn" type="button" disabled={!!file.pending} onClick={() => api.review(true)}>{labels.useDisk}</button>
      </div>
    </div>}
  </section>
}
