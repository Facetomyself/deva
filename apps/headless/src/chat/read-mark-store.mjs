import { isAbsolute, resolve } from 'node:path'
import { isPromise } from 'node:util/types'
import { close } from '../files/workspace-files-fd.mjs'
import { HttpError } from '../http/policy.mjs'
import { invalidReadState, readStateConflict, readStateError, readStateReadOnly, readStateUnconfirmed } from './read-mark-errors.mjs'
import { pinReadMarkRoot, withReadMarkFile } from './read-mark-file.mjs'
import { advanceReadState, parseReadState, validReadMark } from './read-mark-format.mjs'

function authorize(verify) {
  if (typeof verify !== 'function') throw new HttpError(401, 'auth')
  let result
  try {
    result = verify()
    // Reject asynchronous authorization without invoking arbitrary thenable implementations.
    if (isPromise(result)) Promise.prototype.then.call(result, undefined, () => {})
  } catch (error) {
    if (error instanceof HttpError && ((error.status === 401 && error.code === 'auth') ||
      (error.status === 409 && (error.code === 'read_view_stale' || error.code === 'read_view_busy')) ||
      (error.status === 503 && error.code === 'conversation_status_unavailable'))) throw error
    throw new HttpError(401, 'auth')
  }
  if (result !== true) throw new HttpError(401, 'auth')
}

/** One Workbench instance owner's native read marks, shared across that owner's logins.
 * The caller authorizes disclosures and filters the private snapshot to visible sessions.
 * `through` comes only from the authorized durable session revision, never the request clock.
 * Methods are synchronous; no snapshot, callback or parsed map is retained between operations. */
export function openReadMarkStore(options) {
  const { dataDir } = options ?? {}
  if (typeof dataDir !== 'string' || !isAbsolute(dataDir) || dataDir.includes('\0') || Buffer.byteLength(dataDir) > 4095) {
    throw invalidReadState()
  }
  const root = resolve(dataDir)
  if (root === '/') throw invalidReadState()
  let pin
  let active = false
  let closed = false

  function release() {
    const held = pin
    pin = undefined
    close(held?.fd)
  }
  function assertOpen() { if (closed) throw readStateUnconfirmed() }

  function run(operation) {
    assertOpen()
    if (active) throw readStateConflict()
    active = true
    try { return operation() }
    catch (error) { throw readStateError(error) }
    finally {
      active = false
      // `verify` can close the store reentrantly; keep the anchor live until its current
      // operation winds down so no descriptors are recycled under active filesystem work.
      if (closed) release()
    }
  }

  function rootPin() {
    if (!pin) pin = pinReadMarkRoot(root) ?? pinReadMarkRoot(root)
    return pin
  }

  return Object.freeze({
    snapshot() {
      return run(() => {
        const held = rootPin()
        if (!held) return new Map()
        return withReadMarkFile(root, held, (bytes, confirm) => {
          const snapshot = bytes === null ? new Map() : parseReadState(bytes).values
          confirm()
          return snapshot
        })
      })
    },
    advance(input, verify) {
      return run(() => {
        const reauthorize = () => { authorize(verify); assertOpen() }
        reauthorize()
        const { id, through } = input ?? {}
        if (!validReadMark(id, through)) throw invalidReadState()
        const held = rootPin()
        if (!held) throw readStateReadOnly()
        return withReadMarkFile(root, held, (bytes, confirm, publish) => {
          const state = bytes === null ? null : parseReadState(bytes, id)
          const previous = state?.values.get(id)
          if (previous !== undefined && previous >= through) {
            reauthorize()
            confirm()
            return { changed: false, readAt: previous }
          }
          publish(advanceReadState(state, id, through), reauthorize)
          return { changed: true, readAt: through === 0 ? 0 : through }
        })
      })
    },
    close() {
      if (closed) return
      closed = true
      if (!active) release()
    }
  })
}
