import { isAbsolute, resolve } from 'node:path'
import { HttpError } from '../http/policy.mjs'
import { taskConflict, taskUnauthorized, taskUnconfirmed } from './errors.mjs'
import { parseNativeTasks, pauseNativeTask, taskRevision, validTaskId, validTaskRevision, validTaskTime } from './native.mjs'
import { withTaskStorage } from './storage.mjs'

const execution = 'inactive'
const invalidId = () => new HttpError(400, 'invalid_task_id')

function taskEntry(document, id) {
  const entry = document.entries.find(item => item.summary.id === id)
  if (!entry) throw new HttpError(404, 'task_not_found')
  return entry
}

function authenticate(verifyOwner, id) {
  if (typeof verifyOwner !== 'function') throw taskUnauthorized()
  let verification
  try { verification = verifyOwner(id) }
  catch (error) {
    if (error?.code === 'AUTH_FAILED') throw new HttpError(401, 'auth')
    throw error
  }
  if (typeof verification?.then === 'function') {
    Promise.resolve(verification).catch(() => {})
    throw taskUnauthorized()
  }
  if (verification === false) throw taskUnauthorized()
}

/**
 * Owner-authorized caller; read authorization is the caller's responsibility. Pause also
 * takes a required synchronous assertion of the *original* owner's current authorization.
 * Native storage is reopened per operation, so this store needs no close or global cache.
 */
export function openTaskStore({ dataDir, now = Date.now }) {
  if (typeof dataDir !== 'string' || !isAbsolute(dataDir) || typeof now !== 'function') throw taskUnconfirmed()
  const root = resolve(dataDir)

  return Object.freeze({
    async list() {
      return withTaskStorage(root, storage => {
        const file = storage.read()
        const { entries } = parseNativeTasks(file)
        const tasks = entries.map(entry => entry.summary).sort((a, b) => a.createdAt - b.createdAt)
        return { tasks, revision: taskRevision(file), execution }
      })
    },
    async get(id) {
      if (!validTaskId(id)) throw invalidId()
      return withTaskStorage(root, storage => {
        const file = storage.read()
        const { detail: task } = taskEntry(parseNativeTasks(file), id)
        return { task, revision: taskRevision(file), execution }
      })
    },
    async pause(id, revision, verifyOwner) {
      if (!validTaskId(id)) throw invalidId()
      if (!validTaskRevision(revision)) throw new HttpError(400, 'invalid_task_revision')
      authenticate(verifyOwner, id)
      return withTaskStorage(root, storage => {
        const before = storage.read()
        if (taskRevision(before) !== revision) throw taskConflict()
        const document = parseNativeTasks(before)
        const entry = taskEntry(document, id)
        const reauthorize = () => authenticate(verifyOwner, id)
        if (entry.summary.status === 'paused') {
          reauthorize()
          // Idempotent retry still checks disk after reauthorization, and performs no write.
          const current = storage.check(before, revision)
          return { task: taskEntry(parseNativeTasks(current), id).detail, revision, execution }
        }
        if (entry.summary.status !== 'active') throw new HttpError(409, 'task_state')
        if (!entry.detail.pauseAllowed) throw taskUnconfirmed()
        const updatedAt = now()
        if (!validTaskTime(updatedAt)) throw taskUnconfirmed()
        // Desktop pauses by changing only status and updatedAt, retaining nextRunAt and counters.
        const bytes = pauseNativeTask(document, entry, updatedAt)
        const confirmed = storage.publish(before, revision, bytes, reauthorize)
        const { detail: task } = taskEntry(parseNativeTasks(confirmed), id)
        return { task, revision: taskRevision(confirmed), execution }
      })
    }
  })
}
