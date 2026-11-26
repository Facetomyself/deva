import { STATUS_CODES } from 'node:http';
import { connectPipe } from './pipe.mjs';
import {
  BOOTSTRAP_URL, PAGE_POLICIES, VIEWPORT, fail, keyParams, publicPageInfo, readFrame, validateInput,
} from './policy.mjs';

const NAVIGATION_MS = 12_000;
const PAGE_TARGETS = [{ type: 'page', exclude: false }, { exclude: true }];
const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };
const SUBTARGETS = ['iframe', 'worker', 'shared_worker', 'service_worker', 'page']
  .map((type) => ({ type, exclude: false })).concat({ exclude: true });
const SHELL_REASONS = new Set(['BROWSER_CLOSED', 'BROWSER_DISCONNECTED']);
const cloneFrame = (frame) => ({ ...frame, bytes: Buffer.from(frame.bytes) });

// Internal controller, with the process/transport boundary explicit for deterministic tests.
// The exported production facade has only the fixed methods returned at the bottom.
export async function startChromiumSession({ writer, reader, policy, verifySandbox, shutdown, probeOnly = false,
  commandMs, navigationMs = NAVIGATION_MS, signal, abortCode = () => 'BROWSER_ABORTED' }) {
  let contextId, targetId, sessionId, frameId;
  let opening = false;
  const attached = new Map();
  let fatalCode = null, closing = null, busy = false, stopping = null, notice = null;
  let privateInput = false, frameEpoch = 0, stopEpoch = 0, navigationEpoch = 0;
  let latest = null, location = null;
  const loaded = new Set();
  const changed = new Set();

  const notify = () => { for (const fn of changed) fn(); };
  const invalidate = () => { latest = null; frameEpoch++; };
  function restrict(code) { notice ??= code; invalidate(); notify(); }
  function checkNotice() {
    if (notice) {
      const code = notice;
      notice = null;
      throw fail(code);
    }
  }
  function checkLive() { if (fatalCode || closing) throw fail(fatalCode ?? 'BROWSER_CLOSED'); }
  function fatal(code) {
    if (fatalCode || closing) return;
    fatalCode = code;
    close();
  }
  const pipe = connectPipe(writer, reader, { onEvent, onFailure: fatal, commandMs });
  const root = (method, args) => pipe.send(method, args);
  const page = (method, args) => pipe.send(method, args, sessionId);

  function close() {
    if (closing) return closing;
    invalidate();
    // Assign before running Browser.close: recursive EOF/error notification is expected.
    closing = Promise.resolve().then(async () => {
      let timer;
      try {
        if (!fatalCode) {
          await Promise.race([root('Browser.close').catch(() => {}), new Promise((resolve) => {
            timer = setTimeout(resolve, 700);
          })]);
        }
      } finally {
        clearTimeout(timer);
        pipe.stop(fatalCode ?? 'BROWSER_CLOSED');
        await shutdown();
      }
    });
    // Async safety shutdown can originate in a protocol event with no API caller.
    closing.catch(() => {});
    notify();
    return closing;
  }

  function awaitState(test) {
    return new Promise((resolve, reject) => {
      const finish = (callback, value) => { clearTimeout(timer); changed.delete(check); callback(value); };
      const check = () => {
        try {
          checkLive();
          const result = test();
          if (result) finish(resolve, result);
        } catch (error) { finish(reject, error); }
      };
      const timer = setTimeout(() => {
        finish(reject, fail('BROWSER_TIMEOUT'));
        fatal('BROWSER_TIMEOUT');
      }, navigationMs);
      changed.add(check);
      check();
    });
  }

  function sendEventCommand(method, args, id = sessionId) {
    if (closing) return;
    pipe.send(method, args, id).catch((error) => fatal(error.code));
  }

  function dismissTarget(id) {
    restrict('BROWSER_POPUP_UNSUPPORTED');
    sendEventCommand('Target.closeTarget', { targetId: id }, null);
  }

  function trackNavigation(url, loaderId = null) {
    if (!policy.permits(url)) {
      if (!location && url === BOOTSTRAP_URL) return;
      return fatal('BROWSER_NAVIGATION_BLOCKED');
    }
    location = { url, loaderId };
    navigationEpoch++;
    invalidate();
    notify();
  }

  function rejectDocument(requestId, code) {
    sendEventCommand('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
    restrict(code);
  }

  function onDocument(p) {
    const { requestId, request, frameId: requestFrame, responseStatusCode: code, responseHeaders: headers = [] } = p;
    if (typeof requestId !== 'string' || p.resourceType !== 'Document') return fatal('BROWSER_PROTOCOL_INVALID');
    if (requestFrame !== frameId || !policy.permits(request?.url)) return rejectDocument(requestId, 'BROWSER_NAVIGATION_BLOCKED');
    if (p.responseErrorReason) return sendEventCommand('Fetch.continueResponse', { requestId });
    if (code === undefined) return sendEventCommand('Fetch.continueRequest', { requestId, interceptResponse: true });
    if (!Array.isArray(headers) || !Number.isInteger(code)) return fatal('BROWSER_PROTOCOL_INVALID');
    const header = (name) => headers.find((item) => item.name.toLowerCase() === name)?.value;
    if (code >= 300 && code < 400 && header('location')) {
      let destination;
      try { destination = new URL(header('location'), request.url).href; } catch { /* reject below */ }
      if (!policy.permits(destination)) return rejectDocument(requestId, 'BROWSER_NAVIGATION_BLOCKED');
      return sendEventCommand('Fetch.continueResponse', { requestId });
    }
    if (/^\s*attachment\b/iu.test(header('content-disposition') ?? '')) {
      return rejectDocument(requestId, 'BROWSER_DOWNLOAD_UNSUPPORTED');
    }
    if (code === 204 || code === 205) return sendEventCommand('Fetch.continueResponse', { requestId });
    if (!/^\s*(?:text\/html|application\/xhtml\+xml)(?:\s*;|\s*$)/iu.test(header('content-type') ?? '')) {
      return rejectDocument(requestId, 'BROWSER_DOCUMENT_UNSUPPORTED');
    }
    // Stream the original body. Only the headers are changed; no site bodies are read.
    sendEventCommand('Fetch.continueResponse', { requestId, responseCode: code,
      responsePhrase: p.responseStatusText || STATUS_CODES[code] || 'Response', responseHeaders: [...headers, ...PAGE_POLICIES] });
  }

  function onEvent(method, p, id) {
    if (closing) return;
    if (method === 'Target.attachedToTarget') {
      const target = p.targetInfo;
      if (!target || typeof target.targetId !== 'string' || typeof p.sessionId !== 'string') return fatal('BROWSER_PROTOCOL_INVALID');
      if (id === null && opening && target.type === 'page' && target.browserContextId === contextId) {
        if (attached.size) return fatal('BROWSER_TARGET_LOST');
        attached.set(target.targetId, p.sessionId);
        notify();
      } else if (target.targetId !== targetId) dismissTarget(target.targetId);
      return;
    }
    if (method === 'Target.detachedFromTarget' && p.sessionId === sessionId) return fatal('BROWSER_TARGET_LOST');
    if (method === 'Browser.downloadWillBegin') return restrict('BROWSER_DOWNLOAD_UNSUPPORTED');
    if (!sessionId || id !== sessionId) return;
    switch (method) {
      case 'Page.frameNavigated':
        if (!p.frame?.parentId && p.frame?.id === frameId) {
          const { url, urlFragment, loaderId } = p.frame;
          trackNavigation(urlFragment && !url.includes('#') ? `${url}${urlFragment}` : url, loaderId);
        } else if (p.frame && !p.frame.parentId && frameId) fatal('BROWSER_TARGET_LOST');
        break;
      case 'Page.navigatedWithinDocument':
        if (p.frameId === frameId) trackNavigation(p.url, location?.loaderId);
        break;
      case 'Page.lifecycleEvent':
        if (p.frameId === frameId && p.name === 'load') {
          loaded.add(p.loaderId);
          if (loaded.size > 16) loaded.delete(loaded.values().next().value);
          notify();
        }
        break;
      case 'Fetch.requestPaused': onDocument(p); break;
      case 'Fetch.authRequired':
        sendEventCommand('Fetch.continueWithAuth', { requestId: p.requestId, authChallengeResponse: { response: 'CancelAuth' } });
        restrict('BROWSER_HTTP_AUTH_UNSUPPORTED');
        break;
      case 'Page.windowOpen': restrict('BROWSER_POPUP_UNSUPPORTED'); break;
      case 'Page.downloadWillBegin': restrict('BROWSER_DOWNLOAD_UNSUPPORTED'); break;
      case 'Page.fileChooserOpened': restrict('BROWSER_FILE_CHOOSER_UNSUPPORTED'); break;
      case 'Page.javascriptDialogOpening':
        sendEventCommand('Page.handleJavaScriptDialog', { accept: false });
        restrict('BROWSER_DIALOG_UNSUPPORTED');
        break;
      case 'Inspector.targetCrashed': fatal('BROWSER_TARGET_LOST'); break;
      default: break;
    }
  }

  async function run(operation) {
    checkLive();
    if (busy || stopping) throw fail('BROWSER_BUSY');
    checkNotice();
    busy = true;
    try {
      const result = await operation();
      checkLive();
      checkNotice();
      return result;
    } catch (error) {
      checkNotice();
      throw error;
    } finally { busy = false; }
  }

  function waitNavigation(last, stopped, loader = null) {
    return awaitState(() => {
      if (stopEpoch !== stopped) throw fail('BROWSER_NAVIGATION_STOPPED');
      checkNotice();
      return navigationEpoch > last && (!loader || location?.loaderId === loader) &&
        (!location?.loaderId || loaded.has(location.loaderId));
    });
  }

  async function navigate(url) {
    return run(async () => {
      const destination = policy.entry(url);
      const last = navigationEpoch, stopped = stopEpoch;
      invalidate();
      const result = await page('Page.navigate', { url: destination });
      if (stopEpoch !== stopped) throw fail('BROWSER_NAVIGATION_STOPPED');
      if (result.isDownload) throw fail('BROWSER_DOWNLOAD_UNSUPPORTED');
      if (result.errorText || result.frameId !== frameId) throw fail('BROWSER_NAVIGATION_FAILED');
      if (result.loaderId || navigationEpoch > last || !location) await waitNavigation(last, stopped, result.loaderId);
    });
  }

  function history(direction) {
    return run(async () => {
      const { currentIndex, entries } = await page('Page.getNavigationHistory');
      const entry = entries?.[currentIndex + direction];
      if (!entry || !Number.isInteger(entry.id) || !policy.permits(entry.url)) throw fail('BROWSER_HISTORY_UNAVAILABLE');
      const last = navigationEpoch, stopped = stopEpoch;
      invalidate();
      await page('Page.navigateToHistoryEntry', { entryId: entry.id });
      await waitNavigation(last, stopped);
    });
  }

  async function getPageInfo() {
    return run(async () => {
      if (privateInput) return { origin: location ? policy.origin : null, title: '' };
      const { targetInfo } = await root('Target.getTargetInfo', { targetId });
      if (targetInfo?.targetId !== targetId || targetInfo?.browserContextId !== contextId) {
        fatal('BROWSER_TARGET_LOST');
        throw fail('BROWSER_TARGET_LOST');
      }
      if (!policy.permits(targetInfo.url)) return { origin: null, title: '' };
      // The last frame event and Target.getTargetInfo may briefly disagree during navigation.
      if (targetInfo.url.split('#', 1)[0] !== location?.url.split('#', 1)[0]) {
        return { origin: policy.origin, title: '' };
      }
      return publicPageInfo(targetInfo.url.includes('#') ? targetInfo.url : location.url, targetInfo.title, privateInput);
    });
  }

  async function screenshot() {
    const { data } = await page('Page.captureScreenshot', { format: 'png', fromSurface: true,
      captureBeyondViewport: false, clip: { x: 0, y: 0, ...VIEWPORT, scale: 1 } });
    return readFrame(data);
  }

  function captureFrame({ privateView = false } = {}) {
    return run(async () => {
      if (privateInput && privateView !== true) throw fail('BROWSER_PRIVACY_ACTIVE');
      if (!location) throw fail('BROWSER_NAVIGATION_FAILED');
      const epoch = frameEpoch;
      const frame = await screenshot();
      if (epoch !== frameEpoch) throw fail('BROWSER_FRAME_STALE');
      if (privateView !== true && !privateInput && !notice && !closing) latest = frame;
      return cloneFrame(frame);
    });
  }

  const mouse = (type, params) => page('Input.dispatchMouseEvent', { type, modifiers: 0, ...params });
  function dispatchInput(value) {
    return run(async () => {
      const { type, x, y, deltaX, deltaY, text, key } = validateInput(value);
      invalidate();
      if (type === 'text') return void await page('Input.insertText', { text });
      if (type === 'key') {
        const keyDown = keyParams(key);
        const { text: _text, unmodifiedText: _unmodified, ...keyUp } = keyDown;
        await page('Input.dispatchKeyEvent', { type: key === 'Enter' ? 'keyDown' : 'rawKeyDown', ...keyDown });
        return void await page('Input.dispatchKeyEvent', { type: 'keyUp', ...keyUp });
      }
      if (type === 'scroll') return void await mouse('mouseWheel', { x, y, deltaX, deltaY, button: 'none', buttons: 0 });
      await mouse('mousePressed', { x, y, button: 'left', buttons: 1, clickCount: 1 });
      await mouse('mouseReleased', { x, y, button: 'left', buttons: 0, clickCount: 1 });
    });
  }

  function setInputPrivacy(active) {
    checkLive();
    if (typeof active !== 'boolean') throw fail('BROWSER_INPUT_INVALID');
    if (active !== privateInput) {
      privateInput = active;
      invalidate();
    }
  }

  async function stop() {
    checkLive();
    if (stopping) return stopping;
    invalidate();
    stopEpoch++;
    notify();
    stopping = page('Page.stopLoading');
    try { await stopping; } finally { stopping = null; }
  }

  async function setup() {
    const version = await root('Browser.getVersion');
    if (!/^(?:Chromium|Chrome|HeadlessChrome)\/[\d.]+$/u.test(version.product ?? '')) throw fail('BROWSER_START_FAILED');
    const context = await root('Target.createBrowserContext', { disposeOnDetach: true });
    if (typeof context.browserContextId !== 'string') throw fail('BROWSER_START_FAILED');
    contextId = context.browserContextId;
    await root('Browser.setDownloadBehavior', { behavior: 'deny', browserContextId: contextId, eventsEnabled: true });
    await root('Target.setAutoAttach', { ...AUTO_ATTACH, filter: PAGE_TARGETS });
    opening = true;
    const created = await root('Target.createTarget', { url: BOOTSTRAP_URL, browserContextId: contextId });
    if (typeof created.targetId !== 'string') throw fail('BROWSER_START_FAILED');
    targetId = created.targetId;
    sessionId = await awaitState(() => attached.get(targetId));
    attached.clear();
    opening = false;
    await page('Target.setAutoAttach', { ...AUTO_ATTACH, filter: SUBTARGETS });
    await page('Page.enable');
    await page('Page.setLifecycleEventsEnabled', { enabled: true });
    await page('Page.setInterceptFileChooserDialog', { enabled: true });
    await page('Network.setCacheDisabled', { cacheDisabled: true });
    await page('Network.setBypassServiceWorker', { bypass: true });
    await page('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, screenWidth: VIEWPORT.width,
      screenHeight: VIEWPORT.height, deviceScaleFactor: 1, mobile: false });
    const { frameTree } = await page('Page.getFrameTree');
    if (frameTree?.frame?.url !== BOOTSTRAP_URL || typeof frameTree.frame.id !== 'string') throw fail('BROWSER_START_FAILED');
    frameId = frameTree.frame.id;
    await page('Fetch.enable', { handleAuthRequests: true, patterns: [
      { urlPattern: '*', resourceType: 'Document', requestStage: 'Request' },
    ] });
    await page('Runtime.runIfWaitingForDebugger');
    // On a cold launch Chromium can defer creating a renderer until it paints.
    // The internal blank page paints first; no registered site is opened until attested.
    await screenshot();
    await verifySandbox();
    if (!probeOnly) await navigate(policy.startUrl);
  }

  const abort = () => fatal(abortCode());
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) abort();
    checkLive();
    await setup();
    checkLive();
  } catch (error) {
    await close();
    const code = signal?.aborted ? abortCode() : error?.code;
    if (!SHELL_REASONS.has(code) && code !== 'BROWSER_COMMAND_FAILED' && code?.startsWith('BROWSER_')) throw fail(code);
    throw fail('BROWSER_START_FAILED');
  } finally { signal?.removeEventListener('abort', abort); }

  return Object.freeze({
    navigate, back: () => history(-1), forward: () => history(1), stop, close, getPageInfo, captureFrame,
    getLatestFrame: () => latest && !privateInput && !notice && !closing ? cloneFrame(latest) : null,
    dispatchInput, setInputPrivacy,
  });
}
