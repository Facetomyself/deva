import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { crc32, deflateSync } from 'node:zlib'
import { inspectGit } from '../src/git/inspect.mjs'

const REG = 0o100644, EXEC = 0o100755, LINK = 0o120000, SUBMODULE = 0o160000
const SHA = value => createHash('sha1').update(value).digest()
const objectPath = oid => `objects/${oid.slice(0, 2)}/${oid.slice(2)}`
const when = 1712345678

function realIndex(items, { version = 2, extensions = [] } = {}) {
  const sorted = [...items].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)) || (a.stage ?? 0) - (b.stage ?? 0))
  const header = Buffer.alloc(12)
  header.write('DIRC')
  header.writeUInt32BE(version, 4)
  header.writeUInt32BE(items.length, 8)
  const entries = sorted.map(({ path, oid, mode = REG, stage = 0, extended }) => {
    const raw = Buffer.from(path), prefix = extended === undefined ? 62 : 64
    const bytes = Buffer.alloc(Math.ceil((prefix + raw.length + 1) / 8) * 8)
    bytes.writeUInt32BE(mode, 24)
    Buffer.from(oid, 'hex').copy(bytes, 40)
    bytes.writeUInt16BE(Math.min(raw.length, 0xfff) | (stage << 12) | (extended === undefined ? 0 : 0x4000), 60)
    if (extended !== undefined) bytes.writeUInt16BE(extended, 62)
    raw.copy(bytes, prefix)
    return bytes
  })
  const extra = extensions.map(([signature, body]) => {
    const header = Buffer.alloc(8)
    header.write(signature)
    header.writeUInt32BE(body.length, 4)
    return Buffer.concat([header, body])
  })
  const bytes = Buffer.concat([header, ...entries, ...extra])
  return Buffer.concat([bytes, SHA(bytes)])
}

function realPack(objects) {
  const header = Buffer.alloc(12)
  header.write('PACK')
  header.writeUInt32BE(2, 4)
  header.writeUInt32BE(objects.size, 8)
  let offset = header.length
  const values = { commit: 1, tree: 2, blob: 3 }
  const indexRows = []
  const entries = []
  for (const [oid, { type, bytes }] of objects) {
    let remaining = bytes.length >>> 4
    const descriptor = [(values[type] << 4) | (bytes.length & 15) | (remaining ? 128 : 0)]
    while (remaining) {
      const part = remaining & 127
      remaining >>>= 7
      descriptor.push(part | (remaining ? 128 : 0))
    }
    const packed = Buffer.concat([Buffer.from(descriptor), deflateSync(bytes)])
    entries.push(packed)
    indexRows.push({ oid: Buffer.from(oid, 'hex'), offset, crc: crc32(packed) })
    offset += packed.length
  }
  const packData = Buffer.concat([header, ...entries])
  const key = SHA(packData)
  const idx = Buffer.alloc(1032 + 28 * indexRows.length)
  idx.writeUInt32BE(0xff744f63)
  idx.writeUInt32BE(2, 4)
  indexRows.sort((a, b) => Buffer.compare(a.oid, b.oid))
  let found = 0
  for (let byte = 0; byte < 256; byte++) {
    while (found < indexRows.length && indexRows[found].oid[0] <= byte) found++
    idx.writeUInt32BE(found, 8 + byte * 4)
  }
  for (const [at, { oid, crc, offset }] of indexRows.entries()) {
    oid.copy(idx, 1032 + at * 20)
    idx.writeUInt32BE(crc, 1032 + indexRows.length * 20 + 4 * at)
    idx.writeUInt32BE(offset, 1032 + indexRows.length * 24 + 4 * at)
  }
  const idxData = Buffer.concat([idx, key])
  return {
    filename: `objects/pack/pack-${key.toString('hex')}`,
    pack: Buffer.concat([packData, key]),
    idx: Buffer.concat([idxData, SHA(idxData)]),
  }
}

