import type { MemoryEntry, MemoryErrorCode, MemorySnapshot, MemoryType, UserProfile } from '../shared/host-settings'
import { isRoleId } from './chat-transport'
import { HttpFailure, type LibraryQueue, type Revision, type Transport } from './transport'

export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const
export type MemoryInput = Pick<MemoryEntry, 'type' | 'title' | 'body'>
export type Scope = { kind: 'global' } | { kind: 'role'; id: string } | { kind: 'project'; id: string; signal?: AbortSignal }
export type ProfileSnapshot = { profile: UserProfile; revision: Revision; imageRevision: Revision }
export type RoleImage = { image: string; revision: Revision; imageRevision: Revision }
export type MemoryState = { snapshot: MemorySnapshot; revision: Revision }
export type MemoryResult = ({ ok: true; snapshot: MemorySnapshot } | { ok: false; code: MemoryErrorCode }) & { revision: Revision }
export type WorkspaceOption = { id: string; name: string }
export type RoleFields = { name: string; description: string; avatar: string; model: string; prompt: string; workspaceId: string; enabled: boolean }
export type Role = RoleFields & { id: string; workspaceName: string; protected: boolean; revision: Revision }
export type Roster = { roles: Role[]; order: string[]; revision: Revision }

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid library response')
  return value as Record<string, unknown>
}
const string = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('Invalid library string')
  return value
}
const number = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('Invalid library number')
  return value
}
const boolean = (value: unknown): boolean => {
  if (typeof value !== 'boolean') throw new Error('Invalid library flag')
  return value
}
const revision = (value: unknown): Revision => {
  if (typeof value === 'number') return number(value)
  const token = string(value)
  if (!token) throw new Error('Invalid library revision')
  return token
}
const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new Error('Invalid library list')
  return value
}
const opaqueId = (value: unknown): string => {
  const id = string(value)
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid library identifier')
  return id
}
const roleIdentifier = (value: unknown): string => {
  if (!isRoleId(value)) throw new Error('Invalid role id')
  return value
}
const imageUri = (value: unknown): string => {
  const uri = string(value)
  if (uri && !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(uri)) throw new Error('Invalid library image')
  return uri
}
const memoryErrors: readonly MemoryErrorCode[] = ['empty', 'tooLong', 'full', 'budget', 'notFound', 'duplicate', 'badType']
const conflict = (): HttpFailure => new HttpFailure(409, 'conflict')

function parseProfile(value: unknown): ProfileSnapshot {
  const result = object(value)
  const profile = object(result.profile)
  return { profile: { avatar: string(profile.avatar), avatarImage: imageUri(profile.avatarImage) }, revision: revision(result.revision),
    imageRevision: revision(result.imageRevision) }
}

function parseRoleImage(value: unknown): RoleImage {
  const result = object(value)
  return { image: imageUri(result.image), revision: revision(result.revision), imageRevision: revision(result.imageRevision) }
}

function parseMemory(value: unknown): MemorySnapshot {
  const snap = object(value)
  const entries = array(snap.entries).map((item): MemoryEntry => {
    const entry = object(item)
    const type = string(entry.type) as MemoryType
    if (!MEMORY_TYPES.includes(type)) throw new Error('Invalid memory type')
    return { id: string(entry.id), type, title: string(entry.title), body: string(entry.body),
      createdAt: number(entry.createdAt), updatedAt: number(entry.updatedAt) }
  })
  return { entries, used: number(snap.used), budget: number(snap.budget), maxEntries: number(snap.maxEntries),
    maxTitle: number(snap.maxTitle), maxBody: number(snap.maxBody) }
}

function parseRole(value: unknown): Role {
  const role = object(value)
  return { id: roleIdentifier(role.id), name: string(role.name), description: string(role.description), avatar: string(role.avatar),
    model: string(role.model), prompt: string(role.prompt), workspaceId: role.workspaceId === '' ? '' : opaqueId(role.workspaceId),
    workspaceName: string(role.workspaceName), enabled: boolean(role.enabled), protected: boolean(role.protected) || role.id === 'general',
    revision: revision(role.revision) }
}

