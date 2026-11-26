import type { TaskSchedule } from '../shared/host-conversations'
import type { RecordedSchedule, TaskLocale } from './task-inspection-transport'

export function formatTaskInstant(ts: number, zone: string, locale: TaskLocale): string | undefined {
  try {
    const date = new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : locale, {
      timeZone: zone, timeZoneName: 'short', year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).format(ts)
    return `${date} [${zone}]`
  } catch { return undefined }
}

export function recordedScheduleText(schedule: RecordedSchedule): string {
  // A Desktop once value is already a wall-clock time in its own zone. Parsing it
  // with the browser's Date constructor would shift it to the browser's zone.
  return `${schedule.kind === 'once' ? schedule.at.replace('T', ' ') : schedule.cron} [${schedule.tz}]`
}

export function defaultPreviewSchedule(zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', now = Date.now()): TaskSchedule {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now + 3_600_000)
  const field = (key: Intl.DateTimeFormatPartTypes): string => parts.find((item) => item.type === key)!.value
  return { kind: 'recurring', cron: '0 10 * * *', at: `${field('year')}-${field('month')}-${field('day')}T${field('hour')}:${field('minute')}`, tz: zone }
}
