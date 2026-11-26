import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

export class TaskInspectionCheckError extends Error {}
export function check(value, description) {
  if (!value) throw new TaskInspectionCheckError(description)
}

const utc = value => Date.parse(`${value}Z`)
const privateLedger = 'QaNativeOnlyPerTaskFieldMarker'
const privateRoot = 'QaNativeOnlyTopLevelFieldMarker'
const auth = { personaId: null, modelRef: null }
export const activeTask = {
  id: '6423d221-6c4a-4cb1-8c43-b4f1701b7551', title: 'QA archive reminder',
  prompt: 'Read the invented archive notes.\n<b data-task-inspection-fixture="prompt">Literal QA text</b> & keep punctuation.',
  schedule: { kind: 'recurring', cron: '8 9 * * 2', tz: 'UTC' }, auth,
  sessionId: 'task-6423d221-6c4a-4cb1-8c43-b4f1701b7551',
  status: 'active', createdAt: utc('2024-01-01T14:15:00'), updatedAt: utc('2024-01-04T15:16:00'),
  lastRunAt: utc('2024-01-02T09:08:00'), nextRunAt: utc('2035-01-02T09:08:00'), consecutiveErrors: 0,
  runs: [{ firedAt: utc('2024-01-02T09:08:00'), finishedAt: utc('2024-01-02T09:09:00'), status: 'ok',
    summary: '<em data-task-inspection-fixture="history">Literal QA history</em> & only synthetic text.' }],
  privateQaLedger: { marker: privateLedger, values: ['synthetic only', 23] }
}
export const completedTask = {
  id: 'c8a84daf-357b-4d66-8321-289196efdeeb', title: 'QA completed handover', prompt: 'Read the already completed synthetic handover.',
  schedule: { kind: 'once', at: '2024-01-03T19:31', tz: 'UTC' }, auth,
  sessionId: 'task-c8a84daf-357b-4d66-8321-289196efdeeb',
  status: 'completed', createdAt: utc('2024-01-02T12:32:00'), updatedAt: utc('2024-01-03T19:32:00'),
  lastRunAt: utc('2024-01-03T19:31:00'), nextRunAt: null, consecutiveErrors: 0,
  runs: [{ firedAt: utc('2024-01-03T19:31:00'), finishedAt: utc('2024-01-03T19:32:00'), status: 'ok', summary: 'Completed synthetic run.' }]
}
export const previewCron = '17 13 * * *'
export const privateMarkers = [privateLedger, privateRoot, 'privateQaLedger', 'privateQaState']
const original = { version: 1, tasks: [activeTask, completedTask], privateQaState: { marker: privateRoot } }

export async function createTaskInspectionFixture() {
  const parent = await realpath(tmpdir()), prefix = join(parent, 'deva-wb-task-inspection-')
  const root = await mkdtemp(prefix)
  const identity = await lstat(root)
  check(dirname(root) === parent && root.startsWith(prefix) && /^[A-Za-z0-9]{6}$/.test(root.slice(prefix.length)),
    'Unexpected task fixture directory')
  async function verifyRoot() {
    const current = await lstat(root)
    check(current.isDirectory() && current.uid === process.geteuid() && (current.mode & 0o777) === 0o700 &&
      current.dev === identity.dev && current.ino === identity.ino && await realpath(root) === root, 'Task fixture root identity changed')
  }
  async function close() { await verifyRoot(); await rm(root, { recursive: true }) }
  try {
    await verifyRoot()
    const dataDir = join(root, 'data'), path = join(dataDir, 'tasks.json')
    await mkdir(dataDir, { mode: 0o700 })
    const dataIdentity = await lstat(dataDir)
    // Deliberately use distinct original whitespace; a preview must preserve the native file byte for byte.
    const before = Buffer.from(`${JSON.stringify(original, null, 2)}\n\n`)
    await writeFile(path, before, { flag: 'wx', mode: 0o600 })
    async function readNative() {
      await verifyRoot()
      const data = await lstat(dataDir)
      check(data.isDirectory() && data.ino === dataIdentity.ino && data.dev === dataIdentity.dev && await realpath(dataDir) === dataDir,
        'Native task data directory changed identity')
      const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const stat = await fd.stat({ bigint: true })
        check(stat.isFile() && stat.uid === BigInt(process.geteuid()) && (stat.mode & 0o777n) === 0o600n &&
          stat.nlink === 1n && stat.size <= 64n * 1024n, 'Expected a private regular tasks.json in the fixture')
        return { bytes: await fd.readFile(), mtime: stat.mtimeNs, inode: stat.ino }
      } finally { await fd.close() }
    }
    const initial = await readNative()
    check(initial.bytes.equals(before), 'Synthetic native tasks were not written exactly')
    return {
      root, dataDir, close, initialRevision: createHash('sha256').update(before).digest('hex'),
      async assertOriginal() {
        const current = await readNative()
        check(current.bytes.equals(before) && current.mtime === initial.mtime && current.inode === initial.inode,
          'Native task bytes or metadata changed before explicit Pause confirmation')
      },
      async assertPaused(from, to, previous) {
        const { bytes } = await readNative()
        const value = JSON.parse(bytes)
        const updatedAt = value.tasks?.find(row => row.id === activeTask.id)?.updatedAt
        check(Number.isSafeInteger(updatedAt) && updatedAt >= from && updatedAt <= to && updatedAt > activeTask.updatedAt,
          'Confirmed Pause did not save a fresh updatedAt')
        const expected = before.toString('utf8').replace('"status": "active"', '"status": "paused"')
          .replace(`"updatedAt": ${activeTask.updatedAt}`, `"updatedAt": ${updatedAt}`)
        check(bytes.equals(Buffer.from(expected)) &&
          isDeepStrictEqual(value, { ...original, tasks: [{ ...activeTask, status: 'paused', updatedAt }, completedTask] }),
          'Confirmed Pause changed bytes beyond task status and updatedAt, or rewrote other records or history')
        const current = { updatedAt, hash: createHash('sha256').update(bytes).digest('hex') }
        check(!previous || isDeepStrictEqual(current, previous), 'A subsequent read changed the paused task file')
        return current
      }
    }
  } catch (error) {
    await close()
    throw error
  }
}
