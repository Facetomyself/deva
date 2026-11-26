import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { renameSync, symlinkSync } from 'node:fs'
import { chmod, link, mkdir, mkdtemp, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openWorkspaceCatalog } from '../src/business/workspace-catalog.mjs'
import { openDeliveryFiles } from '../src/files/delivery-files.mjs'

const MiB = 1024 * 1024
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWNYZ/B3ncFfBggFADLGB23aTHV6AAAAAElFTkSuQmCC', 'base64')
const jpeg = Buffer.from('/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCMArpq/9k=', 'base64')
const webp = Buffer.from('UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAIAAUAmJaACdLoB+AADsAD+6mX//dk/2yf7ZP/eM/+cSx1O7tAAAAA=', 'base64')
const pdf = Buffer.from('%PDF-1.7\r%\xe2\xe3\xcf\xd3\n%%EOF\n', 'latin1')
const conflict = (root, leaf) => error => {
  assert.equal(error.code, 'ERR_DELIVERY_FILE_CONFLICT')
  assert.equal(error.status, 409)
  assert.equal(error.statusCode, 409)
  assert.equal(error.message.includes(root), false)
  if (leaf) assert.equal(error.message.includes(leaf), false)
  return true
}
const unavailable = (name, kind, size, status) => ({
  name, kind, size, status, revision: null, canDownload: false, canPreview: false, canLocate: false,
})

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'deva-native-deliveries-'))
  const root = join(base, 'granted')
  const alpha = join(root, 'alpha')
  const beta = join(root, 'beta')
  const outside = join(base, 'operator-private')
  await Promise.all([mkdir(alpha, { recursive: true }), mkdir(beta, { recursive: true }), mkdir(outside)])
  const catalog = openWorkspaceCatalog({ root, privateRoots: [outside] })
  const catalogId = name => catalog.list().find(item => item.name === name)?.id
  const cleanups = []
  t.after(async () => {
    catalog.close()
    for (const cleanup of cleanups) await cleanup()
    await rm(base, { recursive: true, force: true })
  })
  return { base, root, alpha, beta, outside, catalog, catalogId, cleanups, files: openDeliveryFiles({ catalog }) }
}

test('native delivery authorization uses the catalog ID and the literal project-relative name', async t => {
  const { files, catalog, catalogId, root, alpha, beta } = await fixture(t)
  const name = '分组 résumé "2026" 🧭.md'
  const path = `报告/${name}`
  const absolute = join(alpha, path)
  const other = join(beta, name)
  const bytes = Buffer.from('\ufeff# 交付\r\nplan: prête!\r\n')
  await mkdir(join(alpha, '报告'))
  await Promise.all([writeFile(absolute, bytes), writeFile(other, bytes)])
  const workspaceId = catalogId('alpha')
  assert.deepEqual(catalog.resolveDeliveryPath(absolute), { id: workspaceId, path })
  const item = await files.inspect(absolute)
  assert.match(item.revision, /^r_[0-9a-f]{64}$/u)
  assert.deepEqual(item, {
    name, kind: 'text', size: bytes.length, status: 'ready', revision: item.revision,
    canDownload: true, canPreview: false, canLocate: true,
  })
  assert.deepEqual(await files.inspect(absolute), item)
  assert.deepEqual(await files.read(absolute, item.revision, 'download'), { name, mime: 'text/plain', bytes })
  await assert.rejects(files.read(absolute, item.revision, 'preview'), { code: 'ERR_DELIVERY_FILE_UNSUPPORTED', status: 415 })
  assert.deepEqual(await files.locate(absolute, item.revision), { workspaceId, path })
  const betaItem = await files.inspect(other)
  assert.notEqual(betaItem.revision, item.revision)
  await assert.rejects(files.read(other, item.revision, 'download'), conflict(root, name))
  await assert.rejects(files.locate(other, item.revision), conflict(root, name))
  assert.deepEqual(await files.locate(other, betaItem.revision), { workspaceId: catalogId('beta'), path: name })
  await assert.rejects(files.read(absolute, `${item.revision.slice(0, -1)}g`, 'download'), { status: 400 })
  await assert.rejects(files.read(absolute, item.revision, 'inline'), { status: 400 })
})

