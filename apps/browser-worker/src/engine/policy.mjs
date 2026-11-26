import { isAbsolute } from 'node:path';

const DIAGNOSTIC_STAGES = new Set([
  'version', 'discover-bootstrap', 'context', 'download-guard', 'root-auto-attach', 'create-target', 'wait-target',
  'resume-bootstrap', 'close-startup-blank', 'page-controls', 'bootstrap-png', 'sandbox-attest', 'entry-navigation',
]);
const DIAGNOSTIC_COMMANDS = new Set([
  'Browser.getVersion', 'Browser.setDownloadBehavior', 'Browser.close', 'Target.createBrowserContext',
  'Target.createTarget', 'Target.setAutoAttach', 'Target.getTargetInfo', 'Target.getTargets', 'Target.closeTarget',
  'Runtime.runIfWaitingForDebugger', 'Page.enable', 'Page.setLifecycleEventsEnabled', 'Page.setInterceptFileChooserDialog',
  'Network.setCacheDisabled', 'Network.setBypassServiceWorker', 'Emulation.setDeviceMetricsOverride', 'Page.getFrameTree',
  'Fetch.enable', 'Fetch.continueRequest', 'Fetch.continueResponse', 'Fetch.failRequest', 'Fetch.continueWithAuth',
  'SystemInfo.getProcessInfo',
  'Page.captureScreenshot', 'Page.navigate', 'Page.getNavigationHistory', 'Page.navigateToHistoryEntry', 'Page.stopLoading',
  'Page.handleJavaScriptDialog', 'Input.insertText', 'Input.dispatchKeyEvent', 'Input.dispatchMouseEvent',
]);

const LAUNCH_HINTS = new Set(['silent', 'unclassified', 'missing-library', 'sandbox-denied', 'debug-pipe',
  'profile-lock', 'snap-wrapper', 'startup-fatal']);
const SANDBOX_FIELDS = [
  'childIdentity', 'inventory', 'inventoryConsistent', 'browserListed', 'browserOwned', 'browserStatus', 'browserUidReadable', 'browserUid', 'browserIdentity',
  'renderersListed', 'renderersOwned', 'renderersAttested', 'rendererStatus', 'rendererStable', 'rendererIdentity',
  'rendererCmdlineReadable', 'rendererArgvMatch', 'rendererArgvContradiction', 'rendererUidReadable', 'rendererUid',
  'pidNamespaceReadable', 'pidNamespace', 'userNamespaceReadable', 'userNamespace', 'nnpReadable', 'nnp',
  'seccompReadable', 'seccomp', 'filterCountReadable', 'filterDelta',
];

export const ENTRY_EVENTS = Object.freeze([
  'navigateSent', 'navigateAck', 'requestPaused', 'responsePaused', 'responseError', 'otherSessionFetch', 'blockedDocument',
  'continueRequestSent', 'continueRequestAck', 'continueResponseSent', 'continueResponseAck', 'fetchCommandError',
  'targetAttach', 'targetDetach', 'frameNavigated', 'mainFrameNavigated', 'withinDocument', 'mainFrameLoad',
]);

export class EngineError extends Error {
  constructor(code, { stage, command, launchHint, sandbox, entryNavigation } = {}) {
    super(code);
    this.name = 'EngineError';
    this.code = code;
    const safe = {};
    if (DIAGNOSTIC_STAGES.has(stage)) safe.stage = stage;
    if (DIAGNOSTIC_COMMANDS.has(command)) safe.command = command;
    if (LAUNCH_HINTS.has(launchHint)) safe.launchHint = launchHint;
    if (sandbox && typeof sandbox === 'object') {
      const fields = {};
      for (const name of SANDBOX_FIELDS) {
        const value = sandbox[name];
        if (name.startsWith('renderers') ? Number.isInteger(value) && value >= 0 && value <= 256 : typeof value === 'boolean') {
          fields[name] = value;
        }
      }
      if (Object.keys(fields).length) safe.sandbox = Object.freeze(fields);
    }
    if (entryNavigation && typeof entryNavigation === 'object') {
      const counts = {};
      for (const name of ENTRY_EVENTS) {
        const value = entryNavigation[name];
        if (Number.isInteger(value) && value >= 0 && value <= 256) counts[name] = value;
      }
      if (Object.keys(counts).length) safe.entryNavigation = Object.freeze(counts);
    }
    if (Object.keys(safe).length) this.diagnostic = Object.freeze(safe);
  }
}

export const fail = (code, diagnostic) => new EngineError(code, diagnostic);
export const VIEWPORT = Object.freeze({ width: 1024, height: 768 });
export const FRAME_LIMIT = 4 * 1024 * 1024;
export const BOOTSTRAP_URL = 'about:blank';

// This header is additive: the origin's own CSP remains independently enforced.
// Top-level same-origin sites retain normal forms and scripts, but the supervised
// surface has no children, workers, pop-ups, downloads, external protocols or pickers.
export const PAGE_POLICIES = Object.freeze([
  Object.freeze({ name: 'Content-Security-Policy', value: [
    'sandbox allow-scripts allow-same-origin allow-forms', "default-src 'self'", "connect-src 'self'",
    "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
    "font-src 'self' data:", "media-src 'self' blob:", "frame-src 'none'", "child-src 'none'",
    "worker-src 'none'", "object-src 'none'", "form-action 'self'", "base-uri 'self'",
  ].join('; ') }),
  Object.freeze({ name: 'Permissions-Policy',
    value: 'clipboard-read=(), clipboard-write=(), camera=(), microphone=(), display-capture=(), geolocation=(), usb=(), serial=(), hid=()' }),
]);

function httpUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x20\x7f]/u.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
  return url;
}

