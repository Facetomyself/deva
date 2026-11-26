import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BOOTSTRAP_URL, configPolicy, EngineError, fail, VIEWPORT } from './policy.mjs';
import { classifyStartupStderr } from './launch-diagnostics.mjs';
import { procIdentity, verifyRendererSandbox } from './sandbox.mjs';
import { startChromiumSession } from './session.mjs';

export { EngineError };

const PROFILE_ROOT = '/tmp';
const PROFILE_PREFIX = 'deva-browser-';
const STARTUP_MS = 25_000;
const HANDSHAKE_MS = 12_000;

function browserFlags(profile, proxyUrl) {
  return [
    '--headless', '--remote-debugging-pipe',
    `--user-data-dir=${profile}`, `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    `--proxy-server=${proxyUrl}`, '--proxy-bypass-list=<-loopback>',
    '--host-resolver-rules=MAP * ~NOTFOUND', '--disable-quic',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--disable-blink-features=FileSystemAccess,FileSystemAccessLocal',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-extensions', '--disable-sync',
    '--disable-breakpad', '--disable-crash-reporter', '--disable-crashpad-for-testing',
    '--password-store=basic', BOOTSTRAP_URL,
  ];
}

async function safeRemove(profile) {
  if (dirname(profile) !== PROFILE_ROOT || !/^deva-browser-[a-z0-9]{6}$/iu.test(basename(profile))) {
    throw fail('BROWSER_CLEANUP_FAILED');
  }
  await rm(profile, { recursive: true, force: true });
}

async function runtimeEnv(profile) {
  const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: profile };
  for (const [name, subdir] of Object.entries({ TMPDIR: 'tmp', XDG_CONFIG_HOME: 'config',
    XDG_CACHE_HOME: 'cache', XDG_DATA_HOME: 'data', XDG_RUNTIME_DIR: 'runtime' })) {
    env[name] = join(profile, subdir);
    await mkdir(env[name], { mode: 0o700 });
  }
  return env;
}

async function groupMembers(group) {
  const pids = (await readdir('/proc')).filter((name) => /^\d+$/u.test(name));
  const members = [];
  for (let from = 0; from < pids.length; from += 32) {
    await Promise.all(pids.slice(from, from + 32).map(async (pid) => {
      try {
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
        const [state, , pgid] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (Number(pgid) === group && state !== 'Z' && state !== 'X') members.push(Number(pid));
      } catch (error) {
        if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) throw error;
      }
    }));
  }
  return members;
}

function statusField(status, key) {
  return status.split('\n').find((line) => line.startsWith(`${key}:`))?.split(/\s+/u).slice(1) ?? [];
}

// A distributor wrapper may detach its crash reporter into a different process group.
// Only identify a helper which names this exact unique profile and has this worker's UID.
async function profileHelpers(profile) {
  const pids = (await readdir('/proc')).filter((name) => /^\d+$/u.test(name));
  const found = [];
  for (let from = 0; from < pids.length; from += 32) {
    await Promise.all(pids.slice(from, from + 32).map(async (pid) => {
      try {
        const comm = await readFile(`/proc/${pid}/comm`, 'utf8');
        if (!/^chrom(?:e|ium)(?:[_-][a-z0-9_-]*)?\n$/iu.test(comm)) return;
        const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
        if (!argv.some((arg) => arg === `--user-data-dir=${profile}` || arg.startsWith(`--database=${profile}/`))) return;
        const status = await readFile(`/proc/${pid}/status`, 'utf8');
        const uid = statusField(status, 'Uid');
        if (uid.length === 4 && uid.every((id) => Number(id) === process.getuid())) found.push(Number(pid));
      } catch (error) {
        if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) throw error;
      }
    }));
  }
  return found;
}

function processControl(child, profile) {
  let exited = false, cleanup;
  const observed = new Map();
  function observeOwned(rows) {
    for (const row of rows) if (observed.size < 512 || observed.has(row.pid)) observed.set(row.pid, row);
  }

  async function liveObserved() {
    const live = [];
    for (const row of observed.values()) {
      const current = await procIdentity(row.pid);
      if (current?.start !== row.start) { observed.delete(row.pid); continue; }
      const status = await readFile(`/proc/${row.pid}/status`, 'utf8').catch(() => '');
      const uid = statusField(status, 'Uid');
      if (uid.length === 4 && uid.every((id) => Number(id) === process.getuid())) live.push(row.pid);
    }
    return live;
  }
  const exit = new Promise((resolve) => {
    child.once('exit', () => { exited = true; resolve(); });
    child.on('error', () => { exited = true; resolve(); });
  });

  function signalOwned(pid, signal) {
    try { process.kill(pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') throw fail('BROWSER_CLEANUP_FAILED'); }
  }

  async function signalBrowser(signal) {
    if (child.pid) signalOwned(-child.pid, signal);
    for (const pid of new Set([...(await liveObserved()), ...(await profileHelpers(profile))])) signalOwned(pid, signal);
  }

  async function awaitEmpty(grace) {
    const until = Date.now() + grace;
    do {
      if (exited && !(await liveObserved()).length && (!child.pid || !(await groupMembers(child.pid)).length) &&
          !(await profileHelpers(profile)).length) return true;
      if (exited) await delay(50);
      else {
        let timer;
        await Promise.race([exit, new Promise((resolve) => { timer = setTimeout(resolve, 50); })]);
        clearTimeout(timer);
      }
    } while (Date.now() < until);
    return false;
  }

  function shutdown() {
    if (cleanup) return cleanup;
    cleanup = (async () => {
      child.stdio[3]?.destroy();
      child.stdio[4]?.destroy();
      try {
        if (!(await awaitEmpty(500))) {
          await signalBrowser('SIGTERM');
          if (!(await awaitEmpty(350))) {
            await signalBrowser('SIGKILL');
            if (!(await awaitEmpty(1_500))) throw fail('BROWSER_CLEANUP_FAILED');
          }
        }
        try { await safeRemove(profile); } catch { throw fail('BROWSER_CLEANUP_FAILED'); }
      } finally { child.stderr?.destroy(); }
    })();
    return cleanup;
  }
  return { shutdown, observeOwned };
}

async function launch(policy, probeOnly, signal) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw fail('BROWSER_CONFIGURATION_INVALID');
  const timeout = AbortSignal.timeout(STARTUP_MS);
  const startup = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const abortCode = () => signal?.aborted ? 'BROWSER_ABORTED' : 'BROWSER_TIMEOUT';
  const checkStartup = () => { if (startup.aborted) throw fail(abortCode()); };
  checkStartup();
  if (process.platform !== 'linux' || typeof process.getuid !== 'function' || process.getuid() === 0 || process.geteuid() === 0) {
    throw fail('BROWSER_SANDBOX_REQUIRED');
  }
  let executable, profile, shutdown, stderr;
  try {
    executable = await realpath(policy.executablePath);
    await access(executable, constants.X_OK);
  } catch { throw fail('BROWSER_EXECUTABLE_REQUIRED'); }
  try {
    checkStartup();
    profile = await mkdtemp(join(PROFILE_ROOT, PROFILE_PREFIX));
    await chmod(profile, 0o700);
    const env = await runtimeEnv(profile);
    checkStartup();
    const child = spawn(executable, browserFlags(profile, policy.proxyUrl), {
      cwd: profile, detached: true, env, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    });
    stderr = classifyStartupStderr(child.stderr);
    const control = processControl(child, profile);
    shutdown = control.shutdown;
    return await startChromiumSession({ writer: child.stdio[3], reader: child.stdio[4], policy, shutdown, probeOnly,
      signal: startup, abortCode, handshakeMs: HANDSHAKE_MS, async verifySandbox(getProcessInfo) {
        await verifyRendererSandbox({ pid: child.pid, uid: process.getuid(), profile, signal: startup, getProcessInfo,
          trustedBrowserInventory: true, observeOwned: control.observeOwned });
        stderr.finish();
      } });
  } catch (error) {
    try {
      if (shutdown) await shutdown();
      else if (profile) await safeRemove(profile);
    } catch { throw fail('BROWSER_CLEANUP_FAILED'); }
    const code = error instanceof EngineError ? error.code : 'BROWSER_START_FAILED';
    throw fail(code, { ...error?.diagnostic, launchHint: stderr?.hint() });
  } finally { stderr?.finish(); }
}

/** A single supervised Chromium page. The caller owns lease/auth and the network namespace. */
export async function createChromiumEngine(options) {
  return launch(configPolicy(options), false, options?.signal);
}

/** Boot, verify the kernel sandbox, render about:blank, and close. No site is contacted. */
export async function probeChromium({ executablePath, proxyUrl = 'http://127.0.0.1:9', signal } = {}) {
  const engine = await launch(configPolicy({ executablePath, proxyUrl, startUrl: 'http://127.0.0.1:9/' }), true, signal);
  await engine.close();
  if (signal?.aborted) throw fail('BROWSER_ABORTED');
  return { available: true };
}
