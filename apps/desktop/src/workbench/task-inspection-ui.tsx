import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Pause, RefreshCw, X } from 'lucide-react'
import { ScheduleEditor } from '../renderer/src/features/chat/ScheduleEditor'
import { useI18n } from '../renderer/src/i18n/i18n'
import { TASK_GROUP_KEY, TASK_GROUP_ORDER, TaskDetailHeading, TaskRailRow, TaskRunHistory, compareTaskRows } from '../renderer/src/redesign/TaskInspectionParts'
import type { TaskRun, TaskSchedule } from '../shared/host-conversations'
import type { TaskInspection, TaskInspectionView, TaskIssue } from './task-inspection-controller'
import { taskInspectionCopy } from './task-inspection-copy'
import { defaultPreviewSchedule, formatTaskInstant, recordedScheduleText } from './task-inspection-time'
import type { InspectedTask, TaskLocale } from './task-inspection-transport'
import './task-inspection.css'

function TaskAlert({ issue }: { issue: TaskIssue }): React.JSX.Element {
  const { locale } = useI18n()
  return <p className="wb-tasks__alert" role="alert" data-testid="workbench-task-error" data-status={issue}>{taskInspectionCopy[locale][issue]}</p>
}

export function TaskInspectionPanel({ api, view, close, id }: {
  api: TaskInspection; view: TaskInspectionView; close: () => void; id: string
}): React.JSX.Element {
  const { t, locale } = useI18n()
  const c = taskInspectionCopy[locale]
  const closeButton = useRef<HTMLButtonElement>(null)
  const details = useRef<HTMLDivElement>(null)
  const pauseButton = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  useLayoutEffect(() => { closeButton.current?.focus() }, [])
  const list = view.list && 'data' in view.list ? view.list.data.tasks : undefined
  const task = view.detail && 'data' in view.detail ? view.detail.data.task : undefined
  const dismissConfirmation = (): void => { api.cancelPause(); pauseButton.current?.focus() }
  return <section id={id} className="wb-tasks" data-testid="workbench-tasks-panel" aria-labelledby={titleId} onKeyDown={(event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    event.preventDefault()
    if (view.confirming) dismissConfirmation()
    else close()
  }}>
    <header className="wb-tasks__head">
      <h2 className="modal__title" id={titleId}>{t('cf.tabTasks')}</h2>
      <button type="button" className="cf-tdetail__act" data-testid="workbench-tasks-refresh" disabled={!!view.pausing}
        onClick={() => void api.refresh()}><RefreshCw size={14} />{c.refresh}</button>
      <button type="button" ref={closeButton} className="cf-tdetail__act" data-testid="workbench-tasks-close" aria-label={c.close}
        title={c.close} onClick={close}><X size={16} /></button>
    </header>
    <p className="wb-tasks__notice" data-testid="workbench-tasks-inactive">{c.inactive}</p>
    {view.statusIssue && <TaskAlert issue={view.statusIssue} />}
    <div className="wb-tasks__body">
      <nav aria-label={c.list} className="wb-tasks__list cf-list">
        {view.list && 'pending' in view.list && <p className="cf-empty" role="status">{c.listLoading}</p>}
        {view.list && 'issue' in view.list && <TaskAlert issue={view.list.issue} />}
        {list?.length === 0 && <p className="cf-empty" data-testid="workbench-task-empty">{c.empty}</p>}
        {list && TASK_GROUP_ORDER.map((status) => {
          const rows = list.filter((task) => task.status === status).sort(compareTaskRows)
          return rows.length > 0 && <section className="cf-trailgroup" data-status={status} key={status}>
            <h3 className="cf-tasks__grouphd">{t(TASK_GROUP_KEY[status])}<span className="cf-tasks__count">{rows.length}</span></h3>
            {rows.map((task) => <TaskRailRow key={task.id} task={task} active={view.selected === task.id}
              testId="workbench-task-row" scheduleText={recordedScheduleText(task.schedule)} onClick={() => {
                void api.select(task.id)
                details.current?.focus()
              }} />)}
          </section>
        })}
      </nav>
      <div className="wb-tasks__detail" ref={details} tabIndex={-1} role="region" aria-label={c.detail}>
        {view.detail && 'pending' in view.detail && <p className="cf-empty" role="status">{c.detailLoading}</p>}
        {view.detail && 'issue' in view.detail && <TaskAlert issue={view.detail.issue} />}
        {!!list?.length && !view.selected && <p className="cf-empty">{c.choose}</p>}
        {task && <RecordedDetail key={task.id} task={task} actions={<>
          {task.pauseAllowed && task.status === 'active' && <div className="cf-tdetail__actions">
            <button ref={pauseButton} type="button" className="cf-tdetail__act" data-testid="workbench-task-pause"
              disabled={!!view.pausing || !!view.statusIssue} aria-expanded={!!view.confirming} onClick={api.askPause}><Pause size={15} />{c.pause}</button>
          </div>}
          {view.confirming && <PauseConfirmation cancel={dismissConfirmation} confirm={() => {
            details.current?.focus({ preventScroll: true })
            void api.confirmPause()
          }} />}
          {view.pausing && <p role="status">{c.pausedLoading}</p>}
        </>} />}
        <TaskSchedulePreview api={api} view={view.preview} />
      </div>
    </div>
  </section>
}

