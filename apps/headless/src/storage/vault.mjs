import { createSecretKey, randomBytes } from 'node:crypto'
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path'
import { childPath, createPrivateFile, openDirectory, publishPrivateFile, readPrivateFile } from './private-files.mjs'
import { decryptMap, encryptMap, MAX_ENVELOPE_BYTES, validateName, validateValue } from './vault-format.mjs'

const VAULT_NAME = 'headless-vault.json'
const DESKTOP_NAME = 'secrets.json'
const KEY_BYTES = 32
const queues = new Map()

function keyPath(keyFile) {
  if (typeof keyFile !== 'string' || !isAbsolute(keyFile) || keyFile.includes('\0') || keyFile.endsWith(sep)) {
    throw new TypeError('Master key path must be an absolute file path')
  }
  const name = basename(keyFile)
  if (name === '.' || name === '..' || name === VAULT_NAME || name === DESKTOP_NAME) {
    throw new TypeError('Reserved master key filename')
  }
  return resolve(keyFile)
}

async function withDirectory(path, options, task) {
  const { directory, identity } = await openDirectory(path, options)
  try {
    return await task(directory, identity)
  } finally {
    // Closing a directory handle cannot undo an already-published mutation.
    await directory.close().catch(() => {})
  }
}

/** Provision an independent raw 32-byte key. The parent directory must already exist. */
export async function initializeMasterKey(keyFile) {
  const path = keyPath(keyFile)
  return withDirectory(dirname(path), {}, async directory => {
    const key = randomBytes(KEY_BYTES)
    try {
      await createPrivateFile(directory, basename(path), key)
    } finally {
      key.fill(0)
    }
  })
}

async function loadMasterKey(path) {
  return withDirectory(dirname(path), {}, async directory => {
    const { bytes } = await readPrivateFile(childPath(directory, basename(path)), {
      minSize: KEY_BYTES, maxSize: KEY_BYTES, singleLink: true
    })
    try {
      return createSecretKey(bytes)
    } finally {
      bytes.fill(0)
    }
  })
}

// Serialize all operations for a directory, including separately opened instances in this process.
// The server is responsible for excluding additional writer processes.
function serialize(identity, task) {
  const result = (queues.get(identity) ?? Promise.resolve()).then(task)
  const tail = result.then(() => {}, () => {})
  queues.set(identity, tail)
  return result.finally(() => {
    if (queues.get(identity) === tail) queues.delete(identity)
  })
}

function readVault(directory, absent = false) {
  return readPrivateFile(childPath(directory, VAULT_NAME), {
    minSize: 1, maxSize: MAX_ENVELOPE_BYTES, absent
  })
}

/**
 * Open an authenticated server-side vault; never provision the master key implicitly.
 * All methods are async. Only get exposes a secret, for use by in-process callers.
 */
export async function openVault({ dataDir, keyFile }) {
  if (typeof dataDir !== 'string' || dataDir.length === 0 || dataDir.includes('\0')) {
    throw new TypeError('Invalid vault data directory')
  }
  const path = resolve(dataDir)
  const key = await loadMasterKey(keyPath(keyFile))
  const identity = await withDirectory(path, { create: true, owned: true }, (directory, storageId) =>
    serialize(storageId, async () => {
      const existing = await readVault(directory, true)
      if (existing) {
        decryptMap(existing.bytes, key)
      } else {
        await publishPrivateFile(directory, VAULT_NAME, encryptMap(new Map(), key))
      }
      return storageId
    }))

  const access = task => serialize(identity, () => withDirectory(path, { owned: true }, async (directory, currentId) => {
    if (currentId !== identity) {
      throw Object.assign(new Error('Vault data directory was replaced'), { code: 'ERR_VAULT_CHANGED' })
    }
    // Reauthenticate disk state for every operation: no stale snapshots across instances, and
    // damage or removal after open can never silently become an empty vault on mutation.
    const { bytes, info } = await readVault(directory)
    const map = decryptMap(bytes, key)
    const persist = () => publishPrivateFile(directory, VAULT_NAME, encryptMap(map, key), info)
    return task(map, persist)
  }))

  return Object.freeze({
    __proto__: null,
    async get(name) {
      validateName(name)
      return access(map => map.get(name) ?? null)
    },
    async has(name) {
      validateName(name)
      return access(map => map.has(name))
    },
    async list(prefix = '') {
      validateName(prefix, true)
      return access(map => [...map.keys()].filter(name => name.startsWith(prefix)).sort())
    },
    async set(name, value) {
      validateName(name)
      validateValue(value)
      return access(async (map, persist) => {
        if (value === '') {
          if (!map.delete(name)) return
        } else {
          if (map.get(name) === value) return
          map.set(name, value)
        }
        await persist()
      })
    },
    async deletePrefix(prefix) {
      validateName(prefix)
      return access(async (map, persist) => {
        let deleted = 0
        for (const name of map.keys()) {
          if (name.startsWith(prefix) && map.delete(name)) deleted++
        }
        if (deleted > 0) await persist()
        return deleted
      })
    }
  })
}
