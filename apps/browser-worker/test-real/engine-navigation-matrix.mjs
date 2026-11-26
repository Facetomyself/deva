#!/usr/bin/env node
// Non-deployable diagnostic only. Run as a normal Linux user with CHROMIUM_PATH set.
// The sole target is this program's freshly bound loopback fixture; arguments cannot set a URL.
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { connectPipe } from '../src/engine/pipe.mjs';
import { BOOTSTRAP_URL, fail, PAGE_POLICIES, readFrame, VIEWPORT } from '../src/engine/policy.mjs';
import { procIdentity, verifyRendererSandbox } from '../src/engine/sandbox.mjs';
import { fixedWebdriverComparison, launchDriver, webdriverExecutable } from './navigation-webdriver-fixture.mjs';

const NAVIGATION_MS = 15_000;
const LANES = [
  { name: 'webdriver-proxy-w3c', webdriver: true, paired: true },
  { name: 'native-task-startup-kept', task: true, keepComponents: true },
];
const SITE_POLICY = "default-src 'none'; sandbox; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";
const SITE_PATH = '/qa-document';
const HEALTH_PATH = '/qa-proxy-probe';
const SITE_TITLE = 'Chromium pipe QA';
const PAGES = [{ type: 'page', exclude: false }, { exclude: true }];
const TARGETS = ['page', 'iframe', 'worker', 'shared_worker', 'service_worker'].map((type) => ({ type, exclude: false }))
  .concat({ exclude: true });
const COUNTERS = ['navigateSent', 'navigateAck', 'frameStartedNavigating', 'frameStartedLoading', 'frameCommit', 'frameLoad',
  'networkRequest', 'networkResponse', 'networkFailed', 'fetchRequest', 'fetchRequestAck', 'fetchResponse', 'fetchResponseAck',
  'fetchBlocked', 'proxyReceived', 'proxyAccepted', 'proxyResponse', 'proxyRejected', 'proxyConnect', 'documentReceived',
  'documentResponse', 'targetCreated', 'componentSeen', 'componentRetired', 'requestExpected', 'requestUpgraded', 'requestOther',
  'blockedReason', 'localNetworkAccess', 'localNetworkPolicy', 'httpsUpgradeConnect', 'interstitial', 'errorPageCommit', 'download'];
const MILESTONES = { frameStartedNavigating: 'firstFrameMs', networkRequest: 'firstNetworkMs', fetchRequest: 'firstFetchMs',
  proxyAccepted: 'firstProxyMs', documentReceived: 'firstDocumentMs', navigateAck: 'navigateAckMs' };
const FAILURE_KIND = new Set(['net::ERR_ABORTED', 'net::ERR_BLOCKED_BY_CLIENT', 'net::ERR_PROXY_CONNECTION_FAILED',
  'net::ERR_NAME_NOT_RESOLVED', 'net::ERR_CONNECTION_REFUSED', 'net::ERR_TIMED_OUT', 'net::ERR_FAILED',
  'net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS', 'net::ERR_TUNNEL_CONNECTION_FAILED', 'net::ERR_SSL_PROTOCOL_ERROR']);
const LNA_KINDS = new Set(['InsecurePrivateNetwork', 'InvalidPrivateNetworkAccess', 'UnexpectedPrivateNetworkAccess',
  'InsecureLocalNetwork', 'PreflightMissingAllowPrivateNetwork', 'PreflightInvalidAllowPrivateNetwork',
  'LocalNetworkAccessPermissionDenied', 'LocalNetworkAccessPermissionDismissed', 'LocalNetworkAccessPermissionUnavailable']);
const BLOCK_KINDS = new Set(['csp', 'mixed-content', 'origin', 'inspector', 'subresource-filter', 'content-type',
  'coep-frame-resource-needs-coep-header', 'corp-not-same-origin', 'corp-not-same-origin-after-defaulted-to-same-origin-by-coep',
  'corp-not-same-site', 'other']);

