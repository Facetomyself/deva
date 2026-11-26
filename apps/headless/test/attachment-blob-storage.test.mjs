import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { blobPart, createTurnMedia, desktopBlob, digestBytes } from '../src/chat/turn-attachments-media.mjs'

const linux = { skip: process.platform !== 'linux' }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const entryFor = (bytes, blob = sha(bytes.toString('base64'))) => ({ blob, sha256: sha(bytes), size: bytes.length })

function fixture(t, initialize = true) {
  const root = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'deva-attachment-blob-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'app')
  const data = join(home, 'data')
  const media = join(data, 'media')
  fs.mkdirSync(initialize ? media : home, { mode: 0o700, recursive: true })
  return { root, home, data, media, file: entry => join(media, entry.blob), store: createTurnMedia(home) }
}

// Position filesystem changes at a real syscall boundary without racing the test scheduler.
function hook(name, interceptor, action) {
  const original = fs[name]
  fs[name] = (...args) => interceptor(original, ...args)
  syncBuiltinESMExports()
  try { return action() } finally { fs[name] = original; syncBuiltinESMExports() }
}

test('legacy Desktop-binary and domain-separated text names retain their raw file formats', linux, t => {
  const { home, data, media, file, store } = fixture(t)
  for (const dir of [home, data, media]) fs.chmodSync(dir, 0o755)
  const binary = Buffer.from([0, 1, 2, 128, 255])
  const part = { type: 'image', data: binary.toString('base64'), mediaType: 'image/png' }
  const ref = { type: 'image', mediaType: 'image/png', name: 'saved.png', blob: sha(part.data) }
  assert.deepEqual(desktopBlob(part, 'saved.png', binary), ref)
  assert.deepEqual(blobPart({ kind: 'image', mime: ref.mediaType, name: ref.name, blob: ref.blob }), ref)
  const binaryEntry = entryFor(binary, ref.blob)
  fs.writeFileSync(file(binaryEntry), binary, { mode: 0o644 })
  fs.chmodSync(file(binaryEntry), 0o644)
  const before = fs.statSync(file(binaryEntry), { bigint: true })
  assert.equal(store.available([binaryEntry]), true)
  assert.deepEqual(store.read(binaryEntry, true), binary)
  assert.equal(store.write(binaryEntry, binary), undefined)
  const after = fs.statSync(file(binaryEntry), { bigint: true })
  assert.deepEqual([after.ino, after.mode, after.mtimeNs], [before.ino, before.mode, before.mtimeNs])

  const text = Buffer.from('\uFEFF附件\r\ncontent')
  const textRef = { type: 'text', name: 'notes.txt', blob: sha(Buffer.concat([Buffer.from('deva text attachment\0'), text])) }
  const textEntry = entryFor(text, textRef.blob)
  assert.deepEqual(desktopBlob({ type: 'text', text: 'wire text' }, 'notes.txt', text), textRef)
  assert.deepEqual(blobPart({ kind: 'text', name: textRef.name, mime: 'text/plain', blob: textRef.blob }), textRef)
  assert.equal(digestBytes(text), textEntry.sha256)
  store.write(textEntry, new Uint8Array(text))
  assert.deepEqual(fs.readFileSync(file(textEntry)), text)
  assert.deepEqual(createTurnMedia(home).read(textEntry), text)
  assert.equal(fs.statSync(file(textEntry)).mode & 0o777, 0o600)
  assert.equal(fs.statSync(file(textEntry)).nlink, 1)
  assert.deepEqual(fs.readdirSync(media).sort(), [binaryEntry.blob, textEntry.blob].sort())
})

test('availability reads in bounded chunks and memoizes only an exact file revision', linux, t => {
  const { data, file, store } = fixture(t, false)
  const bytes = Buffer.alloc(180_003, 0x42)
  const entry = entryFor(bytes)
  assert.equal(store.available([]), true)
  assert.equal(store.available([entry]), false)
  assert.equal(fs.existsSync(data), false)
  store.write(entry, bytes)
  const target = fs.statSync(file(entry)).ino
  let traversed = 0
  hook('readSync', (original, fd, buffer, start, count, offset) => {
    const result = original(fd, buffer, start, count, offset)
    if (fs.fstatSync(fd).ino === target) {
      assert.ok(buffer.length <= 64 * 1024)
      traversed += result
    }
    return result
  }, () => {
    assert.equal(store.available([entry]), true)
    assert.equal(traversed, bytes.length)
    assert.equal(store.available([entry]), true)
  })
  assert.equal(traversed, bytes.length)
  traversed = 0
  hook('readSync', (original, fd, ...args) => {
    const result = original(fd, ...args)
    if (fs.fstatSync(fd).ino === target) traversed += result
    return result
  }, () => assert.deepEqual(store.read(entry), bytes))
  assert.equal(traversed, bytes.length)
  fs.writeFileSync(file(entry), Buffer.alloc(bytes.length, 0x43))
  assert.equal(store.available([entry]), false)
  assert.throws(() => store.read(entry), /Unconfirmed attachment blob/)
  assert.throws(() => store.write(entry, bytes), /Unconfirmed attachment blob/)
  assert.deepEqual(fs.readFileSync(file(entry)), Buffer.alloc(bytes.length, 0x43))
  assert.equal(fs.statSync(file(entry)).ino, target)
})

