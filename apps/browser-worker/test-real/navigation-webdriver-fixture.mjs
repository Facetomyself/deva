// Fixed W3C comparison lanes for engine-navigation-matrix.mjs only. no shell or CDP bridge.
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { request } from 'node:http';
import { isAbsolute, join } from 'node:path';
import { fail } from '../src/engine/policy.mjs';
import { classifyRendererCmdline, procIdentity, verifyRendererSandbox } from '../src/engine/sandbox.mjs';

export async function webdriverExecutable() {
  const dir = process.env.CHROMEWEBDRIVER;
  const configured = process.env.CHROMEDRIVER_BIN || (dir && join(dir, 'chromedriver'));
  for (const path of configured ? [configured] : ['/usr/bin/chromedriver', '/usr/local/bin/chromedriver']) {
    if (!isAbsolute(path)) continue;
    try { await access(path, constants.X_OK); if ((await stat(path)).isFile()) return path; } catch { /* try next */ }
  }
  throw fail('BROWSER_QA_DRIVER_REQUIRED');
}

function endpoint(child, signal) {
  return new Promise((resolve, reject) => {
    let pending = '', size = 0;
    const timer = setTimeout(() => finish(fail('BROWSER_QA_DRIVER_START')), 5000);
    const onExit = () => finish(fail('BROWSER_QA_DRIVER_START'));
    const onAbort = () => finish(fail('BROWSER_TIMEOUT'));
    function finish(error, port) {
      clearTimeout(timer);
      child.off('exit', onExit);
      child.stdout.off('data', receive);
      signal.removeEventListener('abort', onAbort);
      child.stdout.resume();
      if (error) reject(error); else resolve(port);
    }
    function receive(bytes) {
      size += bytes.length;
      if (size > 32 * 1024) return finish(fail('BROWSER_QA_DRIVER_START'));
      pending += bytes.toString('utf8');
      for (;;) {
        const end = pending.indexOf('\n');
        if (end === -1) return;
        const line = pending.slice(0, end).trim();
        pending = pending.slice(end + 1);
        const port = Number(/^ChromeDriver was started successfully on port (\d+)\.?$/u.exec(line)?.[1]);
        if (port > 0 && port <= 65535) return finish(null, port);
      }
    }
    child.once('exit', onExit);
    child.stdout.on('data', receive);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function webdriverRequest(port, method, path, data, ms = 5000) {
  return new Promise((resolve, reject) => {
    const body = data === undefined ? null : Buffer.from(JSON.stringify(data));
    const req = request({ host: '127.0.0.1', port, method, path, agent: false,
      headers: body ? { 'content-type': 'application/json', 'content-length': body.length } : undefined }, (response) => {
      let length = 0;
      const chunks = [];
      response.on('data', (chunk) => {
        length += chunk.length;
        if (length > 512 * 1024) { response.destroy(); reject(fail('BROWSER_QA_DRIVER_RESPONSE')); }
        else chunks.push(chunk);
      });
      response.on('error', () => reject(fail('BROWSER_QA_DRIVER_RESPONSE')));
      response.on('end', () => {
        try { resolve({ status: response.statusCode, value: JSON.parse(Buffer.concat(chunks)).value }); }
        catch { reject(fail('BROWSER_QA_DRIVER_RESPONSE')); }
      });
    });
    req.on('error', () => reject(fail('BROWSER_QA_DRIVER_RESPONSE')));
    req.setTimeout(ms, () => req.destroy());
    req.end(body);
  });
}

async function ownedTree(root) {
  const rows = [];
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/u.test(name)) continue;
    const row = await procIdentity(Number(name));
    if (row) rows.push(row);
  }
  if (!rows.some((row) => row.pid === root.pid && row.start === root.start)) return [];
  const seen = new Set([root.pid]);
  const descendants = [];
  for (let depth = 0; depth < 20; depth++) {
    const group = rows.filter(({ pid, parent, start }) => seen.has(parent) && !seen.has(pid) && BigInt(start) >= BigInt(root.start));
    if (!group.length) break;
    for (const row of group) { seen.add(row.pid); descendants.push(row); }
  }
  return descendants;
}

async function actualArgv(row) {
  const raw = await readFile(`/proc/${row.pid}/cmdline`, 'utf8').catch(() => '');
  return (await procIdentity(row.pid))?.start === row.start ? raw : '';
}

async function verifyW3cSandbox(owned, signal) {
  const driver = await procIdentity(owned.child.pid);
  if (!driver) throw fail('BROWSER_SANDBOX_REQUIRED');
  async function getProcessInfo() {
    const rows = await ownedTree(driver);
    const candidates = [];
    for (const row of rows) {
      const argv = (await actualArgv(row)).split('\0');
      if (argv.includes(`--user-data-dir=${owned.profile}`) && argv.includes('--remote-debugging-pipe') &&
          !argv.some((arg) => arg.startsWith('--type='))) candidates.push(row);
    }
    if (candidates.length !== 1) return { processInfo: [] };
    const [browser] = candidates;
    const processInfo = [{ id: browser.pid, type: 'browser' }];
    for (const row of await ownedTree(browser)) {
      const argv = await actualArgv(row);
      processInfo.push({ id: row.pid, type: classifyRendererCmdline(argv).explicitRenderer ? 'renderer' : 'child' });
    }
    return { processInfo };
  }
  await verifyRendererSandbox({ pid: driver.pid, uid: process.getuid(), profile: owned.profile, signal,
    getProcessInfo, trustedBrowserInventory: false, observeOwned: owned.observeOwned, timeoutMs: 4500 });
}

export function fixedWebdriverComparison({ owned, binary, local, trace, signal, direct, observe }) {
  let port, id, pinnedWindow, bootUrl, firstPassed = false, cdpAttempted = false;
  async function sameWindow() {
    const { status, value } = await webdriverRequest(port, 'GET', `/session/${id}/window`);
    if (status !== 200 || typeof value !== 'string' || !/^[a-z\d_\-]{1,128}$/iu.test(value) ||
        (pinnedWindow && pinnedWindow !== value)) throw fail('BROWSER_TARGET_LOST');
    pinnedWindow = value;
  }
  async function logs(path, keep) {
    const result = await webdriverRequest(port, 'POST', `${path}/se/log`, { type: 'performance' }).catch(() => null);
    if (keep && Array.isArray(result?.value)) for (const item of result.value.slice(0, 512)) {
      let entry;
      try { entry = JSON.parse(item.message).message; } catch { continue; }
      if (entry && typeof entry.method === 'string') observe(entry.method, entry.params ?? {}, item.timestamp);
    }
  }
  async function navigateFixed(viaCdp) {
    const path = `/session/${id}`;
    await logs(path, false);
    trace.begin();
    trace.bump('navigateSent');
    let result;
    try {
      result = viaCdp ? await webdriverRequest(port, 'POST', `${path}/goog/cdp/execute`, {
        cmd: 'Page.navigate', params: { url: local.url },
      }, 17_000) : await webdriverRequest(port, 'POST', `${path}/url`, { url: local.url }, 17_000);
      trace.bump('navigateAck');
      if (result.status !== 200) trace.failure(/\bnet::ERR_[A-Z_]+\b/u.exec(result.value?.message ?? '')?.[0], undefined, false);
      if (viaCdp && result.value?.errorText) trace.failure(result.value.errorText, undefined, false);
      if (viaCdp && result.value?.isDownload) trace.bump('download');
      if (result.status === 200 && !result.value?.errorText && !result.value?.isDownload) {
        const title = await webdriverRequest(port, 'GET', `${path}/title`);
        if (title.status !== 200 || title.value !== 'Chromium pipe QA') throw fail('BROWSER_NAVIGATION_FAILED');
      }
    } finally { await logs(path, true); }
    if (result.status !== 200 || result.value?.errorText || result.value?.isDownload || trace.counters.documentReceived === 0 ||
        (direct ? trace.counters.proxyAccepted !== 0 : trace.counters.proxyAccepted === 0)) throw fail('BROWSER_NAVIGATION_FAILED');
    await sameWindow();
  }
  return {
    async pin() {
      port = await endpoint(owned.child, signal);
      if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/qa-document$/u.test(local.url)) throw fail('BROWSER_QA_FIXED_FIXTURE');
      const { status, value } = await webdriverRequest(port, 'POST', '/session', { capabilities: { alwaysMatch: {
        browserName: 'chrome', pageLoadStrategy: 'normal', timeouts: { implicit: 0, pageLoad: 15_000, script: 5000 },
        'goog:loggingPrefs': { performance: 'ALL' },
        'goog:chromeOptions': { binary, perfLoggingPrefs: { enableNetwork: true, enablePage: true }, args: [
          '--headless', '--remote-debugging-pipe', `--user-data-dir=${owned.profile}`, '--window-size=1024,768',
          ...(direct ? ['--no-proxy-server'] : [`--proxy-server=${local.proxyUrl}`, '--proxy-bypass-list=<-loopback>']),
          '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-quic', '--disable-background-networking',
          '--disable-component-update', '--disable-extensions', '--disable-component-extensions-with-background-pages',
          '--disable-default-apps', '--disable-sync', '--no-first-run', '--no-default-browser-check',
        ] },
      } } });
      if (status !== 200 || !/^[a-f\d]{32}$/iu.test(value?.sessionId ?? '')) throw fail('BROWSER_QA_DRIVER_SESSION');
      id = value.sessionId;
      await sameWindow();
      const initial = await webdriverRequest(port, 'GET', `/session/${id}/url`);
      if (initial.status !== 200 || !['about:blank', 'data:,'].includes(initial.value)) throw fail('BROWSER_QA_FIXED_FIXTURE');
      bootUrl = initial.value;
    },
    async attest() { await verifyW3cSandbox(owned, signal); },
    async navigate() { await navigateFixed(false); firstPassed = true; },
    async compareCdpNavigation() {
      if (direct || !firstPassed || cdpAttempted) throw fail('BROWSER_QA_FIXED_FIXTURE');
      cdpAttempted = true;
      const blank = await webdriverRequest(port, 'POST', `/session/${id}/url`, { url: bootUrl });
      if (blank.status !== 200) throw fail('BROWSER_NAVIGATION_FAILED');
      await sameWindow();
      await navigateFixed(true);
    },
    async close() { if (id) await webdriverRequest(port, 'DELETE', `/session/${id}`).catch(() => {}); },
  };
}

export const launchDriver = (binary, env, profile) => spawn(binary, ['--port=0'],
  { env, cwd: profile, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
