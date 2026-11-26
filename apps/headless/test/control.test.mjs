import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAuthService } from '../src/auth/index.mjs';
import { ControlError, requestControl, startControl } from '../src/control/socket.mjs';

const endpoint = 'workbench-control.sock';
const STATUS = '{"op":"status"}\n';
const controlError = (error) => error instanceof ControlError && error.code === 'CONTROL_FAILED' &&
  error.message === 'Local workbench control failed';

async function fixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'dwc-'));
  const runDir = join(root, 'run');
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, runDir, path: join(runDir, endpoint) };
}

function stubAuth(claimed = false) {
  return {
    isClaimed: () => claimed,
    issueClaim() { throw new Error('internal diagnostic'); },
  };
}

async function boundServer(path, onConnection) {
  const server = createServer({ allowHalfOpen: true }, onConnection);
  server.listen({ path });
  await once(server, 'listening');
  await chmod(path, 0o600);
  return server;
}

function exchange(path, payload, { end = true } = {}) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path, allowHalfOpen: true });
    const chunks = [];
    const timer = setTimeout(() => socket.destroy(new Error('test socket did not close')), 8_000);
    socket.once('connect', () => (end ? socket.end(payload) : socket.write(payload)));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.once('end', () => socket.end());
    socket.once('error', (error) => {
      if (error.code !== 'ECONNRESET') reject(error);
    });
    socket.once('close', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

async function closeServer(server) {
  if (server.listening) await new Promise((resolve) => server.close(resolve));
}

test('private Unix control performs claim and status with the auth service, and restarts cleanly', async (t) => {
  const { root, runDir, path } = await fixture(t);
  const auth = await createAuthService({ dataDir: join(root, 'data') });
  const control = await startControl({ runDir, auth });
  try {
    assert.equal(control.path, path);
    const info = await lstat(path);
    assert.equal(info.isSocket(), true);
    assert.equal(info.mode & 0o777, 0o600);
    assert.equal(info.uid, process.geteuid());
    assert.equal((await lstat(runDir)).mode & 0o777, 0o700);
    assert.deepEqual(await requestControl({ runDir, op: 'status' }), { claimed: false });
    await assert.rejects(requestControl({ runDir, op: 'login' }), controlError);
    const claim = await requestControl({ runDir, op: 'claim' });
    assert.deepEqual(Object.keys(claim).sort(), ['credential', 'expiresAt', 'ttlMs']);
    assert.equal(Buffer.from(claim.credential, 'base64url').length, 32);
    assert.equal(claim.ttlMs, 600_000);
    const password = randomBytes(32).toString('base64url');
    await auth.claim(claim.credential, password);
    assert.deepEqual(await requestControl({ runDir, op: 'status' }), { claimed: true });
    await assert.rejects(requestControl({ runDir, op: 'claim' }), controlError);
  } finally {
    await Promise.all([control.close(), control.close()]);
  }
  await assert.rejects(lstat(path), { code: 'ENOENT' });
  const restarted = await startControl({ runDir, auth });
  try {
    assert.deepEqual(await requestControl({ runDir, op: 'status' }), { claimed: true });
  } finally {
    await restarted.close();
  }
});

test('same run directory has one listener; a live same-UID socket stays in place', async (t) => {
  const { runDir, path } = await fixture(t);
  const auth = stubAuth();
  const results = await Promise.allSettled([startControl({ runDir, auth }), startControl({ runDir, auth })]);
  const controls = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
  try {
    assert.equal(controls.length, 1);
    assert.ok(results.some((result) => result.status === 'rejected' && controlError(result.reason)));
    const original = await lstat(path);
    await assert.rejects(startControl({ runDir, auth }), controlError);
    assert.equal((await lstat(path)).ino, original.ino);
    assert.deepEqual(await requestControl({ runDir, op: 'status' }), { claimed: false });
  } finally {
    await Promise.all(controls.map((control) => control.close()));
  }
  const live = await boundServer(path, (socket) => {
    socket.on('error', () => {});
    socket.resume();
    socket.on('end', () => socket.end());
  });
  try {
    const original = await lstat(path);
    await assert.rejects(startControl({ runDir, auth }), controlError);
    assert.equal((await lstat(path)).ino, original.ino);
    assert.equal(live.listening, true);
  } finally {
    await closeServer(live);
  }
});

test('wrong types, symlinks, insecure modes, and replacement paths are handled safely', async (t) => {
  const { root, runDir, path } = await fixture(t);
  const auth = stubAuth();
  await mkdir(runDir, { mode: 0o700 });
  await chmod(runDir, 0o750);
  await assert.rejects(startControl({ runDir, auth }), controlError);
  await assert.rejects(requestControl({ runDir, op: 'status' }), controlError);
  await chmod(runDir, 0o700);
  await writeFile(path, 'unrelated', { mode: 0o600 });
  await assert.rejects(startControl({ runDir, auth }), controlError);
  await assert.rejects(requestControl({ runDir, op: 'status' }), controlError);
  assert.equal(await readFile(path, 'utf8'), 'unrelated');
  await unlink(path);
  const target = join(root, 'target');
  await writeFile(target, 'unrelated', { mode: 0o600 });
  await symlink(target, path);
  await assert.rejects(startControl({ runDir, auth }), controlError);
  await assert.rejects(requestControl({ runDir, op: 'status' }), controlError);
  assert.equal((await lstat(path)).isSymbolicLink(), true);
  await unlink(path);
  const alias = join(root, 'alias');
  await symlink(runDir, alias);
  await assert.rejects(startControl({ runDir: alias, auth }), controlError);
  await assert.rejects(startControl({ runDir: join(alias, 'child'), auth }), controlError);
  await assert.rejects(lstat(join(runDir, 'child')), { code: 'ENOENT' });
  const control = await startControl({ runDir, auth });
  try {
    await chmod(path, 0o660);
    await assert.rejects(requestControl({ runDir, op: 'status' }), controlError);
    await unlink(path);
    await writeFile(path, 'replacement', { flag: 'wx', mode: 0o600 });
  } finally {
    await control.close();
  }
  assert.equal(await readFile(path, 'utf8'), 'replacement');
});

test('one bounded frame only; timeouts and operational failures emit no details', { timeout: 12_000 }, async (t) => {
  const { root, runDir, path } = await fixture(t);
  let issues = 0;
  const auth = {
    isClaimed: () => false,
    issueClaim() { issues++; throw new Error('internal diagnostic'); },
  };
  const control = await startControl({ runDir, auth });
  const other = join(root, 'other');
  await mkdir(other, { mode: 0o700 });
  const hanging = new Set();
  const fake = await boundServer(join(other, endpoint), (socket) => {
    hanging.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => hanging.delete(socket));
    socket.resume();
  });
  try {
    const rejected = '{"ok":false}\n';
    assert.equal(await exchange(path, Buffer.alloc(2_000, 0x61)), rejected);
    assert.equal(await exchange(path, '{"op":"claim"}\n' + STATUS), rejected);
    assert.equal(await exchange(path, '{"op":"status","op":"claim"}\n'), rejected);
    assert.equal(await exchange(path, '{"op":"unknown"}\n'), rejected);
    assert.equal(await exchange(path, Buffer.from([0xff, 0x0a])), rejected);
    assert.equal(issues, 0);
    assert.equal(await exchange(path, '{"op":"claim"}\n'), rejected);
    assert.equal(issues, 1);
    await Promise.all([
      assert.rejects(requestControl({ runDir: other, op: 'status' }), controlError),
      exchange(path, '{"op":"claim"', { end: false }).then((value) => assert.equal(value, '')),
    ]);
    assert.equal(issues, 1);
    assert.deepEqual(await requestControl({ runDir, op: 'status' }), { claimed: false });
  } finally {
    for (const socket of hanging) socket.destroy();
    await Promise.all([control.close(), closeServer(fake)]);
  }
});

