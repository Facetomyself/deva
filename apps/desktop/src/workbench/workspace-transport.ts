import type { Revision, Transport } from './transport'

export type WorkspaceOption = { id: string; name: string }
export type WorkspaceEntry = { type: 'dir' | 'file'; name: string; path: string }
export type WorkspaceDirectory = { path: string; entries: WorkspaceEntry[]; writable: boolean }
export type WorkspaceFile = { path: string } & (
  | { kind: 'text'; content: string; revision: Revision; writable: boolean }
  | { kind: 'binary' | 'tooLarge'; writable: false }
)

function invalid(): never { throw new Error('Invalid workspace request or response') }
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid()
}
function idOf(id: unknown): string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : invalid()
}
function revisionOf(value: unknown): Revision {
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return invalid()
}
function relative(path: string, root = false): string {
  if (root && path === '') return path
  if (typeof path !== 'string' || /[\\\x00-\x1f\x7f-\x9f]/.test(path) ||
      !path.split('/').every((segment) => segment && segment !== '.' && segment !== '..' && !/^[A-Za-z]:/.test(segment))) return invalid()
  return path
}

/** Owner-selected, project-relative operations only; never passes a chat cwd or host path. */
export function createWorkspaceTransport(transport: Transport, csrf: string) {
  const resource = (id: string, action: 'list' | 'read' | 'file'): string => `/workspaces/${idOf(id)}/${action}`
  return {
    async projects(signal?: AbortSignal): Promise<WorkspaceOption[]> {
      const result = object(await transport.request('/workspaces', 'GET', undefined, undefined, signal ? { signal } : undefined))
      if (!Array.isArray(result.workspaces)) return invalid()
      const seen = new Set<string>()
      return result.workspaces.map((item) => {
        const { id, name } = object(item)
        const key = idOf(id)
        if (typeof name !== 'string' || !name || seen.has(key)) return invalid()
        seen.add(key)
        return { id: key, name }
      })
    },
    async list(id: string, path: string, signal?: AbortSignal): Promise<WorkspaceDirectory> {
      const result = object(await transport.request(resource(id, 'list'), 'POST', { path: relative(path, true) }, csrf, signal ? { signal } : undefined))
      if (result.path !== path || !Array.isArray(result.entries)) return invalid()
      const prefix = path === '' ? '' : `${path}/`
      const seen = new Set<string>()
      const entries = result.entries.map((item): WorkspaceEntry => {
        const { type, name, path: child } = object(item)
        if ((type !== 'file' && type !== 'dir') || typeof name !== 'string' || name.includes('/') ||
            typeof child !== 'string' || child !== prefix + relative(name) || seen.has(child)) return invalid()
        seen.add(child)
        return { type, name, path: child }
      })
      return { path, entries, writable: result.writable === true }
    },
    async read(id: string, path: string): Promise<WorkspaceFile> {
      const result = object(await transport.request(resource(id, 'read'), 'POST', { path: relative(path) }, csrf))
      if (result.path !== path || (result.binary !== undefined && typeof result.binary !== 'boolean') ||
          (result.tooLarge !== undefined && typeof result.tooLarge !== 'boolean')) return invalid()
      if (result.tooLarge === true) return { path, kind: 'tooLarge', writable: false }
      if (result.binary === true) return { path, kind: 'binary', writable: false }
      if (typeof result.content !== 'string') return invalid()
      return { path, kind: 'text', content: result.content, revision: revisionOf(result.revision), writable: result.writable === true }
    },
    async save(id: string, path: string, content: string, revision: Revision): Promise<Revision> {
      const result = object(await transport.request(resource(id, 'file'), 'PUT', { path: relative(path), content, revision: revisionOf(revision) }, csrf))
      if (result.ok !== true) return invalid()
      return revisionOf(result.revision)
    }
  }
}

export type WorkspaceTransport = ReturnType<typeof createWorkspaceTransport>
