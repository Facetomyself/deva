import type { ProjectDocuments, ProjectDocumentView } from './project-document-controller'
import './project-document.css'

const copy = {
  en: {
    new: 'New document', resume: 'Resume document draft', draftTitle: 'New document draft', parent: 'Folder', root: 'Project root (/)',
    name: 'File name (.md or .txt)', content: 'Document text', empty: 'An empty document is allowed.', target: 'Target path',
    review: 'Review', create: 'Create document', cancel: 'Cancel', verify: 'Verify create result', checkFolder: 'Reveal target folder',
    draft: 'Draft only. Review checks the path without creating a file.', preparing: 'Checking target…',
    prepared: 'Target checked. The file has not been created.', creating: 'Creating file…', verifying: 'Checking file and contents…',
    unconfirmed: 'Create result unconfirmed. The draft has been kept.', saved: 'Document saved',
    directory: 'Select a confirmed writable folder from this project.', nameIssue: 'Use an ordinary .md or .txt name, up to 200 UTF-8 bytes.',
    limit: 'The name, path, or document text exceeds its size limit (text: 2 MiB).', invalid: 'The document name or text is invalid.', readonly: 'This location is read-only.',
    restricted: 'This location or file name is restricted.', expired: 'Your session expired. Copy the draft before signing in again.',
    missing: 'The target or review is missing or expired. The draft has been kept.', exists: 'That file already exists. Enter a different name.',
    changed: 'The target folder or file changed. Review the target again.', conflict: 'The target conflicts with the reviewed location. The draft has been kept.',
    busy: 'The document service is busy. Your draft is still here.', unavailable: 'The document check is unavailable. Your draft is still here.',
    notCreated: 'The review reports no creation. Review again before creating.',
  },
  'zh-CN': {
    new: '新建文档', resume: '继续编辑文档草稿', draftTitle: '新建文档草稿', parent: '文件夹', root: '项目根目录 (/)',
    name: '文件名（.md 或 .txt）', content: '文档正文', empty: '正文可为空。', target: '目标路径',
    review: '核对目标', create: '创建文档', cancel: '取消', verify: '核实创建结果', checkFolder: '定位目标文件夹',
    draft: '当前仅为草稿。核对目标时仅检查路径。', preparing: '正在检查目标…',
    prepared: '目标已核对，文件尚未创建。', creating: '正在创建文件…', verifying: '正在核实文件与正文…',
    unconfirmed: '创建结果尚未确认，草稿已保留。', saved: '文档已保存',
    directory: '请选择本项目中已确认可写的文件夹。', nameIssue: '请输入普通的 .md 或 .txt 文件名，最多 200 个 UTF-8 字节。',
    limit: '文件名、路径或正文超过大小上限（正文限 2 MiB）。', invalid: '文件名或正文无效。', readonly: '此位置为只读。',
    restricted: '此位置或文件名受限。', expired: '会话已过期，请在重新登录前复制草稿。',
    missing: '目标或核对记录已失效或不存在，草稿已保留。', exists: '同名文件已存在，请更换文件名。',
    changed: '目标文件夹或文件已变更，请重新核对。', conflict: '目标与核对时的位置冲突，草稿已保留。',
    busy: '文档服务正忙，草稿已保留。', unavailable: '文档核对服务暂不可用，草稿已保留。',
    notCreated: '核实结果显示文件尚未创建。创建前请重新核对目标。',
  }
} as const

type Locale = keyof typeof copy
const pending = (phase: ProjectDocumentView['phase']): boolean => phase === 'preparing' || phase === 'creating' || phase === 'verifying'

export function ProjectDocumentNew({ view, api, locale }: { view: ProjectDocumentView; api: ProjectDocuments; locale: Locale }): React.JSX.Element | null {
  const labels = copy[locale]
  return view.canNew ? <button className="cf-btn wb-document__new" type="button" data-testid="workbench-document-new"
    title={view.retained ? labels.resume : undefined} onClick={() => api.begin()}>{labels.new}</button> : null
}

