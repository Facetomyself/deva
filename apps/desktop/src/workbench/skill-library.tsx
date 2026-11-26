import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type Ref, type RefObject } from 'react'
import { RotateCw } from 'lucide-react'
import { useI18n } from '../renderer/src/i18n/i18n'
import { Toggle } from '../renderer/src/redesign/shell-common'
import { ExtensionSettingsRow, SkillSettingsDetail } from '../renderer/src/redesign/SkillSettingsParts'
import { createSkillLibrary, draftRoles, invalidDraftRoles, roleNeedsReview,
  type RoleMode, type SkillLibraryController, type SkillLibraryState } from './skill-library-controller'
import { skillCopy } from './skill-library-copy'
import { createSkillLibraryTransport, sameSkillRoles, type SkillSummary } from './skill-library-transport'
import type { Bootstrap, Transport } from './transport'
import './skill-library.css'

function useCopy() {
  const { locale } = useI18n()
  return skillCopy[locale]
}

function SavedToggle({ item, busy, disabled, onChange }: {
  item: SkillSummary; busy: boolean; disabled: boolean; onChange: () => void
}): React.JSX.Element {
  const labels = useCopy()
  return <label className="wb-skill__toggle" data-testid={item.source === 'custom' ? 'workbench-skill-toggle' : undefined} aria-busy={busy || undefined}
    onClickCapture={(event) => { if (!event.nativeEvent.isTrusted) { event.preventDefault(); event.stopPropagation() } }}>
    <span className="wb-skill__sr">{labels.savedEnabled}: {item.name}</span>
    <Toggle on={item.enabled} onChange={onChange} disabled={disabled} />
  </label>
}

function SkillStatus({ state }: { state: SkillLibraryState }): React.JSX.Element {
  const labels = useCopy()
  const feedback = state.feedback?.status
  const problem = state.listError ?? (feedback === 'saving' || feedback === 'saved' ? undefined : feedback) ?? state.selected?.error ?? state.roles?.error
  const review = !!state.roles && !!state.selected && roleNeedsReview(state.roles.draft, state.selected.item)
  let text = ''
  if (state.reconnecting) text = labels.reconnecting
  else if (state.syncError) text = state.syncError === 'unavailable' ? labels.sync : `${labels.problem[state.syncError]} ${labels.sync}`
  else if (feedback === 'saving') text = labels.saving
  else if (problem) {
    const edit = state.feedback?.edit
    text = labels.problem[problem] + (feedback === problem && edit && 'enabled' in edit ? ` ${edit.enabled ? labels.requestedOn : labels.requestedOff}` : '')
  } else if (review) text = labels.reviewHint
  else if (state.selected?.loading) text = labels.detailLoading
  else if (state.roles?.loading) text = labels.rolesLoading
  else if (state.listing && !state.catalog) text = labels.loading
  else if (feedback === 'saved') text = labels.saved
  return <p className="wb-skill__status" data-testid="workbench-skill-status" data-error={problem ?? (review && feedback !== 'saving' ? 'stale' : state.syncError)}
    role="status" aria-live="polite">{text}</p>
}

function Refresh({ disabled, refresh }: { disabled: boolean; refresh: () => void }): React.JSX.Element {
  const labels = useCopy()
  return <button type="button" className="btn btn--ghost btn--sm" disabled={disabled} data-testid="workbench-skills-refresh"
    onClick={(event) => { if (event.nativeEvent.isTrusted) refresh() }}><RotateCw size={14} aria-hidden />{labels.refresh}</button>
}

