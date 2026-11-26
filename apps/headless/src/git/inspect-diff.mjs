import { typedObject } from './inspect-history.mjs'
import { MAX_TEXT_BYTES, diffText, limitationFor } from './inspect-policy.mjs'

const MAX_LINES = 4000
const MAX_OUTPUT_LINES = 1000
const MAX_COMPARISONS = 1_000_000
const CONTEXT = 3
const EMPTY = Buffer.alloc(0)

export function emptyDiff(rel, side, state, limitation) {
  return { state, rel, side, lines: [], truncated: false, limitations: [limitation] }
}

function toLines(text) {
  const lines = []
  for (let at = 0; at < text.length;) {
    if (lines.length === MAX_LINES) return null
    const next = text.indexOf('\n', at)
    if (next < 0) {
      lines.push({ text: text.slice(at), lf: false })
      break
    }
    lines.push({ text: text.slice(at, next), lf: true })
    at = next + 1
  }
  return lines
}

function sameLine(a, b) { return a.id === b.id }

function internLines(oldLines, newLines) {
  // Intern once so the LCS cap bounds comparisons even with long shared string prefixes.
  const ids = [new Map(), new Map()]
  let next = 0
  for (const lines of [oldLines, newLines]) {
    for (const line of lines) {
      const group = ids[Number(line.lf)]
      if (!group.has(line.text)) group.set(line.text, ++next)
      line.id = group.get(line.text)
    }
  }
}

function editRows(oldLines, newLines) {
  internLines(oldLines, newLines)
  let prefix = 0, oldEnd = oldLines.length, newEnd = newLines.length
  while (prefix < oldEnd && prefix < newEnd && sameLine(oldLines[prefix], newLines[prefix])) prefix++
  while (oldEnd > prefix && newEnd > prefix && sameLine(oldLines[oldEnd - 1], newLines[newEnd - 1])) {
    oldEnd--
    newEnd--
  }
  const a = oldEnd - prefix, b = newEnd - prefix, width = b + 1
  if (a * b > MAX_COMPARISONS) return null
  const lcs = new Uint16Array((a + 1) * width)
  for (let i = a - 1; i >= 0; i--) {
    for (let j = b - 1; j >= 0; j--) {
      const cell = i * width + j
      lcs[cell] = sameLine(oldLines[prefix + i], newLines[prefix + j])
        ? lcs[cell + width + 1] + 1 : Math.max(lcs[cell + width], lcs[cell + 1])
    }
  }
  const rows = []
  let oldAt = 0, newAt = 0
  const append = type => {
    const oldNo = type !== 'add' ? ++oldAt : undefined
    const newNo = type !== 'del' ? ++newAt : undefined
    const source = oldNo === undefined ? newLines[newNo - 1] : oldLines[oldNo - 1]
    rows.push({ row: { type, ...(oldNo === undefined ? {} : { oldNo }), ...(newNo === undefined ? {} : { newNo }),
      text: source.text }, lf: source.lf, oldAt, newAt })
  }
  while (oldAt < prefix) append('ctx')
  while (oldAt < oldEnd || newAt < newEnd) {
    if (oldAt < oldEnd && newAt < newEnd && sameLine(oldLines[oldAt], newLines[newAt])) append('ctx')
    else {
      const cell = (oldAt - prefix) * width + newAt - prefix
      if (oldAt < oldEnd && (newAt === newEnd || lcs[cell + width] >= lcs[cell + 1])) append('del')
      else append('add')
    }
  }
  while (oldAt < oldLines.length) append('ctx')
  return rows
}

function renderRows(rows, before, after) {
  const lines = [], hunks = []
  let total = 0, truncated = false
  const add = row => {
    const cost = Buffer.byteLength(row.text)
    if (lines.length >= MAX_OUTPUT_LINES || total + cost > MAX_TEXT_BYTES) {
      truncated = true
      return false
    }
    total += cost
    lines.push(row)
    return true
  }
  if (before && after && before.mode !== after.mode) {
    add({ type: 'hunk', text: `mode ${before.mode.toString(8)} → ${after.mode.toString(8)}` })
  }
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].row.type === 'ctx') continue
    const start = Math.max(0, i - CONTEXT), end = Math.min(rows.length, i + CONTEXT + 1)
    const previous = hunks.at(-1)
    if (previous && previous.end >= start) previous.end = end
    else hunks.push({ start, end })
  }
  if (hunks.length === 0 && Boolean(before) !== Boolean(after)) {
    add({ type: 'hunk', text: before ? 'Empty file deleted' : 'Empty file added' })
  }
  for (const { start, end } of hunks) {
    const oldBefore = rows[start - 1]?.oldAt ?? 0, newBefore = rows[start - 1]?.newAt ?? 0
    const oldSize = rows[end - 1].oldAt - oldBefore, newSize = rows[end - 1].newAt - newBefore
    if (!add({ type: 'hunk', text: `@@ -${oldBefore + Number(oldSize > 0)},${oldSize} +${newBefore + Number(newSize > 0)},${newSize} @@` })) break
    for (let i = start; i < end; i++) {
      if (!add(rows[i].row) || (!rows[i].lf && !add({ type: 'hunk', text: '\\ No newline at end of file' }))) break
    }
    if (truncated) break
  }
  return { lines, truncated }
}

export function buildDiff(reader, rel, side, before, after) {
  let oldBytes, newBytes
  try {
    oldBytes = before ? typedObject(reader, before.oid, 'blob') : EMPTY
    newBytes = after ? (after.bytes ?? (after.oid === before?.oid ? oldBytes : typedObject(reader, after.oid, 'blob'))) : EMPTY
  } catch (error) {
    if (error?.code === 'git_stale') throw error
    return emptyDiff(rel, side, error?.code === 'git_limit' ? 'too_large' : 'unavailable', limitationFor(error, 'diff_object'))
  }
  if (oldBytes.length + newBytes.length > MAX_TEXT_BYTES) return emptyDiff(rel, side, 'too_large', 'diff_byte_limit')
  const oldText = diffText(oldBytes), newText = diffText(newBytes)
  const blocked = [oldText, newText].find(value => value.state === 'unavailable') ??
    [oldText, newText].find(value => value.state !== 'ready')
  if (blocked) return emptyDiff(rel, side, blocked.state, blocked.limitation)
  const oldLines = toLines(oldText.text), newLines = toLines(newText.text)
  if (!oldLines || !newLines) return emptyDiff(rel, side, 'too_large', 'diff_line_limit')
  const rows = editRows(oldLines, newLines)
  if (!rows) return emptyDiff(rel, side, 'too_large', 'diff_computation_limit')
  const { lines, truncated } = renderRows(rows, before, after)
  if (truncated && !lines.some(line => line.type === 'add' || line.type === 'del')) {
    return emptyDiff(rel, side, 'too_large', 'diff_output_limit')
  }
  if (!lines.length) return emptyDiff(rel, side, 'unavailable', 'no_text_change')
  return { state: 'ready', rel, side, lines, truncated, limitations: truncated ? ['diff_output_limit'] : [] }
}
