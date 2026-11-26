import { randomBytes } from 'node:crypto';
import { constants, lstatSync, realpathSync } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { FRAME_LIMIT, VIEWPORT } from './engine/policy.mjs';
import { parseSites } from './egress/sites.mjs';
import { controlFault, startWorkerControl, WorkerControlError } from './worker-control.mjs';

const EGRESS_MS = 2_500;
const CLEANUP_MS = 5_000;
const RETRY_MS = 2_000;
const newId = () => randomBytes(18).toString('base64url');
const now = () => performance.now();
const startupStates = new Set(['ready', 'binary-missing', 'sandbox-startup-failure']);
const missingCodes = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'BROWSER_EXECUTABLE_REQUIRED']);
const transientActions = new Set([
  'BROWSER_BUSY', 'BROWSER_FRAME_STALE', 'BROWSER_POPUP_UNSUPPORTED', 'BROWSER_DOWNLOAD_UNSUPPORTED',
  'BROWSER_DIALOG_UNSUPPORTED', 'BROWSER_HTTP_AUTH_UNSUPPORTED', 'BROWSER_FILE_CHOOSER_UNSUPPORTED',
]);

function boundedInt(value, fallback, min, max) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw controlFault();
  return result;
}

function absolutePath(value, max = 4096) {
  return typeof value === 'string' && isAbsolute(value) && !value.includes('\0') && Buffer.byteLength(value) <= max;
}

function brokerIdentity(path) {
  try {
    const parent = lstatSync(dirname(path), { bigint: true });
    const info = lstatSync(path, { bigint: true });
    if (parent.isDirectory() && (parent.mode & 0o7777n) === 0o700n && realpathSync(dirname(path)) === dirname(path) &&
        info.isSocket() && info.uid === parent.uid && (info.mode & 0o7777n) === 0o600n) return info;
  } catch { /* an absent, inaccessible or changed broker is unavailable */ }
  return null;
}

const sameInode = (a, b) => Boolean(a && b && a.dev === b.dev && a.ino === b.ino &&
  (a.birthtimeNs || a.ctimeNs) === (b.birthtimeNs || b.ctimeNs));

function loopbackUrl(value) {
  if (typeof value !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/?$/u.test(value)) return false;
  try { return Boolean(new URL(value).port); } catch { return false; }
}

// The scoped abort signal is disconnected from its parents at completion. Finishing a
// successful Unix request therefore never aborts a browser that the worker now owns.
async function scoped(ms, parents, work) {
  const abort = new AbortController();
  const cancel = () => abort.abort(controlFault('WORKER_UNAVAILABLE'));
  const signals = parents.filter(Boolean);
  for (const signal of signals) {
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
  }
  const timer = setTimeout(() => abort.abort(controlFault('TIMED_OUT')), ms);
  let onAbort;
  try {
    if (abort.signal.aborted) throw abort.signal.reason;
    const canceled = new Promise((_, reject) => {
      onAbort = () => reject(abort.signal.reason);
      abort.signal.addEventListener('abort', onAbort, { once: true });
    });
    const task = Promise.resolve().then(() => {
      abort.signal.throwIfAborted();
      return work(abort.signal);
    });
    return await Promise.race([task, canceled]);
  } finally {
    clearTimeout(timer);
    if (onAbort) abort.signal.removeEventListener('abort', onAbort);
    for (const signal of signals) signal.removeEventListener('abort', cancel);
  }
}

/**
 * Deploy this in the browser worker process, in its isolated network namespace. The
 * only TCP listener created for it is the ephemeral IPv4 loopback egress adapter;
 * workbench requests arrive through the fixed, private Unix control socket.
 * Factory/probe overrides are trusted in-process test hooks, never wire parameters.
 */
