const messages = Object.freeze({
  git_stale: 'Git view changed; reload and try again',
  git_limit: 'Git view exceeds its read limit',
  git_corrupt: 'Git metadata or object is malformed',
  git_object_unavailable: 'Git object is unavailable locally',
  git_unsafe: 'Git view path is unsafe or inaccessible',
  unsupported_git_layout: 'Git repository layout is unsupported',
})

export function gitError(code) {
  return Object.assign(new Error(messages[code] ?? 'Git view failed'), { code })
}
