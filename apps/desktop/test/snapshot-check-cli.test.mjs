import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { lstat, mkdtemp, open, readdir, realpath, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('../out/snapshot-check/check.mjs', import.meta.url))
const usage = 'Usage: node check.mjs --sha256 <64 lowercase hex characters> < snapshot.json\n'
const documents = [
  { name: 'disposable-a.md', text: 'Disposable body A — 文档 🙂\n' },
  { name: 'disposable-b.md', text: 'Disposable body B café\r\n' }
]
const record = JSON.stringify({ version: 1, project: 'Disposable project', documents }, null, 2) + '\n'
const raw = Buffer.from(record)
const sha256 = input => createHash('sha256').update(input).digest('hex')
const argsFor = input => ['--sha256', sha256(input)]
const result = (status, stdout, stderr) => ({ status, stdout, stderr })
const failed = code => result(1, '', `Snapshot check failed: ${code}\n`)
const sandbox = await mkdtemp(join(await realpath(tmpdir()), 'deva-snapshot-cli-'))
const original = await lstat(sandbox)
test.after(async () => {
  const now = await lstat(sandbox)
  assert.equal(await realpath(sandbox), sandbox)
  assert.ok(now.isDirectory() && now.dev === original.dev && now.ino === original.ino)
  assert.deepEqual(await readdir(sandbox), [])
  await rmdir(sandbox)
})

async function run(args, input, { keepOpen = false, env = {}, stdin = 'pipe' } = {}) {
  const home = join(sandbox, 'unused-home')
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: sandbox, env: { HOME: home, USERPROFILE: home, DEVA_HOME: join(sandbox, 'unused-deva-home'), ...env },
    stdio: [stdin, 'pipe', 'pipe'], timeout: 5000, killSignal: 'SIGKILL'
  })
  const closed = once(child, 'close')
  let stdout = '', stderr = '', stdinError
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  if (child.stdin) {
    child.stdin.on('error', error => { stdinError = error })
    if (!keepOpen) child.stdin.end(input)
    else if (input !== undefined) child.stdin.write(input)
  }
  const [status, signal] = await closed
  assert.equal(signal, null, 'checker must exit on its own before the deadline')
  if (stdinError) assert.match(stdinError.code, /^(EPIPE|ECONNRESET)$/)
  return result(status, stdout, stderr)
}

test('help and invalid arguments finish without reading stdin', async () => {
  for (const flag of ['--help', '-h']) {
    assert.deepEqual(await run([flag], undefined, { keepOpen: true }), result(0, usage, ''), flag)
  }
  const args = argsFor(raw)
  for (const [label, argv] of [
    ['no arguments', []], ['filename only', ['snapshot.json']], ['missing value', ['--sha256']],
    ['unexpected option', ['--digest', args[1]]], ['wrong syntax', [`--sha256=${args[1]}`]],
    ['short digest', ['--sha256', 'a'.repeat(63)]], ['uppercase digest', ['--sha256', 'A'.repeat(64)]],
    ['nonhex digest', ['--sha256', 'z'.repeat(64)]], ['trailing argument', [...args, 'snapshot.json']]
  ]) assert.deepEqual(await run(argv, undefined, { keepOpen: true }), result(2, '', usage), label)
  const env = { DEVA_PROJECT_DOCS_SHA256: args[1], DEVA_WEB_TOKEN: 'disposable-token-marker' }
  assert.deepEqual(await run([], raw, { env }), result(2, '', usage), 'ambient settings are ignored')
})

test('prints only counts for an exact matching UTF-8 snapshot', async () => {
  const { status, stdout, stderr } = await run(argsFor(raw), raw)
  assert.equal(status, 0)
  assert.equal(stderr, '')
  const [line, ...tail] = stdout.split('\n')
  assert.deepEqual(tail, [''])
  assert.deepEqual(JSON.parse(line), {
    ok: true, version: 1, documents: documents.length,
    textBytes: documents.reduce((sum, { text }) => sum + Buffer.byteLength(text), 0), sourceBytes: raw.length
  })
})

test('rejects changed or malformed bytes with sanitized failures', async () => {
  for (const input of [record + ' ', record.replaceAll('\n', '\r\n')]) {
    assert.deepEqual(await run(argsFor(raw), input), failed('digest_mismatch'))
  }
  const invalidUtf8 = Buffer.from(raw)
  invalidUtf8[raw.indexOf('🙂')] = 0xff
  for (const [label, input] of [
    ['invalid UTF-8', invalidUtf8], ['leading BOM', Buffer.concat([Buffer.from('\ufeff'), raw])],
    ['truncated JSON', raw.subarray(0, -2)], ['empty input', Buffer.alloc(0)]
  ]) assert.deepEqual(await run(argsFor(input), input), failed('invalid_snapshot'), label)
})

test('reports a real stdin read error without printing a path', { skip: process.platform !== 'linux' }, async () => {
  const dir = await open(sandbox, 'r')
  try { assert.deepEqual(await run(argsFor(raw), undefined, { stdin: dir.fd }), failed('input_error')) }
  finally { await dir.close() }
})

test('rejects more than 2 MiB of stdin before EOF', async () => {
  const oversized = Buffer.alloc(2 * 1024 * 1024 + 1, 0x20)
  raw.copy(oversized)
  assert.deepEqual(await run(argsFor(raw), oversized, { keepOpen: true }), failed('snapshot_limit'))
})
