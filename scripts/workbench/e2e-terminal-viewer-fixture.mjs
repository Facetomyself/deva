import { createHash } from 'node:crypto'
import { lstat, mkdir, open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

export class TerminalViewerCheckError extends Error {}

export function check(condition, message) {
  if (!condition) throw new TerminalViewerCheckError(message)
}

const notes = Array.from({ length: 44 }, () => 'Synthetic release notes')
notes[0] = 'First page | Alpha field guide'
notes[1] = 'Unicode | café · Ελληνικά · 中文'
notes[2] = `<em data-qa-pager="quoted">'safe' & "plain"</em>`
notes[12] = 'Second page | distinctive PTY page marker'
notes[43] = 'Final line | End of the Alpha field guide'
const lines = notes.map((text, i) => `${String(i + 1).padStart(2, '0')} | ${text}`)

export const terminalExpected = Object.freeze({ project: 'Alpha', file: 'guide.txt', lines: Object.freeze(lines) })

async function snapshot(filePath) {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat({ bigint: true })
    check(stat.isFile() && stat.nlink === 1n && (stat.mode & 0o777n) === 0o444n,
      'The fixture must be one ordinary read-only file (0444)')
    return { hash: createHash('sha256').update(await handle.readFile()).digest('hex'),
      mtime: stat.mtimeNs, inode: stat.ino, device: stat.dev, size: stat.size }
  } finally {
    await handle.close()
  }
}

/** Seed only an isolated fixture directory. The caller owns the parent and its lifetime. */
export async function createTerminalFixture(workspaceRoot) {
  check(typeof workspaceRoot === 'string' && isAbsolute(workspaceRoot) && resolve(workspaceRoot) === workspaceRoot,
    'Use an absolute normalized workspace fixture directory')
  await mkdir(workspaceRoot, { recursive: true, mode: 0o755 })
  check((await lstat(workspaceRoot)).isDirectory(), 'The workspace fixture root must be an ordinary directory')
  const expected = terminalExpected
  const projectDir = join(workspaceRoot, expected.project)
  const filePath = join(projectDir, expected.file)
  await mkdir(projectDir, { mode: 0o755 })
  const handle = await open(filePath, 'wx', 0o444)
  try {
    await handle.writeFile(`${expected.lines.join('\n')}\n`, 'utf8')
    await handle.chmod(0o444)
  } finally {
    await handle.close()
  }
  const before = await snapshot(filePath)
  return { expected, filePath, async assertUnchanged() {
    const after = await snapshot(filePath)
    check(Object.keys(before).every(field => after[field] === before[field]),
      'The fixture digest, nanosecond mtime, size, or file identity changed while reading')
  } }
}
