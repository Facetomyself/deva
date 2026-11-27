#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { browserFlags } from '../src/engine/launch-flags.mjs';
import { connectPipe } from '../src/engine/pipe.mjs';
import { BOOTSTRAP_URL, EngineError } from '../src/engine/policy.mjs';

// Observes a real blank profile only; engine-handoff is the separate sandbox and form gate.
// Usage: node apps/browser-worker/test-real/blank-targets.mjs [--compare] [/absolute/chrome]
const DEFAULT_EXECUTABLE = process.env.CHROMIUM_PATH || process.env.CHROME_BIN || '/usr/bin/chromium';
const NULL_PROXY = 'http://127.0.0.1:9';
const OBSERVE_MS = 2_500;
const RUN_MS = 12_000;
const TMP = '/tmp';
const UID = process.getuid?.();
const OMIT_FOR_BASELINE = new Set(['--disable-default-apps', '--disable-component-extensions-with-background-pages']);
// Match the production session's discovery footprint. Every extra observed target fails the hardened run.
const TYPES = new Set(['page', 'iframe', 'worker', 'shared_worker', 'service_worker']);
const FILTER = [...TYPES].map((type) => ({ type, exclude: false })).concat({ exclude: true });
const SCHEMES = new Set(['about', 'chrome-extension', 'chrome', 'http', 'https', 'file', 'data', 'blob']);
const diagnostic = (code) => Object.assign(new Error(code), { qaCode: code });

async function options(args) {
  const paths = args.filter((arg) => arg !== '--compare');
  const compare = args.length !== paths.length;
  const executable = paths[0] ?? DEFAULT_EXECUTABLE;
  if (paths.length > 1 || args.length > paths.length + 1 || !isAbsolute(executable)) throw diagnostic('USAGE');
  try {
    if (!(await stat(executable)).isFile()) throw diagnostic('EXECUTABLE_REQUIRED');
    await access(executable, constants.X_OK);
  } catch { throw diagnostic('EXECUTABLE_REQUIRED'); }
  return { executable, compare };
}

const privateDirectory = (s) => s.isDirectory() && s.uid === BigInt(UID) && (s.mode & 0o777n) === 0o700n;
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;

async function verifyDirectory(path, handle) {
  const [held, linked, canonical] = await Promise.all([
    handle.stat({ bigint: true }), lstat(path, { bigint: true }), realpath(path),
  ]);
  if (canonical !== path || !privateDirectory(held) || !privateDirectory(linked) || !same(held, linked)) {
    throw diagnostic('PROFILE_IDENTITY');
  }
}

async function withFreshProfile(run) {
  const workspace = await mkdtemp(join(TMP, 'deva-blank-'));
  if (dirname(workspace) !== TMP || !/^\/tmp\/deva-blank-[a-z0-9]{6}$/iu.test(workspace)) {
    throw diagnostic('PROFILE_IDENTITY');
  }
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const root = await open(workspace, directoryFlags);
  let profileHandle, canRemove = true;
  const profile = join(workspace, 'profile');
  try {
    await verifyDirectory(workspace, root);
    await mkdir(profile, { mode: 0o700 });
    profileHandle = await open(profile, directoryFlags);
    const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' };
    for (const name of ['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR']) {
      env[name] = join(workspace, name);
      await mkdir(env[name], { mode: 0o700 });
    }
    await verifyDirectory(profile, profileHandle);
    if ((await readdir(profile)).length) throw diagnostic('PROFILE_NOT_EMPTY');
    return await run(profile, env, () => { canRemove = false; });
  } finally {
    try {
      if (canRemove) {
        await verifyDirectory(workspace, root);
        if (profileHandle) await verifyDirectory(profile, profileHandle);
        await rm(workspace, { recursive: true });
      }
    } finally {
      await profileHandle?.close();
      await root.close();
    }
  }
}

async function identity(pid) {
  const raw = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
  if (!raw) return null;
  const row = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
  if (row[0] === 'Z' || row[0] === 'X' || !/^\d+$/u.test(row[19] ?? '')) return null;
  return { pid, session: Number(row[3]), start: row[19] };
}

async function owned(row) {
  const status = await readFile(`/proc/${row.pid}/status`, 'utf8').catch(() => '');
  const uid = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/mu.exec(status)?.slice(1);
  if ((await identity(row.pid))?.start !== row.start) return false;
  if (uid?.length !== 4 || !uid.every((value) => Number(value) === UID)) throw diagnostic('PROCESS_IDENTITY');
  return true;
}

async function children(session, profile) {
  if (!session) return [];
  const names = (await readdir('/proc')).filter((name) => /^\d+$/u.test(name));
  const rows = [];
  for (let from = 0; from < names.length; from += 32) {
    await Promise.all(names.slice(from, from + 32).map(async (name) => {
      const row = await identity(Number(name));
      if (!row) return;
      if (row.session !== session) {
        // Also account for a Chrome helper that made its own session (e.g. a crash handler).
        const comm = await readFile(`/proc/${name}/comm`, 'utf8').catch(() => '');
        if (!/^chrom(?:e|ium)(?:[_-][a-z0-9_-]*)?\n$/iu.test(comm)) return;
        const args = (await readFile(`/proc/${name}/cmdline`, 'utf8').catch(() => '')).split('\0');
        if (!args.some((arg) => arg === `--user-data-dir=${profile}` || arg.startsWith(`--database=${profile}/`))) return;
      }
      if (await owned(row)) rows.push(row);
    }));
  }
  return rows;
}

