import { createHash, randomUUID } from 'node:crypto'
import { isUint8Array } from 'node:util/types'
import { appendRecord, corrupt, openDraftFiles, readAll, readRecord, writeAll } from './upload-store-files.mjs'
import { normalizeUploadInput, uploadContentValidator, UploadStoreError, validateUploadMetadata, validUploadId, validUploadSession } from './upload-store-types.mjs'

export { normalizeUploadName, normalizeUploadType, UPLOAD_MIME_LIMITS, UploadStoreError, validUploadId } from './upload-store-types.mjs'

const MiB = 1024 * 1024
export const UPLOAD_STORE_DEFAULTS = Object.freeze({
  maxSessionCount: 32, maxSessionBytes: 40 * MiB,
  maxGlobalCount: 512, maxGlobalBytes: 256 * MiB,
  draftTtlMs: 24 * 60 * 60 * 1000,
})
const finalName = id => `${id}.draft`
const tempName = id => `.${id}.partial`
const publicMeta = ({ id, name, mime, kind, size, sha256 }) => ({ id, name, mime, kind, size, sha256 })
const recordKeys = ['sid', 'id', 'name', 'mime', 'kind', 'size', 'sha256', 'createdAt']
const typedArray = Object.getPrototypeOf(Uint8Array.prototype)
const byteLength = Object.getOwnPropertyDescriptor(typedArray, 'byteLength').get
const byteOffset = Object.getOwnPropertyDescriptor(typedArray, 'byteOffset').get
const backingBuffer = Object.getOwnPropertyDescriptor(typedArray, 'buffer').get
const closed = () => new UploadStoreError('CLOSED', 'Upload store is closed')
const notFound = () => new UploadStoreError('NOT_FOUND', 'Upload draft not found')

