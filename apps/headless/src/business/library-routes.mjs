import { createHash } from 'node:crypto'
import { createMemoryService } from '../../dist/library-core.mjs'
import { HttpError, json, readJson } from '../http/policy.mjs'
import { openProfile } from './profile.mjs'
import { openPersonas } from './personas.mjs'
import { checkRoleBindings } from './role-bindings.mjs'
import { openWorkspaceCatalog } from './workspace-catalog.mjs'
import { openWorkspaceFiles } from '../files/workspace-files.mjs'
import { workspaceFileRoutes } from '../files/workspace-routes.mjs'

const rolePath = /^\/api\/v1\/personas\/([A-Za-z0-9][A-Za-z0-9_.-]{0,63})(?:\/(enabled|avatar-image))?$/
const memoryPath = /^\/api\/v1\/memory\/(global|role|project)(?:\/([A-Za-z0-9][A-Za-z0-9_.-]{0,127}))?$/
const choices = new Map([
  ['/api/v1/workspaces', ['GET']], ['/api/v1/profile', ['GET']], ['/api/v1/profile/avatar', ['PUT']],
  ['/api/v1/profile/avatar-image', ['PUT']], ['/api/v1/personas', ['GET', 'POST']], ['/api/v1/personas/order', ['PUT']]
])
const codes = new Map(Object.entries({
  AUTH_FAILED: [401, 'auth'], ERR_SETTINGS_INVALID: [400, 'invalid_library_input'],
  ERR_SETTINGS_CONFLICT: [409, 'conflict'], ERR_SETTINGS_REVISION_REQUIRED: [409, 'revision_required'],
  ERR_SETTINGS_READ_ONLY: [503, 'storage_unavailable'], ERR_SETTINGS_STORAGE: [503, 'storage_unavailable'],
  ERR_SETTINGS_UNAVAILABLE: [503, 'storage_unavailable'], ERR_SETTINGS_CORRUPT: [500, 'invalid_existing_state'],
  ERR_PERSONA_INVALID: [400, 'invalid_library_input'], ERR_PERSONA_NOT_FOUND: [404, 'role_not_found'],
  ERR_PERSONA_REVISION_REQUIRED: [409, 'revision_required'], ERR_PERSONA_CONFLICT: [409, 'conflict'],
  ERR_PERSONA_PROTECTED: [409, 'role_protected'], ERR_PERSONA_REFERENCED: [409, 'role_referenced'],
  ERR_PERSONA_LIMIT: [409, 'role_limit'], ERR_PERSONA_CORRUPT: [500, 'invalid_existing_state'],
  ERR_WORKSPACE_UNAVAILABLE: [503, 'workspace_unavailable'], workspaceUnavailable: [404, 'workspace_unavailable'],
  invalidScope: [400, 'invalid_scope'], invalidInput: [400, 'invalid_library_input'], storageIO: [503, 'storage_unavailable'],
  corruptStorage: [500, 'invalid_existing_state'], unsafeStorage: [503, 'storage_unavailable']
}))
function requireRevision(v) {
  if (v === undefined) throw new HttpError(409, 'revision_required')
  if (typeof v !== 'string' || v.length !== 64 || /[^a-f0-9]/.test(v)) throw new HttpError(400, 'invalid_revision')
  return v
}
function fields(value, keys, optional = []) {
  if (!keys.every(k => Object.hasOwn(value, k)) || Object.keys(value).some(k => !keys.includes(k) && !optional.includes(k))) throw new HttpError(400, 'invalid_fields')
}
function profilePictureRevision(image) {
  return createHash('sha256').update('deva:owner-picture:v1\0').update(image).digest('hex')
}
function snapshotOf(memory, scope) {
  const snapshot = memory.snapshot(scope)
  // Scope-bound revision of an authorized, public projection; no unrelated account data enter the digest.
  const revision = createHash('sha256').update(JSON.stringify([scope, snapshot])).digest('hex')
  return { snapshot, revision }
}

