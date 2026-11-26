import assert from 'node:assert/strict';
import { chmod, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createTerminalClient } from '../src/client.mjs';
import { createSocketChannel } from '../src/socket-channel.mjs';
import { encodeFrame, isRequest, MAX_PENDING_FRAMES } from '../src/protocol.mjs';

const screen = { cols: 24, rows: 4, top: 0, left: 0, totalLines: 1, lines: ['fixed fixture'] };
const opened = { type: 'open-ok', screen };
const ignored = () => {};
const lost = { code: null, signal: null, reason: 'worker-lost' };
const linux = { skip: process.platform !== 'linux', timeout: 5_000 };
const args = (options = {}) => ({ text: 'fixed fixture', cols: 24, rows: 4, onScreen: ignored, onExit: ignored, ...options });

async function fixture(t, react) {
  const prefix = join(tmpdir(), 'deva-client-');
  const runDir = await mkdtemp(prefix);
  assert(runDir.startsWith(prefix) && runDir.length === prefix.length + 6);
  const sockets = new Set();
  const requests = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    const channel = createSocketChannel(socket, {
      validate: isRequest,
      onMessage(value) {
        requests.push(value);
        react({ value, channel, socket });
      },
      onClose: () => sockets.delete(socket),
    });
  });
  t.after(async () => {
    try {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });
  const path = join(runDir, 'viewer.sock');
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  await chmod(path, 0o600);
  return { client: createTerminalClient({ runDir }), runDir, requests };
}

test('the distro copy has only the client dependency closure', linux, async (t) => {
  const { runDir } = await fixture(t, ({ value, channel }) => {
    if (value.type === 'probe') channel.send({ type: 'probe-ok' });
  });
  for (const name of ['client.mjs', 'protocol.mjs', 'socket-path.mjs', 'socket-channel.mjs']) {
    await copyFile(new URL(`../src/${name}`, import.meta.url), join(runDir, name));
  }
  const copy = await import(pathToFileURL(join(runDir, 'client.mjs')));
  assert.equal(await copy.createTerminalClient({ runDir }).probe(), true);
});

test('coalesced post-open events follow the single returned initial screen', linux, async (t) => {
  const exit = { code: 2, signal: null, reason: 'fault' };
  const updated = { ...screen, lines: ['later'] };
  const { client } = await fixture(t, ({ socket }) => {
    socket.end(Buffer.concat([encodeFrame(opened), encodeFrame({ type: 'screen', screen: updated }), encodeFrame({ type: 'exit', exit })]));
  });
  const events = [];
  const view = await client.open(args({ onScreen: (value) => events.push(value), onExit: (value) => events.push(value) }));
  assert.deepEqual(view.screen, screen);
  assert.deepEqual(events, []);
  await Promise.resolve();
  assert.deepEqual(events, [updated, exit]);
  await view.dispose();
  await assert.rejects(view.input('down'), /connection lost/);
});

test('wrong ACK, missing native exit and fabricated worker-lost each close without replay', linux, async (t) => {
  const modes = [
    { key: 'down', reply: { type: 'ack', op: 'resize' } },
    { key: 'quit', reply: { type: 'ack', op: 'input' } },
    { key: 'down', reply: { type: 'exit', exit: lost } },
  ];
  for (const { key, reply } of modes) {
    const exits = [];
    const { client, requests } = await fixture(t, ({ value, channel }) => channel.send(value.type === 'open' ? opened : reply));
    const view = await client.open(args({ onExit: (event) => exits.push(event) }));
    await assert.rejects(view.input(key), /connection lost/);
    await assert.rejects(view.input('up'), /connection lost/);
    assert.deepEqual(exits, [lost]);
    assert.deepEqual(requests.map(({ type }) => type), ['open', 'input']);
  }
});

test('typed validation happens before dial and outbound queue pressure revokes the viewer', linux, async (t) => {
  const { client, requests } = await fixture(t, ({ value, channel }) => {
    if (value.type === 'open') channel.send(opened);
  });
  await assert.rejects(client.open(args({ text: 'x'.repeat(65_537) })), /Invalid terminal open/);
  await assert.rejects(client.open(args({ cwd: '/extra' })), /Invalid terminal open/);
  assert.equal(requests.length, 0);
  const exits = [];
  const view = await client.open(args({ onExit: (event) => exits.push(event) }));
  const operations = Array.from({ length: MAX_PENDING_FRAMES + 1 }, () => view.input('down'));
  assert((await Promise.allSettled(operations)).every(({ status }) => status === 'rejected'));
  assert.deepEqual(exits, [lost]);
  assert(requests.length <= 2);
});

test('abort after open revokes the connection and reports transport loss exactly once', linux, async (t) => {
  const { client } = await fixture(t, ({ value, channel }) => {
    if (value.type === 'open') channel.send(opened);
  });
  const controller = new AbortController();
  const exits = [];
  const view = await client.open(args({ signal: controller.signal, onExit: (event) => exits.push(event) }));
  const pending = view.input('down');
  controller.abort();
  await assert.rejects(pending, /connection lost/);
  assert.deepEqual(exits, [lost]);
  await assert.rejects(view.dispose(), /connection lost/);
  assert.equal(await client.probe({ signal: controller.signal }), false);
});
