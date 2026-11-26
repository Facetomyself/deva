import { unavailable } from './validation.mjs'

/** Keep API/shutdown promises independent of an unresponsive worker promise. */
export function within(ms, signal, work) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(unavailable()); return }
    const finish = (fn, value) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      fn(value)
    }
    const cancel = () => finish(reject, unavailable())
    const timer = setTimeout(cancel, ms)
    signal?.addEventListener('abort', cancel, { once: true })
    let pending
    try { pending = work() } catch { cancel(); return }
    void Promise.resolve(pending).then(value => finish(resolve, value), cancel)
  })
}

/** A viewer-local single poll. Timeout itself never adds an event to the journal. */
export function waitForViewer(view, ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(unavailable()); return }
    const wake = () => finish(resolve)
    const cancel = () => finish(reject, unavailable())
    const finish = (fn, value) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      fn(value)
    }
    const timer = setTimeout(wake, ms)
    view.poll = wake
    signal?.addEventListener('abort', cancel, { once: true })
  })
}
