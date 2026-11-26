import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { openWorkerClient, WorkerControlError } from '../src/client.mjs';
import { startWorker } from '../src/worker.mjs';

const siteRows = [
  { id: 'alpha', label: 'Alpha', url: 'https://alpha.example.test/start' },
  { id: 'beta', label: 'Beta', url: 'https://beta.example.test/private/start' },
];
const errorCode = (code) => (error) => error instanceof WorkerControlError && error.code === code && error.message === code;
const onlyStatus = '{"op":"status","args":{}}\n';
const textAction = { type: 'text', text: 'private input value' };
const click = { type: 'click', x: 21, y: 34 };
const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000400000003000806000000000000000000000049454e44ae426082', 'hex');
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function listen(path, handler = (socket) => socket.destroy()) {
  const server = createServer({ allowHalfOpen: true }, handler);
  server.listen({ path });
  await once(server, 'listening');
  await chmod(path, 0o600);
  return server;
}

async function stop(server) {
  if (server.listening) await new Promise((resolve) => server.close(resolve));
}

function raw(path, payload, end = true) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path, allowHalfOpen: true });
    const buffers = [];
    const timer = setTimeout(() => socket.destroy(new Error('fixture request timeout')), 4_000);
    socket.once('connect', () => (end ? socket.end(payload) : socket.write(payload)));
    socket.on('data', (chunk) => buffers.push(chunk));
    socket.once('end', () => socket.end());
    socket.once('error', (error) => { if (!['ECONNRESET', 'EPIPE'].includes(error.code)) reject(error); });
    socket.once('close', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(buffers).toString());
    });
  });
}

async function until(condition) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await condition()) return;
    await delay(10);
  }
  assert.fail('condition never became true');
}

async function fixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'dbw-'));
  const runDir = join(root, 'run'), egressDir = join(root, 'egr');
  const path = join(runDir, 'worker.sock'), egressSocket = join(egressDir, 'egress.sock');
  await mkdir(egressDir, { mode: 0o700 });
  const egress = await listen(egressSocket);
  const browsers = [], probes = [], proxies = [], workers = [];
  let healthy = true;
  const opts = {
    sites: siteRows, runDir, egressSocket, executablePath: '/fixture/chromium', egressCheckMs: 20,
    egressProbe: async (probePath) => { assert.equal(probePath, egressSocket); return healthy; },
    proxyFactory: async (args) => {
      assert.deepEqual(args, { socketPath: egressSocket, host: '127.0.0.1', port: 0 });
      const state = { closed: 0 };
      proxies.push(state);
      return { url: 'http://127.0.0.1:23456', close() { state.closed++; } };
    },
    engineProbe: async (args) => {
      assert.deepEqual(Object.keys(args).sort(), ['executablePath', 'proxyUrl', 'signal']);
      assert.equal(args.executablePath, '/fixture/chromium');
      assert.equal(args.proxyUrl, 'http://127.0.0.1:23456');
      probes.push(args);
      return { available: true };
    },
    engineFactory: async (args) => {
      const state = { args, closed: 0, active: false, inputs: [], frames: 0, privacy: [] };
      browsers.push(state);
      return {
        close() { state.closed++; },
        getPageInfo() { return { origin: new URL(args.startUrl).origin, title: 'do not expose fixture title' }; },
        setInputPrivacy(active) { state.privacy.push(active); state.active = active; },
        dispatchInput(action) { assert.equal(state.active, true); state.inputs.push(action); },
        async captureFrame(options) {
          assert.deepEqual(options, { privateView: true });
          assert.equal(state.active, true);
          state.frames++;
          await state.onFrame?.();
          return { mimeType: 'image/png', width: 1024, height: 768, bytes: png };
        },
      };
    },
  };
  t.after(async () => {
    await Promise.allSettled(workers.map((worker) => worker.close()));
    await stop(egress);
    await rm(root, { recursive: true, force: true });
  });
  return { root, runDir, path, egress, egressSocket, opts, browsers, probes, proxies,
    setHealthy(value) { healthy = value; },
    async start(options = {}) {
      const worker = await startWorker({ ...opts, ...options });
      workers.push(worker);
      return worker;
    },
    client() { return openWorkerClient({ runDir }); },
  };
}

