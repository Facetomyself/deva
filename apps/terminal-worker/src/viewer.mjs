import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import {
  countLines, createViewport, KEY_BYTES, MAX_FRAME_BYTES, MAX_SOURCE_BYTES,
  MAX_SOURCE_LINES, prepareText, SOURCE_NAME, validSize,
} from './viewer-text.mjs';

const keyByByte = new Map(Object.entries(KEY_BYTES).map(([key, byte]) => [byte.charCodeAt(0), key]));

function readSnapshot() {
  const uid = BigInt(process.getuid());
  const stats = { bigint: true };
  const dir = lstatSync('.', stats);
  if (!dir.isDirectory() || dir.uid !== uid || (dir.mode & 0o7777n) !== 0o700n) throw new Error();
  const fd = openSync(SOURCE_NAME, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, stats);
    if (!before.isFile() || before.uid !== uid || before.dev !== dir.dev || before.nlink !== 1n ||
        (before.mode & 0o7777n) !== 0o600n || before.size > BigInt(MAX_SOURCE_BYTES)) throw new Error();
    const sizeBefore = Number(before.size);
    const buffer = Buffer.alloc(sizeBefore + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const size = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (size === 0) break;
      offset += size;
    }
    const after = fstatSync(fd, stats);
    const entry = lstatSync(SOURCE_NAME, stats);
    if (offset !== sizeBefore || after.size !== before.size || after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs || entry.dev !== before.dev || entry.ino !== before.ino ||
        entry.nlink !== 1n || (entry.mode & 0o7777n) !== 0o600n) throw new Error();
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, offset));
    if (countLines(text) > MAX_SOURCE_LINES) throw new Error();
    return {
      data: prepareText(text),
      hash: createHash('sha256').update(buffer.subarray(0, offset)).digest('hex'),
    };
  } finally {
    closeSync(fd);
  }
}

function fault() {
  // An OS exit and/or the missing typed frame is enough for the parent. Never
  // render an exception, a path, or raw bootstrap text to the terminal.
  process.exit(1);
}

function run() {
  const { stdin, stdout, stderr } = process;
  if (stdin.isTTY !== true || stdout.isTTY !== true || stderr.isTTY !== true) return fault();

  stdin.setRawMode(true);
  stdin.on('error', fault);
  stdout.on('error', fault);
  stdin.on('end', fault);
  const { data, hash } = readSnapshot();
  const viewport = createViewport(data);
  let cols;
  let rows;
  let quitting = false;

  function send(frame, done) {
    const line = `${JSON.stringify(frame)}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes > MAX_FRAME_BYTES || stdout.writableLength + bytes > 2 * MAX_FRAME_BYTES) return fault();
    stdout.write(line, (error) => {
      if (error) return fault();
      done?.();
    });
  }

  function emitScreen(type, key) {
    // Node's TTY stdout refreshes the actual size in its own SIGWINCH handler,
    // installed when the stream above is created, before the handler below.
    const nextCols = stdout.columns;
    const nextRows = stdout.rows;
    if (!validSize(nextCols, nextRows)) return fault();
    if (type === 'resize' && nextCols === cols && nextRows === rows) return;
    if (type === 'key' && (nextCols !== cols || nextRows !== rows)) return fault();
    cols = nextCols;
    rows = nextRows;
    const screen = viewport(cols, rows, key);
    if (type === 'ready') send({ type, ttys: true, hash, screen });
    if (type === 'resize') send({ type, screen });
    if (type === 'key') send({ type, key, screen });
  }

  process.on('SIGWINCH', () => { if (!quitting) emitScreen('resize'); });
  stdin.on('data', (bytes) => {
    if (quitting || bytes.length !== 1) return fault();
    const key = keyByByte.get(bytes[0]);
    if (!key) return fault();
    if (key === 'quit') {
      quitting = true;
      stdin.pause();
      send({ type: 'quit' }, () => process.exit(0));
    } else {
      emitScreen('key', key);
    }
  });
  emitScreen('ready');
}

process.on('uncaughtException', fault);
process.on('unhandledRejection', fault);
try {
  run();
} catch {
  fault();
}
