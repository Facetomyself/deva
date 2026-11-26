import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, link, lstat, mkdtemp, readdir, rm, symlink, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createTerminalClient } from '../src/client.mjs';
import { COMMAND_MS, MAX_FRAME_BYTES, encodeFrame } from '../src/protocol.mjs';
import { startTerminalServer } from '../src/server.mjs';

const linux = { skip: process.platform !== 'linux', timeout: 6_000 };
const options = { text: 'one\ntwo\nthree\nfour\nfive\nsix\nseven', cols: 24, rows: 4 };
const ignore = () => {};
const request = (overrides = {}) => ({ ...options, onScreen: ignore, onExit: ignore, ...overrides });
const endpoint = (runDir) => join(runDir, 'viewer.sock');

async function fixture(t) {
  const prefix = join(tmpdir(), 'deva-control-');
  const runDir = await mkdtemp(prefix);
  assert(runDir.startsWith(prefix) && runDir.length === prefix.length + 6);
  const servers = [];
  t.after(async () => {
    try { await Promise.all(servers.map((server) => server.close())); } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });
  return {
    runDir,
    client: createTerminalClient({ runDir }),
    async start(openNative) {
      const server = await startTerminalServer({ runDir, openNative });
      servers.push(server);
      return server;
    },
  };
}

function fakeNative({ hook } = {}) {
  const state = { started: 0, cleaned: 0, active: 0, aborted: 0, calls: [] };
  return {
    state,
    async openNative({ text, cols, rows, onScreen, onExit, signal }) {
      state.started++;
      state.active++;
      const lines = text.split('\n');
      let top = 0;
      let exited = false;
      const screen = () => ({ cols, rows, top, left: 0, totalLines: lines.length, lines: lines.slice(top, top + rows) });
      function close(reason) {
        if (exited) return;
        exited = true;
        state.active--;
        signal.removeEventListener('abort', abort);
        onExit({ code: reason === 'quit' ? 0 : null, signal: reason === 'quit' ? null : 1, reason });
      }
      function abort() {
        state.aborted++;
        close('fault');
      }
      signal.addEventListener('abort', abort, { once: true });
      return {
        screen: screen(),
        async input(key) {
          state.calls.push(key);
          if (key === 'quit') return close('quit');
          if (hook) return hook({ onScreen, onExit, screen, signal, key, close });
          top = Math.min(top + Number(key === 'down'), Math.max(0, lines.length - rows));
          onScreen(screen());
        },
        async resize(w, h) {
          state.calls.push(['resize', w, h]);
          cols = w;
          rows = h;
          top = Math.min(top, Math.max(0, lines.length - rows));
          onScreen(screen());
        },
        async dispose() {
          state.cleaned++;
          close('disposed');
        },
      };
    },
  };
}

async function eventually(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await delay(10);
  }
  assert(predicate(), 'operation should settle in one second');
}

async function raw(runDir) {
  const socket = createConnection({ path: endpoint(runDir) });
  socket.on('error', ignore);
  const closed = new Promise((resolve) => socket.once('close', resolve));
  await once(socket, 'connect');
  return { socket, closed };
}

function rawFrame(text) {
  const body = Buffer.from(text);
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(body.length);
  return Buffer.concat([prefix, body]);
}

test('publishes one private peer, probes native behavior, and orders callbacks before ACKs', linux, async (t) => {
  const { runDir, client, start } = await fixture(t);
  const fake = fakeNative();
  const server = await start(fake.openNative);
  const socket = await lstat(endpoint(runDir));
  assert(socket.isSocket());
  assert.equal(socket.uid, process.geteuid());
  assert.equal(socket.mode & 0o7777, 0o600);
  assert.equal(socket.nlink, 1);
  assert.equal((await lstat(runDir)).mode & 0o7777, 0o700);
  assert.deepEqual(await readdir(runDir), ['viewer.sock']);
  assert.equal(await client.probe(), true);
  assert.deepEqual(fake.state.calls, [['resize', 32, 5], 'down', 'quit']);
  assert.equal(fake.state.active, 0);
  assert.equal(fake.state.cleaned, 1);

  const events = [];
  const viewer = await client.open(request({ onScreen: (value) => events.push(value), onExit: (value) => events.push(value) }));
  assert.deepEqual(viewer.screen, { cols: 24, rows: 4, top: 0, left: 0, totalLines: 7, lines: ['one', 'two', 'three', 'four'] });
  assert.equal(events.length, 0);
  await viewer.input('down');
  assert.equal(events[0].top, 1);
  await viewer.resize(160, 50);
  assert.equal(events[1].cols, 160);
  assert.equal(events[1].rows, 50);
  await viewer.input('quit');
  assert.deepEqual(events[2], { code: 0, signal: null, reason: 'quit' });
  await viewer.dispose();
  assert.equal(events.length, 3);
  await server.close();
  assert.deepEqual(await readdir(runDir), []);
  assert.equal(fake.state.active, 0);
  assert.equal(await client.probe(), false);
});

