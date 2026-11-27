import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

test('local file selection validates before reading and preserves exact UTF-8 without fetching', async t => {
  const entry = fileURLToPath(new URL('../src/headless/web/read-text-file.ts', import.meta.url))
  const { output } = await build({ configFile: false, logLevel: 'silent', build: { ssr: entry, write: false,
    rollupOptions: { output: { format: 'es', inlineDynamicImports: true } } } })
  const { readTextAttachment } = await import(`data:text/javascript;base64,${Buffer.from(output[0].code).toString('base64')}`)
  const originalFetch = globalThis.fetch; let requests = 0, reads = 0
  globalThis.fetch = async () => { requests++; throw Error('Unexpected fetch') }
  t.after(() => { globalThis.fetch = originalFetch })
  for (const [name, size, issue] of [['folder/a.md', 1, 'name'], ['a.pdf', 1, 'name'], ['a.txt', 0, 'empty'], ['a.md', 32769, 'size']]) {
    assert.equal(await readTextAttachment({ name, size, arrayBuffer() { reads++; throw Error('Unexpected read') } }), issue)
  }
  assert.equal(reads, 0)
  const text = '\uFEFF读书笔记\r\n```\r\nA quiet chapter.\t\r\n'
  assert.deepEqual(await readTextAttachment(new File([text], 'Notes.MD')), { name: 'Notes.MD', text })
  assert.equal(await readTextAttachment(new File([new Uint8Array([0xc3, 0x28])], 'a.txt')), 'utf8')
  assert.equal(await readTextAttachment(new File(['a\0b'], 'a.txt')), 'content')
  assert.equal(await readTextAttachment({ name: 'a.txt', size: 2, async arrayBuffer() { return new ArrayBuffer(1) } }), 'read')
  assert.equal(requests, 0)
})
