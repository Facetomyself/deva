import { gitError, inflateObject, limits, meta, objectLimit, rawSha1 } from './objects-format.mjs'
import { maxIndexBytes, parsePackIndex } from './pack-index.mjs'

const PACK_MAGIC = 0x5041434b
const HEADER = 12
const TRAILER = 20
const OFS_DELTA = 6
const REF_DELTA = 7
const types = [undefined, 'commit', 'tree', 'blob', 'tag']

// Git's idx v2 CRC32 uses the IEEE polynomial. Keep this compatible with Node
// 22.0 as well as Node releases with node:zlib.crc32.
const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  for (let j = 0; j < 8; j++) i = (i >>> 1) ^ (i & 1 ? 0xedb88320 : 0)
  return i
})
function crc32(bytes, start, end) {
  let crc = 0xffffffff
  for (let i = start; i < end; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 0xff]
  return (crc ^ 0xffffffff) >>> 0
}

function parseEntryHeader(bytes, entry, end, byOffset) {
  let cursor = entry.offset
  const next = () => {
    if (cursor >= end) throw gitError('git_corrupt')
    return bytes[cursor++]
  }
  let octet = next()
  const kind = (octet >>> 4) & 7
  const type = types[kind]
  if (!type && kind !== OFS_DELTA && kind !== REF_DELTA) throw gitError('git_corrupt')

  let size = octet & 15
  let place = 16
  while (octet & 0x80) {
    if (!Number.isSafeInteger(place)) throw gitError('git_corrupt')
    octet = next()
    size += (octet & 0x7f) * place
    if (!Number.isSafeInteger(size)) throw gitError('git_corrupt')
    place *= 128
  }

  let offsetBase, refBase
  if (kind === OFS_DELTA) {
    octet = next()
    let distance = octet & 0x7f
    const maxDistance = entry.offset - HEADER
    while (octet & 0x80) {
      octet = next()
      distance = (distance + 1) * 128 + (octet & 0x7f)
      if (distance > maxDistance) throw gitError('git_corrupt')
    }
    if (!distance || distance > maxDistance) throw gitError('git_corrupt')
    offsetBase = byOffset.get(entry.offset - distance)
    if (!offsetBase) throw gitError('git_corrupt')
  } else if (kind === REF_DELTA) {
    if (cursor + 20 > end) throw gitError('git_corrupt')
    refBase = bytes.toString('hex', cursor, cursor + 20)
    cursor += 20
  }
  if (end - cursor < 8) throw gitError('git_corrupt') // Minimum zlib stream size.
  Object.assign(entry, { start: cursor, end, type, size, offsetBase, refBase })
}

function validatePack(bytes, index, work) {
  if (bytes.length < HEADER + TRAILER || bytes.readUInt32BE(0) !== PACK_MAGIC) throw gitError('git_corrupt')
  const version = bytes.readUInt32BE(4)
  if (version !== 2 && version !== 3) throw gitError('unsupported_git_layout')
  if (bytes.readUInt32BE(8) !== index.byOid.size) throw gitError('git_corrupt')
  const end = bytes.length - TRAILER
  if (!bytes.subarray(end).equals(index.checksum) || !rawSha1(bytes.subarray(0, end)).equals(index.checksum)) {
    throw gitError('git_corrupt')
  }
  const entries = [...index.byOffset.values()].sort((a, b) => a.offset - b.offset)
  if ((entries[0]?.offset ?? end) !== HEADER) throw gitError('git_corrupt')
  for (let i = 0; i < entries.length; i++) {
    work.check()
    const entry = entries[i]
    const nextOffset = entries[i + 1]?.offset ?? end
    if (entry.offset >= nextOffset || nextOffset > end) throw gitError('git_corrupt')
    if (crc32(bytes, entry.offset, nextOffset) !== entry.crc) throw gitError('git_corrupt')
    parseEntryHeader(bytes, entry, nextOffset, index.byOffset)
  }
  return { bytes, byOid: index.byOid }
}