const tabArgs = (sid, tab) => ({ sid, tabId: tab.tabId });
async function authorize(client, sid, tab) {
  const target = tabArgs(sid, tab);
  return { ...target, ...await client.startPrivacy(target) };
}

test('private Unix API probes readiness, opens a real fixture page and gates each action by tab and control ID', async (t) => {
  const f = await fixture(t);
  const worker = await f.start();
  const client = f.client();
  assert.equal(worker.path, f.path);
  const endpoint = await lstat(f.path);
  assert.equal(endpoint.isSocket(), true);
  assert.equal(endpoint.mode & 0o7777, 0o600);
  assert.equal(endpoint.uid, process.geteuid());
  assert.equal((await lstat(f.runDir)).mode & 0o7777, 0o700);
  assert.deepEqual(await client.sites(), [
    { id: 'alpha', label: 'Alpha', origin: 'https://alpha.example.test' },
    { id: 'beta', label: 'Beta', origin: 'https://beta.example.test' },
  ]);
  assert.equal(f.probes.length, 0);
  assert.deepEqual(await client.status(), { state: 'ready' });
  assert.deepEqual(await client.status(), { state: 'ready' });
  assert.equal(f.probes.length, 1);
  assert.equal(f.browsers.length, 0);
  await assert.rejects(client.open({ sid: 'sid-1', siteId: 'not-approved' }), errorCode('UNKNOWN_SITE'));
  assert.equal(f.browsers.length, 0);
  const tab = await client.open({ sid: 'sid-1', siteId: 'alpha' });
  const target = tabArgs('sid-1', tab);
  const state = f.browsers[0];
  assert.deepEqual({ ...state.args, signal: undefined }, { executablePath: '/fixture/chromium',
    startUrl: siteRows[0].url, allowedUrls: [siteRows[0].url], proxyUrl: 'http://127.0.0.1:23456', signal: undefined });
  await assert.rejects(client.input({ ...target, controlId: 'A'.repeat(24), action: click }), errorCode('CONTROL_REQUIRED'));
  const control = await authorize(client, 'sid-1', tab);
  assert.deepEqual(state.privacy, [true]);
  await assert.rejects(client.startPrivacy(target), errorCode('BUSY'));
  await assert.rejects(client.frame({ ...control, sid: 'different-sid' }), errorCode('TAB_NOT_FOUND'));
  await assert.rejects(client.endPrivacy({ ...control, controlId: 'B'.repeat(24) }), errorCode('CONTROL_REQUIRED'));
  assert.deepEqual(await client.frame(control), { mimeType: 'image/png', width: 1024, height: 768, bytes: png });
  assert.deepEqual(await client.input({ ...control, action: textAction }), { accepted: true });
  assert.deepEqual(await client.input({ ...control, action: click }), { accepted: true });
  assert.deepEqual(state.inputs, [textAction, click]);
  assert.deepEqual(await client.endPrivacy(control), { released: true });
  assert.deepEqual(state.privacy, [true, false]);
  await assert.rejects(client.frame(control), errorCode('CONTROL_REQUIRED'));
  const second = await authorize(client, 'sid-1', tab);
  assert.notEqual(second.controlId, control.controlId);
  assert.deepEqual(await client.release(target), { released: true });
  await assert.rejects(client.input({ ...second, action: click }), errorCode('CONTROL_REQUIRED'));
  assert.deepEqual(await readdir(f.runDir), ['worker.sock']);
  assert.deepEqual(await client.closeTab(target), { closed: true });
  assert.equal(state.closed, 1);
  await assert.rejects(client.startPrivacy(target), errorCode('TAB_NOT_FOUND'));
  await Promise.all([worker.close(), worker.close()]);
  assert.deepEqual(await readdir(f.runDir), []);
  assert.equal(f.proxies[0].closed, 1);
});

