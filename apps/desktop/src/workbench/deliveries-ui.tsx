import { useLayoutEffect, useMemo, useSyncExternalStore } from 'react'
import { DeliverablesView, formatDeliverableSize, type DeliverableViewRow } from '../renderer/src/features/chat/DeliverablesView'
import { createDeliveriesController, emptyDeliveries, type DeliveriesController, type DeliveriesState } from './deliveries-controller'
import type { DeliveriesTransport, DeliveryCandidate, DeliveryGroup, DeliveryLocation } from './deliveries-transport'
import './deliveries.css'

const copy = {
  'zh-CN': {
    title: '对话交付记录', desktop: '桌面交付历史', reply: '用户导出的回复',
    loading: '正在读取交付记录…', pending: '正在处理交付操作…', more: '更多交付记录', retry: '刷新交付记录',
    md: '导出 Markdown', txt: '导出纯文本', format: '导出回复', empty: '这条记录没有可展示的文件。',
    downloadLabel: '下载文件', preview: '预览图片', closePreview: '关闭预览', workspace: '在工作区文件面板中定位',
    source: '定位到交付卡与原回复', card: '定位到交付卡', copy: '复制文件名', close: '关闭提示',
    ready: '可用', missing: '交付记录或文件已不存在。', nonDownloadable: '此文件未开放下载。', missingFile: '文件已不存在',
    tooLarge: '交付文件或记录超过大小上限。', tooLargeFile: '超过大小上限',
    unsupported: '此文件或操作当前未开放。', unsupportedFile: '暂未支持该类型',
    permission: '当前登录无权访问这些交付记录。', changed: '交付记录已变化。请刷新后按新记录重试。',
    cursorChanged: '原有分页已失效，已从第一页重新加载。',
    failure: '交付操作失败，未确认结果。', clipboard: '复制失败，文件名未写入剪贴板。',
    previewFailed: '图片预览失败。', workspaceMissing: '工作区中未找到文件，交付记录仍保留。',
    busy: '对话或交付服务正忙，请稍后重试。', notExportable: '此回复的导出资格已失效。',
    created: '回复已导出。', existing: '这份回复已导出，显示现有文件。', download: '已发起浏览器下载。', copied: '已复制文件名。'
  },
  en: {
    title: 'Conversation deliveries', desktop: 'Desktop delivery history', reply: 'Reply exported by you',
    loading: 'Loading deliveries…', pending: 'Working on the delivery…', more: 'More deliveries', retry: 'Refresh deliveries',
    md: 'Export Markdown', txt: 'Export plain text', format: 'Export reply', empty: 'This delivery has no files to display.',
    downloadLabel: 'Download file', preview: 'Preview image', closePreview: 'Close preview', workspace: 'Locate in workspace files',
    source: 'Find the delivery and original reply', card: 'Find the delivery card', copy: 'Copy file name', close: 'Dismiss notice',
    ready: 'Available', missing: 'The delivery or file no longer exists.', nonDownloadable: 'Download is unavailable for this file.', missingFile: 'File missing',
    tooLarge: 'This delivery file or record exceeds the size limit.', tooLargeFile: 'Exceeds the size limit',
    unsupported: 'This file or action is unavailable.', unsupportedFile: 'Unsupported file type',
    permission: 'This sign-in has no permission to access these deliveries.', changed: 'The delivery has changed. Refresh the list before retrying.',
    cursorChanged: 'These results changed. The first page was loaded again.',
    failure: 'The delivery operation failed and the result is unconfirmed.', clipboard: 'Copy failed. The file name was not added to your clipboard.',
    previewFailed: 'The image preview failed.', workspaceMissing: 'The file was not found in workspace files. The delivery record is still available.',
    busy: 'The conversation or delivery service is busy. Try again shortly.', notExportable: 'This reply is no longer eligible for export.',
    created: 'Reply exported.', existing: 'Showing the existing export for this reply.', download: 'Browser download started.', copied: 'File name copied.'
  }
}

type Copy = (typeof copy)['en']
const localCopy = (locale: string): Copy => copy[locale === 'zh-CN' ? 'zh-CN' : 'en']
const noSubscribe = () => () => {}
const emptySnapshot = () => emptyDeliveries

