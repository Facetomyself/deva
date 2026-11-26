import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createChromiumEngine, probeChromium } from '../src/engine/chromium.mjs';
import { configPolicy, publicPageInfo, VIEWPORT } from '../src/engine/policy.mjs';
import { startChromiumSession } from '../src/engine/session.mjs';

const ORIGIN = 'http://fixture.invalid';
const START = `${ORIGIN}/form?state=hidden#only-local`;
const OTHER = `${ORIGIN}/other`;
const POLICY = configPolicy({ executablePath: '/bin/false', proxyUrl: 'http://127.0.0.1:8123', startUrl: START,
  allowedUrls: [START, OTHER] });
// Minimal wire fixture, not a rendered screenshot. Real rendering has its own CLI.
const png = Buffer.alloc(45);
Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
png.writeUInt32BE(13, 8);
png.write('IHDR', 12);
png.writeUInt32BE(VIEWPORT.width, 16);
png.writeUInt32BE(VIEWPORT.height, 20);
Buffer.from('0000000049454e44ae426082', 'hex').copy(png, 33);
const FRAME = png.toString('base64');

function protocolFixture({ probeOnly, verifySandbox = async () => {}, navigationMs = 400, commandMs = 350, signal } = {}) {
  const writer = new PassThrough();
  const reader = new PassThrough();
  const commands = [];
  const main = 'main-frame';
  const session = 'main-session';
  const context = 'isolated-context';
  const target = 'single-target';
  const info = { url: 'about:blank', title: '', targetId: target, browserContextId: context, type: 'page' };
  const entries = [{ id: 0, url: 'about:blank' }];
  let index = 0, loader = 0, closed = 0, buffer = '';
  let hold = new Set();
  const held = new Map();
  const emit = (method, params, sessionId = session) => send({ method, params, ...(sessionId ? { sessionId } : {}) });
  function send(message, split = false) {
    const wire = `${JSON.stringify(message)}\0`;
    if (split) { reader.write(wire.slice(0, 9)); reader.write(wire.slice(9)); }
    else reader.write(wire);
  }
  function commit(url, title = 'Fixture', id = `loader-${++loader}`) {
    info.url = url;
    info.title = title;
    emit('Page.frameNavigated', { frame: { url, id: main, loaderId: id } });
    emit('Page.lifecycleEvent', { frameId: main, loaderId: id, name: 'load' });
    return id;
  }
  function respond(request, result = {}) {
    send({ id: request.id, result, sessionId: request.sessionId }, true);
  }
  function onCommand(request) {
    commands.push(request);
    const { method, params } = request;
    if (hold.has(method)) { held.set(method, request); return; }
    switch (method) {
      case 'Browser.getVersion': return respond(request, { product: 'Chrome/140.0.0.0' });
      case 'Target.createBrowserContext': return respond(request, { browserContextId: context });
      case 'Target.createTarget':
        emit('Target.attachedToTarget', { sessionId: session, targetInfo: { ...info } }, null);
        return respond(request, { targetId: target });
      case 'Target.getTargetInfo': return respond(request, { targetInfo: { ...info } });
      case 'Page.getFrameTree': return respond(request, { frameTree: { frame: { url: info.url, id: main } } });
      case 'Page.navigate': {
        const id = commit(params.url);
        entries.splice(++index, Infinity, { id: index, url: params.url });
        return respond(request, { frameId: main, loaderId: id });
      }
      case 'Page.getNavigationHistory': return respond(request, { currentIndex: index, entries });
      case 'Page.navigateToHistoryEntry':
        index = entries.findIndex((entry) => entry.id === params.entryId);
        commit(entries[index].url);
        return respond(request);
      case 'Page.captureScreenshot': return respond(request, { data: FRAME });
      default: return respond(request);
    }
  }
  writer.on('data', (data) => {
    buffer += data.toString('utf8');
    let end;
    while ((end = buffer.indexOf('\0')) !== -1) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      onCommand(message);
    }
  });
  return {
    engine: startChromiumSession({ writer, reader, policy: POLICY, commandMs, navigationMs, verifySandbox, probeOnly, signal,
      shutdown: async () => { closed++; } }),
    commands, emit, commit, write: (value) => reader.write(value),
    hold: (method) => { hold.add(method); },
    release(method, value = {}) { hold.delete(method); respond(held.get(method), value); },
    get closed() { return closed; },
  };
}