test('strict raster previews retain original bytes, while PDF is bounded and attachment-only', async t => {
  const { files, alpha } = await fixture(t)
  for (const [name, bytes, mime] of [
    ['封面.PNG', png, 'image/png'], ['sample.jpg', jpeg, 'image/jpeg'], ['sample.webp', webp, 'image/webp'],
    ['sample.pdf', pdf, 'application/pdf'],
  ]) {
    const absolute = join(alpha, name)
    await writeFile(absolute, bytes)
    const item = await files.inspect(absolute)
    const isImage = mime.startsWith('image/')
    assert.equal(item.kind, isImage ? 'image' : 'document')
    assert.equal(item.status, 'ready', name)
    assert.equal(item.canPreview, isImage)
    assert.deepEqual(await files.read(absolute, item.revision, 'download'), { name, mime, bytes })
    if (isImage) assert.deepEqual(await files.read(absolute, item.revision, 'preview'), { name, mime, bytes })
    else await assert.rejects(files.read(absolute, item.revision, 'preview'), { status: 415 })
  }
  const tooWide = Buffer.from(png)
  tooWide.writeUInt32BE(4097, 16)
  const animatedPng = Buffer.concat([png.subarray(0, 33), Buffer.from('000000086163544c000000010000000000000000', 'hex'), png.subarray(33)])
  const wrongRaster = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')
  for (const [name, contents, kind] of [
    ['wrong.png', wrongRaster, 'image'], ['wrong.jpg', png, 'image'], ['broken.webp', webp.subarray(0, -1), 'image'],
    ['oversize.png', tooWide, 'image'], ['animated.png', animatedPng, 'image'], ['wrong.pdf', Buffer.from('%PDF-3.0\n'), 'document'],
  ]) {
    const absolute = join(alpha, name)
    await writeFile(absolute, contents)
    assert.deepEqual(await files.inspect(absolute), unavailable(name, kind, contents.length, 'unsupported'))
    await assert.rejects(files.read(absolute, `r_${'a'.repeat(64)}`, 'preview'), { status: 409 })
  }
})

test('only confirmed missing leaves are shown; unsupported and over-limit files have no capabilities', async t => {
  const { root, files, alpha } = await fixture(t)
  assert.equal(await files.inspect(root), null)
  assert.equal(await files.inspect(alpha), null)
  assert.equal(await files.inspect(join(alpha, 'missing-dir', 'gone.txt')), null)
  assert.deepEqual(await files.inspect(join(alpha, 'gone.txt')), unavailable('gone.txt', 'text', null, 'missing'))
  for (const [name, bytes, kind] of [
    ['plain.txt', Buffer.from([0x61, 0xff]), 'text'], ['binary.csv', Buffer.from([0x61, 0, 0x62]), 'text'],
    ['fake.md', Buffer.from('<!DOCTYPE HTML>\n'), 'text'], ['script.txt', Buffer.from('#!/bin/sh\necho hi'), 'text'],
    ['page.html', Buffer.from('<html>'), 'document'], ['icon.svg', Buffer.from('<svg />'), 'document'],
    ['code.js', Buffer.from('const data = 1'), 'document'], ['macro.docm', Buffer.from('PK'), 'document'],
    ['archive.zip', Buffer.from('PK'), 'document'],
  ]) {
    const path = join(alpha, name)
    await writeFile(path, bytes)
    assert.deepEqual(await files.inspect(path), unavailable(name, kind, bytes.length, 'unsupported'))
  }
  for (const [name, kind, limit] of [['table.csv', 'text', 2 * MiB], ['image.png', 'image', 2 * MiB], ['book.pdf', 'document', 8 * MiB]]) {
    const path = join(alpha, name)
    await writeFile(path, '')
    await truncate(path, limit + 1)
    assert.deepEqual(await files.inspect(path), unavailable(name, kind, limit + 1, 'too-large'))
  }
  const executable = join(alpha, 'executable.txt')
  await writeFile(executable, 'shell', { mode: 0o755 })
  assert.deepEqual(await files.inspect(executable), unavailable('executable.txt', 'text', 5, 'unsupported'))
})

