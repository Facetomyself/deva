import { spawnSync } from 'node:child_process'
import { readStateConflict, readStateReadOnly, readStateUnsupported } from './read-mark-errors.mjs'

const HELPER_TIMEOUT_MS = 1000
const getXattrListSize = { x64: 196, arm64: 13 }[process.arch]

function run(program, args, fds) {
  return spawnSync(program, args, {
    stdio: ['ignore', 'ignore', 'ignore', ...fds], env: {}, timeout: HELPER_TIMEOUT_MS, killSignal: 'SIGKILL'
  })
}

export function lockReadState(fd) {
  // flock operates on the inherited open file description, not the child process's lifetime.
  // Lock the directory itself only for writes: no stale marker or extra path.
  const res = run('/usr/bin/flock', ['-n', '-x', '-E', '73', '3'], [fd])
  if (res.status === 73) throw readStateConflict()
  if (res.status !== 0 || res.error) throw readStateUnsupported()
}

// Node fs has no flistxattr. Debian's Essential perl-base (including bookworm-slim) supplies
// a fixed syscall shim; it probes only inherited descriptors, not a file path or a shell.
// POSIX ACLs, capabilities, labels and other *visible* xattrs are unsupported. The storage
// contract is a conventional local Unix volume without privileged/hidden metadata; Linux
// can hide trusted.* from unprivileged owners. Fail closed if the helper/probe is unavailable.
const probe = 'my $n = shift; for my $fd (3..(2+shift)) { exit 73 if syscall($n,$fd,0,0) != 0 } exit 0;'
export function assertPlainMetadata(...fds) {
  if (process.platform !== 'linux' || getXattrListSize === undefined) throw readStateReadOnly()
  const res = run('/usr/bin/perl', ['-e', probe, String(getXattrListSize), String(fds.length)], fds)
  if (res.status !== 0 || res.error) throw readStateReadOnly()
}