test('startup applies fixed pipe methods and keeps one isolated target through handoff and history', async (t) => {
  const fixture = protocolFixture();
  const engine = await fixture.engine;
  t.after(() => engine.close());
  assert.deepEqual(await engine.getPageInfo(), { origin: ORIGIN, title: 'Fixture' });
  await assert.rejects(engine.back(), { code: 'BROWSER_HISTORY_UNAVAILABLE' });
  await assert.rejects(engine.navigate(`${ORIGIN}/not-an-entry`), { code: 'BROWSER_NAVIGATION_BLOCKED' });
  await assert.rejects(engine.navigate('about:blank'), { code: 'BROWSER_NAVIGATION_BLOCKED' });
  await engine.navigate(OTHER);
  await engine.back();
  await engine.forward();
  await engine.dispatchInput({ type: 'click', x: 32, y: 44 });
  await engine.dispatchInput({ type: 'text', text: '人工接管' });
  await engine.dispatchInput({ type: 'scroll', x: 32, y: 44, deltaX: 0, deltaY: 12 });
  await engine.dispatchInput({ type: 'key', key: 'Enter' });
  const typed = fixture.commands.filter(({ method }) => method.startsWith('Input.'));
  assert.deepEqual(typed.map(({ params }) => params.type ?? params.text),
    ['mousePressed', 'mouseReleased', '人工接管', 'mouseWheel', 'keyDown', 'keyUp']);
  assert.ok(typed.every(({ sessionId }) => sessionId === 'main-session'));
  assert.equal(fixture.commands.filter(({ method }) => method === 'Target.createTarget').length, 1);
  assert.ok(fixture.commands.every(({ method }) => !['Runtime.evaluate', 'Network.getCookies', 'DOM.getDocument'].includes(method)));
  assert.equal(fixture.commands.find(({ method }) => method === 'Browser.setDownloadBehavior').params.behavior, 'deny');
  await engine.close();
  await engine.close();
  assert.equal(fixture.closed, 1);
  assert.equal(engine.getLatestFrame(), null);
  await assert.rejects(engine.getPageInfo(), { code: 'BROWSER_CLOSED' });
});

test('private handoff clears latest pixels and suppresses title, including in-flight captures', async (t) => {
  const fixture = protocolFixture();
  const engine = await fixture.engine;
  t.after(() => engine.close());
  const frame = await engine.captureFrame();
  assert.equal(frame.mimeType, 'image/png');
  assert.deepEqual(frame.bytes, png);
  frame.bytes[0] = 0;
  assert.deepEqual(engine.getLatestFrame().bytes, png);
  fixture.hold('Page.captureScreenshot');
  const oldFrame = engine.captureFrame();
  await assert.rejects(engine.captureFrame(), { code: 'BROWSER_BUSY' });
  engine.setInputPrivacy(true);
  assert.equal(engine.getLatestFrame(), null);
  fixture.release('Page.captureScreenshot', { data: FRAME });
  await assert.rejects(oldFrame, { code: 'BROWSER_FRAME_STALE' });
  assert.deepEqual(await engine.getPageInfo(), { origin: ORIGIN, title: '' });
  await assert.rejects(engine.captureFrame(), { code: 'BROWSER_PRIVACY_ACTIVE' });
  assert.deepEqual((await engine.captureFrame({ privateView: true })).bytes, png);
  assert.equal(engine.getLatestFrame(), null);
  engine.setInputPrivacy(false);
  assert.equal(engine.getLatestFrame(), null);
  assert.deepEqual(await engine.getPageInfo(), { origin: ORIGIN, title: 'Fixture' });
});

