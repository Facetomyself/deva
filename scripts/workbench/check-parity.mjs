import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractInventory, inventoryCounts } from './preload-inventory.mjs'

export const root = fileURLToPath(new URL('../../', import.meta.url))
export const preloadPath = 'apps/desktop/src/preload/index.ts'
export const manifestPath = 'docs/development/web-workbench/parity-manifest.json'

const kinds = ['invoke', 'send', 'sendSync', 'subscription']
const surfaces = ['ui', 'bridge-only', 'legacy-bridge']
const statuses = ['pending', 'implemented', 'desktop-only']
const targets = ['bootstrap', 'rpc', 'events', 'upload', 'download', 'client', 'desktop']
const namePattern = /^[a-zA-Z_$][\w$]*$/
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value) => typeof value === 'string' && value.trim().length > 0

function actualFile(relativePath) {
  if (!text(relativePath) || relativePath.includes('\\') || isAbsolute(relativePath) ||
      relativePath.split('/').some((part) => !part || part === '.' || part === '..')) return false
  try {
    const file = resolve(root, relativePath)
    const location = relative(realpathSync(root), realpathSync(file))
    return !!location && location !== '..' && !location.startsWith(`..${sep}`) && !isAbsolute(location) && lstatSync(file).isFile()
  } catch {
    return false
  }
}

function indexRows(rows, label, errors) {
  const index = new Map()
  if (!Array.isArray(rows)) {
    errors.push(`${label}: expected an array`)
    return index
  }
  for (const row of rows) {
    if (!record(row) || typeof row.name !== 'string' || !namePattern.test(row.name) || row.name === '__proto__') {
      errors.push(`${label}: each row needs a static name`)
      continue
    }
    if (index.has(row.name)) errors.push(`${label}: duplicate ${row.name}`)
    else index.set(row.name, row)
  }
  return index
}

function checkEvidence(path, field, errors, isFile) {
  if (!text(path) || !isFile(path)) errors.push(`${field}: expected a repo-relative path to an existing file`)
}

function checkWeb(web, id, errors, isFile) {
  if (!record(web)) {
    errors.push(`${id}.web: expected an object`)
    return
  }
  const { status, target, semantic, implementation } = web
  if (!statuses.includes(status)) errors.push(`${id}.web.status: invalid disposition`)
  if (!targets.includes(target)) errors.push(`${id}.web.target: invalid target`)
  if (!text(semantic)) errors.push(`${id}.web.semantic: explain the specific web behavior or exclusion`)
  if (statuses.includes(status) && (target === 'desktop') !== (status === 'desktop-only')) {
    errors.push(`${id}.web: desktop target and disposition disagree`)
  }
  if (web.partial !== undefined) {
    if (status !== 'pending' || !text(web.partial?.scope) || !text(web.partial?.remaining)) {
      errors.push(`${id}.web.partial: bounded progress needs a pending row, a scope, and the remaining desktop behavior`)
    }
    checkEvidence(web.partial?.handler, `${id}.web.partial.handler`, errors, isFile)
    checkEvidence(web.partial?.test, `${id}.web.partial.test`, errors, isFile)
  }
  if (status === 'implemented') {
    checkEvidence(implementation?.handler, `${id}.web.implementation.handler`, errors, isFile)
    checkEvidence(implementation?.test, `${id}.web.implementation.test`, errors, isFile)
    if (text(implementation?.handler) && implementation.handler === implementation.test) {
      errors.push(`${id}.web.implementation: handler and test must be distinct files`)
    }
  } else if (implementation !== undefined) {
    errors.push(`${id}.web.implementation: only implemented rows carry Workbench handler and test evidence`)
  }
}

