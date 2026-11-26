import type { DevaApi } from '../shared/host-api'

const prefix = '/api/v1'
const csrfHeader = 'x-deva-csrf'

type RecordValue = Record<string, unknown>
export type Revision = string | number
type Fetch = typeof fetch

export interface Bootstrap {
  protocol: 1
  version: string
  platform: string
  config: RecordValue
  csrf: string
  expiresAt: number
  capabilities?: { textChat?: true; library?: true; workspaceFiles?: true; attachments?: true; browserPanel?: true; sessionPreferences?: true; deliveries?: true }
}

export type SessionScreen = { mode: 'authenticated'; bootstrap: Bootstrap } | { mode: 'claim' | 'login' }

export class HttpFailure extends Error {
  constructor(readonly status: number, readonly code?: string) {
    super(`HTTP ${status}`)
  }
}

function record(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function revision(value: unknown): value is Revision {
  return (typeof value === 'string' && value.length > 0) || (typeof value === 'number' && Number.isFinite(value))
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function providerAddresses(config: RecordValue): Map<string, string> {
  const models = config.models
  if (!record(models) || !Array.isArray(models.providers)) return new Map()
  const addresses = new Map<string, string>()
  for (const p of models.providers) {
    if (record(p) && typeof p.id === 'string' && typeof p.apiHost === 'string') addresses.set(p.id, p.apiHost)
  }
  return addresses
}

function changedProviderAddresses(before: RecordValue, after: RecordValue): boolean {
  const next = providerAddresses(after)
  for (const [id, address] of providerAddresses(before)) if (next.get(id) !== address) return true
  return false
}

/** Remove claim data before loading the UI; the caller only holds it in page memory. */
export function captureClaim(location: Pick<Location, 'hash' | 'pathname' | 'search'>, history: Pick<History, 'state' | 'replaceState'>): string | undefined {
  const values = new URLSearchParams(location.hash.slice(1)).getAll('claim')
  if (values.length === 0) return undefined
  history.replaceState(history.state, '', location.pathname + location.search)
  return values.length === 1 && values[0] ? values[0] : undefined
}

export function createTransport(send: Fetch = fetch) {
  async function fetchJson(path: string, init: RequestInit): Promise<unknown> {
    const response = await send(prefix + path, {
      ...init, credentials: 'same-origin', mode: 'same-origin', redirect: 'error',
      cache: 'no-store', referrerPolicy: 'no-referrer'
    })
    if (!response.ok) {
      const failure: unknown = await response.json().catch(() => undefined)
      const code = record(failure) ? failure.error ?? failure.code : undefined
      throw new HttpFailure(response.status, typeof code === 'string' ? code : undefined)
    }
    return response.status === 204 ? undefined : response.json()
  }

  function request(path: string, method = 'GET', body?: unknown, csrf?: string): Promise<unknown> {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (csrf) headers[csrfHeader] = csrf
    return fetchJson(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  }

  async function uploadAttachment(sid: string, body: Blob, encodedName: string, mime: string, csrf: string): Promise<unknown> {
    if (typeof sid !== 'string' || /^[A-Za-z0-9_-]{1,128}$/u.exec(sid)?.[0] !== sid || !(body instanceof Blob) || !csrf ||
        /^[A-Za-z0-9_-]{1,340}$/u.exec(encodedName)?.[0] !== encodedName || /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.exec(mime)?.[0] !== mime)
      throw new Error('Invalid attachment upload')
    return fetchJson(`/chats/${sid}/attachments`, { method: 'POST', body, headers: {
      accept: 'application/json', 'content-type': 'application/octet-stream', [csrfHeader]: csrf,
      'x-deva-file-name': encodedName, 'x-deva-file-type': mime
    } })
  }

  async function bootstrap(): Promise<Bootstrap> {
    const result = await request('/bootstrap')
    if (!record(result) || result.protocol !== 1 || typeof result.version !== 'string' || !result.version ||
        typeof result.platform !== 'string' || !result.platform || !record(result.config) ||
        typeof result.csrf !== 'string' || !result.csrf || typeof result.expiresAt !== 'number' ||
        !Number.isFinite(result.expiresAt)) throw new Error('Invalid session bootstrap')
    const { protocol, version, platform, config, csrf, expiresAt } = result
    const capabilities: Bootstrap['capabilities'] = {}
    if (record(result.capabilities)) {
      if (result.capabilities.textChat === true) capabilities.textChat = true
      if (result.capabilities.library === true) capabilities.library = true
      if (result.capabilities.workspaceFiles === true) capabilities.workspaceFiles = true
      if (result.capabilities.attachments === true) capabilities.attachments = true
      if (result.capabilities.browserPanel === true) capabilities.browserPanel = true
      if (result.capabilities.sessionPreferences === true) capabilities.sessionPreferences = true
      if (result.capabilities.deliveries === true) capabilities.deliveries = true
    }
    return { protocol, version, platform, config, csrf, expiresAt, ...(Object.keys(capabilities).length ? { capabilities } : {}) }
  }

  async function browserRequest(path: string, csrf: string, signal: AbortSignal | undefined, body?: unknown, png = false): Promise<Response> {
    if (!csrf) throw new Error('Browser session closed')
    // Fetch supplies Origin for same-origin POSTs; JS cannot set the header itself.
    // Use the application origin, never an origin obtained from the remote tab.
    const headers: Record<string, string> = { accept: png ? 'image/png' : 'application/json', [csrfHeader]: csrf }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const response = await send(prefix + path, {
      method: body === undefined ? 'GET' : 'POST', headers, signal,
      body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin',
      mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'same-origin'
    })
    // Never surface or retain a response error body for private browser operations.
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      throw new HttpFailure(response.status)
    }
    return response
  }

  async function deliveryRequest(path: string, signal: AbortSignal, options: {
    accept: string; ifMatch?: string; post?: { csrf: string; body: unknown }
  }): Promise<Response> {
    const headers: Record<string, string> = { accept: options.accept }
    const post = options.post
    if (options.ifMatch) headers['if-match'] = options.ifMatch
    if (post) {
      if (!post.csrf) throw new Error('Delivery session closed')
      headers[csrfHeader] = post.csrf
      headers['content-type'] = 'application/json'
    }
    const response = await send(prefix + path, {
      method: post ? 'POST' : 'GET', headers, signal,
      body: post ? JSON.stringify(post.body) : undefined, credentials: 'same-origin',
      mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'same-origin'
    })
    if (!response.ok) {
      const failure: unknown = await response.json().catch(() => undefined)
      const code = record(failure) ? failure.error ?? failure.code : undefined
      throw new HttpFailure(response.status, typeof code === 'string' ? code : undefined)
    }
    return response
  }

  return {
    request, uploadAttachment, browserRequest, deliveryRequest,
    async inspect(): Promise<SessionScreen> {
      try {
        return { mode: 'authenticated', bootstrap: await bootstrap() }
      } catch (error) {
        if (!(error instanceof HttpFailure && error.status === 401)) throw error
      }
      const state = await request('/auth/state')
      if (!record(state) || typeof state.claimed !== 'boolean') throw new Error('Invalid claim state')
      return { mode: state.claimed ? 'login' : 'claim' }
    },
    async claim(credential: string, password: string): Promise<Bootstrap> {
      await request('/auth/claim', 'POST', { credential, password })
      return bootstrap()
    },
    async login(password: string): Promise<Bootstrap> {
      await request('/auth/login', 'POST', { password })
      return bootstrap()
    },
    async logout(csrf: string): Promise<void> {
      const result = await request('/auth/logout', 'POST', undefined, csrf)
      if (!record(result) || result.ok !== true) throw new Error('Invalid sign out result')
    }
  }
}

export type Transport = ReturnType<typeof createTransport>
export type SettingsHost = Pick<DevaApi, 'config' | 'secrets' | 'provider'> & {
  window: Pick<DevaApi['window'], 'setOverlaySymbolColor'>
}

type LibraryJob = 'read' | 'write' | 'config-write'
export type LibraryQueue = <T>(kind: LibraryJob, operation: (token: string, revision: Revision) => Promise<{
  value: T; configRevision?: Revision
}>) => Promise<T>

// Compare projections irrespective of JSON property order. Hidden config fields are not in this projection.
function equivalent(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => equivalent(item, b[i]))
  return record(a) && record(b) && Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every((key) => Object.prototype.hasOwnProperty.call(b, key) && equivalent(a[key], b[key]))
}

type SettingsBridgeOptions = {
  transport: Transport
  bootstrap: Bootstrap
  onFailure: (error: unknown) => void
  updateBrowserTheme: () => void
}

/** The initial GET is the source of truth for editable settings. Bootstrap is a separate first-frame projection. */
export function createSettingsBridge({ transport, bootstrap, onFailure, updateBrowserTheme }: SettingsBridgeOptions) {
  let snapshot = { ...bootstrap.config }
  let currentRevision: Revision | undefined
  let ids = new Set<string>()
  let csrf: string | undefined = bootstrap.csrf
  let closing = false
  let blocked = false
  let queueTail = Promise.resolve()

  async function readKeyFlags(): Promise<void> {
    const result = await transport.request('/provider-keys')
    if (!record(result) || result.available !== true || !strings(result.ids)) throw new Error('Provider key storage unavailable')
    if (!csrf) throw new Error('Session closed')
    ids = new Set(result.ids)
  }

  async function readSettings(): Promise<{ config: RecordValue; revision: Revision }> {
    const result = await transport.request('/settings')
    if (!record(result) || !record(result.config) || !revision(result.revision)) throw new Error('Invalid settings response')
    if (!csrf) throw new Error('Session closed')
    return { config: result.config, revision: result.revision }
  }

  const ready = Promise.all([
    readSettings().then((result) => {
      snapshot = { ...result.config }
      currentRevision = result.revision
    }),
    readKeyFlags()
  ]).then(() => undefined)

  function fail(error: unknown): void {
    if (blocked) return
    blocked = true
    if (error instanceof HttpFailure && error.status === 401) closeSession()
    onFailure(error)
  }

  // A failed mutation leaves the latest server state unknown (including a dropped response).
  // Halt dependent work, show the failure, and reload from the server rather than rebasing a whole models table.
  function enqueue<T>(operation: (token: string) => Promise<T>, mutation: boolean, library = false): Promise<T> {
    if (closing || !csrf) return Promise.reject(new Error('Session closed'))
    const job = queueTail.then(async () => {
      await ready
      if (blocked || !csrf) throw new Error('Reload settings before continuing')
      try {
        return await operation(csrf)
      } catch (error) {
        if (mutation || (error instanceof HttpFailure && (error.status === 401 || error.status === 403 || (!library && error.status === 409)))) fail(error)
        throw error
      }
    })
    queueTail = job.then(() => undefined, () => undefined)
    return job
  }

  const libraryQueue: LibraryQueue = (kind, operation) => enqueue(async (token) => {
    const expected = currentRevision!
    if (kind !== 'config-write') return (await operation(token, expected)).value

    const verify = (ok: boolean, afterWrite = false): void => {
      if (ok) return
      const error = new HttpFailure(409, afterWrite ? 'settings_changed_after_write' : 'settings_changed')
      fail(error)
      throw error
    }
    try {
      // Role and roster revisions do not cover settings. Do not adopt an external revision
      // even when the visible projection happens to match (stored keys can differ).
      const before = await readSettings()
      verify(before.revision === expected && equivalent(before.config, snapshot))
    } catch (error) {
      fail(error)
      throw error
    }

    let result: Awaited<ReturnType<typeof operation>>
    try {
      result = await operation(token, expected)
    } catch (error) {
      // An acknowledged resource conflict/validation failure belongs to its panel. A lost
      // response or server failure leaves config unknown and must stop queued settings writes.
      if (!(error instanceof HttpFailure) || error.status >= 500) fail(error)
      else if (![401, 403].includes(error.status)) {
        try { verify((await readSettings()).revision === expected) } catch (checkError) { fail(checkError); throw checkError }
      }
      throw error
    }
    try {
      // Read config again: role APIs return independent CAS tokens, never a settings token.
      // The settings projection excludes profile/roster data; unrelated differences are external.
      const after = await readSettings()
      verify((result.configRevision === undefined || result.configRevision === after.revision) && equivalent(after.config, snapshot), true)
      const beforeKeys = [...ids].sort()
      await readKeyFlags()
      verify(equivalent(beforeKeys, [...ids].sort()), true)
      // Do not adopt an external revision observed between the config and key-presence reads.
      verify((await readSettings()).revision === after.revision, true)
      snapshot = after.config
      currentRevision = after.revision
    } catch (error) {
      fail(error)
      throw error
    }
    return result.value
  }, false, true)

  async function changeKey(id: string, token: string, value?: string): Promise<void> {
    const result = await transport.request(`/provider-keys/${encodeURIComponent(id)}`,
      value === undefined ? 'DELETE' : 'PUT', { value, revision: currentRevision }, token)
    if (!record(result) || result.ok !== true || result.available !== true || !revision(result.revision))
      throw new Error('Provider key write failed')
    if (value === undefined) ids.delete(id)
    else ids.add(id)
    currentRevision = result.revision
  }

  async function flush(): Promise<void> {
    await ready
    await queueTail
  }

  const api: SettingsHost = {
    config: {
      getSync: () => ({ ...snapshot }),
      get: async () => { await flush(); return { ...snapshot } },
      set(patch) {
        const set = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined))
        const unset = Object.keys(patch).filter((key) => patch[key] === undefined)
        return enqueue(async (token) => {
          const result = await transport.request('/settings', 'PATCH', { set, unset, revision: currentRevision }, token)
          if (!record(result) || result.ok !== true || !revision(result.revision) ||
              (result.config !== undefined && !record(result.config))) throw new Error('Invalid settings write result')
          const confirmed = result.config ?? { ...snapshot, ...set }
          if (result.config === undefined) for (const key of unset) delete confirmed[key]
          const needsKeyRefresh = changedProviderAddresses(snapshot, confirmed)
          snapshot = confirmed
          currentRevision = result.revision
          // The backend unbinds credentials when a provider address changes; don't infer key presence.
          if (needsKeyRefresh) await readKeyFlags()
          return { ok: true } as const
        }, true)
      }
    },
    secrets: {
      list: async () => { await flush(); return [...ids] },
      available: async () => { await flush(); return true },
      has: async (id) => { await flush(); return ids.has(id) },
      set: (id, key) => enqueue(async (token) => {
        await changeKey(id, token, key || undefined)
        return { ok: true, available: true }
      }, true),
      delete: (id) => enqueue(async (token) => {
        await changeKey(id, token)
        return { ok: true } as const
      }, true)
    },
    provider: {
      listModels: ({ providerId, adapter, baseURL }) => enqueue(async (token) => {
        const result = await transport.request('/provider-models', 'POST', { providerId, adapter, baseURL }, token)
        if (!record(result) || typeof result.ok !== 'boolean' ||
            (result.models !== undefined && !strings(result.models)) || (result.ok && result.models === undefined) ||
            (result.kind !== undefined && typeof result.kind !== 'string') ||
            (result.message !== undefined && typeof result.message !== 'string')) throw new Error('Invalid provider probe result')
        return { ok: result.ok, models: result.models, kind: result.kind, message: result.message }
      }, false)
    },
    window: { setOverlaySymbolColor: async () => updateBrowserTheme() }
  }

  function closeSession(): void {
    csrf = undefined
    currentRevision = undefined
    snapshot = {}
    ids.clear()
  }

  async function logout(): Promise<void> {
    if (!csrf || closing) return
    // Stop accepting work, but let already queued changes settle before revoking the session.
    closing = true
    try {
      await queueTail
      if (csrf) await transport.logout(csrf)
      closeSession()
    } catch (error) {
      closing = false
      throw error
    }
  }

  async function beforeChatWrite(): Promise<void> {
    await flush()
    if (blocked || closing || !csrf) throw new Error('Reload settings before continuing')
  }

  return { api, ready, logout, beforeChatWrite, libraryQueue }
}

/** Install just the features required by the lazy desktop ModelSettings subtree. */
export function installSettingsHost(target: object, api: SettingsHost) {
  if ('deva' in target) throw new Error('The document already has a Deva host')
  Object.defineProperty(target, 'deva', { value: api, configurable: true })
  return () => { Reflect.deleteProperty(target, 'deva') }
}