function PauseConfirmation({ cancel, confirm }: { cancel: () => void; confirm: () => void }): React.JSX.Element {
  const { locale } = useI18n()
  const c = taskInspectionCopy[locale]
  const titleId = useId()
  const first = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => { first.current?.focus() }, [])
  return <div className="wb-tasks__confirm" role="group" aria-labelledby={titleId}>
    <h4 id={titleId}>{c.pauseTitle}</h4><p>{c.pauseMessage}</p>
    <div className="cf-tdetail__actions">
      <button className="cf-tdetail__act" type="button" ref={first} onClick={cancel} data-testid="workbench-task-pause-cancel">{c.cancel}</button>
      <button className="cf-tdetail__act cf-tdetail__act--primary" type="button" onClick={confirm} data-testid="workbench-task-pause-confirm">{c.confirm}</button>
    </div>
  </div>
}

function TaskTime({ value, zone, locale }: { value: number | null; zone: string; locale: TaskLocale }): React.JSX.Element {
  const c = taskInspectionCopy[locale]
  if (value === null) return <>{c.absent}</>
  const iso = new Date(value).toISOString()
  return <time dateTime={iso}>{formatTaskInstant(value, zone, locale) ?? `${iso} (UTC; ${c.zoneUnknown}: ${zone})`}</time>
}

function RecordedDetail({ task, actions }: { task: InspectedTask; actions: ReactNode }): React.JSX.Element {
  const { t, locale } = useI18n()
  const c = taskInspectionCopy[locale]
  const zone = task.schedule.tz
  const time = (value: number | null) => <TaskTime value={value} zone={zone} locale={locale} />
  const runText = (run: TaskRun) => (run.summary || run.error || run.finishedAt !== undefined || run.handoff) &&
    <div className="cf-trun__msg wb-tasks__run">
      {run.summary && <div>{run.summary}</div>}
      {run.error && <div>{run.error}</div>}
      {run.finishedAt !== undefined && <div>{c.finished}: {time(run.finishedAt)}</div>}
      {run.handoff && <div>{c.handoff}: {run.handoff.summary}{run.handoff.needsAction && ` (${c.needsAction})`}</div>}
    </div>
  return <article className="cf-profile__inner cf-tdetail wb-tasks__card" data-testid="workbench-task-detail" data-status={task.status}>
    <TaskDetailHeading task={task} as="h3" />
    <dl className="cf-profile__meta">
      <Meta label={t('tasks.fSchedule')}>{recordedScheduleText(task.schedule)}</Meta>
      <Meta label={c.created}>{time(task.createdAt)}</Meta><Meta label={c.updated}>{time(task.updatedAt)}</Meta>
      <Meta label={c.last}>{time(task.lastRunAt)}</Meta><Meta label={c.next}>{time(task.nextRunAt)}</Meta>
      <Meta label={c.runCount}>{task.runCount}</Meta><Meta label={c.consecutiveErrors}>{task.consecutiveErrors}</Meta>
      <Meta label={t('tasks.fPersona')}>{task.auth.personaId ?? c.absent}</Meta>
      <Meta label={t('tasks.fModel')}>{task.auth.modelRef ?? c.absent}</Meta>
      <Meta label={c.session}>{task.sessionId}</Meta><Meta label={c.ownerSession}>{task.ownerSessionId ?? c.absent}</Meta>
      <Meta label={c.originSession}>{task.originSessionId ?? c.absent}</Meta>
    </dl>
    <section className="cf-tdetail__section">
      <h4 className="cf-profile__convs-label">{c.prompt}</h4>
      <div className="wb-tasks__prompt" data-testid="workbench-task-prompt">{task.prompt}</div>
    </section>
    {actions}
    <TaskRunHistory runs={task.runs} formatTime={time} renderRunText={runText} />
  </article>
}

