import { taskLimit, taskUnsupported } from './errors.mjs'

// After JSON.parse establishes the grammar, inspect the same source for duplicate keys,
// bounded nesting, and the exact spans of the only editable native values. Byte-equivalent
// splicing keeps opaque fields, numeric precision, whitespace and record order intact.
export function taskRecordSpans(text) {
  const spans = []
  const quote = /["\\]/g
  const space = /[\t\n\r ]*/y
  const atom = /[^\t\n\r ,}\]]+/y
  let offset = 0
  let nodes = 0

  function skipSpace() {
    space.lastIndex = offset
    space.exec(text)
    offset = space.lastIndex
  }

  function readString() {
    quote.lastIndex = ++offset
    for (let match; (match = quote.exec(text));) {
      if (match[0] === '"') {
        offset = quote.lastIndex
        return
      }
      quote.lastIndex++
    }
    throw taskUnsupported()
  }

  function value(depth, role, fields) {
    if (++nodes > 262_144 || depth > 32) throw taskLimit()
    skipSpace()
    const start = offset
    const next = text[offset]
    if (next === '{') {
      const keys = new Set()
      offset++
      skipSpace()
      while (text[offset] !== '}') {
        const keyStart = offset
        readString()
        const key = JSON.parse(text.slice(keyStart, offset))
        if (keys.has(key)) throw taskUnsupported()
        keys.add(key)
        if (++nodes > 262_144) throw taskLimit()
        skipSpace()
        offset++ // colon
        const span = value(depth + 1, role === 'root' && key === 'tasks' ? 'records' : null)
        if (role === 'record' && (key === 'status' || key === 'updatedAt')) fields[key] = span
        skipSpace()
        if (text[offset] !== ',') break
        offset++
        skipSpace()
      }
      offset++
    } else if (next === '[') {
      offset++
      skipSpace()
      while (text[offset] !== ']') {
        const fields = role === 'records' ? {} : undefined
        if (fields) spans.push(fields)
        value(depth + 1, fields ? 'record' : null, fields)
        skipSpace()
        if (text[offset] !== ',') break
        offset++
        skipSpace()
      }
      offset++
    } else if (next === '"') {
      readString()
    } else {
      atom.lastIndex = offset
      if (!atom.exec(text)) throw taskUnsupported()
      offset = atom.lastIndex
    }
    return [start, offset]
  }

  value(0, 'root')
  return spans
}

export function patchTaskStatus(text, spans, updatedAt) {
  const patches = [[spans.status, '"paused"'], [spans.updatedAt, JSON.stringify(updatedAt)]]
    .sort(([a], [b]) => b[0] - a[0])
  for (const [[start, end], replacement] of patches) text = text.slice(0, start) + replacement + text.slice(end)
  return Buffer.from(text, 'utf8')
}