function evidence() {
  const counters = Object.fromEntries(COUNTERS.map((key) => [key, 0]));
  const milliseconds = Object.fromEntries(Object.values(MILESTONES).map((key) => [key, -1]));
  let started, startWall, finished;
  return {
    counters, milliseconds, networkFailure: 'none', blockedKind: 'none',
    begin() { started = performance.now(); startWall = Date.now(); },
    reset() {
      started = undefined; finished = undefined; startWall = undefined;
      this.networkFailure = 'none'; this.blockedKind = 'none';
      for (const key of COUNTERS) counters[key] = 0;
      for (const key of Object.values(MILESTONES)) milliseconds[key] = -1;
    },
    bootstrap(key) { if (finished === undefined) counters[key] = Math.min(256, counters[key] + 1); },
    finish() { finished ??= performance.now(); },
    elapsed: () => started === undefined ? -1 : Math.min(60_000, Math.floor((finished ?? performance.now()) - started)),
    failure(errorText, eventWall, count = true) {
      if (started === undefined || finished !== undefined) return;
      if (count) this.bump('networkFailed', eventWall);
      if (FAILURE_KIND.has(errorText)) this.networkFailure = errorText.slice(5);
      else if (this.networkFailure === 'none') this.networkFailure = 'other';
    },
    blocked(value, eventWall) {
      if (typeof value !== 'string' || !value || started === undefined || finished !== undefined) return;
      this.bump('blockedReason', eventWall);
      this.blockedKind = BLOCK_KINDS.has(value) ? value : 'other';
    },
    bump(key, eventWall) {
      if (started === undefined || finished !== undefined || (Number.isFinite(eventWall) && eventWall < startWall)) return;
      counters[key] = Math.min(256, counters[key] + 1);
      const time = MILESTONES[key];
      if (time && milliseconds[time] < 0) milliseconds[time] = Number.isFinite(eventWall) ?
        Math.min(60_000, Math.floor(eventWall - startWall)) : this.elapsed();
    },
  };
}

async function browserExecutable() {
  const configured = process.env.CHROMIUM_PATH || process.env.CHROME_BIN;
  const paths = configured ? [configured] : ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'];
  for (const path of paths) {
    if (!isAbsolute(path)) continue;
    try { await access(path, constants.X_OK); if ((await stat(path)).isFile()) return path; } catch { /* try next */ }
  }
  throw fail('BROWSER_EXECUTABLE_REQUIRED');
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function stopServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
}

async function fixture(trace) {
  const site = createServer((req, res) => {
    if (req.method !== 'GET') return res.writeHead(405).end();
    if (req.url === HEALTH_PATH) return res.writeHead(204).end();
    if (req.url !== SITE_PATH) return res.writeHead(404).end();
    trace.bump('documentReceived');
    res.once('finish', () => trace.bump('documentResponse'));
    return res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8', 'Content-Security-Policy': SITE_POLICY,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).end(
      `<!doctype html><meta charset="UTF-8"><title>${SITE_TITLE}</title><h1>Local navigation fixture</h1>`);
  });
  let proxy;
  try {
    const origin = await listen(site);
    const url = `${origin}${SITE_PATH}`;
    const health = `${origin}${HEALTH_PATH}`;
    const expected = new URL(url);
    proxy = createServer((req, res) => {
      trace.bump('proxyReceived');
      // Do not relay HTTP headers, credentials, redirects, or any request except these exact local GETs.
      if (req.method !== 'GET' || (req.url !== url && req.url !== health)) {
        trace.bump('proxyRejected');
        return res.writeHead(403).end();
      }
      trace.bump('proxyAccepted');
      const upstream = request(`${origin}${req.url === url ? SITE_PATH : HEALTH_PATH}`,
        { method: 'GET', agent: false, headers: { connection: 'close' } }, (result) => {
        trace.bump('proxyResponse');
        res.writeHead(result.statusCode, result.headers);
        result.pipe(res);
      });
      upstream.on('error', () => res.destroy());
      res.on('close', () => upstream.destroy());
      req.resume();
      upstream.end();
    });
    proxy.on('connect', (req, socket) => {
      trace.bump('proxyConnect');
      if (req.url === `${expected.hostname}:443` || (expected.port && req.url === expected.host)) trace.bump('httpsUpgradeConnect');
      socket.destroy();
    });
    proxy.on('upgrade', (_req, socket) => socket.destroy());
    const proxyUrl = await listen(proxy);
    const check = await new Promise((resolve, reject) => {
      const req = request(proxyUrl, { path: health, agent: false }, (res) => {
        res.resume();
        res.once('end', () => resolve(res.statusCode));
        res.once('error', reject);
      });
      req.once('error', reject);
      req.setTimeout(1500, () => req.destroy());
      req.end();
    });
    if (check !== 204) throw fail('BROWSER_FIXTURE_PROXY_FAILED');
    return { url, proxyUrl, close: () => Promise.all([stopServer(proxy), stopServer(site)]) };
  } catch {
    await Promise.all([proxy && stopServer(proxy), stopServer(site)]);
    throw fail('BROWSER_FIXTURE_PROXY_FAILED');
  }
}

