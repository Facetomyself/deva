import { BOOTSTRAP_URL, VIEWPORT } from './policy.mjs';

// Fixed argv for the private Chromium process. Callers supply only its profile and proxy.
export function browserFlags(profile, proxyUrl) {
  return [
    '--headless', '--remote-debugging-pipe',
    `--user-data-dir=${profile}`, `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    `--proxy-server=${proxyUrl}`, '--proxy-bypass-list=<-loopback>',
    `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${new URL(proxyUrl).hostname}`, '--disable-quic',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--disable-blink-features=FileSystemAccess,FileSystemAccessLocal',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-extensions', '--disable-sync',
    // Built-in apps and component extensions can otherwise start workers in a blank profile.
    '--disable-default-apps', '--disable-component-extensions-with-background-pages',
    '--disable-breakpad', '--disable-crash-reporter', '--disable-crashpad-for-testing',
    '--password-store=basic', BOOTSTRAP_URL,
  ];
}
