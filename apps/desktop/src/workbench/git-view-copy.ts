import type { GitIssue } from './git-view-controller'

const en = {
  inspect: 'Git View', readOnly: 'Git · Read-only', unborn: 'No initial commit yet', unknownBranch: 'Branch unknown', worktree: 'Working tree', conflict: 'Conflict',
  scope: 'Ordinary SHA-1 repositories; tracked changes only. History follows first parents. Remote branches come from the local cache; upstream, ahead/behind and live remote state are unknown.',
  not_repo: 'The selected workspace is not a Git repository.', unsupported_layout: 'This repository layout is outside the supported scope.',
  partial: 'Git information is incomplete. Only the available results are shown.', unavailable: 'Git information is unavailable for this workspace.',
  clean: 'No tracked changes.', partialEmpty: 'No tracked changes were available in this incomplete view.', noDiff: 'A text diff is unavailable for this entry.',
  noLines: 'No text lines in this diff.', truncated: 'The diff was truncated.', noBranches: 'No branches to show.',
  cachedRemotes: 'Cached locally', noCommits: 'No commits to show.', older: 'Show more commits', historyLimit: 'More commits exist beyond the display limit.',
  loading: 'Reading Git…', limited: 'Some Git information is outside this view’s scope.',
  limitations: {
    shallow: 'Shallow history ends at the local shallow boundary.', excluded_paths: 'Some paths were excluded from inspection.',
    non_regular_entries: 'Some entries are not regular files.', git_limit: 'Part of the result exceeded an inspection limit.',
    git_object_unavailable: 'Some Git objects are unavailable locally.', unsupported_git_layout: 'Some data uses an unsupported repository layout.',
    excluded_refs: 'Some references were excluded from inspection.', unsafe_worktree: 'Some working tree entries were skipped.'
  },
  issues: {
    auth: 'Your owner session or request verification expired. Sign in again.', origin: 'Open the workbench at its configured address to view Git.',
    csrf: 'Request verification failed. Reload the workbench before trying again.', not_granted: 'Git access is not granted for this workspace.',
    workspace_unavailable: 'The selected workspace is unavailable or no longer authorized.', unsafe: 'This repository or entry is outside the safe read scope.',
    stale: 'This Git view expired or changed. Refresh Git, then select the change again.', busy: 'Git inspection is busy. Try again manually.',
    budget: 'Git inspection reached a resource limit; the requested result is incomplete.', unsupported_layout: 'This repository layout is outside the supported scope.',
    incomplete: 'Git data is incomplete or unreadable. The requested result is unavailable.', unavailable: 'Git inspection is temporarily unavailable.',
    failure: 'Git inspection failed. Try again manually.'
  } satisfies Record<GitIssue, string>
}
const zh: typeof en = {
  inspect: 'Git 查看', readOnly: 'Git · 只读', unborn: '尚无初始提交', unknownBranch: '分支未知', worktree: '工作树', conflict: '冲突',
  scope: '仅查看普通 SHA-1 仓库中已跟踪的更改。提交历史只沿首父遍历。远程分支来自本地缓存；上游、领先／落后和远端实时状态未知。',
  not_repo: '所选工作区并非 Git 仓库。', unsupported_layout: '此仓库布局超出支持范围。',
  partial: 'Git 信息不完整，仅展示已读取的结果。', unavailable: '此工作区的 Git 信息暂不可用。',
  clean: '没有已跟踪的更改。', partialEmpty: '本次读取不完整，未获得已跟踪的更改。', noDiff: '此项没有可显示的文本差异。',
  noLines: '此差异没有文本行。', truncated: '差异已截断。', noBranches: '没有可显示的分支。',
  cachedRemotes: '本地缓存', noCommits: '没有可显示的提交。', older: '显示更多提交', historyLimit: '还有更多提交，已达到显示上限。',
  loading: '正在读取 Git…', limited: '部分 Git 信息超出此视图的范围。',
  limitations: {
    shallow: '浅克隆历史止于本地浅克隆边界。', excluded_paths: '部分路径已排除。', non_regular_entries: '部分条目并非普通文件。',
    git_limit: '部分结果超出读取上限。', git_object_unavailable: '本地缺少部分 Git 对象。', unsupported_git_layout: '部分数据使用超出支持范围的仓库布局。',
    excluded_refs: '部分引用已排除。', unsafe_worktree: '已跳过部分工作树条目。'
  },
  issues: {
    auth: '所有者会话或请求验证已过期，请重新登录。', origin: '请从工作台的已配置地址打开 Git。',
    csrf: '请求验证失败，请重新载入工作台后再试。', not_granted: '此工作区未获 Git 查看授权。',
    workspace_unavailable: '所选工作区已失效或授权已撤销。', unsafe: '此仓库或条目超出安全读取范围。',
    stale: 'Git 视图已过期或发生变化。请刷新 Git，再选择变更。', busy: 'Git 查看正忙，请手动重试。',
    budget: 'Git 查看已达到资源上限，本次结果不完整。', unsupported_layout: '此仓库布局超出支持范围。',
    incomplete: 'Git 数据不完整或读取失败，本次结果暂不可用。', unavailable: 'Git 查看暂不可用。',
    failure: 'Git 读取失败，请手动重试。'
  }
}
export type GitViewCopy = typeof en
export const gitViewCopy = (locale: string): GitViewCopy => locale === 'zh-CN' ? zh : en

const describedInScope = new Set(['tracked_only', 'upstream_unknown', 'first_parent'])
const metadataOnly = new Set(['shallow', 'excluded_refs'])
const explainedByState = new Set(['not_repo', 'unsupported_layout', 'unavailable', 'binary_content', 'no_text_change'])
const budgetCodes = new Set(['status_entry_limit', 'worktree_file_limit', 'worktree_budget', 'branch_limit',
  'diff_byte_limit', 'diff_line_limit', 'diff_computation_limit', 'diff_output_limit'])

/** Omissions of unknown effect must not be presented as a clean tracked view. */
export function hasStatusOmissions(limitations: string[]): boolean {
  return limitations.some((code) => !describedInScope.has(code) && !metadataOnly.has(code))
}
export function gitLimitationLabels(c: GitViewCopy, limitations: string[]): string[] {
  const labels = new Set<string>()
  for (const code of limitations) {
    if (describedInScope.has(code) || explainedByState.has(code)) continue
    const key = budgetCodes.has(code) ? 'git_limit' : code
    labels.add(Object.prototype.hasOwnProperty.call(c.limitations, key) ? c.limitations[key as keyof typeof c.limitations] : c.limited)
  }
  return [...labels]
}
