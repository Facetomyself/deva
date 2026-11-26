/** A browser textarea exposes LF even if its value came from a CRLF file. Reconstruct the
 * original unchanged spans, including mixed terminators, before recording an explicit edit.
 * Newly inserted line breaks follow the document's first terminator. Retain a pre-existing BOM. */
export function workspaceEditorText(raw: string, edited: string): string {
  const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : ''
  const base = raw.slice(bom.length)
  const next = (bom && edited.startsWith(bom) ? edited.slice(1) : edited).replace(/\r\n?/g, '\n')
  if (!base.includes('\r')) return bom + next
  const old = base.replace(/\r\n?/g, '\n')
  if (old === next) return raw
  let first = 0, tail = 0
  const length = Math.min(old.length, next.length)
  while (first < length && old[first] === next[first]) first++
  while (tail < length - first && old[old.length - tail - 1] === next[next.length - tail - 1]) tail++
  let left = 0, right = base.length
  for (let i = 0; i < first; i++) left += base[left] === '\r' && base[left + 1] === '\n' ? 2 : 1
  for (let i = 0; i < tail; i++) right -= base[right - 1] === '\n' && base[right - 2] === '\r' ? 2 : 1
  const ending = base.match(/\r\n|\r|\n/)?.[0] ?? '\n'
  return bom + base.slice(0, left) + next.slice(first, next.length - tail).replace(/\n/g, ending) + base.slice(right)
}