test('socket refuses existing objects, stale sockets and symlinks; replacing its pathname never redirects or deletes', async (t) => {
  const f = await fixture(t);
  await mkdir(f.runDir, { mode: 0o700 });
  await chmod(f.runDir, 0o750);
  await assert.rejects(f.start(), errorCode('CONTROL_FAILED'));
  await chmod(f.runDir, 0o700);
  await writeFile(f.path, 'existing object', { flag: 'wx' });
  await assert.rejects(f.start(), errorCode('CONTROL_FAILED'));
  assert.equal(await readFile(f.path, 'utf8'), 'existing object');
  await unlink(f.path);
  const alias = join(f.root, 'alias');
  await symlink(f.runDir, alias);
  await assert.rejects(f.start({ runDir: alias }), errorCode('CONTROL_FAILED'));
  await symlink(f.egressSocket, f.path);
  await assert.rejects(f.start(), errorCode('CONTROL_FAILED'));
  await assert.rejects(f.client().status(), errorCode('CONTROL_FAILED'));
  await unlink(f.path);

  const stale = await listen(f.path);
  await assert.rejects(f.start(), errorCode('CONTROL_FAILED'));
  const aside = join(f.runDir, 'original');
  await rename(f.path, aside);
  await stop(stale);
  await rename(aside, f.path); // The socket inode exists, but no listener owns it anymore.
  await assert.rejects(f.start(), errorCode('CONTROL_FAILED'));
  assert.equal((await lstat(f.path)).isSocket(), true);
  await unlink(f.path);

  const worker = await f.start();
  const client = f.client();
  assert.deepEqual(await client.status(), { state: 'ready' });
  await chmod(f.path, 0o660);
  await assert.rejects(client.status(), errorCode('CONTROL_FAILED'));
  assert.equal(await raw(f.path, onlyStatus), '');
  await unlink(f.path);
  let foreignCalls = 0;
  const replacement = await listen(f.path, (socket) => {
    foreignCalls++;
    socket.destroy();
  });
  try {
    const inode = (await lstat(f.path)).ino;
    await assert.rejects(client.status(), errorCode('CONTROL_FAILED'));
    await worker.close();
    assert.equal((await lstat(f.path)).ino, inode);
    assert.equal(foreignCalls, 0);
  } finally { await stop(replacement); }
  const fresh = await f.start();
  try {
    await assert.rejects(client.status(), errorCode('CONTROL_FAILED'));
    assert.deepEqual(await f.client().status(), { state: 'ready' });
  } finally { await fresh.close(); }
});

test('pins the run directory for I/O and for unlink, even if its name is replaced', async (t) => {
  const f = await fixture(t);
  const worker = await f.start();
  const client = f.client();
  await client.sites();
  const moved = join(f.root, 'moved');
  await rename(f.runDir, moved);
  await mkdir(f.runDir, { mode: 0o700 });
  const alternate = await listen(f.path);
  try {
    await assert.rejects(client.sites(), errorCode('CONTROL_FAILED'));
    assert.equal(await raw(join(moved, 'worker.sock'), onlyStatus), '');
    const inode = (await lstat(f.path)).ino;
    await worker.close();
    assert.equal((await lstat(f.path)).ino, inode);
    assert.deepEqual(await readdir(moved), []);
  } finally { await stop(alternate); }
});