export async function startWorker({ runDir, egressSocket, sites, executablePath, engineFactory, engineProbe,
  proxyFactory, egressProbe, maxSessions, maxConcurrentOpens, tabTtlMs, controlTtlMs, startupTimeoutMs,
  operationTimeoutMs, egressCheckMs } = {}) {
  const maxTabs = boundedInt(maxSessions, 4, 1, 16);
  const maxOpening = boundedInt(maxConcurrentOpens, Math.min(2, maxTabs), 1, maxTabs);
  const tabTtl = boundedInt(tabTtlMs, 10 * 60_000, 10, 60 * 60_000);
  const controlTtl = boundedInt(controlTtlMs, 2 * 60_000, 10, 15 * 60_000);
  const startupMs = boundedInt(startupTimeoutMs, 25_000, 10, 30_000);
  const operationMs = boundedInt(operationTimeoutMs, 6_000, 10, 15_000);
  const brokerIntervalMs = boundedInt(egressCheckMs, 1_000, 10, 10_000);
  const configuredSites = sites == null ? [] : parseSites(sites);
  const publicSites = configuredSites.map(({ id, label, origin }) => ({ id, label, origin }));
  const siteById = new Map(configuredSites.map((site) => [site.id, site]));
  const brokerPath = absolutePath(egressSocket, 107) && resolve(egressSocket) === egressSocket ? egressSocket : null;
  const configured = Boolean(brokerPath && configuredSites.length);
  const tabs = new Map();
  const resources = new Set(); // Holds a permit until each process has actually finished closing.
  const pending = new Set();
  const shutdown = new AbortController();
  let broker, proxyWork, readiness, checking, startupProbe, timer, transport, closing;
  let opening = 0;
  let state = configured ? 'egress-unavailable' : 'unconfigured';

  function track(promise) {
    pending.add(promise);
    void promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return promise;
  }

  function closeResource(resource) {
    return resource.closing ??= track(Promise.resolve().then(async () => {
      try { await resource.engine.close(); }
      catch { throw controlFault('ENGINE_FAILURE'); }
      resources.delete(resource); // On cleanup failure, fail closed by retaining the permit.
    }));
  }

  function retire(tab) {
    if (!tab.abort.signal.aborted) {
      if (tabs.get(tab.sid) === tab) tabs.delete(tab.sid);
      tab.lease = null;
      tab.epoch++;
      tab.abort.abort();
    }
    // Startup can settle concurrently with revocation; always close a late resource.
    return tab.resource ? closeResource(tab.resource) : Promise.resolve();
  }

  function dropBroker(candidate) {
    if (!candidate || broker !== candidate) return;
    broker = undefined;
    state = 'egress-unavailable';
    for (const tab of tabs.values()) if (tab.broker === candidate) void retire(tab);
    proxyWork ??= track(Promise.resolve().then(() => candidate.proxy.close()));
    void proxyWork.then(() => { proxyWork = undefined; }, () => {});
  }

  function currentBroker(candidate) {
    if (!candidate || broker !== candidate || !sameInode(brokerIdentity(brokerPath), candidate.inode)) {
      dropBroker(candidate);
      return false;
    }
    return true;
  }

  async function checkEgress(inode) {
    if (!inode || shutdown.signal.aborted) return false;
    if (checking && sameInode(checking.inode, inode)) return checking.task;
    if (checking) return false;
    const task = scoped(EGRESS_MS, [shutdown.signal], (signal) => {
      const job = track(Promise.resolve().then(async () => {
        const probe = egressProbe ?? (await import('./egress/index.mjs')).probeEgress;
        signal.throwIfAborted();
        return await probe(brokerPath, { signal }) === true && !signal.aborted && sameInode(brokerIdentity(brokerPath), inode);
      }));
      void job.then(() => { checking = undefined; }, () => { checking = undefined; });
      return job;
    }).catch(() => false);
    checking = { inode, task };
    return task;
  }

  async function ensureBroker() {
    if (currentBroker(broker)) {
      const candidate = broker;
      if (await checkEgress(candidate.inode) && currentBroker(candidate)) return candidate;
      dropBroker(candidate);
    }
    if (proxyWork) return null;
    const inode = brokerIdentity(brokerPath);
    if (!await checkEgress(inode) || shutdown.signal.aborted) return null;
    let proxy;
    try {
      // Retain the work until startup really settles; a late proxy is closed and never published.
      proxy = await scoped(EGRESS_MS, [shutdown.signal], (signal) => {
        const job = track(Promise.resolve().then(async () => {
          const factory = proxyFactory ?? (await import('./egress/index.mjs')).startLocalProxy;
          signal.throwIfAborted();
          const local = await factory({ socketPath: brokerPath, host: '127.0.0.1', port: 0 });
          if (!signal.aborted && sameInode(brokerIdentity(brokerPath), inode) && loopbackUrl(local?.url) &&
              typeof local?.close === 'function') return local;
          if (typeof local?.close === 'function') await local.close();
          throw controlFault('WORKER_UNAVAILABLE');
        }));
        proxyWork = job;
        void job.then(() => { if (proxyWork === job) proxyWork = undefined; }, () => {
          if (proxyWork === job) proxyWork = undefined;
        });
        return job;
      });
      if (shutdown.signal.aborted || !sameInode(brokerIdentity(brokerPath), inode)) {
        proxyWork = track(Promise.resolve().then(() => proxy.close()));
        void proxyWork.then(() => { proxyWork = undefined; }, () => {});
        return null;
      }
      broker = { inode, proxy, startupState: null, retryAt: 0 };
      return broker;
    } catch { return null; }
  }

  async function probeBrowser(candidate) {
    if (candidate.startupState === 'ready' || now() < candidate.retryAt) return candidate.startupState;
    if (!absolutePath(executablePath)) return 'binary-missing';
    let result;
    try {
      if (!engineFactory && !engineProbe) {
        await access(executablePath, constants.X_OK);
        if (!(await stat(executablePath)).isFile()) return 'binary-missing';
      }
      result = await scoped(startupMs, [shutdown.signal], (signal) => {
        if (startupProbe) throw controlFault('BUSY');
        const job = track(Promise.resolve().then(async () => {
          const probe = engineProbe ?? (!engineFactory ? (await import('./engine/chromium.mjs')).probeChromium : null);
          if (!probe) throw controlFault('ENGINE_FAILURE');
          signal.throwIfAborted();
          return probe({ executablePath, proxyUrl: candidate.proxy.url, signal });
        }));
        startupProbe = job;
        void job.then(() => { startupProbe = null; }, () => { startupProbe = null; });
        return job;
      });
      result = result?.available === true ? 'ready' : 'sandbox-startup-failure';
    } catch (error) {
      result = missingCodes.has(error?.code) ? 'binary-missing' : 'sandbox-startup-failure';
    }
    candidate.retryAt = now() + RETRY_MS;
    candidate.startupState = result;
    return result;
  }

  function ensureReady() {
    if (!configured || shutdown.signal.aborted) return Promise.resolve(state);
    if (readiness) return readiness;
    const task = track(Promise.resolve().then(async () => {
      const candidate = await ensureBroker();
      if (!candidate) return state = 'egress-unavailable';
      const checked = await probeBrowser(candidate);
      if (!currentBroker(candidate)) return state = 'egress-unavailable';
      return state = startupStates.has(checked) ? checked : 'sandbox-startup-failure';
    }));
    readiness = task;
    void task.then(() => { readiness = undefined; }, () => { readiness = undefined; });
    return task;
  }

  async function acquire(tab, request) {
    if (resources.size >= maxTabs) throw controlFault('SESSION_LIMIT');
    const resource = {};
    resources.add(resource);
    let started = false;
    try {
      return await scoped(startupMs, [request, shutdown.signal, tab.abort.signal], (signal) => {
        started = true;
        return track(Promise.resolve().then(async () => {
          const factory = engineFactory ?? (await import('./engine/chromium.mjs')).createChromiumEngine;
          signal.throwIfAborted();
          const { site } = tab;
          resource.engine = await factory({ executablePath, startUrl: site.url, allowedUrls: [site.url],
            proxyUrl: tab.broker.proxy.url, signal });
          const methods = ['close', 'getPageInfo', 'captureFrame', 'dispatchInput', 'setInputPrivacy'];
          if (!methods.every((name) => typeof resource.engine?.[name] === 'function')) throw controlFault('ENGINE_FAILURE');
          signal.throwIfAborted();
          return resource;
        }).catch((error) => {
          if (typeof resource.engine?.close === 'function') void closeResource(resource);
          else resources.delete(resource);
          throw error;
        }));
      });
    } catch (error) {
      if (!started) resources.delete(resource);
      if (typeof resource.engine?.close === 'function') void closeResource(resource);
      throw error;
    }
  }

  async function verifyPage(tab) {
    const info = await tab.resource.engine.getPageInfo();
    if (info?.origin !== tab.site.origin) throw controlFault('ENGINE_FAILURE');
  }

  async function openTab({ sid, siteId }, request) {
    const site = siteById.get(siteId);
    if (!site) throw controlFault('UNKNOWN_SITE');
    const previous = tabs.get(sid);
    if (previous?.opening || opening >= maxOpening) throw controlFault('BUSY');
    if (!previous && tabs.size >= maxTabs) throw controlFault('SESSION_LIMIT');
    const tab = { id: newId(), sid, site, opening: true, abort: new AbortController(), epoch: 0 };
    tabs.set(sid, tab); // Immediately invalidate the previous tab and its human control ID.
    opening++;
    const previousClosed = previous ? retire(previous) : null;
    try {
      return await scoped(startupMs + EGRESS_MS, [request, shutdown.signal, tab.abort.signal], async (signal) => {
        if (previousClosed) await scoped(CLEANUP_MS, [signal], () => previousClosed);
        if (await ensureReady() !== 'ready' || !currentBroker(broker)) throw controlFault('WORKER_UNAVAILABLE');
        signal.throwIfAborted();
        tab.broker = broker;
        tab.resource = await acquire(tab, signal);
        if (signal.aborted || tab.abort.signal.aborted) {
          void retire(tab); // Also owns resources that settled after outer cancellation.
          throw controlFault('WORKER_UNAVAILABLE');
        }
        await scoped(operationMs, [signal], () => verifyPage(tab));
        signal.throwIfAborted();
        if (tabs.get(sid) !== tab || !currentBroker(tab.broker)) throw controlFault('WORKER_UNAVAILABLE');
        tab.idleUntil = now() + tabTtl;
        tab.opening = false;
        return { tabId: tab.id, siteId };
      });
    } catch (error) {
      void retire(tab);
      if (error instanceof WorkerControlError) throw error;
      if (missingCodes.has(error?.code) || error?.code === 'BROWSER_SANDBOX_REQUIRED') {
        if (tab.broker && currentBroker(tab.broker)) {
          state = tab.broker.startupState = missingCodes.has(error.code) ? 'binary-missing' : 'sandbox-startup-failure';
          tab.broker.retryAt = now() + RETRY_MS;
        }
        throw controlFault('WORKER_UNAVAILABLE');
      }
      throw controlFault('ENGINE_FAILURE');
    } finally { opening--; }
  }

  function tabFor({ sid, tabId }) {
    const tab = tabs.get(sid);
    if (!tab || tab.opening || tab.id !== tabId) throw controlFault('TAB_NOT_FOUND');
    if (now() >= tab.idleUntil) {
      void retire(tab);
      throw controlFault('TAB_NOT_FOUND');
    }
    if (!currentBroker(tab.broker)) throw controlFault('WORKER_UNAVAILABLE');
    return tab;
  }

  function revoke(tab) {
    tab.lease = null;
    tab.epoch++;
    if (tab.revoking) return tab.revoking;
    if (!tab.privateInput) return Promise.resolve();
    const task = track(Promise.resolve().then(async () => {
      await tab.running?.catch(() => {});
      if (tab.abort.signal.aborted) return;
      try {
        await scoped(operationMs, [shutdown.signal, tab.abort.signal], () => tab.resource.engine.setInputPrivacy(false));
        tab.privateInput = false;
      } catch {
        if (tab.abort.signal.aborted || shutdown.signal.aborted) return;
        void retire(tab);
        throw controlFault('ENGINE_FAILURE');
      }
    }));
    tab.revoking = task;
    void task.then(() => { tab.revoking = null; }, () => { tab.revoking = null; });
    return task;
  }

  function liveLease(tab, controlId) {
    if (tab.lease && now() >= tab.lease.until) void revoke(tab);
    if (!tab.lease || tab.lease.id !== controlId) throw controlFault('CONTROL_REQUIRED');
    return tab.lease;
  }

  async function operate(tab, request, work) {
    if (tab.running || tab.revoking) throw controlFault('BUSY');
    const task = scoped(operationMs, [request, shutdown.signal, tab.abort.signal], work);
    tab.running = task;
    try { return await task; }
    catch (error) {
      if (error?.code !== 'CONTROL_REQUIRED' && !transientActions.has(error?.code)) void retire(tab);
      throw error instanceof WorkerControlError ? error : controlFault('ENGINE_FAILURE');
    } finally { tab.running = null; }
  }

  async function dispatch(op, args, request) {
    if (shutdown.signal.aborted || request.aborted) throw controlFault('WORKER_UNAVAILABLE');
    if (op === 'status') return { state: await ensureReady() };
    if (op === 'sites') return publicSites;
    if (op === 'open') return openTab(args, request);
    const tab = tabFor(args);
    if (op === 'closeTab') {
      const cleanup = retire(tab);
      await scoped(CLEANUP_MS, [request, shutdown.signal], () => cleanup);
      return { closed: true };
    }
    if (op === 'endPrivacy' || op === 'release') {
      if (op === 'endPrivacy') liveLease(tab, args.controlId);
      await revoke(tab);
      if (request.aborted || shutdown.signal.aborted) throw controlFault('WORKER_UNAVAILABLE');
      if (tabFor(args) !== tab) throw controlFault('TAB_NOT_FOUND');
      return { released: true };
    }
    if (op === 'startPrivacy') {
      if (tab.lease && now() >= tab.lease.until) void revoke(tab);
      if (tab.lease || tab.running || tab.revoking) throw controlFault('BUSY');
      const epoch = tab.epoch;
      tab.privateInput = true;
      await operate(tab, request, async (signal) => {
        await verifyPage(tab);
        signal.throwIfAborted();
        if (tab.epoch !== epoch || !currentBroker(tab.broker)) throw controlFault('CONTROL_REQUIRED');
        await tab.resource.engine.setInputPrivacy(true);
      });
      if (request.aborted || tab.epoch !== epoch || !currentBroker(tab.broker) || tabs.get(tab.sid) !== tab) {
        void revoke(tab);
        throw controlFault('CONTROL_REQUIRED');
      }
      tab.lease = { id: newId(), until: now() + controlTtl };
      tab.idleUntil = now() + tabTtl;
      return { controlId: tab.lease.id };
    }
    const lease = liveLease(tab, args.controlId);
    const result = await operate(tab, request, async (signal) => {
      await verifyPage(tab);
      signal.throwIfAborted();
      if (!currentBroker(tab.broker) || liveLease(tab, args.controlId) !== lease) throw controlFault('CONTROL_REQUIRED');
      if (op === 'input') {
        await tab.resource.engine.dispatchInput(args.action);
        return { accepted: true };
      }
      const captured = await tab.resource.engine.captureFrame({ privateView: true });
      if (captured?.mimeType !== 'image/png' || captured.width !== VIEWPORT.width || captured.height !== VIEWPORT.height ||
          !Buffer.isBuffer(captured.bytes) || captured.bytes.length < 45 || captured.bytes.length > FRAME_LIMIT) {
        throw controlFault('ENGINE_FAILURE');
      }
      return { image: captured.bytes.toString('base64') };
    });
    if (request.aborted || !currentBroker(tab.broker) || liveLease(tab, args.controlId) !== lease) {
      throw controlFault('CONTROL_REQUIRED');
    }
    tab.idleUntil = now() + tabTtl;
    return result;
  }

  function maintenance() {
    const time = now();
    for (const tab of tabs.values()) {
      if (!tab.opening && time >= tab.idleUntil) void retire(tab);
      else if (tab.lease && time >= tab.lease.until) void revoke(tab);
    }
    if (currentBroker(broker) && !checking) {
      const candidate = broker;
      void checkEgress(candidate.inode).then((ok) => { if (!ok) dropBroker(candidate); });
    }
  }

  transport = await startWorkerControl({ runDir, dispatch });
  timer = setInterval(maintenance, Math.min(brokerIntervalMs, controlTtl, tabTtl));
  timer.unref();
  return Object.freeze({
    path: transport.path,
    close() {
      return closing ??= Promise.resolve().then(async () => {
        clearInterval(timer);
        shutdown.abort();
        for (const tab of tabs.values()) void retire(tab);
        dropBroker(broker);
        const drained = scoped(CLEANUP_MS, [], async () => {
          while (pending.size) await Promise.allSettled([...pending]);
          if (resources.size || proxyWork) throw controlFault('ENGINE_FAILURE');
        });
        await Promise.all([transport.close(), drained]);
      });
    },
  });
}
