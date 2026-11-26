import { useRef, useSyncExternalStore } from 'react'
import { useI18n } from '../renderer/src/i18n/i18n'
import { AttachmentList, type AttachEntry } from '../renderer/src/redesign/attachments'
import { ComposerAttachmentButton } from '../renderer/src/redesign/ComposerControls'
import { EMPTY_ATTACHMENTS, type AttachmentDraft, type AttachmentDrafts, type AttachmentIssue, type BrowserFiles } from './attachment-drafts'
import { attachmentPreviewUrl, type ChatAttachment } from './chat-transport'

const unsubscribed = () => () => {}
export function useAttachmentDrafts(controller: AttachmentDrafts | undefined, sid: string): AttachmentDraft {
  return useSyncExternalStore(controller?.subscribe ?? unsubscribed, () => controller?.get(sid) ?? EMPTY_ATTACHMENTS)
}

export function attachmentCard(sid: string, { id, name, kind, size }: ChatAttachment): AttachEntry {
  return { id, name, kind, size, ...(kind === 'image' ? { src: { previewUrl: attachmentPreviewUrl(sid, id) } } : {}) }
}

function issueText(issue: AttachmentIssue, zh: boolean): string {
  const size = issue.kind === 'text' ? '512 KiB' : issue.kind === 'image' ? '2 MiB' : '20 MiB'
  const messages: Record<AttachmentIssue['code'], string> = zh ? {
    directory: '此处仅接收文件，已跳过目录。', unreadable: '浏览器未交付可读取的文件。',
    unsupported: '文件类型或内容超出 Web 上传支持范围。支持常见 UTF-8 文本、静态 PNG/JPEG/WebP 和兼容模型的 PDF；GIF、HTML 和 SVG 等仅在桌面功能中处理。',
    name: '文件名无效；请使用有效的文件名重新选择。', empty: '文件为空，已跳过。', large: `文件超出 ${size} 上限。`,
    limit: '每条消息最多添加 4 个附件。', quota: '附件上传额度已用完，请移除草稿附件或稍后再试。',
    uploadFailed: '上传结果未确认，文件未加入草稿。可重新选择该文件。',
    removeFailed: '服务器尚未确认撤回附件。仍显示的附件已停止发送，可再次撤回。',
    expired: '有附件已失效或不可用。移除标记的附件后再重新上传。', invalidContent: '有附件内容校验失败。请移除标记的附件，并检查文件格式。',
    unavailable: '当前对话暂时无法上传附件。', adapter: '所选模型接口不支持这组附件。PDF 需要 Anthropic 或 OpenAI Responses。',
    turnLimit: '这些附件合计超出单条消息的上传限制。', sessionLimit: '当前对话已达到附件存储上限。'
  } : {
    directory: 'Only files can be attached here; the folder was skipped.', unreadable: 'The browser did not supply a readable file.',
    unsupported: 'File type or contents are unsupported in the Web workbench. Use common UTF-8 text, static PNG/JPEG/WebP, or PDF with a compatible model. GIF, HTML and SVG are desktop features.',
    name: 'The filename is invalid. Rename the file and select it again.', empty: 'The file is empty and was skipped.', large: `This file exceeds the ${size} limit.`,
    limit: 'Each message accepts up to 4 attachments.', quota: 'The upload quota was reached. Remove drafts or try again later.',
    uploadFailed: 'The upload was not confirmed; the file was left out of the draft. Select it again to retry.',
    removeFailed: 'The server did not confirm removal. Marked files are blocked from sending and can be removed again.',
    expired: 'Some attachments have expired or are unavailable. Remove the marked files and upload them again.',
    invalidContent: 'Some attachments failed content validation. Remove the marked files and check the file format.',
    unavailable: 'Attachments are unavailable for this conversation right now.', adapter: 'The selected provider adapter does not support these attachments. PDF requires Anthropic or OpenAI Responses.',
    turnLimit: 'These attachments exceed the combined limit for one message.', sessionLimit: 'This conversation has reached its attachment storage limit.'
  }
  return issue.name ? `${issue.name}: ${messages[issue.code]}` : messages[issue.code]
}

export function AttachmentIssues({ draft, dismiss }: { draft: AttachmentDraft; dismiss: () => void }): React.JSX.Element | null {
  const { locale } = useI18n()
  if (!draft.issues.length) return null
  const zh = locale === 'zh-CN'
  return <div className="wb-attachment__issues" data-testid="workbench-attachment-feedback">
    <div role="alert">{draft.issues.map((issue, i) => <p key={i}>{issueText(issue, zh)}</p>)}</div>
    <button type="button" className="cf-empty__action" onClick={dismiss}>{zh ? '关闭提示' : 'Dismiss'}</button>
  </div>
}

export function AttachmentPicker({ add, disabled }: { add: (files: BrowserFiles) => void; disabled: boolean }): React.JSX.Element {
  const input = useRef<HTMLInputElement>(null)
  return <>
    <input ref={input} type="file" multiple hidden disabled={disabled} data-testid="workbench-attachment-input"
      onChange={(event) => {
        const files = Array.from(event.currentTarget.files ?? [])
        event.currentTarget.value = ''
        if (files.length) add({ files, issues: [] })
      }} />
    <ComposerAttachmentButton disabled={disabled} onClick={() => input.current?.click()} testId="workbench-attachment-picker" />
  </>
}

export function AttachmentDraftCards({ sid, draft, remove }: {
  sid: string; draft: AttachmentDraft; remove?: (key: string) => void
}): React.JSX.Element | null {
  const { locale } = useI18n()
  if (!draft.entries.length) return null
  const zh = locale === 'zh-CN'
  const statusText = { uploading: zh ? '正在上传' : 'Uploading', removing: zh ? '正在撤回' : 'Removing',
    expired: zh ? '附件已失效' : 'Attachment unavailable' }
  return <>
    <AttachmentList variant="composer" entries={draft.entries.map((entry) => ({
      ...(entry.status === 'ready' && entry.attachment ? attachmentCard(sid, entry.attachment) : { name: entry.name, kind: entry.kind, size: entry.size }),
      id: entry.key, removable: entry.status !== 'removing'
    }))} onRemove={remove} testId="workbench-draft-attachments" />
    <div className="wb-attachment__draft-status">
      <span role="status">{draft.entries.flatMap(({ name, status }) => status === 'ready' ? [] : [`${name}: ${statusText[status]}`]).join(' · ')}</span>
      {remove && <button type="button" className="cf-empty__action" data-testid="workbench-attachment-clear"
        disabled={draft.entries.every(({ status }) => status === 'removing')}
        onClick={() => { for (const { key } of draft.entries) remove(key) }}>{zh ? '取消全部附件' : 'Cancel all attachments'}</button>}
    </div>
  </>
}

export function AttachmentHint(): React.JSX.Element {
  const { locale } = useI18n()
  return <p className="wb-attachment__hint">{locale === 'zh-CN'
    ? '可选取、粘贴或拖入最多 4 个文件。点击发送后，附件才会提交给模型。'
    : 'Choose, paste, or drop up to 4 files. Attachments are sent to the model only when you press Send.'}</p>
}