test('bounded canonical protocol rejects duplicate or arbitrary fields, bad actions and incomplete messages', async (t) => {
  const f = await fixture(t);
  await f.start();
  const client = f.client();
  const tab = await client.open({ sid: 'sid', siteId: 'alpha' });
  const control = await authorize(client, 'sid', tab);
  const invalid = '{"ok":false,"code":"INVALID_REQUEST"}\n';
  const wire = (op, args) => `${JSON.stringify({ op, args })}\n`;
  const bad = [
    wire('navigate', { ...control, url: 'https://elsewhere.example.test/' }),
    wire('dispatch', { ...control, method: 'Runtime.evaluate' }),
    wire('open', { sid: 'sid', siteId: 'alpha', url: siteRows[0].url }),
    wire('open', { sid: 'sid', siteId: 'alpha', executablePath: '/tmp/path' }),
    wire('frame', { ...control, selector: 'body' }),
    wire('input', { ...control, action: { type: 'key', key: 'F12' } }),
    wire('input', { ...control, action: { type: 'key', key: 'Tab', modifiers: 1 } }),
    wire('input', { ...control, action: { ...click, x: 1024 } }),
    wire('input', { ...control, action: { ...click, button: 'right' } }),
    wire('input', { ...control, action: { type: 'scroll', x: 1, y: 2, deltaX: 2049, deltaY: 0 } }),
    wire('input', { ...control, action: { type: 'text', text: 'x'.repeat(1025) } }),
    wire('input', { ...control, action: { type: 'text', text: 'x\u0001' } }),
    onlyStatus + onlyStatus,
    '{"op":"status","op":"sites","args":{}}\n',
    '{"op":"status","args":{"__proto__":{}}}\n',
    Buffer.from([0xff, 0x0a]),
    Buffer.alloc(16_384, 0x61),
  ];
  for (const payload of bad) assert.equal(await raw(f.path, payload), invalid);
  assert.equal(await raw(f.path, onlyStatus.slice(0, -1), false), '');
  assert.deepEqual(f.browsers[0].inputs, []);
  assert.equal(f.browsers[0].frames, 0);
  assert.deepEqual(await client.input({ ...control, action: { type: 'key', key: 'ArrowLeft' } }), { accepted: true });
});

test('reports unconfigured, egress, missing binary and actual startup verdicts without site traffic', async (t) => {
  const f = await fixture(t);
  let worker = await f.start({ sites: [] });
  assert.deepEqual(await f.client().status(), { state: 'unconfigured' });
  await worker.close();
  worker = await f.start({ egressSocket: join(f.root, 'absent.sock') });
  assert.deepEqual(await f.client().status(), { state: 'egress-unavailable' });
  await worker.close();
  worker = await f.start({ executablePath: 'chromium' });
  assert.deepEqual(await f.client().status(), { state: 'binary-missing' });
  await worker.close();
  // Exercise the product binary path check without loading an engine or starting Chromium.
  worker = await f.start({ engineProbe: undefined, engineFactory: undefined });
  assert.deepEqual(await f.client().status(), { state: 'binary-missing' });
  await worker.close();
  worker = await f.start({ engineProbe: async () => { throw Object.assign(new Error('hidden diagnostic'), { code: 'BROWSER_SANDBOX_REQUIRED' }); } });
  assert.deepEqual(await f.client().status(), { state: 'sandbox-startup-failure' });
  await assert.rejects(f.client().open({ sid: 'sid', siteId: 'alpha' }), errorCode('WORKER_UNAVAILABLE'));
  assert.equal(f.browsers.length, 0);
});

test('enforces session and startup concurrency; page failures do not advertise a tab', async (t) => {
  const f = await fixture(t);
  const startup = deferred(), entered = deferred();
  await f.start({ maxSessions: 2, maxConcurrentOpens: 1,
    async engineFactory(args) {
      if (args.startUrl === siteRows[0].url) { entered.resolve(); await startup.promise; }
      return f.opts.engineFactory(args);
    },
  });
  const client = f.client();
  await client.status();
  const firstOpen = client.open({ sid: 'first', siteId: 'alpha' });
  await entered.promise;
  try {
    await assert.rejects(client.open({ sid: 'first', siteId: 'beta' }), errorCode('BUSY'));
    await assert.rejects(client.open({ sid: 'second', siteId: 'beta' }), errorCode('BUSY'));
    assert.equal(f.browsers.length, 0);
  } finally { startup.resolve(); }
  const first = await firstOpen;
  await client.open({ sid: 'second', siteId: 'beta' });
  await assert.rejects(client.open({ sid: 'third', siteId: 'beta' }), errorCode('SESSION_LIMIT'));
  await client.closeTab(tabArgs('first', first));
  assert.ok((await client.open({ sid: 'third', siteId: 'beta' })).tabId);
});

