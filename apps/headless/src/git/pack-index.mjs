import { gitError, limits, rawSha1 } from './objects-format.mjs'

const MAGIC = 0xff744f63
const FANOUT_END = 8 + 256 * 4
const TRAILER = 40
export const maxIndexBytes = FANOUT_END + 36 * limits.packObjects + TRAILER

export function parsePackIndex(bytes, objectsRemaining, work) {
  const length = bytes.length
  if (length < FANOUT_END - 8 + TRAILER) throw gitError('git_corrupt')
  if (!rawSha1(bytes.subarray(0, -20)).equals(bytes.subarray(-20))) throw gitError('git_corrupt')
  if (bytes.readUInt32BE(0) !== MAGIC || bytes.readUInt32BE(4) !== 2) throw gitError('unsupported_git_layout')
  if (length < FANOUT_END + TRAILER) throw gitError('git_corrupt')

  const count = bytes.readUInt32BE(FANOUT_END - 4)
  if (count > objectsRemaining) throw gitError('git_limit')
  const crcStart = FANOUT_END + count * 20
  const offsetStart = crcStart + count * 4
  const largeStart = offsetStart + count * 4
  const largeBytes = length - TRAILER - largeStart
  if (largeBytes < 0 || largeBytes % 8 || largeBytes > count * 8) throw gitError('git_corrupt')
  const usedLarge = new Uint8Array(largeBytes / 8)

  const byOid = new Map()
  const byOffset = new Map()
  let previousOid
  let i = 0
  for (let bucket = 0; bucket < 256; bucket++) {
    work.check()
    const stop = bytes.readUInt32BE(8 + bucket * 4)
    if (stop < i || stop > count) throw gitError('git_corrupt')
    for (; i < stop; i++) {
      const start = FANOUT_END + i * 20
      const id = bytes.subarray(start, start + 20)
      if (id[0] !== bucket || (previousOid && Buffer.compare(previousOid, id) >= 0)) throw gitError('git_corrupt')
      previousOid = id

      let offset = bytes.readUInt32BE(offsetStart + i * 4)
      if (offset >= 0x80000000) {
        const index = offset - 0x80000000
        if (index >= usedLarge.length || usedLarge[index]) throw gitError('git_corrupt')
        usedLarge[index] = 1
        const wideOffset = bytes.readBigUInt64BE(largeStart + index * 8)
        if (wideOffset >= BigInt(limits.pack)) throw gitError('git_corrupt')
        offset = Number(wideOffset)
      }
      if (offset < 12 || offset >= limits.pack || byOffset.has(offset)) throw gitError('git_corrupt')
      const oid = id.toString('hex')
      const entry = { oid, offset, crc: bytes.readUInt32BE(crcStart + i * 4) }
      byOid.set(oid, entry)
      byOffset.set(offset, entry)
    }
  }
  if (usedLarge.includes(0)) throw gitError('git_corrupt')
  return { byOid, byOffset, checksum: Buffer.from(bytes.subarray(-40, -20)) }
}
