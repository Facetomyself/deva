import { describeSchedule, isValidTimeZone, nextRun, parseCron, parseWallIso } from './schedule'
import type { TaskSchedule } from './tasks-types'

/** 预览结果：成功带人读摘要与下次触发（epoch ms，null=无更多触发）；失败带与 createTask 一致的错误码。 */
export type PreviewScheduleResult =
  | { ok: true; description: string; nextRunAt: number | null }
  | { ok: false; error: 'invalid-input' | 'invalid-tz' | 'invalid-cron' | 'invalid-once' }

/**
 * 校验日程并返回人读摘要 + 下次触发。预览不读写任务、不创建任务。
 * `allowPast` 默认 false：名片编辑态把过期的 once 视为错误。已创建任务的只读展示传 true，
 * 合法但过期的 once 仍返回人读摘要（nextRunAt=null）。`now` 为本次预览的评估时刻（epoch ms）。
 */
export function previewSchedule(
  schedule: TaskSchedule,
  locale: 'zh-CN' | 'en' = 'zh-CN',
  allowPast = false,
  now = Date.now()
): PreviewScheduleResult {
  if (!schedule || typeof schedule !== 'object') return { ok: false, error: 'invalid-input' }
  if (!isValidTimeZone(schedule.tz)) return { ok: false, error: 'invalid-tz' }
  if (schedule.kind === 'recurring') {
    if (!parseCron(schedule.cron ?? '')) return { ok: false, error: 'invalid-cron' }
    const next = nextRun(schedule, now)
    if (next == null) return { ok: false, error: 'invalid-cron' } // 病态但语法合法（如 2/30）
    return { ok: true, description: describeSchedule(schedule, locale), nextRunAt: next }
  }
  if (schedule.kind === 'once') {
    const next = nextRun(schedule, now)
    if (next == null) {
      if (allowPast && parseWallIso(schedule.at ?? ''))
        return { ok: true, description: describeSchedule(schedule, locale), nextRunAt: null }
      return { ok: false, error: 'invalid-once' } // 非法或（编辑态下）已过期
    }
    return { ok: true, description: describeSchedule(schedule, locale), nextRunAt: next }
  }
  return { ok: false, error: 'invalid-input' }
}
