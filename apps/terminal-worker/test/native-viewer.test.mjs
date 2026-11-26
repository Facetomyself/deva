import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { openNativeViewer } from '../src/native.mjs';

const exec = promisify(execFile);
const ROOT = '/dev/shm';
const PREFIX = 'deva-terminal-viewer-';
const VIEWER = fileURLToPath(new URL('../src/viewer.mjs', import.meta.url));
const PRIVATE = 'synthetic-snapshot-private-456';
const invalid = { code: 'terminal_invalid', message: 'Invalid terminal viewer request.' };
const unavailable = { code: 'terminal_unavailable', message: 'Terminal viewer unavailable.' };

function tempEntries() {
  return readdirSync(ROOT).filter((name) => name.startsWith(PREFIX)).sort();
}

function ownedViewers() {
  const children = readFileSync(`/proc/self/task/${process.pid}/children`, 'utf8').trim();
  if (children === '') return [];
  return children.split(/\s+/).flatMap((pid) => {
    try {
      const proc = `/proc/${pid}`;
      const cwd = readlinkSync(`${proc}/cwd`);
      if (cwd.startsWith(`${ROOT}/${PREFIX}`)) return [{ pid: Number(pid), proc, cwd }];
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error;
    }
    return [];
  });
}

function onlyViewer() {
  const children = ownedViewers();
  assert.equal(children.length, 1);
  return children[0];
}

function untilExit(t) {
  let observe;
  const seen = new Promise((resolve) => { observe = resolve; });
  const events = [];
  const deadline = setTimeout(() => observe(null), 4_000);
  t.after(() => clearTimeout(deadline));
  return {
    events, seen,
    onExit(event) {
      events.push(event);
      clearTimeout(deadline);
      observe(event);
    },
  };
}

const entries = Array.from({ length: 44 }, (_, i) => `第${i}行`);
const fixture = entries.join('\n');

function viewport(options = {}) {
  return openNativeViewer({ text: fixture, cols: 24, rows: 4, ...options });
}

test('real Node child certifies three TTYs and confirms key/resize before acknowledgement', async (t) => {
  const output = [];
  const exit = untilExit(t);
  const viewer = await viewport({ onScreen: (screen) => { output.push(screen); }, onExit: exit.onExit });
  t.after(() => viewer.dispose());
  assert.deepEqual(Object.keys(viewer).sort(), ['dispose', 'input', 'resize', 'screen']);
  assert.deepEqual(viewer.screen, { cols: 24, rows: 4, top: 0, left: 0, totalLines: 44, lines: entries.slice(0, 4) });
  assert.deepEqual(output, []);
  const { proc, cwd } = onlyViewer();
  const [tty, out, err] = [0, 1, 2].map((fd) => readlinkSync(`${proc}/fd/${fd}`));
  assert.match(tty, /^\/dev\/pts\/\d+$/);
  assert.equal(tty, out);
  assert.equal(tty, err);
  assert.deepEqual(readFileSync(`${proc}/cmdline`, 'utf8').split('\0'), [process.execPath, '--no-addons', VIEWER, '']);
  assert.deepEqual(readFileSync(`${proc}/environ`, 'utf8').split('\0').filter(Boolean).sort(),
    ['HOME=/', 'LANG=C.UTF-8', 'PATH=/usr/bin:/bin', `PWD=${cwd}`, 'TERM=dumb'].sort());
  assert.equal(lstatSync(cwd).mode & 0o7777, 0o700);
  assert.deepEqual(readdirSync(cwd), []);

  const input = viewer.input('down');
  await assert.rejects(viewer.input('up'), { code: 'terminal_busy' });
  await assert.rejects(viewer.resize(35, 7), { code: 'terminal_busy' });
  await input;
  assert.deepEqual(output.at(-1), { ...viewer.screen, top: 1, lines: entries.slice(1, 5) });
  await viewer.resize(35, 7);
  assert.deepEqual(output.at(-1), { ...viewer.screen, cols: 35, rows: 7, top: 1, lines: entries.slice(1, 8) });
  const screenCount = output.length;
  await viewer.resize(35, 7);
  assert.equal(output.length, screenCount);

  for (const [key, top] of [['page-down', 8], ['end', 37], ['down', 37], ['page-up', 30], ['home', 0], ['up', 0]]) {
    await viewer.input(key);
    assert.equal(output.at(-1).top, top, key);
    assert.deepEqual(output.at(-1).lines, entries.slice(top, top + 7));
  }
  await viewer.input('quit');
  assert.deepEqual(exit.events, [{ code: 0, signal: null, reason: 'quit' }]);
  assert.equal(existsSync(proc), false);
  assert.equal(existsSync(cwd), false);
  await viewer.dispose();
  assert.equal(exit.events.length, 1);
});

