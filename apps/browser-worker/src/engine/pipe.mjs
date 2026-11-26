import { fail } from './policy.mjs';

const MAX_PACKET = 6 * 1024 * 1024;
const MAX_OUTGOING = 16 * 1024;
const MAX_PENDING = 32;
const COMMAND_MS = 5_000;
const utf8 = new TextDecoder('utf-8', { fatal: true });

// Chromium's debugging-pipe transport is NUL-delimited JSON, not a WebSocket.
// This module is internal: only the session implementation owns this object.
export function connectPipe(writer, reader, { onEvent, onFailure, commandMs = COMMAND_MS }) {
  let sequence = 0;
  let terminal = null;
  let chunks = [];
  let size = 0;
  const pending = new Map();

  function stop(code = 'BROWSER_CLOSED', command) {
    if (terminal) return;
    if (command === undefined && pending.size === 1) command = pending.values().next().value.method;
    terminal = fail(code, { command });
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(terminal);
    }
    pending.clear();
    chunks = [];
    size = 0;
    if (code !== 'BROWSER_CLOSED') onFailure(code);
  }

  function packet(buffer) {
    let message;
    try { message = JSON.parse(utf8.decode(buffer)); } catch { return stop('BROWSER_PROTOCOL_INVALID'); }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return stop('BROWSER_PROTOCOL_INVALID');
    if (Number.isSafeInteger(message.id)) {
      const request = pending.get(message.id);
      if (!request) return;
      if ((message.sessionId ?? null) !== request.sessionId) return stop('BROWSER_PROTOCOL_INVALID');
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) return request.reject(fail('BROWSER_COMMAND_FAILED', { command: request.method }));
      if (!message.result || typeof message.result !== 'object' || Array.isArray(message.result)) {
        request.reject(fail('BROWSER_PROTOCOL_INVALID', { command: request.method }));
        return stop('BROWSER_PROTOCOL_INVALID', request.method);
      }
      request.resolve(message.result);
    } else if (typeof message.method === 'string' && (message.sessionId === undefined || typeof message.sessionId === 'string')) {
      try { onEvent(message.method, message.params ?? {}, message.sessionId ?? null); }
      catch { stop('BROWSER_PROTOCOL_INVALID'); }
    } else stop('BROWSER_PROTOCOL_INVALID');
  }

  function onData(data) {
    for (let from = 0; from < data.length && !terminal;) {
      const end = data.indexOf(0, from);
      const chunk = data.subarray(from, end === -1 ? undefined : end);
      size += chunk.length;
      if (size > MAX_PACKET || chunks.length >= 8192) return stop('BROWSER_PROTOCOL_LIMIT');
      if (chunk.length) chunks.push(chunk);
      if (end === -1) return;
      if (!size) return stop('BROWSER_PROTOCOL_INVALID');
      const message = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size);
      chunks = [];
      size = 0;
      packet(message);
      from = end + 1;
    }
  }

  reader.on('data', onData);
  reader.on('end', () => stop('BROWSER_DISCONNECTED'));
  reader.on('close', () => stop('BROWSER_DISCONNECTED'));
  reader.on('error', () => stop('BROWSER_DISCONNECTED'));
  writer.on('error', () => stop('BROWSER_DISCONNECTED'));

  return {
    send(method, params = {}, sessionId = null) {
      if (terminal) return Promise.reject(terminal);
      if (pending.size >= MAX_PENDING) {
        stop('BROWSER_PROTOCOL_LIMIT');
        return Promise.reject(terminal);
      }
      const id = ++sequence;
      const encoded = Buffer.from(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
      if (encoded.length > MAX_OUTGOING) return Promise.reject(fail('BROWSER_PROTOCOL_LIMIT'));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => stop('BROWSER_TIMEOUT', method), commandMs);
        pending.set(id, { resolve, reject, sessionId, timer, method });
        try { writer.write(encoded, (error) => { if (error) stop('BROWSER_DISCONNECTED'); }); }
        catch { stop('BROWSER_DISCONNECTED'); }
      });
    },
    stop,
  };
}