function CatalogList({ controller, state, heading, onOpen, trackRow }: {
  controller: SkillLibraryController; state: SkillLibraryState; heading: Ref<HTMLHeadingElement>
  onOpen: (id: string) => void; trackRow: (id: string, node: HTMLButtonElement | null) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const labels = useCopy()
  const saving = state.feedback?.status === 'saving'
  return <>
    <header className="wb-skill__toolbar">
      <h2 className="cf-pane__title" ref={heading} tabIndex={-1}>{t('extensions.skills')}</h2>
      <Refresh disabled={state.listing || saving || !!state.reconnecting} refresh={() => void controller.refresh()} />
    </header>
    <p className="wb-skill__notice">{labels.inactive}</p>
    <SkillStatus state={state} />
    {state.catalog?.skills.length === 0 && !state.listError && <div className="cf-empty">{labels.empty}</div>}
    {!!state.catalog?.skills.length && <div className="cf-rows">
      {state.catalog.skills.map((item) => <ExtensionSettingsRow key={item.id} name={item.name} badge={t('cf.kindSkill')}
        note={item.source === 'builtin' ? `${t('cf.builtin')} · ${labels.readonly}` : item.canConfigure ? undefined : labels.readonly}
        accessory={item.roles !== null && <span className="cf-badge" title={item.roles.join(', ') || undefined}>
          {item.roles.length === 0 ? labels.noRoles : item.roles.length === 1 ? labels.oneRole : labels.rolesCount.replace('{n}', String(item.roles.length))}
        </span>}
        rowProps={{ 'data-testid': 'workbench-skill-row', 'data-skill-id': item.id, 'data-source': item.source, 'data-enabled': String(item.enabled) }}
        openProps={{ 'data-testid': 'workbench-skill-open', type: 'button', disabled: !!(state.listError || state.syncError), ref: (node) => trackRow(item.id, node) }}
        onOpen={item.source === 'custom' ? (event) => { if (event.nativeEvent.isTrusted) onOpen(item.id) } : undefined}
        toggle={<SavedToggle item={item} busy={saving && state.feedback?.id === item.id}
          disabled={saving || !item.canConfigure || !!(state.listError || state.syncError)} onChange={() => controller.toggle(item.id)} />} />)}
    </div>}
  </>
}

function ScopeText({ item }: { item: SkillSummary }): React.JSX.Element {
  const { t, locale } = useI18n()
  const labels = useCopy()
  if (item.roles === null) return <span>{t('extensions.rolesGeneral')}</span>
  if (item.roles.length === 0) return <span>{labels.noRoles}</span>
  return <span>{item.roles.join(locale === 'zh-CN' ? '、' : ', ')}</span>
}

function RolePicker({ controller, state, item, focusRef, writable }: {
  controller: SkillLibraryController; state: SkillLibraryState; item: SkillSummary; focusRef: Ref<HTMLFieldSetElement>; writable: boolean
}): React.JSX.Element | null {
  const { t } = useI18n()
  const labels = useCopy()
  const radioName = useId()
  const form = state.roles
  if (!form) return null
  const { draft, options } = form
  const saving = state.feedback?.status === 'saving'
  const review = roleNeedsReview(draft, item)
  const invalid = invalidDraftRoles(form, item)
  const roleModes: { value: RoleMode; label: string }[] = [
    { value: 'all', label: t('extensions.rolesGeneral') }, { value: 'none', label: labels.noRoles }, { value: 'selected', label: labels.selectedRoles }
  ]
  return <fieldset className="wb-skill__roles" ref={focusRef} tabIndex={-1} aria-busy={form.loading || saving}>
    <legend className="ext-field__label">{labels.editRoles}</legend>
    {options && <>
      <div className="wb-skill__modes">
        {roleModes.map(({ value, label }) => <label key={value}>
          <input name={radioName} type="radio" value={value} checked={draft.mode === value} disabled={form.loading || saving}
            data-testid="workbench-skill-role-mode" data-role-mode={value} onChange={() => controller.setRoleMode(value)} />{label}
        </label>)}
      </div>
      {draft.mode === 'selected' && <div className="wb-skill__options" role="group" aria-label={labels.selectedRoles}>
        {options.map((option) => <label key={option.id}>
          <input type="checkbox" checked={draft.picked.includes(option.id)} disabled={form.loading || saving}
            data-testid="workbench-skill-role-option" data-role-id={option.id} onChange={(e) => controller.pickRole(option.id, e.currentTarget.checked)} />
          <span>{option.name}{!option.enabled && <small>{labels.disabledRole}</small>}</span>
        </label>)}
        {draft.picked.filter((id) => !options.some((option) => option.id === id)).map((id) => <label key={id}>
          <input type="checkbox" checked disabled={form.loading || saving}
            data-testid="workbench-skill-role-option" data-role-id={id} onChange={() => controller.pickRole(id, false)} />
          <span>{id} <small>{labels.unrecognized}</small></span>
        </label>)}
      </div>}
    </>}
    {options && invalid && !review && <p className="wb-skill__notice">{draft.picked.length ? labels.unknownSelected : labels.emptySelected}</p>}
    <div className="wb-skill__actions">
      <button className="btn btn--ghost btn--sm" type="button" data-testid="workbench-skill-roles-cancel" disabled={saving}
        onClick={() => controller.closeRoles()}>{t('common.cancel')}</button>
      {(review || form.error) && <button className="btn btn--ghost btn--sm" type="button" data-testid="workbench-skill-role-review"
        disabled={saving || form.loading || !writable} onClick={(event) => { if (event.nativeEvent.isTrusted) void controller.reviewRoles() }}>{labels.review}</button>}
      <button className="btn btn--primary btn--sm" type="button" data-testid="workbench-skill-roles-save"
        disabled={saving || form.loading || !!form.error || !options || !writable || review || invalid || sameSkillRoles(draftRoles(draft), item.roles)}
        onClick={(event) => { if (event.nativeEvent.isTrusted) controller.saveRoles() }}>{labels.saveRoles}</button>
    </div>
  </fieldset>
}

function SkillDetail({ controller, state, onBack, backRef }: {
  controller: SkillLibraryController; state: SkillLibraryState & { selected: NonNullable<SkillLibraryState['selected']> }
  onBack: () => void; backRef: RefObject<HTMLButtonElement>
}): React.JSX.Element {
  const { t } = useI18n()
  const labels = useCopy()
  const instructionsId = useId()
  const summary = state.selected.item
  const latest = state.catalog?.skills.find((s) => s.id === summary.id)
  const document = state.selected.document
  const writable = !!document && latest?.revision === document.revision && latest.canConfigure && !state.selected.error && !state.listError && !state.syncError
  const saving = state.feedback?.status === 'saving'
  const roleButton = useRef<HTMLButtonElement>(null)
  const roleEditor = useRef<HTMLFieldSetElement>(null)
  const returnToRoleButton = useRef(false)
  const inRoles = !!state.roles
  useLayoutEffect(() => {
    if (inRoles) {
      roleEditor.current?.focus()
      returnToRoleButton.current = true
    }
  }, [inRoles])
  useLayoutEffect(() => {
    if (inRoles || !returnToRoleButton.current || state.selected.loading) return
    const target = roleButton.current && !roleButton.current.disabled ? roleButton.current : backRef.current
    target?.focus()
    returnToRoleButton.current = false
  }, [backRef, inRoles, saving, state.selected.loading, writable])
  return <SkillSettingsDetail name={summary.name} backLabel={t('common.back')} onBack={onBack}
    sectionProps={{ 'data-testid': 'workbench-skill-detail', 'data-skill-id': summary.id }}
    backProps={{ 'data-testid': 'workbench-skill-back', type: 'button', ref: backRef }}
    controls={<>
      <Refresh disabled={state.listing || saving || !!state.reconnecting} refresh={() => void controller.refresh()} />
      <span className="provider-detail__enable">{summary.enabled ? labels.savedOn : labels.savedOff}</span>
      <SavedToggle item={summary} busy={saving && state.feedback?.id === summary.id} disabled={!writable || saving || inRoles}
        onChange={() => controller.toggle(summary.id)} />
    </>}>
    <p className="wb-skill__notice">{labels.inactive}</p>
    <SkillStatus state={state} />
    {document && <dl className="wb-skill__summary">
      <div><dt>{labels.source}</dt><dd>{labels.custom}{!summary.canConfigure && ` · ${labels.readonly}`}</dd></div>
      {summary.description && <div><dt>{t('extensions.description')}</dt><dd>{summary.description}</dd></div>}
      <div><dt>{t('extensions.roles')}</dt><dd><ScopeText item={summary} />
        {summary.canConfigure && !inRoles && <button className="btn btn--ghost btn--sm" type="button" data-testid="workbench-skill-roles"
          ref={roleButton} disabled={saving || !writable}
          onClick={(event) => { if (event.nativeEvent.isTrusted) controller.openRoles() }}>{labels.editRoles}</button>}
      </dd></div>
    </dl>}
    <RolePicker key={summary.id} controller={controller} state={state} item={latest ?? summary} focusRef={roleEditor} writable={writable} />
    {document && <div className="ext-field ext-field--grow wb-skill__instructions">
      <h3 id={instructionsId} className="ext-field__label">{t('extensions.instructions')}</h3>
      <pre className="ext-detail__md wb-skill__literal" data-testid="workbench-skill-instructions" tabIndex={0}
        aria-labelledby={instructionsId}>{document.instructions}</pre>
      {!document.instructions && <span className="ext-detail__muted">{t('extensions.instructionsEmpty')}</span>}
    </div>}
  </SkillSettingsDetail>
}

function OpenPanel({ controller }: { controller: SkillLibraryController }): React.JSX.Element {
  const { t } = useI18n()
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot)
  const heading = useRef<HTMLHeadingElement>(null)
  const backRef = useRef<HTMLButtonElement>(null)
  const openedFrom = useRef<string | undefined>(undefined)
  const rows = useRef(new Map<string, HTMLButtonElement>())
  const selected = state.selected?.item.id
  useLayoutEffect(() => {
    if (selected) backRef.current?.focus()
    else if (openedFrom.current) {
      (rows.current.get(openedFrom.current) ?? heading.current)?.focus()
      openedFrom.current = undefined
    }
  }, [selected])
  return <section className="wb-skill" data-testid="workbench-skills-panel" aria-label={t('extensions.skills')}>
    {state.selected ? <SkillDetail controller={controller} state={{ ...state, selected: state.selected }} backRef={backRef} onBack={controller.back} /> :
      <CatalogList controller={controller} state={state} heading={heading} onOpen={(id) => { if (controller.open(id)) openedFrom.current = id }}
        trackRow={(id, node) => { if (node) rows.current.set(id, node); else rows.current.delete(id) }} />}
  </section>
}

export default function SkillLibrary({ transport, bootstrap, onExpired }: { transport: Transport; bootstrap: Bootstrap; onExpired: () => void }): React.JSX.Element | null {
  const [controller, setController] = useState<SkillLibraryController>()
  const { t } = useI18n()
  const labels = useCopy()
  useLayoutEffect(() => {
    const api = createSkillLibraryTransport(transport, bootstrap)
    if (!api) return
    const runtime = createSkillLibrary(api, onExpired)
    setController(runtime)
    runtime.start()
    return runtime.dispose
  }, [transport, bootstrap, onExpired])
  if (bootstrap.capabilities?.skillLibrary !== true) return null
  return controller ? <OpenPanel controller={controller} /> :
    <section className="wb-skill" data-testid="workbench-skills-panel" aria-label={t('extensions.skills')}>
      <p role="status" data-testid="workbench-skill-status">{labels.loading}</p>
    </section>
}
