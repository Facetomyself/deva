import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { previewSchedule as desktopPreview } from '../dist/schedule-core.mjs'
import { openTaskPreview } from '../src/tasks/preview.mjs'

const UTC = 'UTC'
const SHANGHAI = 'Asia/Shanghai'
const LA = 'America/Los_Angeles'
const once = (at, tz = UTC) => ({ kind: 'once', at, tz })
const recurring = (cron, tz = UTC) => ({ kind: 'recurring', cron, tz })
const request = (schedule, locale = 'en', allowPast = false) => ({ schedule, locale, allowPast })
const valid = request(recurring('*/15 * * * *'))
const invalid = error => ({ ok: false, error })
const success = (description, next) => ({ ok: true, description, nextRunAt: next === null ? null : Date.parse(next) })
const fault = code => ({ name: 'TaskPreviewError', code })

function fixture(t, time = '2026-01-01T00:00:00Z') {
  const api = openTaskPreview({ now: () => Date.parse(time) })
  t.after(api.close)
  return api
}

test('preview preserves Desktop descriptions and computes against the explicit Shanghai and LA zones', async t => {
  const clock = Date.parse('2026-01-01T00:00:00Z')
  const { preview } = fixture(t)
  for (const [schedule, locale, description, instant] of [
    [recurring('0 10 * * *', SHANGHAI), 'zh-CN', '每天 10:00', '2026-01-01T02:00:00Z'],
    [recurring('0 10 * * *', LA), 'en', 'daily at 10:00', '2026-01-01T18:00:00Z'],
    [once('2026-01-02T10:00', SHANGHAI), 'en', 'once at 2026-01-02 10:00', '2026-01-02T02:00:00Z'],
    [once('2026-01-02 10:00:00', LA), 'zh-CN', '2026-01-02 10:00 一次', '2026-01-02T18:00:00Z'],
    [recurring('0 10 * * *', 'Etc/GMT+8'), 'en', 'daily at 10:00', '2026-01-01T18:00:00Z'],
    [recurring('0 10 * * *', 'US/Pacific'), 'en', 'daily at 10:00', '2026-01-01T18:00:00Z']
  ]) {
    const expected = success(description, instant)
    assert.deepEqual(desktopPreview(schedule, locale, false, clock), expected)
    assert.deepEqual(await preview(request(schedule, locale)), expected)
  }
})

test('calendar validation handles leap days and cron retains Desktop day-of-week OR semantics', async t => {
  const { preview } = fixture(t)
  assert.deepEqual(await preview(request(once('2028-02-29T12:34'))), success('once at 2028-02-29 12:34', '2028-02-29T12:34:00Z'))
  assert.deepEqual(await preview(request(recurring('0 0 29 2 *'))), success('cron: 0 0 29 2 *', '2028-02-29T00:00:00Z'))
  assert.deepEqual(await preview(request(recurring('0 0 30 2 *'))), invalid('invalid-cron'))
  assert.deepEqual(await preview(request(recurring('0 10 30 2 1'))), success('cron: 0 10 30 2 1', '2026-02-02T10:00:00Z'))
  const century = fixture(t, '2096-02-29T00:00:00Z')
  assert.equal((await century.preview(request(recurring('0 0 29 2 *')))).nextRunAt, Date.parse('2104-02-29T00:00:00Z'))

  for (const wall of ['2028-02-30T12:34', '2100-02-29T12:34', '2028-04-31T12:34', '2028-01-00T12:34', '2028-01-31T24:00', '0099-01-31T10:00', '2028-01-01T12:34:01']) {
    assert.deepEqual(await preview(request(once(wall), 'en', true)), invalid('invalid-once'), wall)
  }
  // These tighten the server boundary only: Desktop retains normalization and minute truncation.
  const time = Date.parse('2026-01-01T00:00:00Z')
  assert.equal(desktopPreview(once('2028-02-30T12:34'), 'en', false, time).nextRunAt, Date.parse('2028-03-01T12:34:00Z'))
  assert.equal(desktopPreview(once('2028-01-01T12:34:01'), 'en', false, time).nextRunAt, Date.parse('2028-01-01T12:34:00Z'))
})