test('invalid size, supplied SHA, and names cannot create directories or clobber a valid blob', linux, t => {
  const { data, media, file, store } = fixture(t, false)
  const bytes = Buffer.from('verified')
  const entry = entryFor(bytes)
  const invalid = [
    { ...entry, size: entry.size + 1 }, { ...entry, sha256: '1'.repeat(64) },
    { ...entry, blob: `../${entry.blob}` }, { ...entry, blob: `${entry.blob}\n` }, { ...entry, blob: entry.blob.toUpperCase() },
  ]
  for (const item of invalid) assert.throws(() => store.write(item, bytes), /Unconfirmed attachment blob/)
  assert.equal(fs.existsSync(data), false)
  store.write(entry, bytes)
  const before = fs.statSync(file(entry)).ino
  for (const item of invalid) {
    assert.equal(store.available([item]), false)
    assert.throws(() => store.read(item), /Unconfirmed attachment blob/)
    assert.throws(() => store.write(item, bytes), /Unconfirmed attachment blob/)
  }
  assert.throws(() => store.write(entry, Buffer.from('VERIFIED')), /Unconfirmed attachment blob/)
  assert.equal(fs.statSync(file(entry)).ino, before)
  assert.deepEqual(fs.readFileSync(file(entry)), bytes)
  assert.deepEqual(fs.readdirSync(media), [entry.blob])
})

test('symlink, external hardlink, and unsafe permissions are rejected with no changes to the original', linux, t => {
  const { root, home, data, media, file, store } = fixture(t)
  const bytes = Buffer.from('same bytes in a separate file')
  const entry = entryFor(bytes)
  const external = join(root, 'external')
  fs.writeFileSync(external, bytes, { mode: 0o600 })
  const ino = fs.statSync(external).ino
  const reject = () => {
    assert.equal(store.available([entry]), false)
    assert.throws(() => store.read(entry))
    assert.throws(() => store.write(entry, bytes))
    assert.equal(fs.statSync(external).ino, ino)
    assert.deepEqual(fs.readFileSync(external), bytes)
  }
  fs.symlinkSync(external, file(entry))
  reject()
  assert.equal(fs.readlinkSync(file(entry)), external)
  fs.unlinkSync(file(entry))
  fs.linkSync(external, file(entry))
  reject()
  assert.equal(fs.statSync(external).nlink, 2)
  assert.deepEqual(fs.readdirSync(media), [entry.blob])
  fs.unlinkSync(file(entry))
  fs.writeFileSync(file(entry), bytes, { mode: 0o600 })
  for (const [path, mode, restored] of [[home, 0o770, 0o700], [data, 0o777, 0o700], [media, 0o1777, 0o700],
    [file(entry), 0o660, 0o600], [file(entry), 0o606, 0o600], [file(entry), 0o700, 0o600]]) {
    fs.chmodSync(path, mode)
    reject()
    fs.chmodSync(path, restored)
  }
  assert.equal(store.available([entry]), true)
})

test('symlinked application and intermediate directories never serve as blob roots', linux, t => {
  const { root, home, data, media, file, store } = fixture(t)
  const bytes = Buffer.from('symlink directory check')
  const entry = entryFor(bytes)
  fs.writeFileSync(file(entry), bytes)
  for (const [i, directory] of [home, data, media].entries()) {
    const alias = join(root, `moved-${i}`)
    fs.renameSync(directory, alias)
    fs.symlinkSync(alias, directory)
    assert.equal(store.available([entry]), false)
    assert.throws(() => store.read(entry))
    assert.throws(() => store.write(entry, bytes))
    fs.unlinkSync(directory)
    fs.renameSync(alias, directory)
    assert.deepEqual(fs.readFileSync(file(entry)), bytes)
  }
})