function parseRoster(value: unknown): Roster {
  const result = object(value)
  const roles = array(result.roles).map(parseRole)
  const order = array(result.order).map(roleIdentifier)
  const map = new Map(roles.map((role) => [role.id, role]))
  if (map.size !== roles.length || new Set(order).size !== roles.length || order.length !== roles.length || order.some((id) => !map.has(id)))
    throw new Error('Invalid roster order')
  return { roles: order.map((id) => map.get(id)!), order, revision: revision(result.revision) }
}

const memoryPath = (scope: Scope): string => `/memory/${scope.kind}${scope.kind === 'global' ? '' : `/${scope.kind === 'role' ? roleIdentifier(scope.id) : opaqueId(scope.id)}`}`
const rolePath = (id: string): string => `/personas/${roleIdentifier(id)}`

export function createLibrary(transport: Transport, queue: LibraryQueue) {
  const getProfile = () => transport.request('/profile').then(parseProfile)
  const getRoster = () => transport.request('/personas').then(parseRoster)
  const getRole = async (id: string): Promise<Role> => {
    const role = parseRole(object(await transport.request(rolePath(id))).role)
    if (role.id !== id) throw new Error('Invalid role response')
    return role
  }
  const getRoleImage = (id: string) => transport.request(`${rolePath(id)}/avatar-image`).then(parseRoleImage)

  // A conversation-scoped editor may close while waiting in the owner library queue.
  async function memoryRequest(scope: Scope, method: string, body?: unknown, token?: string): Promise<unknown> {
    const signal = scope.kind === 'project' ? scope.signal : undefined
    const ensureOpen = (): void => { if (signal?.aborted) throw new Error('Project view closed') }
    ensureOpen()
    try {
      const value = await transport.request(memoryPath(scope), method, body, token, signal ? { signal, referrerPolicy: 'same-origin' } : undefined)
      ensureOpen()
      return value
    } catch (error) {
      ensureOpen()
      throw error
    }
  }

  function changeMemory(scope: Scope, method: 'POST' | 'DELETE', body: Record<string, unknown> & { revision: Revision }): Promise<MemoryResult> {
    return queue<MemoryResult>('write', async (token) => {
      const result = object(await memoryRequest(scope, method, body, token))
      const current = revision(result.revision)
      if (result.ok === true) return { value: { ok: true, snapshot: parseMemory(result.snapshot), revision: current } }
      const code = string(result.code) as MemoryErrorCode
      if (result.ok !== false || !memoryErrors.includes(code)) throw new Error('Invalid memory write result')
      if (current !== body.revision) throw conflict()
      return { value: { ok: false, code, revision: current } }
    })
  }

  function changeRole(path: string, method: 'POST' | 'PATCH' | 'PUT', fields: object): Promise<{ role: Role; roster: Roster }> {
    return queue('config-write', async (token) => {
      const role = parseRole(object(await transport.request(path, method, fields, token)).role)
      const roster = await getRoster()
      if (roster.roles.find((item) => item.id === role.id)?.revision !== role.revision) throw new Error('Role changed while saving')
      return { value: { role, roster } }
    })
  }

  return {
    profile: () => queue('read', async () => ({ value: await getProfile() })),
    saveProfile(baseline: ProfileSnapshot, spec: string, image: string): Promise<ProfileSnapshot> {
      return queue('config-write', async (token, expected) => {
        const before = await getProfile()
        if (before.revision !== expected || before.profile.avatar !== baseline.profile.avatar || before.imageRevision !== baseline.imageRevision)
          throw conflict()
        let configRevision = expected
        let imageRevision = before.imageRevision
        let confirmedImage = before.profile.avatarImage
        if (spec !== baseline.profile.avatar) {
          const result = object(await transport.request('/profile/avatar', 'PUT', { spec, revision: expected }, token))
          if (result.ok !== true) throw new Error('Invalid profile write result')
          configRevision = revision(result.revision)
        }
        // Settings and image are independent CAS transactions. If the spec was saved but
        // the image is stale, require a reload and expose the possibly partial result.
        if (image !== baseline.profile.avatarImage) {
          try {
            const result = object(await transport.request('/profile/avatar-image', 'PUT', { dataUri: image, imageRevision }, token))
            confirmedImage = imageUri(result.image)
            imageRevision = revision(result.imageRevision)
            if (Boolean(confirmedImage) !== Boolean(image)) throw new Error('Image was not saved')
          } catch (error) {
            // The spec may already have been committed. Acknowledge only after loading both files and config again.
            if (configRevision !== expected && error instanceof HttpFailure && ![401, 403].includes(error.status))
              throw new Error('Avatar settings saved, image write not confirmed')
            throw error
          }
        }
        const after = await getProfile()
        if (after.revision !== configRevision || after.profile.avatar !== spec ||
            after.imageRevision !== imageRevision || after.profile.avatarImage !== confirmedImage)
          throw new Error('Profile changed while saving')
        return { value: after, configRevision }
      })
    },
    workspaces: () => queue('read', async () => ({ value: array(object(await transport.request('/workspaces')).workspaces)
      .map((item): WorkspaceOption => { const w = object(item); return { id: opaqueId(w.id), name: string(w.name) } }) })),
    memory: (scope: Scope) => queue('read', async () => {
      const result = object(await memoryRequest(scope, 'GET'))
      return { value: { snapshot: parseMemory(result.snapshot), revision: revision(result.revision) } }
    }),
    writeMemory: (scope: Scope, input: MemoryInput, revision: Revision, id?: string) =>
      changeMemory(scope, 'POST', { input, ...(id === undefined ? {} : { id }), revision }),
    deleteMemory: (scope: Scope, revision: Revision, id?: string) =>
      changeMemory(scope, 'DELETE', { ...(id === undefined ? { clear: true } : { id }), revision }),
    roster: () => queue('read', async () => ({ value: await getRoster() })),
    role: (id: string) => queue('read', async () => ({ value: await getRole(id) })),
    roleImage: (id: string) => queue('read', async () => ({ value: await getRoleImage(id) })),
    roleAvatar: (id: string) => queue('read', async () => {
      const role = await getRole(id)
      const image = await getRoleImage(id)
      if (role.revision !== image.revision) throw conflict()
      return { value: { role, image } }
    }),
    setRoleImage: (role: Role, previous: RoleImage, dataUri: string) => queue('write', async (token) => {
      const value = parseRoleImage(await transport.request(`${rolePath(role.id)}/avatar-image`, 'PUT',
        { dataUri, revision: role.revision, imageRevision: previous.imageRevision }, token))
      if (value.revision !== role.revision || Boolean(value.image) !== Boolean(dataUri)) throw new Error('Role picture write not confirmed')
      return { value }
    }),
    createRole: (fields: Partial<RoleFields> & Pick<RoleFields, 'name'>) => changeRole('/personas', 'POST', fields),
    updateRole: (role: Role, fields: Partial<RoleFields>) => changeRole(rolePath(role.id), 'PATCH', { ...fields, revision: role.revision }),
    setEnabled: (role: Role, enabled: boolean) => changeRole(`${rolePath(role.id)}/enabled`, 'PUT', { enabled, revision: role.revision }),
    reorder: (ids: string[], revision: Revision) => queue('config-write', async (token) => ({ value: parseRoster(await transport.request('/personas/order', 'PUT', { ids, revision }, token)) })),
    deleteRole: (role: Role) => queue('config-write', async (token) => {
      if (role.protected || role.id === 'general') throw new HttpFailure(409, 'role_protected')
      const result = object(await transport.request(rolePath(role.id), 'DELETE', { revision: role.revision }, token))
      if (result.ok !== true) throw new Error('Invalid role deletion result')
      return { value: await getRoster() }
    })
  }
}

export type Library = ReturnType<typeof createLibrary>
