import { useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import { CalendarClock, Clock } from 'lucide-react'
import type { TaskRecord, TaskStatus } from '../../../preload'
import { useI18n } from '../i18n/i18n'

/** Shared Desktop task markup. Data reads, calculations and actions belong to the host. */
export const TASK_GROUP_ORDER: TaskStatus[] = ['active', 'paused', 'error', 'completed']
export const TASK_GROUP_KEY: Record<TaskStatus, string> = {
  active: 'tasks.groupActive', paused: 'tasks.groupPaused', error: 'tasks.groupError', completed: 'tasks.groupCompleted'
}

type TaskOrder = Pick<TaskRecord, 'nextRunAt' | 'createdAt'>
/** Within a status group, order saved occurrences first; newest creation wins ties. */
export function compareTaskRows(a: TaskOrder, b: TaskOrder): number {
  const an = a.nextRunAt ?? Number.POSITIVE_INFINITY
  const bn = b.nextRunAt ?? Number.POSITIVE_INFINITY
  return an !== bn ? an - bn : b.createdAt - a.createdAt
}

export function TaskRailRow({ task, scheduleText, active, onClick, onContext, testId }: {
  task: Pick<TaskRecord, 'id' | 'title' | 'status'>; scheduleText: string; active: boolean
  onClick: () => void; onContext?: (e: MouseEvent) => void; testId?: string
}): React.JSX.Element {
  const { t } = useI18n()
  return (
    <button type="button" className={`cf-trow${active ? ' is-active' : ''}`}
      aria-current={active || undefined} data-testid={testId} data-task-id={testId ? task.id : undefined}
      onClick={onClick} onContextMenu={onContext}>
      <span className={`cf-trow__icon is-${task.status}`} title={t('tasks.cardTitle')}>
        <CalendarClock size={16} />
      </span>
      <div className="cf-trow__main">
        <div className="cf-trow__title">{task.title || t('chat.untitled')}</div>
        <div className="cf-trow__sched">
          <Clock size={11} />
          <span className="cf-trow__schedtext">{scheduleText}</span>
        </div>
      </div>
    </button>
  )
}

export function TaskDetailHeading({ task, as: Title = 'div' }: {
  task: Pick<TaskRecord, 'title' | 'status'>; as?: 'div' | 'h3'
}): React.JSX.Element {
  const { t } = useI18n()
  return <>
    <div className={`cf-tdetail__icon is-${task.status}`}><CalendarClock size={30} /></div>
    <Title className="cf-profile__name">{task.title || t('chat.untitled')}</Title>
    <div className="cf-tdetail__tags">
      <span className={`cf-tdetail__status is-${task.status}`}>{t(TASK_GROUP_KEY[task.status])}</span>
    </div>
  </>
}

type TaskRun = TaskRecord['runs'][number]
type TaskRunStatus = TaskRun['status']
export const runStatusKey: Record<TaskRunStatus, string> = {
  ok: 'tasks.runOk', skipped: 'tasks.runSkipped', aborted: 'tasks.runAborted', error: 'tasks.runError'
}

/** Same fixed-width status circle for the last run and run history. */
const RUN_ICON_MARK: Record<TaskRunStatus, ReactNode> = {
  ok: <path d="m9 12 2 2 4-4" />,
  error: <><path d="m15 9-6 6" /><path d="m9 9 6 6" /></>,
  aborted: <><path d="M12 16v-4" /><path d="M12 8h.01" /></>,
  skipped: <><path d="m8 9 3 3-3 3" /><path d="m13 9 3 3-3 3" /></>
}

export function RunStatusIcon({ status, label, detail }: {
  status: TaskRunStatus; label: string; detail?: string
}): React.JSX.Element {
  const title = detail ? `${label}：${detail}` : label
  return (
    <span className={`cf-runicon is-${status}`} role="img" aria-label={title} title={title}>
      <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor"
        strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        {RUN_ICON_MARK[status]}
      </svg>
    </span>
  )
}

const HISTORY_PREVIEW = 5
export function TaskRunHistory({ runs, formatTime, headerAction, renderRunText }: {
  runs: TaskRun[]; formatTime: (ts: number) => ReactNode; headerAction?: ReactNode; renderRunText?: (run: TaskRun) => ReactNode
}): React.JSX.Element {
  const { t } = useI18n()
  const history = useMemo(() => [...runs].reverse(), [runs])
  const [historyAll, setHistoryAll] = useState(false)
  const shownHistory = historyAll ? history : history.slice(0, HISTORY_PREVIEW)
  return (
    <div className="cf-tdetail__section">
      <div className="cf-tdetail__sechead">
        <div className="cf-profile__convs-label">{t('tasks.runHistory')}</div>
        {headerAction}
      </div>
      {history.length === 0 ? <div className="cf-empty">{t('tasks.historyEmpty')}</div> : (
        <div className="cf-truns">
          {shownHistory.map((run, i) => (
            <div key={i} className="cf-trun">
              <span className="cf-trun__time">{formatTime(run.firedAt)}</span>
              <RunStatusIcon status={run.status} label={t(runStatusKey[run.status])} detail={run.error} />
              {renderRunText ? renderRunText(run) : (run.summary || run.error) && (
                <span className="cf-trun__msg">{run.summary || run.error}</span>
              )}
            </div>
          ))}
        </div>
      )}
      {history.length > HISTORY_PREVIEW && (
        <button type="button" className="cf-trun__more" onClick={() => setHistoryAll((v) => !v)} aria-expanded={historyAll}>
          {historyAll ? t('tasks.historyCollapse') : t('tasks.historyShowAll').replace('{n}', String(history.length))}
        </button>
      )}
    </div>
  )
}
