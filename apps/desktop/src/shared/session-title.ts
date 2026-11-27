/** Manual titles use one line and at most 100 UTF-16 units in both hosts. */
export const SESSION_TITLE_MAX = 100

export function normalizeSessionTitle(value: string): string {
  const singleLine = value.replace(/\s+/g, ' ').trim()
  // Clipping at unit 100 must not leave half an emoji or a trailing separator.
  return singleLine.slice(0, SESSION_TITLE_MAX).replace(/[\uD800-\uDBFF]$/u, '').trimEnd()
}
