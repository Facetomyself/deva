import { useEffect, useState } from 'react'
import { DeliverablesView, formatDeliverableSize, type DeliverableViewRow } from './DeliverablesView'
import { useI18n } from '../../i18n/i18n'
import { type ChatBlock, useChatState } from '../../store/chat'
import { useToast } from '../../components/ToastProvider'
import type { DeliverableInfo } from '../../../../shared/deliverables'

/**
 * 交付卡（present_files 成功后，回合结束时排在回复末尾，见 DeliveryCards）：模型交付给用户的成品文件，每个一行——
 * 缩略图（系统缩略图 / 文件图标）、文件名、大小与所在目录，操作：打开 / 在文件夹中显示 / 复制路径。
 * 卡片内容取自主进程（按对话 id + 调用 id 从历史里取路径），重开对话同样还原；文件被移走则标「已不存在」。
 */

// 缩略图按「对话:调用:序号」缓存：滚动 / 重渲染时不反复向系统要图。
const thumbCache = new Map<string, string | null>()

/**
 * 主进程信息到达前，先按调用参数画出文件名，避免卡片高度跳动。参数是模型原样发出的（可能是相对路径、
 * 可能重复），只取文件名占位；真实路径以 inspect 返回的为准。
 */
function placeholders(args: unknown): DeliverableInfo[] {
  const paths = (args as { paths?: unknown } | null)?.paths
  if (!Array.isArray(paths)) return []
  return [...new Set(paths.filter((p): p is string => typeof p === 'string'))]
    .map((p) => {
      const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
      return { path: p, name: p.slice(cut + 1), dir: p.slice(0, Math.max(cut, 0)), size: 0, openable: false }
    })
}

export function DeliverablesCard({
  block
}: {
  block: Extract<ChatBlock, { kind: 'tool' }>
}): React.JSX.Element {
  const { t } = useI18n()
  const toast = useToast()
  const { currentSessionId: sessionId } = useChatState()
  const [files, setFiles] = useState<DeliverableInfo[]>(() => placeholders(block.args))
  const [loaded, setLoaded] = useState(false)
  const [thumbs, setThumbs] = useState<Record<number, string | null>>({})
  const [copied, setCopied] = useState<number | null>(null)

  useEffect(() => {
    let alive = true
    void window.deva.deliverables
      .inspect(sessionId, block.id)
      .then((list) => {
        if (!alive) return
        setFiles(list)
        setLoaded(true)
        list.forEach((f, i) => {
          if (f.size === null) return
          const key = `${sessionId}:${block.id}:${i}`
          if (thumbCache.has(key)) {
            setThumbs((prev) => ({ ...prev, [i]: thumbCache.get(key) ?? null }))
            return
          }
          void window.deva.deliverables
            .thumbnail(sessionId, block.id, i)
            .catch(() => null)
            .then((url) => {
              thumbCache.set(key, url)
              if (alive) setThumbs((prev) => ({ ...prev, [i]: url }))
            })
        })
      })
      .catch(() => {
        if (alive) setLoaded(true)
      })
    return () => {
      alive = false
    }
  }, [sessionId, block.id])

  useEffect(() => {
    if (copied === null) return
    const h = setTimeout(() => setCopied(null), 1500)
    return () => clearTimeout(h)
  }, [copied])

  const open = (i: number): void => {
    void window.deva.deliverables
      .open(sessionId, block.id, i)
      .catch(() => ({ ok: false }))
      .then((r) => {
        if (!r.ok) toast.show({ variant: 'error', message: t('chat.deliver.openFailed') })
      })
  }

  const reveal = (i: number): void => {
    void window.deva.deliverables
      .reveal(sessionId, block.id, i)
      .catch(() => ({ ok: false }))
      .then((r) => {
        if (!r.ok) toast.show({ variant: 'error', message: t('chat.deliver.missing') })
      })
  }

  // 优先走原生 clipboard 桥（sandbox 下最稳），失败回退 navigator.clipboard。
  const copyPath = (i: number, path: string): void => {
    void window.deva.clipboard
      .writeText(path)
      .catch(() => navigator.clipboard.writeText(path))
      .then(
        () => setCopied(i),
        () => {}
      )
  }

  const platform = window.deva.platform
  // 所在目录：在角色的默认工作区里写「Deva 的工作区」（子目录接在后面），不写一长串路径；完整路径在悬停提示里。
  const dirLabel = (f: DeliverableInfo): string => {
    if (!f.home) return f.dir
    const label = t('chat.deliver.roleHome').replace('{name}', f.home.role)
    return f.home.rel ? `${label}${platform === 'win32' ? '\\' : '/'}${f.home.rel}` : label
  }
  const revealLabel = t(
    platform === 'win32'
      ? 'chat.deliver.revealWin'
      : platform === 'darwin'
        ? 'chat.deliver.revealMac'
        : 'chat.deliver.revealOther'
  )
  // 保留原始序号：打开、定位和复制仍由 Electron 的上下文与 IPC 完成。
  const rows = files.map((f, i): DeliverableViewRow => {
    const missing = loaded && f.size === null
    const available = loaded && !missing
    const canOpen = available && f.openable
    const actions: DeliverableViewRow['actions'][number][] = []
    if (canOpen) actions.push({ id: 'open', label: t('chat.deliver.open'), onClick: () => open(i) })
    actions.push(
      { id: 'locate', label: revealLabel, onClick: () => reveal(i), disabled: !available },
      { id: 'copy', label: t('chat.deliver.copyPath'), onClick: () => copyPath(i, f.path), copied: copied === i }
    )
    return {
      key: f.path,
      index: i,
      name: f.name,
      title: f.path,
      thumb: thumbs[i],
      missing,
      detail: missing ? t('chat.deliver.missing') : loaded ? `${formatDeliverableSize(f.size ?? 0)} · ${dirLabel(f)}` : dirLabel(f),
      // 点整行：能打开就打开，否则在文件夹中显示（可执行 / 脚本类文件不直接打开）。
      primary: available ? () => canOpen ? open(i) : reveal(i) : undefined,
      actions
    }
  })

  return (
    <DeliverablesView
      title={t('chat.deliver.title')}
      labels={{
        count: (n) => t(n === 1 ? 'chat.deliver.countOne' : 'chat.deliver.count').replace('{n}', String(n)),
        collapsed: (name, n) => t('chat.deliver.collapsedMany')
          .replace('{name}', name).replace('{n}', String(n)).replace('{rest}', String(n - 1)),
        expand: (remaining) => t('chat.deliver.expand').replace('{n}', String(remaining)),
        collapse: t('chat.deliver.collapse')
      }}
      rows={rows}
    />
  )
}
