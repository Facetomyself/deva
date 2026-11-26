import { createHash } from 'node:crypto'
import { parseIndex } from './inspect-index.mjs'
import { readHeadTree } from './inspect-history.mjs'
import {
  MAX_ENTRIES, MAX_INDEX_BYTES, MAX_RESULT_ROWS_BYTES, MAX_WORK_BYTES, MAX_WORK_FILE_BYTES, MODE_EXEC, MODE_FILE,
  blobOid, limitationFor, regularMode, sha256,
} from './inspect-policy.mjs'

function change(before, after) {
  if (!before) return after ? 'A' : null
  if (!after) return 'D'
  if ((before.mode & 0o170000) !== (after.mode & 0o170000)) return 'T'
  return before.oid !== after.oid || before.mode !== after.mode ? 'M' : null
}

function mayDiff(letter, before, after) {
  return Boolean(letter && (!before || regularMode(before.mode)) && (!after || regularMode(after.mode)))
}

export function statusSnapshot(state, fields, limitations, hash, entries = []) {
  return { state, ...fields, limitations: [...limitations], fingerprint: hash.digest('hex'), entries }
}

export function emptyStatus(state, fields, limitations) {
  return statusSnapshot(state, fields, limitations,
    createHash('sha256').update(JSON.stringify(['git-view-v1', state, fields, [...limitations]])))
}

function workReader(io, hash, limitations, markPartial) {
  let remaining = MAX_WORK_BYTES, exhausted = false
  return function readWork(rel, keepBytes) {
    let work
    const limit = Math.min(remaining, MAX_WORK_FILE_BYTES)
    if (!limit || exhausted) work = { state: 'budget' }
    else {
      try { work = io.workFile(rel, limit) }
      catch (error) {
        if (error?.code === 'git_stale') throw error
        if (error?.code === 'git_limit') {
          exhausted = true
          work = { state: 'budget' }
        } else work = { state: 'unsafe' }
      }
    }
    if (work?.state === 'regular' && Buffer.isBuffer(work.bytes) && typeof work.executable === 'boolean' && work.bytes.length <= limit) {
      const { bytes } = work
      remaining -= bytes.length
      const mode = work.executable ? MODE_EXEC : MODE_FILE
      const oid = blobOid(bytes)
      hash.update(JSON.stringify([rel, 'regular', mode, bytes.length, sha256(bytes)]))
      return { state: 'regular', entry: { mode, oid, ...(keepBytes ? { bytes } : {}) } }
    }
    if (work?.state === 'missing') {
      hash.update(JSON.stringify([rel, 'missing']))
      return { state: 'missing', entry: null }
    }
    const state = work?.state === 'too_large' && limit === MAX_WORK_FILE_BYTES ? 'too_large' :
      work?.state === 'too_large' || work?.state === 'budget' ? 'budget' : 'unsafe'
    markPartial()
    limitations.add(({ too_large: 'worktree_file_limit', budget: 'worktree_budget', unsafe: 'unsafe_worktree' })[state])
    hash.update(JSON.stringify([rel, state]))
    return { state, entry: null }
  }
}

export function collectStatus(io, reader, refs, fields, limitations, selectedRel) {
  const hash = createHash('sha256').update(JSON.stringify(['git-view-v1', refs.head, refs.branch, fields]))
  let index, head, target, state = 'ready'
  try {
    const indexBytes = io.readMeta('index', MAX_INDEX_BYTES)
    index = parseIndex(indexBytes)
    hash.update(JSON.stringify(['index', indexBytes === null ? null : sha256(indexBytes)]))
  } catch (error) {
    if (error?.code === 'git_stale') throw error
    const reason = limitationFor(error, 'index')
    limitations.add(reason)
    hash.update(JSON.stringify(reason))
    const unavailable = error?.code === 'git_index_unsupported' || error?.code === 'unsupported_git_layout' ? 'unsupported_layout' : 'unavailable'
    return { status: statusSnapshot(unavailable, fields, limitations, hash) }
  }
  try { head = readHeadTree(reader, refs.head) }
  catch (error) {
    if (error?.code === 'git_stale') throw error
    const reason = limitationFor(error, 'head_tree')
    limitations.add(reason)
    hash.update(JSON.stringify(reason))
    return { status: statusSnapshot(error?.code === 'unsupported_git_layout' ? 'unsupported_layout' : 'unavailable', fields, limitations, hash) }
  }
  if (index.excluded || head.excluded) limitations.add('excluded_paths')
  const entries = []
  let outputBytes = 0, outputFull = false
  const paths = [...new Set([...index.entries.keys(), ...head.entries.keys()])].sort()
  if (paths.length > MAX_ENTRIES) {
    state = 'partial'
    limitations.add('status_entry_limit')
    hash.update(JSON.stringify(['status_entry_limit', paths.length]))
    paths.length = MAX_ENTRIES
  }
  const readWork = workReader(io, hash, limitations, () => { state = 'partial' })
  for (const rel of paths) {
    const headEntry = head.entries.get(rel) ?? null
    const stages = index.entries.get(rel)
    const indexEntry = stages?.[0] ?? null
    const conflicted = stages !== undefined && indexEntry === null
    const conflictHasNonRegular = conflicted && stages.some(entry => !regularMode(entry.mode))
    const hasRegularStage = stages?.some(entry => regularMode(entry.mode))
    if (conflictHasNonRegular || (headEntry && !regularMode(headEntry.mode)) || (indexEntry && !regularMode(indexEntry.mode))) {
      limitations.add('non_regular_entries')
      if (conflictHasNonRegular || (!hasRegularStage && !regularMode(headEntry?.mode))) continue
    }
    // A pathname removed from the index is no longer tracked in the worktree, even if an
    // untracked replacement currently exists at the same name. Never open it for comparison.
    const work = hasRegularStage ? readWork(rel, rel === selectedRel) : { state: 'not_tracked', entry: null }
    if (work.state === 'unsafe' || work.state === 'budget') continue
    const intent = indexEntry?.intent === true
    const staged = conflicted ? 'U' : intent ? null : change(headEntry, indexEntry)
    const workBase = intent ? null : indexEntry
    const workAvailable = work.state === 'regular' || work.state === 'missing'
    const worktree = conflicted ? 'U' : workAvailable ? change(workBase, work.entry) : null
    const diffSides = []
    if (!conflicted) {
      if (mayDiff(staged, headEntry, indexEntry)) diffSides.push('staged')
      if (mayDiff(worktree, workBase, work.entry)) diffSides.push('worktree')
    }
    if (staged || worktree) {
      const row = { rel, staged, worktree, conflicted, diffSides }
      if (!outputFull) outputBytes += 1 + Buffer.byteLength(JSON.stringify(row))
      if (outputBytes > MAX_RESULT_ROWS_BYTES) {
        outputFull = true
        state = 'partial'
        limitations.add('status_output_limit')
        // Still fingerprint approved worktree slots; omit this and following rows from the view.
        continue
      }
      entries.push(row)
    }
    if (rel === selectedRel) target = { headEntry, indexEntry, workBase, work, conflicted, diffSides }
  }
  hash.update(JSON.stringify([state, [...limitations]]))
  return { status: statusSnapshot(state, fields, limitations, hash, entries), target }
}
