import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BUILTIN_SKILL_CATALOG } from '../dist/library-core.mjs'
import { openSkillDocuments } from '../src/skills/documents.mjs'

const protectedIds = ['create-skill', 'create-agent', 'create-mcp']
const statuses = { skill_invalid: 400, skill_unsupported: 409, skill_limit: 413, skill_restricted: 422 }
const revision = /^[a-f0-9]{64}$/
const skillMd = (name, body = 'Prose.') => `---\nname: ${name}\ndescription: Display summary\n---\n\n${body}\n`

function sandbox(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'deva-skill-documents-'))
  const dataDir = join(dir, 'data'), skillsDir = join(dataDir, 'skills')
  const documents = openSkillDocuments({ dataDir }) // Roots are deliberately absent at construction.
  t.after(() => {
    documents.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  fs.mkdirSync(dataDir, { mode: 0o700 })
  function folder(id) {
    const path = join(skillsDir, id)
    fs.mkdirSync(path, { mode: 0o700, recursive: true })
    return path
  }
  function put(id, value) {
    const path = join(folder(id), 'SKILL.md')
    fs.writeFileSync(path, value, { mode: 0o600 })
    return path
  }
  return { dir, dataDir, skillsDir, documents, folder, put }
}

function fails(code, action) {
  assert.throws(action, { name: 'SkillDocumentError', code, message: code, status: statuses[code], statusCode: statuses[code] })
}

function watchDocumentReads(path, task, onRead) {
  const old = fs.readSync, info = fs.statSync(path, { bigint: true })
  let read = 0
  fs.readSync = function (fd, ...args) {
    const n = old.call(this, fd, ...args)
    const current = fs.fstatSync(fd, { bigint: true })
    if (current.dev === info.dev && current.ino === info.ino) {
      read += n
      onRead?.(read)
    }
    return n
  }
  syncBuiltinESMExports()
  try { return task(() => read) } finally { fs.readSync = old; syncBuiltinESMExports() }
}

test('native builtin rows are immutable display metadata and load with absent custom storage', t => {
  const { documents, folder } = sandbox(t)
  const rows = documents.list()
  assert.deepEqual(rows.map(item => item.id), protectedIds)
  assert.deepEqual(rows.map(({ documentRevision, ...summary }) => summary), BUILTIN_SKILL_CATALOG)
  assert(BUILTIN_SKILL_CATALOG.every(Object.isFrozen))
  for (const row of rows) {
    assert.match(row.documentRevision, revision)
    assert.deepEqual(documents.get(row.id), { ...row, detail: 'builtin' })
    assert.equal(documents.stamp(row.id), row.documentRevision)
  }
  assert.deepEqual(documents.stamps(), protectedIds.toSorted().map(id => ({ id, documentRevision: documents.stamp(id) })))
  rows[0].description = 'edited returned value'
  assert.equal(documents.get('create-skill').description, BUILTIN_SKILL_CATALOG[0].description)
  folder('ordinary.empty')
  assert.equal(documents.list().length, 3)
  assert.equal(documents.get('ordinary.empty'), null)
  assert.equal(documents.stamp('ordinary.empty'), null)
  assert.equal(documents.get('missing'), null)
})

test('ordinary native notes share parser, projections and revisions; resources stay literal', t => {
  const { documents, folder, put } = sandbox(t)
  put('z-late', skillMd('Zulu'))
  put('same-b', skillMd('Same'))
  put('same-a', skillMd('Same'))
  const raw = '\uFEFF' + [
    '---', 'name: Alpha', 'description: "Résumé goes here"', 'trigger: On request', 'license: MIT',
    'compatibility: Local prose', 'allowed-tools: Bash(git add:*) Read', 'metadata:',
    '  author: "Owner"', '  reference: scripts/read.sh', 'private_field: ignored', '---', '',
    'Read `scripts/read.sh` and `/etc/example.conf` as references.', '', 'A secret-like ordinary placeholder: password=hello.', ''
  ].join('\r\n')
  put('some.Notes-2', raw)
  fs.symlinkSync('/missing-resource', join(folder('some.Notes-2'), 'scripts'))
  fs.symlinkSync('/missing-foreign', join(folder('.hide-me'), 'SKILL.md'))
  const rows = documents.list()
  assert.deepEqual(rows.map(x => x.id), [...protectedIds, 'some.Notes-2', 'same-a', 'same-b', 'z-late'])
  const row = rows[3]
  assert.deepEqual(Object.keys(row).sort(), ['description', 'documentRevision', 'id', 'name', 'source'])
  assert.deepEqual(documents.get(row.id), {
    ...row, detail: 'document', trigger: 'On request', license: 'MIT', compatibility: 'Local prose',
    allowedTools: ['Bash(git add:*)', 'Read'], metadata: { author: 'Owner', reference: 'scripts/read.sh' },
    instructions: 'Read `scripts/read.sh` and `/etc/example.conf` as references.\n\nA secret-like ordinary placeholder: password=hello.'
  })
  const stamps = documents.stamps()
  assert.deepEqual(stamps, rows.map(({ id, documentRevision }) => ({ id, documentRevision })).sort((a, b) => a.id < b.id ? -1 : 1))
  for (const { id, documentRevision } of rows) {
    assert.match(documentRevision, revision)
    assert.equal(documents.stamp(id), documentRevision)
  }
  assert.equal(documents.get('some.notes-2'), null)
})

test('stamps are stat-only; list reads headers and selected detail reads exactly one body', t => {
  const { documents, put } = sandbox(t)
  const invalidBody = Buffer.concat([Buffer.from(skillMd('Healthy header', 'a'.repeat(8000))), Buffer.from([0xff, 0])])
  const path = put('body', invalidBody)
  put('other', skillMd('Other', 'Safe detail'))
  watchDocumentReads(path, read => {
    const stamped = documents.stamp('body')
    assert.equal(documents.stamps().find(x => x.id === 'body').documentRevision, stamped)
    assert.equal(read(), 0)
    assert.equal(documents.get('other').instructions, 'Safe detail')
    assert.equal(read(), 0)
    assert.equal(documents.list().find(x => x.id === 'body').documentRevision, stamped)
    assert(read() > 0 && read() <= 512)
    const before = read()
    fails('skill_unsupported', () => documents.get('body'))
    assert.equal(read() - before, invalidBody.length)
  })
  const plain = put('plain', '\uFEFF# Plain body\r\n\r\nNo frontmatter.\r\n')
  assert.equal(documents.get('plain').instructions, '# Plain body\n\nNo frontmatter.')
  fs.writeFileSync(plain, 'Only LF or CRLF\rInvalid.')
  fails('skill_unsupported', () => documents.get('plain'))
  put('unterminated', '---\nname: Missing closing marker')
  assert.match(documents.stamp('unterminated'), revision)
  fails('skill_unsupported', () => documents.get('unterminated'))
  fails('skill_unsupported', () => documents.list())
})

test('selected restrictions distinguish obvious key forms from mere prose and references', t => {
  const { documents, put } = sandbox(t)
  put('sensitive-header', '---\nname: Summary remains visible\nmetadata:\n  apiKey: REPLACE_ME\n---\nManual note.\n')
  put('sensitive-body', skillMd('Header is ordinary', '-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic key marker\n-----END OPENSSH PRIVATE KEY-----'))
  put('other', skillMd('Other', 'No credential material, merely a reference to credentials.env'))
  assert.equal(documents.list().length, 6)
  fails('skill_restricted', () => documents.get('sensitive-header'))
  fails('skill_restricted', () => documents.get('sensitive-body'))
  assert.equal(documents.get('other').instructions, 'No credential material, merely a reference to credentials.env')
  const token = 'ghp_' + 'X'.repeat(36)
  put('sensitive-title', skillMd(token))
  assert.match(documents.stamp('sensitive-title'), revision)
  fails('skill_restricted', () => documents.get('sensitive-title'))
  fails('skill_restricted', () => documents.list())
})

test('unsafe identifiers, reserved aliases, and prototype/duplicate fields fail closed', t => {
  const { documents, folder, put } = sandbox(t)
  for (const id of ['../ordinary', 'x/other', 'x\\other', '.hidden', 'x\n', 'x\r\n', 'x.', 'a..b',
    '__proto__', 'constructor', 'toString', 'CREATE-SKILL', 'create_agent', 'create.mcp']) {
    fails('skill_invalid', () => documents.get(id))
    fails('skill_invalid', () => documents.stamp(id))
  }
  put('alias-title', skillMd('CREATE_SKILL'))
  fails('skill_unsupported', () => documents.get('alias-title'))
  fails('skill_unsupported', () => documents.list())
  put('alias-title', skillMd('An ordinary name'))
  put('unsafe-fields', '---\nname: Fields\nmetadata:\n  __proto__: sentinel\n---\nOther text.\n')
  fails('skill_unsupported', () => documents.get('unsafe-fields'))
  fails('skill_unsupported', () => documents.list())
  put('unsafe-fields', '---\nname: Fields\nname: duplicate\n---\nOther text.\n')
  fails('skill_unsupported', () => documents.get('unsafe-fields'))
  folder('Same')
  folder('same')
  fails('skill_unsupported', () => documents.stamps())
  fs.rmdirSync(folder('same'))
  put('CREATE-SKILL', skillMd('Shadow'))
  assert.equal(documents.get('create-skill').detail, 'builtin')
  fails('skill_invalid', () => documents.get('CREATE-SKILL'))
  fails('skill_unsupported', () => documents.get('alias-title'))
  fails('skill_unsupported', () => documents.stamps())
})

test('native symlinks, hard links, and unsafe owner permissions never produce rows', t => {
  const { documents, dataDir, folder, dir, put, skillsDir } = sandbox(t)
  const outside = join(dir, 'outside.md')
  fs.writeFileSync(outside, skillMd('Outside'))
  const skill = folder('selected'), file = join(skill, 'SKILL.md')
  fs.symlinkSync(outside, file)
  fails('skill_unsupported', () => documents.get('selected'))
  fails('skill_unsupported', () => documents.stamps())
  fs.unlinkSync(file)
  fs.linkSync(outside, file)
  fails('skill_unsupported', () => documents.stamp('selected'))
  fs.unlinkSync(file)
  put('selected', skillMd('Owned'))
  for (const mode of [0o666, 0o200, 0o700]) {
    fs.chmodSync(file, mode)
    fails('skill_unsupported', () => documents.stamp('selected'))
  }
  fs.chmodSync(file, 0o600)
  fs.chmodSync(skill, 0o777)
  fails('skill_unsupported', () => documents.get('selected'))
  fs.chmodSync(skill, 0o700)
  fs.symlinkSync(skill, join(skillsDir, 'symlink'))
  fails('skill_unsupported', () => documents.stamps())
  fs.unlinkSync(join(skillsDir, 'symlink'))
  const old = join(dir, 'outside-skills')
  fs.renameSync(skillsDir, old)
  fs.symlinkSync(old, skillsDir)
  fails('skill_unsupported', () => documents.list())
  const alias = join(dir, 'alias')
  fs.symlinkSync(dataDir, alias)
  fails('skill_unsupported', () => openSkillDocuments({ dataDir: alias }).stamps())
})

test('revisions track native file/directory identity and same-length edits, not auxiliary resources', t => {
  const { documents, put, folder, skillsDir } = sandbox(t)
  const path = put('note', skillMd('Name', 'First'))
  const first = documents.stamp('note')
  fs.writeFileSync(join(folder('note'), 'private-resource'), 'Ignored.')
  assert.equal(documents.stamp('note'), first)
  fs.utimesSync(path, 1, 1)
  fs.writeFileSync(path, skillMd('Name', 'Other'))
  fs.utimesSync(path, 1, 1)
  const edited = documents.stamp('note')
  assert.notEqual(edited, first)
  const other = join(skillsDir, 'old-note')
  fs.renameSync(folder('note'), other)
  fs.renameSync(join(other, 'SKILL.md'), join(folder('note'), 'SKILL.md'))
  const replaced = documents.stamp('note')
  assert.notEqual(replaced, edited)
  assert.equal(documents.get('note').documentRevision, replaced)
})

test('a mid-read native replacement and a changed configured root fail revalidation', t => {
  const { documents, put, dir, dataDir } = sandbox(t)
  const path = put('note', skillMd('Name', 'Old note'))
  let changed = false
  watchDocumentReads(path, () => fails('skill_unsupported', () => documents.get('note')), () => {
    if (changed) return
    changed = true
    fs.renameSync(path, join(dir, 'old-note'))
    put('note', skillMd('Name', 'Replacement'))
  })
  assert.equal(documents.get('note').instructions, 'Replacement')
  fs.renameSync(dataDir, join(dir, 'old-data'))
  put('note', skillMd('Other native root'))
  fails('skill_unsupported', () => documents.get('note'))
  const replacement = openSkillDocuments({ dataDir })
  t.after(() => replacement.close())
  assert.equal(replacement.get('note').name, 'Other native root')
})

test('native ancestor swaps and permission changes during reads give fixed errors', async t => {
  const changes = [
    ['skills root', ({ dir, skillsDir, put }) => {
      fs.renameSync(skillsDir, join(dir, 'old-skills'))
      put('note', skillMd('New skills root'))
    }],
    ['direct skill directory', ({ dir, folder, put }) => {
      fs.renameSync(folder('note'), join(dir, 'old-directory'))
      put('note', skillMd('New directory'))
    }],
    ['configured root', ({ dir, dataDir, put }) => {
      fs.renameSync(dataDir, join(dir, 'old-root'))
      put('note', skillMd('New root'))
    }],
    ['document mode', (_fixture, path) => fs.chmodSync(path, 0o666)]
  ]
  for (const [label, change] of changes) {
    await t.test(label, child => {
      const fixture = sandbox(child)
      const path = fixture.put('note', skillMd('Origin'))
      watchDocumentReads(path, () => fails('skill_unsupported', () => fixture.documents.get('note')), () => change(fixture, path))
    })
  }
})

test('old-kernel synthetic directory birthtime survives unrelated native writes', t => {
  const { documents, dir, dataDir, put } = sandbox(t)
  const path = put('stable', skillMd('Stable'))
  const fstat = fs.fstatSync
  fs.fstatSync = function (...args) {
    const info = fstat.apply(this, args)
    if (info.isDirectory() && typeof info.ctimeNs === 'bigint') info.birthtimeNs = info.ctimeNs
    return info
  }
  syncBuiltinESMExports()
  try {
    const before = documents.stamp('stable')
    fs.writeFileSync(join(dataDir, 'config.json'), '{}')
    assert.equal(documents.stamp('stable'), before)
    watchDocumentReads(path, () => {
      assert.equal(documents.list().find(item => item.id === 'stable').documentRevision, before)
    }, () => {
      fs.writeFileSync(join(dir, 'unrelated-ancestor-sibling'), '')
      fs.writeFileSync(join(dataDir, 'config-next.json'), '{}')
    })
  } finally { fs.fstatSync = fstat; syncBuiltinESMExports() }
})

test('the canonical root descriptor is lazy, singular, and released by idempotent close', t => {
  const { documents, dataDir, put } = sandbox(t)
  const root = fs.statSync(dataDir, { bigint: true })
  const rootFds = () => fs.readdirSync('/proc/self/fd').filter(fd => {
    try {
      const info = fs.statSync(`/proc/self/fd/${fd}`, { bigint: true })
      return info.dev === root.dev && info.ino === root.ino
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return false
    }
  }).length
  const initial = rootFds()
  assert.equal(documents.get('create-skill').detail, 'builtin')
  assert.equal(rootFds(), initial)
  put('note', '---\nunterminated')
  fails('skill_unsupported', () => documents.get('note'))
  assert.equal(rootFds(), initial)
  put('note', skillMd('Ordinary'))
  assert.equal(documents.get('note').name, 'Ordinary')
  assert.equal(rootFds(), initial + 1)
  documents.list()
  documents.stamps()
  assert.equal(rootFds(), initial + 1)
  documents.close()
  documents.close()
  assert.equal(rootFds(), initial)
  for (const action of [() => documents.get('create-skill'), () => documents.stamp('create-skill'),
    () => documents.list(), () => documents.stamps()]) fails('skill_unsupported', action)
})

test('bounds cover foreign entries, documents, header bytes, and aggregate stat size', t => {
  const { documents, put, folder, skillsDir } = sandbox(t)
  const header = put('large-header', `---\nname: ${'x'.repeat(16 * 1024)}\n---\nSmall body.`)
  assert.match(documents.stamp('large-header'), revision)
  fails('skill_limit', () => documents.list())
  fails('skill_limit', () => documents.get('large-header'))
  fs.truncateSync(header, 128 * 1024 + 1)
  fails('skill_limit', () => documents.stamp('large-header'))
  fs.unlinkSync(header)
  for (let i = 0; i < 33; i++) fs.truncateSync(put(`aggregate-${i}`, skillMd('Name')), 128 * 1024)
  fails('skill_limit', () => documents.stamps())
  for (let i = 0; i < 33; i++) fs.unlinkSync(join(folder(`aggregate-${i}`), 'SKILL.md'))
  for (let i = 0; i < 129; i++) put(`visible-${i}`, '')
  fails('skill_limit', () => documents.stamps())
  for (let i = 0; i < 352; i++) fs.writeFileSync(join(skillsDir, `.foreign-${i}`), '')
  fails('skill_limit', () => documents.stamp('missing'))
})
