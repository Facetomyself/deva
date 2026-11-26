import { createHash } from 'node:crypto'
import { inflateSync } from 'node:zlib'

const MiB = 1024 * 1024
export const limits = Object.freeze({
  pack: 24 * MiB,
  packTotal: 48 * MiB, // Sum of the pack and idx file lengths.
  packs: 16,
  directoryEntries: 128,
  packObjects: 8192,
  gets: 8192,
  object: 2 * MiB,
  tree: 4 * MiB,
  loose: 4 * MiB + 64 * 1024,
  delta: 8 * MiB, // Instructions can be larger than the reconstructed object.
  deltaDepth: 32,
  work: 64 * MiB,
  activeMs: 1000
})

const publicCodes = new Set([
  'git_limit', 'git_corrupt', 'git_object_unavailable', 'unsupported_git_layout',
  // Preserve safe codes from the pinned metadata boundary, without its messages.
  'git_stale', 'git_unsafe'
])
export const gitError = code => Object.assign(new Error(code), { code })
export function meta(callback) {
  try { return callback() }
  catch (error) {
    throw gitError(publicCodes.has(error?.code) ? error.code : 'git_object_unavailable')
  }
}

export const oidPattern = /^[0-9a-f]{40}$/
export const rawSha1 = bytes => createHash('sha1').update(bytes).digest()
export const objectLimit = type => type === 'tree' ? limits.tree : limits.object

export function verifyObject(oid, object) {
  const { type, bytes } = object
  const hash = createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex')
  if (hash !== oid) throw gitError('git_corrupt')
  return object
}

// Node's info.engine.bytesWritten reports the input consumed, not output size.
// Git entries have one complete zlib stream, without padding or a second stream.
export function inflateObject(input, maximum, excessCode, work) {
  work.consume(input.length)
  const cap = Math.min(maximum, work.remaining)
  let result
  try {
    result = inflateSync(input, { maxOutputLength: Math.max(1, cap), info: true })
  } catch (error) {
    // Failed inflation does not expose the bytes emitted before the failure.
    work.consume(cap)
    if (error?.code === 'ERR_BUFFER_TOO_LARGE') throw gitError(cap < maximum ? 'git_limit' : excessCode)
    throw gitError('git_corrupt')
  }
  work.consume(result.buffer.length)
  if (result.buffer.length > maximum) throw gitError(excessCode)
  if (result.engine.bytesWritten !== input.length) throw gitError('git_corrupt')
  return result.buffer
}
