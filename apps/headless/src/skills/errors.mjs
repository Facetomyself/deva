import { HttpError } from '../http/policy.mjs'

const status = Object.freeze({
  auth: 401,
  skill_invalid: 400,
  skill_not_found: 404,
  skill_builtin: 409,
  skill_conflict: 409,
  skill_unknown_role: 409,
  skill_unsupported: 409,
  skill_limit: 413,
  skill_read_only: 403,
  skill_restricted: 422,
  skill_storage_unconfirmed: 503
})

export const skillError = (code = 'skill_storage_unconfirmed') => new HttpError(status[code], code)

// Never forward native paths, untrusted error messages, or parse results to this API.
export function publicSkillError(error) {
  const code = error?.code
  if (Object.hasOwn(status, code) && status[code] === error?.status) return skillError(code)
  switch (code) {
    case 'ERR_PERSONA_LIMIT': return skillError('skill_limit')
    case 'ERR_SETTINGS_CORRUPT':
    case 'ERR_PERSONA_CORRUPT': return skillError('skill_unsupported')
    case 'ERR_SETTINGS_CONFLICT':
    case 'ERR_PERSONA_CONFLICT': return skillError('skill_conflict')
    case 'ERR_SETTINGS_READ_ONLY':
    case 'EACCES':
    case 'EPERM':
    case 'EROFS': return skillError('skill_read_only')
    default: return skillError()
  }
}
