import { gitError } from './git-errors.mjs'
import { boundedInteger, pinGitRoot } from './repository-fd.mjs'
import { MAX_GIT_DEPTH, layoutMarkers, listMetaType, metadataPath, sensitiveBytes, unsupportedPack, workPath } from './repository-paths.mjs'

const ABSENT = Object.freeze({ state: 'missing' })
const UNSAFE = Object.freeze({ state: 'unsafe' })
const TOO_LARGE = Object.freeze({ state: 'too_large' })

function detectLayout(scope, mount) {
  const git = scope.path(['.git'], (_, version) => version)
  if (!git) return 'not_repo'
  if (!git.info.isDirectory()) return 'unsupported_layout'
  if (git.mount !== String(mount)) throw gitError('git_unsafe')
  for (const rel of layoutMarkers) {
    if (scope.path(['.git', ...rel.split('/')], fd => fd !== undefined)) return 'unsupported_layout'
  }
  // Promisor and SHA-256 pack sidecars/names are classified by existence only.
  // No pointer file, sidecar or repository configuration is ever opened for data.
  const unsupported = scope.path(['.git', 'objects', 'pack'], (fd, version) => {
    if (fd === undefined) return false
    let found = false
    scope.list(fd, version, name => {
      if (unsupportedPack.test(name)) { found = true; return false }
    })
    return found
  })
  return unsupported ? 'unsupported_layout' : 'ready'
}

/** Open a synchronous, request-scoped view of an operator-approved Linux directory FD. */
export function openGitIo({ fd, mount } = {}) {
  const scope = pinGitRoot(fd, mount)
  let state
  try { state = detectLayout(scope, mount) } catch (error) { scope.close(); throw error }

  function meta(rel, mode) {
    if (typeof rel === 'string' && rel.length <= 4095 && rel.split('/', MAX_GIT_DEPTH + 1).length > MAX_GIT_DEPTH) {
      throw gitError('git_limit')
    }
    const parts = metadataPath(rel, mode)
    if (!parts) throw gitError('git_unsafe')
    return ['.git', ...parts]
  }
  function requireReady() {
    if (state !== 'ready') throw gitError('unsupported_git_layout')
  }
  return Object.freeze({
    state,
    readMeta(rel, maxBytes) {
      const parts = meta(rel, 'read')
      const limit = boundedInteger(maxBytes)
      requireReady()
      return scope.path(parts, (pin, version) => {
        if (pin === undefined) return null
        const bytes = scope.read(pin, version, limit)
        if (bytes === undefined) throw gitError('git_limit')
        return bytes
      })
    },
    listMeta(rel, maxEntries) {
      const parts = meta(rel, 'list')
      const limit = boundedInteger(maxEntries)
      requireReady()
      const relParts = parts.slice(1)
      const names = scope.path(parts, (dir, version) => {
        if (dir === undefined) return []
        const matched = []
        scope.list(dir, version, name => {
          const expected = listMetaType(relParts, name)
          if (expected === undefined) return
          if (relParts.length === MAX_GIT_DEPTH || matched.length >= limit) throw gitError('git_limit')
          matched.push({ name, expected })
        })
        return matched
      })
      return names.map(({ name, expected }) => scope.path([...parts, name], (pin, version) => {
        if (pin === undefined) throw gitError('git_stale')
        const type = scope.entryType(version)
        if (expected !== 'either' && type !== expected) throw gitError('git_unsafe')
        return { name, type }
      })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    },
    marker(rel) {
      const parts = meta(rel, 'marker')
      return scope.path(parts, pin => pin !== undefined)
    },
    workFile(rel, maxBytes) {
      const parts = workPath(rel)
      if (!parts) return UNSAFE
      const limit = boundedInteger(maxBytes)
      try {
        return scope.path(parts, (pin, version) => {
          if (pin === undefined) return ABSENT
          const bytes = scope.read(pin, version, limit)
          if (bytes === undefined) return TOO_LARGE
          if (sensitiveBytes(bytes)) return UNSAFE
          return { state: 'regular', bytes, executable: Boolean(version.info.mode & 0o100n) }
        })
      } catch (error) {
        if (error?.code === 'git_unsafe') return UNSAFE
        throw error
      }
    },
    verify: scope.verify,
    close: scope.close,
  })
}
