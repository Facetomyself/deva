import { fmArray, fmMap, fmString, parseFrontmatter } from './frontmatter'

/** Native SKILL.md display fields. No directory, lifecycle or runtime concerns. */
export function parseSkillDocument(id: string, raw: string) {
  const { data, body } = parseFrontmatter(raw)
  return {
    id,
    name: fmString(data, 'name') || id,
    description: fmString(data, 'description'),
    trigger: fmString(data, 'trigger'),
    allowedTools: fmArray(data, 'allowed-tools'),
    license: fmString(data, 'license'),
    compatibility: fmString(data, 'compatibility'),
    metadata: fmMap(data, 'metadata'),
    instructions: body.trim()
  }
}
