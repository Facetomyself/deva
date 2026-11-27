import { useId, useLayoutEffect, useRef, useState } from 'react'
import { ContextRing } from '../renderer/src/redesign/ContextRing'
import { useI18n } from '../renderer/src/i18n/i18n'
import type { ChatProjection } from './chat-stream'
import { fullModelRef, type ContextReport, type ConversationStatusTransport } from './conversation-status-transport'

type ModelGroup = { p: { id: string }; models: readonly { id: string; contextWindow?: number; maxOutput?: number }[] }
export type ContextTarget = { model: string | null; signature: string; refs: ReadonlySet<string> }

/** The picker only shares IDs and numeric model limits; no draft, provider address or credentials. */
export function contextTarget(model: string | null | undefined, groups: readonly ModelGroup[], defaultRef: string | null): ContextTarget | undefined {
  if (model !== null && !fullModelRef(model)) return
  const settings = groups.flatMap(({ p, models }) => models.flatMap(({ id, contextWindow, maxOutput }) => {
    const ref = `${p.id}:${id}`
    return (model === null || model === ref) && fullModelRef(ref) ? [[ref, contextWindow ?? null, maxOutput ?? null] as const] : []
  }))
  if (!settings.length) return
  return { model, signature: JSON.stringify([model === null ? defaultRef : null, settings]), refs: new Set(settings.map(([ref]) => ref)) }
}

export function contextAuthority(projection: ChatProjection | undefined, sid: string): { scope: string; version: number | null } | undefined {
  const snapshot = projection?.snapshot
  const state = snapshot?.state
  if (projection?.status !== 'ready' || !snapshot || state?.id !== sid || state.compatibility !== 'text' || snapshot.cursor.scope !== `chat:${sid}`) return
  const { active, lastTurn } = state
  return {
    scope: JSON.stringify([snapshot.cursor.epoch, snapshot.cursor.generation, state.updatedAt, active?.turnId, lastTurn?.turnId, lastTurn?.status]),
    version: snapshot.contextVersion ?? null
  }
}

const copy = {
  en: {
    measured: 'Previous request · measured input tokens', live: 'Current turn · measured input tokens',
    estimate: 'Estimate from saved conversation history', none: 'No context usage yet',
    unavailable: 'Context usage unavailable', loading: 'Loading context usage…', close: 'Close'
  },
  'zh-CN': {
    measured: '上次请求 · 实测输入 token', live: '当前回合 · 实测输入 token',
    estimate: '根据已保存的对话历史估算', none: '暂无上下文用量',
    unavailable: '上下文用量暂不可用', loading: '正在读取上下文用量…', close: '关闭'
  }
}

type Props = {
  api: ConversationStatusTransport
  sid: string
  projection?: ChatProjection
  target?: ContextTarget
  blocked: boolean
  modelReady: boolean
  onExpired: () => void
}

export function WorkbenchContextMeter({ api, sid, projection, target, blocked, modelReady, onExpired }: Props): React.JSX.Element | null {
  const { locale } = useI18n()
  const label = copy[locale]
  const authority = contextAuthority(projection, sid)
  const model = target?.model
  const scope = !blocked && modelReady && target && authority ? JSON.stringify([sid, model, target.signature, authority.scope]) : undefined
  const version = authority?.version
  const [result, setResult] = useState<{ api: Props['api']; scope: string; report?: ContextReport }>()
  const [opened, setOpened] = useState<string>()
  const root = useRef<HTMLDivElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const expired = useRef(onExpired)
  const cardId = useId()
  useLayoutEffect(() => { expired.current = onExpired }, [onExpired])
  useLayoutEffect(() => {
    if (model === undefined || !scope) return
    const controller = new AbortController()
    void api.usage(sid, model, controller.signal).then((report) => {
      if (!controller.signal.aborted) setResult({ api, scope, report })
    }, (error: unknown) => {
      if (controller.signal.aborted) return
      setResult({ api, scope })
      if ((error as { status?: number } | null)?.status === 401) expired.current()
    })
    return () => controller.abort()
  }, [api, sid, model, scope, version])

  const settled = result?.api === api && result.scope === scope ? result : undefined
  const report = settled?.report
  const known = !!report?.modelRef && !!target?.refs.has(report.modelRef)
  const usage = known && report?.usage?.used != null ? report.usage : undefined
  const source = !target || (settled && !known) ? 'unavailable' : report?.source ?? 'loading'
  const open = !!usage && !!scope && opened === scope
  const close = (restoreFocus: boolean): void => {
    setOpened(undefined)
    if (restoreFocus) root.current?.querySelector<HTMLButtonElement>('.cf-mp__ringbtn')?.focus({ preventScroll: true })
  }
  useLayoutEffect(() => { setOpened(undefined); setResult(undefined) }, [api, scope])
  useLayoutEffect(() => {
    if (!open) return
    closeButton.current?.focus({ preventScroll: true })
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      close(true)
    }
    const outside = (event: Event): void => {
      if (event.target && !root.current?.contains(event.target as Node)) close(false)
    }
    document.addEventListener('keydown', escape, true)
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('focusin', outside)
    return () => {
      document.removeEventListener('keydown', escape, true)
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('focusin', outside)
    }
  }, [open])

  if (blocked || !modelReady || !authority) return null
  if (!usage) return <span className={source === 'loading' ? 'wb-status__sr-only' : 'wb-context__state'} data-testid="workbench-context-source"
    data-source={source}>{label[source]}</span>
  return <div className="wb-context" ref={root} data-testid="workbench-context-meter">
    <ContextRing usage={usage} open={open} onToggle={() => open ? close(true) : setOpened(scope)} cardId={cardId}
      details={<div className="wb-context__details">
        <span data-testid="workbench-context-source" data-source={source}>{label[source]}</span>
        <button className="cf-empty__action" ref={closeButton} type="button" onClick={() => close(true)}>{label.close}</button>
      </div>} />
  </div>
}