function packNames(io, work) {
  const listed = meta(() => io.listMeta('objects/pack', limits.directoryEntries))
  work.check()
  if (!Array.isArray(listed)) throw gitError('git_corrupt')
  if (listed.length > limits.directoryEntries) throw gitError('git_limit')
  const pairs = new Map()
  for (const item of listed) {
    const name = item?.name
    if (typeof name !== 'string' || !name.startsWith('pack-') || !(name.endsWith('.pack') || name.endsWith('.idx'))) continue
    const match = /^(pack-[0-9a-f]{40})\.(pack|idx)$/.exec(name)
    if (!match || item.type !== 'file') throw gitError('unsupported_git_layout')
    const [, prefix, suffix] = match
    const files = pairs.get(prefix) ?? new Set()
    if (files.has(suffix)) throw gitError('git_corrupt')
    files.add(suffix)
    pairs.set(prefix, files)
    if (pairs.size > limits.packs) throw gitError('git_limit')
  }
  for (const files of pairs.values()) if (files.size !== 2) throw gitError('git_corrupt')
  return [...pairs.keys()].sort()
}

export function readPacks(io, work) {
  let remaining = limits.packTotal
  let objectsRemaining = limits.packObjects
  const read = (prefix, suffix, maximum) => {
    const cap = Math.min(maximum, remaining)
    if (!cap) throw gitError('git_limit')
    const bytes = meta(() => io.readMeta(`objects/pack/${prefix}.${suffix}`, cap))
    work.check()
    if (bytes === null) throw gitError('git_object_unavailable')
    if (!Buffer.isBuffer(bytes)) throw gitError('git_corrupt')
    if (bytes.length > cap) throw gitError('git_limit')
    remaining -= bytes.length
    return bytes
  }
  const packs = []
  for (const name of packNames(io, work)) {
    const index = parsePackIndex(read(name, 'idx', maxIndexBytes), objectsRemaining, work)
    objectsRemaining -= index.byOid.size
    packs.push(validatePack(read(name, 'pack', limits.pack), index, work))
  }
  return packs
}

export function inflatePackEntry(pack, entry, work) {
  const maximum = entry.type ? objectLimit(entry.type) : limits.delta
  if (entry.size > maximum) throw gitError('git_limit')
  const result = inflateObject(pack.bytes.subarray(entry.start, entry.end), entry.size, 'git_corrupt', work)
  if (result.length !== entry.size) throw gitError('git_corrupt')
  return result
}

export function applyDelta(delta, base, work) {
  let cursor = 0
  const next = () => {
    if (cursor >= delta.length) throw gitError('git_corrupt')
    return delta[cursor++]
  }
  const size = () => {
    let value = 0, place = 1, octet
    do {
      if (!Number.isSafeInteger(place)) throw gitError('git_corrupt')
      octet = next()
      value += (octet & 0x7f) * place
      if (!Number.isSafeInteger(value)) throw gitError('git_corrupt')
      place *= 128
    } while (octet & 0x80)
    return value
  }
  if (size() !== base.bytes.length) throw gitError('git_corrupt')
  const resultSize = size()
  if (resultSize > objectLimit(base.type)) throw gitError('git_limit')
  work.consume(resultSize)
  const bytes = Buffer.alloc(resultSize)
  let written = 0
  let instructions = 0
  while (cursor < delta.length) {
    if ((instructions++ & 0xfff) === 0) work.check()
    const instruction = next()
    if (instruction & 0x80) {
      let offset = 0, length = 0
      for (let i = 0; i < 4; i++) if (instruction & (1 << i)) offset += next() * 256 ** i
      for (let i = 0; i < 3; i++) if (instruction & (0x10 << i)) length += next() * 256 ** i
      length ||= 0x10000
      if (offset + length > base.bytes.length || written + length > resultSize) throw gitError('git_corrupt')
      base.bytes.copy(bytes, written, offset, offset + length)
      written += length
    } else {
      const length = instruction
      if (!length || cursor + length > delta.length || written + length > resultSize) throw gitError('git_corrupt')
      delta.copy(bytes, written, cursor, cursor + length)
      cursor += length
      written += length
    }
  }
  if (written !== resultSize) throw gitError('git_corrupt')
  return { type: base.type, bytes }
}