test('0600 bootstrap is read once into independent snapshots', async (t) => {
  const before = tempEntries();
  const opening = viewport({ text: `${PRIVATE}\n甲` });
  t.after(() => opening.then((viewer) => viewer.dispose(), () => {}));
  const staged = tempEntries().filter((name) => !before.includes(name));
  assert.equal(staged.length, 1);
  const source = join(ROOT, staged[0], 'source');
  assert.equal(lstatSync(source).mode & 0o7777, 0o600);
  assert.equal(readFileSync(source, 'utf8'), `${PRIVATE}\n甲`);
  const one = await opening;
  assert.equal(existsSync(source), false);
  const two = await viewport({ text: 'second\n乙' });
  t.after(() => two.dispose());
  const dirs = ownedViewers().map(({ cwd }) => cwd);
  assert.equal(new Set(dirs).size, 2);
  assert.deepEqual(one.screen.lines, [PRIVATE.slice(0, 24), '甲']);
  assert.deepEqual(two.screen.lines, ['second', '乙']);
  await one.input('right');
  await two.input('down');
  await one.dispose();
  await two.dispose();
  assert.deepEqual(tempEntries(), before);
});

test('neutralizes controls, expands tabs, retains normal Unicode and clamps horizontal scrolling', async (t) => {
  const longLine = '界'.repeat(24) + '👩‍💻e\u0301';
  const unsafe = 'A\tB\rC\x00\x1b[2J\x1b]8;;x\x07\u009b\u009d\u202e\u2067D';
  let last;
  const viewer = await viewport({ text: `\ufeff${unsafe}\r\n${longLine}\n末尾\n`, onScreen: (screen) => { last = screen; } });
  t.after(() => viewer.dispose());
  assert.equal(viewer.screen.totalLines, 4);
  assert.deepEqual(viewer.screen.lines, ['A       B�C��[2J�]8;;x��', '界'.repeat(12), '末尾', '']);
  assert(viewer.screen.lines.every((line) => !/[\p{Cc}\p{Bidi_Control}\p{Zl}\p{Zp}]/u.test(line)));
  await viewer.input('right');
  assert.equal(last.left, 1);
  assert.equal(last.lines[1], ` ${'界'.repeat(11)} `);
  for (let i = 0; i < 30; i++) await viewer.input('right');
  assert.equal(last.left, 27);
  assert.equal(last.lines[1], ` ${'界'.repeat(10)}👩‍💻e\u0301`);
  await viewer.input('left');
  assert.equal(last.left, 26);
  await viewer.resize(160, 4);
  assert.equal(last.left, 0);
  assert.equal(last.lines[1], longLine);
  assert.equal(last.lines[0], 'A       B�C��[2J�]8;;x�����D');
});

test('bounded malformed data, empty files, byte/line limits, invalid keys and dimensions', async (t) => {
  const before = tempEntries();
  for (const text of [Buffer.from([0xc0, 0xaf]), 'bad\ud800', 42]) {
    await assert.rejects(viewport({ text }), invalid);
  }
  for (const text of ['a'.repeat(65_537), '文'.repeat(21_846), '\n'.repeat(4_096)]) {
    await assert.rejects(viewport({ text }), { code: 'terminal_limit' });
  }
  await assert.rejects(viewport({ cols: 23 }), invalid);
  await assert.rejects(viewport({ rows: 51 }), invalid);
  assert.deepEqual(tempEntries(), before);

  const viewer = await viewport({ text: '' });
  t.after(() => viewer.dispose());
  assert.deepEqual(viewer.screen, { cols: 24, rows: 4, top: 0, left: 0, totalLines: 1, lines: [''] });
  for (const key of ['q', 'toString', '__proto__', '\x1b[A', '', null]) await assert.rejects(viewer.input(key), invalid);
  await assert.rejects(viewer.resize(24, 3), invalid);
  await viewer.dispose();
  await assert.rejects(viewer.input('down'), unavailable);

  const exact = await viewport({ text: `${'a'.repeat(65_536 - 4_095)}${'\n'.repeat(4_095)}` });
  t.after(() => exact.dispose());
  assert.equal(exact.screen.totalLines, 4_096);
  assert.deepEqual(exact.screen.lines, ['a'.repeat(24), '', '', '']);
});