test('a rejected or wrong-target engine produces no fake tab, and a SID can retry', async (t) => {
  const f = await fixture(t);
  let attempts = 0;
  await f.start({ async engineFactory(args) {
    if (++attempts === 1) throw Error('sensitive internal fixture detail');
    const engine = await f.opts.engineFactory(args);
    if (attempts === 2) return { ...engine, getPageInfo: () => ({ origin: 'https://other.example.test' }) };
    return engine;
  } });
  const client = f.client();
  await assert.rejects(client.open({ sid: 'sid', siteId: 'alpha' }), errorCode('ENGINE_FAILURE'));
  await assert.rejects(client.open({ sid: 'sid', siteId: 'alpha' }), errorCode('ENGINE_FAILURE'));
  await until(() => f.browsers[0].closed === 1);
  const tab = await client.open({ sid: 'sid', siteId: 'alpha' });
  assert.ok(tab.tabId);
});

test('release invalidates an in-flight frame; a successful site swap invalidates the old target', async (t) => {
  const f = await fixture(t);
  await f.start();
  const client = f.client();
  const tab = await client.open({ sid: 'sid', siteId: 'alpha' });
  const control = await authorize(client, 'sid', tab);
  const completed = deferred(), entered = deferred();
  f.browsers[0].onFrame = async () => { entered.resolve(); await completed.promise; };
  const receiveFrame = assert.rejects(client.frame(control), errorCode('CONTROL_REQUIRED'));
  await entered.promise;
  const released = client.endPrivacy(control);
  try {
    await until(async () => {
      try { await client.input({ ...control, action: click }); }
      catch (error) { return error.code === 'CONTROL_REQUIRED'; }
      return false;
    });
    assert.deepEqual(f.browsers[0].inputs, []);
  } finally { completed.resolve(); }
  await receiveFrame;
  await released;
  assert.deepEqual(f.browsers[0].privacy, [true, false]);
  const oldControl = await authorize(client, 'sid', tab);
  const switched = await client.open({ sid: 'sid', siteId: 'beta' });
  assert.notEqual(switched.tabId, tab.tabId);
  assert.equal(f.browsers[0].closed, 1);
  assert.equal(f.browsers[1].args.startUrl, siteRows[1].url);
  await assert.rejects(client.input({ ...oldControl, action: click }), errorCode('TAB_NOT_FOUND'));
  await assert.rejects(client.input({ ...oldControl, tabId: switched.tabId, action: click }), errorCode('CONTROL_REQUIRED'));
});

test('endPrivacy cannot report success if the exact page is replaced while privacy cleanup is pending', async (t) => {
  const f = await fixture(t);
  const disable = deferred(), disabling = deferred();
  await f.start({ async engineFactory(args) {
    const engine = await f.opts.engineFactory(args);
    return { ...engine, async setInputPrivacy(active) {
      if (!active) { disabling.resolve(); await disable.promise; }
      engine.setInputPrivacy(active);
    } };
  } });
  const client = f.client();
  const first = await client.open({ sid: 'sid', siteId: 'alpha' });
  const control = await authorize(client, 'sid', first);
  const release = assert.rejects(client.endPrivacy(control), errorCode('TAB_NOT_FOUND'));
  await disabling.promise;
  try {
    const second = await client.open({ sid: 'sid', siteId: 'beta' });
    assert.notEqual(second.tabId, first.tabId);
    assert.equal(f.browsers[0].closed, 1);
    await release;
  } finally { disable.resolve(); }
});

