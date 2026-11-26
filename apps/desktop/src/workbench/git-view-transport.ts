import type { Transport } from './transport'

export type GitSide = 'staged' | 'worktree'
export type GitRepoState = 'ready' | 'partial' | 'unavailable' | 'not_repo' | 'unsupported_layout'
export type GitEntry = {
  entryId: string; rel: string; staged: string | null; worktree: string | null; conflicted: boolean; diffSides: GitSide[]
}
type GitProjection = { state: GitRepoState; branch: string | null; limitations: string[] }
type GitHead = { detached: boolean; unborn: boolean }
export type GitStatus = GitProjection & GitHead & {
  workspaceId: string; mergeInProgress: boolean; viewId: string | null; entries: GitEntry[]
}
export type GitBranch = { name: string; current: boolean; remote: string | null }
export type GitBranches = GitProjection & GitHead & { branches: GitBranch[] }
export type GitCommit = { oid: string; short: string; subject: string; author?: string; timestamp: number }
export type GitLog = GitProjection & { commits: GitCommit[]; traversal: 'first-parent'; more: boolean }
export type GitDiffLine = { type: 'ctx' | 'add' | 'del' | 'hunk'; oldNo?: number; newNo?: number; text: string }
export type GitDiff = {
  state: 'ready' | 'binary' | 'too_large' | 'unavailable'; rel: string; side: GitSide; lines: GitDiffLine[]; truncated: boolean; limitations: string[]
}
export type GitDiffRequest = { viewId: string; entryId: string; side: GitSide }

export const GIT_LOG_STEP = 20
export const GIT_LOG_MAX = 100

function invalid(): never { throw new Error('Invalid Git inspection request or response') }
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid()
}
function str(value: unknown): string { return typeof value === 'string' ? value : invalid() }
function nullable(value: unknown): string | null { return value === null ? value : str(value) }
function bool(value: unknown): boolean { return typeof value === 'boolean' ? value : invalid() }
function array<T>(value: unknown, parse: (item: unknown) => T): T[] { return Array.isArray(value) ? value.map(parse) : invalid() }
function token(value: unknown, pattern: RegExp): string {
  return typeof value === 'string' && pattern.exec(value)?.[0] === value ? value : invalid()
}
function integer(value: unknown, min: number, max: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : invalid()
}
function literal<T extends string>(value: unknown, values: readonly T[]): T {
  return values.find((item) => item === value) ?? invalid()
}
const viewId = /^v_[0-9a-f]{32}$/u
const entryId = /^e_[0-9a-f]{32}$/u
const diffSide = (value: unknown): GitSide => literal(value, ['staged', 'worktree'])

function projection(row: Record<string, unknown>): GitProjection {
  return { state: literal(row.state, ['ready', 'partial', 'unavailable', 'not_repo', 'unsupported_layout']),
    branch: nullable(row.branch), limitations: array(row.limitations, str) }
}
function head(row: Record<string, unknown>): GitHead { return { detached: bool(row.detached), unborn: bool(row.unborn) } }
function status(value: unknown, workspaceId: string): GitStatus {
  const row = object(value)
  if (row.workspaceId !== workspaceId) return invalid()
  const seen = new Set<string>()
  const entries = array(row.entries, (item): GitEntry => {
    const entry = object(item)
    const id = token(entry.entryId, entryId)
    const sides = array(entry.diffSides, diffSide)
    if (seen.has(id) || new Set(sides).size !== sides.length) return invalid()
    seen.add(id)
    return { entryId: id, rel: str(entry.rel), staged: nullable(entry.staged), worktree: nullable(entry.worktree),
      conflicted: bool(entry.conflicted), diffSides: sides }
  })
  return { ...projection(row), ...head(row), workspaceId, mergeInProgress: bool(row.mergeInProgress),
    viewId: row.viewId === null ? null : token(row.viewId, viewId), entries }
}
function branches(value: unknown): GitBranches {
  const row = object(value)
  return { ...projection(row), ...head(row), branches: array(row.branches, (item) => {
    const branch = object(item)
    return { name: str(branch.name), current: bool(branch.current), remote: nullable(branch.remote) }
  }) }
}
function log(value: unknown, limit: number): GitLog {
  const row = object(value)
  const commits = array(row.commits, (item): GitCommit => {
    const commit = object(item)
    const oid = token(commit.oid, /^[0-9a-f]{40}$/u)
    const short = token(commit.short, /^[0-9a-f]{4,40}$/u)
    if (!oid.startsWith(short)) return invalid()
    return { oid, short, subject: str(commit.subject), ...(commit.author === undefined ? {} : { author: str(commit.author) }),
      timestamp: integer(commit.timestamp, -8_640_000_000_000, 8_640_000_000_000) }
  })
  if (commits.length > limit) return invalid()
  return { ...projection(row), more: bool(row.more), traversal: literal(row.traversal, ['first-parent']), commits }
}
function diff(value: unknown, side: GitSide): GitDiff {
  const row = object(value)
  if (row.side !== side) return invalid()
  const lines = array(row.lines, (item): GitDiffLine => {
    const line = object(item)
    return { type: literal(line.type, ['ctx', 'add', 'del', 'hunk']), text: str(line.text),
      ...(line.oldNo === undefined ? {} : { oldNo: integer(line.oldNo, 0, Number.MAX_SAFE_INTEGER) }),
      ...(line.newNo === undefined ? {} : { newNo: integer(line.newNo, 0, Number.MAX_SAFE_INTEGER) }) }
  })
  return { state: literal(row.state, ['ready', 'binary', 'too_large', 'unavailable']), rel: str(row.rel), side, lines,
    truncated: bool(row.truncated), limitations: array(row.limitations, str) }
}

/** Only the four owner projections; no route/body identifiers derived from Git text. */
export function createGitViewTransport(transport: Pick<Transport, 'gitRequest'>, csrf: string) {
  const request = (id: string, action: 'status' | 'branches' | 'log' | 'diff', body: object, signal: AbortSignal): Promise<unknown> =>
    transport.gitRequest(`/workspaces/${token(id, /^w_[0-9a-f]{32}$/u)}/git/${action}`, body, csrf, signal)
  return {
    async status(id: string, signal: AbortSignal): Promise<GitStatus> {
      return status(await request(id, 'status', {}, signal), id)
    },
    async branches(id: string, signal: AbortSignal): Promise<GitBranches> {
      return branches(await request(id, 'branches', {}, signal))
    },
    async log(id: string, limit: number, signal: AbortSignal): Promise<GitLog> {
      return log(await request(id, 'log', { limit: integer(limit, 1, GIT_LOG_MAX) }, signal), limit)
    },
    async diff(id: string, selection: GitDiffRequest, signal: AbortSignal): Promise<GitDiff> {
      const side = diffSide(selection.side)
      return diff(await request(id, 'diff', { viewId: token(selection.viewId, viewId), entryId: token(selection.entryId, entryId), side }, signal), side)
    }
  }
}
export type GitViewTransport = ReturnType<typeof createGitViewTransport>
