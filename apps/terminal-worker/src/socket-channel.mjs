import { Buffer } from 'node:buffer';
import { createConnection } from 'node:net';
import { COMMAND_MS, MAX_FRAME_BYTES, MAX_PENDING_FRAMES, MAX_WIRE_FRAMES, decodeFrame, encodeFrame } from './protocol.mjs';
import { openSocketScope, sameNode } from './socket-path.mjs';

export function transportError() {
  return new Error('Terminal worker connection lost');
}

function timer(callback) {
  const handle = setTimeout(callback, COMMAND_MS);
  handle.unref();
  return handle;
}

export function dialTerminalSocket(runDir, signal) {
  return new Promise((resolve, reject) => {
    let scope, socket, deadline;
    let settled = false;
    function finish(success) {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener('abort', abort);
      scope?.close();
      if (success) {
        socket.removeListener('error', abort);
        socket.removeListener('close', abort);
        resolve(socket);
      } else {
        socket?.destroy();
        reject(transportError());
      }
    }
    const abort = () => finish(false);
    if (signal?.aborted) return abort();
    try {
      scope = openSocketScope(runDir);
      const before = scope.inspect();
      socket = createConnection({ path: scope.socketPath });
      socket.once('error', abort);
      socket.once('close', abort);
      socket.once('connect', () => {
        try { finish(!signal?.aborted && sameNode(before, scope.inspect())); } catch { abort(); }
      });
      signal?.addEventListener('abort', abort, { once: true });
      deadline = timer(abort);
    } catch { abort(); }
  });
}

export function createSocketChannel(socket, { validate, onMessage, onClose }) {
  const prefix = Buffer.allocUnsafe(4);
  let prefixUsed = 0;
  let body = null;
  let used = 0;
  let readDeadline, writeDeadline, endDeadline;
  let sent = 0;
  let received = 0;
  let queuedBytes = 0;
  let queuedFrames = 0;
  let stopped = false;
  let ending = false;
  const closed = new Promise((resolve) => socket.once('close', resolve));

  function destroy() {
    if (stopped) return;
    stopped = true;
    body = null;
    clearTimeout(readDeadline);
    clearTimeout(writeDeadline);
    clearTimeout(endDeadline);
    socket.destroy();
    onClose();
  }
  function send(value) {
    if (stopped || ending) return false;
    try {
      const packet = encodeFrame(value);
      if (++sent > MAX_WIRE_FRAMES || queuedFrames >= MAX_PENDING_FRAMES
        || queuedBytes + packet.length > MAX_FRAME_BYTES + 4) throw transportError();
      if (queuedFrames++ === 0) writeDeadline = timer(destroy);
      queuedBytes += packet.length;
      socket.write(packet, (error) => {
        if (stopped) return;
        queuedBytes -= packet.length;
        if (--queuedFrames === 0) clearTimeout(writeDeadline);
        if (error) destroy();
      });
      return true;
    } catch {
      destroy();
      return false;
    }
  }
  function end() {
    if (stopped || ending) return;
    ending = true;
    endDeadline = timer(destroy);
    socket.end();
  }
  function consume(chunk) {
    if (stopped || ending) return destroy();
    let offset = 0;
    let frames = 0;
    try {
      while (offset < chunk.length && !stopped) {
        if (!body) {
          if (prefixUsed === 0) readDeadline = timer(destroy);
          const take = Math.min(4 - prefixUsed, chunk.length - offset);
          chunk.copy(prefix, prefixUsed, offset, offset + take);
          prefixUsed += take;
          offset += take;
          if (prefixUsed < 4) break;
          const length = prefix.readUInt32BE(0);
          if (length < 1 || length > MAX_FRAME_BYTES) throw transportError();
          body = Buffer.allocUnsafe(length);
          prefixUsed = 0;
        }
        const take = Math.min(body.length - used, chunk.length - offset);
        chunk.copy(body, used, offset, offset + take);
        offset += take;
        used += take;
        if (used === body.length) {
          clearTimeout(readDeadline);
          if (++frames > MAX_PENDING_FRAMES || ++received > MAX_WIRE_FRAMES) throw transportError();
          const length = used;
          const value = decodeFrame(body, validate);
          body = null;
          used = 0;
          onMessage(value, length + 4);
          if (ending && offset < chunk.length) throw transportError();
        }
      }
    } catch { destroy(); }
  }

  socket.on('error', destroy);
  socket.on('end', destroy);
  socket.once('close', destroy);
  socket.on('data', consume);
  return { closed, destroy, end, send, get active() { return !stopped && !ending; } };
}