test('page-driven same-origin document navigation is sandboxed; redirects and unsupported surfaces are blocked', async (t) => {
  const fixture = protocolFixture();
  const engine = await fixture.engine;
  t.after(() => engine.close());
  const safe = { requestId: 'same-origin', resourceType: 'Document', frameId: 'main-frame',
    request: { url: `${ORIGIN}/not-a-registered-entry` } };
  fixture.emit('Fetch.requestPaused', safe);
  assert.equal(fixture.commands.at(-1).method, 'Fetch.continueRequest');
  fixture.emit('Fetch.requestPaused', { ...safe, responseStatusCode: 200,
    responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }, { name: 'Content-Security-Policy', value: "default-src 'self'" }] });
  const response = fixture.commands.at(-1);
  assert.equal(response.method, 'Fetch.continueResponse');
  assert.ok(response.params.responseHeaders.some(({ value }) => value.includes('frame-src')));
  assert.ok(response.params.responseHeaders.some(({ value }) => value === "default-src 'self'"));
  fixture.emit('Fetch.requestPaused', { ...safe, responseStatusCode: 302,
    responseHeaders: [{ name: 'Location', value: 'http://cross-origin.invalid/' }] });
  assert.equal(fixture.commands.at(-1).method, 'Fetch.failRequest');
  await assert.rejects(engine.getPageInfo(), { code: 'BROWSER_NAVIGATION_BLOCKED' });
  fixture.emit('Fetch.requestPaused', { ...safe, frameId: 'child' });
  await assert.rejects(engine.getPageInfo(), { code: 'BROWSER_NAVIGATION_BLOCKED' });
  fixture.emit('Fetch.requestPaused', { ...safe, responseStatusCode: 200,
    responseHeaders: [{ name: 'Content-Disposition', value: 'attachment; filename=a' }] });
  await assert.rejects(engine.getPageInfo(), { code: 'BROWSER_DOWNLOAD_UNSUPPORTED' });
  fixture.emit('Target.attachedToTarget', { sessionId: 'popup', targetInfo: { targetId: 'popup', type: 'page' } }, null);
  assert.equal(fixture.commands.at(-1).method, 'Target.closeTarget');
  await assert.rejects(engine.getPageInfo(), { code: 'BROWSER_POPUP_UNSUPPORTED' });
  fixture.emit('Page.fileChooserOpened', {});
  await assert.rejects(engine.getPageInfo(), { code: 'BROWSER_FILE_CHOOSER_UNSUPPORTED' });
  fixture.emit('Page.javascriptDialogOpening', {});
  assert.deepEqual(fixture.commands.at(-1).params, { accept: false });
  await assert.rejects(engine.getPageInfo(), { code: 'BROWSER_DIALOG_UNSUPPORTED' });
  fixture.emit('Fetch.authRequired', { requestId: 'auth' });
  assert.equal(fixture.commands.at(-1).params.authChallengeResponse.response, 'CancelAuth');
  await assert.rejects(engine.getPageInfo(), { code: 'BROWSER_HTTP_AUTH_UNSUPPORTED' });
  fixture.commit('http://cross-origin.invalid');
  await assert.rejects(engine.getPageInfo(), { code: 'BROWSER_NAVIGATION_BLOCKED' });
});

test('unsupported gestures, shortcuts, host paths as tools and unsafe config are excluded', async (t) => {
  const fixture = protocolFixture();
  const engine = await fixture.engine;
  t.after(() => engine.close());
  for (const input of [null, { type: 'click', x: -1, y: 0 }, { type: 'click', x: 1024, y: 768 },
    { type: 'click', x: 2, y: 5, modifiers: 2 }, { type: 'key', key: 'F12' }, { type: 'key', key: 'Ctrl+V' },
    { type: 'scroll', x: 2, y: 5, deltaX: 99999, deltaY: 0 }, { type: 'text', text: 'a\u0000' },
    { type: 'text', text: 'x'.repeat(1025) }, { type: 'file', path: '/tmp/host' }]) {
    await assert.rejects(engine.dispatchInput(input), { code: 'BROWSER_INPUT_INVALID' });
  }
  assert.ok(!fixture.commands.some(({ method }) => method.startsWith('Input.')));
  await assert.rejects(createChromiumEngine({ executablePath: 'chromium', startUrl: START }), { code: 'BROWSER_EXECUTABLE_REQUIRED' });
  await assert.rejects(createChromiumEngine({ executablePath: '/bin/false', startUrl: START, proxyUrl: 'http://192.168.1.1:8080' }),
    { code: 'BROWSER_PROXY_REQUIRED' });
  assert.throws(() => configPolicy({ executablePath: '/bin/false', startUrl: START,
    allowedUrls: ['https://fixture.invalid/'], proxyUrl: 'http://127.0.0.1:8080' }), { code: 'BROWSER_CONFIGURATION_INVALID' });
  const absent = await probeChromium({ executablePath: '/usr/bin/deva-browser-never-shipped' }).catch((error) => error.code);
  assert.ok(['BROWSER_EXECUTABLE_REQUIRED', 'BROWSER_SANDBOX_REQUIRED'].includes(absent));
});

