import { MAX_ENTRIES, MAX_INDEX_BYTES, MODE_DIR, fail, leafMode, safePath, sha1, sha256 } from './inspect-policy.mjs'

const ENTRY_BYTES = 62
const HASH_BYTES = 20
const LENGTH_MASK = 0x0fff
const EXTENDED = 0x4000
const SKIP_WORKTREE = 0x4000
const INTENT_TO_ADD = 0x2000
const ZERO_OID = '0'.repeat(40)
const EMPTY_BLOB_OID = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'

function indexExtensions(bytes, offset, end) {
  while (offset < end) {
    if (end - offset < 8) fail('git_corrupt')
    const signature = bytes[offset]
    const length = bytes.readUInt32BE(offset + 4)
    if (length > end - offset - 8) fail('git_corrupt')
    // Git's index format reserves an uppercase first signature byte for optional extensions.
    // In particular, split index (link) and sparse index (sdir) are required, not hints.
    if (signature < 0x41 || signature > 0x5a) fail('git_index_unsupported')
    offset += 8 + length
  }
}

export function parseIndex(bytes) {
  const entries = new Map()
  if (bytes === null) return { entries, excluded: false }
  if (!Buffer.isBuffer(bytes) || bytes.length < 12 + HASH_BYTES || bytes.toString('latin1', 0, 4) !== 'DIRC') fail('git_corrupt')
  if (bytes.length > MAX_INDEX_BYTES) fail('git_limit')
  const end = bytes.length - HASH_BYTES
  const version = bytes.readUInt32BE(4)
  if (version !== 2 && version !== 3) fail('git_index_unsupported')
  if (sha1(bytes.subarray(0, end)) !== bytes.toString('hex', end)) {
    // Detect a valid SHA-256 trailer without consulting repository configuration.
    if (bytes.length >= 44 && sha256(bytes.subarray(0, -32)) === bytes.toString('hex', bytes.length - 32)) {
      fail('git_index_unsupported')
    }
    fail('git_corrupt')
  }
  const count = bytes.readUInt32BE(8)
  if (count > MAX_ENTRIES) fail('git_limit')
  let offset = 12
  let previous, previousStage, excluded = false
  for (let entry = 0; entry < count; entry++) {
    const start = offset
    if (end - offset <= ENTRY_BYTES) fail('git_corrupt')
    const mode = bytes.readUInt32BE(offset + 24)
    if (mode === MODE_DIR) fail('git_index_unsupported')
    if (!leafMode(mode)) fail('git_corrupt')
    const oid = bytes.toString('hex', offset + 40, offset + 60)
    const flags = bytes.readUInt16BE(offset + 60)
    const stage = (flags >> 12) & 3
    let intent = false
    offset += ENTRY_BYTES
    if (flags & EXTENDED) {
      if (version < 3 || end - offset < 3) fail('git_corrupt')
      const extended = bytes.readUInt16BE(offset)
      if ((extended & SKIP_WORKTREE) || (extended & ~(SKIP_WORKTREE | INTENT_TO_ADD))) fail('git_index_unsupported')
      intent = Boolean(extended & INTENT_TO_ADD)
      if (intent && (stage !== 0 || oid !== EMPTY_BLOB_OID)) fail('git_corrupt')
      offset += 2
    }
    const nul = bytes.indexOf(0, offset)
    if (nul < 0 || nul >= end || nul === offset || oid === ZERO_OID) fail('git_corrupt')
    const name = bytes.subarray(offset, nul)
    if (Math.min(name.length, LENGTH_MASK) !== (flags & LENGTH_MASK)) fail('git_corrupt')
    if (previous) {
      const order = Buffer.compare(previous, name)
      if (order > 0 || (order === 0 && (previousStage === 0 || previousStage >= stage))) fail('git_corrupt')
    }
    previous = name
    previousStage = stage
    offset = start + Math.ceil((nul + 1 - start) / 8) * 8
    if (offset > end || bytes.subarray(nul, offset).some(byte => byte !== 0)) fail('git_corrupt')
    const rel = safePath(name)
    if (rel === null) {
      excluded = true
    } else {
      const stages = entries.get(rel) ?? []
      stages[stage] = { mode, oid, intent }
      entries.set(rel, stages)
    }
  }
  indexExtensions(bytes, offset, end)
  return { entries, excluded }
}
