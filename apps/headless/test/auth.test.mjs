import assert from 'node:assert/strict';
import crypto, { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { AuthError, AuthStateError, createAuthService } from '../src/auth/index.mjs';

const randomToken = () => randomBytes(32).toString('base64url');
const uniform = { name: 'AuthError', code: 'AUTH_FAILED', message: 'Authentication failed' };

async function fixture(t) {
  // Exercise real async scrypt cheaply in this isolated test process; pin the production policy at its call boundary.
  const scrypt = crypto.scrypt;
  t.mock.method(crypto, 'scrypt', (password, salt, length, options, callback) => {
    assert.equal(salt.length, 32);
    assert.equal(length, 64);
    assert.deepEqual(options, { N: 2 ** 17, r: 8, p: 1, maxmem: 160 * 1024 * 1024 });
    scrypt(password, salt, length, { ...options, N: 2 ** 10 }, callback);
  });
  const dataDir = await mkdtemp(join(tmpdir(), 'deva-workbench-auth-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const authDir = join(dataDir, 'web-workbench-auth');
  return { dataDir, authDir, ownerFile: join(authDir, 'owner.json') };
}

function fakeTime(t) {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  return (milliseconds) => { now += milliseconds; };
}

function isAuthError(error) {
  assert.ok(error instanceof AuthError);
  for (const [key, value] of Object.entries(uniform)) assert.equal(error[key], value);
  return true;
}

function isStateError(code) {
  return (error) => error instanceof AuthStateError && error.code === code;
}

function assertToken(value) {
  assert.match(value, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(value, 'base64url').length, 32);
}

test('only explicit issuance enables one concurrent claim; just the salted verifier survives restart', async (t) => {
  const { dataDir, authDir, ownerFile } = await fixture(t);
  const mobile = join(dataDir, 'mobile-pairing.json');
  await writeFile(mobile, 'synthetic mobile state\n');
  const service = await createAuthService({ dataDir });
  const secondHandle = await createAuthService({ dataDir });
  const password = randomToken();
  const wrongPassword = randomToken();
  assert.equal(service.isClaimed(), false);
  await assert.rejects(service.claim(randomToken(), password), isAuthError);
  await assert.rejects(service.login(password), isAuthError);

  const discarded = await service.issueClaim();
  const before = Date.now();
  const issued = await service.issueClaim();
  assertToken(issued.credential);
  assert.notEqual(discarded.credential, issued.credential);
  assert.equal(issued.ttlMs, 10 * 60_000);
  assert.ok(issued.expiresAt >= before + issued.ttlMs && issued.expiresAt <= Date.now() + issued.ttlMs);
  await assert.rejects(service.claim(discarded.credential, password), isAuthError);
  const other = await secondHandle.issueClaim();
  const primary = service.claim(issued.credential, password);
  const duplicate = assert.rejects(service.claim(issued.credential, wrongPassword), isAuthError);
  const rotateDuringClaim = assert.rejects(service.issueClaim(), isAuthError);
  const competing = secondHandle.claim(other.credential, wrongPassword);
  const outcomes = await Promise.allSettled([primary, competing]);
  await Promise.all([duplicate, rotateDuringClaim]);
  const winners = outcomes.flatMap((result, index) => result.status === 'fulfilled' ? [index] : []);
  assert.equal(winners.length, 1);
  const [winner] = winners;
  const { value: signedIn } = outcomes[winner];
  isAuthError(outcomes[1 - winner].reason);
  const activeService = [service, secondHandle][winner];
  const activePassword = [password, wrongPassword][winner];
  const inactivePassword = [wrongPassword, password][winner];
  assert.equal(activeService.isClaimed(), true);
  assertToken(signedIn.session);
  assertToken(signedIn.csrf);
  assert.deepEqual(activeService.authenticate(signedIn.session, signedIn.csrf), { expiresAt: signedIn.expiresAt });
  await assert.rejects(service.claim(issued.credential, password), isAuthError);
  await assert.rejects(service.issueClaim(), isAuthError);
  await assert.rejects(secondHandle.issueClaim(), isAuthError);

  assert.equal(await readFile(mobile, 'utf8'), 'synthetic mobile state\n');
  const raw = await readFile(ownerFile, 'utf8');
  const sensitive = [password, wrongPassword, discarded.credential, issued.credential, other.credential,
    signedIn.session, signedIn.csrf];
  for (const value of sensitive) assert.equal(raw.includes(value), false);
  assert.deepEqual(await readdir(authDir), ['owner.json']);
  assert.equal((await stat(authDir)).mode & 0o777, 0o700);
  assert.equal((await stat(ownerFile)).mode & 0o777, 0o600);
  const state = JSON.parse(raw);
  assert.deepEqual(Object.keys(state).sort(), ['salt', 'scheme', 'state', 'verifier', 'version']);
  assert.equal(state.scheme, 'scrypt-n131072-r8-p1');
  assert.equal(Buffer.from(state.salt, 'base64url').length, 32);
  assert.equal(Buffer.from(state.verifier, 'base64url').length, 64);

  const restarted = await createAuthService({ dataDir });
  assert.equal(restarted.isClaimed(), true);
  await assert.rejects(restarted.issueClaim(), isAuthError);
  assert.throws(() => restarted.authenticate(signedIn.session), isAuthError);
  await assert.rejects(restarted.login(inactivePassword), isAuthError);
  const loggedIn = await restarted.login(activePassword);
  assert.notEqual(loggedIn.session, signedIn.session);
  assert.deepEqual(restarted.authenticate(loggedIn.session), { expiresAt: loggedIn.expiresAt });
});

test('claim and login count failures under one public error shape and never stretch the failure window', async (t) => {
  const { dataDir } = await fixture(t);
  const advance = fakeTime(t);
  const service = await createAuthService({ dataDir });
  const password = randomToken();
  const claim = await service.issueClaim();
  for (let attempt = 0; attempt < 4; attempt++) {
    await assert.rejects(service.claim(randomToken(), password), isAuthError);
  }
  await assert.rejects(service.claim(claim.credential, '😀'.repeat(11)), isAuthError);
  await assert.rejects(service.claim(claim.credential, password), isAuthError);
  advance(59_999);
  await assert.rejects(service.claim(claim.credential, password), isAuthError);
  advance(1);
  const { session } = await service.claim(claim.credential, password);
  const invalidPasswords = ['', {}, '😀'.repeat(257), '\uD800'.repeat(12), ` ${randomToken()}`];
  for (const invalid of invalidPasswords) await assert.rejects(service.login(invalid), isAuthError);
  await assert.rejects(service.login(password), isAuthError);
  assert.doesNotThrow(() => service.authenticate(session));
  advance(59_999);
  await assert.rejects(service.login(password), isAuthError);
  advance(1);
  assertToken((await service.login(password)).session);
});

test('claim TTL is checked both at submission and after derivation; restart drops pending claims', async (t) => {
  const { dataDir } = await fixture(t);
  const advance = fakeTime(t);
  const service = await createAuthService({ dataDir });
  const password = randomToken();
  const { credential, ttlMs } = await service.issueClaim();
  advance(ttlMs - 1);
  const started = assert.rejects(service.claim(credential, password), isAuthError);
  advance(1);
  await started;
  await assert.rejects(service.claim(credential, password), isAuthError);
  assert.equal(service.isClaimed(), false);
  const newer = await service.issueClaim();
  const restarted = await createAuthService({ dataDir });
  await assert.rejects(restarted.claim(newer.credential, password), isAuthError);
  assert.equal(restarted.isClaimed(), false);
  const own = await restarted.issueClaim();
  assert.notEqual(own.credential, newer.credential);
});

test('session tokens and CSRF are distinct; recovery, cap, expiry, and revocation enforce validity', async (t) => {
  const { dataDir } = await fixture(t);
  const advance = fakeTime(t);
  const service = await createAuthService({ dataDir });
  const { credential } = await service.issueClaim();
  const password = randomToken();
  const first = await service.claim(credential, password);
  const live = [];
  for (let count = 0; count < 5; count++) live.push(await service.login(password));
  const active = live[0];
  const last = live.at(-1);
  assert.equal(new Set([first, ...live].flatMap(({ session, csrf }) => [session, csrf])).size, 12);
  assert.throws(() => service.authenticate(first.session), isAuthError);
  assert.throws(() => service.describe(first.session), isAuthError);
  for (const { session, csrf, expiresAt } of live) {
    assert.deepEqual(service.authenticate(session, csrf), { expiresAt });
    assert.deepEqual(service.describe(session), { csrf, expiresAt });
  }
  assert.throws(() => service.authenticate(active.session, last.csrf), isAuthError);
  assert.throws(() => service.authenticate(active.session, undefined), isAuthError);
  assert.throws(() => service.authenticate(active.session, null), isAuthError);
  assert.throws(() => service.authenticate(`${active.session}=`, active.csrf), isAuthError);
  assert.equal(service.logout(active.session), undefined);
  assert.equal(service.logout(active.session), undefined);
  assert.throws(() => service.describe(active.session), isAuthError);
  advance(12 * 60 * 60_000 - 1);
  assert.doesNotThrow(() => service.authenticate(last.session, last.csrf));
  advance(1);
  assert.throws(() => service.authenticate(last.session), isAuthError);
  assert.throws(() => service.describe(last.session), isAuthError);
});

test('fresh state, damaged state, and permission errors are distinguished without resetting storage', async (t) => {
  const { dataDir, authDir, ownerFile } = await fixture(t);
  const newDir = join(dataDir, 'new-instance', 'nested');
  assert.equal((await createAuthService({ dataDir: newDir })).isClaimed(), false);
  assert.equal((await stat(newDir)).mode & 0o777, 0o700);
  await mkdir(authDir, { mode: 0o700 });
  await assert.rejects(createAuthService({ dataDir }), isStateError('AUTH_STATE_CORRUPT'));
  assert.deepEqual(await readdir(authDir), []);
  const damaged = '{"version":1,"state":"claimed","state":"unclaimed"}\n';
  await writeFile(ownerFile, damaged, { mode: 0o600 });
  await assert.rejects(createAuthService({ dataDir }), isStateError('AUTH_STATE_CORRUPT'));
  assert.equal(await readFile(ownerFile, 'utf8'), damaged);
  const unsupported = '{"version":2,"state":"unclaimed"}\n';
  await writeFile(ownerFile, unsupported);
  await assert.rejects(createAuthService({ dataDir }), isStateError('AUTH_STATE_CORRUPT'));
  await chmod(ownerFile, 0o644);
  await assert.rejects(createAuthService({ dataDir }), isStateError('AUTH_STATE_PERMISSION'));
  await unlink(ownerFile);
  const unrelated = join(dataDir, 'unrelated.json');
  await writeFile(unrelated, '{"version":1,"state":"unclaimed"}\n', { mode: 0o600 });
  await symlink(unrelated, ownerFile);
  await assert.rejects(createAuthService({ dataDir }), isStateError('AUTH_STATE_CORRUPT'));
  await chmod(dataDir, 0o755);
  await assert.rejects(createAuthService({ dataDir }), isStateError('AUTH_STATE_PERMISSION'));
  await chmod(dataDir, 0o700);
});
