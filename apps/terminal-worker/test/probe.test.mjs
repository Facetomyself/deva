import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createTerminalClient } from '../src/client.mjs';
import { COMMAND_MS, encodeFrame } from '../src/protocol.mjs';
import { startTerminalServer } from '../src/server.mjs';

const linux = { skip: process.platform !== 'linux', timeout: 6_000 };
const TEXT = 'one\ntwo\nthree\nfour\nfive\nsix\nseven';
const QUIT = { code: 0, signal: null, reason: 'quit' };
const DISPOSED = { code: null, signal: 1, reason: 'disposed' };

async function fixture(t, firstProbe) {
  const runDir = await mkdtemp(join(tmpdir(), 'deva-probe-'));
  const path = join(runDir, 'viewer.sock');
  const gates = [];
  let server;
  t.after(async () => {
    for (const gate of gates) gate.resolve();
    try { await server?.close(); } finally { await rm(runDir, { recursive: true, force: true }); }
  });
  const state = { active: 0, peak: 0, probes: [], viewers: [], events: [] };
  server = await startTerminalServer({ runDir, async openNative({ text, cols, rows, onScreen, onExit, signal }) {
    const probe = text !== TEXT;
    const starts = probe ? state.probes : state.viewers;
    const plan = probe && !starts.length ? firstProbe : {};
    if (probe) assert.equal(text, 'viewer control probe\nsecond\nthird\nfourth\nfifth\nsixth\nseventh');
    const calls = [];
    starts.push(calls);
    state.peak = Math.max(state.peak, ++state.active);
    let top = 0;
    let exited = false;
    const lines = text.split('\n');
    const screen = () => ({ cols, rows, top, left: 0, totalLines: lines.length, lines: lines.slice(top, top + rows) });
    function exit(status = QUIT) {
      if (exited) return;
      exited = true;
      state.active--;
      onExit(status);
    }
    if (plan.open) await plan.open(signal);
    return {
      screen: screen(),
      async resize(w, h) {
        calls.push(['resize', w, h]);
        cols = w;
        rows = h;
        onScreen(screen());
      },
      async input(key) {
        calls.push(key);
        if (key === 'quit') return plan.quit ? plan.quit(exit) : exit();
        if (plan.down) await plan.down();
        top++;
        onScreen(screen());
      },
      async dispose() {
        calls.push('dispose');
        if (plan.cleanup) await plan.cleanup();
        exit(DISPOSED);
      },
    };
  } });
  async function rawSocket() {
    const socket = createConnection({ path });
    socket.on('error', () => {});
    const closed = once(socket, 'close');
    await once(socket, 'connect');
    return { socket, closed };
  }
  async function socketTurn() {
    // Give earlier requests a worker I/O turn while the real proof is gated.
    const { socket, closed } = await rawSocket();
    socket.write(encodeFrame({ type: 'dispose' })); // Invalid as a first command.
    await closed;
  }
  const client = createTerminalClient({ runDir });
  const event = (value) => state.events.push(value);
  return {
    state, server, runDir, client, rawSocket, socketTurn,
    open: () => client.open({ text: TEXT, cols: 24, rows: 4, onScreen: event, onExit: event }),
    gate() {
      const gate = Promise.withResolvers();
      gates.push(gate);
      return gate;
    },
  };
}

const proofCalls = [['resize', 32, 5], 'down', 'quit', 'dispose'];

