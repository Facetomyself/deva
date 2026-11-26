import { isDeepStrictEqual } from 'node:util'
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeSettings, publishSettingsFile, readSettingsFile, withSettingsDirectory } from '../../apps/headless/src/business/settings-file.mjs'

export class SkillCheckError extends Error {}
export function check(value, message) { if (!value) throw new SkillCheckError(message) }

export const roleName = 'Editorial Reviewer'
export const builtinIds = ['create-agent', 'create-skill', 'create-mcp']
export const marker = 'EDITORIAL-RESOURCE-SENTINEL: private fixture text.'
export const guide = Object.freeze({ id: 'editorial-guide', name: 'Editorial Guide', body: [
  '# Proof copy',
  'Use sentence case for headings and keep captions short.',
  '[Glossary](https://skills-fixture.invalid/glossary)',
  '<span data-fixture="editorial-phrase">literal markup</span>',
  '`https://skills-fixture.invalid/inline`',
  '`references/editorial-notes.txt`'
].join('\n') })
export const notes = Object.freeze({ id: 'release-notes', name: 'Release Notes', body: '# Release notes\nList user-facing changes in order.' })
export const revisedGuide = Object.freeze({ ...guide, name: 'Editorial Guide – Revised', body: `${guide.body}\nCheck that figure numbers match the captions.` })

function documentBytes(doc) {
  return Buffer.from([
    '---', `name: ${doc.name}`, 'description: Ordinary copy-editing notes for a synthetic publication.',
    'trigger: During editorial review', 'allowed-tools:', '  - read_file', 'license: CC0-1.0',
    'compatibility: Plain text', 'metadata:', '  audience: editors', '---', '', doc.body, ''
  ].join('\n'))
}

export async function privateRoot() {
  const prefix = join(await realpath(tmpdir()), 'deva-wb-skills-')
  const root = await mkdtemp(prefix)
  const info = await lstat(root)
  async function verify() {
    const current = await lstat(root)
    check(root.startsWith(prefix) && root.length > prefix.length && await realpath(root) === root && current.isDirectory() &&
      current.uid === process.geteuid() && (current.mode & 0o777) === 0o700 && info.ino === current.ino && info.dev === current.dev,
    'Expected the original private synthetic directory')
  }
  await verify()
  return { root, async close() { await verify(); await rm(root, { recursive: true }) } }
}

export async function createSkillFixture(root) {
  const dataDir = join(root, 'data'), skillRoot = join(dataDir, 'skills')
  const docPath = doc => join(skillRoot, doc.id, 'SKILL.md')
  const resourceDir = join(skillRoot, guide.id, 'references')
  const resource = join(resourceDir, 'editorial-notes.txt')
  const create = (path, bytes) => writeFile(path, bytes, { mode: 0o600, flag: 'wx' })
  const rawConfig = () => withSettingsDirectory(dataDir, null, async dir => (await readSettingsFile(dir)).raw)
  await mkdir(resourceDir, { recursive: true, mode: 0o700 })
  await mkdir(join(skillRoot, notes.id), { mode: 0o700 })
  await create(resource, marker)
  // On normal Linux relatime mounts, a successful content read advances this deliberately old atime.
  const old = new Date('2000-01-01T00:00:00Z')
  await utimes(resource, old, old)
  const resourceSnapshot = await stat(resource, { bigint: true })
  await Promise.all([guide, notes].map(doc => create(docPath(doc), documentBytes(doc))))
  await withSettingsDirectory(dataDir, null, async dir => {
    const { info } = await readSettingsFile(dir)
    check(!info, 'The synthetic native config must start fresh')
    const published = await publishSettingsFile(dir, encodeSettings({ locale: 'en', theme: 'light',
      skills: { enabled: { [guide.id]: true, [notes.id]: false }, roles: { [notes.id]: [] }, sidebarLabel: 'Editorial collection' }
    }), info)
    check(published.durable, 'Could not publish the synthetic native config')
  })
  const { openPersonas } = await import('../../apps/headless/src/business/personas.mjs')
  const personas = await openPersonas({ dataDir })
  const role = await personas.upsert({ name: roleName, description: 'Reviews copies of synthetic publications.',
    prompt: 'Check spelling and punctuation.', enabled: true })
  const general = await personas.get('general')
  check(role.enabled && !role.protected && general?.enabled && general.protected, 'Expected one ordinary role and the native General role')
  const initial = await rawConfig()
  let currentGuide = guide
  return Object.freeze({
    dataDir, role, general,
    async assertNative(enabled, roles) {
      const raw = await rawConfig()
      const expected = structuredClone(initial)
      expected.skills.enabled[guide.id] = enabled
      if (roles === null) delete expected.skills.roles[guide.id]
      else expected.skills.roles[guide.id] = roles
      check(isDeepStrictEqual(raw, expected), 'Raw native config changed outside the selected skill preference or stored a wrong scope')
      for (const doc of [currentGuide, notes]) {
        check((await readFile(docPath(doc))).equals(documentBytes(doc)), 'A preference changed the source SKILL.md bytes')
      }
      const now = await stat(resource, { bigint: true })
      for (const field of ['dev', 'ino', 'size', 'ctimeNs', 'mtimeNs', 'atimeNs']) {
        check(now[field] === resourceSnapshot[field], 'Unrelated editorial resource was opened or changed')
      }
    },
    async reviseGuide() {
      check(currentGuide === guide, 'Expected the original editorial document before manual edit')
      const target = docPath(guide), temp = join(skillRoot, guide.id, '.editorial-draft')
      check(await realpath(target) === target && (await lstat(target)).isFile(), 'Manual edit must target the private regular fixture file')
      await create(temp, documentBytes(revisedGuide))
      await rename(temp, target)
      currentGuide = revisedGuide
    }
  })
}
