import { HttpFailure, type Bootstrap, type Transport } from './transport'

type Obj = Record<string, unknown>
export type SkillRoles = string[] | null
export type SkillSummary = {
  id: string; name: string; description: string; source: 'builtin' | 'custom'
  enabled: boolean; roles: SkillRoles; revision: string; canConfigure: boolean
}
export type SkillDocument = SkillSummary & {
  detail: 'document'; instructions: string; trigger: string; license: string; compatibility: string
  allowedTools: string[]; metadata: Record<string, string>
}
export type Catalog = { skills: SkillSummary[]; revision: string }
export type RoleOption = { id: string; name: string; enabled: boolean }
export type SkillEdit = { enabled: boolean } | { roles: SkillRoles }
export type SkillProblem = 'stale' | 'missing' | 'readonly' | 'restricted' | 'unknownRole' | 'expired' | 'invalid' | 'unavailable'

const summaryFields = ['id', 'name', 'description', 'source', 'enabled', 'roles', 'revision', 'canConfigure']
const documentFields = ['instructions', 'trigger', 'license', 'compatibility', 'allowedTools', 'metadata']
class InvalidSkillResponse extends Error {
  constructor() { super('Invalid skill library response') }
}
function invalid(): never { throw new InvalidSkillResponse() }
function object(v: unknown): v is Obj { return v !== null && typeof v === 'object' && !Array.isArray(v) }
function exact(v: unknown, keys: readonly string[]): v is Obj {
  return object(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k))
}
function strings(v: unknown): v is string[] { return Array.isArray(v) && v.every((x) => typeof x === 'string') }
const reservedIds = new Set(['prototype', ...Object.getOwnPropertyNames(Object.prototype).map((key) => key.toLowerCase())])
function roleId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 256 && v === v.trim() && !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(v)
}
function roles(v: unknown): v is SkillRoles { return v === null || Array.isArray(v) && Array.from(v).every(roleId) }
function revision(v: unknown): v is string { return typeof v === 'string' && /^[a-f0-9]{64}$/u.exec(v)?.[0] === v }
function id(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.exec(v)?.[0] === v &&
    !v.endsWith('.') && !v.includes('..') && !reservedIds.has(v.toLowerCase())
}
function summary(v: unknown, extra: readonly string[] = []): SkillSummary {
  if (!exact(v, [...summaryFields, ...extra]) || !id(v.id) || typeof v.name !== 'string' || !v.name ||
      typeof v.description !== 'string' || (v.source !== 'builtin' && v.source !== 'custom') ||
      typeof v.enabled !== 'boolean' || !roles(v.roles) || !revision(v.revision) || typeof v.canConfigure !== 'boolean' ||
      (v.source === 'builtin' && (v.canConfigure || !v.enabled || v.roles !== null))) return invalid()
  return { id: v.id, name: v.name, description: v.description, source: v.source, enabled: v.enabled,
    roles: v.roles === null ? null : [...new Set(v.roles)], revision: v.revision, canConfigure: v.canConfigure }
}
function detail(value: unknown, wanted: string): SkillDocument | SkillSummary & { detail: 'builtin' } | null {
  if (!exact(value, ['skill', 'execution']) || value.execution !== 'inactive') return invalid()
  const v = value.skill
  if (v === null) return null
  if (!object(v) || v.id !== wanted) return invalid()
  if (v.detail === 'builtin' && v.source === 'builtin') return { ...summary(v, ['detail']), detail: 'builtin' }
  if (v.detail !== 'document' || v.source !== 'custom' ||
      typeof v.instructions !== 'string' || typeof v.trigger !== 'string' || typeof v.license !== 'string' ||
      typeof v.compatibility !== 'string' || !strings(v.allowedTools) || !object(v.metadata) ||
      !Object.values(v.metadata).every((x) => typeof x === 'string')) return invalid()
  return { ...summary(v, ['detail', ...documentFields]), detail: 'document', instructions: v.instructions, trigger: v.trigger,
    license: v.license, compatibility: v.compatibility, allowedTools: v.allowedTools, metadata: v.metadata as Record<string, string> }
}

export function sameSkillRoles(a: SkillRoles, b: SkillRoles): boolean {
  return a === null || b === null ? a === b : a.length === b.length && a.every((value) => b.includes(value))
}
export function matchesSkillEdit(skill: SkillSummary, edit: SkillEdit): boolean {
  return 'enabled' in edit ? skill.enabled === edit.enabled : sameSkillRoles(skill.roles, edit.roles)
}
export function retryableSkillRead(error: unknown): boolean {
  return error instanceof TypeError || error instanceof HttpFailure && (error.status === 429 || error.status >= 500)
}

