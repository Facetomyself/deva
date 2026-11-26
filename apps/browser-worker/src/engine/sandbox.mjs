import { readFile, readlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fail } from './policy.mjs';

const SANDBOX_MS = 2_500;
const MAX_PROCS = 256;
const MAX_ANCESTORS = 20;
const PROC = { readFile, readlink };
const isPid = (id) => Number.isInteger(id) && id > 1 && id <= 4_194_304;

function fields(status, key) {
  return status.split('\n').find((line) => line.startsWith(`${key}:`))?.split(/\s+/u).slice(1) ?? [];
}

function count(value) {
  return /^\d+$/u.test(value ?? '') ? Number(value) : undefined;
}

export async function procIdentity(pid, proc = PROC) {
  if (!isPid(pid)) return null;
  const stat = await proc.readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
  if (!stat || stat.lastIndexOf(')') === -1) return null;
  const row = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const start = row[19]; // Linux proc stat field 22; unchanged for a process's lifetime.
  if (!/^\d+$/u.test(start ?? '') || row[0] === 'Z' || row[0] === 'X') return null;
  return { pid, parent: count(row[1]), start };
}

async function procStatus(pid, proc) {
  const status = await proc.readFile(`/proc/${pid}/status`, 'utf8').catch(() => '');
  if (!status) return null;
  return {
    uid: fields(status, 'Uid').map(count), nsDepth: fields(status, 'NSpid').length,
    nnp: count(fields(status, 'NoNewPrivs')[0]), seccomp: count(fields(status, 'Seccomp')[0]),
    filters: count(fields(status, 'Seccomp_filters')[0]),
  };
}

