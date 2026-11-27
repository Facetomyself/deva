import { createHash } from 'node:crypto'
import { isSharedArrayBuffer, isUint8Array } from 'node:util/types'
import { textAttachmentProblem } from './text-file'
import { isProjectDocsLabel, MAX_PROJECT_DOCUMENTS, MAX_PROJECT_TEXT_BYTES } from './project-docs-format'

export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024
export const isSnapshotDigest = (v: unknown): v is string => typeof v === 'string' && v.length === 64 && !/[^a-f0-9]/u.test(v)
type ErrorCode = 'invalid_digest' | 'digest_mismatch' | 'invalid_snapshot' | 'snapshot_limit'
export class SnapshotError extends Error {
  constructor(readonly code: ErrorCode) { super(code) }
}
const invalid = (): never => { throw new SnapshotError('invalid_snapshot') }
const limit = (): never => { throw new SnapshotError('snapshot_limit') }
export type SnapshotDocument = Readonly<{ name: string; text: string; bytes: number }>
export type ProjectSnapshot = Readonly<{ version: 1; project: string; documents: readonly SnapshotDocument[]; totalTextBytes: number }>

// Fixed-depth v1 grammar. Read each member before assigning it: JSON.parse on a whole
// object loses duplicate keys (including escaped spellings) and rounds number literals.
function parseV1(source: string): ProjectSnapshot {
  let at = 0
  function whitespace(): void {
    while (source[at] === ' ' || source[at] === '\t' || source[at] === '\r' || source[at] === '\n') at++
  }
  function take(ch: string): boolean {
    whitespace()
    if (source[at] !== ch) return false
    at++; return true
  }
  function expect(ch: string): void { if (!take(ch)) invalid() }
  function string(): string {
    expect('"'); const start = at - 1
    while (at < source.length) {
      const ch = source[at++]
      if (ch === '\\') at++ // Skip an escaped character; JSON.parse validates escapes inside this token.
      else if (ch === '"') {
        try { return JSON.parse(source.slice(start, at)) as string } catch { return invalid() }
      }
    }
    return invalid()
  }
  function object(keys: readonly string[], readField: (key: string) => void): void {
    expect('{')
    const remaining = new Set(keys)
    do {
      const key = string()
      if (!remaining.delete(key)) invalid()
      expect(':'); readField(key)
    } while (take(','))
    expect('}'); if (remaining.size) invalid()
  }

  let project = '', totalTextBytes = 0
  const documents: SnapshotDocument[] = [], names = new Set<string>()
  object(['version', 'project', 'documents'], key => {
    if (key === 'version') { expect('1'); return }
    if (key === 'project') {
      project = string()
      if (!isProjectDocsLabel(project)) invalid()
      return
    }
    expect('[')
    do {
      if (documents.length >= MAX_PROJECT_DOCUMENTS) limit()
      let name = '', text = ''
      object(['name', 'text'], field => { if (field === 'name') name = string(); else text = string() })
      const issue = textAttachmentProblem({ name, text })
      if (issue === 'size') limit()
      if (issue) invalid()
      const canonical = name.normalize('NFC').toLowerCase()
      if (names.has(canonical)) invalid()
      names.add(canonical)
      const bytes = Buffer.byteLength(text)
      totalTextBytes += bytes
      if (totalTextBytes > MAX_PROJECT_TEXT_BYTES) limit()
      documents.push(Object.freeze({ name, text, bytes }))
    } while (take(','))
    expect(']')
  })
  whitespace(); if (at !== source.length) invalid()
  return Object.freeze({ version: 1, project, documents: Object.freeze(documents), totalTextBytes })
}

/** Validate the independently reviewed wire bytes, not a re-serialized object. No I/O or ambient configuration. */
export function validateProjectSnapshot(bytes: Uint8Array, expectedSha256: string): ProjectSnapshot {
  if (!isSnapshotDigest(expectedSha256)) throw new SnapshotError('invalid_digest')
  if (!isUint8Array(bytes) || isSharedArrayBuffer(bytes.buffer)) invalid()
  if (bytes.byteLength > MAX_SNAPSHOT_BYTES) limit()
  // Hash and decode the same private copy; never expose a view onto the caller's backing store.
  let raw: Uint8Array
  try { raw = new Uint8Array(bytes) } catch { return invalid() }
  if (createHash('sha256').update(raw).digest('hex') !== expectedSha256) throw new SnapshotError('digest_mismatch')
  let source: string
  // Keep an input BOM visible to the grammar: it is not JSON whitespace. BOM inside text is data.
  try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw) } catch { return invalid() }
  return parseV1(source)
}