async function activeGroup(pid) {
  if (!pid) return [];
  const rows = [];
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/u.test(name)) continue;
    const raw = await readFile(`/proc/${name}/stat`, 'utf8').catch(() => '');
    if (!raw) continue;
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    if (Number(fields[2]) === pid && fields[0] !== 'Z' && fields[0] !== 'X') rows.push(Number(name));
  }
  return rows;
}

async function childLauncher(executablePath, proxyUrl, driverPath = null) {
  const profile = await mkdtemp('/tmp/deva-engine-qa-');
  if (dirname(profile) !== '/tmp' || !/^deva-engine-qa-[a-z0-9]{6}$/iu.test(basename(profile))) throw fail('BROWSER_QA_CLEANUP');
  let child;
  const owned = new Map();
  let exited = false;
  try {
    await chmod(profile, 0o700);
    for (const name of ['tmp', 'config', 'cache', 'data', 'runtime', 'Default']) await mkdir(join(profile, name), { mode: 0o700 });
    await writeFile(join(profile, 'Default', 'Preferences'), JSON.stringify({ credentials_enable_service: false,
      profile: { password_manager_enabled: false }, autofill: { profile_enabled: false, credit_card_enabled: false } }),
    { mode: 0o600, flag: 'wx' });
    const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: profile, TMPDIR: join(profile, 'tmp'),
      XDG_CONFIG_HOME: join(profile, 'config'), XDG_CACHE_HOME: join(profile, 'cache'), XDG_DATA_HOME: join(profile, 'data'),
      XDG_RUNTIME_DIR: join(profile, 'runtime') };
    child = driverPath ? launchDriver(driverPath, env, profile) : spawn(executablePath, ['--headless', '--remote-debugging-pipe', `--user-data-dir=${profile}`,
      '--window-size=1024,768', `--proxy-server=${proxyUrl}`, '--proxy-bypass-list=<-loopback>',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-quic',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--disable-blink-features=FileSystemAccess,FileSystemAccessLocal',
      '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update',
      '--disable-extensions', '--disable-sync',
      '--disable-breakpad', '--disable-crash-reporter', '--disable-crashpad-for-testing', '--password-store=basic', BOOTSTRAP_URL],
    { env, cwd: profile, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
    child.once('exit', () => { exited = true; });
    child.once('error', () => { exited = true; });
  } catch {
    await rm(profile, { recursive: true, force: true });
    throw fail('BROWSER_QA_LAUNCH');
  }
  async function ownedAlive() {
    const live = [];
    for (const row of owned.values()) if ((await procIdentity(row.pid))?.start === row.start) live.push(row.pid);
    return live;
  }
  async function waitExit(ms) {
    const end = Date.now() + ms;
    do {
      if (exited && !(await activeGroup(child.pid)).length && !(await ownedAlive()).length) return true;
      await sleep(40);
    } while (Date.now() < end);
    return false;
  }
  function signal(pid, value) {
    try { process.kill(pid, value); } catch (error) { if (error.code !== 'ESRCH') throw fail('BROWSER_QA_CLEANUP'); }
  }
  async function terminate(value) {
    if (child.pid && (!exited || (await activeGroup(child.pid)).length)) signal(-child.pid, value);
    for (const pid of await ownedAlive()) signal(pid, value);
  }
  return { child, profile, observeOwned(rows) { for (const row of rows) owned.set(row.pid, row); }, async close() {
    child.stdio[3]?.destroy();
    child.stdio[4]?.destroy();
    child.stdout?.destroy();
    if (!(await waitExit(350))) {
      await terminate('SIGTERM');
      if (!(await waitExit(350))) {
        await terminate('SIGKILL');
        if (!(await waitExit(1000))) throw fail('BROWSER_QA_CLEANUP');
      }
    }
    await rm(profile, { recursive: true, force: true });
  } };
}

function observer(trace, url, ownFrame = () => true) {
  const expected = new URL(url);
  function classification(raw) {
    if (raw === url) return 'requestExpected';
    try {
      const seen = new URL(raw);
      if (seen.protocol === 'https:' && seen.hostname === expected.hostname && seen.pathname === expected.pathname &&
          !seen.username && !seen.password && !seen.search && !seen.hash && (!seen.port || seen.port === expected.port)) {
        return 'requestUpgraded';
      }
    } catch { /* count as other */ }
    return 'requestOther';
  }
  return (method, p, wall) => {
    if (method === 'Page.frameStartedNavigating' && ownFrame(p.frameId)) trace.bump('frameStartedNavigating', wall);
    if (method === 'Page.frameStartedLoading' && ownFrame(p.frameId)) trace.bump('frameStartedLoading', wall);
    if (method === 'Page.frameNavigated' && p.frame && !p.frame.parentId && ownFrame(p.frame.id)) {
      if (p.frame.url === url && !p.frame.unreachableUrl) trace.bump('frameCommit', wall);
      if (p.frame.unreachableUrl || /^chrome-error:\//u.test(p.frame.url ?? '')) trace.bump('errorPageCommit', wall);
    }
    if (method === 'Page.lifecycleEvent' && ownFrame(p.frameId) && p.name === 'load') trace.bump('frameLoad', wall);
    if (method === 'Page.interstitialShown') trace.bump('interstitial', wall);
    if (method === 'Browser.downloadWillBegin' || method === 'Page.downloadWillBegin') trace.bump('download', wall);
    if (method === 'Network.requestWillBeSent' && p.type === 'Document') {
      trace.bump('networkRequest', wall);
      trace.bump(classification(p.request?.url), wall);
    }
    if (method === 'Network.responseReceived' && p.type === 'Document') trace.bump('networkResponse', wall);
    if (method === 'Network.loadingFailed' && p.type === 'Document') {
      trace.failure(p.errorText, wall);
      trace.blocked(p.blockedReason, wall);
      if (LNA_KINDS.has(p.corsErrorStatus?.corsError) || p.errorText === 'net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS') {
        trace.bump('localNetworkAccess', wall);
      }
    }
    if (method === 'Network.requestWillBeSentExtraInfo' &&
        ['Block', 'Warn', 'PreflightBlock', 'PreflightWarn', 'PermissionBlock', 'PermissionWarn']
          .includes(p.clientSecurityState?.privateNetworkRequestPolicy)) trace.bump('localNetworkPolicy', wall);
    if (method === 'Audits.issueAdded' && LNA_KINDS.has(p.issue?.details?.corsIssueDetails?.corsErrorStatus?.corsError)) {
      trace.bump('localNetworkAccess', wall);
    }
  };
}

function controller({ browser, local, lane, trace, signal }) {
  let bootId, bootContext, context, target, candidate, main, control, guard, fault;
  let pageCreating = false, navigated = false;
  const retired = new Map();
  const preserved = new Set();
  const inspect = observer(trace, local.url, (frame) => frame === main);
  const pipe = connectPipe(browser.child.stdio[3], browser.child.stdio[4], { onEvent, onFailure: setFault });
  const root = (name, args) => pipe.send(name, args);
  const on = (sid) => (name, args, timeoutMs) => pipe.send(name, args, sid, timeoutMs);
  signal.addEventListener('abort', () => pipe.stop('BROWSER_TIMEOUT'), { once: true });
  function setFault(code) { fault ??= code; }
  function check() { if (fault) throw fail(fault); if (signal.aborted) throw fail('BROWSER_TIMEOUT'); }
  function defaultComponent(info) {
    return !!bootContext && context !== bootContext && info?.browserContextId === bootContext &&
      info.type === 'service_worker' && !info.openerId && !info.attached && typeof info.targetId === 'string' &&
      info.targetId !== bootId && info.targetId !== target && info.targetId !== candidate &&
      /^chrome-extension:\/\/[a-p]{32}\/[!-~]*$/u.test(info.url ?? '');
  }
  function targetCreated(info) {
    trace.bump('targetCreated');
    const candidateBlank = info?.type === 'page' && !info.openerId && (!info.url || info.url === BOOTSTRAP_URL);
    if (info?.targetId === bootId && candidateBlank && !navigated && info.browserContextId !== context &&
        (!bootContext || !info.browserContextId || info.browserContextId === bootContext)) {
      bootContext ||= info.browserContextId;
      return;
    }
    if (info?.targetId === target && candidateBlank && !navigated && info.browserContextId === context) return;
    if (pageCreating && !candidate && candidateBlank && info.browserContextId === context && typeof info.targetId === 'string') {
      candidate = info.targetId;
      return;
    }
    // Only a pre-navigation Chrome-owned component in the independently verified
    // default context can be observed here. Never attach to it or send it input.
    if (!navigated && defaultComponent(info) && !preserved.has(info.targetId) && !retired.has(info.targetId) &&
        preserved.size + retired.size < 8) {
      trace.bootstrap('componentSeen');
      if (lane.keepComponents) preserved.add(info.targetId);
      else retired.set(info.targetId, root('Target.closeTarget', { targetId: info.targetId }).then(({ success }) => {
        if (success !== true) setFault('BROWSER_TARGET_LOST');
        else trace.bootstrap('componentRetired');
      }, () => setFault('BROWSER_TARGET_LOST')));
      return;
    }
    setFault('BROWSER_TARGET_LOST');
    pipe.stop('BROWSER_TARGET_LOST');
  }
  function continueFetch(name, params, evidenceKey) {
    on(guard)(name, params).then(() => { if (evidenceKey) trace.bump(evidenceKey); }, (error) => setFault(error.code));
  }
  function fetchPaused(p) {
    const response = p.responseStatusCode !== undefined || !!p.responseErrorReason;
    trace.bump(response ? 'fetchResponse' : 'fetchRequest');
    if (p.resourceType !== 'Document' || p.frameId !== main || p.request?.url !== local.url ||
        (response && (p.responseStatusCode !== 200 || p.responseErrorReason || !Array.isArray(p.responseHeaders)))) {
      trace.bump('fetchBlocked');
      return continueFetch('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' });
    }
    if (!response) return continueFetch('Fetch.continueRequest', { requestId: p.requestId, interceptResponse: true }, 'fetchRequestAck');
    return continueFetch('Fetch.continueResponse', { requestId: p.requestId, responseCode: 200, responsePhrase: 'OK',
      responseHeaders: [...p.responseHeaders, ...PAGE_POLICIES] }, 'fetchResponseAck');
  }
  function onEvent(method, p, sid) {
    if (method === 'Target.targetCreated' && sid === null) return targetCreated(p.targetInfo);
    if (method === 'Target.targetDestroyed' && p.targetId === target) return setFault('BROWSER_TARGET_LOST');
    if (method === 'Fetch.requestPaused' && sid === guard) return fetchPaused(p);
    if (method === 'Fetch.authRequired' && sid === guard) return continueFetch('Fetch.continueWithAuth',
      { requestId: p.requestId, authChallengeResponse: { response: 'CancelAuth' } });
    if (sid === control || (sid === null && method === 'Browser.downloadWillBegin')) inspect(method, p);
  }
  return {
    async pin() {
      const version = await root('Browser.getVersion');
      if (!/^(?:Chrome|Chromium|HeadlessChrome)\/[\d.]+$/u.test(version.product ?? '')) throw fail('BROWSER_QA_LAUNCH');
      let initial;
      for (let i = 0; i < 8; i++) {
        const { targetInfos } = await root('Target.getTargets', { filter: PAGES });
        if (!Array.isArray(targetInfos) || targetInfos.length > 1) throw fail('BROWSER_TARGET_LOST');
        [initial] = targetInfos;
        if (initial?.url) break;
        await sleep(50, undefined, { signal });
      }
      if (initial?.url !== BOOTSTRAP_URL || initial.type !== 'page' || initial.openerId || initial.attached ||
          typeof initial.targetId !== 'string' || !initial.targetId) throw fail('BROWSER_TARGET_LOST');
      bootId = initial.targetId;
      bootContext = initial.browserContextId;
      if (lane.task) {
        ({ browserContextId: context } = await root('Target.createBrowserContext', { disposeOnDetach: true }));
        if (typeof context !== 'string' || !context || context === bootContext) throw fail('BROWSER_TARGET_LOST');
      } else target = bootId;
      await root('Target.setDiscoverTargets', { discover: true, filter: TARGETS });
      check();
      if (lane.task) {
        pageCreating = true;
        ({ targetId: target } = await root('Target.createTarget', { browserContextId: context, url: BOOTSTRAP_URL, background: false }));
        pageCreating = false;
        if (typeof target !== 'string' || !target || target === bootId || (candidate && candidate !== target)) throw fail('BROWSER_TARGET_LOST');
      }
      await root('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true, ...(context ? { browserContextId: context } : {}) });
      ({ sessionId: control } = await root('Target.attachToTarget', { targetId: target, flatten: true }));
      if (typeof control !== 'string' || !control) throw fail('BROWSER_TARGET_LOST');
      guard = control;
      if (lane.split) {
        ({ sessionId: guard } = await root('Target.attachToTarget', { targetId: target, flatten: true }));
        if (typeof guard !== 'string' || !guard || guard === control) throw fail('BROWSER_TARGET_LOST');
      }
      const { targetInfo } = await root('Target.getTargetInfo', { targetId: target });
      if (targetInfo?.targetId !== target || targetInfo.type !== 'page' || targetInfo.url !== BOOTSTRAP_URL ||
          targetInfo.openerId || (context && targetInfo.browserContextId !== context)) throw fail('BROWSER_TARGET_LOST');
    },
    async guard() {
      const page = on(control);
      const protectedPage = on(guard);
      await page('Page.enable');
      await page('Page.setLifecycleEventsEnabled', { enabled: true });
      await page('Network.enable');
      await page('Audits.enable').catch((error) => { if (error.code !== 'BROWSER_COMMAND_FAILED') throw error; });
      if (lane.guards) {
        await protectedPage('Page.setInterceptFileChooserDialog', { enabled: true });
        await protectedPage('Network.setCacheDisabled', { cacheDisabled: true });
        await protectedPage('Network.setBypassServiceWorker', { bypass: true });
        await protectedPage('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, screenWidth: VIEWPORT.width,
          screenHeight: VIEWPORT.height, deviceScaleFactor: 1, mobile: false });
      } else await page('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
      const { frameTree } = await page('Page.getFrameTree');
      if (frameTree?.frame?.url !== BOOTSTRAP_URL || typeof frameTree.frame.id !== 'string') throw fail('BROWSER_TARGET_LOST');
      main = frameTree.frame.id;
      if (lane.guards) await protectedPage('Fetch.enable', { handleAuthRequests: true,
        patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] });
      readFrame((await page('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false,
        clip: { x: 0, y: 0, ...VIEWPORT, scale: 1 } })).data);
    },
    async attest() {
      await verifyRendererSandbox({ pid: browser.child.pid, uid: process.getuid(), profile: browser.profile,
        getProcessInfo: () => root('SystemInfo.getProcessInfo'), trustedBrowserInventory: true,
        observeOwned: browser.observeOwned, signal });
      check();
    },
    async activate() {
      await Promise.all(retired.values());
      check();
      if (lane.retire && (await root('Target.closeTarget', { targetId: bootId })).success !== true) throw fail('BROWSER_TARGET_LOST');
      let clean;
      for (let attempt = 0; attempt < 12; attempt++) {
        await Promise.all(retired.values());
        const { targetInfos } = await root('Target.getTargets', { filter: TARGETS });
        check();
        if (!Array.isArray(targetInfos) || !targetInfos.some((item) => item.targetId === target && item.type === 'page' &&
            item.url === BOOTSTRAP_URL && !item.openerId && (!context || item.browserContextId === context))) break;
        const waiting = targetInfos.filter((item) => item.targetId !== target &&
          !(lane.keepComponents && preserved.has(item.targetId) && defaultComponent(item)) &&
          (lane.retire || item.targetId !== bootId || item.type !== 'page' || item.url !== BOOTSTRAP_URL || item.openerId ||
            (bootContext && item.browserContextId && item.browserContextId !== bootContext)));
        if (!waiting.length) { clean = true; break; }
        if (waiting.some((item) => !retired.has(item.targetId) && (!lane.retire || item.targetId !== bootId))) break;
        if (attempt < 11) await sleep(45, undefined, { signal });
      }
      if (!clean) throw fail('BROWSER_TARGET_LOST');
      await root('Target.activateTarget', { targetId: target });
      check();
    },
    async navigate() {
      navigated = true;
      trace.begin();
      trace.bump('navigateSent');
      const result = await on(control)('Page.navigate', { url: local.url }, NAVIGATION_MS);
      trace.bump('navigateAck');
      if (result.errorText) trace.failure(result.errorText, undefined, false);
      if (result.isDownload) trace.bump('download');
      if (result.errorText || result.isDownload || result.frameId !== main) throw fail('BROWSER_NAVIGATION_FAILED');
      const end = Date.now() + Math.max(0, NAVIGATION_MS - trace.elapsed());
      do {
        check();
        if (trace.counters.documentReceived > 0 && trace.counters.proxyAccepted > 0 && trace.counters.frameCommit > 0) {
          const { targetInfo } = await root('Target.getTargetInfo', { targetId: target });
          if (targetInfo?.targetId === target && targetInfo.url === local.url && targetInfo.title === SITE_TITLE &&
              (!lane.guards || (trace.counters.fetchRequestAck > 0 && trace.counters.fetchResponseAck > 0))) return;
        }
        await sleep(40, undefined, { signal });
      } while (Date.now() < end);
      throw fail('BROWSER_TIMEOUT');
    },
    async close() {
      await root('Browser.close').catch(() => {});
      pipe.stop();
    },
  };
}