test('public metadata never serializes page URL and removes query/fragment echoes', () => {
  const url = `${ORIGIN}/a?q=sensitive%20value#fragment-id`;
  assert.deepEqual(publicPageInfo(url, `Portal - ${url}`), { origin: ORIGIN, title: 'Portal - [URL]' });
  assert.deepEqual(publicPageInfo(url, 'Example ?q=sensitive value'), { origin: ORIGIN, title: 'Example' });
  assert.deepEqual(publicPageInfo(url, 'sensitive value – Settings'), { origin: ORIGIN, title: '' });
  assert.deepEqual(publicPageInfo(url, 'fragment-id – Settings'), { origin: ORIGIN, title: '' });
  assert.equal(publicPageInfo(url, '😀'.repeat(120)).title, '😀'.repeat(100));
});

test('stop interrupts navigation and probe only validates an internal bootstrap frame', async (t) => {
  const fixture = protocolFixture();
  const engine = await fixture.engine;
  t.after(() => engine.close());
  fixture.hold('Page.navigate');
  const navigating = engine.navigate(OTHER);
  fixture.release('Page.navigate', { frameId: 'main-frame', loaderId: 'blocked' });
  await engine.stop();
  await assert.rejects(navigating, { code: 'BROWSER_NAVIGATION_STOPPED' });
  assert.equal(fixture.commands.at(-1).method, 'Page.stopLoading');
  let attested = 0;
  const probe = protocolFixture({ probeOnly: true, verifySandbox: async () => { attested++; } });
  await (await probe.engine).close();
  assert.equal(attested, 1);
  assert.equal(probe.closed, 1);
  assert.ok(!probe.commands.some(({ method }) => method === 'Page.navigate'));
  const failed = protocolFixture({ verifySandbox: async () => { throw new Error('secret'); } });
  await assert.rejects(failed.engine, { message: 'BROWSER_START_FAILED' });
  assert.equal(failed.closed, 1);
  assert.ok(!failed.commands.some(({ method }) => method === 'Page.navigate'));
});

test('aborting startup cleans up the session and ignores late browser replies', async () => {
  const controller = new AbortController();
  const fixture = protocolFixture({ signal: controller.signal });
  fixture.hold('Target.createTarget');
  await new Promise(setImmediate);
  assert.ok(fixture.commands.some(({ method }) => method === 'Target.createTarget'));
  controller.abort(new Error('not public'));
  await assert.rejects(fixture.engine, { code: 'BROWSER_ABORTED', message: 'BROWSER_ABORTED' });
  fixture.release('Target.createTarget', { targetId: 'late-target' });
  assert.equal(fixture.closed, 1);
  assert.ok(!fixture.commands.some(({ method }) => method === 'Page.navigate'));
  await assert.rejects(probeChromium({ executablePath: '/bin/false', signal: controller.signal }), { code: 'BROWSER_ABORTED' });
});

test('oversized pipe messages, bad frames and command timeouts stay bounded', async () => {
  const fixture = protocolFixture({ commandMs: 80 });
  const engine = await fixture.engine;
  fixture.hold('Page.captureScreenshot');
  const invalid = engine.captureFrame();
  fixture.release('Page.captureScreenshot', { data: 'AAAA' });
  await assert.rejects(invalid, { code: 'BROWSER_FRAME_INVALID' });
  fixture.hold('Page.captureScreenshot');
  await assert.rejects(engine.captureFrame(), { code: 'BROWSER_TIMEOUT' });
  await engine.close();
  assert.equal(fixture.closed, 1);
  const oversized = protocolFixture();
  const otherEngine = await oversized.engine;
  oversized.write(Buffer.alloc(6 * 1024 * 1024 + 1, 0x61));
  await assert.rejects(otherEngine.getPageInfo(), { code: 'BROWSER_PROTOCOL_LIMIT' });
  await otherEngine.close();
  assert.equal(oversized.closed, 1);
});
