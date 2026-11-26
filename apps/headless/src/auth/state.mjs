import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

const UNCLAIMED = Object.freeze({ version: 1, state: 'unclaimed' });
const MAX_STATE_BYTES = 1024;
const stateLocks = new Map();

export class AuthStateError extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.name = 'AuthStateError';
    this.code = code;
  }
}

function corrupt(message) {
  return new AuthStateError('AUTH_STATE_CORRUPT', message);
}

function stateError(error) {
  if (error instanceof AuthStateError) return error;
  if (['EACCES', 'EPERM', 'EROFS'].includes(error.code)) {
    return new AuthStateError('AUTH_STATE_PERMISSION', 'Web auth state access denied', error);
  }
  return new AuthStateError('AUTH_STATE_IO', 'Web auth state I/O failed', error);
}

export function decodeFixed(value, size) {
  if (typeof value !== 'string' || value.length !== Math.ceil(size * 4 / 3) ||
      !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === size && bytes.toString('base64url') === value ? bytes : null;
}

export const PASSWORD_SCHEME = 'scrypt-n131072-r8-p1';
export const SALT_BYTES = 32;
export const VERIFIER_BYTES = 64;

function parseState(bytes) {
  let state;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    state = JSON.parse(text);
  } catch {
    throw corrupt('Invalid web auth state encoding');
  }
  // Our versioned writer emits canonical JSON; reject ambiguity such as duplicate state keys.
  if (text !== `${JSON.stringify(state)}\n`) throw corrupt('Invalid web auth state serialization');
  if (state === null || typeof state !== 'object' || Array.isArray(state) || state.version !== 1) {
    throw corrupt('Unknown web auth state format');
  }
  if (state.state === 'unclaimed' && Object.keys(state).length === 2) return null;
  if (state.state !== 'claimed' || Object.keys(state).length !== 5 || state.scheme !== PASSWORD_SCHEME) {
    throw corrupt('Invalid web auth owner state');
  }
  const salt = decodeFixed(state.salt, SALT_BYTES);
  const verifier = decodeFixed(state.verifier, VERIFIER_BYTES);
  if (!salt || !verifier) throw corrupt('Invalid web auth password verifier');
  return { salt, verifier };
}

function assertPrivate(info, required) {
  if ((info.mode & 0o077) !== 0 || (info.mode & required) !== required ||
      (typeof process.geteuid === 'function' && info.uid !== process.geteuid())) {
    throw new AuthStateError('AUTH_STATE_PERMISSION', 'Web auth state must be private to the process user');
  }
}

async function privateDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory()) throw corrupt('Expected a real web auth state directory');
  assertPrivate(info, 0o700);
}

async function readOwner(path) {
  let file;
  try {
    // A bad state path must not follow a symlink or block on a FIFO.
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (['ENOENT', 'ELOOP', 'ENOTDIR'].includes(error.code)) {
      throw corrupt('Web auth owner state is missing or is not a regular file');
    }
    throw error;
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1) throw corrupt('Web auth owner state is not a private regular file');
    assertPrivate(info, 0o400);
    if (info.size > MAX_STATE_BYTES) throw corrupt('Web auth owner state is oversized');
    const bytes = Buffer.alloc(MAX_STATE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_STATE_BYTES) throw corrupt('Web auth owner state is oversized');
    return parseState(bytes.subarray(0, length));
  } finally {
    await file.close();
  }
}

async function syncDirectory(path) {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function writeState(directory, path, state, eligible = () => true) {
  const temporary = join(directory, `.owner-${randomBytes(16).toString('hex')}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  let renamed = false;
  try {
    try {
      await file.chmod(0o600);
      await file.writeFile(`${JSON.stringify(state)}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    if (!eligible()) return false;
    await rename(temporary, path);
    renamed = true;
    await syncDirectory(directory);
    return true;
  } finally {
    if (!renamed) await unlink(temporary);
  }
}

// Serialize initialization and the claim commit even across service handles in this process.
async function locked(key, run) {
  const previous = stateLocks.get(key);
  let unlock;
  const pending = new Promise((done) => { unlock = done; });
  stateLocks.set(key, pending);
  try {
    await previous;
    return await run();
  } catch (error) {
    throw stateError(error);
  } finally {
    unlock();
    if (stateLocks.get(key) === pending) stateLocks.delete(key);
  }
}

export async function openAuthState(dataDir) {
  if (typeof dataDir !== 'string' || dataDir.length === 0 || dataDir.includes('\0')) {
    throw new TypeError('dataDir must be a private directory path');
  }
  let root;
  try {
    const path = resolve(dataDir);
    const firstCreated = await mkdir(path, { recursive: true, mode: 0o700 });
    await privateDirectory(path);
    root = await realpath(path);
    if (firstCreated) {
      // The later auth-directory sync persists its entry in root; persist newly created
      // ancestors as well so a successful claim is durable when dataDir was initially absent.
      const lastParent = dirname(await realpath(firstCreated));
      for (let directory = dirname(root); ; directory = dirname(directory)) {
        await syncDirectory(directory);
        if (directory === lastParent || directory === dirname(directory)) break;
      }
    }
  } catch (error) {
    throw stateError(error);
  }
  const directory = join(root, 'web-workbench-auth');
  const path = join(directory, 'owner.json');
  const owner = await locked(directory, async () => {
    let isNew = false;
    try {
      await mkdir(directory, { mode: 0o700 });
      isNew = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    await privateDirectory(directory);
    if (!isNew) return readOwner(path);
    await syncDirectory(root);
    await writeState(directory, path, UNCLAIMED);
    return null;
  });
  return {
    owner,
    async loadOwner() {
      return locked(directory, async () => {
        await privateDirectory(directory);
        return readOwner(path);
      });
    },
    async commitOwner(candidate, eligible) {
      return locked(directory, async () => {
        await privateDirectory(directory);
        const existing = await readOwner(path);
        if (existing || !eligible()) return { committed: false, owner: existing };
        const committed = await writeState(directory, path, {
          version: 1,
          state: 'claimed',
          scheme: PASSWORD_SCHEME,
          salt: candidate.salt.toString('base64url'),
          verifier: candidate.verifier.toString('base64url'),
        }, eligible);
        return { committed, owner: committed ? candidate : null };
      });
    },
  };
}
