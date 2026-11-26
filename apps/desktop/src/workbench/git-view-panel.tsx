import { useId, useSyncExternalStore } from 'react'
import { Check, FileDiff, GitBranch, GitCommitHorizontal, RefreshCw } from 'lucide-react'
import { useI18n } from '../renderer/src/i18n/i18n'
import { GitBranchPill } from '../renderer/src/redesign/GitBranchPill'
import { gitLimitationLabels, gitViewCopy, hasStatusOmissions } from './git-view-copy'
import { hasGitData, type WorkspaceGitView } from './git-view-controller'
import { GIT_LOG_MAX, type GitBranches, type GitDiff, type GitEntry, type GitLog, type GitSide } from './git-view-transport'
import './git-view.css'

export function WorkspaceGitPanel({ workspaceId, controller: api }: { workspaceId: string; controller: WorkspaceGitView }): React.JSX.Element | null {
  const view = useSyncExternalStore(api.subscribe, api.snapshot, api.snapshot)
  const { t, locale } = useI18n()
  const c = gitViewCopy(locale)
  const id = useId()
  if (view.workspaceId !== workspaceId) return null
  const status = view.status
  const repo = hasGitData(status?.state)
  const canInspect = repo && !view.stale
  const blocked = view.issue === 'auth' || view.issue === 'origin' || view.issue === 'csrf' || view.issue === 'not_granted' ||
    view.issue === 'workspace_unavailable' || view.issue === 'unsafe'
  const branch = repo && status ? status.detached ? t('cf.git.detached') : status.branch ?? c.unknownBranch : c.inspect
  const changes = view.tab === 'changes'
  const projection = changes ? status : view.tab === 'branches' ? view.branches : view.log
  const state = changes && projection?.state === 'ready' && hasStatusOmissions(projection.limitations) ? 'partial' : projection?.state
  const limitations = gitLimitationLabels(c, [...(projection?.limitations ?? []), ...(changes ? view.diff?.limitations ?? [] : [])])
  const message = view.issue ? c.issues[view.issue] : view.pending ? c.loading : state && state !== 'ready' ? c[state] : undefined
  const sideLabel = (side: GitSide): string => side === 'staged' ? t('git.staged') : c.worktree
  return <>
    <GitBranchPill className="wb-git__toggle" label={branch} title={c.inspect} aria-label={c.inspect} aria-expanded={view.open}
      aria-controls={view.open ? id : undefined} mergeLabel={repo && status?.mergeInProgress ? t('cf.git.merging') : undefined}
      busy={view.pending === 'status'} data-testid="workspace-git-toggle" data-workspace-git="" onClick={(event) => {
        if (event.nativeEvent.isTrusted) void (view.open ? api.dismiss() : api.open())
      }} />
    {view.open && <section className="cf-ctx wb-git" id={id} aria-labelledby={`${id}-title`} data-testid="workspace-git-panel" data-workspace-git="">
      <header className="wb-git__bar">
        <h3 id={`${id}-title`}>{c.readOnly}</h3>
        <button className="cf-ctx__item" type="button" data-testid="workspace-git-refresh" disabled={view.pending === 'status' || blocked}
          onClick={(event) => { if (event.nativeEvent.isTrusted) void api.refresh() }}><RefreshCw size={14} aria-hidden="true" />{t('cf.git.refresh')}</button>
      </header>
      <p className="wb-git__muted">{c.scope}</p>
      {repo && status?.unborn && <p className="wb-git__muted">{c.unborn}</p>}
      {repo && <div className="wb-git__bar wb-git__tabs">
        <button className="cf-ctx__item" type="button" aria-pressed={changes} disabled={!canInspect}
          onClick={() => api.changes()}><FileDiff size={14} aria-hidden="true" />{t('git.changes')}</button>
        <button className="cf-ctx__item" type="button" aria-pressed={view.tab === 'branches'} disabled={!canInspect || view.pending === 'branches'}
          data-testid="workspace-git-branches" onClick={(event) => { if (event.nativeEvent.isTrusted) void api.branches() }}>
          <GitBranch size={14} aria-hidden="true" />{t('cf.git.branches')}</button>
        <button className="cf-ctx__item" type="button" aria-pressed={view.tab === 'history'} disabled={!canInspect || view.pending === 'log'}
          data-testid="workspace-git-history" onClick={(event) => { if (event.nativeEvent.isTrusted) void api.history() }}>
          <GitCommitHorizontal size={14} aria-hidden="true" />{t('git.history')}</button>
      </div>}
      <div data-testid="workspace-git-status" data-status={view.issue ?? (view.pending ? 'loading' : state)}>
        {message && <p role={view.issue ? 'alert' : 'status'} className={view.issue ? 'wb-git__alert' : 'wb-git__muted'}>{message}</p>}
        {changes && repo && status?.entries.length === 0 && <p className="wb-git__muted">{state === 'ready' ? c.clean : c.partialEmpty}</p>}
      </div>
      {limitations.map((text) => <p key={text} className="wb-git__muted">{text}</p>)}
      {changes && repo && status && status.entries.length > 0 && <ul className="wb-git__rows">
        {status.entries.map((entry) => <GitChangeRow key={entry.entryId} entry={entry} selected={view.selection}
          available={canInspect && !!status.viewId} sideLabel={sideLabel} conflict={c.conflict} noDiff={c.noDiff} onDiff={(side) => void api.diff(entry.entryId, side)} />)}
      </ul>}
      {view.branches && hasGitData(view.branches.state) && <Branches data={view.branches} />}
      {view.log && hasGitData(view.log.state) && <History data={view.log} limit={view.limit} loading={view.pending === 'log'} more={() => void api.history(true)} />}
      {view.diff && <Diff data={view.diff} sideLabel={sideLabel(view.diff.side)} />}
    </section>}
  </>
}

