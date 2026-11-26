import { constants, lstatSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs';
import { chmod, link, mkdir, mkdtemp, open } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { FRAME_LIMIT, validateInput } from './engine/policy.mjs';

const NAME = 'worker.sock';
const REQUEST_BYTES = 8 * 1024;
const RESPONSE_BYTES = Math.ceil(FRAME_LIMIT / 3) * 4 + 256 * 1024;
const READ_MS = 1_500;
const RESPONSE_MS = 35_000;
const MAX_SOCKETS = 16;
const activePaths = new Set();
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export const workerStates = Object.freeze([
  'ready', 'unconfigured', 'egress-unavailable', 'binary-missing', 'sandbox-startup-failure',
]);
const errorCodes = new Set([
  'CONTROL_FAILED', 'INVALID_REQUEST', 'UNKNOWN_SITE', 'WORKER_UNAVAILABLE', 'SESSION_LIMIT', 'BUSY',
  'TAB_NOT_FOUND', 'CONTROL_REQUIRED', 'ENGINE_FAILURE', 'TIMED_OUT',
]);

export class WorkerControlError extends Error {
  constructor(code = 'CONTROL_FAILED') {
    const safeCode = errorCodes.has(code) ? code : 'CONTROL_FAILED';
    super(safeCode);
    this.name = 'WorkerControlError';
    this.code = safeCode;
  }
}

export const controlFault = (code) => new WorkerControlError(code);
export const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
export const validSiteId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 64 &&
  /^[A-Za-z0-9]/u.test(value) && !/[^A-Za-z0-9_-]/u.test(value);
export const validOpaqueId = (value) => typeof value === 'string' && value.length === 24 && !/[^A-Za-z0-9_-]/u.test(value);

const validSid = (value) => typeof value === 'string' && value.length > 0 && value.length <= 128 &&
  !/[^A-Za-z0-9_.:-]/u.test(value);
const argsByOp = Object.freeze(Object.assign(Object.create(null), {
  status: [], sites: [], open: ['sid', 'siteId'], release: ['sid', 'tabId'], closeTab: ['sid', 'tabId'],
  startPrivacy: ['sid', 'tabId'], endPrivacy: ['sid', 'tabId', 'controlId'], frame: ['sid', 'tabId', 'controlId'],
  input: ['sid', 'tabId', 'controlId', 'action'],
}));

export function validateRequest(value) {
  if (!exactKeys(value, ['op', 'args']) || typeof value.op !== 'string') throw controlFault('INVALID_REQUEST');
  const { op, args } = value;
  const keys = argsByOp[op];
  if (!keys || !exactKeys(args, keys) ||
      (keys.includes('sid') && !validSid(args.sid)) ||
      (keys.includes('siteId') && !validSiteId(args.siteId)) ||
      (keys.includes('tabId') && !validOpaqueId(args.tabId)) ||
      (keys.includes('controlId') && !validOpaqueId(args.controlId))) throw controlFault('INVALID_REQUEST');
  if (op === 'input') {
    try { return { op, args: { sid: args.sid, tabId: args.tabId, controlId: args.controlId, action: validateInput(args.action) } }; }
    catch { throw controlFault('INVALID_REQUEST'); }
  }
  return { op, args: Object.fromEntries(keys.map((key) => [key, args[key]])) };
}

function location(runDir) {
  if (process.platform !== 'linux' || typeof runDir !== 'string' || !isAbsolute(runDir) || runDir.includes('\0')) {
    throw controlFault();
  }
  const directory = resolve(runDir);
  const path = join(directory, NAME);
  if (Buffer.byteLength(path) > 107) throw controlFault();
  return { directory, path };
}

const ownedMode = (info, mode) => info?.uid === BigInt(process.geteuid()) && (info.mode & 0o7777n) === mode;
const privateDir = (info) => ownedMode(info, 0o700n) && info.isDirectory();
const privateSocket = (info) => ownedMode(info, 0o600n) && info.isSocket();
const sameInode = (current, expected) => Boolean(current && expected && current.dev === expected.dev && current.ino === expected.ino);
// Linux filesystems can reuse an inode number immediately after the worker exits.
const stamp = (info) => info.birthtimeNs || info.ctimeNs;
const sameSocket = (current, expected) => sameInode(current, expected) && stamp(current) === stamp(expected);

function optionalStat(path) {
  try { return lstatSync(path, { bigint: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

function checkDirectory(directory, info) {
  const visible = optionalStat(directory);
  return privateDir(visible) && sameInode(visible, info) && realpathSync(directory) === directory;
}

async function pinDirectory(directory, { create = false } = {}) {
  if (realpathSync(dirname(directory)) !== dirname(directory)) throw controlFault();
  if (create) {
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try {
    const info = await handle.stat({ bigint: true });
    if (!privateDir(info) || !checkDirectory(directory, info)) throw controlFault();
    return { handle, info, fdPath: `/proc/self/fd/${handle.fd}` };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function removeIfSame(path, info, directory = false, published = false) {
  if (!info) return;
  const current = optionalStat(path);
  if ((published ? sameSocket(current, info) : sameInode(current, info)) &&
      (directory ? current.isDirectory() : current.isSocket())) {
    if (directory) rmdirSync(path);
    else unlinkSync(path);
  }
}

function receive(socket, maxBytes) {
  return new Promise((resolveFrame) => {
    const chunks = [];
    let size = 0;
    function finish(value) {
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('close', onClose);
      chunks.length = 0;
      resolveFrame(value);
    }
    function onClose() { finish(null); }
    function onData(chunk) {
      size += chunk.length;
      if (size > maxBytes || chunks.length >= 2048) {
        socket.pause();
        finish(null);
      } else chunks.push(chunk);
    }
    function onEnd() {
      const bytes = Buffer.concat(chunks, size);
      if (!size || bytes.indexOf(0x0a) !== size - 1) return finish(null);
      try {
        const text = utf8.decode(bytes.subarray(0, -1));
        const value = JSON.parse(text);
        // Canonical JSON excludes duplicate fields, BOMs, extra lines and hidden trailing data.
        finish(JSON.stringify(value) === text ? value : null);
      } catch { finish(null); }
    }
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('close', onClose);
  });
}

const encode = (value) => `${JSON.stringify(value)}\n`;

function listen(server, path) {
  return new Promise((resolveListen, reject) => {
    function ready() { server.off('error', reject); resolveListen(); }
    server.once('listening', ready);
    server.once('error', reject);
    server.listen({ path, backlog: MAX_SOCKETS });
  });
}

export async function startWorkerControl({ runDir, dispatch }) {
  const { directory, path } = location(runDir);
  if (activePaths.has(path) || typeof dispatch !== 'function') throw controlFault();
  activePaths.add(path);
  const clients = new Set();
  let root, stage, stageInfo, stageFd, bindPath, bound, published, server, closing;

  function intact() {
    if (closing || !published || !checkDirectory(directory, root.info)) return false;
    const current = optionalStat(path);
    return privateSocket(current) && sameSocket(current, published);
  }

  async function shutdown() {
    try {
      if (root) removeIfSame(join(root.fdPath, NAME), published, false, true);
    } finally {
      try {
        for (const socket of clients) socket.destroy();
        if (server?.listening) await new Promise((done) => server.close(done));
      } finally {
        try {
          if (bindPath) removeIfSame(bindPath, bound);
          if (stage) removeIfSame(stage, stageInfo, true);
        } finally {
          await Promise.allSettled([stageFd?.close(), root?.handle.close()]);
          activePaths.delete(path);
        }
      }
    }
  }

  async function answer(socket, signal, setDeadline) {
    const value = await receive(socket, REQUEST_BYTES);
    if (signal.aborted || !intact()) return socket.destroy();
    setDeadline(RESPONSE_MS);
    let response;
    try {
      const { op, args } = validateRequest(value);
      response = { ok: true, result: await dispatch(op, args, signal) };
    } catch (error) {
      response = { ok: false, code: error instanceof WorkerControlError ? error.code : 'ENGINE_FAILURE' };
    }
    if (signal.aborted || !intact()) return socket.destroy();
    const bytes = encode(response);
    if (Buffer.byteLength(bytes) > RESPONSE_BYTES) return socket.destroy();
    socket.end(bytes);
  }

  function accept(socket) {
    socket.on('error', () => socket.destroy());
    try {
      if (clients.size >= MAX_SOCKETS || !intact()) return socket.destroy();
    } catch { return socket.destroy(); }
    const abort = new AbortController();
    clients.add(socket);
    let deadline;
    const setDeadline = (ms) => {
      clearTimeout(deadline);
      deadline = setTimeout(() => socket.destroy(), ms);
    };
    setDeadline(READ_MS);
    socket.once('close', () => {
      clearTimeout(deadline);
      clients.delete(socket);
      abort.abort();
    });
    void answer(socket, abort.signal, setDeadline).catch(() => socket.destroy());
  }

  try {
    root = await pinDirectory(directory, { create: true });
    const rootPath = join(root.fdPath, NAME);
    if (optionalStat(rootPath)) throw controlFault(); // Never remove or take over an existing endpoint, even if stale.
    stage = await mkdtemp(join(root.fdPath, '.worker-'));
    stageInfo = optionalStat(stage);
    if (!privateDir(stageInfo)) throw controlFault();
    stageFd = await open(stage, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    if (!sameInode(await stageFd.stat({ bigint: true }), stageInfo)) throw controlFault();
    // libuv unlinks the original bind path on close. Bind relative to a pinned staging
    // inode, publish exclusively, and remove the staging directory before serving requests.
    bindPath = `/proc/self/fd/${stageFd.fd}/s`;
    server = createServer({ allowHalfOpen: true }, accept);
    server.on('error', () => {});
    await listen(server, bindPath);
    bound = optionalStat(bindPath);
    if (!bound?.isSocket() || bound.uid !== BigInt(process.geteuid())) throw controlFault();
    await chmod(bindPath, 0o600);
    if (!privateSocket(optionalStat(bindPath)) || !checkDirectory(directory, root.info)) throw controlFault();
    await link(bindPath, rootPath);
    const linked = optionalStat(rootPath);
    if (!sameInode(linked, bound)) throw controlFault();
    published = linked;
    removeIfSame(bindPath, bound);
    const current = optionalStat(rootPath);
    if (!sameInode(current, linked)) throw controlFault();
    published = current; // Unlinking the staging name updates ctime on filesystems without birthtime.
    if (!intact()) throw controlFault();
    removeIfSame(stage, stageInfo, true);
    stage = null;
    return Object.freeze({
      path,
      close() { return closing ??= Promise.resolve().then(shutdown).catch(() => { throw controlFault(); }); },
    });
  } catch {
    await shutdown().catch(() => {});
    throw controlFault();
  }
}

/** The first valid socket inode binds this client instance; reopen the client after a worker restart. */
export function createWorkerTransport(runDir) {
  const { directory, path } = location(runDir);
  let identity;
  return async (op, args) => {
    const request = validateRequest({ op, args });
    const payload = encode(request);
    if (Buffer.byteLength(payload) > REQUEST_BYTES) throw controlFault('INVALID_REQUEST');
    let root, socket, timer;
    try {
      root = await pinDirectory(directory);
      const target = join(root.fdPath, NAME);
      const inode = optionalStat(target);
      if (!privateSocket(inode) || (identity && (!sameSocket(inode, identity.inode) || !sameInode(root.info, identity.root)))) {
        throw controlFault();
      }
      identity ??= { inode, root: root.info };
      const intact = () => {
        const info = optionalStat(path);
        return privateSocket(info) && sameSocket(info, inode) && checkDirectory(directory, root.info);
      };
      if (!intact()) throw controlFault();
      socket = createConnection({ path: target, allowHalfOpen: true });
      socket.on('error', () => socket.destroy());
      timer = setTimeout(() => socket.destroy(), RESPONSE_MS + READ_MS);
      const response = receive(socket, RESPONSE_BYTES);
      socket.once('connect', () => {
        try { if (intact()) socket.end(payload); else socket.destroy(); }
        catch { socket.destroy(); }
      });
      const value = await response;
      if (!intact()) throw controlFault();
      if (exactKeys(value, ['ok', 'result']) && value.ok === true) return value.result;
      if (exactKeys(value, ['ok', 'code']) && value.ok === false && errorCodes.has(value.code)) throw controlFault(value.code);
      throw controlFault();
    } catch (error) {
      throw error instanceof WorkerControlError ? error : controlFault();
    } finally {
      clearTimeout(timer);
      socket?.destroy();
      await root?.handle.close();
    }
  };
}
