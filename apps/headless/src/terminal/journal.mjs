import { sequenceConflict } from './validation.mjs'

const RING_SIZE = 8
// Reserve enough room for the JSON envelope and commas even at maximum cursor size.
const BYTE_BUDGET = 256 * 1024 - 128

/** In-memory journal of already validated, immutable display frames and final exit. */
export function openTerminalJournal() {
  let cursor = 0, ring = [], bytes = 0, latest = null, exit = null

  function append(type, value) {
    const entry = Object.freeze({ seq: ++cursor, type, [type]: value })
    const size = Buffer.byteLength(JSON.stringify(entry))
    ring.push({ entry, size })
    bytes += size
    while (ring.length > RING_SIZE || bytes > BYTE_BUDGET) bytes -= ring.shift().size
    return entry
  }

  return {
    get cursor() { return cursor },
    screen(value) { if (!exit) latest = append('screen', value) },
    finish(value) { if (!exit) exit = append('exit', value) },
    read(after) {
      if (after > cursor) throw sequenceConflict()
      const reset = after < cursor && (ring.length === 0 || after < ring[0].entry.seq - 1)
      const entries = reset ? [latest, exit].filter(Boolean) : ring.map(({ entry }) => entry)
      return { cursor, reset, events: entries.filter(entry => entry.seq > after) }
    },
    clear() {
      ring = []; bytes = 0; latest = null; exit = null
    },
  }
}