export function useDeliveries(api: DeliveriesTransport | undefined, sid: string, open: boolean, authority: string | undefined, options: {
  beforeWrite: () => Promise<void>
  expired: () => void
  openWorkspace?: (location: DeliveryLocation, signal: AbortSignal) => Promise<boolean>
}): { controller?: DeliveriesController; view: DeliveriesState } {
  const { beforeWrite, expired, openWorkspace } = options
  const controller = useMemo(() => api && createDeliveriesController(api, {
    beforeWrite, expired, openWorkspace,
    objectUrl: (blob) => URL.createObjectURL(blob),
    revokeUrl: (url) => URL.revokeObjectURL(url),
    deferRelease: (fn) => { const timer = window.setTimeout(fn, 2_000); return () => window.clearTimeout(timer) },
    saveDownload: (url, name) => {
      const link = document.createElement('a')
      link.href = url
      link.download = name
      document.body.append(link)
      try { link.click() } finally { link.remove() }
    },
    copyName: (name) => navigator.clipboard.writeText(name)
  }), [api, beforeWrite, expired, openWorkspace])
  const view = useSyncExternalStore(controller?.subscribe ?? noSubscribe, controller?.snapshot ?? emptySnapshot)
  useLayoutEffect(() => {
    controller?.select(open ? sid : undefined)
    return () => controller?.select(undefined)
  }, [controller, sid, open])
  useLayoutEffect(() => { if (open && authority !== undefined) void controller?.read(authority) }, [controller, sid, open, authority])
  return open && view.sid === sid ? { view, controller } : { view: emptyDeliveries }
}

export function ReplyDeliveryActions({ candidate, authority, state, controller, locale }: {
  candidate: DeliveryCandidate; authority: string; state: DeliveriesState; controller: DeliveriesController; locale: string
}): React.JSX.Element {
  const t = localCopy(locale)
  return <div className="wb-deliveries__formats" role="group" aria-label={t.format}>
    <button type="button" className="cf-btn" data-testid="workbench-export-md" disabled={!!state.pending}
      onClick={() => void controller.exportReply(candidate, 'md', authority)}>{t.md}</button>
    <button type="button" className="cf-btn" data-testid="workbench-export-txt" disabled={!!state.pending}
      onClick={() => void controller.exportReply(candidate, 'txt', authority)}>{t.txt}</button>
  </div>
}

export function BrowserDeliveryCard({ group, state, controller, locale, workspace, source, reveal }: {
  group: DeliveryGroup; state: DeliveriesState; controller: DeliveriesController; locale: string
  workspace: boolean; source: boolean; reveal: () => void
}): React.JSX.Element {
  const t = localCopy(locale)
  const zh = locale === 'zh-CN'
  const run = (action: 'download' | 'preview' | 'locate' | 'copy', index: number) => () => void controller.runItem(action, group.id, index)
  const preview = state.preview?.gid === group.id ? state.preview : undefined
  const rows = group.items.map((item): DeliverableViewRow => {
    const detail = item.status === 'ready' ? item.canDownload ? t.ready : t.nonDownloadable :
      item.status === 'missing' ? t.missingFile : item.status === 'too-large' ? t.tooLargeFile : t.unsupportedFile
    const download = item.canDownload ? run('download', item.index) : undefined
    const inspect = item.canPreview ? run('preview', item.index) : undefined
    const locate = group.origin === 'desktop' && workspace && item.canLocate
    const canAct = !state.pending
    return {
      index: item.index, key: String(item.index), name: item.name, title: item.name,
      detail: item.size === null ? detail : `${formatDeliverableSize(item.size)} · ${detail}`,
      missing: item.status === 'missing', primary: canAct ? inspect ?? download : undefined,
      actions: [
        ...(download ? [{ id: 'download' as const, label: t.downloadLabel, onClick: download, disabled: !canAct }] : []),
        ...(inspect ? [{ id: 'preview' as const, label: t.preview, onClick: inspect, disabled: !canAct }] : []),
        { id: 'locate', label: locate ? t.workspace : source ? t.source : t.card,
          onClick: locate ? run('locate', item.index) : reveal, disabled: !!locate && !canAct },
        { id: 'copy', label: t.copy, onClick: run('copy', item.index), disabled: !canAct }
      ]
    }
  })
  return <DeliverablesView title={group.origin === 'reply' ? t.reply : t.desktop} groupId={group.id} origin={group.origin}
    rows={rows} labels={{
      count: (n) => zh ? `${n} 个文件` : `${n} ${n === 1 ? 'file' : 'files'}`,
      collapsed: (name, n) => zh ? `${name} 等 ${n} 个文件` : `${name} + ${n - 1} more`,
      expand: (n) => zh ? `展开其余 ${n} 个文件` : `Show ${n} more files`, collapse: zh ? '收起其余文件' : 'Show fewer files'
    }} onCollapse={preview ? () => controller.closePreview() : undefined}>
    {!rows.length && <p className="wb-deliveries__empty">{t.empty}</p>}
    {preview && <figure className="wb-deliveries__preview" data-testid="deliverables-preview-panel">
      <figcaption><span>{preview.name}</span><button className="cf-btn" type="button" onClick={() => controller.closePreview()}>{t.closePreview}</button></figcaption>
      <img src={preview.url} alt={preview.name} data-testid="deliverables-preview-image" onError={() => controller.closePreview(true, preview.url)} />
    </figure>}
  </DeliverablesView>
}

