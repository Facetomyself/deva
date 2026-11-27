import { HttpError } from '../http/policy.mjs'

export const invalidReadState = () => new HttpError(400, 'invalid_read_state')
export const readStateReadOnly = () => new HttpError(403, 'read_state_read_only')
export const readStateConflict = () => new HttpError(409, 'read_state_conflict')
export const readStateUnsupported = () => new HttpError(409, 'read_state_unsupported')
export const readStateLimit = () => new HttpError(413, 'read_state_limit')
export const readStateUnconfirmed = () => new HttpError(503, 'read_state_unconfirmed')

export function readStateError(error) {
  if (error instanceof HttpError) return error
  switch (error?.code) {
    case 'EACCES': case 'EPERM': case 'EROFS': return readStateReadOnly()
    case 'ENOENT': case 'EEXIST': case 'ESTALE': return readStateConflict()
    case 'ENOTDIR': case 'ELOOP': case 'EXDEV': case 'ENOTSUP': case 'EOPNOTSUPP': return readStateUnsupported()
    case 'EFBIG': return readStateLimit()
    default: return readStateUnconfirmed()
  }
}
