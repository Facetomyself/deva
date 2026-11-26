import { createChatStore, isValidSessionId } from './chat-store-core'
import type { ChatSessionMeta } from './chat-storage-types'
import { getDevaHome } from './config'
import { getDesktopMediaStore } from './media-store'
import { removeToolResults } from './tool-results'

export type { ChatSessionMeta, StoredNotice, StoredSession } from './chat-storage-types'
export { deriveTitle, projectKey } from './chat-store-core'

let desktopStore: ReturnType<typeof createChatStore> | undefined

function store(): ReturnType<typeof createChatStore> {
  return (desktopStore ??= createChatStore({ dataDir: getDevaHome(), media: getDesktopMediaStore(), removeToolResults }))
}

export const listSessions = (): ChatSessionMeta[] => {
  try { return store().listSessions() } catch { return [] }
}
export const getSession = (id: string) => isValidSessionId(id) ? store().getSession(id) : undefined
export const ensureSession: ReturnType<typeof store>['ensureSession'] = (id, opts) => store().ensureSession(id, opts)
export const save = (id: string): void => { if (isValidSessionId(id)) store().save(id) }
export const setSessionArchived = (id: string, archived: boolean): boolean =>
  isValidSessionId(id) && store().setSessionArchivedLegacy(id, archived)
export const rebindSessionPersona: ReturnType<typeof store>['rebindSessionPersona'] = (id, from, to) => {
  try { return store().rebindSessionPersona(id, from, to) } catch { return false }
}
export const syncSessionBinding: ReturnType<typeof store>['syncSessionBinding'] = (id, binding) => {
  try { return store().syncSessionBinding(id, binding) } catch { return false }
}
export function deleteSession(id: string): void {
  if (isValidSessionId(id)) {
    try { store().deleteSession(id) } catch { /* desktop deletes remain best effort */ }
  }
}