test('expires control, retires idle tabs and tears down on loss of egress', async (t) => {
  const f = await fixture(t);
  await f.start({ controlTtlMs: 75, tabTtlMs: 350 });
  const client = f.client();
  const first = await client.open({ sid: 'sid', siteId: 'alpha' });
  const token = await authorize(client, 'sid', first);
  await until(() => f.browsers[0].privacy.includes(false));
  await assert.rejects(client.input({ ...token, action: click }), errorCode('CONTROL_REQUIRED'));
  await until(() => f.browsers[0].closed === 1);
  await assert.rejects(client.startPrivacy(tabArgs('sid', first)), errorCode('TAB_NOT_FOUND'));

  const second = await client.open({ sid: 'sid', siteId: 'beta' });
  const secondToken = await authorize(client, 'sid', second);
  f.setHealthy(false);
  assert.deepEqual(await client.status(), { state: 'egress-unavailable' });
  await assert.rejects(client.input({ ...secondToken, action: click }), errorCode('TAB_NOT_FOUND'));
  assert.equal(f.browsers[1].closed, 1);
  assert.equal(f.proxies[0].closed, 1);
  f.setHealthy(true);
  assert.deepEqual(await client.status(), { state: 'ready' });
});

test('timeout bounds a stuck open; late engines are closed and never reused', async (t) => {
  const f = await fixture(t);
  const late = deferred();
  let signal;
  await f.start({ maxSessions: 1, startupTimeoutMs: 75, async engineFactory(args) {
    signal = args.signal;
    await late.promise;
    return f.opts.engineFactory(args);
  } });
  const client = f.client();
  await client.status();
  try {
    await assert.rejects(client.open({ sid: 'sid', siteId: 'alpha' }), errorCode('TIMED_OUT'));
    assert.equal(signal.aborted, true);
    await assert.rejects(client.open({ sid: 'other', siteId: 'beta' }), errorCode('SESSION_LIMIT'));
    assert.deepEqual(f.browsers, []);
  } finally { late.resolve(); }
  await until(() => f.browsers[0]?.closed === 1);
  const recovered = await client.open({ sid: 'other', siteId: 'beta' });
  assert.ok(recovered.tabId);
});

test('shutdown aborts startup, drains the late engine, and closes only resources it owns', async (t) => {
  const f = await fixture(t);
  const entered = deferred();
  let aborted = false;
  const worker = await f.start({ async engineFactory(args) {
    const cancellation = once(args.signal, 'abort');
    entered.resolve();
    await cancellation;
    aborted = true;
    return f.opts.engineFactory(args);
  } });
  const client = f.client();
  await client.status();
  const opening = assert.rejects(client.open({ sid: 'sid', siteId: 'alpha' }), (error) =>
    errorCode('CONTROL_FAILED')(error) || errorCode('WORKER_UNAVAILABLE')(error));
  await entered.promise;
  await worker.close();
  await opening;
  assert.equal(aborted, true);
  assert.equal(f.browsers[0].closed, 1);
  assert.equal(f.proxies[0].closed, 1);
  assert.equal(f.egress.listening, true);
  assert.deepEqual(await readdir(f.runDir), []);
});

test('a timed-out private capture retires only its tab', async (t) => {
  const f = await fixture(t);
  await f.start({ operationTimeoutMs: 100 });
  const client = f.client();
  const first = await client.open({ sid: 'first', siteId: 'alpha' });
  const second = await client.open({ sid: 'second', siteId: 'beta' });
  const firstControl = await authorize(client, 'first', first);
  const secondControl = await authorize(client, 'second', second);
  const completion = deferred();
  f.browsers[0].onFrame = () => completion.promise;
  try {
    await assert.rejects(client.frame(firstControl), errorCode('TIMED_OUT'));
    await until(() => f.browsers[0].closed === 1);
    await assert.rejects(client.input({ ...firstControl, action: click }), errorCode('TAB_NOT_FOUND'));
    assert.deepEqual(await client.input({ ...secondControl, action: click }), { accepted: true });
    assert.equal(f.browsers[1].closed, 0);
  } finally { completion.resolve(); }
});
