import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createChromiumEngine, EngineError, probeChromium } from '../src/engine/chromium.mjs';
import { classifyStartupStderr } from '../src/engine/launch-diagnostics.mjs';
import { connectPipe } from '../src/engine/pipe.mjs';
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

function protocolFixture({ probeOnly, verifySandbox = async () => {}, navigationMs = 400, commandMs = 350, signal,
  initiallyHeld = [], launchTargets, discoveryTargets, unexpectedDiscovered, duringDownload, omitAttachedContext = false,
  fetchNavigation = false, holdNavigationCommit = false } = {}) {
  const writer = new PassThrough();
  const reader = new PassThrough();
  const commands = [];
  const main = 'main-frame';
  const session = 'main-session';
  const context = 'default-private-profile';
  const target = 'single-target';
  const info = { url: 'about:blank', title: '', targetId: target, browserContextId: context, type: 'page' };
  const initialTargets = launchTargets ?? [{ ...info, attached: false }];
  const entries = [{ id: 0, url: 'about:blank' }];
  let index = 0, loader = 0, closed = 0, buffer = '', pausedNavigation;
  const fetchEvent = () => ({ requestId: 'fixture-document', resourceType: 'Document', frameId: main,
    request: { url: pausedNavigation.params.url } });
  const hold = new Set(initiallyHeld);
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
      case 'Target.getTargets': return respond(request, { targetInfos: initialTargets });
      case 'Target.setDiscoverTargets': {
        for (const initial of discoveryTargets ?? initialTargets) emit('Target.targetCreated', { targetInfo: initial }, null);
        if (unexpectedDiscovered) emit('Target.targetCreated', { targetInfo: unexpectedDiscovered }, null);
        return respond(request);
      }
      case 'Browser.setDownloadBehavior':
        if (duringDownload) emit(duringDownload.method, duringDownload.params, null);
        return respond(request);
      case 'Target.attachToTarget':
        emit('Target.attachedToTarget', { sessionId: session, targetInfo: { ...info,
          ...(omitAttachedContext ? { browserContextId: undefined } : {}) }, waitingForDebugger: false }, null);
        return respond(request, { sessionId: session });
      case 'Target.getTargetInfo': return respond(request, { targetInfo: { ...info } });
      case 'Page.getFrameTree': return respond(request, { frameTree: { frame: { url: info.url, id: main } } });
      case 'Page.navigate': {
        if (fetchNavigation) {
          pausedNavigation = request;
          return emit('Fetch.requestPaused', fetchEvent());
        }
        const id = commit(params.url);
        entries.splice(++index, Infinity, { id: index, url: params.url });
        return respond(request, { frameId: main, loaderId: id });
      }
      case 'Fetch.continueRequest':
        respond(request);
        if (pausedNavigation) emit('Fetch.requestPaused', { ...fetchEvent(), responseStatusCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'text/html' }] });
        return;
      case 'Fetch.continueResponse':
        respond(request);
        if (pausedNavigation && !holdNavigationCommit) {
          const pending = pausedNavigation;
          pausedNavigation = null;
          return respond(pending, { frameId: main, loaderId: commit(pending.params.url) });
        }
        return;
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

test('Node child fd 3 reads requests and fd 4 writes responses on the private pipe', async (t) => {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `
    import { createReadStream, writeSync } from 'node:fs';
    const request = createReadStream(null, { fd: 3, autoClose: false });
    let buffered = '';
    for await (const bytes of request) {
      buffered += bytes.toString('utf8');
      const end = buffered.indexOf('\\0');
      if (end === -1) continue;
      const frame = JSON.parse(buffered.slice(0, end));
      if (frame.method !== 'Browser.getVersion') process.exit(2);
      writeSync(4, JSON.stringify({ id: frame.id, result: { product: 'Chromium/140.0.0.0' } }) + '\\0');
      break;
    }
  `], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  t.after(() => child.kill());
  child.stderr.resume();
  const pipe = connectPipe(child.stdio[3], child.stdio[4], { onEvent() {}, onFailure() {} });
  assert.deepEqual(await pipe.send('Browser.getVersion'), { product: 'Chromium/140.0.0.0' });
  pipe.stop();
  child.stdio[3].destroy();
  child.stdio[4].destroy();
  assert.deepEqual(await exited, [0, null]);
});

