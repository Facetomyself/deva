import { isSessionId } from '../events/chat-event.mjs'
import { decodeUtf8 } from '../files/workspace-files-fd.mjs'
import { invalidReadState, readStateLimit } from './read-mark-errors.mjs'

export const MAX_READ_STATE_BYTES = 1024 * 1024
export const MAX_READ_STATE_IDS = 8192
export const validReadMark = (id, time) => isSessionId(id) && Number.isSafeInteger(time) && time >= 0

// JSON hardens neither duplicate keys nor rounded decimal input. Keep the raw form of every
// unrelated byte and require an exact safe integer in the mathematical value of each token.
function exactTimestamp(token) {
  const [, minus, whole, fraction = '', exponent = '0'] = token
  const digits = whole + fraction
  const first = digits.search(/[1-9]/)
  if (first < 0) return 0 // Includes the valid legacy representation -0.
  const point = whole.length + Number(exponent)
  if (minus || point <= first || point - first > 16 || /[1-9]/.test(digits.slice(point))) throw invalidReadState()
  const value = Number(token[0])
  if (!Number.isSafeInteger(value)) throw invalidReadState()
  return value
}

export function parseReadState(bytes, targetId) {
  if (bytes.length > MAX_READ_STATE_BYTES) throw readStateLimit()
  let text
  try { text = decodeUtf8(bytes) } catch { throw invalidReadState() }
  // The shared fatal decoder deliberately retains BOM; retain it in the output, if present.
  let cursor = text.charCodeAt(0) === 0xfeff ? 1 : 0
  const values = new Map()
  const white = /[\x20\t\r\n]*/y
  const key = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})){0,128}"/y
  const number = /(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?/y
  function match(pattern) {
    pattern.lastIndex = cursor
    const token = pattern.exec(text)
    if (!token) throw invalidReadState()
    cursor = pattern.lastIndex
    return token
  }
  const ws = () => match(white)
  ws()
  if (text[cursor++] !== '{') throw invalidReadState()
  let insertion = cursor
  let target
  ws()
  if (text[cursor] !== '}') {
    for (;;) {
      const spelling = match(key)[0]
      if (spelling.length > 770) throw invalidReadState() // 128 ASCII characters, up to six bytes each, plus quotes.
      const id = JSON.parse(spelling)
      ws()
      if (text[cursor++] !== ':') throw invalidReadState()
      ws()
      const start = cursor
      const time = exactTimestamp(match(number))
      if (!validReadMark(id, time) || values.has(id)) throw invalidReadState()
      if (values.size >= MAX_READ_STATE_IDS) throw readStateLimit()
      values.set(id, time)
      if (id === targetId) target = { start, end: cursor }
      insertion = cursor
      ws()
      if (text[cursor] !== ',') break
      cursor++
      ws()
    }
  }
  if (text[cursor++] !== '}') throw invalidReadState()
  ws()
  if (cursor !== text.length) throw invalidReadState()
  return { text, values, insertion, target }
}

export function advanceReadState(state, id, through) {
  let text
  if (!state) text = `{${JSON.stringify(id)}:${through}}`
  else if (state.target) {
    const { text: raw, target: { start, end } } = state
    text = `${raw.slice(0, start)}${through}${raw.slice(end)}`
  } else {
    const { text: raw, values, insertion } = state
    if (values.size >= MAX_READ_STATE_IDS) throw readStateLimit()
    text = `${raw.slice(0, insertion)}${values.size ? ',' : ''}${JSON.stringify(id)}:${through}${raw.slice(insertion)}`
  }
  if (Buffer.byteLength(text) > MAX_READ_STATE_BYTES) throw readStateLimit()
  return Buffer.from(text, 'utf8')
}