test('no registration, private data, traversal, permission changes, links, and special entries reveal nothing', async t => {
  const { base, root, alpha, outside, cleanups, files } = await fixture(t)
  const noMount = openDeliveryFiles({ catalog: openWorkspaceCatalog({}) })
  const safe = join(alpha, 'public.txt')
  const privateFile = join(outside, 'external.txt')
  const rootFile = join(root, 'operator.txt')
  await Promise.all([writeFile(safe, 'public'), writeFile(privateFile, 'private'), writeFile(rootFile, 'outside all projects')])
  const valid = await files.inspect(safe)
  assert.equal(await noMount.inspect(safe), null)
  await assert.rejects(noMount.locate(safe, valid.revision), conflict(base, 'public.txt'))
  const viaSymlink = join(alpha, 'symlink.txt')
  const viaHardlink = join(alpha, 'hardlink.txt')
  const symlinkParent = join(alpha, 'symlink-dir')
  const symlinkProject = join(root, 'other')
  const unreadable = join(alpha, 'unreadable.txt')
  const noSearch = join(alpha, 'no-search')
  const dot = join(alpha, '.git')
  const savedCredential = join(alpha, 'credentials.json')
  const renamedKey = join(alpha, 'notes.txt')
  const socket = createServer()
  const socketPath = join(alpha, 'socket.txt')
  await Promise.all([
    symlink(privateFile, viaSymlink), symlink(outside, symlinkParent), symlink(outside, symlinkProject), link(privateFile, viaHardlink),
    writeFile(unreadable, 'hidden', { mode: 0o200 }), mkdir(noSearch), mkdir(dot), writeFile(savedCredential, '{"token":"private"}'),
    writeFile(renamedKey, '-----BEGIN OPENSSH PRIVATE KEY-----\n...'),
    new Promise((resolve, reject) => socket.once('error', reject).listen(socketPath, resolve)),
  ])
  cleanups.push(() => new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve())))
  await writeFile(join(noSearch, 'file.txt'), 'hidden')
  await writeFile(join(dot, 'config.txt'), 'hidden')
  await chmod(noSearch, 0o644)
  cleanups.push(() => chmod(noSearch, 0o755))
  for (const absolute of [privateFile, '/etc/passwd', rootFile, viaSymlink, viaHardlink, join(symlinkParent, 'external.txt'),
    join(symlinkProject, 'external.txt'), unreadable, socketPath, join(noSearch, 'file.txt'), join(dot, 'config.txt'),
    savedCredential, renamedKey, `${alpha}/../alpha/public.txt`, `${alpha}/./public.txt`, `${alpha}//public.txt`,
    `${alpha}/public.txt/`, `${alpha}/public.txt\0`, 'public.txt', join(alpha, 'file\u202e.txt')]) {
    assert.equal(await files.inspect(absolute), null, absolute)
    await assert.rejects(files.read(absolute, valid.revision, 'download'), conflict(base))
  }
})

test('signed revisions become stale on in-place edits, links, project replacement and root replacement', async t => {
  const { catalog, catalogId, files, base, root, alpha, outside } = await fixture(t)
  const path = join(alpha, 'report.txt')
  const privateFile = join(outside, 'new.txt')
  await writeFile(path, 'before')
  await writeFile(privateFile, 'private replacement')
  const first = await files.inspect(path)
  await writeFile(path, 'AFTER!')
  await assert.rejects(files.read(path, first.revision, 'download'), conflict(base))
  await assert.rejects(files.locate(path, first.revision), conflict(base))
  const second = await files.inspect(path)
  assert.notEqual(second.revision, first.revision)
  await rm(path)
  await symlink(privateFile, path)
  assert.equal(await files.inspect(path), null)
  await assert.rejects(files.read(path, second.revision, 'download'), conflict(base))
  await rm(path)
  await link(privateFile, path)
  assert.equal(await files.inspect(path), null)
  await assert.rejects(files.locate(path, second.revision), conflict(base))
  await assert.rejects(files.read(path, second.revision, 'download'), conflict(base))
  await rm(path)
  await writeFile(path, 'original root')
  const third = await files.inspect(path)
  const alphaId = catalogId('alpha')
  await rename(alpha, join(root, '.retired-project'))
  await mkdir(alpha)
  await writeFile(path, 'replacement project')
  assert.notEqual(catalogId('alpha'), alphaId)
  await assert.rejects(files.read(path, third.revision, 'download'), conflict(base))
  const current = await files.inspect(path)
  await rename(root, join(base, '.retired-root'))
  await mkdir(alpha, { recursive: true })
  await writeFile(path, 'replacement root')
  assert.equal(catalog.resolveDeliveryPath(path), null)
  assert.equal(await files.inspect(path), null)
  await assert.rejects(files.read(path, current.revision, 'download'), conflict(base))
  await assert.rejects(files.locate(path, current.revision), conflict(base))
})

