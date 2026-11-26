import { COMMAND_MS, LIFETIME_MS, MAX_FRAME_BYTES, MAX_PENDING_FRAMES, isRequest, isResponse } from './protocol.mjs';
import { createSocketChannel, dialTerminalSocket, transportError } from './socket-channel.mjs';

const timer = (callback, ms) => setTimeout(callback, ms).unref();
const validSignal = (signal) => signal === undefined || signal instanceof AbortSignal;

function options(value, fields) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).every((key) => {
    if (!fields.includes(key)) return false;
    const property = Object.getOwnPropertyDescriptor(value, key);
    return property?.enumerable === true && Object.hasOwn(property, 'value');
  });
}

function attachProbe(socket, signal) {
  return new Promise((resolve) => {
    let seen = false;
    const channel = createSocketChannel(socket, {
      validate: isResponse,
      onMessage(response) {
        if (seen || response.type !== 'probe-ok') return channel.destroy();
        seen = true;
        queueMicrotask(() => {
          if (!channel.active || signal?.aborted) return;
          resolve(true);
          channel.destroy();
        });
      },
      onClose() {
        clearTimeout(deadline);
        signal?.removeEventListener('abort', channel.destroy);
        resolve(false);
      },
    });
    const deadline = timer(channel.destroy, COMMAND_MS);
    signal?.addEventListener('abort', channel.destroy, { once: true });
    if (socket.destroyed || signal?.aborted) channel.destroy();
    else channel.send({ type: 'probe' });
  });
}

function attachViewer(socket, request, { onScreen, onExit, signal }, resolve, reject) {
  let opened = false;
  let stopped = false;
  let barrier = true;
  let earlyBytes = 0;
  let earlyExit = false;
  let exitReason;
  let seenCols = request.cols;
  let seenRows = request.rows;
  let pending, terminalOperation;
  const early = [];
  const queue = [];
  const channel = createSocketChannel(socket, { validate: isResponse, onMessage, onClose: stop });
  let deadline = timer(channel.destroy, COMMAND_MS);
  const lifetime = timer(channel.destroy, LIFETIME_MS);
  signal?.addEventListener('abort', channel.destroy, { once: true });

  function announceExit(exit) {
    exitReason = exit.reason;
    try { onExit(exit); } catch { /* A caller callback must not block cleanup. */ }
  }

  function announceLoss() {
    if (opened && exitReason === undefined) announceExit({ code: null, signal: null, reason: 'worker-lost' });
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(deadline);
    clearTimeout(lifetime);
    signal?.removeEventListener('abort', channel.destroy);
    const error = transportError();
    if (!opened) reject(error);
    if (pending) {
      pending.reject(error);
      pending = undefined;
    }
    for (const op of queue.splice(0)) op.reject(error);
    if (!barrier) announceLoss();
  }

  function pump() {
    if (stopped || pending || barrier || exitReason !== undefined || !queue.length) return;
    pending = queue.shift();
    deadline = timer(channel.destroy, COMMAND_MS);
    channel.send(pending.request);
  }

  function enqueue(request) {
    if (stopped || exitReason !== undefined || terminalOperation) return Promise.reject(transportError());
    if (!isRequest(request)) {
      channel.destroy();
      return Promise.reject(new TypeError('Invalid terminal operation'));
    }
    if (queue.length + Number(Boolean(pending)) >= MAX_PENDING_FRAMES) {
      channel.destroy();
      return Promise.reject(transportError());
    }
    const result = new Promise((resolve, reject) => { queue.push({ request, resolve, reject }); });
    if (request.type === 'dispose' || request.key === 'quit') terminalOperation = result;
    pump();
    return result;
  }

  function handleEvent(response) {
    if (exitReason !== undefined) return channel.destroy();
    if (response.type === 'screen') {
      seenCols = response.screen.cols;
      seenRows = response.screen.rows;
      try { onScreen(response.screen); } catch { channel.destroy(); }
    } else {
      announceExit(response.exit);
      if (!pending || exitReason === 'fault') channel.destroy();
    }
  }

  function acceptOpen(screen) {
    if (screen.cols !== request.cols || screen.rows !== request.rows || screen.top !== 0 || screen.left !== 0) return channel.destroy();
    opened = true;
    clearTimeout(deadline);
    resolve({
      screen,
      input: (key) => enqueue({ type: 'input', key }),
      resize: (cols, rows) => enqueue({ type: 'resize', cols, rows }),
      dispose: () => terminalOperation ?? (exitReason && exitReason !== 'worker-lost'
        ? Promise.resolve() : enqueue({ type: 'dispose' })),
    });
    // A coalesced screen/exit is later than the initial screen returned by open.
    queueMicrotask(() => {
      barrier = false;
      for (const response of early.splice(0)) handleEvent(response);
      earlyBytes = 0;
      if (stopped) announceLoss();
      else pump();
    });
  }

  function onMessage(response, bytes) {
    if (!opened) {
      if (response.type !== 'open-ok') return channel.destroy();
      acceptOpen(response.screen);
    } else if (response.type === 'screen' || response.type === 'exit') {
      if (barrier) {
        if (earlyExit || early.length >= MAX_PENDING_FRAMES || earlyBytes + bytes > MAX_FRAME_BYTES + 4) return channel.destroy();
        earlyBytes += bytes;
        earlyExit = response.type === 'exit';
        early.push(response);
      } else {
        handleEvent(response);
      }
    } else {
      if (response.type !== 'ack' || !pending || response.op !== pending.request.type || exitReason === 'fault') return channel.destroy();
      const { type, key, cols, rows } = pending.request;
      if ((type === 'resize' && (cols !== seenCols || rows !== seenRows))
        || (type === 'input' && key === 'quit' && exitReason !== 'quit')
        || (type === 'dispose' && exitReason !== 'disposed')) return channel.destroy();
      clearTimeout(deadline);
      const finished = pending;
      pending = undefined;
      finished.resolve();
      if (exitReason !== undefined) channel.destroy();
      else queueMicrotask(pump);
    }
  }

  if (socket.destroyed || signal?.aborted) channel.destroy();
  else channel.send(request);
}

export function createTerminalClient({ runDir }) {
  return {
    async probe(input = {}) {
      if (!options(input, ['signal']) || !validSignal(input.signal)) return false;
      try {
        const socket = await dialTerminalSocket(runDir, input.signal);
        return await attachProbe(socket, input.signal);
      } catch {
        return false;
      }
    },
    open(input) {
      if (!options(input, ['text', 'cols', 'rows', 'onScreen', 'onExit', 'signal'])) {
        return Promise.reject(new TypeError('Invalid terminal open options'));
      }
      const { text, cols, rows, onScreen, onExit, signal } = input;
      const request = { type: 'open', text, cols, rows };
      if (!isRequest(request) || typeof onScreen !== 'function' || typeof onExit !== 'function' || !validSignal(signal)) {
        return Promise.reject(new TypeError('Invalid terminal open options'));
      }
      return new Promise((resolve, reject) => {
        dialTerminalSocket(runDir, signal).then((socket) => {
          try { attachViewer(socket, request, { onScreen, onExit, signal }, resolve, reject); } catch {
            socket.destroy();
            reject(transportError());
          }
        }, reject);
      });
    },
  };
}
