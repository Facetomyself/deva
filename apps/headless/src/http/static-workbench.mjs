import { constants, promises as fs } from 'node:fs'
import { extname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { childPath, openDirectory } from '../storage/private-files.mjs'
import { json, responseHeaders } from './policy.mjs'

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const MANIFEST_LIMIT = 1024 * 1024
const HTML = 'index.html'
const ENTRY = 'workbench.js'
const MIME = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm'
}))
const HTML_POLICY = [
  "default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:", "font-src 'self' data:", "connect-src 'self'",
  "media-src 'self' blob:", "worker-src 'self' blob:", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'"
].join('; ')

function invalidBundle() { return Error('Invalid workbench build') }
function list(value) {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) throw invalidBundle()
  return value
}

function asset(name) {
  if (name === ENTRY) return name
  const extension = typeof name === 'string' && extname(name)
  if (!extension || extension === '.html' || !MIME.has(extension) ||
      !/^assets\/(?:[\w-][\w.-]*\/)*[\w-][\w.-]*$/.test(name)) throw invalidBundle()
  return name
}

function manifestFiles(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw invalidBundle()
  const files = new Set([HTML])
  let hasEntry = false
  for (const record of Object.values(manifest)) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw invalidBundle()
    files.add(asset(record.file))
    if (record.file === ENTRY && record.isEntry === true) hasEntry = true
    for (const name of [...list(record.css), ...list(record.assets)]) files.add(asset(name))
    for (const dependency of [...list(record.imports), ...list(record.dynamicImports)]) {
      if (!Object.hasOwn(manifest, dependency)) throw invalidBundle()
    }
  }
  if (!hasEntry) throw invalidBundle()
  return files
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
}

// Paths come from checked build output, never directly from a request. Anchor each
// path component to its parent fd so a concurrent rename cannot introduce a symlink.
async function openRegular(root, name) {
  const parts = name.split('/')
  const leaf = parts.pop()
  let directory = root
  try {
    for (const part of parts) {
      const next = await fs.open(childPath(directory, part), DIRECTORY_FLAGS)
      const previous = directory
      directory = next
      if (previous !== root) await previous.close()
    }
    const handle = await fs.open(childPath(directory, leaf), FILE_FLAGS)
    try {
      const info = await handle.stat({ bigint: true })
      if (!info.isFile() || info.nlink !== 1n || info.size > BigInt(Number.MAX_SAFE_INTEGER)) throw invalidBundle()
      return { handle, info }
    } catch (error) {
      await handle.close().catch(() => {})
      throw error
    }
  } finally {
    if (directory !== root) await directory.close().catch(() => {})
  }
}

async function inspectBundle(webDir) {
  const { directory, identity } = await openDirectory(webDir)
  try {
    const { handle, info } = await openRegular(directory, 'manifest.json')
    let manifest
    try {
      if (info.size === 0n || info.size > BigInt(MANIFEST_LIMIT)) throw invalidBundle()
      const bytes = Buffer.alloc(Number(info.size))
      for (let offset = 0; offset < bytes.length;) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
        if (!bytesRead) throw invalidBundle()
        offset += bytesRead
      }
      if (!sameFile(info, await handle.stat({ bigint: true }))) throw invalidBundle()
      manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } finally {
      await handle.close()
    }
    const files = new Map()
    for (const name of manifestFiles(manifest)) {
      const file = await openRegular(directory, name)
      await file.handle.close()
      if ((name === HTML || name === ENTRY) && file.info.size === 0n) throw invalidBundle()
      files.set(name, file.info)
    }
    return { identity, manifest: info, files }
  } finally {
    await directory.close()
  }
}

/** Serve one verified, immutable Vite build. Missing/invalid output keeps readiness false. */
export async function openStaticWorkbench(webDir) {
  const bundle = await inspectBundle(webDir).catch(() => null)

  async function withRoot(task) {
    if (!bundle) throw invalidBundle()
    const { directory, identity } = await openDirectory(webDir)
    try {
      if (identity !== bundle.identity) throw invalidBundle()
      return await task(directory)
    } finally {
      await directory.close()
    }
  }

  async function openVerified(directory, name, expected) {
    const { handle, info } = await openRegular(directory, name)
    if (sameFile(info, expected)) return handle
    await handle.close()
    throw invalidBundle()
  }

  return Object.freeze({
    async ready() {
      return withRoot(async directory => {
        await (await openVerified(directory, 'manifest.json', bundle.manifest)).close()
        for (const [name, info] of bundle.files) await (await openVerified(directory, name, info)).close()
        return true
      }).catch(() => false)
    },

    async handle(req, res, path) {
      const name = path === '/' ? HTML : path.slice(1)
      const info = bundle?.files.get(name)
      if (!info && name !== HTML && name !== ENTRY) return false
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        json(res, 405, { error: 'method' }, { allow: 'GET, HEAD', connection: 'close' })
        return true
      }
      try {
        await withRoot(async directory => {
          const file = await openVerified(directory, name, info)
          try {
            const size = Number(info.size)
            res.writeHead(200, {
              ...responseHeaders,
              // Human Copy is same-origin and Paste consumes the browser's native paste
              // event only. No page needs asynchronous clipboard reading or embedded fullscreen.
              ...(name === HTML ? { 'content-security-policy': HTML_POLICY,
                'permissions-policy': 'clipboard-read=(), clipboard-write=(self), fullscreen=(self)' } : {}),
              'cross-origin-resource-policy': 'same-origin',
              'content-type': MIME.get(extname(name)),
              'content-length': size
            })
            if (req.method === 'HEAD' || size === 0) res.end()
            else await pipeline(file.createReadStream({ start: 0, end: size - 1, autoClose: false }), res)
          } finally {
            await file.close()
          }
        })
      } catch {
        if (!res.headersSent && !res.destroyed) json(res, 503, { error: 'workbench_unavailable' })
        else if (!res.writableEnded) res.destroy()
      }
      return true
    }
  })
}