async function runLane(executablePath, driverPath, lane) {
  const trace = evidence();
  const signal = AbortSignal.timeout(lane.paired ? 60_000 : 35_000);
  const reports = [];
  let name = lane.name, phase = 'fixture', code = 'none', local, browser, run, cleaned = true;
  function collect() {
    trace.finish();
    const counts = Object.entries({ ...trace.counters, ...trace.milliseconds }).map(([key, value]) => `${key}:${value}`).join(',');
    reports.push({ name, phase, code, counts, elapsed: trace.elapsed(), networkFailure: trace.networkFailure, blockedKind: trace.blockedKind });
  }
  try {
    local = await fixture(trace);
    phase = 'launch';
    if (lane.webdriver && !driverPath) throw fail('BROWSER_QA_DRIVER_REQUIRED');
    browser = await childLauncher(executablePath, local.proxyUrl, lane.webdriver ? driverPath : null);
    run = lane.webdriver ? fixedWebdriverComparison({ owned: browser, binary: executablePath, local, trace, signal,
      direct: lane.direct, observe: observer(trace, local.url) }) : controller({ browser, local, lane, trace, signal });
    const phases = lane.webdriver ? ['pin', 'attest', 'navigate'] : ['pin', 'guard', 'attest', 'activate', 'navigate'];
    for (const key of phases) { phase = key; await run[key](); }
    if (lane.paired) {
      phase = 'complete';
      collect();
      trace.reset();
      name = 'webdriver-proxy-fixed-cdp';
      phase = 'compare-cdp';
      await run.compareCdpNavigation();
    }
    phase = 'complete';
  } catch (error) { code = /^BROWSER_[A-Z_]+$/u.test(error?.code) ? error.code : 'BROWSER_QA_FAILURE'; }
  finally {
    collect();
    try { await run?.close(); } catch { cleaned = false; }
    try { await browser?.close(); } catch { cleaned = false; }
    try { await local?.close(); } catch { cleaned = false; }
  }
  let passes = 0;
  for (const report of reports) {
    const okay = report.code === 'none' && cleaned;
    if (okay) passes++;
    console.log(`QA lane=${report.name} verdict=${okay ? 'pass' : 'fail'} phase=${report.phase} code=${report.code} cleanup=${Number(cleaned)} ` +
      `navigationMs=${report.elapsed} networkFailure=${report.networkFailure} blockedKind=${report.blockedKind} counts=${report.counts}`);
  }
  return { passes, ran: reports.length };
}

async function run() {
  if (process.argv.length !== 2) throw fail('BROWSER_QA_FIXED_FIXTURE');
  if (process.platform !== 'linux' || !process.getuid?.() || !process.geteuid?.()) throw fail('BROWSER_SANDBOX_REQUIRED');
  const binary = await browserExecutable();
  const driver = await webdriverExecutable().catch(() => null);
  // ChromeDriver performance logs do not expose an asynchronous Fetch pause/ack
  // channel. The pair compares navigation methods only; it is not a Fetch parity test.
  console.log('QA parity=fetch-not-attempted reason=no-driver-fetch-event-channel');
  let passed = 0, attempted = 0;
  const expected = 3;
  for (const lane of LANES) {
    const result = await runLane(binary, driver, lane);
    passed += result.passes;
    attempted += result.ran;
  }
  console.log(`QA summary pass=${passed} fail=${attempted - passed} blocked=${expected - attempted}`);
  if (passed !== expected) process.exitCode = 1;
}

run().catch((error) => {
  const code = /^BROWSER_[A-Z_]+$/u.test(error?.code) ? error.code : 'BROWSER_QA_FAILURE';
  console.error(`QA verdict=fail phase=preflight code=${code}`);
  process.exitCode = 1;
});