test('launcher stderr exposes an enum only and stops classifying before site use', () => {
  const stream = new PassThrough();
  const diagnostic = classifyStartupStderr(stream);
  assert.equal(diagnostic.hint(), 'silent');
  stream.write(Buffer.from('test local path /private/path and session '));
  assert.equal(diagnostic.hint(), 'unclassified');
  stream.write(Buffer.from('remote debugging pipe file descr'));
  stream.write(Buffer.from('iptors are not open'));
  assert.equal(diagnostic.hint(), 'debug-pipe');
  diagnostic.finish();
  stream.write(Buffer.from('error while loading shared libraries: /private/path'));
  assert.equal(diagnostic.hint(), 'debug-pipe');
  assert.equal(new EngineError('BROWSER_START_FAILED', { launchHint: '/private/path' }).diagnostic, undefined);
  stream.end();
});

test('startup attaches only to the single openerless initial blank and rejects foreign targets', async (t) => {
  const fixture = protocolFixture();
  const engine = await fixture.engine;
  t.after(() => engine.close());
  const attached = fixture.commands.filter(({ method }) => method === 'Target.attachToTarget');
  assert.deepEqual(attached.map(({ params }) => params), [{ targetId: 'single-target', flatten: true }]);
  assert.ok(!fixture.commands.some(({ method }) => ['Target.createTarget', 'Target.closeTarget', 'Target.createBrowserContext',
    'Target.setAutoAttach', 'Runtime.runIfWaitingForDebugger'].includes(method)));
  const initial = { targetId: 'original-blank', type: 'page', url: 'about:blank', attached: false };
  for (const launchTargets of [[{ ...initial, url: OTHER }], [{ ...initial, openerId: 'other' }], [{ ...initial, attached: true }],
    [initial, { ...initial, targetId: 'another' }]]) {
    const unexpected = protocolFixture({ launchTargets });
    await assert.rejects(unexpected.engine, (error) => {
      assert.equal(error.code, 'BROWSER_TARGET_LOST');
      assert.equal(error.diagnostic.stage, 'discover-bootstrap');
      assert.equal(error.diagnostic.target.event, 'snapshot');
      assert.equal(error.diagnostic.target.snapshotCount, launchTargets.length);
      return true;
    });
    assert.equal(unexpected.closed, 1);
    assert.ok(!unexpected.commands.some(({ method }) => method === 'Page.navigate'));
  }
  const discovered = protocolFixture({ unexpectedDiscovered: {
    targetId: 'browser-worker', type: 'service_worker', url: 'chrome-extension://fixture-unknown/background.js',
    browserContextId: 'default-private-profile',
  } });
  await assert.rejects(discovered.engine, (error) => {
    assert.equal(error.code, 'BROWSER_TARGET_LOST');
    assert.equal(error.diagnostic.stage, 'watch-targets');
    assert.equal(error.diagnostic.target.type, 'service_worker');
    assert.equal(error.diagnostic.target.context, 'same');
    assert.equal(error.diagnostic.target.sameTarget, false);
    assert.equal(error.diagnostic.target.postNavigation, false);
    return true;
  });
  assert.equal(discovered.closed, 1);
  assert.ok(!discovered.commands.some(({ method }) => method === 'Page.navigate'));
});