// Race the next pull, not the whole stage: after abort we still wait for any disk I/O and cleanup.
function pull(iterator, signal) {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve().then(() => {
      signal.throwIfAborted()
      return iterator.next()
    }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

function stopPulling(iterator) {
  try { void Promise.resolve(iterator?.return?.()).catch(() => {}) } catch { /* best effort */ }
}

async function verifyPayloadOnDisk(handle, size, expected, signal) {
  const hash = createHash('sha256')
  for (let offset = 0; offset < size; offset += 64 * 1024) {
    signal.throwIfAborted()
    hash.update(await readAll(handle, Math.min(64 * 1024, size - offset), offset))
  }
  if (hash.digest('hex') !== expected) throw corrupt('Staged upload payload checksum mismatch')
}

function quotaTracker(limits) {
  const usage = new Map()
  const global = { count: 0, bytes: 0 }
  function adjust(sid, count, bytes, enforce = true) {
    const session = usage.get(sid) ?? { count: 0, bytes: 0 }
    if (enforce && ((count > 0 && (count > limits.maxSessionCount - session.count || count > limits.maxGlobalCount - global.count)) ||
        (bytes > 0 && (bytes > limits.maxSessionBytes - session.bytes || bytes > limits.maxGlobalBytes - global.bytes)))) {
      throw new UploadStoreError('QUOTA', 'Upload draft quota exceeded')
    }
    global.count += count; global.bytes += bytes
    session.count += count; session.bytes += bytes
    if (session.count) usage.set(sid, session)
    else usage.delete(sid)
  }
  return adjust
}

/**
 * Open file-backed drafts in an existing, private, absolute Linux dataDir. The owner must hold
 * the application's exclusive dataDir lock from before opening until after await close().
 *
 * stage(sid, {name,mime,size?}, asyncIterable<Uint8Array>, {signal?}?) -> public metadata;
 * describe(sid,id) -> metadata or null; read(sid,id) -> {meta,bytes} or UPLOAD_NOT_FOUND;
 * remove(sid,id) -> true on deletion, false on an absent/foreign ID; sweep() -> removed count.
 * Names are NFC display labels only; no host path, URL, rendering or upload transformation.
 * Text is UTF-8 text/plain <=512 KiB; PNG/JPEG/WebP inherit the avatar validator's static raster
 * header/container checks (not pixel decoding), 4096px per dimension and 2 MiB/file. PDF <=20 MiB
 * is recognized by its header only; it is not sanitized or suitable for direct same-origin rendering.
 *
 * Byte quotas count payloads; reserved counts and byte budgets include concurrent writes. On
 * successful commit, file and directory have been fsynced. Startup restores the validated metadata
 * index, discards private orphan partials and sweeps expired drafts. TTL starts at publication;
 * expired drafts are hidden immediately and release capacity on sweep, remove, or the next stage.
 * close() aborts unfinished staging, waits for cleanup and keeps intact drafts. Unsafe/corrupt indexed files fail
 * closed: startup rejects invalid manifests, and read verifies the stored digest of the exact bytes.
 * Staging/delete never touches the separately committed native session history or its media.
 */
export async function openUploadStore({ dataDir, now = Date.now, ...options } = {}) {
  const limits = { ...UPLOAD_STORE_DEFAULTS, ...options }
  if (typeof now !== 'function' || Object.keys(options).some(key => !Object.hasOwn(UPLOAD_STORE_DEFAULTS, key)) ||
      Object.entries(limits).some(([key, value]) => !Number.isSafeInteger(value) || value < (key === 'draftTtlMs' ? 1 : 0))) {
    throw new UploadStoreError('INVALID', 'Invalid upload store options')
  }
  function time() {
    const value = now()
    if (!Number.isSafeInteger(value) || value < 0) throw new UploadStoreError('INVALID', 'Invalid upload store clock')
    return value
  }
  const files = await openDraftFiles(dataDir)
  const records = new Map()
  const countUsage = quotaTracker(limits)
  const expired = ({ createdAt }, current) => current - createdAt >= limits.draftTtlMs
  const shutdown = new AbortController()
  const active = new Set()
  let closing = false
  let closeTask
  let queued = Promise.resolve()
  let storageFault

  function ordered(worker) {
    const task = queued.then(worker)
    queued = task.then(() => {}, () => {})
    return task
  }

  function apply(worker) {
    return closing ? Promise.reject(closed()) : ordered(worker)
  }

  async function load(id, { verifyPayload = false, entry } = {}) {
    await files.checkDirectory()
    const name = finalName(id)
    const { handle, stat } = await files.openRecord(name, entry?.identity)
    try {
      const record = await readRecord(handle, stat, id)
      if (entry && recordKeys.some(key => record[key] !== entry.record[key])) throw corrupt('Upload draft metadata changed')
      let bytes
      if (verifyPayload) {
        bytes = await readAll(handle, record.size)
        if (createHash('sha256').update(bytes).digest('hex') !== record.sha256) throw corrupt('Upload draft payload checksum mismatch')
      }
      await files.verify(handle, name, stat, { stable: true })
      await files.checkDirectory()
      return { record, bytes, identity: stat }
    } finally { await handle.close() }
  }

  async function erase(entry) {
    const { sid, id, size } = entry.record
    await files.checkDirectory()
    await files.discard(finalName(id), entry.identity)
    records.delete(id)
    countUsage(sid, -1, -size, false)
    await files.sync()
    await files.checkDirectory()
  }

  async function sweepExpired() {
    await files.checkDirectory()
    const current = time()
    let removed = 0
    for (const entry of records.values()) {
      if (expired(entry.record, current)) { await erase(entry); removed++ }
    }
    return removed
  }

  async function recover() {
    await files.checkDirectory()
    const partials = []
    for (const name of await files.names()) {
      if (name.endsWith('.draft') && validUploadId(name.slice(0, -6))) {
        const id = name.slice(0, -6)
        const entry = await load(id)
        countUsage(entry.record.sid, 1, entry.record.size, false)
        records.set(id, entry)
      } else if (name.startsWith('.') && name.endsWith('.partial') && validUploadId(name.slice(1, -8))) {
        const { handle, stat } = await files.openRecord(name)
        await handle.close()
        partials.push([name, stat])
      }
    }
    for (const [name, identity] of partials) {
      await files.checkDirectory()
      await files.discard(name, identity)
    }
    if (partials.length) await files.sync()
    await sweepExpired()
  }

  async function stageDraft(sid, input, source, { signal: callerSignal } = {}) {
    if (storageFault) throw storageFault
    const signal = callerSignal === undefined ? shutdown.signal : AbortSignal.any([callerSignal, shutdown.signal])
    signal.throwIfAborted()
    if (!validUploadSession(sid) || typeof source?.[Symbol.asyncIterator] !== 'function') {
      throw new UploadStoreError('INVALID', 'Upload requires a valid session and an async byte stream')
    }
    const { type, name, declared } = normalizeUploadInput(input)
    if (records.size) {
      const current = time()
      for (const { record } of records.values()) {
        if (expired(record, current)) { await ordered(sweepExpired); break }
      }
      signal.throwIfAborted()
      if (storageFault) throw storageFault
    }
    const id = randomUUID()
    let reserved = declared ?? 0
    countUsage(sid, 1, reserved)
    let location = tempName(id)
    let handle
    let identity
    let iterator
    let streamDone = false
    let published = false
    let cleanupFailed = false
    try {
      const hash = createHash('sha256')
      const validator = uploadContentValidator(type)
      await files.checkDirectory()
      signal.throwIfAborted()
      const temp = await files.create(location)
      handle = temp.handle
      identity = temp.stat
      iterator = source[Symbol.asyncIterator]()
      if (typeof iterator?.next !== 'function') throw new UploadStoreError('INVALID', 'Upload byte stream has no iterator')
      let size = 0
      for (;;) {
        const step = await pull(iterator, signal)
        signal.throwIfAborted()
        if (storageFault) throw storageFault
        if (!step || typeof step !== 'object') throw new UploadStoreError('INVALID', 'Invalid upload byte stream result')
        if (step.done) { streamDone = true; break }
        const chunk = step.value
        if (!isUint8Array(chunk)) throw new UploadStoreError('INVALID', 'Upload chunks must be Uint8Array bytes')
        const length = byteLength.call(chunk)
        const next = size + length
        if (next > type.maxBytes) throw new UploadStoreError('TOO_LARGE', 'Upload exceeds its MIME byte limit')
        if (declared !== undefined && next > declared) throw new UploadStoreError('INVALID', 'Upload does not match its declared size')
        if (!length) continue
        if (declared === undefined) { countUsage(sid, 0, length); reserved = next }
        const bytes = Buffer.from(new Uint8Array(backingBuffer.call(chunk), byteOffset.call(chunk), length))
        validator.accept(bytes)
        await writeAll(handle, bytes, size)
        hash.update(bytes)
        size = next
      }
      if (declared !== undefined && size !== declared) throw new UploadStoreError('INVALID', 'Upload does not match its declared size')
      validateUploadMetadata(name, type.mime, size)
      const payload = await files.verify(handle, location, identity)
      if (payload.size !== BigInt(size)) throw corrupt('Staged upload size changed')
      const sha256 = hash.digest('hex')
      await verifyPayloadOnDisk(handle, size, sha256, signal)
      await validator.finish(() => readAll(handle, size))
      signal.throwIfAborted()
      // Serialize publication with queries and removals. Streaming and quota reservations are concurrent.
      return await ordered(async () => {
        if (storageFault) throw storageFault
        signal.throwIfAborted()
        await files.checkDirectory()
        await files.verify(handle, location, payload, { stable: true })
        const record = { id, sid, name, mime: type.mime, kind: type.kind, size, sha256, createdAt: time() }
        const fileSize = await appendRecord(handle, record)
        await handle.sync()
        if ((await files.verify(handle, location, identity)).size !== fileSize) throw corrupt('Staged upload size changed')
        if (records.has(id) || await files.stat(finalName(id))) throw corrupt('Upload draft identifier collision')
        await files.checkDirectory()
        signal.throwIfAborted()
        await files.rename(location, finalName(id))
        location = finalName(id)
        const committed = await files.verify(handle, location, identity)
        await files.sync()
        await files.checkDirectory()
        await handle.close()
        handle = undefined
        signal.throwIfAborted()
        records.set(id, { record, identity: committed })
        published = true
        return publicMeta(record)
      })
    } catch (error) {
      if (!streamDone) stopPulling(iterator)
      if (identity && !published) {
        try {
          if (await files.discard(location, identity, { missingOkay: true })) await files.sync()
        } catch (cleanupError) {
          cleanupFailed = true
          storageFault = corrupt('Upload draft cleanup failed; reopen after inspecting storage', new AggregateError([error, cleanupError]))
          throw storageFault
        }
      }
      throw error
    } finally {
      try { await handle?.close() } finally { if (!published && !cleanupFailed) countUsage(sid, -1, -reserved, false) }
    }
  }

  try { await recover() } catch (error) { await files.close(); throw error }

  function owned(sid, id, includeExpired = false) {
    if (!validUploadSession(sid) || !validUploadId(id)) return undefined
    const entry = records.get(id)
    if (entry?.record.sid !== sid || (!includeExpired && expired(entry.record, time()))) return undefined
    return entry
  }

  return {
    stage(sid, input, source, options) {
      if (closing) return Promise.reject(closed())
      const task = Promise.resolve().then(() => stageDraft(sid, input, source, options))
      active.add(task)
      const forget = () => active.delete(task)
      void task.then(forget, forget)
      return task
    },
    describe: (sid, id) => apply(async () => {
      const entry = owned(sid, id)
      if (!entry) return null
      return publicMeta((await load(id, { entry })).record)
    }),
    read: (sid, id) => apply(async () => {
      const entry = owned(sid, id)
      if (!entry) throw notFound()
      const { record, bytes } = await load(id, { entry, verifyPayload: true })
      return { meta: publicMeta(record), bytes }
    }),
    remove: (sid, id) => apply(async () => {
      const entry = owned(sid, id, true)
      if (!entry) return false
      await erase(entry)
      return true
    }),
    sweep: () => apply(sweepExpired),
    close() {
      if (!closing) {
        closing = true
        shutdown.abort(closed())
        closeTask = (async () => {
          await Promise.allSettled(active)
          await queued
          await files.close()
        })()
      }
      return closeTask
    },
  }
}
