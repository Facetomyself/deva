import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { MemoryEntry, MemoryErrorCode, MemoryIpcResult, MemoryScopeArg, MemorySnapshot, MemoryType } from '../../../preload'
import { useI18n } from '../i18n/i18n'
import { useDialog } from '../components/DialogProvider'
import { useToast } from '../components/ToastProvider'
import { fill } from './memory-editor'
import './memory-detail.css'

/**
 * 记忆详情编辑页（对比稿 design/memory-ui.html，个人资料面板与角色资料页共用）：标题、正文（撑满剩余高度），
 * 底部左「删除」（二次确认）、右「取消 / 保存」。不加字段名。与模型的 memory_* 工具同一套校验。
 * 不显示也不改类型：条目都由模型写入，类型由模型定；保存不传 type，主进程沿用原类型。
 * 放在弹窗里与 .cf-editor 平级（自带内边距），弹窗高度由调用方定。
 */

export function MemoryDetail({
  entry,
  scope,
  onClose,
  onChanged,
  web
}: {
  entry: MemoryEntry
  /** 记忆所在的层：省略 = 全局；`{ personaId }` = 角色记忆。 */
  scope?: MemoryScopeArg
  onClose: () => void
  /** 改动或删除之后：带最新快照；省略 = 列表需要重新读取（如条目已被别处删掉）。 */
  onChanged: (snapshot?: MemorySnapshot) => void
  web?: {
    types: readonly { value: MemoryType; label: string }[]
    typeLabel: string
    locked: boolean
    limits: Pick<MemorySnapshot, 'maxTitle' | 'maxBody' | 'maxEntries' | 'budget'>
    write: (input: Pick<MemoryEntry, 'type' | 'title' | 'body'>) => Promise<MemoryIpcResult>
    remove?: () => Promise<MemoryIpcResult>
  }
}): React.JSX.Element {
  const { t } = useI18n()
  const dialog = useDialog()
  const toast = useToast()
  const [title, setTitle] = useState(entry.title)
  const [body, setBody] = useState(entry.body)
  const [type, setType] = useState(entry.type)
  const [error, setError] = useState<MemoryErrorCode | null>(null)
  const [pending, setPending] = useState(false)

  // 写操作统一收口：成功交回快照并关闭；条目已被别处删掉则提示并让列表重读；其余错误显示在按钮上方。
  const run = async (op: () => Promise<{ ok: true; snapshot: MemorySnapshot } | { ok: false; code: MemoryErrorCode }>): Promise<void> => {
    if (pending || web?.locked) return
    setPending(true)
    try {
      const r = await op()
      if (r.ok) {
        onChanged(r.snapshot)
        onClose()
      } else if (r.code === 'notFound') {
        toast.show({ title: t('cf.profile.err.notFound'), variant: 'error' })
        onChanged()
        onClose()
      } else setError(r.code)
    } catch {
      if (!web) toast.show({ title: t('cf.profile.err.failed'), variant: 'error' })
    } finally {
      setPending(false)
    }
  }

  const save = (): void => {
    if (title.trim() === entry.title && body.trim() === entry.body && type === entry.type) return onClose()
    void run(() => web ? web.write({ type, title, body }) : window.deva.memory.write({ title, body }, entry.id, scope))
  }
  const remove = async (): Promise<void> => {
    const ok = await dialog.confirm({
      title: t('cf.profile.memDelete'),
      message: fill(t('cf.profile.memDeleteConfirm'), { content: entry.title }),
      confirmText: t('cf.profile.memDelete'),
      variant: 'danger'
    })
    if (ok) void run(() => web?.remove ? web.remove() : window.deva.memory.remove(entry.id, scope))
  }

  return (
    <div className="cf-editor cf-memdetail" data-testid={web ? 'workbench-memory-editor' : undefined}>
      {web && <label className="wb-library__field">{web.typeLabel}
        <select className="cf-input" value={type} disabled={pending} onChange={(e) => { setType(e.target.value as MemoryType); setError(null) }}>
          {web.types.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
      </label>}
      <input
        className="cf-input"
        value={title}
        maxLength={web?.limits.maxTitle ?? 60}
        data-testid={web ? 'workbench-memory-title' : undefined}
        disabled={web ? pending : undefined}
        placeholder={t('cf.memTitle')}
        aria-label={t('cf.memTitle')}
        onChange={(e) => {
          setTitle(e.target.value)
          setError(null)
        }}
      />
      <textarea
        className="cf-memdetail__body"
        value={body}
        maxLength={web?.limits.maxBody ?? 1500}
        data-testid={web ? 'workbench-memory-body' : undefined}
        disabled={web ? pending : undefined}
        placeholder={t('cf.memBody')}
        aria-label={t('cf.memBody')}
        onChange={(e) => {
          setBody(e.target.value)
          setError(null)
        }}
      />
      {error && <div className="cf-me__err">{fill(t(`cf.profile.err.${error}`), { max: web?.limits.maxTitle ?? 60, entries: web?.limits.maxEntries ?? 100, budget: web?.limits.budget ?? 4000 })}</div>}
      <div className="cf-editor__actions">
        {(!web || web.remove) && <button type="button" className="cf-memdetail__del" disabled={pending || web?.locked} onClick={() => void remove()}>
          <Trash2 size={14} />
          {t('cf.profile.memDelete')}
        </button>}
        <button type="button" className="cf-btn" disabled={web ? pending : undefined} onClick={onClose}>
          {t('cf.cancel')}
        </button>
        <button type="button" className="cf-btn is-primary" data-testid={web ? 'workbench-memory-save' : undefined} disabled={pending || web?.locked || !title.trim()} onClick={save}>
          {t('cf.save')}
        </button>
      </div>
    </div>
  )
}
