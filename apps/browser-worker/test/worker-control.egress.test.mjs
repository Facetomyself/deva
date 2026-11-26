import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { openWorkerClient } from '../src/client.mjs';
import { probeEgress, startEgress } from '../src/egress/index.mjs';
import { startWorker } from '../src/worker.mjs';

function throughProxy(proxyUrl, destination) {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const req = request({ host: proxy.hostname, port: proxy.port, path: destination.href,
      headers: { Host: destination.host }, agent: false }, (res) => {
      res.resume();
      res.once('error', reject);
      res.once('end', () => resolve(res.statusCode));
    });
    req.once('error', reject);
    req.setTimeout(2_000, () => req.destroy(new Error('local fixture proxy timeout')));
    req.end();
  });
}

test('worker connects to the separately owned broker, uses only its loopback adapter, and leaves the broker running', async (t) => {
  const root = await mkdtemp('/tmp/browser-wi-');
  const runDir = join(root, 'worker'), brokerDir = join(root, 'broker');
  await mkdir(brokerDir, { mode: 0o700 });
  let broker, worker, targetRequests = 0, engineCloses = 0;
  const target = createServer((req, res) => {
    targetRequests++;
    assert.equal(req.url, '/approved');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<p>Private loopback fixture</p>');
  });
  t.after(async () => {
    await worker?.close();
    await broker?.close();
    if (target.listening) await new Promise((resolve) => target.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  const url = new URL(`http://127.0.0.1:${target.address().port}/approved`);
  const sites = [{ id: 'fixture', label: 'Private fixture', url: url.href }];
  broker = await startEgress({ runDir: brokerDir, sites, privateOrigins: [url.origin] });
  worker = await startWorker({ runDir, egressSocket: broker.socketPath, sites, executablePath: '/fixture/chromium',
    engineProbe: async (args) => {
      assert.match(args.proxyUrl, /^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/u);
      assert.equal(Object.hasOwn(args, 'startUrl'), false);
      return { available: true };
    },
    engineFactory: async ({ proxyUrl, startUrl, allowedUrls }) => {
      assert.equal(startUrl, url.href);
      assert.deepEqual(allowedUrls, [url.href]);
      assert.equal(await throughProxy(proxyUrl, url), 200);
      return { close() { engineCloses++; }, getPageInfo: () => ({ origin: url.origin }),
        setInputPrivacy() {}, captureFrame() {}, dispatchInput() {} };
    },
  });
  const client = openWorkerClient({ runDir });
  assert.deepEqual(await client.status(), { state: 'ready' });
  assert.equal(targetRequests, 0, 'readiness must never contact a configured site');
  const tab = await client.open({ sid: 'fixture-sid', siteId: 'fixture' });
  assert.ok(tab.tabId);
  assert.equal(targetRequests, 1);
  await worker.close();
  assert.equal(engineCloses, 1);
  assert.equal(await probeEgress(broker.socketPath), true);
});
