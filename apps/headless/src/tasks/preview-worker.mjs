import { parentPort, workerData } from 'node:worker_threads'
import { previewSchedule } from '../../dist/schedule-core.mjs'

// A single calculation using Desktop's rules, not a scheduler. For example,
// an LA spring gap may be observed during a cron scan and filled at 03:00;
// a once at 02:30 resolves to 01:30 under Desktop's two-offset calculation.
// An ambiguous once uses that same calculation, not necessarily the earlier
// instant. A cron scan in the repeated hour may find the second occurrence
// if its cutoff is already on/after the first occurrence.
const { request: { schedule, locale, allowPast }, timestamp } = workerData
parentPort.postMessage(previewSchedule(schedule, locale, allowPast, timestamp))