test('socket creation, connect and cleanup preserve private inode scope', linux, async (t) => {
  const { runDir, client, start } = await fixture(t);
  const fake = fakeNative();
  const child = join(runDir, 'new-dir');
  const nested = await startTerminalServer({ runDir: child, openNative: fake.openNative });
  t.after(() => nested.close());
  assert.equal((await lstat(child)).mode & 0o777, 0o700);
  await nested.close();
  const alias = join(runDir, 'alias');
  await symlink(child, alias);
  await assert.rejects(startTerminalServer({ runDir: alias, openNative: fake.openNative }));
  assert.equal(await createTerminalClient({ runDir: alias }).probe(), false);

  const server = await start(fake.openNative);
  const path = endpoint(runDir);
  const original = await lstat(path, { bigint: true });
  await assert.rejects(start(fake.openNative));
  assert.equal((await lstat(path, { bigint: true })).ino, original.ino);
  await chmod(runDir, 0o750);
  assert.equal(await client.probe(), false);
  await chmod(runDir, 0o700);
  await chmod(path, 0o660);
  assert.equal(await client.probe(), false);
  await chmod(path, 0o600);
  const alternate = join(runDir, 'hardlink');
  await link(path, alternate);
  assert.equal(await client.probe(), false);
  assert.equal(alternate, join(runDir, 'hardlink'));
  await unlink(alternate);
  assert.equal(await client.probe(), true);

  // Replace the path with another listener. The first worker's net.Server
  // binds elsewhere and its cleanup must preserve the replacement inode.
  assert.equal(path, join(runDir, 'viewer.sock'));
  await unlink(path);
  const replacement = createServer((socket) => socket.destroy());
  t.after(() => new Promise((resolve) => replacement.close(resolve)));
  await new Promise((resolve, reject) => {
    replacement.once('error', reject);
    replacement.listen(path, resolve);
  });
  await chmod(path, 0o600);
  const replacementInode = (await lstat(path, { bigint: true })).ino;
  await server.close();
  assert.equal((await lstat(path, { bigint: true })).ino, replacementInode);
  assert.equal(await client.probe(), false);
});

test('invalid raw frames and pipelined commands reach zero native starts', linux, async (t) => {
  const { runDir, start } = await fixture(t);
  const fake = fakeNative();
  await start(fake.openNative);
  for (const frame of [
    rawFrame('{"type":"probe","type":"probe"}'),
    rawFrame('{"type":"probe"}{}'),
    rawFrame('{"type":"open","text":"x","cols":24,"rows":4,"argv":[]}'),
    rawFrame('{"type":"input","key":"quit"}'),
    rawFrame('{"type":"shell","argv":[]}'),
    Buffer.alloc(4),
    Buffer.from([0xff, 0xff, 0xff, 0xff]),
    Buffer.concat([encodeFrame({ type: 'open', ...options }), encodeFrame({ type: 'probe' })]),
  ]) {
    const { socket, closed } = await raw(runDir);
    socket.write(frame);
    await closed;
  }
  assert.equal(fake.state.started, 0);

  const { socket, closed } = await raw(runDir);
  const frame = encodeFrame({ type: 'probe' });
  for (const byte of frame) socket.write(Buffer.from([byte]));
  const [response] = await once(socket, 'data');
  assert.deepEqual(JSON.parse(response.subarray(4)), { type: 'probe-ok' });
  socket.destroy();
  await closed;
  assert.equal(fake.state.started, 1);
  assert.equal(fake.state.cleaned, 1);
});

test('native startup, active children and orphaned starts share the four-slot cap', linux, async (t) => {
  const { client, start } = await fixture(t);
  const fake = fakeNative();
  let unblock;
  let started = 0;
  let revoked = 0;
  const hold = new Promise((resolve) => { unblock = resolve; });
  const server = await start(async (input) => {
    started++;
    if (started <= 4) {
      input.signal.addEventListener('abort', () => { revoked++; }, { once: true });
      await hold;
    }
    return fake.openNative(input);
  });
  try {
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    const starts = controllers.map(({ signal }) => client.open(request({ signal })));
    const settled = Promise.allSettled(starts);
    await eventually(() => started === 4);
    await assert.rejects(client.open(request()), /connection lost/);
    for (const controller of controllers) controller.abort();
    assert((await settled).every(({ status }) => status === 'rejected'));
    await eventually(() => revoked === 4);
    // The cancelled launches remain counted until their late result is disposed.
    await assert.rejects(client.open(request()), /connection lost/);
    assert.equal(started, 4);
    unblock();
    await eventually(() => fake.state.cleaned === 4);
    const viewers = await Promise.all(Array.from({ length: 4 }, () => client.open(request())));
    assert.equal(fake.state.active, 4);
    await assert.rejects(client.open(request()), /connection lost/);
    await Promise.all(viewers.map((view) => view.dispose()));
    assert.equal(fake.state.active, 0);
    await server.close();
    assert.equal(fake.state.cleaned, 8);
  } finally {
    unblock();
  }
});

