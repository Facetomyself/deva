import { createHash } from 'node:crypto';
import { readFileSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeWorkspace } from './native-workspace.mjs';
import {
  countLines, KEY_BYTES, MAX_FRAME_BYTES, MAX_SOURCE_BYTES, MAX_SOURCE_LINES,
  safeRenderedLine, validSize,
} from './viewer-text.mjs';

const require = createRequire(import.meta.url);
const ADDON = '@lydell/node-pty';
const VERSION = '1.2.0-beta.15';
const VIEWER = fileURLToPath(new URL('./viewer.mjs', import.meta.url));
const CHILD_ENV = { TERM: 'dumb', HOME: '/', LANG: 'C.UTF-8', PATH: '/usr/bin:/bin' };
const START_MS = 3_000;
const ACTION_MS = 1_500;
const CLOSE_MS = 2_000;
const KEY_INPUT = Object.fromEntries(Object.entries(KEY_BYTES).map(([key, byte]) => [key, Buffer.from(byte)]));

const messages = {
  terminal_invalid: 'Invalid terminal viewer request.',
  terminal_limit: 'Terminal viewer snapshot exceeds its limits.',
  terminal_busy: 'Terminal viewer action already in progress.',
  terminal_unavailable: 'Terminal viewer unavailable.',
};
const fail = (code = 'terminal_unavailable') => Object.assign(new Error(messages[code]), { code });

function lockedAddon() {
  if (process.platform !== 'linux' || !['arm64', 'x64'].includes(process.arch) ||
      process.getuid?.() === 0 || process.geteuid?.() === 0 || process.getuid?.() !== process.geteuid?.()) throw fail();
  const entry = require.resolve(ADDON);
  const platform = `${ADDON}-linux-${process.arch}`;
  const platformEntry = createRequire(entry).resolve(platform);
  for (const [root, name] of [[dirname(entry), ADDON], [dirname(dirname(platformEntry)), platform]]) {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    if (pkg.name !== name || pkg.version !== VERSION) throw fail();
  }
  const pty = require(entry);
  if (typeof pty.spawn !== 'function' || typeof pty.native?.fork !== 'function') throw fail();
  return pty;
}

function exact(object, ...keys) {
  return object !== null && typeof object === 'object' && Object.keys(object).length === keys.length &&
    keys.every((key) => Object.hasOwn(object, key));
}

function confirmedScreen(frame, action, totalLines) {
  if (!exact(frame, 'cols', 'rows', 'top', 'left', 'totalLines', 'lines')) throw fail();
  const { cols, rows, top, left, lines } = frame;
  if (cols !== action.cols || rows !== action.rows || frame.totalLines !== totalLines ||
      !Number.isInteger(top) || top < 0 || top > Math.max(0, totalLines - rows) ||
      !Number.isInteger(left) || left < 0 || left > MAX_SOURCE_BYTES * 8 - cols ||
      !Array.isArray(lines) || lines.length !== Math.min(totalLines - top, rows) ||
      !lines.every((line) => safeRenderedLine(line, cols)) ||
      (action.kind === 'ready' && (top !== 0 || left !== 0))) throw fail();
  Object.freeze(lines);
  return Object.freeze(frame);
}

function notify(callback, details) {
  try {
    const result = callback?.(details);
    if (result !== undefined) Promise.resolve(result).catch(() => {});
  } catch {
    // An application callback has no control over native teardown or acknowledgements.
  }
}

class NativeSession {
  constructor({ cols, rows, onScreen, onExit, signal }, totalLines, hash) {
    Object.assign(this, { cols, rows, onScreen, onExit, signal, totalLines, hash });
    this.workspace = new NativeWorkspace();
    this.state = 'opening';
    this.buffer = '';
    this.closed = new Promise((resolve) => { this.resolveClosed = resolve; });
    this.abort = () => this.stop('fault');
  }

  async start(addon, text) {
    const cwd = this.workspace.prepare(text);
    this.pty = addon.spawn(process.execPath, ['--no-addons', VIEWER], {
      cols: this.cols, rows: this.rows, name: CHILD_ENV.TERM, cwd, env: CHILD_ENV,
      encoding: 'utf8', handleFlowControl: false,
    });
    const initial = this.begin('ready', this.cols, this.rows, undefined, START_MS);
    this.exitListener = this.pty.onExit((event) => this.exited(event));
    this.dataListener = this.pty.onData((chunk) => this.data(chunk));
    this.ptyError = (error) => {
      // EIO is the normal Linux PTY EOF. The OS exit event, not this stream
      // event, carries the actual termination status.
      if (error.code !== 'EIO' && error.code !== 'EAGAIN') this.stop('fault');
    };
    this.pty.on('error', this.ptyError);
    this.signal?.addEventListener('abort', this.abort, { once: true });
    if (this.signal?.aborted) this.abort();
    await initial;
    if (this.state !== 'ready') throw fail();
    return { screen: this.screen, input: this.input, resize: this.resize, dispose: this.dispose };
  }

