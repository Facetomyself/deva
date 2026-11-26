#!/usr/bin/env node
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { inflateSync } from 'node:zlib';
import { createChromiumEngine, EngineError, probeChromium } from '../src/engine/chromium.mjs';

// Run as a normal Linux user: node apps/browser-worker/test-real/engine-handoff.mjs [/absolute/chrome]
// A missing or unsandboxed browser is a failing CI gate, not an optional test skip.
const color = [24, 109, 159];
const receiptColor = [34, 145, 83];
const input = '人工接管·状态保留';
const ENTRY_QUERY = 'token=fixture-local-query';
const ENTRY_HASH = 'fixture-local-fragment';
let verificationPhase = 'preflight';

async function executable() {
  const chosen = process.argv[2] || process.env.CHROMIUM_PATH || process.env.CHROME_BIN || process.env.CHROME_PATH;
  const dirs = (process.env.PATH ?? '').split(':').filter(isAbsolute);
  const paths = chosen ? [chosen] : ['google-chrome', 'google-chrome-stable', 'chromium', 'chrome', 'chromium-browser']
    .flatMap((name) => dirs.map((dir) => join(dir, name)))
    .concat('/opt/google/chrome/chrome', '/usr/lib/chromium/chromium');
  for (const path of paths) {
    if (!isAbsolute(path)) continue;
    try { await access(path, constants.X_OK); if ((await stat(path)).isFile()) return path; } catch { /* try next */ }
  }
  throw Object.assign(new Error('An existing Chromium/Chrome executable is required; set CHROMIUM_PATH.'), { code: 'BROWSER_EXECUTABLE_REQUIRED' });
}

function listenLoopback(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
}

function writeHtml(response, background, title, html) {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(`<!doctype html><meta charset="UTF-8"><title>${title}</title>
    <style>html,body{margin:0;background:rgb(${background});font:20px sans-serif}
    h1{position:absolute;top:12px;left:24px;margin:0;font-size:22px}
    input:not([type=hidden]){position:absolute;top:64px;left:24px;width:360px;height:40px;font:20px sans-serif}
    button{position:absolute;top:128px;left:24px;height:40px;width:125px}</style>${html}`);
}

async function readForm(req) {
  let size = 0;
  const parts = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1500) throw new Error('fixture submit oversized');
    parts.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(parts).toString());
}

function makeSite(state) {
  return createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/form' && req.method === 'GET') {
      writeHtml(res, color, 'Fixture Form', `<h1>Fixture Form</h1><form action="/submit" method="post">
        <input aria-label="Handoff fixture" name="value" required><input type="hidden" name="tab" id="tab">
        <button type="submit">Submit</button></form><script>
        const token = sessionStorage.getItem('fixture-tab') || crypto.randomUUID();
        sessionStorage.setItem('fixture-tab', token); document.getElementById('tab').value = token;</script>`);
    } else if (path === '/submit' && req.method === 'POST') {
      readForm(req).then((form) => {
        const tab = form.get('tab');
        if (form.get('value') !== input || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/u.test(tab ?? '') ||
            [...form].length !== 2) { res.writeHead(400).end(); return; }
        state.submitCount++;
        state.tab = tab;
        res.writeHead(303, { Location: '/receipt' }).end();
      }).catch(() => res.writeHead(400).end());
    } else if (path === '/receipt' && state.tab && req.method === 'GET') {
      writeHtml(res, receiptColor, 'Fixture Checking', `<h1>Fixture Receipt</h1><script>
        document.title = sessionStorage.getItem('fixture-tab') === '${state.tab}' ?
          'Fixture Complete' : 'Fixture State Lost';</script>`);
    } else if (path === '/stall') {
      state.onStall?.(); // Caller aborts while Chromium is waiting on the first document.
    } else res.writeHead(404).end();
  });
}