test('post-read identity check catches a leaf swapped at the live fd checkpoint', async t => {
  const { catalog, files, base, alpha, outside } = await fixture(t)
  const absolute = join(alpha, 'live.txt')
  const privateFile = join(outside, 'replacement.txt')
  await writeFile(absolute, 'allowed')
  await writeFile(privateFile, 'private bytes')
  const checked = openDeliveryFiles({ catalog: {
    resolveDeliveryPath: catalog.resolveDeliveryPath,
    pinProject(id) {
      const pinned = catalog.pinProject(id)
      let calls = 0
      return { ...pinned, assertCurrent() {
        if (++calls === 5 && swap) {
          swapped = true
          renameSync(absolute, join(alpha, '.retired'))
          symlinkSync(privateFile, absolute)
        }
        pinned.assertCurrent()
      } }
    },
  } })
  let swap = false, swapped = false
  const item = await checked.inspect(absolute)
  swap = true
  await assert.rejects(checked.read(absolute, item.revision, 'download'), conflict(base))
  assert.equal(swapped, true)
  assert.equal(await files.inspect(absolute), null)
})

function withInstrumentedFs(root, input, source) {
  // Keep all path traversal and IO real. Isolate fd-info/IO observation in a
  // child so these synchronous builtin hooks are invisible to other tests.
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs'
    import { syncBuiltinESMExports } from 'node:module'
    import assert from 'node:assert/strict'
    const [root, ...args] = process.argv.slice(1)
    const start = async () => {
      syncBuiltinESMExports()
      const { openWorkspaceCatalog } = await import(${JSON.stringify(new URL('../src/business/workspace-catalog.mjs', import.meta.url).href)})
      const { openDeliveryFiles } = await import(${JSON.stringify(new URL('../src/files/delivery-files.mjs', import.meta.url).href)})
      const catalog = openWorkspaceCatalog({ root })
      return { catalog, files: openDeliveryFiles({ catalog }) }
    }
    ${source}
  `, root, ...input])
}

test('different mount identity blocks direct file and intermediate-directory authorization even on the same device', async t => {
  const { root, alpha } = await fixture(t)
  const nested = join(alpha, 'nested')
  const flat = join(alpha, 'flat.txt')
  const deep = join(nested, 'deep.txt')
  await mkdir(nested)
  await Promise.all([writeFile(flat, 'flat'), writeFile(deep, 'deep')])
  withInstrumentedFs(root, [flat, nested, deep], String.raw`
    const [flat, nested, deep] = args
    const readFile = fs.readFileSync
    let mounted = false
    fs.readFileSync = function(path, ...options) {
      const result = readFile(path, ...options)
      const fd = /^\/proc\/self\/fdinfo\/(\d+)$/.exec(path)?.[1]
      if (mounted && fd && [flat, nested].includes(fs.readlinkSync('/proc/self/fd/' + fd))) {
        return result.replace(/^mnt_id:\s*\d+$/m, 'mnt_id:\t4294967295')
      }
      return result
    }
    const { catalog, files } = await start()
    try {
      const before = await files.inspect(flat)
      assert.equal(before.status, 'ready')
      assert.equal((await files.inspect(deep)).status, 'ready')
      mounted = true
      assert.equal(await files.inspect(flat), null)
      assert.equal(await files.inspect(deep), null)
      await assert.rejects(files.read(flat, before.revision, 'download'), { status: 409 })
    } finally { catalog.close() }
  `)
})

test('cold PDF metadata only reads magic, cached metadata does not read, and downloads re-read every byte', async t => {
  const { root, alpha } = await fixture(t)
  const path = join(alpha, 'boundary.pdf')
  const size = 8 * MiB
  await writeFile(path, pdf)
  await truncate(path, size)
  withInstrumentedFs(root, [path, String(size)], `
    const [path, size] = args
    const read = fs.readSync
    let readBytes = 0
    fs.readSync = function(fd, ...options) {
      const n = read(fd, ...options)
      if (fs.readlinkSync('/proc/self/fd/' + fd) === path) readBytes += n
      return n
    }
    const { catalog, files } = await start()
    try {
      const item = await files.inspect(path)
      assert.equal(item.status, 'ready')
      assert.equal(readBytes, 9)
      assert.deepEqual(await files.inspect(path), item)
      assert.deepEqual(await files.locate(path, item.revision), { workspaceId: catalog.list()[0].id, path: 'boundary.pdf' })
      assert.equal(readBytes, 9)
      assert.equal((await files.read(path, item.revision, 'download')).bytes.length, Number(size))
      assert.equal(readBytes, 9 + Number(size))
      await files.read(path, item.revision, 'download')
      assert.equal(readBytes, 9 + 2 * Number(size))
    } finally { catalog.close() }
  `)
})
