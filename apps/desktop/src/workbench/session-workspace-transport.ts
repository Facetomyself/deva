import { isWorkspaceRevision } from './chat-transport'
import { HttpFailure, type Transport } from './transport'
import type { WorkspaceOption } from './workspace-transport'

export type AttachedWorkspace = {
  id: string
  name: string | null
  state: 'available' | 'unavailable'
  source: 'manual' | 'role'
}
export type WorkspaceBinding = { workspace: AttachedWorkspace | null; revision: string }

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isWorkspaceId = (value: unknown): value is string => typeof value === 'string' && value.length === 34 &&
  value.startsWith('w_') && !/[^a-f0-9]/u.test(value.slice(2))
const projectLabel = (value: unknown): value is string => typeof value === 'string' && value.length > 0 &&
  value.length <= 255 && !/[\\/\x00-\x1f\x7f-\x9f]/u.test(value) && value !== '.' && value !== '..'

function parseBinding(value: unknown): WorkspaceBinding {
  if (!record(value) || !isWorkspaceRevision(value.revision)) throw new Error('Invalid conversation workspace revision')
  const { workspace, revision } = value
  if (workspace === null) return { workspace, revision }
  if (!record(workspace)) throw new Error('Invalid conversation workspace')
  const { id, name, state, source } = workspace
  if (!isWorkspaceId(id) || (state !== 'available' && state !== 'unavailable') ||
      (source !== 'manual' && source !== 'role')) throw new Error('Invalid conversation workspace')
  if (state === 'unavailable' && name === null) return { workspace: { id, name: null, state, source }, revision }
  if (state !== 'available' || !projectLabel(name)) throw new Error('Invalid conversation workspace')
  return { workspace: { id, name, state, source }, revision }
}

export function createSessionWorkspaceTransport(transport: Transport, csrf: string) {
  function path(sid: string): string {
    if (!sid || /^[A-Za-z0-9_-]{1,128}$/u.exec(sid)?.[0] !== sid) throw new Error('Invalid chat id')
    return `/chats/${sid}/workspace`
  }
  const options = (signal: AbortSignal) => ({ signal, referrerPolicy: 'same-origin' as const })
  return {
    async read(sid: string, signal: AbortSignal): Promise<WorkspaceBinding> {
      return parseBinding(await transport.request(path(sid), 'GET', undefined, undefined, options(signal)))
    },
    async patch(sid: string, revision: string, workspaceId: string | null, signal: AbortSignal): Promise<WorkspaceBinding> {
      if (!csrf || !isWorkspaceRevision(revision) || (workspaceId !== null && !isWorkspaceId(workspaceId)))
        throw new Error('Invalid conversation workspace selection')
      const result = parseBinding(await transport.request(path(sid), 'PATCH', { revision, workspaceId }, csrf, options(signal)))
      if (workspaceId === null ? result.workspace !== null : result.workspace?.id !== workspaceId || result.workspace.source !== 'manual')
        throw new Error('Conversation workspace change not confirmed')
      return result
    },
    async projects(signal: AbortSignal): Promise<WorkspaceOption[]> {
      let value: unknown
      try { value = await transport.request('/workspaces', 'GET', undefined, undefined, options(signal)) }
      catch (error) {
        // Older or unmounted catalogues may omit this route; the conversation resource is independent.
        if (error instanceof HttpFailure && ([404, 405, 501].includes(error.status) || error.code === 'workspace_unavailable')) return []
        throw error
      }
      if (!record(value) || !Array.isArray(value.workspaces)) throw new Error('Invalid workspace catalogue')
      const seen = new Set<string>()
      return value.workspaces.map((item) => {
        if (!record(item) || !isWorkspaceId(item.id) || !projectLabel(item.name) || seen.has(item.id))
          throw new Error('Invalid workspace catalogue entry')
        seen.add(item.id)
        return { id: item.id, name: item.name }
      })
    }
  }
}

export type SessionWorkspaceTransport = ReturnType<typeof createSessionWorkspaceTransport>