test('preview matches Desktop around DST gaps and repeated wall minutes', async t => {
  const cases = [
    // The scan traverses 01:59 -> 03:00, or starts after 01:59 and misses the gap.
    [recurring('30 2 * * *', LA), '2026-03-08T09:58:00Z', '2026-03-08T10:00:00Z'],
    [recurring('30 2 * * *', LA), '2026-03-08T09:59:00Z', '2026-03-09T09:30:00Z'],
    // Desktop's two-offset once conversion lands at 01:30, not 03:00, in this LA gap.
    [once('2026-03-08T02:30', LA), '2026-03-08T08:00:00Z', '2026-03-08T09:30:00Z'],
    // The cron scan returns the first match strictly after the cutoff; both 01:30s can match.
    [recurring('30 1 * * *', LA), '2026-11-01T07:00:00Z', '2026-11-01T08:30:00Z'],
    [recurring('30 1 * * *', LA), '2026-11-01T08:30:00Z', '2026-11-01T09:30:00Z'],
    // Ambiguous once resolves via the offset calculation: earlier in LA, later in Berlin.
    [once('2026-11-01T01:30', LA), '2026-11-01T07:00:00Z', '2026-11-01T08:30:00Z'],
    [once('2026-10-25T02:30', 'Europe/Berlin'), '2026-10-25T00:00:00Z', '2026-10-25T01:30:00Z']
  ]
  for (const [schedule, after, next] of cases) {
    const { preview } = fixture(t, after)
    const desktop = desktopPreview(schedule, 'en', false, Date.parse(after))
    assert.equal(desktop.nextRunAt, Date.parse(next))
    assert.deepEqual(await preview(request(schedule)), desktop)
  }
})

test('past once and equality with the evaluation instant respect allowPast', async t => {
  const { preview } = fixture(t)
  for (const [wall, description] of [
    ['2025-12-31T23:59', 'once at 2025-12-31 23:59'],
    ['2026-01-01T00:00', 'once at 2026-01-01 00:00']
  ]) {
    assert.deepEqual(await preview(request(once(wall))), invalid('invalid-once'))
    assert.deepEqual(await preview(request(once(wall), 'en', true)), success(description, null))
  }
  assert.deepEqual(await preview(request(once('2026-01-01T00:01'))), success('once at 2026-01-01 00:01', '2026-01-01T00:01:00Z'))
})

test('rejects extra or mistyped fields, offsets, oversized fields, and client clocks/code', async t => {
  const { preview } = fixture(t)
  const { schedule, locale, allowPast } = valid
  const accessor = { locale, allowPast, get schedule() { assert.fail('accessor invoked') } }
  const proto = Object.create({ schedule })
  for (const input of [null, [], accessor, proto, { schedule, locale }, { schedule, allowPast },
    { ...valid, locale: 'en-US' }, { ...valid, allowPast: 'false' }, { ...valid, allowPast: 0 },
    { ...valid, now: 0 }, { ...valid, timestamp: 0 }, { ...valid, code: 'return true' },
    { ...valid, schedule: { ...schedule, at: '2026-01-01T00:01' } },
    { ...valid, schedule: { ...schedule, taskId: 'other' } },
    { ...valid, schedule: { ...schedule, kind: 'other' } },
    { ...valid, schedule: { kind: 'once', at: '2026-01-01T00:01' } },
    { ...valid, schedule: { kind: 'recurring', tz: UTC } }]) {
    assert.deepEqual(await preview(input), invalid('invalid-input'))
  }
  for (const tz of [0, '', 'PST', '+08:00', 'UTC+08:00', 'Mars/Olympus_Mons', `Asia/${'A'.repeat(128)}`]) {
    assert.deepEqual(await preview(request(recurring('*/15 * * * *', tz))), invalid('invalid-tz'))
  }
  for (const cron of [0, '', '* * * * * *', '60 * * * *', '*/0 * * * *', 'z'.repeat(513)]) {
    assert.deepEqual(await preview(request(recurring(cron))), invalid('invalid-cron'))
  }
  for (const wall of [0, '2026-01-01T00:10:59', '2026-01-01T00:10Z', '2026-01-01T00:10:00.000', ' 2026-01-01T00:10 ', 'z'.repeat(20)]) {
    assert.deepEqual(await preview(request(once(wall))), invalid('invalid-once'))
  }
})

