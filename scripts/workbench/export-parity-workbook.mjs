import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkManifest, manifestPath, preloadPath, root } from './check-parity.mjs'
import { extractInventory } from './preload-inventory.mjs'
import { openSnapshot, publishWorkbook, validSha } from './parity-workbook-guard.mjs'
import { cell, zipWorkbook } from './parity-workbook-ooxml.mjs'

export const defaultRepo = 'Facetomyself/deva'
const usage = 'Usage: node scripts/workbench/export-parity-workbook.mjs [--repo owner/repo] [--pr positive-safe-integer]'
const ownerPattern = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/
const repoPattern = /^[A-Za-z0-9_.-]{1,100}$/
const required = [
  'scripts/workbench/export-parity-workbook.mjs', 'scripts/workbench/parity-workbook-guard.mjs',
  'scripts/workbench/parity-workbook-ooxml.mjs', 'scripts/workbench/check-parity.mjs',
  'scripts/workbench/preload-inventory.mjs', 'apps/desktop/package.json', 'pnpm-lock.yaml',
]

function verifyRepo(repo) {
  const [owner, name, extra] = typeof repo === 'string' ? repo.split('/') : []
  if (!owner || !name || extra !== undefined || owner.length > 39 || !ownerPattern.test(owner) ||
      !repoPattern.test(name) || name === '.' || name === '..' || name.toLowerCase().endsWith('.git')) {
    throw new Error('Invalid --repo: expected a GitHub owner/repo slug')
  }
  return repo
}

export function parseOptions(args) {
  const options = { repo: defaultRepo }
  const seen = new Set()
  for (let i = 0; i < args.length; i += 2) {
    const [flag, value] = args.slice(i, i + 2)
    if (!['--repo', '--pr'].includes(flag) || seen.has(flag) || value === undefined) throw new Error(usage)
    seen.add(flag)
    if (flag === '--repo') options.repo = verifyRepo(value)
    else {
      if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid --pr: expected a positive safe integer')
      options.pr = Number(value)
    }
  }
  return options
}

export function loadParity(snapshot) {
  for (const file of required) snapshot.read(file)
  const manifest = JSON.parse(snapshot.read(manifestPath).toString('utf8'))
  const inventory = extractInventory(snapshot.read(preloadPath).toString('utf8'), preloadPath)
  const errors = checkManifest(manifest, inventory, (path) => { snapshot.read(path); return true })
  if (errors.length) throw new Error(`Workbench parity check failed (${errors.length}):\n- ${errors.join('\n- ')}`)
  return manifest
}

