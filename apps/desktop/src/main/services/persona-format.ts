import { fmScalar, fmString, parseFrontmatter } from './frontmatter'

export const PERSONA_MARKDOWN_FIELDS = ['name', 'description', 'avatar', 'model', 'workspace', 'workspaceId'] as const
export type PersonaMarkdownFields = Record<(typeof PERSONA_MARKDOWN_FIELDS)[number] | 'prompt', string>

interface Header {
  bom: string
  opening: string
  closing: string
  newline: string
  lines: string[]
  body: string
  indexes: Map<string, number>
}

export interface ParsedPersonaMarkdown extends PersonaMarkdownFields {
  /** Strict editing keeps untouched fields, comments, opaque extension metadata and body bytes. */
  readonly source?: Header
}

const keyLine = /^([A-Za-z0-9_-]+)[\t ]*:[\t ]*(.*)$/u
const keyIsForbidden = (key: string): boolean => ['__proto__', 'prototype', 'constructor'].includes(key)
const known = new Set<string>(PERSONA_MARKDOWN_FIELDS)
const badControl = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|\r(?!\n)/u
const corrupt = (): never => { throw new Error('Invalid persona frontmatter') }

function strictHeader(raw: string): Header {
  const bom = raw.startsWith('\ufeff') ? '\ufeff' : ''
  const text = raw.slice(bom.length)
  if (badControl.test(text)) corrupt()
  const opening = /^[\t ]*---[\t ]*(\r?\n)/u.exec(text)
  if (!opening) return corrupt()
  const tail = text.slice(opening[0].length)
  const delimiter = /(?:^|\n)([\t ]*---[\t ]*(?:\r?\n|(?![\s\S])))/u.exec(tail)
  if (!delimiter) return corrupt()
  const closing = delimiter[1]
  const start = delimiter.index + (delimiter[0].length - closing.length)
  const lines = tail.slice(0, start).match(/[^\n]*\n/gu) ?? []
  const indexes = new Map<string, number>()
  let active: string | undefined
  for (const [index, segment] of lines.entries()) {
    const line = segment.replace(/\r?\n$/u, '')
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const m = keyLine.exec(line)
    if (!m) {
      // Opaque extension blocks travel unchanged. Reject nested prototype keys rather
      // than giving them to the desktop's permissive frontmatter parser on a later read.
      const child = /^[\t ]+(?:-[\t ]+)?(?:['"])?([A-Za-z0-9_-]+)(?:['"])?[\t ]*:/u.exec(line)
      if (!active || known.has(active) || !/^[\t ]+\S/u.test(line) || (child && keyIsForbidden(child[1]))) corrupt()
      continue
    }
    const [, key, value] = m
    if (keyIsForbidden(key) || indexes.has(key)) corrupt()
    active = key
    indexes.set(key, index)
    if (known.has(key)) {
      const scalar = value.trim()
      if (/[\r\n]/u.test(scalar) ||
          (scalar.startsWith('"') && !/^"(?:[^"\\]|\\["\\])*"$/u.test(scalar)) ||
          (scalar.startsWith("'") && !/^'[^']*'$/u.test(scalar)) ||
          /^\[.*\]$/u.test(scalar)) corrupt()
    }
  }
  return { bom, opening: opening[0], closing, newline: opening[1], lines,
    body: tail.slice(start + closing.length), indexes }
}

/** Desktop keeps its tolerant legacy read; server writes require a checked, patchable header. */
export function parsePersonaMarkdown(id: string, raw: string, { strict = false } = {}): ParsedPersonaMarkdown {
  const source = strict ? strictHeader(raw) : undefined
  // Never parse opaque extension fields in strict mode. The existing scalar reader remains
  // the single authority for interpreting desktop-owned values.
  const text = source
    ? ['---', ...PERSONA_MARKDOWN_FIELDS.flatMap(key => {
      const index = source.indexes.get(key)
      return index === undefined ? [] : [source.lines[index].replace(/\r?\n$/u, '')]
    }), '---', source.body].join('\n')
    : raw
  const { data, body } = parseFrontmatter(text)
  return {
    name: fmString(data, 'name') || id,
    description: fmString(data, 'description'),
    avatar: fmString(data, 'avatar'),
    model: fmString(data, 'model'),
    workspace: fmString(data, 'workspace'),
    workspaceId: fmString(data, 'workspaceId'),
    prompt: body.trim(),
    ...(source ? { source } : {})
  }
}

/** Create desktop-compatible Markdown, or change only the supplied fields of a strict parse. */
export function serializePersonaMarkdown(fields: Partial<PersonaMarkdownFields>, previous?: ParsedPersonaMarkdown): string {
  const source = previous?.source
  const newline = source?.newline ?? '\n'
  const lines: (string | null)[] = source ? [...source.lines] : []
  for (const key of PERSONA_MARKDOWN_FIELDS) {
    const value = fields[key]
    if (value === undefined || value === previous?.[key]) continue
    const index = source?.indexes.get(key)
    const line = value || key === 'name' ? `${key}: ${fmScalar(value)}${newline}` : null
    if (index === undefined) { if (line !== null) lines.push(line) }
    else lines[index] = line
  }
  const prompt = fields.prompt
  const changedBody = !source || (prompt !== undefined && prompt.trim() !== previous?.prompt)
  const body = changedBody ? `${newline}${(prompt ?? '').trim().replace(/\r?\n/g, newline)}${newline}` : source.body
  let closing = source?.closing ?? `---${newline}`
  if (body && !closing.endsWith('\n')) closing += newline
  return `${source?.bom ?? ''}${source?.opening ?? `---${newline}`}${lines.join('')}${closing}${body}`
}