async function procArgs(pid, proc) {
  return (await proc.readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')).split('\0').filter(Boolean);
}

const CHROME_PROGRAM = /^(?:chrome|chromium|chrome-headless-shell|headless_shell)$/u;
const TYPE_PREFIX = '--type=';
const isSpace = (ch) => ch === ' ' || ch === '\t';

function titleArguments(title) {
  const program = /^([^ \t'"\\]+)[ \t]+/u.exec(title);
  if (!program || !CHROME_PROGRAM.test(program[1].split('/').at(-1))) return [];
  const args = [];
  let start = program[0].length;
  while (start < title.length) {
    while (start < title.length && isSpace(title[start])) start++;
    if (start === title.length) break;
    let at = start, quote = '', literal = true;
    for (; at < title.length; at++) {
      const char = title[at];
      if (char === '\\' && quote !== "'") { literal = false; at++; continue; }
      if (quote) { if (char === quote) quote = ''; continue; }
      if (char === '"' || char === "'") { literal = false; quote = char; continue; }
      if (isSpace(char)) break;
    }
    args.push(literal ? title.slice(start, at) : null);
    start = at + 1;
  }
  return args;
}

/** Safe local role evidence; consumers without a private Browser report must require explicitRenderer. */
export function classifyRendererCmdline(raw) {
  const argv = Array.isArray(raw) ? raw.filter((arg) => typeof arg === 'string') :
    typeof raw === 'string' ? raw.split('\0').filter(Boolean) : [];
  const realArgs = argv.slice(1);
  const titleArgs = titleArguments(argv[0] ?? '');
  const knownTypes = [...realArgs, ...titleArgs].filter((arg) => arg?.startsWith(TYPE_PREFIX));
  const contradictory = knownTypes.some((arg) => arg !== '--type=renderer');
  // A merged title has lost real argument boundaries. Only trust the canonical first
  // switch after the known Chrome executable, never a type-like substring in an argument value.
  const explicitRenderer = !contradictory && (realArgs.includes('--type=renderer') || titleArgs[0] === '--type=renderer');
  return { readable: argv.length > 0, explicitRenderer, contradictory };
}

async function ancestry(pid, root, proc) {
  const visited = new Set();
  const found = [];
  for (let depth = 0; depth < MAX_ANCESTORS && isPid(pid) && !visited.has(pid); depth++) {
    visited.add(pid);
    const row = await procIdentity(pid, proc);
    if (!row) return null;
    found.push(row);
    if (pid === root.pid) return row.start === root.start ? found : null;
    pid = row.parent;
  }
  return null;
}

const uidMatches = (status, uid) => status?.uid.length === 4 && status.uid.every((id) => id === uid);

async function namespaceIdentity(pid, proc) {
  const [link, rawMap] = await Promise.all([
    proc.readlink(`/proc/${pid}/ns/user`).catch(() => ''),
    proc.readFile(`/proc/${pid}/uid_map`, 'utf8').catch(() => ''),
  ]);
  const map = rawMap.trim().split(/\s+/u);
  return {
    link: /^user:\[\d+\]$/u.test(link) ? link : null,
    map: map.length > 0 && map.length % 3 === 0 && map.every((part) => /^\d+$/u.test(part)) ? map.join(' ') : null,
  };
}

function differentUserNamespace(browser, renderer) {
  if (browser.link && renderer.link) return { readable: true, isolated: browser.link !== renderer.link };
  if (browser.map && renderer.map) return { readable: true, isolated: browser.map !== renderer.map };
  return { readable: false, isolated: false };
}

async function checkRenderer({ row, browserRoot, browser, browserNs, uid, proc, trustedBrowserInventory }) {
  const [status, argv, rendererNs] = await Promise.all([
    procStatus(row.pid, proc), procArgs(row.pid, proc), namespaceIdentity(row.pid, proc),
  ]);
  if (!status) return { rendererStatus: false, pass: false };
  const role = classifyRendererCmdline(argv);
  const after = await ancestry(row.pid, browserRoot, proc);
  const rendererStable = after?.[0].start === row.start;
  const ns = differentUserNamespace(browserNs, rendererNs);
  const filterAvailable = browser.filters !== undefined || status.filters !== undefined;
  const evidence = {
    rendererStatus: true, rendererStable, rendererCmdlineReadable: role.readable,
    rendererArgvMatch: role.explicitRenderer, rendererArgvContradiction: role.contradictory,
    rendererIdentity: rendererStable && !role.contradictory && (role.explicitRenderer || trustedBrowserInventory === true),
    rendererUidReadable: status.uid.length === 4 && status.uid.every(Number.isInteger), rendererUid: uidMatches(status, uid),
    pidNamespaceReadable: browser.nsDepth > 0 && status.nsDepth > 0, pidNamespace: status.nsDepth > browser.nsDepth,
    userNamespaceReadable: ns.readable, userNamespace: ns.isolated,
    nnpReadable: status.nnp !== undefined, nnp: status.nnp === 1,
    seccompReadable: status.seccomp !== undefined, seccomp: status.seccomp === 2,
    filterCountReadable: browser.filters !== undefined && status.filters !== undefined,
    filterDelta: !filterAvailable || (status.filters !== undefined && browser.filters !== undefined && status.filters > browser.filters),
  };
  const { rendererIdentity, rendererUid, pidNamespaceReadable, pidNamespace, userNamespace, nnp, seccomp, filterDelta } = evidence;
  return { ...evidence, pass: rendererIdentity && rendererUid && pidNamespaceReadable && pidNamespace &&
    userNamespace && nnp && seccomp && filterDelta };
}

async function snapshot({ launched, uid, profile, getProcessInfo, observeOwned, proc, evidence, trustedBrowserInventory }) {
  const { processInfo } = await getProcessInfo();
  if (!Array.isArray(processInfo) || processInfo.length > MAX_PROCS) return false;
  evidence.inventory = true;
  const browserRows = processInfo.filter((item) => item?.type === 'browser' && isPid(item.id));
  evidence.browserListed = browserRows.length === 1;
  evidence.renderersListed = processInfo.filter((item) => item?.type === 'renderer' && isPid(item.id)).length;
  if (!evidence.browserListed) return false;
  const browserPath = await ancestry(browserRows[0].id, launched, proc);
  evidence.browserOwned = !!browserPath;
  if (!browserPath) return false;
  const [browserRoot] = browserPath;
  const [browser, argv, browserNs] = await Promise.all([
    procStatus(browserRoot.pid, proc), procArgs(browserRoot.pid, proc), namespaceIdentity(browserRoot.pid, proc),
  ]);
  evidence.browserStatus = !!browser;
  evidence.browserUidReadable = browser?.uid.length === 4 && browser.uid.every(Number.isInteger);
  evidence.browserUid = !!uidMatches(browser, uid);
  evidence.browserIdentity = argv.includes(`--user-data-dir=${profile}`) && argv.includes('--remote-debugging-pipe') &&
    !argv.some((arg) => arg.startsWith('--type='));
  if (!browser || !evidence.browserUid || !evidence.browserIdentity || !(await ancestry(browserRoot.pid, launched, proc))) return false;
  observeOwned(browserPath);
  const seen = new Map([[browserRoot.pid, 'browser']]);
  const renderers = [];
  for (const item of processInfo) {
    if (!isPid(item?.id) || typeof item.type !== 'string') continue;
    if (seen.has(item.id)) {
      if (seen.get(item.id) !== item.type) { evidence.inventoryConsistent = false; return false; }
      continue;
    }
    seen.set(item.id, item.type);
    const path = await ancestry(item.id, browserRoot, proc);
    if (!path) continue;
    observeOwned(path);
    if (item.type === 'renderer') renderers.push(path[0]);
  }
  evidence.inventoryConsistent = true;
  evidence.renderersOwned = renderers.length;
  const results = await Promise.all(renderers.map((row) => checkRenderer({
    row, browserRoot, browser, browserNs, uid, proc, trustedBrowserInventory,
  })));
  evidence.renderersAttested = results.filter(({ pass }) => pass).length;
  // Report the evidence for the first failing renderer (or one passing renderer), never a PID or raw proc content.
  if (results.length) {
    const { pass: _pass, ...renderer } = results.find(({ pass }) => !pass) ?? results[0];
    Object.assign(evidence, renderer);
  }
  return evidence.renderersOwned > 0 && evidence.renderersOwned === evidence.renderersListed &&
    evidence.renderersAttested === evidence.renderersOwned;
}

/** Inspect only candidate IDs and their ancestors. Only the launcher sets trustedBrowserInventory for its private root CDP. */
export async function verifyRendererSandbox({ pid, uid, profile, signal, getProcessInfo, observeOwned = () => {},
  trustedBrowserInventory = false, proc = PROC, timeoutMs = SANDBOX_MS }) {
  const launched = await procIdentity(pid, proc);
  const deadline = Date.now() + timeoutMs;
  let evidence = { childIdentity: !!launched };
  if (launched) {
    do {
      signal.throwIfAborted();
      evidence = { childIdentity: true };
      try {
        if (await snapshot({ launched, uid, profile, getProcessInfo, observeOwned, proc, evidence, trustedBrowserInventory })) return;
      } catch (error) {
        if (error?.code === 'BROWSER_ABORTED' || error?.code === 'BROWSER_TIMEOUT') throw error;
        evidence.inventory = false;
        break;
      }
      if (Date.now() < deadline) await delay(70, undefined, { signal });
    } while (Date.now() < deadline);
  }
  throw fail('BROWSER_SANDBOX_REQUIRED', { sandbox: evidence });
}