const labels = { implemented: '已实现', partial: '部分覆盖', pending: '待实现', desktop: '仅桌面' }
const buckets = Object.keys(labels)
const desktopLabels = { ui: '桌面界面', 'bridge-only': '仅桥接', 'legacy-bridge': '历史桥接' }
function bucket({ status, partial }) {
  return status === 'implemented' ? 'implemented' : status === 'desktop-only' ? 'desktop' : partial ? 'partial' : 'pending'
}
const stats = (methods) => {
  const counts = Object.fromEntries(buckets.map((key) => [key, 0]))
  for (const { web } of methods) counts[bucket(web)]++
  return counts
}
const pathPart = (part) => encodeURIComponent(part).replace(/[!'()*]/g, (character) =>
  `%${character.charCodeAt(0).toString(16).toUpperCase()}`)

export function buildWorkbook(manifest, { sha, repo = defaultRepo, pr } = {}) {
  verifyRepo(repo)
  if (!validSha(sha)) throw new Error('Expected an exact Git commit SHA')
  if (pr !== undefined && (!Number.isSafeInteger(pr) || pr < 1)) throw new Error('Expected a positive safe PR number')
  const base = `https://github.com/${repo}`
  const evidence = (path) => path ? cell(path, 'link', `${base}/blob/${sha}/${path.split('/').map(pathPart).join('/')}`) : ''
  const commit = cell(`固定提交：${sha}`, 'metaLink', `${base}/commit/${sha}`)
  const methods = manifest.groups.flatMap((group) => group.methods)
  const counts = stats(methods)
  const subs = methods.filter(({ kind }) => kind === 'subscription').length
  const totals = `方法 ${methods.length} 项 · ${manifest.groups.length} 个命名空间 · ${subs} 项订阅（已计入方法） · ${buckets.map((key) => `${labels[key]} ${counts[key]}`).join(' / ')}`
  const status = (web) => cell(labels[bucket(web)], bucket(web))
  const countCells = (counts) => buckets.map((key) => cell(counts[key], key))
  const webCells = (web) => [status(web), web.target, web.semantic,
    web.partial?.scope ?? (web.status === 'implemented' ? '按 Web 预期行为验收；见源码和测试。' : ''),
    web.partial?.remaining ?? (web.status === 'pending' ? '待按 Web 预期行为实现及验证。' : ''),
    evidence((web.implementation ?? web.partial)?.handler), evidence((web.implementation ?? web.partial)?.test)]
  const webHeader = ['Web 状态', 'Web 落点', 'Web 预期行为', '已覆盖范围', '待补范围', 'Web 源码', 'Web 测试']
  const webWidths = [15, 14, 56, 43, 43, 45, 45]
  const methodTab = `${methods.length}项能力`
  const sheets = [
    {
      name: '总览', widths: [26, 16, 16, 16, 16, 16, 17], prefix: [
        `Deva Desktop / Web · ${methodTab}验收清单`, commit,
        `${repo} · 桌面 preload AST 与 parity manifest 已核对；证据固定于上述提交。`, totals,
        `另列 ${manifest.values.length} 项平台/启动值，见「平台值」；单列 ${manifest.flows.length} 项跨功能流程。`,
        ...(pr === undefined ? [] : [cell(`关联拉取请求：#${pr}（导出时指定）`, 'metaLink', `${base}/pull/${pr}`)]),
        '部分覆盖：有明确范围和证据，仍属待完成；待实现：清单尚无验收范围记录。',
        cell('查看验收清单源数据与完整字段', 'metaLink', evidence(manifestPath).href),
      ], header: ['命名空间', '方法数', '订阅数', ...Object.values(labels)],
      rows: [[cell('方法合计', 'total'), cell(methods.length, 'total'), cell(subs, 'total'), ...countCells(counts)],
        ...manifest.groups.map(({ name, methods: rows }) => [name, rows.length, rows.filter(({ kind }) => kind === 'subscription').length, ...countCells(stats(rows))])],
    },
    {
      name: methodTab, widths: [33, 16, 16, 36, 17, 15, 46, ...webWidths, 52, 52], frozenColumns: 1,
      prefix: [`${methodTab} · 桌面与 Web 对照`, commit, totals,
        cell('查看桌面 preload（AST 清查来源）', 'metaLink', evidence(preloadPath).href)],
      header: ['能力键', '命名空间', 'IPC 类型', 'IPC 通道', '订阅注记', '桌面入口类型', '桌面职责 / 用途', ...webHeader, '桌面宿主路径', '桌面界面路径'],
      rows: manifest.groups.flatMap(({ name, host, methods: rows }) => rows.map(({ name: method, kind, channel, desktop, web }) => [
        `${name}.${method}`, name, kind, channel, kind === 'subscription' ? cell('订阅 · 含清理', 'subscription') : '',
        desktopLabels[desktop.surface], desktop.use, ...webCells(web), evidence(desktop.host ?? host), evidence(desktop.entry),
      ])),
    },
    {
      name: '跨功能流程', widths: [25, 37, 83, 56], prefix: [`跨功能流程 · ${manifest.flows.length} 项`, commit],
      header: ['场景键', '关联能力键', '跨功能验收预期', '桌面参考实现'],
      rows: manifest.flows.map(({ id, methods: keys, expectation, precedent }) => [id, keys.join('\n'), expectation, evidence(precedent)]),
    },
    {
      name: '平台值', widths: [18, 24, 15, 46, ...webWidths, 52, 52], frozenColumns: 1,
      prefix: [`平台 / 启动值 · ${manifest.values.length} 项（单独计数）`, commit, '此表记录值表达式，独立于方法与订阅验收数。'],
      header: ['值键', '桌面表达式', '桌面入口类型', '桌面职责 / 用途', ...webHeader, '桌面宿主路径', '桌面界面路径'],
      rows: manifest.values.map(({ name, expression, desktop, web }) => [name, expression, desktopLabels[desktop.surface], desktop.use,
        ...webCells(web), evidence(desktop.host), evidence(desktop.entry)]),
    },
  ]
  return { bytes: zipWorkbook(sheets), methodCount: methods.length, counts, subs }
}

export function run(args, { stdout = console.log, stderr = console.error } = {}) {
  if (args.length === 1 && args[0] === '--help') { stdout(usage); return 0 }
  let options
  try { options = parseOptions(args) } catch (error) { stderr(error.message); return 2 }
  try {
    const snapshot = openSnapshot(root)
    const { bytes, methodCount } = buildWorkbook(loadParity(snapshot), { sha: snapshot.sha, ...options })
    snapshot.assertCurrent()
    const { output, reused } = publishWorkbook(root, snapshot.sha, methodCount, bytes)
    stdout(`${reused ? 'Verified existing' : 'Wrote'} ${output}\nPinned HEAD: ${snapshot.sha}`)
    return 0
  } catch (error) {
    stderr(`Parity workbook export failed: ${error.message}`)
    return 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2))
}