export function DeliveryHistory({ groups, state, authority, controller, locale, workspace, hasSource, reveal }: {
  groups: DeliveryGroup[]; state: DeliveriesState; authority?: string; controller: DeliveriesController; locale: string; workspace: boolean
  hasSource: (group: DeliveryGroup) => boolean; reveal: (group: DeliveryGroup) => void
}): React.JSX.Element | null {
  const t = localCopy(locale)
  if (!groups.length && !state.loading && !state.issue && !state.nextCursor) return null
  const didReset = state.issue === 'changed' && !!state.authority
  return <section className="wb-deliveries__history" data-testid="workbench-deliveries" aria-label={t.title}>
    <h2>{t.title}</h2>
    {state.loading && <p role="status">{t.loading}</p>}
    {state.issue && <p role={didReset ? 'status' : 'alert'} data-testid="workbench-deliveries-issue" data-status={state.issue}>
      {didReset && !state.loading ? t.cursorChanged : t[state.issue]}{' '}
      {authority && state.issue !== 'permission' && <button className="cf-btn" type="button" disabled={!!state.loading}
        onClick={() => void controller.read(authority)}>{t.retry}</button>}
    </p>}
    {groups.map((group) => <BrowserDeliveryCard key={group.id} group={group} state={state} controller={controller} locale={locale}
      workspace={workspace} source={hasSource(group)} reveal={() => reveal(group)} />)}
    {!!state.nextCursor && authority && <button className="cf-btn" type="button" data-testid="workbench-deliveries-more"
      disabled={!!state.loading} onClick={() => void controller.read(authority, true)}>{t.more}</button>}
  </section>
}

export function DeliveryFeedback({ state, authority, controller, locale }: {
  state: DeliveriesState; authority?: string; controller: DeliveriesController; locale: string
}): React.JSX.Element | null {
  const t = localCopy(locale)
  if (state.pending) return <p className="wb-deliveries__feedback" role="status">{t.pending}</p>
  const feedback = state.feedback
  if (!feedback) return null
  return <div className="wb-deliveries__feedback" role={'issue' in feedback ? 'alert' : 'status'} data-testid="workbench-delivery-feedback"
    data-status={'issue' in feedback ? feedback.issue : feedback.success}>
    <span>{'issue' in feedback ? t[feedback.issue] : t[feedback.success]}</span>
    {'issue' in feedback && authority && (feedback.issue === 'changed' || feedback.issue === 'missing' || feedback.issue === 'notExportable') &&
      <button className="cf-btn" type="button" onClick={() => { controller.dismiss(); void controller.read(authority) }}>{t.retry}</button>}
    <button className="cf-btn" type="button" onClick={controller.dismiss}>{t.close}</button>
  </div>
}