function makeProxy(origin, state) {
  const server = createServer((req, res) => {
    let url;
    try { url = new URL(req.url); } catch { res.writeHead(403).end(); return; }
    if (url.origin !== origin || !['GET', 'POST'].includes(req.method) || url.username || url.password) {
      res.writeHead(403).end(); return;
    }
    state.proxyRequests++;
    const headers = { ...req.headers, host: url.host, connection: 'close' };
    delete headers['proxy-connection'];
    const upstream = request(url, { method: req.method, headers, agent: false }, (response) => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => res.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  // This fixture needs HTTP only and cannot forward arbitrary destinations.
  server.on('connect', (_req, socket) => socket.destroy());
  server.on('upgrade', (_req, socket) => socket.destroy());
  return server;
}

function topLeftRgb(frame) {
  assert.equal(frame.mimeType, 'image/png');
  assert.equal(frame.width, 1024);
  assert.equal(frame.height, 768);
  const buffer = frame.bytes;
  assert.equal(buffer.readUInt32BE(16), frame.width);
  assert.equal(buffer.readUInt32BE(20), frame.height);
  assert.equal(buffer[24], 8);
  assert.ok([2, 6].includes(buffer[25]), 'Chromium returned an unexpected PNG format');
  let offset = 8;
  const chunks = [];
  while (offset + 12 <= buffer.length) {
    const size = buffer.readUInt32BE(offset);
    assert.ok(offset + size + 12 <= buffer.length);
    if (buffer.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(buffer.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
  }
  const decoded = inflateSync(Buffer.concat(chunks), { maxOutputLength: 4 * 1024 * 768 + 768 });
  assert.ok(decoded[0] <= 4);
  // At the top-left pixel all preceding Paeth/Sub/Up predictor values are zero.
  return [...decoded.subarray(1, 4)];
}

async function processes() {
  const all = [];
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/u.test(name)) continue;
    try {
      const raw = await readFile(`/proc/${name}/stat`, 'utf8');
      const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
      const [state, parent, group] = fields;
      if (state === 'Z' || state === 'X') continue;
      const argv = (await readFile(`/proc/${name}/cmdline`, 'utf8').catch(() => '')).split('\0');
      all.push({ pid: Number(name), parent: Number(parent), group: Number(group), start: fields[19], argv });
    } catch { /* process exited between reads */ }
  }
  return all;
}

async function ownedBrowser() {
  const snapshot = await processes();
  const roots = snapshot.flatMap((p) => p.parent === process.pid ? p.argv
    .filter((arg) => /^--user-data-dir=\/tmp\/deva-browser-[a-z0-9]{6}$/iu.test(arg))
    .map((arg) => ({ pid: p.pid, start: p.start, profile: arg.slice('--user-data-dir='.length) })) : []);
  assert.equal(roots.length, 1, 'expected precisely one owned Chromium process root');
  const [root] = roots;
  const children = new Map([[root.pid, root.start]]);
  for (let added = true; added;) {
    added = false;
    for (const p of snapshot) if (children.has(p.parent) && !children.has(p.pid)) {
      children.set(p.pid, p.start);
      added = true;
    }
  }
  return { ...root, children };
}

async function verifyExited(owned) {
  const live = await processes();
  if (owned) {
    assert.ok(!live.some((p) => (owned.children.has(p.pid) && owned.children.get(p.pid) === p.start) ||
      p.group === owned.pid || p.argv.some((arg) => arg === `--user-data-dir=${owned.profile}` ||
        arg.startsWith(`--database=${owned.profile}/`))), 'owned Chromium process survived close');
    await assert.rejects(stat(owned.profile), { code: 'ENOENT' });
  }
  assert.ok(!live.some((p) => p.parent === process.pid && p.argv.some((arg) => arg.startsWith('--user-data-dir=/tmp/deva-browser-'))));
}

async function eventually(inspect, accept) {
  const deadline = Date.now() + 4_000;
  do {
    const value = await inspect();
    if (accept(value)) return value;
    await delay(30);
  } while (Date.now() < deadline);
  assert.fail('expected Chromium page state did not arrive');
}

async function run() {
  if (process.platform !== 'linux' || process.getuid?.() === 0) {
    throw Object.assign(new Error('This verification requires non-root Linux with the Chromium sandbox.'), { code: 'BROWSER_SANDBOX_REQUIRED' });
  }
  const executablePath = await executable();
  const state = { submitCount: 0, proxyRequests: 0, tab: null, onStall: null };
  const site = makeSite(state);
  let proxy, engine, owned;
  try {
    const origin = await listenLoopback(site);
    proxy = makeProxy(origin, state);
    const proxyUrl = await listenLoopback(proxy);
    const options = { executablePath, proxyUrl };
    verificationPhase = 'probe';
    assert.deepEqual(await probeChromium(options), { available: true });
    assert.equal(state.proxyRequests, 0, 'readiness probe must stay on about:blank');
    await verifyExited();
    verificationPhase = 'open';
    engine = await createChromiumEngine({ ...options, startUrl: `${origin}/form?${ENTRY_QUERY}#${ENTRY_HASH}` });
    owned = await ownedBrowser();
    verificationPhase = 'first-frame';
    await eventually(() => engine.getPageInfo(), (info) => info.title === 'Fixture Form');
    assert.deepEqual(await engine.getPageInfo(), { origin, title: 'Fixture Form' });
    const first = await engine.captureFrame();
    assert.deepEqual(topLeftRgb(first), color);
    assert.ok(engine.getLatestFrame().bytes.equals(first.bytes));
    verificationPhase = 'handoff';
    engine.setInputPrivacy(true);
    assert.equal(engine.getLatestFrame(), null);
    await assert.rejects(engine.captureFrame(), { code: 'BROWSER_PRIVACY_ACTIVE' });
    await engine.dispatchInput({ type: 'click', x: 65, y: 81 });
    await engine.dispatchInput({ type: 'text', text: input });
    await eventually(() => engine.captureFrame({ privateView: true }), (frame) => !frame.bytes.equals(first.bytes));
    assert.deepEqual(await engine.getPageInfo(), { origin, title: '' });
    assert.equal(engine.getLatestFrame(), null);
    await engine.dispatchInput({ type: 'click', x: 83, y: 148 });
    await eventually(() => engine.captureFrame({ privateView: true }).catch((error) => {
      if (error.code !== 'BROWSER_FRAME_STALE') throw error;
      return null;
    }), (frame) => frame && topLeftRgb(frame).join() === receiptColor.join());
    engine.setInputPrivacy(false);
    assert.deepEqual(await eventually(() => engine.getPageInfo(), (info) => info.title === 'Fixture Complete'),
      { origin, title: 'Fixture Complete' });
    assert.equal(state.submitCount, 1, 'Chinese form field should survive the handoff and be submitted once');
    assert.ok(state.proxyRequests >= 3, 'fixture documents must travel through the loopback proxy');
    verificationPhase = 'history';
    await engine.back();
    await eventually(() => engine.getPageInfo(), (info) => info.title === 'Fixture Form');
    await engine.forward();
    await eventually(() => engine.getPageInfo(), (info) => info.title === 'Fixture Complete');
    verificationPhase = 'close';
    const finalOwned = await ownedBrowser();
    assert.equal(finalOwned.pid, owned.pid);
    owned = { ...owned, children: new Map([...owned.children, ...finalOwned.children]) };
    await engine.close();
    await verifyExited(owned);
    engine = null;

    verificationPhase = 'abort';
    let stalledOwned;
    const abort = new AbortController();
    state.onStall = () => {
      state.onStall = null;
      ownedBrowser().then((browser) => { stalledOwned = browser; abort.abort(); }, () => abort.abort());
    };
    await assert.rejects(createChromiumEngine({ ...options, startUrl: `${origin}/stall`, signal: abort.signal }),
      { code: 'BROWSER_ABORTED' });
    assert.ok(stalledOwned, 'cancellation must have a real running Chromium child');
    await verifyExited(stalledOwned);
    console.log('PASS: sandboxed Chromium probe, same-tab human handoff, real PNG, form submission, history and cleanup');
  } finally {
    try { await engine?.close(); } finally {
      await Promise.all([closeServer(site), proxy && closeServer(proxy)]);
    }
  }
}

run().catch((error) => {
  const diagnostic = error instanceof EngineError ? error.diagnostic : undefined;
  const code = /^BROWSER_[A-Z_]+$/u.test(error?.code) ? error.code : 'FIXTURE_FAILURE';
  const sandbox = Object.entries(diagnostic?.sandbox ?? {}).map(([name, value]) => `${name}:${Number(value)}`).join(',');
  const labels = [`phase=${verificationPhase}`, diagnostic?.stage && `stage=${diagnostic.stage}`,
    diagnostic?.command && `command=${diagnostic.command}`, diagnostic?.launchHint && `launch=${diagnostic.launchHint}`,
    sandbox && `sandbox=${sandbox}`].filter(Boolean);
  console.error(`FAIL ${code} [${labels.join(' ')}]`);
  process.exitCode = 1;
});
