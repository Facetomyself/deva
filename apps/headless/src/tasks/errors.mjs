import { HttpError } from '../http/policy.mjs'

export const taskUnsupported = () => new HttpError(409, 'task_file_unsupported')
export const taskConflict = () => new HttpError(409, 'task_conflict')
export const taskUnconfirmed = () => new HttpError(503, 'task_storage_unconfirmed')
export const taskLimit = () => new HttpError(413, 'task_limit')
export const taskUnauthorized = () => new HttpError(401, 'unauthorized')
