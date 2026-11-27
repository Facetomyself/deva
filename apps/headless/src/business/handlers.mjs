import { connectProvider } from './model-connection.mjs'
import { openUploadStore } from '../attachments/upload-store.mjs'
import { attachmentRoutes } from '../attachments/routes.mjs'
import { deliveryRoutes } from '../deliveries/routes.mjs'
import { createEventJournal } from '../events/index.mjs'
import { createChatWebSocket } from '../events/websocket.mjs'
import { createTextTurns } from '../chat/text-turns.mjs'
import { chatRoutes } from '../chat/routes.mjs'
import { conversationStatusRoutes } from '../chat/conversation-status-routes.mjs'
import { openReadMarkStore } from '../chat/read-mark-store.mjs'
import { browserRoutes } from '../browser/routes.mjs'
import { gitViewRoutes } from '../git/routes.mjs'
import { openGitService } from '../git/service.mjs'
import { openTaskStore } from '../tasks/store.mjs'
import { openTaskPreview } from '../tasks/preview.mjs'
import { taskRoutes } from '../tasks/routes.mjs'
import { openTerminalService } from '../terminal/service.mjs'
import { terminalRoutes } from '../terminal/routes.mjs'
import { HttpError, json, readJson } from '../http/policy.mjs'
import { openSettings } from './settings.mjs'
import { allowedModelOrigins } from './provider-fetch.mjs'
import { openLibrary } from './library-routes.mjs'
import { openSkillDocuments } from '../skills/documents.mjs'
import { openSkillLibrary } from '../skills/store.mjs'
import { openProjectDocumentService } from '../files/project-document-service.mjs'
import { projectDocumentRoutes } from '../files/project-document-routes.mjs'
import { skillLibraryRoutes } from '../skills/routes.mjs'

const keyPath = /^\/api\/v1\/provider-keys\/([A-Za-z0-9_.-]{1,128})$/
const names = new Set(['/api/v1/settings', '/api/v1/provider-keys', '/api/v1/provider-models'])
function exact(obj, fields) {
  if (Object.keys(obj).length !== fields.length || !fields.every((key) => Object.hasOwn(obj, key))) throw new HttpError(400, 'invalid_fields')
}
function revision(value) {
  if (value === undefined) throw new HttpError(409, 'revision_required')
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new HttpError(400, 'invalid_revision')
  return value
}
const errors = Object.freeze({
  ERR_SETTINGS_INVALID: [400, 'invalid_settings'], ERR_SETTINGS_REVISION_REQUIRED: [409, 'revision_required'],
  ERR_SETTINGS_CONFLICT: [409, 'conflict'], ERR_SETTINGS_PROVIDER_NOT_FOUND: [404, 'provider_not_found'],
  ERR_SETTINGS_READ_ONLY: [503, 'storage_unavailable'], ERR_SETTINGS_UNAVAILABLE: [503, 'storage_unavailable'],
  ERR_PROVIDER_EGRESS: [422, 'provider_origin_not_permitted'], AUTH_FAILED: [401, 'auth']
})
function statusFor(err) {
  if (err instanceof HttpError) return [err.status, err.code]
  return Object.hasOwn(errors, err?.code) ? errors[err.code] : [500, 'internal']
}
const text = (str) => typeof str === 'string' && str.trim().length > 0

/** Use a single immutable provider snapshot for URL, credentials and headers. The browser may
 * request a known provider but never independently select the destination for its stored key. */
async function probe(settings, supplied, opts, signal) {
  exact(supplied, ['providerId', 'adapter', 'baseURL'])
  if (!text(supplied.providerId) || !text(supplied.baseURL) || !['openai', 'anthropic', 'responses'].includes(supplied.adapter)) throw new HttpError(400, 'invalid_probe')
  const connection = await connectProvider(settings, supplied.providerId, { ...opts, expected: supplied, signal })
  return connection.listModels()
}

