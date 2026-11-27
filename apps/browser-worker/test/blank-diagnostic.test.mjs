import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseBlankDiagnostic, runBlankDiagnostic } from '../src/blank-diagnostic.mjs'
import { EngineError } from '../src/engine/policy.mjs'

const executablePath = '/private/fixture-chromium'
const empty = (code, available = false) => ({ available, code, stage: null, command: null, launchHint: null })
const verified = empty('BROWSER_BLANK_VERIFIED', true)
const generic = empty('BROWSER_DIAGNOSTIC_FAILED')
const line = value => `${JSON.stringify(value)}\n`

const failure = {
  available: false, code: 'BROWSER_START_FAILED', stage: 'version',
  command: 'Browser.getVersion', launchHint: 'sandbox-denied',
}

test('one fixed native call, and success only once the probe resolves after cleanup', async () => {
  const signals = new EventEmitter()
  const cleanup = Promise.withResolvers()
  const calls = []
  const attempt = runBlankDiagnostic(executablePath, { signals, probe: options => {
    calls.push(options)
    return cleanup.promise
  } })
  assert.equal(calls.length, 1)
  const { signal, ...options } = calls[0]
  assert.ok(signal instanceof AbortSignal && !signal.aborted)
  assert.deepEqual(options, { executablePath, proxyUrl: 'http://127.0.0.1:9' })
  let finished = false
  const result = attempt.then(value => { finished = true; return value })
  await new Promise(setImmediate)
  assert.equal(finished, false)
  cleanup.resolve({ available: true })
  assert.deepEqual(await result, verified)
  assert.deepEqual(signals.eventNames(), [])
})

test('native failure projection omits raw metadata and unexpected enum fields', async () => {
  const privateData = 'pid=987 path=/private/fixture version=140.1 https://example.invalid/#test-token'
  const native = new EngineError(failure.code, { ...failure, sandbox: { childIdentity: true } })
  native.message = privateData
  native.stderr = privateData
  native.diagnostic = { ...native.diagnostic, target: { url: privateData }, executablePath: privateData }
  const run = error => runBlankDiagnostic(executablePath, { probe: async () => { throw error } })
  assert.deepEqual(await run(native), failure)
  native.diagnostic = { stage: 'entry-navigation', command: 'Page.navigate', launchHint: privateData, stderr: privateData }
  assert.deepEqual(await run(native), empty(failure.code))
  for (const error of [new EngineError(privateData, failure), new Error(privateData), { ...native }, null]) {
    assert.deepEqual(await run(error), generic)
  }
  assert.deepEqual(await runBlankDiagnostic(executablePath, { probe: async () => ({ available: false, url: privateData }) }), generic)
})

test('SIGINT and SIGTERM request cancellation, await cleanup and never turn into exit-zero evidence', async () => {
  for (const name of ['SIGINT', 'SIGTERM']) {
    const signals = new EventEmitter()
    const cleanup = Promise.withResolvers()
    let signal, finished = false
    const result = runBlankDiagnostic(executablePath, { signals, probe: options => {
      signal = options.signal
      return cleanup.promise
    } }).then(value => { finished = true; return value })
    signals.emit(name)
    assert.equal(signal.aborted, true)
    await new Promise(setImmediate)
    assert.equal(finished, false)
    if (name === 'SIGINT') cleanup.resolve({ available: true })
    else cleanup.reject(new EngineError('BROWSER_CLEANUP_FAILED'))
    assert.deepEqual(await result, empty(name === 'SIGINT' ? 'BROWSER_ABORTED' : 'BROWSER_CLEANUP_FAILED'))
    assert.deepEqual(signals.eventNames(), [])
  }
})

test('real probe rejects both real and effective root before executable lookup', { skip: process.platform !== 'linux' }, async t => {
  const uid = t.mock.method(process, 'getuid', () => 0)
  const euid = t.mock.method(process, 'geteuid', () => 1000)
  const path = '/dev/null/never-a-chromium-binary'
  assert.deepEqual(await runBlankDiagnostic(path), empty('BROWSER_SANDBOX_REQUIRED'))
  uid.mock.mockImplementation(() => 1000)
  euid.mock.mockImplementation(() => 0)
  assert.deepEqual(await runBlankDiagnostic(path), empty('BROWSER_SANDBOX_REQUIRED'))
})

test('packaged exec parser correlates exit and rejects any noncanonical or additional output', () => {
  for (const [value, exit] of [[verified, 0], [failure, 1], [generic, 1]]) {
    assert.deepEqual(parseBlankDiagnostic(line(value), '', exit), value)
  }
  const valid = line(failure)
  for (const [stdout, stderr, exit] of [
    ['', '', 1], [valid, 'private stderr', 1], [valid, '', 125], [valid, '', 0], [line(verified), '', 1],
    [valid.trim(), '', 1], [` ${valid}`, '', 1], [`${valid}\n`, '', 1], [`noise\n${valid}`, '', 1],
    [`${valid}${valid}`, '', 1], [valid.replace('"available":false', '"available":false,"available":false'), '', 1],
    ...[{}, null, [], { ...failure, target: 'private' }, { ...failure, available: 'false' },
      { ...failure, code: 'BROWSER_PRIVATE' }, { ...failure, stage: 'entry-navigation' },
      { ...failure, command: 'Page.navigate' }, { ...failure, launchHint: 'private' },
      { ...generic, stage: 'version' }, { ...verified, stage: 'version' }].map(value => [line(value), '', value?.available === true ? 0 : 1]),
  ]) assert.equal(parseBlankDiagnostic(stdout, stderr, exit), null)
})

test('actual CLI emits one safe JSON line and nonzero exit without socket/config reads or Chromium spawn', () => {
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))
  const env = {
    DEVA_CHROMIUM_PATH: 'private-relative-executable', DEVA_BROWSER_CONTROL_DIR: 'private-relative-worker',
    DEVA_BROWSER_EGRESS_DIR: 'private-relative-egress', DEVA_BROWSER_SITES_FILE: 'private-relative-sites',
  }
  for (const [args, code] of [[[], 'BROWSER_EXECUTABLE_REQUIRED'], [['private-extra-arg'], 'BROWSER_CONFIGURATION_INVALID']]) {
    const result = spawnSync(process.execPath, [cli, 'diagnose-sandbox', ...args], { env, encoding: 'utf8', timeout: 5_000 })
    assert.equal(result.error, undefined)
    assert.equal(result.signal, null)
    assert.equal(result.status, 1)
    assert.equal(result.stderr, '')
    const expected = empty(code)
    assert.equal(result.stdout, line(expected))
    assert.deepEqual(parseBlankDiagnostic(result.stdout, result.stderr, result.status), expected)
  }
})
