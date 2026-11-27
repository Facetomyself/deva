import { EngineError } from './engine/policy.mjs'

const success = 'BROWSER_BLANK_VERIFIED'
const generic = 'BROWSER_DIAGNOSTIC_FAILED'
const failures = new Set([
  generic, 'BROWSER_ABORTED', 'BROWSER_CLEANUP_FAILED', 'BROWSER_CONFIGURATION_INVALID',
  'BROWSER_EXECUTABLE_REQUIRED', 'BROWSER_FRAME_INVALID', 'BROWSER_NAVIGATION_BLOCKED',
  'BROWSER_PROTOCOL_INVALID', 'BROWSER_PROTOCOL_LIMIT', 'BROWSER_PROXY_REQUIRED',
  'BROWSER_SANDBOX_REQUIRED', 'BROWSER_START_FAILED', 'BROWSER_TARGET_LOST', 'BROWSER_TIMEOUT',
])
const stages = new Set([
  'version', 'discover-bootstrap', 'watch-targets', 'download-guard', 'attach-bootstrap',
  'page-controls', 'bootstrap-png', 'sandbox-attest',
])
const commands = new Set([
  'Browser.getVersion', 'Browser.setDownloadBehavior', 'Browser.close', 'Target.getTargets',
  'Target.setDiscoverTargets', 'Target.attachToTarget', 'Page.enable', 'Page.setLifecycleEventsEnabled',
  'Page.setInterceptFileChooserDialog', 'Network.setCacheDisabled', 'Network.setBypassServiceWorker',
  'Emulation.setDeviceMetricsOverride', 'Page.getFrameTree', 'Fetch.enable', 'Fetch.continueRequest',
  'Fetch.failRequest', 'Fetch.continueWithAuth', 'Page.handleJavaScriptDialog', 'Page.captureScreenshot',
  'SystemInfo.getProcessInfo',
])
const hints = new Set([
  'silent', 'unclassified', 'missing-library', 'sandbox-denied', 'debug-pipe',
  'profile-lock', 'snap-wrapper', 'startup-fatal',
])
const member = (values, value) => values.has(value) ? value : null

function report(available, code, details) {
  return { available, code, stage: member(stages, details?.stage),
    command: member(commands, details?.command), launchHint: member(hints, details?.launchHint) }
}

// A single local probe, independent of the worker, broker and their configured sites.
export async function runBlankDiagnostic(executablePath, { extraArgs = false, signals = process, probe } = {}) {
  if (extraArgs) return report(false, 'BROWSER_CONFIGURATION_INVALID')
  const controller = new AbortController()
  const stop = () => controller.abort()
  signals.on('SIGINT', stop); signals.on('SIGTERM', stop)
  try {
    probe ??= (await import('./engine/chromium.mjs')).probeChromium
    const result = await probe({ executablePath, proxyUrl: 'http://127.0.0.1:9', signal: controller.signal })
    if (controller.signal.aborted) return report(false, 'BROWSER_ABORTED')
    // The native result only resolves after PNG capture, kernel attestation and cleanup.
    return result?.available === true ? report(true, success) : report(false, generic)
  } catch (error) {
    if (error instanceof EngineError && failures.has(error.code) && error.code !== generic) {
      return report(false, error.code, error.diagnostic)
    }
    return report(false, generic)
  } finally {
    signals.removeListener('SIGINT', stop); signals.removeListener('SIGTERM', stop)
  }
}

// Hosted exec accepts exactly the CLI frame and correlated exit status, with no stderr.
export function parseBlankDiagnostic(stdout, stderr, exitCode) {
  if (typeof stdout !== 'string' || stdout.length > 512 || stderr !== '' || (exitCode !== 0 && exitCode !== 1)) return null
  try {
    const value = JSON.parse(stdout)
    if (value?.available !== (exitCode === 0) || (value.available ? value.code !== success : !failures.has(value.code))) return null
    const safe = report(value.available, value.code, value.available || value.code === generic ? undefined : value)
    return stdout === `${JSON.stringify(safe)}\n` ? safe : null
  } catch { return null }
}
