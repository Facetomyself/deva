import assert from 'node:assert/strict';
import { mkdtemp, readFile, rmdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openTerminalService } from '../../headless/src/terminal/service.mjs';
import { createTerminalClient } from '../src/client.mjs';
import { startTerminalServer } from '../src/server.mjs';
import {
  COMMAND_MS, IDLE_MS, LIFETIME_MS, MAX_FRAME_BYTES, MAX_PEERS,
  decodeFrame, encodeFrame, isRequest, isResponse, validScreen, validText,
} from '../src/protocol.mjs';

const decode = (text, validator = isRequest) => decodeFrame(Buffer.from(text), validator);

const validOpen = {
  type: 'open', text: 'text', cols: 24, rows: 4,
};

const screen = { cols: 24, rows: 4, top: 1, left: 3, totalLines: 6, lines: ['界😀', '', 'text'] };

test('canonical framed requests reject duplicate, extra, trailing or malformed content', () => {
  assert.deepEqual(decode(JSON.stringify(validOpen)), validOpen);
  for (const malformed of [
    '{"type":"probe","type":"probe"}', '{"type":"probe","typ\\u0065":"probe"}',
    '{"type":"probe"} ', '{"type":"probe"}{"type":"probe"}', '{"type":"probe",}',
    '{"type":"probe","__proto__":{}}', '{"type":"probe","path":"elsewhere"}',
    '{"type":"input","key":"\u001b"}', '{"type":"resize","cols":2.4e1,"rows":4}',
    'null', '[]', '"probe"', '\ufeff{"type":"probe"}',
  ]) assert.throws(() => decode(malformed), /Invalid terminal frame/);
  assert.throws(() => decodeFrame(Buffer.from([0xc0, 0xaf]), isRequest));
  assert.throws(() => decodeFrame(Buffer.alloc(MAX_FRAME_BYTES + 1), isRequest));
  assert.throws(() => encodeFrame('x'.repeat(MAX_FRAME_BYTES)));
});

test('64 KiB text, 4096 logical lines and escaped wire boundary', () => {
  const open = { ...validOpen, text: '\0'.repeat(65_536) };
  const frame = encodeFrame(open);
  assert(frame.length > 384 * 1024 && frame.length <= MAX_FRAME_BYTES + 4);
  assert.equal(frame.readUInt32BE(), frame.length - 4);
  assert.deepEqual(decodeFrame(frame.subarray(4), isRequest), open);
  assert.equal(validText('😀'.repeat(16_384)), true);
  assert.equal(validText('😀'.repeat(16_384) + 'x'), false);
  assert.equal(validText('\r\n'.repeat(4_095)), true);
  assert.equal(validText('\r\n'.repeat(4_096)), false);
  assert.equal(validText('\ud800'), false);
  assert.equal(validText(''), true);
  for (const value of [
    { ...validOpen, rows: 51 }, { ...validOpen, cols: 23 }, { ...validOpen, text: 14 },
    { type: 'input', key: 'escape' }, { type: 'input', key: ['up'] }, { type: 'dispose', reason: 'quit' },
  ]) assert.equal(isRequest(value), false);
  for (const key of ['up', 'down', 'page-up', 'page-down', 'home', 'end', 'left', 'right', 'quit']) {
    assert.equal(isRequest({ type: 'input', key }), true);
  }
});

