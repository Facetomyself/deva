import { constants, lstatSync, rmdirSync, unlinkSync } from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, open, realpath } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const SOCKET_NAME = 'workbench-control.sock';
const SOCKET_BYTES = 107; // Linux sockaddr_un.sun_path, less its terminator.
const MAX_FRAME_BYTES = 512;
const IO_TIMEOUT_MS = 1_500;
const MAX_CONNECTIONS = 16;
const activePaths = new Set();

export class ControlError extends Error {
  constructor() {
    super('Local workbench control failed');
    this.name = 'ControlError';
    this.code = 'CONTROL_FAILED';
  }
}

function location(runDir) {
  if (process.platform !== 'linux' || typeof runDir !== 'string' || !isAbsolute(runDir) || runDir.includes('\0')) {
    throw new ControlError();
  }
  const directory = resolve(runDir);
  const path = join(directory, SOCKET_NAME);
  if (Buffer.byteLength(path) > SOCKET_BYTES) throw new ControlError();
  return { directory, path };
}

function ownedMode(info, mode) {
  return info.uid === BigInt(process.geteuid()) && (info.mode & 0o7777n) === mode;
}

function privateSocket(info) {
  return info.isSocket() && ownedMode(info, 0o600n);
}

async function checkRunDir(directory, create) {
  // Refuse symlinks in the directory chain, including on initial creation.
  if (await realpath(dirname(directory)) !== dirname(directory)) throw new ControlError();
  if (create) {
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  const info = await lstat(directory, { bigint: true });
  if (!info.isDirectory() || !ownedMode(info, 0o700n) || await realpath(directory) !== directory) {
    throw new ControlError();
  }
}

function optionalStat(path) {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function sameInode(info, expected) {
  return info && info.dev === expected.dev && info.ino === expected.ino;
}

function removeSocket(path, expected) {
  const current = optionalStat(path);
  if (sameInode(current, expected) && current.isSocket()) {
    unlinkSync(path);
    return true;
  }
  return false;
}

function removeStage(path, expected) {
  const current = optionalStat(path);
  if (sameInode(current, expected) && current.isDirectory()) rmdirSync(path);
}

function probeStale(path) {
  return new Promise((resolveProbe) => {
    const socket = createConnection({ path });
    const timer = setTimeout(() => finish(false), IO_TIMEOUT_MS);
    function finish(stale) {
      clearTimeout(timer);
      socket.destroy();
      resolveProbe(stale);
    }
    socket.once('connect', () => finish(false));
    socket.once('close', () => finish(false));
    socket.once('error', (error) => finish(error.code === 'ECONNREFUSED'));
  });
}

function readFrame(socket) {
  return new Promise((resolveFrame) => {
    const chunks = [];
    let size = 0;
    socket.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_FRAME_BYTES) {
        socket.pause();
        resolveFrame(null);
      } else {
        chunks.push(chunk);
      }
    });
    socket.once('error', () => resolveFrame(null));
    socket.once('close', () => resolveFrame(null));
    socket.once('end', () => {
      if (size === 0 || size > MAX_FRAME_BYTES) return resolveFrame(null);
      const bytes = Buffer.concat(chunks, size);
      if (bytes.indexOf(0x0a) !== bytes.length - 1) return resolveFrame(null);
      try {
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, -1));
        const value = JSON.parse(text);
        resolveFrame(JSON.stringify(value) === text ? value : null);
      } catch {
        resolveFrame(null);
      }
    });
  });
}

function frame(value) {
  return `${JSON.stringify(value)}\n`;
}

function keys(value, count) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === count;
}

function supported(op) {
  return op === 'claim' || op === 'status';
}

function validResult(op, value) {
  if (op === 'status') return keys(value, 1) && typeof value.claimed === 'boolean';
  return keys(value, 3) && typeof value.credential === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value.credential) &&
    Buffer.from(value.credential, 'base64url').toString('base64url') === value.credential &&
    Number.isSafeInteger(value.expiresAt) && value.expiresAt > 0 && Number.isSafeInteger(value.ttlMs) && value.ttlMs > 0;
}

async function answer(socket, auth) {
  const request = await readFrame(socket);
  if (socket.destroyed) return;
  let response = { ok: false };
  try {
    if (keys(request, 1) && supported(request.op)) {
      let result;
      if (request.op === 'status') {
        result = { claimed: auth.isClaimed() };
      } else {
        const { credential, expiresAt, ttlMs } = await auth.issueClaim();
        result = { credential, expiresAt, ttlMs };
      }
      if (validResult(request.op, result)) response = { ok: true, result };
    }
  } catch {
    // The protocol never carries filesystem details, auth errors, or caller input.
  }
  if (!socket.destroyed) socket.end(frame(response));
}