test('root reports may omit context or briefly omit URL only for the pinned blank', async (t) => {
  const blank = { targetId: 'single-target', type: 'page', url: 'about:blank', attached: false };
  const fixture = protocolFixture({ launchTargets: [blank], discoveryTargets: [{ ...blank, url: '',
    browserContextId: 'default-private-profile' }], omitAttachedContext: true,
  duringDownload: { method: 'Target.detachedFromTarget', params: {} } });
  const engine = await fixture.engine;
  t.after(() => engine.close());
  assert.deepEqual(await engine.getPageInfo(), { origin: ORIGIN, title: 'Fixture' });
  assert.equal(fixture.commands.filter(({ method }) => method === 'Target.attachToTarget').length, 1);
});

test('a conflicting explicit context during download guard yields only fixed target facts', async () => {
  const fixture = protocolFixture({ duringDownload: { method: 'Target.targetCreated', params: {
    targetInfo: { targetId: 'single-target', type: 'page', url: START, browserContextId: 'unknown-private-context' },
  } } });
  await assert.rejects(fixture.engine, (error) => {
    assert.equal(error.code, 'BROWSER_TARGET_LOST');
    assert.equal(error.diagnostic.stage, 'download-guard');
    const { target } = error.diagnostic;
    assert.equal(target.event, 'created');
    assert.equal(target.eventStage, 'download-guard');
    assert.equal(target.type, 'page');
    assert.equal(target.context, 'different');
    assert.equal(target.urlKind, 'http');
    assert.equal(target.sameTarget, true);
    assert.equal(target.postNavigation, false);
    assert.equal(target.snapshotCount, 1);
    assert.equal(target.snapshotUrlKind, 'blank');
    assert.ok(!JSON.stringify(target).includes(START));
    assert.ok(!JSON.stringify(target).includes('unknown-private-context'));
    return true;
  });
  assert.equal(fixture.closed, 1);
  const unsafe = new EngineError('BROWSER_TARGET_LOST', { target: { event: START, type: START, sameTarget: START,
    root: true, snapshotCount: 1, observedUrl: START } });
  assert.deepEqual(unsafe.diagnostic.target, { root: true, snapshotCount: 1 });
});

test('startup installs guards and attests its existing renderer before activation and site navigation', async (t) => {
  let attested = false;
  const fixture = protocolFixture({ verifySandbox: async () => {
    assert.equal(fixture.commands.at(-1).method, 'Page.captureScreenshot');
    assert.ok(!fixture.commands.some(({ method }) => method === 'Target.activateTarget' || method === 'Page.navigate'));
    attested = true;
  } });
  const engine = await fixture.engine;
  t.after(() => engine.close());
  assert.equal(attested, true);
  const order = fixture.commands.map(({ method }) => method);
  const required = ['Target.setDiscoverTargets', 'Browser.setDownloadBehavior', 'Target.attachToTarget', 'Page.enable',
    'Fetch.enable', 'Page.captureScreenshot', 'Target.activateTarget', 'Page.navigate'];
  assert.deepEqual(order.filter((method) => required.includes(method)), required);
});

test('a newly discovered page or worker invalidates the only engine page even in the pinned context', async () => {
  for (const [type, url] of [
    ['page', 'about:blank'], ['iframe', 'about:blank'], ['worker', 'about:blank'],
    ['shared_worker', 'about:blank'], ['service_worker', 'chrome-extension://fixture-unknown/background.js'],
  ]) {
    const fixture = protocolFixture();
    const engine = await fixture.engine;
    await engine.captureFrame();
    fixture.emit('Target.targetCreated', { targetInfo: { type, url, targetId: 'foreign',
      browserContextId: 'default-private-profile' } }, null);
    assert.equal(engine.getLatestFrame(), null);
    await assert.rejects(engine.getPageInfo(), (error) => {
      assert.equal(error.code, 'BROWSER_TARGET_LOST');
      assert.equal(error.diagnostic.target.type, type);
      assert.equal(error.diagnostic.target.context, 'same');
      return true;
    });
    await engine.close();
    assert.equal(fixture.closed, 1);
    assert.equal(fixture.commands.filter(({ method }) => method === 'Target.attachToTarget').length, 1);
  }
});

