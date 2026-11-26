import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync,
} from 'node:fs';

// Linux's O_PATH keeps a stable directory descriptor without granting data access.
// Only kernel-owned /proc/self/fd links are followed, never a link in the supplied path.
const O_PATH = 0x200000;
export const DIR_FLAGS = O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW;
export const BIG = { bigint: true };
const NAME = 'viewer.sock';
const accessBits = (stat) => stat.mode & 0o7777n;
export const fdPath = (fd) => `/proc/self/fd/${fd}`;

export function rejected() {
  return new Error('Invalid terminal socket scope');
}

export function sameNode(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

export function lookup(path) {
  try {
    return lstatSync(path, BIG);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function assertDirectory(stat, uid, leaf) {
  if (!stat?.isDirectory()) throw rejected();
  const mode = accessBits(stat);
  if (leaf) {
    if (stat.uid !== uid || mode !== 0o700n) throw rejected();
  } else if ((stat.uid !== uid && stat.uid !== 0n)
    || ((mode & 0o022n) !== 0n && !(stat.uid === 0n && (mode & 0o1000n) !== 0n))) {
    throw rejected();
  }
}

function pathParts(runDir) {
  if (process.platform !== 'linux' || typeof process.geteuid !== 'function' || typeof runDir !== 'string'
    || !runDir.startsWith('/') || runDir.length > 4095 || runDir.includes('\0') || !runDir.isWellFormed()) throw rejected();
  const parts = runDir.slice(1).split('/');
  if (parts.length > 64 || parts.some((part) => !part || part === '.' || part === '..')) throw rejected();
  return parts;
}

function traverse(parts, uid, create) {
  let fd = openSync('/', DIR_FLAGS);
  try {
    assertDirectory(fstatSync(fd, BIG), uid, false);
    for (const [index, part] of parts.entries()) {
      const at = `${fdPath(fd)}/${part}`;
      const leaf = index === parts.length - 1;
      if (leaf && create) {
        try { mkdirSync(at, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      const previous = lookup(at);
      assertDirectory(previous, uid, leaf);
      const next = openSync(at, DIR_FLAGS);
      try {
        const opened = fstatSync(next, BIG);
        assertDirectory(opened, uid, leaf);
        if (!sameNode(previous, opened) || !sameNode(opened, lookup(at))) throw rejected();
      } catch (error) {
        closeSync(next);
        throw error;
      }
      closeSync(fd);
      fd = next;
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function checkSocket(stat, uid, links = 1n) {
  if (!stat?.isSocket() || stat.uid !== uid || accessBits(stat) !== 0o600n || stat.nlink !== links) throw rejected();
  return stat;
}

export function openSocketScope(runDir, { create = false } = {}) {
  const parts = pathParts(runDir);
  const uid = BigInt(process.geteuid());
  const fd = traverse(parts, uid, create);
  const root = fdPath(fd);
  const identity = fstatSync(fd, BIG);
  let closed = false;
  function verify() {
    if (closed) throw rejected();
    const current = traverse(parts, uid, false);
    try {
      if (!sameNode(identity, fstatSync(current, BIG)) || !sameNode(identity, fstatSync(fd, BIG))) throw rejected();
    } finally {
      closeSync(current);
    }
  }
  const socketPath = `${root}/${NAME}`;
  function inspect() {
    verify();
    const before = checkSocket(lookup(socketPath), uid);
    verify();
    const after = checkSocket(lookup(socketPath), uid);
    if (!sameNode(before, after)) throw rejected();
    return after;
  }
  function verifyPinned() {
    if (closed) throw rejected();
    const currentDir = fstatSync(fd, BIG);
    assertDirectory(currentDir, uid, true);
    if (!sameNode(identity, currentDir)) throw rejected();
  }
  return {
    root, uid, socketPath, verify, verifyPinned, inspect,
    close() {
      if (closed) return;
      closed = true;
      closeSync(fd);
    },
  };
}