test('a changed mount ID fails closed even when the directory device and inode match', linux, t => {
  const { media, file, store } = fixture(t)
  const bytes = Buffer.from('match the pinned mount')
  const entry = entryFor(bytes)
  fs.writeFileSync(file(entry), bytes)
  const directory = fs.statSync(media)
  let sightings = 0
  // Keep the inode checks on the real filesystem and simulate only the fdinfo mount
  // ID change; a real bind mount requires CAP_SYS_ADMIN.
  hook('readFileSync', (original, path, ...args) => {
    const result = original(path, ...args)
    const fdInfo = typeof path === 'string' && /^\/proc\/self\/fdinfo\/(\d+)$/.exec(path)
    if (!fdInfo) return result
    const probe = fs.fstatSync(Number(fdInfo[1]))
    if (probe.dev !== directory.dev || probe.ino !== directory.ino || ++sightings === 1) return result
    return result.replace(/^mnt_id:\s+(\d+)$/m, (_, id) => `mnt_id:\t${BigInt(id) + 1n}`)
  }, () => assert.equal(store.available([entry]), false))
  assert.equal(sightings, 2)
  assert.deepEqual(store.read(entry), bytes)
})

for (const label of ['home', 'data', 'media']) {
  test(`write detects ${label} replacement after staging and cleans only its pinned directory`, linux, t => {
    const fx = fixture(t)
    const bytes = Buffer.from('publish only in original live dir')
    const entry = entryFor(bytes)
    const alternate = join(fx.root, `${label}-renamed`)
    const directory = fx[label]
    const movedMedia = join(alternate, label === 'home' ? 'data/media' : label === 'data' ? 'media' : '.')
    let switched = false
    hook('fsyncSync', (original, fd) => {
      const result = original(fd)
      if (!switched && fs.fstatSync(fd).isFile()) {
        switched = true
        fs.renameSync(directory, alternate)
        fs.mkdirSync(fx.media, { recursive: true, mode: 0o700 })
        fs.writeFileSync(join(fx.media, 'sentinel'), bytes)
      }
      return result
    }, () => assert.throws(() => fx.store.write(entry, bytes), /Unconfirmed attachment blob/))
    assert.equal(switched, true)
    assert.deepEqual(fs.readdirSync(fx.media), ['sentinel'])
    assert.deepEqual(fs.readFileSync(join(fx.media, 'sentinel')), bytes)
    assert.deepEqual(fs.readdirSync(movedMedia), [])
  })
}

test('a read never accepts a replacement inode even when the name and bytes are identical', linux, t => {
  const { root, file, store } = fixture(t)
  const bytes = Buffer.from('verified file identity')
  const entry = entryFor(bytes)
  for (const [i, read] of [() => assert.throws(() => store.read(entry)), () => assert.equal(store.available([entry]), false)].entries()) {
    fs.writeFileSync(file(entry), bytes)
    const ino = fs.statSync(file(entry)).ino
    const alternate = join(root, `previous-${i}`)
    let replaced = false
    hook('readSync', (original, fd, ...args) => {
      const result = original(fd, ...args)
      if (!replaced && fs.fstatSync(fd).ino === ino) {
        replaced = true
        fs.renameSync(file(entry), alternate)
        fs.writeFileSync(file(entry), bytes, { mode: 0o600 })
      }
      return result
    }, read)
    assert.equal(replaced, true)
    assert.equal(fs.statSync(alternate).ino, ino)
    assert.notEqual(fs.statSync(file(entry)).ino, ino)
  }
})

test('no-clobber publication preserves competing inodes and removes our staging file', linux, t => {
  const { media, file, store } = fixture(t)
  for (const valid of [true, false]) {
    const bytes = Buffer.from(`incoming-${valid}`)
    const entry = entryFor(bytes)
    const other = valid ? bytes : Buffer.alloc(bytes.length, 0x41)
    let inode
    hook('linkSync', (original, source, target) => {
      fs.writeFileSync(target, other, { flag: 'wx', mode: 0o600 })
      inode = fs.statSync(target).ino
      return original(source, target)
    }, () => {
      if (valid) store.write(entry, bytes)
      else assert.throws(() => store.write(entry, bytes), /Unconfirmed attachment blob/)
    })
    assert.ok(Number.isSafeInteger(inode))
    assert.equal(fs.statSync(file(entry)).ino, inode)
    assert.deepEqual(fs.readFileSync(file(entry)), other)
    assert.equal(fs.statSync(file(entry)).nlink, 1)
    assert.ok(fs.readdirSync(media).every(name => /^[0-9a-f]{64}$/.test(name)))
  }
})