export function skillProblem(error: unknown): SkillProblem {
  if (error instanceof HttpFailure) {
    switch (error.status) {
      case 401: return 'expired'
      case 403: return 'readonly'
      case 404: return 'missing'
      case 409:
        if (error.code === 'skill_unknown_role') return 'unknownRole'
        if (error.code === 'skill_builtin') return 'readonly'
        return error.code === 'skill_unsupported' ? 'restricted' : 'stale'
      case 413:
      case 422: return 'restricted'
      case 400: return 'invalid'
    }
  }
  return error instanceof InvalidSkillResponse || error instanceof SyntaxError ? 'invalid' : 'unavailable'
}

export function createSkillLibraryTransport(transport: Transport, session: Pick<Bootstrap, 'capabilities' | 'csrf'>) {
  if (session.capabilities?.skillLibrary !== true || !session.csrf) return undefined
  const csrf = session.csrf
  const read = (path: string, signal: AbortSignal) => transport.request(path, 'GET', undefined, undefined, { signal, expectedStatus: 200 })
  const write = (path: string, method: 'PATCH' | 'POST', body: unknown, signal: AbortSignal) =>
    transport.request(path, method, body, csrf, { signal, expectedStatus: 200, referrerPolicy: 'same-origin' })
  return {
    async list(signal: AbortSignal): Promise<Catalog> {
      const v = await read('/skills', signal)
      if (!exact(v, ['skills', 'revision', 'execution']) || v.execution !== 'inactive' || !revision(v.revision) || !Array.isArray(v.skills)) return invalid()
      const skills = v.skills.map((item) => summary(item))
      if (new Set(skills.map((s) => s.id)).size !== skills.length) return invalid()
      return { skills, revision: v.revision }
    },
    async detail(skillId: string, signal: AbortSignal): Promise<ReturnType<typeof detail>> {
      if (!id(skillId)) return invalid()
      return detail(await read(`/skills/${encodeURIComponent(skillId)}`, signal), skillId)
    },
    async roles(signal: AbortSignal): Promise<RoleOption[]> {
      const v = await read('/skills/-/roles', signal)
      if (!exact(v, ['roles']) || !Array.isArray(v.roles)) return invalid()
      const rows = v.roles.map((row): RoleOption => {
        if (!exact(row, ['id', 'name', 'enabled']) || !roleId(row.id) || typeof row.name !== 'string' || typeof row.enabled !== 'boolean') return invalid()
        return { id: row.id, name: row.name, enabled: row.enabled }
      })
      if (new Set(rows.map((r) => r.id)).size !== rows.length) return invalid()
      return rows
    },
    async patch(target: SkillSummary, edit: SkillEdit, signal: AbortSignal): Promise<SkillSummary> {
      if (!id(target.id) || target.source !== 'custom' || target.canConfigure !== true || !revision(target.revision)) return invalid()
      let body: SkillEdit & { revision: string }
      if (exact(edit, ['enabled']) && 'enabled' in edit && typeof edit.enabled === 'boolean') body = { revision: target.revision, enabled: edit.enabled }
      else if (exact(edit, ['roles']) && 'roles' in edit && roles(edit.roles) &&
          (edit.roles === null || (edit.roles.length <= 64 && new Set(edit.roles).size === edit.roles.length))) body = { revision: target.revision, roles: edit.roles }
      else return invalid()
      const v = await write(`/skills/${encodeURIComponent(target.id)}/preferences`, 'PATCH', body, signal)
      if (!exact(v, ['skill', 'execution']) || v.execution !== 'inactive') return invalid()
      const saved = summary(v.skill)
      if (saved.id !== target.id || saved.source !== 'custom' || saved.canConfigure !== true || !matchesSkillEdit(saved, body) ||
          (saved.revision === target.revision && !matchesSkillEdit(target, body))) return invalid()
      return saved
    },
    async changes(after: string, waitMs: number, signal: AbortSignal): Promise<{ changed: boolean; revision: string }> {
      if (!revision(after) || !Number.isInteger(waitMs) || waitMs < 0 || waitMs > 8000) return invalid()
      const v = await write('/skills/-/changes', 'POST', { after, waitMs }, signal)
      if (!exact(v, ['changed', 'revision']) || !revision(v.revision) || v.changed !== (v.revision !== after)) return invalid()
      return { changed: v.changed, revision: v.revision }
    }
  }
}
export type SkillLibraryTransport = NonNullable<ReturnType<typeof createSkillLibraryTransport>>