function checkDesktop(row, id, errors, isFile, isValue = false) {
  const { desktop } = row
  if (!record(desktop)) {
    errors.push(`${id}.desktop: expected an object`)
    return
  }
  if (!surfaces.includes(desktop.surface)) errors.push(`${id}.desktop.surface: invalid entry class`)
  if (!text(desktop.use)) errors.push(`${id}.desktop.use: explain the current desktop use or bridge`)
  if (desktop.surface === 'ui') checkEvidence(desktop.entry, `${id}.desktop.entry`, errors, isFile)
  else if (desktop.entry !== undefined) errors.push(`${id}.desktop.entry: only ui rows carry a renderer entry`)
  if (isValue || desktop.host !== undefined) checkEvidence(desktop.host, `${id}.desktop.host`, errors, isFile)
  if (desktop.surface === 'legacy-bridge' && row.web?.status === 'desktop-only') {
    errors.push(`${id}: historical desktop use is not evidence for a Web exclusion`)
  }
}

function compareRows(expected, live, prefix, errors, fields) {
  for (const actual of live) {
    const id = `${prefix}${actual.name}`
    const documented = expected.get(actual.name)
    if (!documented) errors.push(`missing manifest entry: ${id}`)
    else for (const field of fields) {
      if (documented[field] !== actual[field]) {
        errors.push(`changed ${id}.${field}: manifest=${JSON.stringify(documented[field])}, preload=${JSON.stringify(actual[field])}`)
      }
    }
  }
  const liveNames = new Set(live.map(({ name }) => name))
  for (const name of expected.keys()) if (!liveNames.has(name)) errors.push(`stale manifest entry: ${prefix}${name}`)
}

function checkFlows(flows, methods, errors, isFile) {
  if (!Array.isArray(flows) || !flows.length) {
    errors.push('flows: expected named parity scenarios')
    return
  }
  const seen = new Set()
  for (const flow of flows) {
    if (!record(flow) || !text(flow.id) || !text(flow.expectation) || !Array.isArray(flow.methods) || !flow.methods.length) {
      errors.push('flows: each scenario requires id, methods and expectation')
      continue
    }
    if (seen.has(flow.id)) errors.push(`flows: duplicate ${flow.id}`)
    seen.add(flow.id)
    const members = new Set()
    for (const member of flow.methods) {
      if (!methods.has(member)) errors.push(`flows.${flow.id}: unknown method ${member}`)
      if (members.has(member)) errors.push(`flows.${flow.id}: duplicate method ${member}`)
      members.add(member)
    }
    if (flow.precedent !== undefined) checkEvidence(flow.precedent, `flows.${flow.id}.precedent`, errors, isFile)
  }
}

export function checkManifest(manifest, inventory, isFile = actualFile) {
  const errors = []
  if (!record(manifest)) return ['manifest: expected an object']
  if (manifest.schemaVersion !== 1) errors.push('schemaVersion: expected 1')
  if (manifest.preload !== preloadPath) errors.push(`preload: expected ${preloadPath}`)

  const groups = indexRows(manifest.groups, 'groups', errors)
  const values = indexRows(manifest.values, 'values', errors)
  const methods = new Set()
  const detected = new Map(inventory.groups.map((group) => [group.name, group.methods]))
  compareRows(groups, inventory.groups, '', errors, [])
  compareRows(values, inventory.values, '', errors, ['expression'])
  const documented = { groups: groups.size, methods: 0, subscriptions: 0, values: values.size }
  for (const [name, group] of groups) {
    if (values.has(name)) errors.push(`manifest group and value share name: ${name}`)
    checkEvidence(group.host, `${name}.host`, errors, isFile)
    const rows = indexRows(group.methods, `${name}.methods`, errors)
    if (!rows.size) errors.push(`${name}.methods: expected a nonempty group`)
    for (const [method, row] of rows) {
      const id = `${name}.${method}`
      methods.add(id)
      documented.methods++
      if (row.kind === 'subscription') documented.subscriptions++
      if (!kinds.includes(row.kind) || !text(row.channel)) errors.push(`${id}: expected a known IPC kind and channel`)
      checkDesktop(row, id, errors, isFile)
      checkWeb(row.web, id, errors, isFile)
    }
    if (detected.has(name)) compareRows(rows, detected.get(name), `${name}.`, errors, ['kind', 'channel'])
  }
  for (const [name, row] of values) {
    if (!text(row.expression)) errors.push(`${name}.expression: value source is required`)
    checkDesktop(row, name, errors, isFile, true)
    checkWeb(row.web, name, errors, isFile)
  }
  const live = inventoryCounts(inventory)
  for (const key of Object.keys(live)) {
    const expected = manifest.baseline?.[key]
    if (expected !== documented[key] || expected !== live[key]) {
      errors.push(`baseline.${key}: expected=${JSON.stringify(expected)}, manifest=${documented[key]}, preload=${live[key]}`)
    }
  }
  checkFlows(manifest.flows, methods, errors, isFile)
  return errors
}