async function reap(child, profile, outcome) {
  async function waitEmpty(grace) {
    const end = performance.now() + grace;
    do {
      if (outcome() && !(await children(child.pid, profile)).length) return true;
      await delay(40);
    } while (performance.now() < end);
    return false;
  }
  if (await waitEmpty(1_000)) return;
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const row of await children(child.pid, profile)) {
      if (!(await owned(row))) continue;
      try { process.kill(row.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (await waitEmpty(1_000)) return;
  }
  throw diagnostic('CHILDREN_STILL_LIVE');
}

function inventory() {
  const observations = new Map();
  let unexpected = false;
  function observe(info) {
    if (typeof info?.targetId !== 'string' || !info.targetId) throw diagnostic('TARGET_INVENTORY_INVALID');
    const prior = observations.get(info.targetId);
    if (!prior && observations.size >= 256) throw diagnostic('TARGET_INVENTORY_LIMIT');
    const type = TYPES.has(info.type) ? info.type : 'other';
    const rawScheme = typeof info.url === 'string' ? /^([a-z][a-z\d+.-]*):/iu.exec(info.url)?.[1].toLowerCase() : undefined;
    const scheme = info.url === '' ? 'empty' : SCHEMES.has(rawScheme) ? rawScheme : 'other';
    const blank = type === 'page' && !info.openerId && info.attached === false && [BOOTSTRAP_URL, ''].includes(info.url);
    unexpected ||= !blank;
    if (!prior || (!blank && prior.blank) || (prior.blank && prior.scheme === 'empty' && info.url === BOOTSTRAP_URL)) {
      observations.set(info.targetId, { type, scheme, blank });
    }
  }
  function summarize(final) {
    const counts = {};
    for (const { type, scheme } of observations.values()) {
      counts[`${type}:${scheme}`] = (counts[`${type}:${scheme}`] ?? 0) + 1;
    }
    const singleBlank = !unexpected && observations.size === 1 && final.length === 1 && final[0].url === BOOTSTRAP_URL;
    return { counts, singleBlank };
  }
  return { observe, summarize };
}

async function observeBlank(executable, baseline, profile, env, retainProfile, signal) {
  if (signal.aborted) throw diagnostic('INTERRUPTED');
  const args = browserFlags(profile, NULL_PROXY).filter((arg) => !baseline || !OMIT_FOR_BASELINE.has(arg));
  const child = spawn(executable, args, { cwd: profile, env, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  let outcome, closing = false;
  child.once('exit', (code) => { outcome = { code }; });
  child.on('error', () => { outcome = { code: null }; });
  const targets = inventory();
  const failed = new AbortController();
  const deadline = AbortSignal.timeout(RUN_MS);
  const pipe = connectPipe(child.stdio[3], child.stdio[4], {
    onEvent(method, { targetInfo }, session) {
      if (closing) return;
      if (session === null && (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged')) {
        targets.observe(targetInfo);
      }
    },
    onFailure(code) { if (!closing) failed.abort(diagnostic(code)); },
  });
  const timeout = () => pipe.stop('BROWSER_TIMEOUT');
  const interrupt = () => pipe.stop('BROWSER_ABORTED');
  deadline.addEventListener('abort', timeout, { once: true });
  signal.addEventListener('abort', interrupt, { once: true });
  const snapshot = async () => {
    const { targetInfos } = await pipe.send('Target.getTargets', { filter: FILTER });
    if (!Array.isArray(targetInfos)) throw diagnostic('TARGET_INVENTORY_INVALID');
    for (const info of targetInfos) targets.observe(info);
    return targetInfos;
  };
  try {
    await pipe.send('Target.setDiscoverTargets', { discover: true, filter: FILTER });
    await snapshot();
    try { await delay(OBSERVE_MS, undefined, { signal: failed.signal }); }
    catch { throw failed.signal.reason; }
    const result = targets.summarize(await snapshot());
    failed.signal.throwIfAborted();
    return result;
  } finally {
    deadline.removeEventListener('abort', timeout);
    signal.removeEventListener('abort', interrupt);
    closing = true;
    await pipe.send('Browser.close', {}, null, 700).catch(() => {});
    pipe.stop();
    child.stdio[3].destroy();
    child.stdio[4].destroy();
    try { await reap(child, profile, () => outcome); }
    catch (error) { retainProfile(); throw error; }
    if (!failed.signal.aborted && outcome.code !== 0) throw diagnostic('BROWSER_EXIT_FAILED');
  }
}

const signal = new AbortController();
const interrupt = () => signal.abort();
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
try {
  if (process.platform !== 'linux' || !UID || process.geteuid() !== UID) throw diagnostic('UNPRIVILEGED_LINUX_REQUIRED');
  const { executable, compare } = await options(process.argv.slice(2));
  const run = (baseline) => withFreshProfile((profile, env, retain) =>
    observeBlank(executable, baseline, profile, env, retain, signal.signal));
  const hardened = await run(false);
  console.log(JSON.stringify({ hardened: hardened.counts }));
  if (!hardened.singleBlank) throw diagnostic('UNEXPECTED_TARGETS');
  if (compare) {
    const baseline = await run(true);
    console.log(JSON.stringify({ baseline: baseline.counts }));
  }
} catch (error) {
  // Browser output and arbitrary exception text are deliberately excluded.
  console.error(`blank-targets: ${error?.qaCode ?? (error instanceof EngineError ? error.code : 'QA_FAILED')}`);
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
}
