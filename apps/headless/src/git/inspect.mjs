import { buildDiff, emptyDiff } from './inspect-diff.mjs'
import { readCommit } from './inspect-history.mjs'
import { MAX_RESULT_ROWS_BYTES, displayRef, fail, limitationFor, safePath } from './inspect-policy.mjs'
import { collectStatus, emptyStatus } from './inspect-status.mjs'
import { createGitObjectReader } from './objects.mjs'
import { readGitRefs } from './refs.mjs'

const MAX_BRANCHES = 2000
const MAX_LOG_COUNT = 100
const MAX_LOG_BYTES = 8 * 1024 * 1024
const OPS = new Set(['branches', 'log', 'status', 'diff'])
const DIFFERENT_SIDES = new Set(['staged', 'worktree'])
const NO_HEAD = { branch: null, detached: false, unborn: false, mergeInProgress: false }

function ioFailure(state) {
  if (state === undefined || state === 'ready') return null
  return state === 'not_repo' || state === 'unsupported_layout' ? state : 'unavailable'
}

function readRefs(io) {
  const ioState = ioFailure(io.state)
  if (ioState) return { refs: null, state: ioState, limitations: new Set([ioState]) }
  try {
    const refs = readGitRefs(io)
    const limitations = new Set(refs.limitations)
    const branch = displayRef(refs.branch)
    if (refs.branch !== null && branch === null) limitations.add('excluded_refs')
    const fields = { branch, detached: refs.detached, unborn: refs.unborn, mergeInProgress: refs.mergeInProgress }
    return { state: 'ready', refs, fields, limitations }
  } catch (error) {
    if (error?.code === 'git_stale') throw error
    const state = error?.code === 'unsupported_git_layout' ? 'unsupported_layout' : 'unavailable'
    return { refs: null, state, limitations: new Set([limitationFor(error, 'refs')]) }
  }
}

function branches({ refs, state, fields = NO_HEAD, limitations }) {
  const rows = []
  let outputBytes = 0
  if (refs) {
    limitations.add('upstream_unknown')
    for (const ref of refs.branches) {
      const name = displayRef(ref.name), remote = ref.remote === null ? null : displayRef(ref.remote)
      if (name === null || (ref.remote !== null && remote === null)) {
        limitations.add('excluded_refs')
        continue
      }
      if (rows.length === MAX_BRANCHES) {
        state = 'partial'
        limitations.add('branch_limit')
        break
      }
      const row = { name, current: ref.current, remote }
      outputBytes += 1 + Buffer.byteLength(JSON.stringify(row))
      if (outputBytes > MAX_RESULT_ROWS_BYTES) {
        state = 'partial'
        limitations.add('branch_output_limit')
        break
      }
      rows.push(row)
    }
  }
  return { state, branch: fields.branch, detached: fields.detached, unborn: fields.unborn, branches: rows, limitations: [...limitations] }
}

function log(reader, { refs, state, fields = NO_HEAD, limitations }, requestedLimit) {
  const limit = Number.isInteger(requestedLimit) ? Math.min(MAX_LOG_COUNT, Math.max(1, requestedLimit)) : 50
  const commits = [], seen = new Set()
  let oid = refs?.head ?? null, bytes = 0, more = false
  while (oid !== null) {
    if (commits.length === limit) { more = true; break }
    try {
      if (seen.has(oid)) fail('git_corrupt')
      seen.add(oid)
      const commit = readCommit(reader, oid, true)
      bytes += commit.cost
      if (bytes > MAX_LOG_BYTES) fail('git_limit')
      commits.push(commit.row)
      oid = refs.shallow.has(oid) ? null : commit.firstParent
    } catch (error) {
      if (error?.code === 'git_stale') throw error
      limitations.add(limitationFor(error, 'history'))
      state = commits.length ? 'partial' : error?.code === 'unsupported_git_layout' ? 'unsupported_layout' : 'unavailable'
      break
    }
  }
  return { state, branch: fields.branch, commits, traversal: 'first-parent', more, limitations: [...limitations] }
}

function status(io, reader, { refs, state, fields = NO_HEAD, limitations }, rel) {
  limitations.add('tracked_only')
  if (!refs) return { status: emptyStatus(state, fields, limitations) }
  return collectStatus(io, reader, refs, fields, limitations, rel)
}

function validateDiff({ rel, side, expectedFingerprint }) {
  if (typeof expectedFingerprint !== 'string' || expectedFingerprint.length !== 64 || !/^[a-f0-9]{64}$/.test(expectedFingerprint)) fail('git_stale')
  if (typeof rel !== 'string' || rel.length > 4095 || !rel.isWellFormed() || safePath(Buffer.from(rel)) !== rel ||
      !DIFFERENT_SIDES.has(side)) fail('git_invalid_job')
}

function diff(io, reader, refState, { rel, side, expectedFingerprint }) {
  const snapshot = status(io, reader, refState, rel)
  if (snapshot.status.fingerprint !== expectedFingerprint) fail('git_stale')
  const { target } = snapshot
  if (!target) return emptyDiff(rel, side, 'unavailable', 'entry_unavailable')
  if (target.conflicted) return emptyDiff(rel, side, 'unavailable', 'conflicted_entry')
  if (!target.diffSides.includes(side)) {
    if (side === 'worktree' && target.work.state === 'too_large') return emptyDiff(rel, side, 'too_large', 'worktree_file_limit')
    return emptyDiff(rel, side, 'unavailable', 'side_unavailable')
  }
  return side === 'staged'
    ? buildDiff(reader, rel, side, target.headEntry, target.indexEntry)
    : buildDiff(reader, rel, side, target.workBase, target.work.entry)
}

/** Synchronous inspection; job.rel/job.side are service-resolved view data, never browser input. */
export function inspectGit(io, job) {
  if (!job || !OPS.has(job.op)) fail('git_invalid_job')
  if (job.op === 'diff') validateDiff(job)
  const refState = readRefs(io)
  if (job.op === 'branches') return branches(refState)
  const reader = createGitObjectReader(io)
  if (job.op === 'log') return log(reader, refState, job.limit)
  if (job.op === 'status') return status(io, reader, refState).status
  return diff(io, reader, refState, job)
}
