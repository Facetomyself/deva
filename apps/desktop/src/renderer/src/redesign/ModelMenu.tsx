/**
 * 模型贴片点开的菜单：全部「已启用服务商 × 已启用模型」按服务商分组平铺，点一下即切换。
 *
 * 每行只写模型名（悬停提示写完整 ID）。服务商名是灰色小字、滚动时吸顶；组间不画线、不放色点。
 * 列表自己滚动；打开时把当前模型滚到可见范围中间。
 */
import { useLayoutEffect, useRef } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import './model-panel.css'
import type { ModelDef, Provider } from '../mock/models'
import { useI18n } from '../i18n/i18n'

export interface ModelGroup {
  p: Provider
  models: ModelDef[]
}

export function ModelMenu({
  groups,
  activePid,
  activeMid,
  onPick
}: {
  groups: ModelGroup[]
  activePid: string | null
  activeMid: string | null
  onPick: (pid: string, mid: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const listRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef<HTMLButtonElement>(null)

  // 只在打开时定位一次：直接改列表的 scrollTop（scrollIntoView 可能连带滚动外层）。
  useLayoutEffect(() => {
    const list = listRef.current
    const item = activeRef.current
    if (!list || !item) return
    list.scrollTop = item.offsetTop - (list.clientHeight - item.offsetHeight) / 2
  }, [])

  return (
    <div className="model-pick__menu cf-mp__menu" role="menu" aria-label={t('chat.selectModel')}>
      {groups.length === 0 ? (
        <div className="model-pick__empty">{t('chat.noModel')}</div>
      ) : (
        <div ref={listRef} className="cf-mp__list">
          {groups.map(({ p, models }) => (
            <div key={p.id} className="cf-mp__group">
              <div className="cf-mp__ghead">{p.name}</div>
              {models.map((m) => {
                const on = p.id === activePid && m.id === activeMid
                return (
                  <button
                    key={m.id}
                    ref={on ? activeRef : undefined}
                    type="button"
                    role="menuitemradio"
                    aria-checked={on}
                    className={`model-pick__item${on ? ' is-active' : ''}`}
                    title={m.name === m.id ? m.id : `${m.name} · ${m.id}`}
                    onClick={() => onPick(p.id, m.id)}
                  >
                    <span className="model-pick__name">{m.name}</span>
                    <span className="cf-mp__check">{on && <Check size={14} className="model-pick__check" />}</span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function modelGroups(providers: Provider[]): ModelGroup[] {
  return providers.filter((p) => p.enabled && (p.purpose ?? 'llm') === 'llm')
    .map((p) => ({ p, models: p.models.filter((m) => m.enabled) })).filter((g) => g.models.length > 0)
}

export function ModelSelectButton({ open, active, groups, onToggle, onPick }: {
  open: boolean; active: { provider: Provider; model: ModelDef } | null; groups: ModelGroup[]
  onToggle: () => void; onPick: (pid: string, mid: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const name = active?.model.name ?? t('chat.selectModel')
  return <>
    <button className={`chip cf-mp__model${open ? ' is-open' : ''}`} type="button"
      title={open ? undefined : name} aria-label={name} aria-haspopup="menu" aria-expanded={open} onClick={onToggle}>
      <span className="chip__label">{name}</span>
      <ChevronDown size={13} className="chip__caret" />
    </button>
    {open && <ModelMenu groups={groups} activePid={active?.provider.id ?? null} activeMid={active?.model.id ?? null} onPick={onPick} />}
  </>
}
