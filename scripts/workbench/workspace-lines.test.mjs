import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))
const ts = require('typescript')
const source = await readFile(new URL('../../apps/desktop/src/workbench/workspace-line-endings.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const { workspaceEditorText } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)

test('an ordinary input event cannot normalize the original file or strip its UTF-8 BOM', () => {
  assert.equal(workspaceEditorText('\uFEFFOne\r\nTwo\r\n', '\uFEFFOne\nTwo!\n'), '\uFEFFOne\r\nTwo!\r\n')
  assert.equal(workspaceEditorText('\uFEFF原文\r\n', '替换\n另起一行\n'), '\uFEFF替换\r\n另起一行\r\n')
  assert.equal(workspaceEditorText('A\rB\r', 'A\nB\nC\n'), 'A\rB\rC\r')
  assert.equal(workspaceEditorText('x\ny', 'edit\ny'), 'edit\ny')
})

test('mixed terminators in unchanged text spans survive insertions and deletions', () => {
  const orig='A\r\nB\nC\rD\n'
  assert.equal(workspaceEditorText(orig, 'A\nB\nC\nD\n'), orig)
  assert.equal(workspaceEditorText(orig, 'A\nB\nM\nC\nD\n'), 'A\r\nB\nM\r\nC\rD\n')
  assert.equal(workspaceEditorText(orig, 'A\nB\nD\n'), 'A\r\nB\nD\n')
})