test('startup timeout reports only a predefined phase and CDP command', async () => {
  const fixture = protocolFixture({ probeOnly: true, commandMs: 50, initiallyHeld: ['Page.captureScreenshot'] });
  await assert.rejects(fixture.engine, (error) => {
    assert.equal(error.code, 'BROWSER_TIMEOUT');
    assert.equal(error.message, 'BROWSER_TIMEOUT');
    assert.deepEqual(error.diagnostic, { stage: 'bootstrap-png', command: 'Page.captureScreenshot' });
    return true;
  });
  assert.equal(fixture.closed, 1);
  assert.equal(new EngineError('BROWSER_START_FAILED', { stage: '/private/path', command: START }).diagnostic, undefined);
});

test('entry interleaves Fetch request and response continuations with a waiting Page.navigate', async (t) => {
  const fixture = protocolFixture({ fetchNavigation: true });
  const engine = await fixture.engine;
  t.after(() => engine.close());
  const commands = fixture.commands;
  const navigate = commands.findIndex(({ method }) => method === 'Page.navigate');
  assert.ok(navigate >= 0);
  assert.deepEqual(commands.slice(navigate, navigate + 3).map(({ method }) => method),
    ['Page.navigate', 'Fetch.continueRequest', 'Fetch.continueResponse']);
  assert.equal(commands[navigate + 1].params.interceptResponse, true);
  assert.ok(commands[navigate + 2].params.responseHeaders.some(({ name }) => name === 'Content-Security-Policy'));
  const discovery = commands.find(({ method }) => method === 'Target.setDiscoverTargets');
  assert.equal(discovery.sessionId, undefined);
  assert.deepEqual(discovery.params.filter.map(({ type }) => type).filter(Boolean),
    ['page', 'iframe', 'worker', 'shared_worker', 'service_worker']);
  assert.deepEqual(await engine.getPageInfo(), { origin: ORIGIN, title: 'Fixture' });
});

test('entry timeout distinguishes committed Fetch continuations from an absent document commit', async () => {
  const fixture = protocolFixture({ fetchNavigation: true, holdNavigationCommit: true, commandMs: 60 });
  await assert.rejects(fixture.engine, (error) => {
    assert.equal(error.code, 'BROWSER_TIMEOUT');
    assert.equal(error.diagnostic.command, 'Page.navigate');
    const { entryNavigation } = error.diagnostic;
    assert.equal(entryNavigation.navigateAck, 0);
    assert.equal(entryNavigation.requestPaused, 1);
    assert.equal(entryNavigation.continueRequestSent, 1);
    assert.equal(entryNavigation.continueRequestAck, 1);
    assert.equal(entryNavigation.responsePaused, 1);
    assert.equal(entryNavigation.continueResponseSent, 1);
    assert.equal(entryNavigation.continueResponseAck, 1);
    assert.equal(entryNavigation.mainFrameNavigated, 0);
    assert.ok(!JSON.stringify(error.diagnostic).includes(START));
    return true;
  });
  assert.equal(fixture.closed, 1);
  const bad = new EngineError('BROWSER_TIMEOUT', { entryNavigation: { responsePaused: 1, requestPaused: START, body: START } });
  assert.deepEqual(bad.diagnostic.entryNavigation, { responsePaused: 1 });
});

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
  assert.equal(fixture.commands.filter(({ method }) => method === 'Target.attachToTarget').length, 1);
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
  fixture.emit('Page.windowOpen', {});
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
  fixture.hold('Target.attachToTarget');
  await new Promise(setImmediate);
  assert.ok(fixture.commands.some(({ method }) => method === 'Target.attachToTarget'));
  controller.abort(new Error('not public'));
  await assert.rejects(fixture.engine, { code: 'BROWSER_ABORTED', message: 'BROWSER_ABORTED' });
  fixture.release('Target.attachToTarget', { sessionId: 'late-session' });
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
