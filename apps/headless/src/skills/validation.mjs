import { isSkillId } from './documents-ids.mjs'
import { skillError } from './errors.mjs'
const own = Object.hasOwn
const invalid = () => skillError('skill_invalid')

export function assertSkillId(id) {
  if (!isSkillId(id)) throw invalid()
}

// Role IDs are opaque, and the authoritative roster—not the preference file—defines membership.
export const validRoleId = id => typeof id === 'string' && id.length > 0 && id.length <= 256 &&
  id === id.trim() && id.isWellFormed() && !/[\u0000-\u001f\u007f]/u.test(id)

export function skillPreferenceEdit(input) {
  if (input === null || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw invalid()
  const fields = Reflect.ownKeys(input)
  if (fields.length !== 2 || !fields.includes('revision') || (!fields.includes('enabled') && !fields.includes('roles'))) throw invalid()
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor?.enumerable || !own(descriptor, 'value')) throw invalid()
  }
  const { revision } = input
  if (typeof revision !== 'string' || revision.length !== 64 || !/^[a-f0-9]{64}$/.test(revision)) throw invalid()
  if (own(input, 'enabled')) {
    if (typeof input.enabled !== 'boolean') throw invalid()
    return { revision, field: 'enabled', value: input.enabled }
  }
  const roles = input.roles
  if (roles === null) return { revision, field: 'roles', value: null }
  if (!Array.isArray(roles) || Object.getPrototypeOf(roles) !== Array.prototype) throw invalid()
  if (roles.length > 64) throw skillError('skill_limit')
  if (Reflect.ownKeys(roles).length !== roles.length + 1) throw invalid()
  const result = new Set()
  for (let i = 0; i < roles.length; i++) {
    const property = Object.getOwnPropertyDescriptor(roles, String(i))
    if (!property?.enumerable || !own(property, 'value') || !validRoleId(property.value) || result.has(property.value)) throw invalid()
    result.add(property.value)
  }
  return { revision, field: 'roles', value: [...result] }
}

export function assertSkillOwner(verifyOwner, id) {
  if (typeof verifyOwner !== 'function') throw skillError('auth')
  try {
    const result = verifyOwner(id)
    if (result && typeof result.then === 'function') {
      Promise.resolve(result).catch(() => {})
      throw skillError('auth')
    }
    // Support assertion-style callbacks (undefined after a successful recheck).
    if (result === false) throw skillError('auth')
  } catch { throw skillError('auth') }
}
