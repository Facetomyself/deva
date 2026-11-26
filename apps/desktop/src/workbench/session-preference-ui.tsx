import { useEffect, useId, useRef } from 'react'
import { Archive, ArchiveRestore, Check, Pencil } from 'lucide-react'
import { Modal } from '../renderer/src/components/Modal'
import { useI18n } from '../renderer/src/i18n/i18n'
import { ModelSelectButton } from '../renderer/src/redesign/ModelMenu'
import { normalizeTitle, type PreferenceEntry, type PreferenceIssue, type SessionPreferenceController } from './session-preferences'

const labels = {
  en: {
    conflict: 'These preferences changed elsewhere. Your draft is still here. Reload the saved preferences before applying changes again.',
    busy: 'This conversation has a reply in progress. Try again once it ends.',
    readOnly: 'Preferences for this desktop history are read-only in Workbench.',
    missing: 'This conversation is no longer available.',
    storage: 'The save was not confirmed in storage. Reload the saved preferences to check the result.',
    invalid: 'The server rejected this preference. Check the title or the model enabled in settings.',
    readFailure: 'Could not load saved conversation preferences.',
    writeFailure: 'Could not confirm the save. Reload the saved preferences to check the result.',
    reload: 'Reload saved preferences', saving: 'Saving preferences…', loading: 'Loading preferences…',
    follow: 'Follow default', actions: 'Conversation actions'
  },
  'zh-CN': {
    conflict: '其他窗口已更改会话设置。草稿已保留；请重新读取已保存的设置，再提交修改。',
    busy: '这段对话有一条回复正在进行，请在回复结束后重试。',
    readOnly: '这段桌面历史的会话设置在工作台中为只读。',
    missing: '这段对话已失效。',
    storage: '保存结果尚未在存储中确认，请重新读取已保存的设置核对结果。',
    invalid: '服务端未接受这项设置，请检查标题或模型设置中的启用状态。',
    readFailure: '加载已保存的会话设置失败。',
    writeFailure: '保存结果尚未确认，请重新读取已保存的设置核对结果。',
    reload: '重读已保存的设置', saving: '正在保存会话设置…', loading: '正在读取会话设置…',
    follow: '跟随默认', actions: '会话操作'
  }
} satisfies Record<string, Record<PreferenceIssue | 'reload' | 'saving' | 'loading' | 'follow' | 'actions', string>>

export function SessionPreferenceStatus({ entry, reload, locked }: {
  entry: PreferenceEntry; reload: () => void; locked?: boolean
}): React.JSX.Element | null {
  const { locale } = useI18n()
  const c = labels[locale]
  if (entry.pending) return <p className="wb-session-prefs__notice" role="status">{c.saving}</p>
  if (!entry.issue) return entry.reading && !entry.confirmed ? <p className="wb-session-prefs__notice" role="status">{c.loading}</p> : null
  return <div className="wb-session-prefs__notice" data-testid="workbench-session-preferences-issue">
    <span role="alert">{c[entry.issue]}</span>{' '}
    {entry.needsRead && <button className="cf-empty__action" type="button" data-testid="workbench-session-preferences-reload"
      disabled={locked || entry.reading} onClick={reload}>{c.reload}</button>}
  </div>
}

export function SessionHeaderActions({ archived, blocked, disabled, rename, archive }: {
  archived: boolean; blocked?: string; disabled: boolean; rename: () => void; archive: () => void
}): React.JSX.Element {
  const { t, locale } = useI18n()
  return <div className="wb-session-prefs__actions" role="group" data-testid="workbench-session-menu" aria-label={labels[locale].actions}>
    {archived && <span className="cf-conv__tag" data-testid="workbench-session-archived"><Archive size={11} />{t('cf.archivedTag')}</span>}
    <button className="cf-conv__headbtn" type="button" data-testid="workbench-session-rename" aria-haspopup="dialog"
      aria-label={t('cf.renameChat')} title={blocked ?? t('cf.renameChat')} disabled={disabled} onClick={rename}><Pencil size={14} /></button>
    <button className="cf-conv__headbtn" type="button" data-testid={archived ? 'workbench-session-restore' : 'workbench-session-archive'}
      aria-label={archived ? t('cf.unarchive') : t('cf.archive')} title={blocked ?? (archived ? t('cf.unarchive') : t('cf.archive'))}
      disabled={disabled} onClick={archive}>
      {archived ? <><ArchiveRestore size={13} /><span>{t('cf.unarchive')}</span></> : <Archive size={14} />}
    </button>
  </div>
}

export function SessionRenameDialog({ sid, entry, store, disabled, close, reload }: {
  sid: string; entry: PreferenceEntry; store: SessionPreferenceController; disabled: boolean; close: () => void; reload: () => void
}): React.JSX.Element | null {
  const { t } = useI18n()
  const field = useRef<HTMLInputElement>(null)
  const id = useId()
  useEffect(() => { field.current?.select() }, [])
  const draft = entry.draft
  if (!draft) return null
  const title = normalizeTitle(draft.text)
  const unchanged = title === draft.initial
  const ready = !disabled && !entry.reading && !entry.pending && !entry.needsRead && !unchanged
  const cancel = (): void => { if (!entry.pending) { store.discardRename(sid); close() } }
  const save = (): void => { if (ready) void store.saveRename(sid).then((ok) => { if (ok) close() }) }
  return <Modal open onClose={cancel} labelledBy={id}>
    <h2 id={id} className="modal__title">{t('cf.renameChatTitle')}</h2>
    <div className="modal__field">
      <input ref={field} className="input" autoFocus aria-label={t('cf.renameChatTitle')} data-testid="workbench-rename-input"
        value={draft.text} disabled={!!entry.pending} placeholder={t('cf.renamePlaceholder')} onChange={(event) => store.editRename(sid, event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) save() }} />
    </div>
    <SessionPreferenceStatus entry={entry} reload={reload} />
    <div className="modal__actions">
      <button className="btn btn--ghost" type="button" disabled={!!entry.pending} onClick={cancel}>{t('common.cancel')}</button>
      <button className="btn btn--primary" type="button" data-testid="workbench-rename-save" disabled={!ready} onClick={save}>{t('cf.renameChat')}</button>
    </div>
  </Modal>
}

type ModelButton = Parameters<typeof ModelSelectButton>[0]
export function SessionModelPicker({ open, active, groups, onToggle, onPick, follow, pinned, disabled }: ModelButton & {
  follow: () => void; pinned: string | null | undefined; disabled: boolean
}): React.JSX.Element {
  const { t, locale } = useI18n()
  const c = labels[locale]
  const name = pinned === null ? c.follow : active?.model.name ?? pinned ?? t('chat.selectModel')
  const id = useId()
  return <ModelSelectButton open={open && !disabled} active={active} groups={groups} onToggle={onToggle} onPick={onPick}
    label={name} menuId={id} disabled={disabled} leading={
      <button className={`model-pick__item${pinned === null ? ' is-active' : ''}`} type="button" role="menuitemradio"
        aria-checked={pinned === null} data-testid="workbench-session-model-default" onClick={follow}>
        <span className="model-pick__name">{c.follow}</span>
        <span className="cf-mp__check">{pinned === null && <Check size={14} className="model-pick__check" />}</span>
      </button>
    } />
}