test('screens, exits and ACKs admit only their typed shapes', () => {
  assert.equal(validScreen(screen), true);
  assert.equal(isResponse({ type: 'screen', screen }), true);
  assert.equal(validScreen({ ...screen, totalLines: 4_096, top: 4_095, left: 524_288 - screen.cols, lines: [''] }), true);
  for (const value of [
    { ...screen, nested: 1 }, { ...screen, left: -1 }, { ...screen, left: Infinity }, { ...screen, left: 524_288 - screen.cols + 1 },
    { ...screen, totalLines: 0 }, { ...screen, totalLines: 4_097 }, { ...screen, top: 6 }, { ...screen, top: Infinity },
    { ...screen, top: 4 }, { ...screen, lines: [] }, { ...screen, lines: ['\u001b[1m'] }, { ...screen, lines: ['\u202e'] },
    { ...screen, lines: ['a', 'b', 'c', 'd', 'e'] }, { ...screen, lines: [1] }, { ...screen, lines: Array(1) },
  ]) assert.equal(validScreen(value), false);
  const line = `x${'\u0301'.repeat(24_575)} `;
  assert.equal(Buffer.byteLength(line + line), 96 * 1024);
  const exact = { type: 'screen', screen: { ...screen, lines: [line, line] } };
  assert.deepEqual(decodeFrame(encodeFrame(exact).subarray(4), isResponse), exact);
  assert.equal(isResponse({ type: 'screen', screen: { ...screen, lines: [line, `${line}x`] } }), false);
  assert.equal(isResponse({ type: 'exit', exit: { code: null, signal: 1, reason: 'disposed' } }), true);
  assert.equal(isResponse({ type: 'exit', exit: { code: 17, signal: 9, reason: 'fault' } }), true);
  assert.equal(isResponse({ type: 'exit', exit: { code: null, signal: null, reason: 'worker-lost' } }), false);
  assert.equal(isResponse({ type: 'exit', exit: { code: 17, signal: 9, reason: 'worker-lost' } }), false);
  assert.equal(isResponse({ type: 'exit', exit: { code: 1.5, signal: 0, reason: 'fault' } }), false);
  assert.equal(isResponse({ type: 'ack', op: 'resize' }), true);
  assert.equal(isResponse({ type: 'ack', op: 'open' }), false);
  assert.equal(MAX_PEERS, 4);
  assert(COMMAND_MS <= 10_000);
  assert(IDLE_MS <= 120_000);
  assert(LIFETIME_MS <= 600_000);
});

test('a real 64 KiB native snapshot stays readable after tab expansion across IPC, service and UI', {
  skip: process.platform !== 'linux' || process.getuid?.() === 0 || !['arm64', 'x64'].includes(process.arch), timeout: 10_000,
}, async (t) => {
  const grapheme = `a${'\u0301'.repeat(32_767)}`;
  const text = `${grapheme}\t`;
  assert.equal(Buffer.byteLength(text), 65_536);
  const runDir = await mkdtemp(join(tmpdir(), 'deva-display-'));
  let server, service;
  t.after(async () => {
    try { await service?.close(); await server?.close(); } finally { await rmdir(runDir); }
  });
  server = await startTerminalServer({ runDir });
  service = openTerminalService({
    auth: { isLoginActive: () => true, onSessionRevoked: () => () => {} },
    worker: createTerminalClient({ runDir }),
    openSource: () => ({ text, verify: () => true, close() {} }),
  });
  const require = createRequire(new URL('../../desktop/package.json', import.meta.url));
  const ts = require('typescript');
  const { outputText } = ts.transpileModule(await readFile(new URL('../../desktop/src/workbench/terminal-view-transport.ts', import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  const { createTerminalViewTransport } = await import(`data:text/javascript,${encodeURIComponent(outputText)}`);
  const actor = { role: 'owner', ownerId: 'owner', loginSessionId: 'login' };
  const workspaceId = `w_${'a'.repeat(32)}`;
  const api = createTerminalViewTransport({ async request(path, method, body) {
    assert.equal(method, 'POST');
    const prefix = `/workspaces/${workspaceId}/terminals`;
    const receipt = path === prefix ? await service.start(actor, workspaceId, body)
      : await service.events(actor, workspaceId, /^\/([^/]+)\/events$/u.exec(path.slice(prefix.length))[1], body);
    return JSON.parse(JSON.stringify(receipt));
  } }, 'owner-csrf');
  const size = { cols: 24, rows: 4 };
  const view = await api.start({ workspaceId, path: 'snapshot.txt', revision: `r_${'b'.repeat(64)}` }, size);
  assert.equal(Buffer.byteLength(view.screen.lines[0]), 65_542);
  assert.deepEqual(view.screen, { ...size, top: 0, left: 0, totalLines: 1, lines: [`${grapheme}${' '.repeat(7)}`] });
  assert.deepEqual(await api.events(workspaceId, view.id, 0, 0, new AbortController().signal), {
    cursor: 1, reset: false, events: [{ seq: 1, type: 'screen', screen: view.screen }],
  });
});