export async function openLibrary({ dataDir, workspaceRoot, workspaceWritable = false, privateRoots = [] }) {
  if (typeof workspaceWritable !== 'boolean' || (workspaceWritable && !workspaceRoot)) throw new TypeError('Workspace writes require an explicit project root')
  const catalog = openWorkspaceCatalog({ root: workspaceRoot, privateRoots: [dataDir, ...privateRoots] })
  let profile, personas, memory, fileCommands
  try {
    if (workspaceRoot) fileCommands = workspaceFileRoutes(openWorkspaceFiles({ catalog, writable: workspaceWritable }))
    profile = await openProfile({ dataDir })
    personas = await openPersonas({ dataDir, workspaceCatalog: catalog, checkReferences: checkRoleBindings(dataDir) })
    memory = createMemoryService({ dataDir, resolveWorkspaceRoot: catalog.resolveRoot })
  } catch (err) { catalog.close(); throw err }
  // Serialize role/memory edits together: a deleted role cannot acquire new memory between
  // the existence check and its write, or vice versa. Never wait for an HTTP body under this queue.
  let queue = Promise.resolve(), queued = 0, closed = false
  function serial(task) {
    if (closed || queued >= 32) throw new HttpError(503, 'library_busy')
    queued++
    const job = queue.then(task).finally(() => { queued-- })
    queue = job.catch(() => {})
    return job
  }
  async function memoryRequest(match, method, body) {
    const [, kind, ref] = match
    if ((kind === 'global') !== (ref === undefined)) throw new HttpError(400, 'invalid_scope')
    if (kind === 'role' && !await personas.get(ref)) throw new HttpError(404, 'role_not_found')
    const scope = kind === 'global' ? { kind } : kind === 'role' ? { kind, personaId: ref } : { kind, workspaceId: ref }
    const previous = snapshotOf(memory, scope)
    if (method === 'GET') return previous
    if (requireRevision(body.revision) !== previous.revision) throw new HttpError(409, 'conflict')
    if (method === 'POST') {
      fields(body, ['input', 'revision'], ['id'])
      const r = memory.writeMemory(body.input, body.id, scope)
      if (!r.ok) return { ok: false, code: r.code, revision: previous.revision }
    } else if (body.clear === true) {
      fields(body, ['clear', 'revision']); memory.clearMemories(scope)
    } else {
      fields(body, ['id', 'revision'])
      if (!memory.deleteMemory(body.id, scope)) return { ok: false, code: 'notFound', revision: previous.revision }
    }
    return { ok: true, ...snapshotOf(memory, scope) }
  }
  async function enabledRole(id) {
    const role = await personas.get(id)
    if (!role?.enabled) throw new HttpError(409, 'role_unavailable')
    // Only these data fields are part of a conversation binding. A role's folder selection
    // or an instruction in its Markdown never authorizes execution or external file reads.
    return { id: role.id, name: role.name, prompt: role.prompt, model: role.model, enabled: true }
  }
  return {
    workspaceFilesEnabled: Boolean(fileCommands),
    resolveRole: id => serial(() => enabledRole(id)),
    withRoleForChat: (id, action) => serial(async () => action(await enabledRole(id))),
    async handle(req, res, { auth, policy }) {
      const path = (req.url ?? '').split('?', 1)[0]
      if (path.startsWith('/api/v1/workspaces/') && fileCommands) return fileCommands(req, res, { auth, policy })
      const mem = memoryPath.exec(path), role = rolePath.exec(path)
      const ordering = path === '/api/v1/personas/order' && req.method === 'PUT'
      const forRole = role && (role[2] === 'avatar-image' ? ['GET', 'PUT'] : role[2] ? ['PUT'] : ['GET', 'PATCH', 'DELETE'])
      // A legacy record may itself be named "order". Only the PUT action reserves that path.
      const methods = ordering ? ['PUT'] : forRole || choices.get(path) || (mem ? ['GET', 'POST', 'DELETE'] : null)
      if (!methods) return false
      const write = req.method !== 'GET'
      try {
        policy.check(req, write)
        if (path !== req.url) throw new HttpError(400, 'unexpected_query')
        if (!methods.includes(req.method)) { json(res, 405, { error: 'method' }, { allow: methods.join(', ') }); return true }
        const cookie = policy.cookie(req)
        if (write) auth.authenticate(cookie, req.headers['x-deva-csrf']); else auth.authenticate(cookie)
        const imageWrite = path === '/api/v1/profile/avatar-image' || role?.[2] === 'avatar-image'
        const body = write ? await readJson(req, imageWrite ? 3 * 1024 * 1024 : 384 * 1024) : null
        const result = await serial(async () => {
          // A large upload/queue delay may outlast a user's session; authenticate at dispatch as well.
          if (write) auth.authenticate(cookie, req.headers['x-deva-csrf']); else auth.authenticate(cookie)
          if (mem) return memoryRequest(mem, req.method, body)
          if (path === '/api/v1/workspaces') return { workspaces: catalog.list() }
          if (path === '/api/v1/profile') {
            const state = await profile.getSnapshot()
            return { ...state, imageRevision: profilePictureRevision(state.profile.avatarImage) }
          }
          if (path === '/api/v1/profile/avatar') { fields(body, ['spec', 'revision']); return profile.setAvatar(body.spec, requireRevision(body.revision)) }
          if (path === '/api/v1/profile/avatar-image') {
            fields(body, ['dataUri', 'imageRevision'])
            const expected = requireRevision(body.imageRevision)
            const current = await profile.get()
            if (profilePictureRevision(current.avatarImage) !== expected) throw new HttpError(409, 'conflict')
            const image = await profile.setAvatarImage(body.dataUri)
            return { image, imageRevision: profilePictureRevision(image) }
          }
          if (path === '/api/v1/personas') {
            if (!write) return personas.list()
            if (Object.hasOwn(body, 'id') || Object.hasOwn(body, 'revision')) throw new HttpError(400, 'invalid_fields')
            return { role: await personas.upsert(body) }
          }
          if (ordering) { fields(body, ['ids','revision']); return personas.reorder(body.ids, requireRevision(body.revision)) }
          const id = role[1]
          if (role[2] === 'avatar-image') {
            if (!write) return personas.getAvatarImage(id)
            fields(body, ['dataUri', 'revision', 'imageRevision'])
            return personas.setAvatarImage(id, body.dataUri, requireRevision(body.revision), requireRevision(body.imageRevision))
          }
          if (!write) {
            const r = await personas.get(id); if (!r) throw new HttpError(404, 'role_not_found')
            return { role: r }
          }
          const revision = requireRevision(body.revision)
          if (role[2]) { fields(body, ['enabled','revision']); return { role: await personas.setEnabled(id, body.enabled, revision) } }
          if (req.method === 'DELETE') { fields(body, ['revision']); return personas.remove(id, revision) }
          if (Object.hasOwn(body, 'id')) throw new HttpError(400, 'invalid_fields')
          return { role: await personas.upsert({ ...body, id }) }
        })
        json(res, 200, result)
      } catch (error) {
        const [status, code] = error instanceof HttpError ? [error.status, error.code] : (codes.get(error?.code) ?? [500, 'internal'])
        if (!res.destroyed && !res.headersSent) json(res, status, { error: code }, write ? { connection: 'close' } : {})
      }
      return true
    },
    async close() { closed = true; await queue; catalog.close() }
  }
}