test('an abandoned service-owned socket is recovered after the prior process exits', { timeout: 12_000 }, async (t) => {
  const { runDir, path } = await fixture(t);
  const moduleUrl = new URL('../src/control/socket.mjs', import.meta.url).href;
  const code = `import {startControl} from ${JSON.stringify(moduleUrl)};\n` +
    'await startControl({runDir:process.argv[1],auth:{isClaimed:()=>false,issueClaim(){throw Error()}}});\n' +
    'process.stdout.write("ready\\n");';
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, runDir], { stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  const [notice] = await Promise.race([
    once(child.stdout, 'data'),
    exited.then(() => { throw new Error('child exited before binding'); }),
  ]);
  assert.equal(notice.toString('utf8'), 'ready\n');
  assert.deepEqual(await requestControl({ runDir, op: 'status' }), { claimed: false });
  assert.equal(child.kill('SIGKILL'), true);
  assert.deepEqual(await exited, [null, 'SIGKILL']);
  assert.equal((await lstat(path)).isSocket(), true);
  await assert.rejects(requestControl({ runDir, op: 'status' }), controlError);
  const recovered = await startControl({ runDir, auth: stubAuth(true) });
  try {
    assert.deepEqual(await requestControl({ runDir, op: 'status' }), { claimed: true });
  } finally {
    await recovered.close();
  }
  await assert.rejects(lstat(path), { code: 'ENOENT' });
});