export function ProjectDocumentStatus({ view, locale }: { view: ProjectDocumentView; locale: Locale }): React.JSX.Element | null {
  if (!view.phase) return null
  const labels = copy[locale]
  const issue = view.issue === 'name' ? 'nameIssue' : view.issue
  return <p className={issue ? 'wb-workspace__alert wb-document__status' : 'wb-workspace__muted wb-document__status'}
    role="status" tabIndex={-1} data-testid="workbench-document-status" data-state={view.phase} data-issue={view.issue}>
    {pending(view.phase) && <span className="wb-document__spinner" aria-hidden="true" />}
    {labels[view.phase]}{issue && issue !== view.phase ? ` ${labels[issue]}` : ''}
    {view.savedPath && <>: <code>/{view.savedPath}</code></>}
  </p>
}

export function ProjectDocumentDraft({ view, api, locale }: { view: ProjectDocumentView; api: ProjectDocuments; locale: Locale }): React.JSX.Element | null {
  const draft = view.draft
  if (!draft) return null
  const labels = copy[locale]
  const prepared = view.phase === 'prepared' || view.phase === 'creating'
  const uncertain = view.phase === 'unconfirmed' || view.issue === 'unconfirmed' || draft.uncertainPath === view.preview && !!draft.uncertainPath
  return <section aria-label={labels.draftTitle} className="wb-document" data-testid="workbench-document-draft" data-workspace-document="true">
    <strong>{labels.draftTitle}</strong>
    <label>{labels.parent}
      <select className="input" data-testid="workbench-document-parent" value={draft.directory} disabled={!view.editable}
        onChange={(event) => api.update({ directory: event.currentTarget.value })}>
        {!view.folders.includes(draft.directory) && <option value={draft.directory} disabled>{draft.directory ? `/${draft.directory}` : labels.root}</option>}
        {view.folders.map((folder) => <option key={folder} value={folder}>{folder ? `/${folder}` : labels.root}</option>)}
      </select>
    </label>
    <label>{labels.name}
      <input className="input" data-testid="workbench-document-name" aria-invalid={view.issue === 'name' || undefined}
        spellCheck={false} value={draft.name} readOnly={!view.editable} onChange={(event) => api.update({ name: event.currentTarget.value })} />
    </label>
    {view.preview && <p className="wb-document__preview">{labels.target}: <code>/{view.preview}</code></p>}
    <label>{labels.content}
      <textarea className="input wb-workspace__editor" data-testid="workbench-document-content" spellCheck={false} value={draft.content}
        readOnly={!view.editable} onChange={(event) => api.update({ content: event.currentTarget.value })} />
      {!draft.content && <span className="wb-workspace__muted">{labels.empty}</span>}
    </label>
    <ProjectDocumentStatus view={view} locale={locale} />
    <div className="wb-workspace__review-actions">
      {view.canVerify ? <button className="btn btn--primary" type="button" data-testid="workbench-document-verify"
        onClick={(event) => { if (event.nativeEvent.isTrusted) void api.verify() }}>{labels.verify}</button>
        : prepared ? <button className="btn btn--primary" type="button" data-testid="workbench-document-create" disabled={!view.canCreate}
          onClick={(event) => { if (event.nativeEvent.isTrusted) void api.create() }}>{labels.create}</button>
          : !uncertain && <button className="btn btn--primary" type="button" data-testid="workbench-document-review" disabled={!view.canReview}
            onClick={(event) => { if (event.nativeEvent.isTrusted) void api.prepare() }}>{labels.review}</button>}
      {uncertain && <button className="cf-btn" type="button" data-testid="workbench-document-folder-check" onClick={() => void api.checkFolder()}>{labels.checkFolder}</button>}
      <button className="cf-btn" type="button" data-testid="workbench-document-cancel" onClick={() => api.dismiss(true)}>{labels.cancel}</button>
    </div>
  </section>
}
