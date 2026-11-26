import { performance } from 'node:perf_hooks'
import { gitError, inflateObject, limits, meta, objectLimit, oidPattern, verifyObject } from './objects-format.mjs'
import { applyDelta, inflatePackEntry, readPacks } from './pack.mjs'

const LOOSE_HEADER_MAX = 32

function readLoose(io, oid, work) {
  const cap = Math.min(limits.loose, work.remaining)
  if (!cap) throw gitError('git_limit')
  const encoded = meta(() => io.readMeta(`objects/${oid.slice(0, 2)}/${oid.slice(2)}`, cap))
  work.check()
  if (encoded === null) return null
  if (!Buffer.isBuffer(encoded)) throw gitError('git_corrupt')
  if (encoded.length > cap) throw gitError('git_limit')
  const raw = inflateObject(encoded, limits.tree + LOOSE_HEADER_MAX, 'git_limit', work)
  const headerEnd = raw.subarray(0, LOOSE_HEADER_MAX).indexOf(0)
  if (headerEnd < 0) throw gitError('git_corrupt')
  const header = /^(commit|tree|blob|tag) (0|[1-9][0-9]*)$/.exec(raw.toString('latin1', 0, headerEnd))
  if (!header) throw gitError('git_corrupt')
  const [, type, size] = header
  const declared = Number(size)
  if (declared > objectLimit(type)) throw gitError('git_limit')
  const bytes = raw.subarray(headerEnd + 1)
  if (bytes.length > objectLimit(type)) throw gitError('git_limit')
  if (bytes.length !== declared) throw gitError('git_corrupt')
  return verifyObject(oid, { type, bytes })
}

/**
 * Read SHA-1 objects named by trusted internal refs/index/tree traversal.
 * io is already scoped to the approved project's pinned Git metadata directory;
 * reads return fresh buffers (or null for missing files) and an absent pack
 * directory lists as []. Use one reader per operation with synchronous traversal.
 * Disk and zlib calls are synchronous; the active-time deadline is cooperative.
 */
export function createGitObjectReader(io) {
  let packs, packError
  let calls = 0, elapsed = 0, remaining = limits.work

  function unpackedPacks(work) {
    if (packError) throw gitError(packError)
    if (!packs) {
      try { packs = readPacks(io, work) }
      catch (error) {
        packError = error.code
        throw error
      }
    }
    return packs
  }

  function locate(oid, work, samePack) {
    const preferred = samePack?.byOid.get(oid)
    if (preferred) return { pack: samePack, entry: preferred }
    const loose = readLoose(io, oid, work)
    if (loose) return { loose }
    for (const pack of unpackedPacks(work)) {
      const entry = pack.byOid.get(oid)
      if (entry) return { pack, entry }
    }
    throw gitError('git_object_unavailable')
  }

  function resolve(pack, entry, depth, active, work) {
    work.check()
    if (depth > limits.deltaDepth) throw gitError('git_limit')
    const { oid, type, offsetBase, refBase } = entry
    if (active.has(oid)) throw gitError('git_corrupt')
    if (type) return verifyObject(oid, { type, bytes: inflatePackEntry(pack, entry, work) })
    if (entry.size > limits.delta || depth === limits.deltaDepth) throw gitError('git_limit')
    active.add(oid)
    try {
      let base
      if (offsetBase) base = resolve(pack, offsetBase, depth + 1, active, work)
      else {
        if (active.has(refBase)) throw gitError('git_corrupt')
        const target = locate(refBase, work, pack)
        base = target.loose ?? resolve(target.pack, target.entry, depth + 1, active, work)
      }
      return verifyObject(oid, applyDelta(inflatePackEntry(pack, entry, work), base, work))
    } finally { active.delete(oid) }
  }

  function get(oid) {
    if (++calls > limits.gets) throw gitError('git_limit')
    const started = performance.now()
    const work = {
      get remaining() { return remaining },
      check() {
        if (elapsed + (performance.now() - started) >= limits.activeMs) throw gitError('git_limit')
      },
      consume(bytes) {
        if (bytes > remaining) throw gitError('git_limit')
        remaining -= bytes
        this.check()
      }
    }
    try {
      work.check()
      if (typeof oid !== 'string' || oid.length !== 40 || !oidPattern.test(oid)) throw gitError('git_corrupt')
      const target = locate(oid, work)
      const object = target.loose ?? resolve(target.pack, target.entry, 0, new Set(), work)
      work.check()
      return object
    } finally { elapsed += performance.now() - started }
  }

  return { get }
}