function GitChangeRow({ entry, available, selected, sideLabel, conflict, noDiff, onDiff }: {
  entry: GitEntry; available: boolean; selected?: { entryId: string; side: GitSide }; sideLabel: (side: GitSide) => string
  conflict: string; noDiff: string; onDiff: (side: GitSide) => void
}): React.JSX.Element {
  const primary = entry.diffSides.includes('worktree') ? 'worktree' : entry.diffSides[0]
  return <li className="wb-git__row" data-rel={entry.rel}>
    <button className="cf-ctx__item wb-git__path" type="button" title={primary ? entry.rel : noDiff}
      data-testid={`workspace-git-entry-${entry.entryId}`} disabled={!available || !primary}
      aria-current={selected?.entryId === entry.entryId || undefined}
      onClick={(event) => { if (primary && event.nativeEvent.isTrusted) onDiff(primary) }}>
      <FileDiff size={14} aria-hidden="true" /><bdi>{entry.rel}</bdi>
    </button>
    {entry.conflicted && <span className="wb-git__flag">{conflict}</span>}
    {(['staged', 'worktree'] as const).map((side) => {
      const code = entry[side]
      if (code === null && !entry.diffSides.includes(side)) return null
      const label = `${sideLabel(side)}${code ? ` · ${code}` : ''}`
      return entry.diffSides.includes(side) ? <button key={side} className="cf-ctx__item wb-git__side" type="button"
        disabled={!available} aria-pressed={selected?.entryId === entry.entryId && selected.side === side}
        data-testid={`workspace-git-diff-${entry.entryId}-${side}`} onClick={(event) => { if (event.nativeEvent.isTrusted) onDiff(side) }}>{label}</button>
        : <span key={side} className="wb-git__muted" title={noDiff}>{label}</span>
    })}
  </li>
}

function Branches({ data }: { data: GitBranches }): React.JSX.Element {
  const { t, locale } = useI18n()
  const c = gitViewCopy(locale)
  if (!data.branches.length) return <p className="wb-git__muted">{c.noBranches}</p>
  return <div className="wb-git__results" data-testid="workspace-git-branch-list">
    {([false, true] as const).map((remote) => {
      const group = data.branches.filter((branch) => (branch.remote !== null) === remote)
      return !!group.length && <section key={String(remote)}>
        <h4 className="cf-ctx__section">{remote ? `${t('cf.git.remoteBranches')} · ${c.cachedRemotes}` : t('cf.git.localBranches')}</h4>
        <ul className="wb-git__rows">{group.map((branch, index) => <li className="wb-git__result" key={`${branch.name}:${index}`} aria-current={branch.current || undefined}
          title={branch.current ? t('cf.git.currentBranch') : undefined}>
          <span className="wb-git__branch-check">{branch.current && <Check size={14} aria-hidden="true" />}</span><bdi>{branch.name}</bdi>
        </li>)}</ul>
      </section>
    })}
  </div>
}

function History({ data, limit, loading, more }: { data: GitLog; limit: number; loading: boolean; more: () => void }): React.JSX.Element {
  const { locale } = useI18n()
  const c = gitViewCopy(locale)
  const format = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' })
  return <div className="wb-git__results" data-testid="workspace-git-commit-list">
    {data.commits.length > 0 ? <ol className="wb-git__rows">{data.commits.map((commit) => {
      const date = new Date(commit.timestamp * 1000)
      return <li className="wb-git__result wb-git__commit" key={commit.oid}>
        <GitCommitHorizontal size={14} aria-hidden="true" /><code title={commit.oid}>{commit.short}</code>
        <bdi className="wb-git__subject">{commit.subject}</bdi>
        <span className="wb-git__muted">{commit.author && <><bdi>{commit.author}</bdi>{' · '}</>}
          <time dateTime={date.toISOString()}>{format.format(date)}</time></span>
      </li>
    })}</ol> : <p className="wb-git__muted">{c.noCommits}</p>}
    {data.more && (limit < GIT_LOG_MAX ? <button className="cf-ctx__item" type="button" data-testid="workspace-git-load-more" disabled={loading}
      onClick={(event) => { if (event.nativeEvent.isTrusted) more() }}>{c.older}</button> : <p className="wb-git__muted">{c.historyLimit}</p>)}
  </div>
}

function Diff({ data, sideLabel }: { data: GitDiff; sideLabel: string }): React.JSX.Element {
  const { locale, t } = useI18n()
  const c = gitViewCopy(locale)
  const notice = data.state === 'binary' ? t('git.binary') : data.state === 'too_large' ? t('git.tooLarge') :
    data.state === 'unavailable' ? c.noDiff : !data.truncated && data.lines.length === 0 ? c.noLines : undefined
  return <section className="wb-git__diff" aria-label={t('git.diff')} data-testid="workspace-git-diff" data-state={data.state} data-side={data.side}>
    <h4>{t('git.diff')} · <bdi>{data.rel}</bdi> · {sideLabel}</h4>
    {notice && <p className="wb-git__muted">{notice}</p>}
    {data.truncated && <p className="wb-git__alert" role="status">{c.truncated}</p>}
    {data.state === 'ready' && data.lines.length > 0 && <div className="diffview" tabIndex={0} aria-label={t('git.diff')}>
      {data.lines.map((line, index) => <div key={index} className={`diffview__line ${line.type}`}>
        <span className="diffview__no">{line.oldNo}</span><span className="diffview__no">{line.newNo}</span>
        <span className="diffview__sign">{line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '}</span>
        <span className="diffview__text" dir="ltr">{line.text}</span>
      </div>)}
    </div>}
  </section>
}
