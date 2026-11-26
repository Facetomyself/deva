import { TextDecoder } from 'node:util'
import { parseSkillDocument } from '../../dist/library-core.mjs'
import { fail } from './documents-errors.mjs'
import { isBuiltinAlias, isPrototypeName } from './documents-ids.mjs'

export const MAX_HEADER_BYTES = 16 * 1024
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

// Recognizable credential forms only, not a general secret scanner. Prose, paths,
// resource references, and placeholders stay literal; they are never dereferenced.
const obviousKeyMaterial = /-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{24,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:proj-|svcacct-|ant-api\d+-)?[A-Za-z0-9_-]{24,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{16,}|(?:sk|rk)_live_[A-Za-z0-9]{16,})\b/u
const sensitiveKey = name => {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[_.\-\s]+/)
  return words.some(word => /^(?:auth|authorization|bearer|cookies?|credentials?|pass(?:word|phrase|wd)|secrets?|tokens?|apikey|accesskey|privatekey|clientsecret)$/.test(word)) ||
    /(?:^| )(?:api|access|private|signing|ssh) keys?(?: |$)/.test(words.join(' '))
}

function checkedText(bytes) {
  let text
  try { text = utf8.decode(bytes) } catch { fail() }
  text = text.replace(/^\uFEFF/u, '').replace(/\r\n/g, '\n')
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(text)) fail()
  return text
}

function inspectHeader(header, selected) {
  const outer = new Set()
  let inner = new Set()
  for (const line of header.trimEnd().split('\n').slice(1, -1)) {
    const entry = /^([ \t]*)(?:(['"])([A-Za-z0-9_.-]+)\2|([A-Za-z0-9_.-]+))[ \t]*:/u.exec(line)
    if (!entry) continue
    const name = entry[3] ?? entry[4]
    if (isPrototypeName(name)) fail()
    const seen = entry[1] ? inner : outer
    const folded = name.toLowerCase()
    if (seen.has(folded)) fail()
    seen.add(folded)
    if (!entry[1]) inner = new Set()
    if (selected && sensitiveKey(name)) fail('skill_restricted')
  }
}

// The only byte-reading entry point for a catalog row. Read in small chunks and
// stop on the closing marker (or as soon as the first line is not an opener).
// The final read can overlap the body; only bytes up to the marker are decoded or
// parsed. Stamp callers never enter this module's read paths.
function readHeader(size, read) {
  const bytes = Buffer.alloc(Math.min(size, MAX_HEADER_BYTES + 1))
  let used = 0, start = 0, opened = false
  while (used < bytes.length) {
    const n = Math.min(bytes.length - used, 512)
    read(bytes, used, n, used)
    used += n
    while (start < used) {
      const lf = bytes.indexOf(10, start)
      const newline = lf !== -1 && lf < used
      if (!newline && used < size) break
      const end = newline ? lf + 1 : used
      const marker = bytes.toString('utf8', start, end).trim() === '---'
      if (start === 0) {
        if (!marker) return ''
        opened = true
      } else if (marker) {
        if (end > MAX_HEADER_BYTES) fail('skill_limit')
        return checkedText(bytes.subarray(0, end))
      }
      start = end
    }
  }
  // A long first prose line is not a long metadata header.
  if (!opened && !/^\s*(?:-{0,2}|---\s*)$/u.test(bytes.toString('utf8', 0, used))) return ''
  if (!opened && size <= MAX_HEADER_BYTES) return ''
  if (size > MAX_HEADER_BYTES) fail('skill_limit')
  fail() // Opening delimiter without a closing delimiter.
}

function checkedSummary({ name, description }) {
  if (isBuiltinAlias(name)) fail()
  if (obviousKeyMaterial.test(name) || obviousKeyMaterial.test(description)) fail('skill_restricted')
  return { name, description }
}

export function readSkillSummary(id, size, read) {
  const header = readHeader(size, read)
  inspectHeader(header, false)
  return checkedSummary(parseSkillDocument(id, header))
}

export function readSkillDetail(id, size, read) {
  const bytes = Buffer.alloc(size)
  read(bytes, 0, size, 0)
  const header = readHeader(size, (dst, offset, length, start) => bytes.copy(dst, offset, start, start + length))
  inspectHeader(header, true)
  const raw = checkedText(bytes)
  if (obviousKeyMaterial.test(raw)) fail('skill_restricted')
  const parsed = parseSkillDocument(id, raw)
  checkedSummary(parsed)
  return parsed
}
