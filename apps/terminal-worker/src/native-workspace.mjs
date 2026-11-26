import {
  chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdtempSync, openSync,
  realpathSync, rmdirSync, statfsSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { SOURCE_NAME } from './viewer-text.mjs';

const ROOT = '/dev/shm';
const PREFIX = 'deva-terminal-viewer-';
const TMPFS_MAGIC = 0x01021994;
const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const anchor = (fd) => `/proc/self/fd/${fd}`;
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const lstat = (path) => lstatSync(path, { bigint: true, throwIfNoEntry: false });
const fstat = (fd) => fstatSync(fd, { bigint: true });

function privateDir(stat, root, uid) {
  return stat?.isDirectory() && stat.dev === root.dev && stat.uid === uid &&
    (stat.mode & 0o7077n) === 0n;
}

function privateSource(stat, dir, uid) {
  return stat?.isFile() && stat.dev === dir.dev && stat.uid === uid &&
    (stat.mode & 0o7177n) === 0n && stat.nlink === 1n;
}

// A single fixed file inside a fresh directory on a verified tmpfs. Operations
// are anchored by open dirfds; named entries and their exact inodes must also
// match before any unlink/rmdir. Never recursively remove host content.
export class NativeWorkspace {
  prepare(text) {
    if (process.platform !== 'linux' || statfsSync(ROOT).type !== TMPFS_MAGIC) throw new Error();
    this.uid = BigInt(process.getuid());
    this.rootFd = openSync(ROOT, DIR_FLAGS);
    this.rootAnchor = anchor(this.rootFd);
    this.root = fstat(this.rootFd);
    this.verifyRoot();

    const made = mkdtempSync(join(this.rootAnchor, PREFIX));
    this.dirEntry = join(this.rootAnchor, basename(made));
    this.cwd = join(ROOT, basename(made));
    this.dir = lstat(this.dirEntry);
    if (!privateDir(this.dir, this.root, this.uid) || this.dir.ino === this.root.ino) throw new Error();
    this.verify();
    if ((this.dir.mode & 0o7777n) !== 0o700n) chmodSync(this.dirEntry, 0o700);
    this.dirFd = openSync(this.dirEntry, DIR_FLAGS);
    if ((fstat(this.dirFd).mode & 0o7777n) !== 0o700n) throw new Error();
    this.dirAnchor = anchor(this.dirFd);
    this.verify();

    this.sourceEntry = join(this.dirAnchor, SOURCE_NAME);
    const fd = openSync(this.sourceEntry,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      this.source = fstat(fd);
      fchmodSync(fd, 0o600);
      writeFileSync(fd, text, 'utf8');
      const ready = fstat(fd);
      if (!privateSource(ready, this.dir, this.uid) || !same(this.source, ready) ||
          (ready.mode & 0o7777n) !== 0o600n) throw new Error();
      this.verifySource();
    } finally {
      closeSync(fd);
    }
    return this.cwd;
  }

  verifyRoot() {
    const current = lstat(ROOT);
    if (!current?.isDirectory() || !same(current, this.root) ||
        realpathSync(this.rootAnchor) !== ROOT || statfsSync(this.rootAnchor).type !== TMPFS_MAGIC ||
        (current.mode & 0o7777n) !== 0o1777n || current.uid !== 0n) throw new Error();
  }

  verify() {
    this.verifyRoot();
    const current = lstat(this.dirEntry);
    if (!privateDir(current, this.root, this.uid) || !same(current, this.dir) ||
        realpathSync(this.dirEntry) !== this.cwd || (this.dirFd !== undefined &&
        (!same(fstat(this.dirFd), this.dir) || realpathSync(this.dirAnchor) !== this.cwd))) throw new Error();
  }

  verifySource() {
    this.verify();
    const current = lstat(this.sourceEntry);
    if (!privateSource(current, this.dir, this.uid) || !same(current, this.source)) throw new Error();
  }

  discardSource() {
    this.verifySource();
    unlinkSync(this.sourceEntry);
    this.source = undefined;
  }

  close() {
    try {
      if (this.source !== undefined) this.discardSource();
      if (this.dir !== undefined) {
        this.verify();
        rmdirSync(this.dirEntry);
      }
    } finally {
      try {
        if (this.dirFd !== undefined) closeSync(this.dirFd);
      } finally {
        if (this.rootFd !== undefined) closeSync(this.rootFd);
      }
    }
  }
}