test('samples each accepted preview clock once and bypasses Desktop default when supplied', async t => {
  const time = Date.parse('2026-01-01T00:00:00Z')
  const clock = t.mock.method(Date, 'now', () => time)
  const schedule = once('2026-01-01T00:01')
  assert.equal(desktopPreview(schedule).nextRunAt, time + 60_000)
  assert.equal(clock.mock.callCount(), 1)
  assert.equal(desktopPreview(schedule, 'en', false, time + 60_000).ok, false)
  assert.equal(clock.mock.callCount(), 1)
  const runner = openTaskPreview()
  t.after(runner.close)
  assert.equal((await runner.preview(request(schedule))).nextRunAt, time + 60_000)
  assert.equal(clock.mock.callCount(), 2)
  assert.deepEqual(await runner.preview({ ...valid, now: time }), invalid('invalid-input'))
  assert.equal(clock.mock.callCount(), 2)
})

test('limits concurrency without a queue, aborts work, and recovers capacity after exit', async t => {
  const { preview } = fixture(t)
  const alreadyAborted = AbortSignal.abort()
  await assert.rejects(preview(valid, alreadyAborted), fault('preview_aborted'))
  const cancel = new AbortController()
  const first = assert.rejects(preview(valid, cancel.signal), fault('preview_aborted'))
  const second = preview(valid)
  const overflow = assert.rejects(preview(valid), fault('preview_busy'))
  cancel.abort()
  // The cancelled worker is still charged to the limit until its exit event.
  const stillFull = assert.rejects(preview(valid), fault('preview_busy'))
  await Promise.all([first, overflow, stillFull])
  const expected = success('every 15 min', '2026-01-01T00:15:00Z')
  assert.deepEqual(await second, expected)
  assert.deepEqual(await preview(valid), expected)
})

test('close settles all pending previews and drains workers; repeated close is idempotent', async t => {
  const { preview, close } = fixture(t)
  const first = assert.rejects(preview(valid), fault('preview_closed'))
  const second = assert.rejects(preview(valid), fault('preview_closed'))
  const draining = close()
  assert.equal(close(), draining)
  await Promise.all([first, second, draining])
  await assert.rejects(preview(valid), fault('preview_closed'))
})

test('the wall timer terminates an in-flight worker at the preview budget', async t => {
  const { preview, close } = fixture(t)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  // Advance the main-thread clock before it can consume a real worker result.
  const timedOut = assert.rejects(preview(valid), fault('preview_timeout'))
  t.mock.timers.tick(2_000)
  await timedOut
  await close()
})

test('worker and parent dependency graphs expose no task store, filesystem, network or model access', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const parent = 'apps/headless/src/tasks/preview.mjs'
  const worker = 'apps/headless/src/tasks/preview-worker.mjs'
  const core = 'apps/headless/dist/schedule-core.mjs'
  const { metafile } = await build({
    absWorkingDir: root, entryPoints: [parent, worker], outdir: 'task-preview-dependency-check',
    bundle: true, platform: 'node', format: 'esm', metafile: true, write: false
  })
  assert.deepEqual(Object.keys(metafile.inputs).sort(), [parent, worker, core].sort())
  const imports = Object.values(metafile.outputs).flatMap(output => output.imports.map(dep => dep.path))
  assert.deepEqual([...new Set(imports)].sort(), ['node:events', 'node:worker_threads'])
})