export async function openBusiness({ dataDir, vault, auth, version, allowedOrigins = [], workspaceRoot, workspaceWritable = false, workspaceCreate = false, privateRoots, browserRunDir, terminalRunDir, gitProjects }) {
  const opts = { version, allowedOrigins: [...allowedModelOrigins(allowedOrigins)] }
  const settings = await openSettings({ dataDir, vault })
  const lifetime = new AbortController()
  const journal = createEventJournal()
  let library, turns, uploads, browser, closingBrowser, git, closingGit, taskStore, preview, tasks, closingTasks
  let terminalService, closingTerminals, skills, closingSkills, documentIntents, closingDocuments, readMarks, conversation, closingConversation
  try {
    library = await openLibrary({ dataDir, workspaceRoot, workspaceWritable, workspaceCreate, privateRoots, gitProjects })
    if (library.createDocumentTarget) documentIntents = openProjectDocumentService({auth,openTarget:library.createDocumentTarget})
    // Discover native documents only upon explicit owner requests (never feed this catalog to turns).
    const documents = openSkillDocuments({ dataDir })
    skills = skillLibraryRoutes({ auth, documents, store: openSkillLibrary({ dataDir, documents,
      withRoleChoices: library.withSkillRoleChoices }) })
    if (library.gitGrants.enabled) git = openGitService({ grants: library.gitGrants, auth })
    // No scheduler is installed in this process. Task records are read only on a human request.
    taskStore = openTaskStore({ dataDir }); preview = openTaskPreview()
    tasks = taskRoutes({ store: taskStore, preview })
    uploads = await openUploadStore({ dataDir })
    readMarks=openReadMarkStore({dataDir})
    turns = createTextTurns({ dataDir, settings, journal, ...opts, resolveRole: library.resolveRole,
      withWorkspace: library.withWorkspace, uploads, deliveries: true,
      // A desktop-imported clock can be ahead of ours. New content advances past a known read mark.
      // The turn owner treats unreadable/invalid marks as absent rather than blocking a model request.
      readWatermark: sid => readMarks.snapshot().get(sid) })
    conversation=conversationStatusRoutes({turns,marks:readMarks,journal})
    // A workspace plus an explicit private control mount enables the human-only viewer.
    // Do not start a process here or make app readiness depend on the optional sidecar.
    if (terminalRunDir && library.terminalSource) {
      const { createTerminalClient } = await import('../../../terminal-worker/src/client.mjs')
      terminalService = openTerminalService({ auth, openSource: library.terminalSource, worker: createTerminalClient({ runDir: terminalRunDir }) })
    }
    // The Unix client is loaded only when the operator mounted a private worker socket.
    if (browserRunDir) {
      const { createManualBrowser } = await import('../browser/manual-browser.mjs')
      browser = createManualBrowser({ runDir: browserRunDir, auth, sessionExists: turns.hasBrowserSession })
    }
  } catch (err) {
    journal.close()
    await Promise.allSettled([conversation ? conversation.close() : readMarks?.close(), documentIntents?.close(), skills?.close(), terminalService?.close(), git?.close(), ...(tasks ? [tasks.close()] : [preview?.close(), taskStore?.close?.()]),
      turns?.close(), uploads?.close(), library?.close()]); throw err
  }
  const documentRoutes = projectDocumentRoutes(documentIntents)
  const terminals = terminalRoutes(terminalService)
  const handleGit = gitViewRoutes(git)
  const handleBrowser = browserRoutes(browser)
  const chats = chatRoutes(turns, { withRoleForChat: library.withRoleForChat })
  const attachments = attachmentRoutes({ uploads, turns })
  const deliveries = deliveryRoutes({ turns, files: library.deliveryFiles })
  function beginShutdown() {
    lifetime.abort(); attachments.close()
    if (!closingConversation) { closingConversation=conversation.close();void closingConversation.catch(()=>{}) }
    if (!closingDocuments) { closingDocuments=documentRoutes.close();void closingDocuments.catch(()=>{}) }
    if (!closingSkills) { closingSkills=skills.close();void closingSkills.catch(()=>{}) }
    if (!closingTerminals) { closingTerminals = terminals.close(); void closingTerminals.catch(() => {}) }
    if (!closingTasks) { closingTasks = tasks.close(); void closingTasks.catch(() => {}) }
    if (git && !closingGit) { closingGit = git.close(); void closingGit.catch(() => {}) }
    if (browser && !closingBrowser) { closingBrowser = Promise.resolve(browser.close()); void closingBrowser.catch(() => {}) }
  }
  return {
    beginShutdown,
    capabilities: Object.freeze({ textChat: true, library: true, workspaceFiles: library.workspaceFilesEnabled, attachments: true,
      browserPanel: !!browser, gitInspect: !!git, taskInspection: Boolean(tasks), deliveries: typeof turns.deliverySnapshot === 'function',
      conversationStatus: Boolean(conversation), terminalViewer: Boolean(terminalService), skillLibrary: Boolean(skills), workspaceDocumentCreate: Boolean(documentIntents),
      sessionWorkspaces: typeof turns.getWorkspace === 'function' && typeof turns.setWorkspace === 'function',
      sessionPreferences: typeof turns.patchPreferences === 'function' && typeof journal.watchSessions === 'function' }),
    createRealtime: ({ auth, policy }) => createChatWebSocket({ turns, journal, auth, policy }),
    getConfig: () => settings.getPublicConfig(),
    async handle(req, res, { auth, policy }) {
      const path = (req.url ?? '').split('?', 1)[0]
      if ((path==='/api/v1/conversation-status/reads' || path.startsWith('/api/v1/chats/') && (path.endsWith('/context-usage') || path.endsWith('/read-state'))) &&
          await conversation.handle(req,res,{auth,policy})) return true
      if (path.startsWith('/api/v1/workspaces/') && path.includes('/document-intents') && await documentRoutes.handle(req,res,{auth,policy})) return true
      if ((path === '/api/v1/skills' || path.startsWith('/api/v1/skills/')) && await skills.handle(req,res,{auth,policy})) return true
      if ((path === '/api/v1/terminal/profiles' || (path.startsWith('/api/v1/workspaces/') && path.includes('/terminals'))) &&
          await terminals.handle(req,res,{auth,policy})) return true
      if ((path === '/api/v1/tasks' || path.startsWith('/api/v1/tasks/')) && await tasks.handle(req, res, { auth, policy })) return true
      if (path.startsWith('/api/v1/workspaces/') && path.includes('/git/') && await handleGit(req, res, { auth, policy })) return true
      if (path.includes('/browser') && await handleBrowser(req, res, { auth, policy })) return true
      if (path === '/api/v1/chats' || path.startsWith('/api/v1/chats/')) {
        if (path.includes('/deliveries') && await deliveries(req, res, { auth, policy })) return true
        if (path.includes('/attachments') && await attachments.handle(req, res, { auth, policy })) return true
        return chats(req, res, { auth, policy })
      }
      const match = keyPath.exec(path)
      if (!names.has(path) && !match) return library.handle(req, res, { auth, policy })
      const methods = match ? ['PUT', 'DELETE'] : path === '/api/v1/settings' ? ['GET', 'PATCH'] : path.endsWith('models') ? ['POST'] : ['GET']
      const write = req.method !== 'GET'
      try {
        policy.check(req, write)
        if (req.url !== path) throw new HttpError(400, 'unexpected_query')
        if (!methods.includes(req.method)) { json(res, 405, { error: 'method' }, { allow: methods.join(', ') }); return true }
        const cookie = policy.cookie(req)
        if (write) auth.authenticate(cookie, req.headers['x-deva-csrf']); else auth.authenticate(cookie)
        if (lifetime.signal.aborted) throw new HttpError(503, 'shutting_down')
        if (path === '/api/v1/settings' && !write) {
          const { revision: rev, ...config } = await settings.getPublicConfig()
          json(res, 200, { config, revision: rev })
        } else if (path === '/api/v1/settings') {
          const body = await readJson(req, 1024 * 1024)
          revision(body.revision)
          const { revision: rev, ...config } = await settings.patch(body)
          json(res, 200, { ok: true, revision: rev, config })
        } else if (match) {
          if (['.', '..', '__proto__', 'constructor', 'prototype'].includes(match[1])) throw new HttpError(400, 'invalid_provider')
          const body = await readJson(req, 70 * 1024); const rev = revision(body.revision)
          exact(body, req.method === 'PUT' ? ['value', 'revision'] : ['revision'])
          if (req.method === 'PUT' && typeof body.value !== 'string') throw new HttpError(400, 'invalid_fields')
          const result = req.method === 'PUT' ? await settings.setKey(match[1], body.value, rev) : await settings.deleteKey(match[1], rev)
          json(res, 200, { ok: true, available: result.available, revision: result.revision })
        } else if (path === '/api/v1/provider-keys') {
          json(res, 200, { ids: await settings.listKeys(), available: await settings.available() })
        } else {
          const ctrl = new AbortController(); const closed = () => { if (!res.writableEnded) ctrl.abort() }
          res.once('close', closed)
          try { json(res, 200, await probe(settings, await readJson(req), opts, AbortSignal.any([lifetime.signal, ctrl.signal]))) }
          finally { res.off('close', closed) }
        }
      } catch (err) {
        const [status, code] = statusFor(err)
        if (!res.destroyed && !res.headersSent) json(res, status, { error: code }, write ? { connection: 'close' } : {})
      }
      return true
    },
    async close() {
      beginShutdown()
      try { await turns.close() } finally {
        journal.close()
        try {
          const results = await Promise.allSettled([closingBrowser, closingGit, closingTasks, closingTerminals, closingSkills, closingDocuments, closingConversation])
          if (results.some(row => row.status === 'rejected')) throw Error('Optional service shutdown unconfirmed')
        } finally { try { await uploads.close() } finally { await library.close() } }
      }
    }
  }
}
