import { useId, useMemo, useState } from 'react'
import { FileText } from 'lucide-react'
import { FileCardLabel } from '../../renderer/src/redesign/FileCardLabel'
import type { AttachmentIssue } from './read-text-file'

type Translate = (en: string, zh: string) => string

export function attachmentIssue(problem: AttachmentIssue, t: Translate) {
  switch (problem) {
    case 'name': return t('Choose a .txt or .md file with a valid name.', '请选择名称有效的 .txt 或 .md 文件。')
    case 'empty': return t('Choose a file containing text.', '请选择含有文字的文件。')
    case 'size': return t('Choose a file up to 32 KiB.', '请选择 32 KiB 以内的文件。')
    case 'utf8': return t('Choose a file encoded as UTF-8.', '请选择 UTF-8 编码的文件。')
    case 'content': return t('This file contains unsupported characters.', '此文件含有无效字符。')
    default: return t('Could not read this file. Choose it again or pick another.', '读取文件失败，请重新选择。')
  }
}

const encoder = new TextEncoder()

export function TextAttachmentCard({ name, text, size, onRemove, t }: {
  name: string; text?: string; size?: number; onRemove?: () => void; t: Translate
}) {
  const [expanded, setExpanded] = useState(false)
  const contentId = useId()
  const sent = !onRemove
  const bytes = useMemo(() => (size ?? encoder.encode(text).length).toLocaleString(), [size, text])
  const meta = t(`${bytes} B`, `${bytes} 字节`) + (sent ? '' : t(' · Not sent', ' · 尚未发送'))
  return <div className="web-attachment" data-testid={sent ? 'sent-attachment' : 'draft-attachment'}>
    <div className={`cf-fcard web-attachment__card${sent ? ' is-sent' : ''}`}>
      <FileCardLabel icon={<FileText size={19} strokeWidth={1.8} />} name={<bdi title={name}>{name}</bdi>} meta={meta} />
      <div className="web-attachment__actions">
        {text === undefined ? <span className="web-muted" role="status"><span className="web-spinner" aria-hidden="true" />{t('Reading…', '读取中…')}</span> :
          <button type="button" className="web-secondary" data-testid={sent ? 'sent-attachment-preview' : 'attachment-preview'}
            aria-expanded={expanded} aria-controls={expanded ? contentId : undefined}
            aria-label={expanded ? t(`Hide preview of ${name}`, `收起 ${name} 的预览`) : t(`Preview ${name}`, `预览 ${name}`)}
            onClick={() => setExpanded(!expanded)}>{expanded ? t('Hide preview', '收起预览') : t('Preview', '预览')}</button>}
        {onRemove && <button type="button" className="web-secondary" data-testid="attachment-remove"
          aria-label={t(`Remove ${name}`, `移除 ${name}`)} onClick={onRemove}>{t('Remove', '移除')}</button>}
      </div>
    </div>
    {text !== undefined && expanded && <pre id={contentId} tabIndex={0} aria-label={name} data-testid="attachment-content">{text}</pre>}
  </div>
}