function repo() {
  const meta = new Map([['HEAD', Buffer.from('ref: refs/heads/main\n')]])
  const work = new Map(), workReads = [], metaReads = [], objects = new Map()
  const io = {
    state: 'ready',
    readMeta(path, limit) {
      metaReads.push(path)
      if (path === 'config' || path === 'config.worktree' || path.includes('hooks/')) assert.fail(`unexpected read: ${path}`)
      const bytes = meta.get(path) ?? null
      if (bytes && bytes.length > limit) throw Object.assign(Error('git_limit'), { code: 'git_limit' })
      return bytes
    },
    listMeta(path, max) {
      const entries = new Map()
      for (const key of meta.keys()) {
        if (!key.startsWith(`${path}/`)) continue
        const [name, ...rest] = key.slice(path.length + 1).split('/')
        entries.set(name, { name, type: rest.length ? 'dir' : 'file' })
      }
      if (entries.size > max) throw Object.assign(Error('git_limit'), { code: 'git_limit' })
      return [...entries.values()]
    },
    marker(path) { return meta.has(path) },
    workFile(path, max) {
      workReads.push(path)
      const value = work.get(path) ?? { state: 'missing' }
      if (value.state === 'regular' && value.bytes.length > max) return { state: 'too_large' }
      return value
    },
  }
  function object(type, data) {
    const bytes = Buffer.from(data)
    const raw = Buffer.concat([Buffer.from(`${type} ${bytes.length}\0`), bytes])
    const oid = SHA(raw).toString('hex')
    objects.set(oid, { type, bytes })
    meta.set(objectPath(oid), deflateSync(raw))
    return oid
  }
  return {
    io, meta, work, workReads, metaReads,
    blob: value => object('blob', value),
    tree(entries) {
      const rows = [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
      return object('tree', Buffer.concat(rows.flatMap(({ path, oid, mode = REG }) => [
        Buffer.from(`${mode.toString(8)} `), Buffer.from(path), Buffer.from([0]), Buffer.from(oid, 'hex'),
      ])))
    },
    commit(tree, { parents = [], message = 'Subject\n\nUnreviewed body', author = 'Ada Test', timestamp = when } = {}) {
      return object('commit', `tree ${tree}\n${parents.map(oid => `parent ${oid}\n`).join('')}author ${author} <author@example.test> ${timestamp} +0530\ncommitter Hidden Person <committer@example.test> ${timestamp + 1} +0000\n\n${message}\n`)
    },
    index(items, options) { meta.set('index', realIndex(items, options)) },
    setWork(path, bytes, executable = false) { work.set(path, { state: 'regular', bytes: Buffer.from(bytes), executable }) },
    head(oid) { meta.set('refs/heads/main', Buffer.from(`${oid}\n`)) },
    remove(oid) { meta.delete(objectPath(oid)) },
    pack() {
      const { filename, pack, idx } = realPack(objects)
      for (const oid of objects.keys()) meta.delete(objectPath(oid))
      meta.set(`${filename}.idx`, idx)
      meta.set(`${filename}.pack`, pack)
    },
  }
}

function status(repo) { return inspectGit(repo.io, { op: 'status' }) }
function diff(repo, view, rel, side) {
  return inspectGit(repo.io, { op: 'diff', expectedFingerprint: view.fingerprint, rel, side })
}
function changedText(result) {
  return result.lines.filter(row => row.type === 'del' || row.type === 'add').map(row => [row.type, row.text])
}

function basic(old, staged = old, working = staged) {
  const fixture = repo()
  const base = fixture.blob(old), next = fixture.blob(staged)
  const tree = fixture.tree([{ path: 'readme.txt', oid: base }])
  const head = fixture.commit(tree)
  fixture.head(head)
  fixture.index([{ path: 'readme.txt', oid: next }])
  fixture.setWork('readme.txt', working)
  return { fixture, head, tree, base, next }
}

test('real SHA-1 status distinguishes staged and raw worktree changes, mode, add and deletes', () => {
  const r = repo()
  const prior = r.blob('lead\nold\nend\n'), next = r.blob('lead\nstaged\nend\n'), other = r.blob('same\n')
  const empty = r.blob(''), sym = r.blob('/private-target'), newer = r.blob('regular\n')
  const path = (path, oid, mode) => ({ path, oid, mode })
  const head = r.commit(r.tree([path('readme.txt', prior), path('staged-deleted.txt', other), path('removed.txt', other),
    path('mode.sh', other), path('type-change', sym, LINK), path('hidden-link', sym, LINK), path('hidden-submodule', prior, SUBMODULE),
    path('.gitignore', other), path('config', r.tree([path('apiKeys.json', other)]), 0o040000),
    path(Buffer.from([0x80, 0xff]), other)]))
  r.head(head)
  r.index([path('readme.txt', next), path('removed.txt', other), path('mode.sh', other), path('type-change', newer),
    path('hidden-link', sym, LINK), path('hidden-submodule', prior, SUBMODULE), path('.gitignore', other),
    path('config/apiKeys.json', other), path(Buffer.from([0x80, 0xff]), other), path('added.txt', empty)])
  r.setWork('readme.txt', 'lead\nworking\nend\n')
  r.setWork('mode.sh', 'same\n', true)
  r.setWork('type-change', 'regular\n')
  r.setWork('staged-deleted.txt', 'untracked different replacement')
  r.setWork('untracked-now.txt', 'never read')
  r.setWork('added.txt', '')
  const view = status(r)
  assert.equal(view.state, 'ready')
  assert.match(view.fingerprint, /^[0-9a-f]{64}$/)
  assert.equal(view.branch, 'main')
  assert.deepEqual(view.entries, [
    { rel: 'added.txt', staged: 'A', worktree: null, conflicted: false, diffSides: ['staged'] },
    { rel: 'mode.sh', staged: null, worktree: 'M', conflicted: false, diffSides: ['worktree'] },
    { rel: 'readme.txt', staged: 'M', worktree: 'M', conflicted: false, diffSides: ['staged', 'worktree'] },
    { rel: 'removed.txt', staged: null, worktree: 'D', conflicted: false, diffSides: ['worktree'] },
    { rel: 'staged-deleted.txt', staged: 'D', worktree: null, conflicted: false, diffSides: ['staged'] },
    { rel: 'type-change', staged: 'T', worktree: null, conflicted: false, diffSides: [] },
  ])
  assert.deepEqual(r.workReads, ['added.txt', 'mode.sh', 'readme.txt', 'removed.txt', 'type-change'])
  assert.ok(view.limitations.includes('tracked_only'))
  assert.ok(view.limitations.includes('excluded_paths'))
  assert.ok(view.limitations.includes('non_regular_entries'))
  assert.deepEqual(changedText(diff(r, view, 'readme.txt', 'staged')), [['del', 'old'], ['add', 'staged']])
  assert.deepEqual(changedText(diff(r, view, 'readme.txt', 'worktree')), [['del', 'staged'], ['add', 'working']])
  assert.deepEqual(diff(r, view, 'mode.sh', 'worktree').lines, [{ type: 'hunk', text: 'mode 100644 → 100755' }])
  assert.deepEqual(diff(r, view, 'added.txt', 'staged').lines, [{ type: 'hunk', text: 'Empty file added' }])
  assert.deepEqual(changedText(diff(r, view, 'removed.txt', 'worktree')), [['del', 'same']])
  const numbered = diff(r, view, 'readme.txt', 'staged').lines
  assert.deepEqual(numbered[0], { type: 'hunk', text: '@@ -1,3 +1,3 @@' })
  assert.deepEqual(numbered[2], { type: 'del', oldNo: 2, text: 'old' })
  assert.deepEqual(numbered[3], { type: 'add', newNo: 2, text: 'staged' })
})

test('real local and remote tracking refs, detached and unborn HEAD, and first-parent audit rows', () => {
  const r = repo()
  const unborn = status(r)
  assert.equal(unborn.state, 'ready')
  assert.equal(unborn.branch, 'main')
  assert.equal(unborn.unborn, true)
  assert.deepEqual(inspectGit(r.io, { op: 'log' }).commits, [])
  const tree = r.tree([])
  const root = r.commit(tree, { message: 'Public root' })
  const side = r.commit(tree, { message: 'Unvisited side', parents: [root] })
  const main = r.commit(tree, { message: 'Email someone@example.test with https://remote/pass /private/path', parents: [root] })
  const head = r.commit(tree, { message: 'Public merge\n\n/hidden/host/path', parents: [main, side] })
  r.head(head)
  r.meta.set('packed-refs', Buffer.from(`# pack-refs with: peeled sorted\n${side} refs/heads/side\n${root} refs/remotes/origin/main\n`))
  r.meta.set('refs/remotes/origin/HEAD', Buffer.from('ref: refs/remotes/origin/main\n'))
  assert.deepEqual(inspectGit(r.io, { op: 'branches' }), {
    state: 'ready', branch: 'main', detached: false, unborn: false, limitations: ['upstream_unknown'],
    branches: [
      { name: 'main', current: true, remote: null }, { name: 'side', current: false, remote: null },
      { name: 'origin/main', current: false, remote: 'origin' },
    ],
  })
  const log = inspectGit(r.io, { op: 'log', limit: 1000, oid: side })
  assert.equal(log.traversal, 'first-parent')
  assert.equal(log.more, false)
  assert.deepEqual(log.commits, [
    { oid: head, short: head.slice(0, 7), subject: 'Public merge', author: 'Ada Test', timestamp: when },
    { oid: main, short: main.slice(0, 7), subject: '', author: 'Ada Test', timestamp: when },
    { oid: root, short: root.slice(0, 7), subject: 'Public root', author: 'Ada Test', timestamp: when },
  ])
  assert.equal(inspectGit(r.io, { op: 'log', limit: 1 }).more, true)
  assert.equal(r.metaReads.includes(objectPath(side)), false)
  r.meta.set('HEAD', Buffer.from(`${head}\n`))
  assert.equal(status(r).detached, true)
  assert.equal(inspectGit(r.io, { op: 'log' }).branch, null)
  assert.equal(inspectGit(r.io, { op: 'branches' }).branches.some(row => row.current), false)
  r.meta.set('shallow', Buffer.from(`${head}\n`))
  const shallow = inspectGit(r.io, { op: 'log' })
  assert.deepEqual(shallow.commits.map(row => row.oid), [head])
  assert.equal(shallow.more, false)
  assert.ok(shallow.limitations.includes('shallow'))
})

test('v3 conflict, merge marker and intent-to-add; required extensions and checksum are rejected', () => {
  const r = repo()
  const a = r.blob('old\n'), b = r.blob('other\n'), empty = r.blob('')
  const head = r.commit(r.tree([{ path: 'merge.txt', oid: a }]))
  r.head(head)
  r.meta.set('MERGE_HEAD', Buffer.from(`${head}\n`))
  const items = [
    { path: 'merge.txt', oid: a, stage: 1 }, { path: 'merge.txt', oid: a, stage: 2 }, { path: 'merge.txt', oid: b, stage: 3 },
    { path: 'new.txt', oid: empty, extended: 0x2000 },
  ]
  r.index(items, { version: 3, extensions: [['FSMN', Buffer.from('ignored metadata')], ['TREE', Buffer.from('cache')]] })
  r.setWork('merge.txt', 'conflict body\n')
  r.setWork('new.txt', 'pending\n')
  const view = status(r)
  assert.equal(view.mergeInProgress, true)
  assert.deepEqual(view.entries, [
    { rel: 'merge.txt', staged: 'U', worktree: 'U', conflicted: true, diffSides: [] },
    { rel: 'new.txt', staged: null, worktree: 'A', conflicted: false, diffSides: ['worktree'] },
  ])
  assert.deepEqual(diff(r, view, 'merge.txt', 'staged').limitations, ['conflicted_entry'])
  assert.deepEqual(changedText(diff(r, view, 'new.txt', 'worktree')), [['add', 'pending']])
  for (const ext of ['link', 'sdir', 'abcd']) {
    r.index(items, { version: 3, extensions: [[ext, Buffer.alloc(0)]] })
    const unsupported = status(r)
    assert.equal(unsupported.state, 'unsupported_layout')
    assert.deepEqual(unsupported.entries, [])
  }
  r.index([{ path: 'sparse/', oid: a, mode: 0o040000 }])
  assert.equal(status(r).state, 'unsupported_layout')
  r.index([{ path: 'new.txt', oid: empty, extended: 0x4000 }], { version: 3 })
  assert.equal(status(r).state, 'unsupported_layout')
  r.index([], { version: 4 })
  assert.equal(status(r).state, 'unsupported_layout')
  const sha256Header = realIndex([]).subarray(0, 12)
  r.meta.set('index', Buffer.concat([sha256Header, createHash('sha256').update(sha256Header).digest()]))
  assert.equal(status(r).state, 'unsupported_layout')
  r.index([], { version: 3 })
  r.meta.get('index')[13] ^= 1
  assert.equal(status(r).state, 'unavailable')
  assert.ok(status(r).limitations.includes('index_invalid'))
})

test('pack-only repository after GC and explicit missing-object outcomes', () => {
  const { fixture: r } = basic('pre-GC\n', 'post-GC\n', 'post-GC\n')
  r.pack()
  const view = status(r)
  assert.equal(view.state, 'ready')
  assert.deepEqual(changedText(diff(r, view, 'readme.txt', 'staged')), [['del', 'pre-GC'], ['add', 'post-GC']])
  assert.equal(inspectGit(r.io, { op: 'log' }).commits.length, 1)

  const { fixture: missing, next, tree } = basic('base\n', 'changed\n')
  missing.remove(next)
  const missingBlob = diff(missing, status(missing), 'readme.txt', 'staged')
  assert.equal(missingBlob.state, 'unavailable')
  assert.deepEqual(missingBlob.limitations, ['missing_object'])
  missing.remove(tree)
  const missingTree = status(missing)
  assert.equal(missingTree.state, 'unavailable')
  assert.ok(missingTree.limitations.includes('missing_object'))
  const partial = repo()
  const emptyTree = partial.tree([])
  const parent = partial.commit(emptyTree)
  const child = partial.commit(emptyTree, { parents: [parent] })
  partial.head(child)
  partial.remove(parent)
  const log = inspectGit(partial.io, { op: 'log' })
  assert.equal(log.state, 'partial')
  assert.deepEqual(log.commits.map(commit => commit.oid), [child])
  assert.ok(log.limitations.includes('missing_object'))
})

test('diff preserves raw CRLF, leading BOM and final newline; blocks binary and obvious private keys', () => {
  const { fixture: raw } = basic('line\r\nend\n', '\uFEFFline\nend')
  const result = diff(raw, status(raw), 'readme.txt', 'staged')
  assert.deepEqual(changedText(result), [['del', 'line\r'], ['del', 'end'], ['add', '\uFEFFline'], ['add', 'end']])
  assert.ok(result.lines.some(row => row.text === '\\ No newline at end of file'))
  const { fixture: binary } = basic('old\n', Buffer.from([0x00, 0x01, 0xff]))
  const hiddenBinary = diff(binary, status(binary), 'readme.txt', 'staged')
  assert.equal(hiddenBinary.state, 'binary')
  assert.deepEqual(hiddenBinary.lines, [])
  const { fixture: key } = basic('# Example\n-----BEGIN OPENSSH PRIVATE KEY-----\nprivate\n', 'replacement\n')
  const secret = diff(key, status(key), 'readme.txt', 'staged')
  assert.equal(secret.state, 'unavailable')
  assert.deepEqual(secret.limitations, ['sensitive_content'])
  assert.deepEqual(secret.lines, [])
  const { fixture: repeated } = basic('---\n', '-'.repeat(200 * 1024))
  assert.equal(diff(repeated, status(repeated), 'readme.txt', 'staged').state, 'ready')
})

test('diff and worktree budgets are explicit; status never turns unread or untrusted files into clean rows', () => {
  const { fixture: big } = basic('old\n', 'x'.repeat(256 * 1024))
  assert.equal(diff(big, status(big), 'readme.txt', 'staged').state, 'too_large')
  const { fixture: many } = basic('old\n', 'new\n'.repeat(4001))
  assert.deepEqual(diff(many, status(many), 'readme.txt', 'staged').limitations, ['diff_line_limit'])
  const { fixture: costly } = basic('old\n'.repeat(1100), 'new\n'.repeat(1100))
  assert.deepEqual(diff(costly, status(costly), 'readme.txt', 'staged').limitations, ['diff_computation_limit'])
  const { fixture: output } = basic('old\n', 'new\n'.repeat(1200))
  const cut = diff(output, status(output), 'readme.txt', 'staged')
  assert.equal(cut.state, 'ready')
  assert.equal(cut.truncated, true)
  assert.equal(cut.lines.length, 1000)
  const { fixture: unread } = basic('old\n', 'next\n')
  unread.work.set('readme.txt', { state: 'unsafe' })
  const partial = status(unread)
  assert.equal(partial.state, 'partial')
  assert.deepEqual(partial.entries, [])
  assert.ok(partial.limitations.includes('unsafe_worktree'))
  unread.work.set('readme.txt', { state: 'too_large' })
  const stagedOnly = status(unread)
  assert.equal(stagedOnly.state, 'partial')
  assert.deepEqual(stagedOnly.entries[0].diffSides, ['staged'])
  assert.equal(diff(unread, stagedOnly, 'readme.txt', 'worktree').state, 'too_large')
})

test('fresh content is bound to expected status fingerprint, across path content, mode, index and HEAD', () => {
  const { fixture: r, next, tree } = basic('before\n', 'stage!\n', 'first!\n')
  const view = status(r)
  assert.equal(status(r).fingerprint, view.fingerprint)
  r.setWork('readme.txt', 'late!!\n')
  assert.throws(() => diff(r, view, 'readme.txt', 'worktree'), { code: 'git_stale' })
  const moved = status(r)
  r.setWork('readme.txt', 'late!!\n', true)
  assert.throws(() => diff(r, moved, 'readme.txt', 'staged'), { code: 'git_stale' })
  const mode = status(r)
  r.index([{ path: 'readme.txt', oid: next, mode: EXEC }])
  assert.throws(() => diff(r, mode, 'readme.txt', 'staged'), { code: 'git_stale' })
  const index = status(r)
  r.head(r.commit(tree, { message: 'Different HEAD, same tree' }))
  assert.throws(() => diff(r, index, 'readme.txt', 'staged'), { code: 'git_stale' })
  assert.throws(() => inspectGit(r.io, { op: 'diff', rel: 'readme.txt', side: 'staged' }), { code: 'git_stale' })
})

test('tree depth, index entries, serialized result size and history traversal are bounded', () => {
  const r = repo()
  const blob = r.blob('tracked\n')
  let tree = r.tree([{ path: 'readme.txt', oid: blob }])
  for (let i = 0; i < 16; i++) tree = r.tree([{ path: 'subdir', oid: tree, mode: 0o040000 }])
  r.head(r.commit(tree))
  const deep = status(r)
  assert.equal(deep.state, 'unavailable')
  assert.ok(deep.limitations.includes('head_tree_limit'))

  const many = repo()
  const leaf = many.blob('entry\n')
  many.index(Array.from({ length: 2001 }, (_, i) => ({ path: `file-${i}`, oid: leaf })))
  const tooMany = status(many)
  assert.equal(tooMany.state, 'unavailable')
  assert.ok(tooMany.limitations.includes('index_limit'))
  const long = Array.from({ length: 1000 }, (_, i) => ({ path: `${String(i).padStart(4, '0')}/${'a'.repeat(240)}/`.repeat(7) + 'file', oid: leaf }))
  many.index(long)
  const output = status(many)
  assert.equal(output.state, 'partial')
  assert.ok(output.entries.length < long.length)
  assert.ok(output.limitations.includes('status_output_limit'))

  const history = repo(), empty = history.tree([])
  let parent = history.commit(empty)
  for (let i = 0; i < 104; i++) parent = history.commit(empty, { parents: [parent], message: 'x'.repeat(200), author: 'a'.repeat(100) })
  history.head(parent)
  const log = inspectGit(history.io, { op: 'log', limit: 1000 })
  assert.equal(log.commits.length, 100)
  assert.equal(log.more, true)
  assert.equal(log.commits[0].author, 'a'.repeat(95) + '…')
  assert.equal(log.commits[0].subject, 'x'.repeat(159) + '…')
})

test('not-repo and unsupported layouts are distinct and perform zero reads', () => {
  for (const state of ['not_repo', 'unsupported_layout']) {
    const io = { state, readMeta() { assert.fail('unexpected metadata read') } }
    for (const op of ['branches', 'log', 'status']) assert.equal(inspectGit(io, { op }).state, state)
    const snapshot = inspectGit(io, { op: 'status' })
    assert.equal(inspectGit(io, { op: 'diff', rel: 'readme.txt', side: 'staged', expectedFingerprint: snapshot.fingerprint }).state, 'unavailable')
  }
})
