import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const entry = fileURLToPath(new URL('../src/headless/project-documents.ts', import.meta.url))
const { output } = await build({ configFile: false, logLevel: 'silent', build: { ssr: entry, write: false,
  rollupOptions: { output: { format: 'es', inlineDynamicImports: true } } } })
const { projectDocumentResponses: publish, PROJECT_DOCS: root } = await import(`data:text/javascript;base64,${Buffer.from(output[0].code).toString('base64')}`)
const snapshot = documents => ({ version: 1, project: 'Fixture', documents, totalTextBytes: documents.reduce((sum, d) => sum + d.bytes, 0) })
const document = (name, text) => ({ name, text, bytes: Buffer.byteLength(text) })
const content = value => { assert.equal(value.bytes, Buffer.byteLength(value.json)); return JSON.parse(value.json) }

test('a bounded process-local publication separates its metadata from the explicitly selected text', () => {
  assert.equal(publish(undefined), undefined)
  const source = Array.from({ length: 8 }, (_, i) => document(`part-${i}.md`, `${i}` + '\t'.repeat(32767)))
  const first = publish(snapshot(source)), list = first(root), { project, generation, documents } = content(list)
  assert.ok(list.bytes <= 32 * 1024); assert.equal(project, 'Fixture'); assert.match(generation, /^[0-9a-f]{32}$/u)
  assert.equal(documents.length, source.length); assert.equal(new Set(documents.map(row => row.id)).size, source.length)
  for (const [i, { id, name, bytes }] of documents.entries()) {
    assert.match(id, /^[0-9a-f]{32}$/u); assert.deepEqual(documents[i], { id, name: source[i].name, bytes: source[i].bytes })
    const detail = first(`${root}/${generation}/${id}`)
    assert.ok(detail.bytes <= 200 * 1024); assert.deepEqual(content(detail), { generation, id, name, bytes, text: source[i].text })
    assert.equal(first(`${root}/${generation}/${name}`), undefined)
  }
  const next = publish(snapshot(source)), nextList = content(next(root)); assert.notEqual(nextList.generation, generation)
  assert.equal(next(`${root}/${generation}/${documents[0].id}`), undefined)
  assert.equal(next(`${root}/${nextList.generation}/${documents[0].id}`), undefined)
  assert.equal(first(`${root}?list`), undefined)
})
