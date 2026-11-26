import { decodeUtf8 } from '../files/workspace-files-fd.mjs'
import { gitError } from './git-errors.mjs'
import { MAX_GIT_DEPTH, validRefName } from './repository-paths.mjs'

const HEADS = 'refs/heads/'
const REMOTES = 'refs/remotes/'
const REPLACE = 'refs/replace/'
const MAX_REF_BYTES = 4096
const MAX_PACKED_BYTES = 4 * 1024 * 1024
const MAX_SHALLOW_BYTES = 2 * 1024 * 1024
const MAX_REFS = 10_000
const corrupt = () => { throw gitError('git_corrupt') }
const unsupported = () => { throw gitError('unsupported_git_layout') }

function text(bytes) {
  try { return decodeUtf8(bytes) } catch { corrupt() }
}
function stripFinalEol(s) {
  return s.endsWith('\r\n') ? s.slice(0, -2) : s.endsWith('\n') ? s.slice(0, -1) : s
}
function oid(value) {
  if (/^[0-9a-f]{64}$/iu.test(value)) unsupported()
  if (!/^[0-9a-f]{40}$/iu.test(value) || /^0{40}$/u.test(value)) corrupt()
  return value.toLowerCase()
}
function refValue(bytes) {
  const value = stripFinalEol(text(bytes))
  if (!value.startsWith('ref: ')) return { oid: oid(value) }
  const target = value.slice(5)
  if (!target.startsWith('refs/') || !validRefName(target)) corrupt()
  return { target }
}
function trackingRef(ref) {
  return ref.startsWith(HEADS) || (ref.startsWith(REMOTES) && ref.slice(REMOTES.length).includes('/'))
}
function remoteAlias(ref) {
  return ref.startsWith(REMOTES) && ref.endsWith('/HEAD')
}
function packedRefs(io) {
  const bytes = io.readMeta('packed-refs', MAX_PACKED_BYTES)
  const refs = new Map()
  if (bytes === null || bytes.length === 0) return refs
  let peelAllowed = false
  const seen = new Set()
  for (const line of stripFinalEol(text(bytes)).split(/\r?\n/u)) {
    if (line.startsWith('#')) { peelAllowed = false; continue }
    if (line.startsWith('^')) {
      if (!peelAllowed) corrupt()
      oid(line.slice(1))
      peelAllowed = false
      continue
    }
    const gap = line.indexOf(' ')
    if (gap < 0) corrupt()
    const id = oid(line.slice(0, gap))
    const name = line.slice(gap + 1)
    if (!name.startsWith('refs/') || !validRefName(name) || seen.has(name)) corrupt()
    if (name.startsWith(REPLACE)) unsupported()
    seen.add(name)
    if (seen.size > MAX_REFS) throw gitError('git_limit')
    if (trackingRef(name)) refs.set(name, id)
    peelAllowed = true
  }
  return refs
}
function looseRefs(io, refs) {
  let entriesVisited = 0
  function walk(dir, depth) {
    const entries = io.listMeta(dir, MAX_REFS - entriesVisited)
    entriesVisited += entries.length
    for (const { name, type } of entries) {
      const ref = `${dir}/${name}`
      if (depth >= MAX_GIT_DEPTH) throw gitError('git_limit')
      if (type === 'dir') { walk(ref, depth + 1); continue }
      if (!validRefName(ref)) corrupt()
      if (!trackingRef(ref)) unsupported()
      const bytes = io.readMeta(ref, MAX_REF_BYTES)
      if (bytes === null) throw gitError('git_stale')
      const value = refValue(bytes)
      if (value.target !== undefined) {
        if (!remoteAlias(ref)) unsupported()
        // A remote HEAD is an alias, not a tracking branch. Its loose value also
        // shadows a stale packed record at the same ref name.
        refs.delete(ref)
      } else refs.set(ref, value.oid)
      if (refs.size > MAX_REFS) throw gitError('git_limit')
    }
  }
  walk(HEADS.slice(0, -1), 2)
  walk(REMOTES.slice(0, -1), 2)
}
function shallowRefs(io) {
  const bytes = io.readMeta('shallow', MAX_SHALLOW_BYTES)
  if (bytes === null || bytes.length === 0) return new Set()
  const lines = stripFinalEol(text(bytes)).split(/\r?\n/u)
  if (lines.length > MAX_REFS) throw gitError('git_limit')
  return new Set(lines.map(oid))
}

export function readGitRefs(io) {
  if (io.state !== undefined && io.state !== 'ready') unsupported()
  const headBytes = io.readMeta('HEAD', MAX_REF_BYTES)
  if (headBytes === null) corrupt()
  const value = refValue(headBytes)
  if (value.target !== undefined && !value.target.startsWith(HEADS)) unsupported()
  if (value.target?.split('/').length > MAX_GIT_DEPTH) throw gitError('git_limit')
  const refs = packedRefs(io)
  looseRefs(io, refs)
  const detached = value.target === undefined
  const branch = detached ? null : value.target.slice(HEADS.length)
  const head = (detached ? value.oid : refs.get(value.target)) ?? null
  const shallow = shallowRefs(io)
  const branches = [...refs.keys()].sort().map(ref => {
    const local = ref.startsWith(HEADS)
    const name = ref.slice((local ? HEADS : REMOTES).length)
    return { name, current: value.target === ref, remote: local ? null : name.slice(0, name.indexOf('/')) }
  })
  return { branch, head, detached, unborn: !detached && head === null, mergeInProgress: io.marker('MERGE_HEAD'), branches, shallow,
    limitations: shallow.size ? ['shallow'] : [] }
}
