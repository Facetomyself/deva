import assert from 'node:assert/strict';
import test from 'node:test';
import { browserFlags } from '../src/engine/launch-flags.mjs';

// Changes to the fixed production argv are deliberate: the sandbox, private pipe,
// and broker proxy are part of the startup boundary, not overridable flags.
test('Chromium launches with fixed private-pipe, restricted-egress, blank-only argv', () => {
  assert.deepEqual(browserFlags('/tmp/deva-browser-unit00', 'http://127.0.0.1:8123'), [
    '--headless', '--remote-debugging-pipe',
    '--user-data-dir=/tmp/deva-browser-unit00', '--window-size=1024,768',
    '--proxy-server=http://127.0.0.1:8123', '--proxy-bypass-list=<-loopback>',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-quic',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--disable-blink-features=FileSystemAccess,FileSystemAccessLocal',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-extensions', '--disable-sync',
    '--disable-default-apps', '--disable-component-extensions-with-background-pages',
    '--disable-breakpad', '--disable-crash-reporter', '--disable-crashpad-for-testing',
    '--password-store=basic', 'about:blank',
  ]);
});