function Meta({ label, children }: { label: string; children: ReactNode }): React.JSX.Element {
  return <div className="cf-profile__row"><dt className="cf-profile__k">{label}</dt><dd className="cf-profile__v">{children}</dd></div>
}

function TaskSchedulePreview({ api, view }: { api: TaskInspection; view: TaskInspectionView['preview'] }): React.JSX.Element {
  const { locale } = useI18n()
  const c = taskInspectionCopy[locale]
  const [initial] = useState(defaultPreviewSchedule)
  const [zone, setZone] = useState(initial.tz)
  const [schedule, setSchedule] = useState<TaskSchedule>(initial)
  const [allowPast, setAllowPast] = useState(false)
  const title = useId()
  useLayoutEffect(() => { api.clearPreview() }, [api, locale])
  return <section className="cf-tdetail__section wb-tasks__preview" aria-labelledby={title}>
    <h3 id={title}>{c.previewTitle}</h3><p className="wb-tasks__muted">{c.previewHint}</p>
    <label className="wb-tasks__zone">{c.timezone}
      <input type="text" className="input" autoComplete="off" spellCheck={false} autoCapitalize="none" maxLength={128}
        data-testid="workbench-task-preview-zone" value={zone} onChange={(event) => { api.clearPreview(); setZone(event.currentTarget.value) }} />
    </label>
    <fieldset className="wb-tasks__fields"><legend>{c.scheduleFields}</legend>
      <ScheduleEditor initial={initial} tz={zone.trim()} onChange={(next) => { api.clearPreview(); setSchedule(next) }} />
    </fieldset>
    <label className="wb-tasks__allow"><input type="checkbox" checked={allowPast} data-testid="workbench-task-preview-allow-past"
      onChange={(event) => { api.clearPreview(); setAllowPast(event.currentTarget.checked) }} />{c.allowPast}</label>
    <button className="cf-tdetail__act cf-tdetail__act--primary" type="button" data-testid="workbench-task-preview" disabled={!!view && 'pending' in view}
      onClick={() => void api.preview({ schedule: { ...schedule, tz: zone.trim() }, locale, allowPast })}>{c.preview}</button>
    {view && 'pending' in view && <p role="status">{c.previewing}</p>}
    {view && 'issue' in view && <TaskAlert issue={view.issue} />}
    {view && 'validation' in view && <p className="wb-tasks__alert" role="alert" data-status={view.validation}>{c[view.validation]}</p>}
    {view && 'data' in view && <div role="status" className="wb-tasks__receipt" data-testid="workbench-task-preview-result">
      <div>{view.data.description}</div>
      <div>{c.predicted}: {view.data.nextRunAt === null ? c.noNext : <TaskTime value={view.data.nextRunAt} zone={view.data.zone} locale={locale} />}</div>
    </div>}
  </section>
}