test('dispose drains a stalled action and closes the real child', async (t) => {
  const exit = untilExit(t);
  const viewer = await viewport({ onExit: exit.onExit });
  t.after(() => viewer.dispose());
  const { pid, proc, cwd } = onlyViewer();
  process.kill(pid, 'SIGSTOP');
  const pending = viewer.input('down');
  const rejected = assert.rejects(pending, unavailable);
  await Promise.all([viewer.dispose(), viewer.dispose(), rejected]);
  assert.deepEqual(exit.events, [{ code: null, signal: 1, reason: 'disposed' }]);
  assert.equal(existsSync(proc), false);
  assert.equal(existsSync(cwd), false);
});

test('action timeout hangs up a stalled child and reports fault', { timeout: 5_000 }, async (t) => {
  const exit = untilExit(t);
  const viewer = await viewport({ onExit: exit.onExit });
  t.after(() => viewer.dispose());
  const { pid, proc, cwd } = onlyViewer();
  process.kill(pid, 'SIGSTOP');
  await assert.rejects(viewer.resize(32, 5), unavailable);
  await viewer.dispose();
  assert.deepEqual(exit.events, [{ code: null, signal: 1, reason: 'fault' }]);
  assert.equal(existsSync(proc), false);
  assert.equal(existsSync(cwd), false);
});

test('lone unowned entry is preserved and disposal reports cleanup fault', async (t) => {
  const exit = untilExit(t);
  const viewer = await viewport({ onExit: exit.onExit });
  const { proc, cwd } = onlyViewer();
  const dir = lstatSync(cwd, { bigint: true });
  const stray = join(cwd, 'foreign');
  writeFileSync(stray, 'synthetic stray sentinel', { flag: 'wx', mode: 0o600 });
  const inode = lstatSync(stray, { bigint: true });
  t.after(() => {
    const current = lstatSync(stray, { bigint: true });
    const onDisk = lstatSync(cwd, { bigint: true });
    assert.deepEqual([current.dev, current.ino, onDisk.dev, onDisk.ino], [inode.dev, inode.ino, dir.dev, dir.ino]);
    unlinkSync(stray);
    rmdirSync(cwd);
  });
  await assert.rejects(viewer.dispose(), unavailable);
  assert.deepEqual(exit.events, [{ code: null, signal: 1, reason: 'fault' }]);
  assert.equal(existsSync(proc), false);
  assert.equal(readFileSync(stray, 'utf8'), 'synthetic stray sentinel');
});

test('aborting before readiness or during a key cleans up and reports actual fault exit', async (t) => {
  const before = tempEntries();
  const controller = new AbortController();
  const startup = untilExit(t);
  const opening = viewport({ signal: controller.signal, onExit: startup.onExit });
  controller.abort(PRIVATE);
  await assert.rejects(opening, unavailable);
  assert.equal((await startup.seen)?.reason, 'fault');
  assert.equal(startup.events.length, 1);

  await assert.rejects(viewport({ signal: controller.signal }), unavailable);
  const active = new AbortController();
  const exit = untilExit(t);
  const viewer = await viewport({ signal: active.signal, onExit: exit.onExit });
  t.after(() => viewer.dispose());
  const { proc, cwd } = onlyViewer();
  const waiting = assert.rejects(viewer.input('down'), unavailable);
  active.abort(PRIVATE);
  await waiting;
  await viewer.dispose();
  assert.deepEqual(exit.events, [{ code: null, signal: 1, reason: 'fault' }]);
  assert.equal(existsSync(proc), false);
  assert.equal(existsSync(cwd), false);
  assert.deepEqual(tempEntries(), before);
});

test('unexpected OS exit is a fault and native-addon unavailability has a fixed error', async (t) => {
  const exit = untilExit(t);
  const viewer = await viewport({ onExit: exit.onExit });
  t.after(() => viewer.dispose());
  const { pid, proc, cwd } = onlyViewer();
  process.kill(pid, 'SIGKILL');
  assert.deepEqual(await exit.seen, { code: null, signal: 9, reason: 'fault' });
  await viewer.dispose();
  assert.equal(existsSync(proc), false);
  assert.equal(existsSync(cwd), false);

  const module = new URL('../src/native.mjs', import.meta.url).href;
  const testAddon = `import {openNativeViewer} from ${JSON.stringify(module)};
    try { await openNativeViewer({ text: ${JSON.stringify(PRIVATE)}, cols: 24, rows: 4 }); process.exitCode = 2; }
    catch (e) { process.stdout.write(JSON.stringify({ code: e.code, message: e.message })); }`;
  const output = await exec(process.execPath, ['--no-addons', '--input-type=module', '--eval', testAddon], { timeout: 4_000 });
  assert.equal(output.stderr, '');
  assert.deepEqual(JSON.parse(output.stdout), unavailable);
  await assert.rejects(exec(process.execPath, ['--no-addons', VIEWER], { timeout: 4_000 }),
    { code: 1, stdout: '', stderr: '' });
});
