import { chmodSync, closeSync, fstatSync, linkSync, mkdtempSync, openSync, rmdirSync, unlinkSync } from 'node:fs';
import { assertDirectory, BIG, checkSocket, DIR_FLAGS, fdPath, lookup, rejected, sameNode } from './socket-path.mjs';

function removeSocket(scope, expected) {
  // Only a process with the effective UID could race these checks. Leave a
  // changed entry alone, including symlinks and another worker's socket.
  if (!expected) return;
  const before = checkSocket(lookup(scope.socketPath), scope.uid);
  if (!sameNode(expected, before)) return;
  scope.verifyPinned();
  if (!sameNode(before, checkSocket(lookup(scope.socketPath), scope.uid))) return;
  unlinkSync(scope.socketPath);
  scope.verifyPinned();
  if (lookup(scope.socketPath)) throw rejected();
}

export function prepareSocketPublish(scope) {
  scope.verify();
  if (lookup(scope.socketPath)) throw rejected();
  // Node's Unix server unlinks its bind path on close. Bind inside a fresh
  // private staging directory and publish by an atomic, no-overwrite link.
  // Retire the staging path before admission; Node can then never unlink the
  // public path or a replacement placed there by another worker.
  const stage = mkdtempSync(`${scope.root}/.viewer-`);
  const stageIdentity = lookup(stage);
  let fd;
  let bound;
  let published;
  try {
    assertDirectory(stageIdentity, scope.uid, true);
    fd = openSync(stage, DIR_FLAGS);
    if (!sameNode(stageIdentity, fstatSync(fd, BIG))) throw rejected();
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (sameNode(stageIdentity, lookup(stage))) rmdirSync(stage);
    throw error;
  }
  const bindPath = `${fdPath(fd)}/viewer.sock`;
  function retire() {
    const actual = lookup(bindPath);
    if (actual) {
      if (!bound || !sameNode(bound, actual) || !actual.isSocket() || actual.uid !== scope.uid) throw rejected();
      unlinkSync(bindPath);
      if (lookup(bindPath)) throw rejected();
    }
    const current = lookup(stage);
    if (current) {
      if (!sameNode(stageIdentity, current)) throw rejected();
      rmdirSync(stage);
      if (lookup(stage)) throw rejected();
    }
  }
  return {
    bindPath,
    publish() {
      scope.verify();
      bound = lookup(bindPath);
      if (!bound?.isSocket() || bound.uid !== scope.uid || bound.nlink !== 1n) throw rejected();
      chmodSync(bindPath, 0o600);
      if (!sameNode(bound, checkSocket(lookup(bindPath), scope.uid))) throw rejected();
      linkSync(bindPath, scope.socketPath); // EEXIST: preserve live and stale entries.
      published = bound;
      if (!sameNode(published, checkSocket(lookup(scope.socketPath), scope.uid, 2n))) throw rejected();
      retire();
      if (!sameNode(published, scope.inspect())) throw rejected();
      return published;
    },
    close() {
      try {
        // The listening handle has already closed, so its private bind path is gone.
        try { retire(); } catch { /* Preserve entries with unexpected identities. */ }
        try { removeSocket(scope, published); } catch { /* Preserve a changed entry. */ }
      } finally {
        closeSync(fd);
      }
    },
  };
}