function listen(server, path) {
  return new Promise((resolveListen, reject) => {
    function error(reason) {
      server.off('listening', ready);
      reject(reason);
    }
    function ready() {
      server.off('error', error);
      resolveListen();
    }
    server.once('error', error);
    server.once('listening', ready);
    server.listen({ path, backlog: MAX_CONNECTIONS });
  });
}

/** The caller holds the volume's exclusive writer lock until after close(). */
export async function startControl({ runDir, auth } = {}) {
  const { directory, path } = location(runDir);
  if (activePaths.has(path) || typeof auth?.isClaimed !== 'function' || typeof auth?.issueClaim !== 'function') {
    throw new ControlError();
  }
  activePaths.add(path);
  const clients = new Set();
  let server;
  let stage;
  let stageInfo;
  let handle;
  let bindPath;
  let bound;
  let published;
  let closing;

  async function shutdown() {
    try {
      if (published) removeSocket(path, published);
    } finally {
      try {
        for (const socket of clients) socket.destroy();
        if (server?.listening) await new Promise((resolveClose) => server.close(resolveClose));
      } finally {
        try {
          if (bound) removeSocket(bindPath, bound);
          if (stage && stageInfo) removeStage(stage, stageInfo);
        } finally {
          try {
            await handle?.close();
          } finally {
            activePaths.delete(path);
          }
        }
      }
    }
  }

  try {
    await checkRunDir(directory, true);
    const previous = optionalStat(path);
    if (previous && (!privateSocket(previous) || !await probeStale(path) || !removeSocket(path, previous))) {
      throw new ControlError();
    }
    stage = await mkdtemp(join(directory, '.control-'));
    stageInfo = await lstat(stage, { bigint: true });
    if (!stageInfo.isDirectory() || !ownedMode(stageInfo, 0o700n)) throw new ControlError();
    handle = await open(stage, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    if (!sameInode(await handle.stat({ bigint: true }), stageInfo)) throw new ControlError();
    // libuv unlinks the original bind path on close. Keep that path relative to a
    // pinned directory inode and publish a hard link; libuv never owns the public path.
    bindPath = `/proc/self/fd/${handle.fd}/s`;
    server = createServer({ allowHalfOpen: true }, (socket) => {
      if (closing || clients.size >= MAX_CONNECTIONS) {
        socket.destroy();
        return;
      }
      clients.add(socket);
      const timer = setTimeout(() => socket.destroy(), IO_TIMEOUT_MS);
      socket.once('close', () => {
        clearTimeout(timer);
        clients.delete(socket);
      });
      void answer(socket, auth).catch(() => socket.destroy());
    });
    server.on('error', () => {});
    await listen(server, bindPath);
    bound = await lstat(bindPath, { bigint: true });
    if (!bound.isSocket() || bound.uid !== BigInt(process.geteuid())) throw new ControlError();
    await chmod(bindPath, 0o600);
    if (!privateSocket(await lstat(bindPath, { bigint: true }))) throw new ControlError();
    await link(bindPath, path); // Exclusive publication: no replacement of an existing inode.
    published = bound;
    if (!removeSocket(bindPath, bound)) throw new ControlError();
    removeStage(stage, stageInfo);
    stage = null;
    return Object.freeze({
      path,
      close() {
        return closing ??= shutdown().catch(() => { throw new ControlError(); });
      },
    });
  } catch {
    await shutdown().catch(() => {});
    throw new ControlError();
  }
}

export async function requestControl({ runDir, op } = {}) {
  const { directory, path } = location(runDir);
  if (!supported(op)) throw new ControlError();
  try {
    await checkRunDir(directory, false);
    const info = await lstat(path, { bigint: true });
    if (!privateSocket(info)) throw new ControlError();
    const socket = createConnection({ path, allowHalfOpen: true });
    const timer = setTimeout(() => socket.destroy(), IO_TIMEOUT_MS);
    try {
      const response = readFrame(socket);
      socket.once('connect', () => {
        try {
          const current = optionalStat(path);
          if (!sameInode(current, info) || !privateSocket(current)) socket.destroy();
          else socket.end(frame({ op }));
        } catch {
          socket.destroy();
        }
      });
      const value = await response;
      if (!keys(value, 2) || value.ok !== true || !validResult(op, value.result)) throw new ControlError();
      return value.result;
    } finally {
      clearTimeout(timer);
      socket.destroy();
    }
  } catch {
    throw new ControlError();
  }
}
