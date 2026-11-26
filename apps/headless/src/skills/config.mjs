import { TextDecoder } from 'node:util'
import { MAX_SETTINGS_FILE_BYTES } from '../business/settings-file.mjs'
import { skillError } from './errors.mjs'
import { validRoleId } from './validation.mjs'

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const unsupported = () => skillError('skill_unsupported')
const whitespace = char => char === ' ' || char === '\t' || char === '\r' || char === '\n'
function skipWhitespace(text, i) {
  while (whitespace(text[i])) i++
  return i
}

// The text has already passed the bounded, fatal UTF-8 and strict JSON checks below.
// Find token boundaries without decoding or reserializing unrelated values.
function stringEnd(text, i) {
  while (text[++i] !== '"') { if (text[i] === '\\') i++ }
  return i + 1
}

function valueEnd(text, i) {
  if (text[i] === '"') return stringEnd(text, i)
  if (text[i] === '{' || text[i] === '[') {
    let depth = 1
    while (depth) {
      const char = text[++i]
      if (char === '"') i = stringEnd(text, i) - 1
      else if (char === '{' || char === '[') depth++
      else if (char === '}' || char === ']') depth--
    }
    return i + 1
  }
  while (i < text.length && !whitespace(text[i]) && !',}]'.includes(text[i])) i++
  return i
}

function objectSpans(text, start, select) {
  if (text[start] !== '{') throw unsupported()
  const members = new Map()
  let i = skipWhitespace(text, start + 1), prevComma = null, appendAt = start + 1, count = 0
  while (text[i] !== '}') {
    const keyStart = i
    const keyEnd = stringEnd(text, i)
    const key = JSON.parse(text.slice(keyStart, keyEnd))
    const startValue = skipWhitespace(text, skipWhitespace(text, keyEnd) + 1)
    const endValue = valueEnd(text, startValue)
    i = skipWhitespace(text, endValue)
    const nextComma = text[i] === ',' ? i : null
    if (select(key)) {
      if (members.has(key)) throw unsupported() // Avoid editing through ambiguous native keys.
      members.set(key, { keyStart, startValue, endValue, prevComma, nextComma })
    }
    count++
    appendAt = endValue
    if (nextComma !== null) i = skipWhitespace(text, nextComma + 1)
    prevComma = nextComma
  }
  return { members, appendAt, count }
}

export function parseSkillConfig(bytes, ids) {
  let text, rootStart
  try {
    text = bytes ? decoder.decode(bytes) : '{}'
    // Desktop's shared reader accepts the optional UTF-8 BOM. Keep it in the text
    // so we never strip it from an otherwise valid original on a preference edit.
    const first = text.charCodeAt(0) === 0xfeff ? 1 : 0
    JSON.parse(first ? text.slice(first) : text)
    rootStart = skipWhitespace(text, first)
  } catch { throw unsupported() }

  const root = objectSpans(text, rootStart, key => key === 'skills')
  const section = root.members.get('skills')
  const skills = section ? objectSpans(text, section.startValue, key => key === 'enabled' || key === 'roles') : null
  const map = field => {
    const span = skills?.members.get(field)
    return span ? objectSpans(text, span.startValue, id => ids.has(id)) : null
  }
  return { text, root, skills, enabled: map('enabled'), roles: map('roles') }
}

function storedValue(config, field, id) {
  const span = config[field]?.members.get(id)
  return span && JSON.parse(config.text.slice(span.startValue, span.endValue))
}

export function skillPreferences(config, id) {
  const enabled = storedValue(config, 'enabled', id) !== false
  const roles = storedValue(config, 'roles', id)
  // Missing is all roles. Treat an invalid present scope as unsupported rather than
  // silently widening it; preserve stale legacy IDs (including deleted roles) as saved.
  if (roles !== undefined && (!Array.isArray(roles) || !roles.every(validRoleId))) throw unsupported()
  return { enabled, roles: roles ?? null }
}

function insert(text, object, key, encoded) {
  const { appendAt, count } = object
  return text.slice(0, appendAt) + (count ? ',' : '') + JSON.stringify(key) + ':' + encoded + text.slice(appendAt)
}

function remove(text, { keyStart, endValue, prevComma, nextComma }) {
  if (nextComma !== null) return text.slice(0, keyStart) + text.slice(endValue, nextComma) + text.slice(nextComma + 1)
  if (prevComma !== null) return text.slice(0, prevComma) + text.slice(prevComma + 1, keyStart) + text.slice(endValue)
  return text.slice(0, keyStart) + text.slice(endValue)
}

export function encodeSkillPreference(config, id, { field, value }) {
  const { text } = config
  const object = config[field]
  const span = object?.members.get(id)
  let next
  if (value === null) {
    if (!span) return null
    next = remove(text, span)
  } else {
    const encoded = JSON.stringify(value)
    const entry = `{${JSON.stringify(id)}:${encoded}}`
    if (span) next = text.slice(0, span.startValue) + encoded + text.slice(span.endValue)
    else if (object) next = insert(text, object, id, encoded)
    else if (config.skills) next = insert(text, config.skills, field, entry)
    else next = insert(text, config.root, 'skills', `{${JSON.stringify(field)}:${entry}}`)
  }
  if (Buffer.byteLength(next) > MAX_SETTINGS_FILE_BYTES) throw skillError('skill_limit')
  return Buffer.from(next)
}
