import { Worker } from 'node:worker_threads'
import { HttpError } from '../http/policy.mjs'

const file = new URL('./inspect-worker.mjs', import.meta.url)
const codes = new Map([
  ['git_stale',409], ['git_limit',413], ['git_unsafe',403], ['git_corrupt',422],
  ['git_object_unavailable',422], ['unsupported_git_layout',422], ['git_timeout',503], ['git_unavailable',503]
])
export function gitFault(code) { return new HttpError(codes.get(code) ?? 503, codes.has(code) ? code : 'git_unavailable') }

/** The directory lease remains held by the caller until the Worker has actually exited.
 * No caller-provided code/filename/argv/env/URL is passed to a worker. */
export function inspectInWorker(pin, job, signal) {
  if (signal.aborted) return Promise.reject(gitFault('git_unavailable'))
  return new Promise((resolve, reject) => {
    let worker
    try {
      worker = new Worker(file, { workerData: { fd: pin.fd, mount: String(pin.mount), job },
        execArgv: [], env: {}, trackUnmanagedFds: true, stdout: true, stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } })
    } catch { reject(gitFault('git_unavailable')); return }
    worker.stdout.resume(); worker.stderr.resume()
    let outcome, failure, terminating = false
    function terminate(code) {
      failure ??= code
      if (!terminating) { terminating = true; void worker.terminate().catch(() => {}) }
    }
    const abort = () => terminate('git_unavailable')
    const timer = setTimeout(() => terminate('git_timeout'), 6000); timer.unref()
    signal.addEventListener('abort', abort, { once: true })
    worker.on('message', result => {
      if (outcome || !result || typeof result.ok !== 'boolean') { terminate('git_unavailable'); return }
      outcome = result
    })
    worker.once('messageerror', () => terminate('git_unavailable'))
    worker.once('error', () => terminate('git_unavailable'))
    worker.once('exit', code => {
      clearTimeout(timer); signal.removeEventListener('abort', abort)
      if (signal.aborted || failure || code !== 0 || !outcome) { reject(gitFault(failure ?? 'git_unavailable')); return }
      if (!outcome.ok) reject(gitFault(outcome.error))
      else resolve(outcome.result)
    })
    if (signal.aborted) abort()
  })
}
