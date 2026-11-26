import { FRAME_LIMIT, VIEWPORT } from '../../../browser-worker/src/engine/policy.mjs'
import { validOpaqueId } from '../../../browser-worker/src/worker-control.mjs'
import { BrowserHandoffError, createBrowserHandoff } from './handoff.mjs'

export function deny() { throw new BrowserHandoffError('HANDOFF_DENIED') }
export function unavailable() { throw new BrowserHandoffError('HANDOFF_UNAVAILABLE') }

// Transport or engine exceptions never become public errors. Validation is affirmative:
// neither a Promise nor a missing/malformed acknowledgement counts as success.
export async function workerAck(operation, validate) {
  try {
    const result = await operation()
    if (validate(result) === true) return result
  } catch { /* the exception can carry private data */ }
  unavailable()
}

const scope = ({ sessionId, tabId }, controlId) =>
  controlId === undefined ? { sid: sessionId, tabId } : { sid: sessionId, tabId, controlId }
const exact = (tab, binding) => tab?.sessionId === binding.sessionId && tab.tabId === binding.tabId &&
  tab.tabId === binding.targetId && tab.actor.ownerId === binding.ownerId && tab.actor.loginSessionId === binding.loginSessionId

const isFrame = (frame) => frame?.mimeType === 'image/png' && frame.width === VIEWPORT.width &&
  frame.height === VIEWPORT.height && Buffer.isBuffer(frame.bytes) && frame.bytes.length >= 45 && frame.bytes.length <= FRAME_LIMIT

/** Serial caller bridges real worker acknowledgements to the sync metadata domain. */
export function createAsyncHandoff({ client, lookup, authorized, onClose, now, randomBytes }) {
  let receipt
  function confirm(op, binding, detail) {
    if (receipt?.op !== op || !exact(receipt.tab, binding) || receipt.detail !== detail ||
        lookup(binding.sessionId) !== receipt.tab) return false
    receipt = undefined
    return true
  }
  function commit(op, tab, detail, publish) {
    if (receipt) unavailable()
    receipt = { op, tab, detail }
    try {
      const value = publish()
      if (receipt) unavailable()
      return value
    } finally { receipt = undefined }
  }

  const core = createBrowserHandoff({ now, randomBytes,
    authorize(binding) {
      const tab = lookup(binding.sessionId)
      return exact(tab, binding) && authorized(tab)
    },
    worker: {
      // The worker-created tab ID pins the Target generation. There is no cached
      // RPC acknowledgement here: every private operation below checks its real
      // control ID, and the worker transport independently pins its endpoint inode.
      isLive(binding) { return exact(lookup(binding.sessionId), binding) },
      pause(binding) { return confirm('pause', binding) },
      attach(binding) { return confirm('attach', binding) },
      release(binding, intent) { return confirm('release', binding, intent) },
      close(binding) {
        const tab = lookup(binding.sessionId)
        if (exact(tab, binding)) onClose(tab)
        // Timer/revocation is synchronous; the real close is tracked separately.
        // At this point cleanup is unconfirmed, so the core quarantines the Target.
        return false
      },
    },
  })

  async function pause(tab, guard) {
    guard()
    const { controlId } = await workerAck(() => client.startPrivacy(scope(tab)), (value) => validOpaqueId(value?.controlId))
    guard()
    commit('pause', tab, undefined, () => core.offer({ actor: tab.actor, sessionId: tab.sessionId, tabId: tab.tabId,
      targetId: tab.tabId, origin: tab.origin, label: tab.label }))
    return controlId
  }

  async function operate(tab, control, permit, guard, op, action) {
    guard()
    const args = scope(tab, control)
    const result = op === 'frame' ? await workerAck(() => client.frame(args), isFrame) :
      await workerAck(() => client.input({ ...args, action }), (value) => value?.accepted === true)
    try {
      guard()
      // The worker has no standalone attach verb. The completed private RPC is
      // the per-request acknowledgement of the exact private worker channel.
      const access = commit('attach', tab, undefined, () => permit.attach())
      try {
        if (!(op === 'frame' ? access.allowsFrame() : access.allowsInput())) deny()
        guard()
      } finally { access.disconnect() }
      return result
    } catch (error) {
      if (op === 'frame') result.bytes.fill(0)
      throw error
    }
  }

  async function release(tab, control, permit, intent, guard) {
    guard()
    await workerAck(() => client.endPrivacy(scope(tab, control)), (value) => value?.released === true)
    guard()
    return commit('release', tab, intent, () => permit.finish())
  }

  return Object.freeze({ core, pause, operate, release })
}
