import { createEventJournal } from './journal.mjs'

export { chatScope, createEventJournal, SESSIONS_SCOPE } from './journal.mjs'

/**
 * Supply the real desktop chat-bus exports from the eventual host entry point. This module has no
 * startup side effects and no Electron import. Each installation owns its epoch and subscriptions.
 */
export function installDesktopEventBridge(source, limits) {
  if (typeof source?.onChatEvent !== 'function' || typeof source.onSessionsChanged !== 'function') {
    throw new TypeError('Expected onChatEvent and onSessionsChanged registrations')
  }
  const journal = createEventJournal(limits)
  const unregister = []
  let installed = true

  function uninstall() {
    if (!installed) return
    installed = false
    journal.close()
    for (const off of unregister.splice(0).reverse()) {
      try { off() } catch { /* finish removing the other desktop callbacks */ }
    }
  }

  function register(subscribe, callback) {
    const off = subscribe.call(source, callback)
    if (typeof off !== 'function') throw new TypeError('Desktop registration must return an unsubscribe function')
    unregister.push(off)
  }

  try {
    register(source.onChatEvent, (payload) => {
      if (!installed) return
      try { journal.publishChat(payload) } catch { /* protect the producer without logging payloads */ }
    })
    register(source.onSessionsChanged, () => {
      if (!installed) return
      try { journal.publishSessionsChanged() } catch { /* protect the producer */ }
    })
  } catch (error) {
    uninstall()
    throw error
  }
  return Object.freeze({ journal, uninstall })
}
