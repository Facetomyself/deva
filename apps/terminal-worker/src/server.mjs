import { createServer } from 'node:net';
import { COMMAND_MS, IDLE_MS, LIFETIME_MS, MAX_PEERS, isRequest, validExit, validScreen } from './protocol.mjs';
import { createSocketChannel, transportError } from './socket-channel.mjs';
import { openSocketScope, sameNode } from './socket-path.mjs';
import { prepareSocketPublish } from './socket-publish.mjs';

const MAX_CONNECTIONS = 8;
const PROBE_TEXT = 'viewer control probe\nsecond\nthird\nfourth\nfifth\nsixth\nseventh';
const timer = (callback, ms) => setTimeout(callback, ms).unref();

async function defaultOpenNative(options) {
  const { openNativeViewer } = await import('./native.mjs');
  return openNativeViewer(options);
}

function closeListener(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function awaitCleanup(cleanups) {
  let deadline;
  try {
    await Promise.race([
      Promise.allSettled(cleanups).then((results) => {
        if (results.some(({ status }) => status === 'rejected')) throw new Error('Terminal worker cleanup failed');
      }),
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error('Terminal worker cleanup timed out')), COMMAND_MS);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}

function sameSize(screen, cols, rows) {
  return screen?.cols === cols && screen?.rows === rows;
}

function attachPeer(socket, { authorized, openNative, owners, probeSlot }) {
  const controller = new AbortController();
  let stopped = false;
  let busy = false;
  let phase = 'new';
  let progress, idle;
  let opening, native, cleanup, lastScreen, exit;
  let resolveExit, cancelWait, leaveProbe;
  const exitReady = new Promise((resolve) => { resolveExit = resolve; });
  function wait(operation) {
    return new Promise((resolve, reject) => {
      function settle(callback, value) {
        if (cancelWait !== cancel) return;
        cancelWait = undefined;
        callback(value);
      }
      const cancel = () => settle(resolve);
      cancelWait = cancel;
      Promise.resolve(operation).then((value) => settle(resolve, value), (error) => settle(reject, error));
      if (stopped) cancel();
    });
  }
  const channel = createSocketChannel(socket, { validate: isRequest, onMessage, onClose: stop });
  const absolute = timer(channel.destroy, LIFETIME_MS);
  idle = timer(channel.destroy, COMMAND_MS);

  function release() {
    if (!opening) return Promise.resolve();
    if (!cleanup) {
      cleanup = opening.then((viewer) => viewer?.dispose(), () => {}).then(() => {
        owners.delete(peer);
        if (probeSlot.owner === peer) probeSlot.owner = undefined;
      });
      // Transport loss has no caller awaiting disposal. Keep its errors handled.
      cleanup.catch(() => {});
    }
    return cleanup;
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(absolute);
    clearTimeout(idle);
    clearTimeout(progress);
    cancelWait?.();
    leaveProbe?.();
    resolveExit(null);
    controller.abort();
    release();
  }

  function finish() {
    release();
    channel.end();
  }

  function onScreen(screen) {
    if (stopped) return;
    if (exit || !validScreen(screen)) return channel.destroy();
    lastScreen = screen;
    if (phase === 'viewing') channel.send({ type: 'screen', screen });
  }

  function onExit(status) {
    if (stopped) return;
    if (exit || !validExit(status)) return channel.destroy();
    exit = status;
    resolveExit(status);
    if (phase === 'viewing') {
      channel.send({ type: 'exit', exit });
      if (!busy) finish();
    }
  }

  async function open(text, cols, rows) {
    if (owners.size >= MAX_PEERS || (phase === 'probing' && probeSlot.owner)) throw transportError();
    if (phase === 'probing') probeSlot.owner = peer;
    owners.add(peer);
    // Save the promise before invoking native so synchronous callbacks or a late
    // result after revocation share the same cleanup and continue to occupy a slot.
    opening = Promise.resolve().then(() => {
      if (stopped) throw transportError();
      return openNative({ text, cols, rows, onScreen, onExit, signal: controller.signal });
    });
    native = await wait(opening);
    if (stopped) return;
    if (!native || typeof native.input !== 'function' || typeof native.resize !== 'function'
      || typeof native.dispose !== 'function' || !validScreen(native.screen)
      || !sameSize(native.screen, cols, rows) || native.screen.top !== 0 || native.screen.left !== 0 || exit) throw transportError();
    lastScreen = native.screen;
  }

  async function proveReadiness() {
    await open(PROBE_TEXT, 24, 4);
    if (stopped) return false;
    await wait(native.resize(32, 5));
    if (stopped) return false;
    if (!sameSize(lastScreen, 32, 5) || exit) throw transportError();
    await wait(native.input('down'));
    if (stopped) return false;
    if (!sameSize(lastScreen, 32, 5) || lastScreen.top !== 1 || exit) throw transportError();
    await wait(native.input('quit'));
    if (stopped) return false;
    const status = await exitReady;
    if (stopped) return false;
    if (!status || status.reason !== 'quit' || status.code !== 0 || status.signal !== null) throw transportError();
    await wait(release());
    return !stopped && authorized();
  }

  async function probe() {
    const ready = await new Promise((resolve) => {
      if (!probeSlot.waiters) {
        const waiters = new Set();
        probeSlot.waiters = waiters;
        // Share only this in-flight result. The lead peer still owns the native
        // child and its deadline; release() keeps the slot through late cleanup.
        function settle(result) {
          probeSlot.waiters = undefined;
          for (const done of waiters) done(result);
          waiters.clear();
        }
        void proveReadiness().then(settle, () => settle(false));
      }
      const waiters = probeSlot.waiters;
      waiters.add(resolve);
      // Unsubscribe on disconnect so churn stays bounded by live transports.
      leaveProbe = () => {
        waiters.delete(resolve);
        resolve(false);
      };
    });
    leaveProbe = undefined;
    if (ready && !stopped && authorized() && channel.send({ type: 'probe-ok' })) finish();
    else channel.destroy();
  }

  async function operate(request) {
    const { type } = request;
    if (type === 'resize') {
      await wait(native.resize(request.cols, request.rows));
      if (!stopped && !sameSize(lastScreen, request.cols, request.rows)) throw transportError();
    } else if (type === 'input') {
      await wait(native.input(request.key));
      if (!stopped && request.key === 'quit' && (await exitReady)?.reason !== 'quit') throw transportError();
    } else {
      await wait(release());
      if (!stopped && (await exitReady)?.reason !== 'disposed') throw transportError();
    }
    if (stopped) return;
    if (!authorized()) return channel.destroy();
    if (exit?.reason === 'fault') return finish();
    if (channel.send({ type: 'ack', op: type }) && exit) finish();
  }

  async function run(request) {
    if (stopped) return;
    try {
      if (!authorized()) throw transportError();
      if (phase === 'new') {
        if (request.type === 'probe') {
          phase = 'probing';
          await probe();
        } else {
          phase = 'opening';
          await open(request.text, request.cols, request.rows);
          if (stopped) return;
          if (exit || !authorized()) throw transportError();
          phase = 'viewing';
          channel.send({ type: 'open-ok', screen: native.screen });
        }
      } else {
        await operate(request);
      }
    } catch {
      if (phase === 'viewing' && exit && !stopped) finish();
      else channel.destroy();
    } finally {
      busy = false;
      clearTimeout(progress);
      if (channel.active) idle = timer(channel.destroy, IDLE_MS);
    }
  }

  function onMessage(request) {
    if (stopped || busy || exit || (phase === 'new' && !['open', 'probe'].includes(request.type))
      || (phase === 'viewing' && !['input', 'resize', 'dispose'].includes(request.type))
      || !['new', 'viewing'].includes(phase)) return channel.destroy();
    busy = true;
    clearTimeout(idle);
    progress = timer(channel.destroy, COMMAND_MS);
    // Inspect coalesced frames before initiating any native command; pipelined
    // messages are invalid because the typed channel allows one command in flight.
    queueMicrotask(() => { void run(request); });
  }

  const peer = { closed: channel.closed, destroy: channel.destroy, release };
  return peer;
}

export async function startTerminalServer({ runDir, openNative = defaultOpenNative }) {
  if (typeof openNative !== 'function') throw new TypeError('Invalid terminal native opener');
  const scope = openSocketScope(runDir, { create: true });
  let publication, identity, closing;
  const peers = new Set();
  const owners = new Set();
  const probeSlot = { owner: undefined, waiters: undefined };
  function authorized() {
    if (!identity || closing) return false;
    try { return sameNode(identity, scope.inspect()); } catch { return false; }
  }
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    if (peers.size >= MAX_CONNECTIONS || !authorized()) {
      socket.destroy();
      return;
    }
    const peer = attachPeer(socket, { authorized, openNative, owners, probeSlot });
    peers.add(peer);
    void peer.closed.then(() => peers.delete(peer));
  });
  server.maxConnections = MAX_CONNECTIONS;

  function close() {
    if (closing) return closing;
    // Take the snapshot synchronously: a disconnected peer still owns its slot
    // while a late native open or asynchronous disposal remains outstanding.
    for (const peer of peers) peer.destroy();
    const cleanups = [...owners].map((peer) => peer.release());
    // Capture cleanup failures immediately, including before listen close settles.
    const cleanup = awaitCleanup(cleanups);
    cleanup.catch(() => {});
    closing = (async () => {
      try {
        await closeListener(server);
      } finally {
        try { publication?.close(); } finally { scope.close(); }
      }
      await cleanup;
    })();
    return closing;
  }

  try {
    publication = prepareSocketPublish(scope);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ path: publication.bindPath, backlog: MAX_CONNECTIONS }, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    server.on('error', () => { close().catch(() => {}); });
    identity = publication.publish();
  } catch {
    await close().catch(() => {});
    throw new Error('Terminal worker failed to start');
  }
  return { close };
}