const withoutFragment = (url) => url.href.split('#', 1)[0];

export function configPolicy({ executablePath, proxyUrl, startUrl, allowedUrls } = {}) {
  if (typeof executablePath !== 'string' || !isAbsolute(executablePath) || executablePath.includes('\0')) {
    throw fail('BROWSER_EXECUTABLE_REQUIRED');
  }
  const proxy = httpUrl(proxyUrl);
  if (!proxy || proxy.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(proxy.hostname)
      || !/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}\/?$/u.test(proxyUrl)) {
    throw fail('BROWSER_PROXY_REQUIRED');
  }
  const start = httpUrl(startUrl);
  if (!start || (allowedUrls !== undefined && (!Array.isArray(allowedUrls) || allowedUrls.length > 64))) {
    throw fail('BROWSER_CONFIGURATION_INVALID');
  }
  const entries = new Set();
  for (const entry of allowedUrls ?? [startUrl]) {
    const url = httpUrl(entry);
    if (!url || url.origin !== start.origin) throw fail('BROWSER_CONFIGURATION_INVALID');
    entries.add(withoutFragment(url));
  }
  if (!entries.has(withoutFragment(start))) throw fail('BROWSER_CONFIGURATION_INVALID');
  return Object.freeze({ executablePath, proxyUrl: proxyUrl.replace(/\/$/u, ''), startUrl: start.href,
    origin: start.origin,
    entry(value) {
      const url = httpUrl(value);
      if (!url || !entries.has(withoutFragment(url))) throw fail('BROWSER_NAVIGATION_BLOCKED');
      return url.href;
    },
    permits(value) { return httpUrl(value)?.origin === start.origin; },
  });
}

export function publicPageInfo(url, title, secret = false) {
  const location = httpUrl(url);
  if (!location) return { origin: null, title: '' };
  if (secret || typeof title !== 'string') return { origin: location.origin, title: '' };
  let result = title
    .replace(/[a-z][a-z\d+.-]*:\/\/[^\s<>]+/giu, '[URL]')
    .split(/[?#]/u, 1)[0]
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  // A site can insert a query value or fragment verbatim into document.title.
  const fragments = [location.search.slice(1), location.hash.slice(1),
    ...location.searchParams.keys(), ...location.searchParams.values()];
  for (const value of fragments) {
    if (!value) continue;
    let decoded = value;
    try { decoded = decodeURIComponent(value); } catch { /* retain literal */ }
    for (const candidate of new Set([value, decoded, encodeURIComponent(decoded)])) {
      if (candidate && result.toLowerCase().includes(candidate.toLowerCase())) result = '';
    }
  }
  return { origin: location.origin, title: Array.from(result).slice(0, 100).join('') };
}

const SAFE_KEYS = new Map([
  ['Backspace', 8], ['Tab', 9], ['Enter', 13], ['Escape', 27], ['End', 35], ['Home', 36],
  ['ArrowLeft', 37], ['ArrowUp', 38], ['ArrowRight', 39], ['ArrowDown', 40], ['Delete', 46],
]);

const inRange = (n, from, to) => Number.isFinite(n) && n >= from && n <= to;

export function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('BROWSER_INPUT_INVALID');
  const { type, x, y, deltaX, deltaY, key, text } = input;
  let expected;
  switch (type) {
    case 'click':
      expected = ['type', 'x', 'y'];
      break;
    case 'scroll':
      expected = ['type', 'x', 'y', 'deltaX', 'deltaY'];
      if (!inRange(deltaX, -2048, 2048) || !inRange(deltaY, -2048, 2048)) throw fail('BROWSER_INPUT_INVALID');
      break;
    case 'text':
      expected = ['type', 'text'];
      if (typeof text !== 'string' || text.length < 1 || text.length > 1024 || /[\p{Cc}\p{Cs}]/u.test(text)) {
        throw fail('BROWSER_INPUT_INVALID');
      }
      break;
    case 'key':
      expected = ['type', 'key'];
      if (!SAFE_KEYS.has(key)) throw fail('BROWSER_INPUT_INVALID');
      break;
    default: throw fail('BROWSER_INPUT_INVALID');
  }
  const supplied = Reflect.ownKeys(input);
  if (supplied.length !== expected.length || !expected.every((field) => Object.hasOwn(input, field))) {
    throw fail('BROWSER_INPUT_INVALID');
  }
  if ((type === 'click' || type === 'scroll') &&
      (!inRange(x, 0, VIEWPORT.width - 1) || !inRange(y, 0, VIEWPORT.height - 1))) {
    throw fail('BROWSER_INPUT_INVALID');
  }
  return Object.fromEntries(expected.map((field) => [field, input[field]]));
}

export function keyParams(key) {
  return { key, code: key, windowsVirtualKeyCode: SAFE_KEYS.get(key), modifiers: 0,
    ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) };
}

const PNG_MAGIC = '89504e470d0a1a0a';

export function readFrame(data) {
  if (typeof data !== 'string' || data.length > Math.ceil(FRAME_LIMIT / 3) * 4 ||
      data.length % 4 || !/^[a-z\d+/]+={0,2}$/iu.test(data)) throw fail('BROWSER_FRAME_INVALID');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length < 45 || bytes.length > FRAME_LIMIT || bytes.toString('hex', 0, 8) !== PNG_MAGIC ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR' ||
      bytes.readUInt32BE(16) !== VIEWPORT.width || bytes.readUInt32BE(20) !== VIEWPORT.height ||
      bytes.toString('hex', bytes.length - 12) !== '0000000049454e44ae426082') {
    throw fail('BROWSER_FRAME_INVALID');
  }
  return { mimeType: 'image/png', ...VIEWPORT, bytes };
}
