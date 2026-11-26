import { HttpError, json, readJson } from './policy.mjs'

const routes = new Map([
  ['/api/v1/auth/state', 'GET'], ['/api/v1/auth/claim', 'POST'], ['/api/v1/auth/login', 'POST'],
  ['/api/v1/auth/logout', 'POST'], ['/api/v1/bootstrap', 'GET']
])

/** Only the fields the desktop renderer reads before its first frame. Model headers, MCP
 * settings, remote devices and keys must never join this client-visible bootstrap snapshot. */
export function appearanceSnapshot(config) {
  const result = {}; const layout = {}
  if (['light', 'dark', 'system'].includes(config?.theme)) result.theme = config.theme
  if (['zh-CN', 'en'].includes(config?.locale)) result.locale = config.locale
  if (['sm', 'md', 'lg', 'xl'].includes(config?.chatFontSize)) result.chatFontSize = config.chatFontSize
  for (const key of ['sidebarWidth', 'composerHeight']) {
    const n = config?.layout?.[key]
    if (Number.isSafeInteger(n) && n > 0 && n <= 8192) layout[key] = n
  }
  if (typeof config?.layout?.sidebarCollapsed === 'boolean') layout.sidebarCollapsed = config.layout.sidebarCollapsed
  if (Object.keys(layout).length) result.layout = layout
  return result
}

function exactStrings(body, names) {
  const keys = Object.keys(body)
  if (keys.length !== names.length || !names.every((n) => Object.hasOwn(body, n) && typeof body[n] === 'string'))
    throw new HttpError(400, 'invalid_fields')
}

/** No route issues claim credentials. That action belongs to the private deployment control channel. */
export function sessionRoutes({ auth, policy, version, getConfig, capabilities }) {
  if (!version || typeof getConfig !== 'function') throw new TypeError('Missing bootstrap dependencies')
  return async (req, res) => {
    const path = (req.url ?? '').split('?', 1)[0]
    const method = routes.get(path)
    if (!method) return false
    try {
      policy.check(req, method === 'POST')
      if (path !== req.url) throw new HttpError(400, 'unexpected_query')
      if (req.method !== method) { json(res, 405, { error: 'method' }, { allow: method }); return true }
      if (path === '/api/v1/auth/state') {
        json(res, 200, { claimed: auth.isClaimed() })
        return true
      }
      const cookie = policy.cookie(req)
      if (path === '/api/v1/bootstrap') {
        const { csrf, expiresAt } = auth.describe(cookie)
        const config = appearanceSnapshot(await getConfig())
        json(res, 200, { protocol: 1, version, platform: process.platform, config, csrf, expiresAt,
          capabilities: { textChat: capabilities?.textChat === true, library: capabilities?.library === true,
            workspaceFiles: capabilities?.workspaceFiles === true, attachments: capabilities?.attachments === true,
            browserPanel: capabilities?.browserPanel === true, sessionPreferences: capabilities?.sessionPreferences === true,
            deliveries: capabilities?.deliveries === true } })
        return true
      }
      if (path === '/api/v1/auth/logout') {
        auth.authenticate(cookie, req.headers['x-deva-csrf'])
        auth.logout(cookie)
        json(res, 200, { ok: true }, { 'set-cookie': policy.forgetCookie() })
        return true
      }
      const body = await readJson(req)
      const claiming = path === '/api/v1/auth/claim'
      exactStrings(body, claiming ? ['credential', 'password'] : ['password'])
      const { session, csrf, expiresAt } = claiming
        ? await auth.claim(body.credential, body.password)
        : await auth.login(body.password)
      json(res, 200, { csrf, expiresAt }, { 'set-cookie': policy.issueCookie(session, expiresAt) })
    } catch (err) {
      const known = err instanceof HttpError
      const status = known ? err.status : err?.code === 'AUTH_FAILED' ? 401 : 500
      const code = known ? err.code : status === 401 ? 'auth' : 'internal'
      // Neither exceptions nor request contents are returned/logged. Close rejected POSTs so an
      // unconsumed or over-limit body never pollutes a keep-alive connection.
      json(res, status, { error: code }, method === 'POST' ? { connection: 'close' } : {})
    }
    return true
  }
}