test('abrupt peer death revokes an owned viewer and its blocked native command', linux, async (t) => {
  const { runDir, start } = await fixture(t);
  const fake = fakeNative({ hook: ({ signal }) => new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })) });
  const server = await start(fake.openNative);
  const moduleUrl = new URL('../src/client.mjs', import.meta.url).href;
  const peer = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createTerminalClient } from ${JSON.stringify(moduleUrl)};
    const viewer = await createTerminalClient({ runDir: process.argv[1] }).open({
      text: 'fixed fixture', cols: 24, rows: 4, onScreen() {}, onExit() {},
    });
    await viewer.input('down');
  `, runDir], { stdio: 'ignore' });
  const exited = once(peer, 'exit');
  t.after(() => { if (peer.exitCode === null && peer.signalCode === null) peer.kill('SIGKILL'); });
  await eventually(() => fake.state.calls.includes('down'));
  peer.kill('SIGKILL');
  assert.deepEqual(await exited, [null, 'SIGKILL']);
  await eventually(() => fake.state.cleaned === 1);
  assert.equal(fake.state.aborted, 1);
  assert.equal(fake.state.active, 0);
  await server.close();
  assert.deepEqual(await readdir(runDir), []);
});

test('a blocked reader is revoked when bounded response pressure exceeds its budget', linux, async (t) => {
  const { runDir, start } = await fixture(t);
  const line = 'a' + '\u0301'.repeat(32_767);
  const fake = fakeNative({ hook: ({ onScreen, screen }) => {
    for (let i = 0; i < 12; i++) onScreen({ ...screen(), totalLines: 1, lines: [line] });
  } });
  await start(fake.openNative);
  const { socket, closed } = await raw(runDir);
  t.after(() => socket.destroy());
  socket.write(encodeFrame({ type: 'open', ...options }));
  const [response] = await once(socket, 'data');
  assert.match(response.toString(), /open-ok/);
  socket.pause();
  socket.write(encodeFrame({ type: 'input', key: 'down' }));
  await eventually(() => fake.state.cleaned === 1);
  assert.equal(fake.state.aborted, 1);
  assert.equal(fake.state.active, 0);
  socket.resume();
  await closed;
  assert(Buffer.byteLength(line) < MAX_FRAME_BYTES);
});

test('missing native readiness is false, and a real native engine completes the same probe when installed', linux, async (t) => {
  const { client, start } = await fixture(t);
  const bad = await start(async () => { throw Error('fixture native launch failed'); });
  assert.equal(await client.probe(), false);
  await bad.close();
  const require = createRequire(new URL('../src/native.mjs', import.meta.url));
  try { require.resolve('@lydell/node-pty'); } catch { return t.skip('locked native addon is absent'); }
  const server = await start();
  assert.equal(await client.probe(), true);
  const actual = [];
  const view = await client.open(request({ onScreen: (screen) => actual.push(screen), onExit: (exit) => actual.push(exit) }));
  await view.resize(32, 5);
  await view.input('down');
  assert.equal(actual[0].rows, 5);
  assert.equal(actual[1].top, 1);
  await view.input('quit');
  assert.deepEqual(actual[2], { code: 0, signal: null, reason: 'quit' });
  await server.close();
});

test('a command deadline closes the peer and disposes a blocked native operation', { skip: process.platform !== 'linux', timeout: COMMAND_MS + 3_000 }, async (t) => {
  const { client, start } = await fixture(t);
  const exits = [];
  const fake = fakeNative({ hook: ({ signal }) => new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })) });
  await start(fake.openNative);
  const view = await client.open(request({ onExit: (exit) => exits.push(exit) }));
  await assert.rejects(view.input('down'), /connection lost/);
  assert.deepEqual(exits, [{ code: null, signal: null, reason: 'worker-lost' }]);
  await eventually(() => fake.state.cleaned === 1);
  assert.equal(fake.state.active, 0);
});
