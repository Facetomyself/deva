import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { manifestPath, root } from './check-parity.mjs'
import { buildWorkbook, defaultRepo, loadParity, parseOptions, run } from './export-parity-workbook.mjs'
import { publishWorkbook, snapshotFromEntries } from './parity-workbook-guard.mjs'

const requireFromDesktop = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))
const { unzipSync, strFromU8 } = requireFromDesktop('fflate')
const concurrently = promisify(execFile)
const decode = (value) => value.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity) =>
  ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity])

// Parse the generated XML subset (elements, attributes and the five built-in entities).
function parseXml(source) {
  const doc = { children: [], text: '' }
  const stack = [doc]
  for (const token of source.match(/<[^>]+>|[^<]+/g)) {
    if (token.startsWith('<?')) continue
    if (token.startsWith('</')) {
      assert.equal(stack.pop().name, token.slice(2, -1))
    } else if (token.startsWith('<')) {
      const [, name, attributes] = /^<([\w:]+)(.*?)(?:\/?>)$/.exec(token)
      const attrs = Object.fromEntries([...attributes.matchAll(/([\w:]+)="([^"]*)"/g)].map(([, key, value]) => [key, decode(value)]))
      const node = { name, attrs, children: [], text: '' }
      stack.at(-1).children.push(node)
      if (!token.endsWith('/>')) stack.push(node)
    } else stack.at(-1).text += decode(token)
  }
  assert.equal(stack.length, 1)
  assert.equal(doc.children.length, 1)
  return doc.children[0]
}
const child = (node, name) => node.children.find((element) => element.name === name)
const content = (node) => node.text + node.children.map(content).join('')
const nextSha = (sha) => `${sha.slice(0, -1)}${sha.endsWith('a') ? 'b' : 'a'}`
const github = (repo, sha, file) => `https://github.com/${repo}/blob/${sha}/${file}`

function unpack(bytes) {
  const files = unzipSync(bytes)
  const get = (name) => parseXml(strFromU8(files[name]))
  const book = get('xl/workbook.xml')
  const tabs = child(book, 'sheets').children.map(({ attrs }) => attrs.name)
  const sheets = tabs.map((name, i) => {
    const tree = get(`xl/worksheets/sheet${i + 1}.xml`)
    const refs = get(`xl/worksheets/_rels/sheet${i + 1}.xml.rels`).children
    const targets = new Map(refs.map(({ attrs }) => {
      assert.equal(attrs.TargetMode, 'External')
      assert.match(attrs.Type, /\/hyperlink$/)
      return [attrs.Id, attrs.Target]
    }))
    const links = new Map(child(tree, 'hyperlinks').children.map(({ attrs }) => [attrs.ref, targets.get(attrs['r:id'])]))
    assert.equal(links.size, refs.length)
    const rows = child(tree, 'sheetData').children.map(({ children }) => children.map((c) => {
      assert.ok(!child(c, 'f'))
      return { value: content(c), type: c.attrs.t, link: links.get(c.attrs.r), style: c.attrs.s }
    }))
    const first = Number(child(child(child(tree, 'sheetViews'), 'sheetView'), 'pane').attrs.ySplit)
    assert.match(child(tree, 'autoFilter').attrs.ref, new RegExp(`^A${first}:[A-Z]+${rows.length}$`))
    return { name, links, rows, data: rows.slice(first) }
  })
  return { files, tabs, sheets }
}

function actualParity() {
  // Format tests can run while linked sources are being edited. These in-memory
  // workbooks use a synthetic commit and are never published. The CLI checks actual Git blobs.
  const base=realpathSync(root)
  const manifest=loadParity({ read(file) {
    const path=join(base,file)
    assert.ok(path.startsWith(base+'/') && realpathSync(path)===path && lstatSync(path).isFile())
    return readFileSync(path)
  } })
  return {manifest,sha:'0123456789abcdef0123456789abcdef01234567'}
}

test('exact desktop AST methods and evidence, flows, values, and deterministic OOXML', () => {
  const { manifest, sha } = actualParity()
  const result = buildWorkbook(manifest, { sha })
  assert.deepEqual(result.bytes, buildWorkbook(manifest, { sha }).bytes)
  assert.notDeepEqual(result.bytes, buildWorkbook(manifest, { sha: nextSha(sha) }).bytes)
  const { files, tabs, sheets: [overview, methods, flows, values] } = unpack(result.bytes)
  assert.equal(Object.keys(files).length, 13)
  assert.ok(Object.keys(files).every((name) => !/macro|vba|externalLink/i.test(name)))
  assert.deepEqual(tabs, ['总览', `${manifest.baseline.methods}项能力`, '跨功能流程', '平台值'])
  assert.match(overview.rows[1][0].value, new RegExp(sha))
  assert.ok([...overview.links.values()].includes(github(defaultRepo, sha, manifestPath)))
  assert.equal(overview.data.length, manifest.baseline.groups + 1)
  assert.equal(methods.data.length, manifest.baseline.methods)
  assert.equal(new Set(methods.data.map(([key]) => key.value)).size, manifest.baseline.methods)
  assert.equal(methods.data.filter((row) => row[4].value === '订阅 · 含清理').length, manifest.baseline.subscriptions)
  const expectedMethods = manifest.groups.flatMap((group) => group.methods.map((method) => ({ group, method })))
  let expectedEvidence = 1 // Methods header links to the exact AST input.
  const dispositions = new Map([['已实现', 0], ['部分覆盖', 0], ['待实现', 0], ['仅桌面', 0]])
  for (const [i, { group, method }] of expectedMethods.entries()) {
    const row = methods.data[i]
    const { desktop, web } = method
    assert.deepEqual(row.slice(0, 4).map(({ value }) => value), [`${group.name}.${method.name}`, group.name, method.kind, method.channel])
    assert.equal(row[6].value, desktop.use)
    const label = web.status === 'implemented' ? '已实现' : web.status === 'desktop-only' ? '仅桌面' : web.partial ? '部分覆盖' : '待实现'
    assert.equal(row[7].value, label)
    dispositions.set(label, dispositions.get(label) + 1)
    assert.equal(row[9].value, web.semantic)
    if (web.partial) assert.deepEqual(row.slice(10, 12).map(({ value }) => value), [web.partial.scope, web.partial.remaining])
    const implementation = web.implementation ?? web.partial
    for (const [j, file] of [implementation?.handler, implementation?.test, desktop.host ?? group.host, desktop.entry].entries()) {
      assert.equal(row[12 + j].value, file ?? '')
      assert.equal(row[12 + j].link, file ? github(defaultRepo, sha, file) : undefined)
      if (file) expectedEvidence++
    }
  }
  assert.ok(expectedEvidence >= 344)
  assert.equal(methods.links.size, expectedEvidence + 1) // One more non-blob link goes to the commit.
  assert.deepEqual(overview.data[0].map(({ value }) => value), ['方法合计', String(manifest.baseline.methods),
    String(manifest.baseline.subscriptions), ...[...dispositions.values()].map(String)])
  assert.ok(methods.data.find(([key]) => key.value === 'skills.list')?.[13].link)
  assert.ok(methods.data.find(([key]) => key.value === 'skills.get')?.[12].link)
  assert.ok(!methods.data.some(([key]) => key.value === 'platform'))
  assert.deepEqual(flows.data.map((row) => row.map(({ value, link }) => [value, link])), manifest.flows.map(({ id, methods, expectation, precedent }) =>
    [[id, undefined], [methods.join('\n'), undefined], [expectation, undefined], [precedent ?? '', precedent ? github(defaultRepo, sha, precedent) : undefined]]))
  assert.equal(values.data.length, manifest.baseline.values)
  const platform = values.data.find(([key]) => key.value === 'platform')
  assert.equal(platform[1].value, 'process.platform')
  assert.ok(platform[10].link.startsWith(`https://github.com/${defaultRepo}/blob/${sha}/`))
})

test('fork links preserve casing; string cells preserve formula-looking Unicode and XML characters', () => {
  const { manifest, sha } = actualParity()
  const fork = 'Case-Preserving/Repo_Fork.1'
  const example = '=1+1 中文 😺 & < > " \' _x0041_ \u0001'
  const method = manifest.groups[0].methods[0]
  method.desktop.use = example
  method.desktop.host = '目录/文件 #?&.ts'
  const { sheets: [overview, methods] } = unpack(buildWorkbook(manifest, { sha, repo: fork, pr: 321 }).bytes)
  assert.ok([...overview.links.values()].includes(`https://github.com/${fork}/pull/321`))
  assert.equal(methods.data[0][6].type, 'inlineStr')
  assert.equal(methods.data[0][6].value, example.replace('_x0041_', '_x005F_x0041_').replace('\u0001', '_x0001_'))
  assert.equal(methods.data[0][14].link, github(fork, sha, '%E7%9B%AE%E5%BD%95/%E6%96%87%E4%BB%B6%20%23%3F%26.ts'))
  assert.deepEqual(parseOptions(['--repo', fork, '--pr', '321']), { repo: fork, pr: 321 })
  for (const repo of ['owner/repo\n', 'https://owner/repo', '../repo', 'owner/.', 'owner/repo.git', 'owner/repo?x', 'owner/repo/extra', 'foo--bar/repo', 'o%40x/r']) {
    assert.throws(() => parseOptions(['--repo', repo]), /Invalid --repo/)
  }
  for (const pr of ['01', '0', '-1', '1.1', '1e3', '1\n', '9007199254740992']) assert.throws(() => parseOptions(['--pr', pr]), /Invalid --pr/)
  assert.equal(run(['--repo', 'x/y', '--repo', 'z/y'], { stderr: () => {} }), 2)
})

const sha = 'abcdef1234567890abcdef1234567890abcdef12'
const payload = Buffer.from('original verified workbook bytes')
function scratch(t) {
  const temp = realpathSync(tmpdir())
  const dir = mkdtempSync(join(temp, 'deva-parity-test-'))
  const original=lstatSync(dir,{bigint:true})
  t.after(() => {
    assert.equal(dirname(dir), temp)
    assert.match(basename(dir), /^deva-parity-test-[a-z0-9]{6}$/i)
    const current=lstatSync(dir,{bigint:true})
    assert.equal(realpathSync(dir),dir); assert.ok(current.isDirectory() && current.uid===BigInt(process.geteuid()))
    assert.deepEqual([current.dev,current.ino],[original.dev,original.ino])
    rmSync(dir, { recursive: true })
  })
  return dir
}

test('snapshot requires exact-case tracked, staged and actual raw bytes for every input', (t) => {
  const dir = scratch(t)
  const path = 'evidence/Entry.ts'
  mkdirSync(join(dir, 'evidence'))
  writeFileSync(join(dir, path), payload)
  const blob = createHash('sha1').update(`blob ${payload.length}\0`).update(payload).digest('hex')
  const tree = new Map([[path, `100644 ${blob}`]])
  assert.throws(() => snapshotFromEntries(dir, sha, tree, new Map()).read(path), /HEAD\/index mismatch/)
  assert.throws(() => snapshotFromEntries(dir, sha, tree, new Map([[path, `100755 ${blob}`]])).read(path), /HEAD\/index mismatch/)
  assert.throws(() => snapshotFromEntries(dir, sha, tree, tree).read('evidence/entry.ts'), /exact-case/)
  assert.throws(() => snapshotFromEntries(dir, sha, tree, tree).read('../Entry.ts'), /Invalid repository path/)
  assert.deepEqual(snapshotFromEntries(dir, sha, tree, tree).read(path), payload)
  writeFileSync(join(dir, path), 'different worktree bytes')
  assert.throws(() => snapshotFromEntries(dir, sha, tree, tree).read(path), /Worktree bytes differ/)
  writeFileSync(join(dir, 'untrusted'), payload)
  symlinkSync(join(dir, 'untrusted'), join(dir, 'evidence', 'Link.ts'))
  const symlinkTree = new Map([['evidence/Link.ts', `100644 ${blob}`]])
  assert.throws(() => snapshotFromEntries(dir, sha, symlinkTree, symlinkTree).read('evidence/Link.ts'), /real, exact-case/)
})

test('publication is byte-idempotent and keeps unrelated files and links untouched', (t) => {
  const dir = scratch(t)
  const outputParent = join(dir, 'test-results', `parity-${sha.slice(0, 7)}`)
  const output = join(outputParent, 'Deva-Web-186项能力验收清单.xlsx')
  assert.deepEqual(publishWorkbook(dir, sha, 186, payload), { output, reused: false })
  assert.deepEqual(publishWorkbook(dir, sha, 186, payload), { output, reused: true })
  assert.throws(() => publishWorkbook(dir, sha, 186, Buffer.alloc(payload.length, 'X')), /exists/)
  assert.deepEqual(readFileSync(output), payload)
  assert.deepEqual(readdirSync(outputParent), [basename(output)])
  const unrelated = join(dir, 'unrelated')
  writeFileSync(unrelated, payload)
  symlinkSync(unrelated, join(outputParent, 'Deva-Web-187项能力验收清单.xlsx'))
  linkSync(unrelated, join(outputParent, 'Deva-Web-188项能力验收清单.xlsx'))
  const dangling = join(outputParent, 'Deva-Web-189项能力验收清单.xlsx')
  symlinkSync(join(dir, 'nonexistent'), dangling)
  for (const methodCount of [187, 188, 189]) assert.throws(() => publishWorkbook(dir, sha, methodCount, payload), /unsafe/)
  assert.deepEqual(readFileSync(unrelated), payload)
  assert.ok(lstatSync(dangling).isSymbolicLink())

  const other = scratch(t)
  symlinkSync(join(dir, 'test-results'), join(other, 'test-results'), 'dir')
  assert.throws(() => publishWorkbook(other, sha, 186, payload), /Unsafe workbook output directory/)
  const nested = scratch(t)
  mkdirSync(join(nested, 'test-results'))
  symlinkSync(outputParent, join(nested, 'test-results', `parity-${sha.slice(0, 7)}`), 'dir')
  assert.throws(() => publishWorkbook(nested, sha, 186, payload), /Unsafe workbook output directory/)
})

test('competing writers preserve complete bytes and only reuse exact content', async (t) => {
  const dir = scratch(t)
  const entry = new URL('./parity-workbook-guard.mjs', import.meta.url).href
  const script = `import { publishWorkbook } from ${JSON.stringify(entry)}; const [dir, sha, value] = process.argv.slice(1); console.log(JSON.stringify(publishWorkbook(dir, sha, 186, Buffer.from(value))));`
  const launch = (value) => concurrently(process.execPath, ['--input-type=module', '-e', script, dir, sha, value])
  const candidates = ['candidate one', 'candidate two']
  const results = await Promise.allSettled(candidates.map(launch))
  const winner = results.findIndex(({ status }) => status === 'fulfilled')
  assert.notEqual(winner, -1)
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1)
  const { output, reused } = JSON.parse(results[winner].value.stdout)
  assert.equal(reused, false)
  assert.equal(readFileSync(output, 'utf8'), candidates[winner])
  assert.deepEqual(publishWorkbook(dir, sha, 186, Buffer.from(candidates[winner])), { output, reused: true })
  assert.deepEqual(readdirSync(dirname(output)), [basename(output)])
})