test('three viewers and overlapping probes share one fixed proof through exit and cleanup', linux, async (t) => {
  const quitting = Promise.withResolvers();
  const cleaning = Promise.withResolvers();
  let cleanup;
  const { state, server, runDir, client, open, rawSocket, socketTurn, gate } = await fixture(t, {
    quit: quitting.resolve,
    cleanup() { cleaning.resolve(); return cleanup.promise; },
  });
  cleanup = gate();
  const viewers = await Promise.all(Array.from({ length: 3 }, open));
  const results = [];
  const watch = (result) => result.then((ready) => { results.push(ready); return ready; });
  const lead = watch(client.probe());
  const exit = await quitting.promise;
  const waiter = watch(createTerminalClient({ runDir }).probe());
  const controller = new AbortController();
  const early = client.probe({ signal: controller.signal });
  await socketTurn();
  assert.equal(state.active, 4);
  await assert.rejects(open(), /connection lost/);
  // Three viewers, three probe peers and two idle transports occupy all eight.
  const idle = await Promise.all(Array.from({ length: 2 }, rawSocket));
  assert.equal(await client.probe(), false);
  assert(idle.every(({ socket }) => !socket.destroyed));
  for (const peer of idle) peer.socket.destroy();
  await Promise.all(idle.map(({ closed }) => closed));
  controller.abort();
  assert.equal(await early, false);
  assert.deepEqual(results, []);
  exit();
  await cleaning.promise;
  await assert.rejects(open(), /connection lost/);
  assert.deepEqual(results, []);
  assert.equal(state.active, 3);
  cleanup.resolve();
  assert.deepEqual(await Promise.all([lead, waiter]), [true, true]);
  assert.deepEqual(state.probes, [proofCalls]);
  assert.deepEqual(state.events, []);
  assert.equal(state.peak, 4);

  const fourth = await open();
  assert.deepEqual(await Promise.all([client.probe(), client.probe()]), [false, false]);
  assert.deepEqual(state.probes, [proofCalls]);
  assert.equal(state.active, 4);
  await Promise.all([...viewers, fourth].map((viewer) => viewer.dispose()));
  assert.equal(await client.probe(), true); // The earlier successful proof was not cached.
  assert.deepEqual(state.probes, [proofCalls, proofCalls]);
  await server.close();
  assert.equal(state.active, 0);
  assert.deepEqual(await readdir(runDir), []);
});

test('a shared nonzero native exit yields false and a fresh probe can succeed', linux, async (t) => {
  const quitting = Promise.withResolvers();
  const { state, client, socketTurn } = await fixture(t, { quit: quitting.resolve });
  const lead = client.probe();
  const exit = await quitting.promise;
  const waiter = client.probe();
  await socketTurn();
  exit({ code: 7, signal: null, reason: 'fault' });
  assert.deepEqual(await Promise.all([lead, waiter]), [false, false]);
  assert.deepEqual(state.probes, [proofCalls]);
  assert.equal(await client.probe(), true);
  assert.deepEqual(state.probes, [proofCalls, proofCalls]);
  assert.equal(state.active, 0);
});

test('aborting the lead invalidates the shared proof and late open is disposed', linux, async (t) => {
  const opening = Promise.withResolvers();
  const cleaning = Promise.withResolvers();
  let late;
  const { state, client, open, socketTurn, gate } = await fixture(t, {
    open(signal) { opening.resolve(signal); return late.promise; },
    cleanup: cleaning.resolve,
  });
  late = gate();
  const controller = new AbortController();
  const lead = client.probe({ signal: controller.signal });
  const signal = await opening.promise;
  const waiter = client.probe();
  await socketTurn();
  controller.abort();
  assert.deepEqual(await Promise.all([lead, waiter]), [false, false]);
  assert.equal(signal.aborted, true);
  assert.equal(await client.probe(), false);
  assert.deepEqual(state.probes, [[]]);
  const viewers = await Promise.all(Array.from({ length: 3 }, open));
  await assert.rejects(open(), /connection lost/);
  assert.equal(state.active, 4);
  late.resolve();
  await cleaning.promise;
  assert.equal(await client.probe(), true);
  assert.deepEqual(state.probes, [['dispose'], proofCalls]);
  await Promise.all(viewers.map((viewer) => viewer.dispose()));
  assert.equal(state.peak, 4);
  assert.equal(state.active, 0);
});

test('worker command deadline revokes a stuck proof and ignores its late rejection', { ...linux, timeout: COMMAND_MS + 4_000 }, async (t) => {
  const moving = Promise.withResolvers();
  let late;
  const { state, client, rawSocket, socketTurn, gate } = await fixture(t, {
    down() { moving.resolve(); return late.promise; },
  });
  late = gate();
  const { socket, closed } = await rawSocket(); // No client-side command timer on the lead.
  const received = [];
  socket.on('data', (chunk) => received.push(chunk));
  socket.write(encodeFrame({ type: 'probe' }));
  await moving.promise;
  const waiter = client.probe();
  await socketTurn();
  await closed;
  assert.equal(await waiter, false);
  assert.deepEqual(received, []);
  assert.deepEqual(state.probes, [[['resize', 32, 5], 'down', 'dispose']]);
  assert.equal(state.active, 0);
  assert.equal(await client.probe(), true);
  late.reject(new Error('late native command failure'));
  await socketTurn();
  assert.deepEqual(state.probes, [[['resize', 32, 5], 'down', 'dispose'], proofCalls]);
  assert.equal(state.active, 0);
});
