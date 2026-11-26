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

async function checkRenderer({ row, browser, browserNs, uid, proc }) {
  const [status, argv, rendererNs] = await Promise.all([
    procStatus(row.pid, proc), procArgs(row.pid, proc), namespaceIdentity(row.pid, proc),
  ]);
  if (!status) return { rendererStatus: false, pass: false };
  const ns = differentUserNamespace(browserNs, rendererNs);
  const filterAvailable = browser.filters !== undefined || status.filters !== undefined;
  const evidence = {
    rendererStatus: true, rendererIdentity: argv.includes('--type=renderer'),
    rendererUidReadable: status.uid.length === 4 && status.uid.every(Number.isInteger), rendererUid: uidMatches(status, uid),
    pidNamespaceReadable: browser.nsDepth > 0 && status.nsDepth > 0, pidNamespace: status.nsDepth > browser.nsDepth,
    userNamespaceReadable: ns.readable, userNamespace: ns.isolated,
    nnpReadable: status.nnp !== undefined, nnp: status.nnp === 1,
    seccompReadable: status.seccomp !== undefined, seccomp: status.seccomp === 2,
    filterCountReadable: browser.filters !== undefined && status.filters !== undefined,
    filterDelta: !filterAvailable || (status.filters !== undefined && browser.filters !== undefined && status.filters > browser.filters),
  };
  return { ...evidence, pass: Object.entries(evidence).every(([name, value]) => name === 'filterCountReadable' || value) };
}

async function snapshot({ launched, uid, profile, getProcessInfo, observeOwned, proc, evidence }) {
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
  const seen = new Set();
  const renderers = [];
  for (const item of processInfo) {
    if (!isPid(item?.id) || item.id === browserRoot.pid || seen.has(item.id)) continue;
    seen.add(item.id);
    const path = await ancestry(item.id, browserRoot, proc);
    if (!path) continue;
    observeOwned(path);
    if (item.type === 'renderer') renderers.push(path[0]);
  }
  evidence.renderersOwned = renderers.length;
  const results = await Promise.all(renderers.map((row) => checkRenderer({ row, browser, browserNs, uid, proc })));
  evidence.renderersAttested = results.filter(({ pass }) => pass).length;
  // Report the evidence for the first failing renderer (or one passing renderer), never a PID or raw proc content.
  if (results.length) {
    const { pass: _pass, ...renderer } = results.find(({ pass }) => !pass) ?? results[0];
    Object.assign(evidence, renderer);
  }
  return evidence.renderersOwned > 0 && evidence.renderersOwned === evidence.renderersListed &&
    evidence.renderersAttested === evidence.renderersOwned;
}

/** Inspect only this private Browser's process IDs and their ancestor chains, not the system process list. */
export async function verifyRendererSandbox({ pid, uid, profile, signal, getProcessInfo, observeOwned = () => {},
  proc = PROC, timeoutMs = SANDBOX_MS }) {
  const launched = await procIdentity(pid, proc);
  const deadline = Date.now() + timeoutMs;
  let evidence = { childIdentity: !!launched };
  if (launched) {
    do {
      signal.throwIfAborted();
      evidence = { childIdentity: true };
      try {
        if (await snapshot({ launched, uid, profile, getProcessInfo, observeOwned, proc, evidence })) return;
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
