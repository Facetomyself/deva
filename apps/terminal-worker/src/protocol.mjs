import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';

export const MAX_FRAME_BYTES = 512 * 1024;
export const MAX_PEERS = 4;
export const MAX_PENDING_FRAMES = 8;
export const MAX_WIRE_FRAMES = 16_384;
export const COMMAND_MS = 8_000;
export const IDLE_MS = 90_000;
export const LIFETIME_MS = 9 * 60_000;

const KEYS = new Set(['up', 'down', 'page-up', 'page-down', 'home', 'end', 'left', 'right', 'quit']);
const EXIT_REASONS = new Set(['quit', 'disposed', 'fault']);
const MAX_SCREEN_BYTES = 96 * 1024;
const NON_RENDERED = /[\p{Cc}\p{Zl}\p{Zp}]|(?:(?![\u200c\u200d])\p{Cf})/u;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function record(value, ...keys) {
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && keys.every((key) => {
    const field = Object.getOwnPropertyDescriptor(value, key);
    return field?.enumerable === true && Object.hasOwn(field, 'value');
  });
}

function inRange(value, low, high) {
  return Number.isSafeInteger(value) && value >= low && value <= high;
}

export function validSize(cols, rows) {
  return inRange(cols, 24, 160) && inRange(rows, 4, 50);
}

export function validKey(key) {
  return KEYS.has(key);
}

export function validText(text) {
  if (typeof text !== 'string' || text.length > 65_536 || !text.isWellFormed() || Buffer.byteLength(text) > 65_536) return false;
  let lines = 1;
  // LF and CRLF each end one logical line. A bare CR is rendered as data.
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    if (++lines > 4_096) return false;
  }
  return true;
}

export function validScreen(screen) {
  if (!record(screen, 'cols', 'rows', 'top', 'left', 'totalLines', 'lines')) return false;
  const { cols, rows, top, left, totalLines, lines } = screen;
  if (!validSize(cols, rows) || !inRange(totalLines, 1, 4_096)
      || !inRange(top, 0, totalLines - 1) || !inRange(left, 0, 65_536 * 8 - cols)
      || !Array.isArray(lines) || !inRange(lines.length, 1, Math.min(rows, totalLines - top))
      || Reflect.ownKeys(lines).length !== lines.length + 1) return false;
  let bytes = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const entry = Object.getOwnPropertyDescriptor(lines, i);
    if (!entry?.enumerable || !Object.hasOwn(entry, 'value')) return false;
    const line = entry.value;
    if (typeof line !== 'string' || line.length > MAX_SCREEN_BYTES || !line.isWellFormed() || NON_RENDERED.test(line)) return false;
    bytes += Buffer.byteLength(line);
    if (bytes > MAX_SCREEN_BYTES) return false;
  }
  return true;
}

export function validExit(exit) {
  const status = (n) => n === null || inRange(n, 0, 2_147_483_647);
  return record(exit, 'code', 'signal', 'reason') && status(exit.code) && status(exit.signal) && EXIT_REASONS.has(exit.reason);
}

export function isRequest(value) {
  switch (value?.type) {
    case 'probe':
    case 'dispose': return record(value, 'type');
    case 'open': return record(value, 'type', 'text', 'cols', 'rows') && validText(value.text) && validSize(value.cols, value.rows);
    case 'resize': return record(value, 'type', 'cols', 'rows') && validSize(value.cols, value.rows);
    case 'input': return record(value, 'type', 'key') && validKey(value.key);
    default: return false;
  }
}

export function isResponse(value) {
  switch (value?.type) {
    case 'probe-ok': return record(value, 'type');
    case 'open-ok':
    case 'screen': return record(value, 'type', 'screen') && validScreen(value.screen);
    case 'exit': return record(value, 'type', 'exit') && validExit(value.exit);
    case 'ack': return record(value, 'type', 'op') && ['input', 'resize', 'dispose'].includes(value.op);
    default: return false;
  }
}

export function encodeFrame(value) {
  const json = JSON.stringify(value);
  if (typeof json !== 'string') throw new Error('Invalid terminal frame');
  const length = Buffer.byteLength(json);
  if (length === 0 || length > MAX_FRAME_BYTES) throw new Error('Invalid terminal frame length');
  const packet = Buffer.allocUnsafe(length + 4);
  packet.writeUInt32BE(length);
  packet.write(json, 4, length, 'utf8');
  return packet;
}

export function decodeFrame(payload, validate) {
  // The canonical representation rejects duplicate (including escaped-equivalent)
  // keys, extra whitespace/data, alternate numeric spellings, and BOMs. Validate
  // the small typed schema before serialization, so deeply nested junk is bounded.
  if (payload.length === 0 || payload.length > MAX_FRAME_BYTES) throw new Error('Invalid terminal frame length');
  const json = utf8.decode(payload);
  let value;
  try {
    value = JSON.parse(json);
    if (validate(value) && JSON.stringify(value) === json) return value;
  } catch {
    // Do not propagate JSON errors: Node can include the submitted text.
  }
  throw new Error('Invalid terminal frame');
}