// Publish mutually exclusive counts. A partial scope has tests but is still pending in the
// canonical manifest; it must never silently increase the implemented count.
function coverageReport(manifest) {
  const blank = () => ({ implemented: 0, partial: 0, pendingWithoutScope: 0, desktopOnly: 0 })
  const totals = blank()
  const groups = manifest.groups.map(({ name, methods }) => {
    const counts = blank()
    for (const { web } of methods) {
      const key = web.status === 'implemented' ? 'implemented' : web.status === 'desktop-only' ? 'desktopOnly' : web.partial ? 'partial' : 'pendingWithoutScope'
      counts[key]++; totals[key]++
    }
    return { name, ...counts }
  })
  return { baseline: manifest.baseline, totals, groups, values: Object.fromEntries(manifest.values.map(({name, web}) => [name,web.status])) }
}

export function run(args, { stdout = console.log, stderr = console.error } = {}) {
  if (args.length && (args.length !== 1 || !['--extract', '--coverage', '--help'].includes(args[0]))) {
    stderr('Usage: node scripts/workbench/check-parity.mjs [--extract | --coverage | --help]')
    return 2
  }
  if (args[0] === '--help') {
    stdout('Usage: node scripts/workbench/check-parity.mjs [--extract | --coverage | --help]\nDefault: validate manifest against the desktop preload AST. --extract: print the live inventory as JSON. --coverage: validate and print mutually exclusive per-namespace and total coverage as JSON.')
    return 0
  }
  try {
    const inventory = extractInventory(readFileSync(resolve(root, preloadPath), 'utf8'), preloadPath)
    if (args[0] === '--extract') {
      stdout(JSON.stringify({ baseline: inventoryCounts(inventory), ...inventory }, null, 2))
      return 0
    }
    const manifest = JSON.parse(readFileSync(resolve(root, manifestPath), 'utf8'))
    const errors = checkManifest(manifest, inventory)
    if (errors.length) {
      stderr(`Workbench parity check failed (${errors.length}):\n- ${errors.join('\n- ')}`)
      return 1
    }
    const report = coverageReport(manifest)
    if (args[0] === '--coverage') { stdout(JSON.stringify(report, null, 2)); return 0 }
    const { groups, methods, subscriptions, values } = inventoryCounts(inventory)
    const dispositions = manifest.groups.flatMap((group) => group.methods)
      .reduce((counts, row) => counts.set(row.web.status, (counts.get(row.web.status) ?? 0) + 1), new Map())
    const methodStatus = statuses.map((status) => `${status}=${dispositions.get(status) ?? 0}`).join(', ')
    const valueStatus = manifest.values.map(({ name, web }) => `${name}=${web.status}`).join(', ')
    stdout(`Workbench parity inventory OK: ${groups} groups / ${methods} methods (${subscriptions} subscriptions) / ${values} value(s); methods: ${methodStatus}; pending detail: ${report.totals.partial} partial, ${report.totals.pendingWithoutScope} without a recorded scope; values: ${valueStatus || 'none'}`)
    return 0
  } catch (error) {
    stderr(`Workbench parity check could not run: ${error.message}`)
    return 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2))
}