test('exclusive staging never opens or cleans an existing temporary name', linux, t => {
  const { media, file, store } = fixture(t)
  const bytes = Buffer.from('incoming stage')
  const entry = entryFor(bytes)
  const originalBytes = Buffer.from('reserved stage')
  let stage
  hook('openSync', (original, path, flags, mode) => {
    if (!stage && typeof path === 'string' && path.endsWith('.tmp')) {
      stage = join(media, path.split('/').at(-1))
      fs.writeFileSync(stage, originalBytes, { flag: 'wx', mode: 0o600 })
    }
    return original(path, flags, mode)
  }, () => assert.throws(() => store.write(entry, bytes), { code: 'EEXIST' }))
  assert.equal(fs.existsSync(file(entry)), false)
  assert.deepEqual(fs.readFileSync(stage), originalBytes)
  assert.deepEqual(fs.readdirSync(media), [stage.split('/').at(-1)])
})

test('a swapped staging name is never cleaned as if it still named the creating FD', linux, t => {
  const { root, media, file, store } = fixture(t)
  const bytes = Buffer.from('staged bytes')
  const entry = entryFor(bytes)
  const originalPath = join(root, 'moved-stage')
  const replacement = Buffer.from('replacement')
  let stage
  hook('fsyncSync', (original, fd) => {
    const result = original(fd)
    if (!stage && fs.fstatSync(fd).isFile()) {
      const [name] = fs.readdirSync(media)
      assert.match(name, /\.tmp$/)
      stage = join(media, name)
      fs.renameSync(stage, originalPath)
      fs.writeFileSync(stage, replacement, { mode: 0o600 })
    }
    return result
  }, () => assert.throws(() => store.write(entry, bytes), /Unconfirmed attachment blob/))
  assert.equal(fs.existsSync(file(entry)), false)
  assert.deepEqual(fs.readFileSync(originalPath), bytes)
  assert.deepEqual(fs.readFileSync(stage), replacement)
  assert.deepEqual(fs.readdirSync(media), [stage.split('/').at(-1)])
})

test('two real processes staging identical bytes both complete with one published inode', { ...linux, timeout: 8_000 }, async t => {
  const { home, media, file, store } = fixture(t)
  const bytes = Buffer.from('shared concurrent publication')
  const entry = entryFor(bytes)
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { createTurnMedia } from ${JSON.stringify(new URL('../src/chat/turn-attachments-media.mjs', import.meta.url).href)};
    const [home, entryJSON, hex] = process.argv.slice(1);
    const realLink = fs.linkSync;
    fs.linkSync = (...args) => {
      fs.writeSync(1, 'ready\\n');
      if (fs.readSync(0, Buffer.alloc(1), 0, 1, null) !== 1) throw Error('Barrier closed');
      return realLink(...args);
    };
    syncBuiltinESMExports();
    createTurnMedia(home).write(JSON.parse(entryJSON), Buffer.from(hex, 'hex'));
  `
  function contender() {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, home, JSON.stringify(entry), bytes.toString('hex')],
      { stdio: 'pipe', timeout: 5_000, killSignal: 'SIGKILL' })
    let output = '', errors = ''
    const ready = Promise.withResolvers()
    const closed = Promise.withResolvers()
    child.stdout.on('data', chunk => { output += chunk; if (output === 'ready\n') ready.resolve() })
    child.stderr.on('data', chunk => { errors += chunk })
    child.on('error', err => { ready.reject(err); closed.resolve({ code: null, errors: String(err) }) })
    child.on('close', (code, signal) => {
      if (output !== 'ready\n') ready.reject(new Error(errors || `Contender quit before staging (${code ?? signal})`))
      closed.resolve({ code, errors })
    })
    return { child, ready: ready.promise, closed: closed.promise }
  }
  const workers = [contender(), contender()]
  try {
    await Promise.all(workers.map(proc => proc.ready))
    assert.equal(fs.readdirSync(media).filter(name => name.endsWith('.tmp')).length, 2)
    for (const { child } of workers) child.stdin.end('!')
    assert.deepEqual(await Promise.all(workers.map(proc => proc.closed)), [{ code: 0, errors: '' }, { code: 0, errors: '' }])
  } finally {
    for (const { child } of workers) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await Promise.all(workers.map(proc => proc.closed))
  }
  assert.deepEqual(fs.readdirSync(media), [entry.blob])
  assert.equal(fs.statSync(file(entry)).nlink, 1)
  assert.deepEqual(store.read(entry), bytes)
})