  begin(kind, cols, rows, key, timeout = ACTION_MS) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.stop('fault'), timeout);
      this.pending = { kind, cols, rows, key, timer, resolve, reject };
    });
  }

  finish(action, success) {
    if (!action || this.pending !== action) return;
    this.pending = undefined;
    clearTimeout(action.timer);
    if (success) action.resolve();
    else action.reject(fail());
  }

  assertReady() {
    if (this.state !== 'ready') throw fail();
    if (this.pending) throw fail('terminal_busy');
  }

  input = async (key) => {
    if (typeof key !== 'string' || !Object.hasOwn(KEY_INPUT, key)) throw fail('terminal_invalid');
    this.assertReady();
    const wait = this.begin(key === 'quit' ? 'quit' : 'key', this.cols, this.rows, key);
    try {
      // This locked library exposes the nonblocking master fd. Write exactly one
      // byte, with no library write queue or pending I/O racing master teardown.
      if (writeSync(this.pty.fd, KEY_INPUT[key]) !== 1) this.stop('fault');
    } catch {
      this.stop('fault');
    }
    await wait;
  };

  resize = async (cols, rows) => {
    if (!validSize(cols, rows)) throw fail('terminal_invalid');
    this.assertReady();
    if (cols === this.cols && rows === this.rows) return;
    const wait = this.begin('resize', cols, rows);
    try {
      this.pty.resize(cols, rows);
    } catch {
      this.stop('fault');
    }
    await wait;
  };

  data(chunk) {
    if (this.state === 'closing' || this.state === 'exited') return;
    try {
      if (typeof chunk !== 'string' || this.buffer.length + chunk.length > MAX_FRAME_BYTES ||
          !this.pending) throw fail();
      this.buffer += chunk;
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      // The child produces exactly one typed line per request. A CR just before
      // its newline is permitted for PTY drivers that apply output conversion.
      if (newline !== this.buffer.length - 1 || Buffer.byteLength(this.buffer) > MAX_FRAME_BYTES) throw fail();
      const line = this.buffer.slice(0, this.buffer[newline - 1] === '\r' ? newline - 1 : newline);
      this.buffer = '';
      this.frame(JSON.parse(line));
    } catch {
      this.stop('fault');
    }
  }

  frame(frame) {
    const action = this.pending;
    if (frame?.type !== action.kind) throw fail();
    if (action.kind === 'quit') {
      if (!exact(frame, 'type') || action.ack) throw fail();
      action.ack = true;
      return;
    }
    if (action.kind === 'ready') {
      if (!exact(frame, 'type', 'ttys', 'hash', 'screen') || frame.ttys !== true || frame.hash !== this.hash) throw fail();
    } else if (action.kind === 'key') {
      if (!exact(frame, 'type', 'key', 'screen') || frame.key !== action.key) throw fail();
    } else if (!exact(frame, 'type', 'screen')) {
      throw fail();
    }
    const screen = confirmedScreen(frame.screen, action, this.totalLines);
    if (action.kind === 'ready') {
      this.workspace.discardSource();
      this.hash = undefined;
      this.state = 'ready';
    }
    this.screen = screen;
    this.cols = screen.cols;
    this.rows = screen.rows;
    if (action.kind !== 'ready') notify(this.onScreen, screen);
    this.finish(action, true);
  }

  stop(intent) {
    if (this.state === 'closing' || this.state === 'exited') return;
    this.state = 'closing';
    this.intent = intent;
    this.buffer = '';
    this.finish(this.pending, false);
    if (this.pty) {
      // The locked UnixTerminal's public destroy() closes the master and later
      // calls kill(pid), which can signal a reused PID. Close only its master
      // ReadStream instead. Linux delivers SIGHUP to this PTY's own session;
      // the addon's independent OS wait callback remains attached.
      this.pty._socket.destroy();
    }
  }

  exited({ exitCode, signal }) {
    if (this.state === 'exited') return;
    const action = this.pending;
    const osSignal = Number.isInteger(signal) && signal > 0 ? signal : null;
    const code = osSignal === null && Number.isInteger(exitCode) ? exitCode : null;
    let reason = 'fault';
    if (this.intent === 'disposed' && (osSignal === 1 || code === 1)) reason = 'disposed';
    if (!this.intent && action?.kind === 'quit' && action.ack && code === 0 && !this.buffer) reason = 'quit';
    this.state = 'exited';
    this.buffer = '';
    this.signal?.removeEventListener('abort', this.abort);
    this.dataListener?.dispose();
    this.exitListener?.dispose();
    let clean = false;
    try {
      this.workspace.close();
      clean = true;
    } catch {
      reason = 'fault';
    }
    notify(this.onExit, { code, signal: osSignal, reason });
    this.finish(action, reason === 'quit' && clean);
    this.resolveClosed(clean);
  }

  waitForClose() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(fail()), CLOSE_MS);
      this.closed.then((clean) => {
        clearTimeout(timer);
        if (clean) resolve();
        else reject(fail());
      });
    });
  }

  dispose = async () => {
    this.stop('disposed');
    this.closeWait ??= this.waitForClose();
    await this.closeWait;
  };

  async cleanFailedStart() {
    if (this.pty) {
      this.stop('fault');
      await this.waitForClose();
    } else {
      this.workspace.close();
    }
  }
}

export async function openNativeViewer(options) {
  if (!options || typeof options !== 'object') throw fail('terminal_invalid');
  const { text, cols, rows, onScreen, onExit, signal } = options;
  if (typeof text !== 'string' || !validSize(cols, rows) ||
      (onScreen !== undefined && typeof onScreen !== 'function') ||
      (onExit !== undefined && typeof onExit !== 'function') ||
      (signal !== undefined && !(signal instanceof AbortSignal))) throw fail('terminal_invalid');
  if (text.length > MAX_SOURCE_BYTES) throw fail('terminal_limit');
  if (!text.isWellFormed()) throw fail('terminal_invalid');
  const totalLines = countLines(text);
  if (Buffer.byteLength(text) > MAX_SOURCE_BYTES || totalLines > MAX_SOURCE_LINES) throw fail('terminal_limit');
  if (signal?.aborted) throw fail();
  const session = new NativeSession({ cols, rows, onScreen, onExit, signal }, totalLines,
    createHash('sha256').update(text).digest('hex'));
  try {
    return await session.start(lockedAddon(), text);
  } catch {
    try { await session.cleanFailedStart(); } catch { /* Report a fixed error only. */ }
    throw fail();
  }
}
