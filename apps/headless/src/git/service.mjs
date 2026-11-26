import { randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { HttpError } from '../http/policy.mjs'
import { inspectInWorker, gitFault } from './runner.mjs'

const opaque = prefix => prefix + randomBytes(16).toString('hex')
const viewTag = /^v_[a-f0-9]{32}$/u, entryTag = /^e_[a-f0-9]{32}$/u
const states = new Set(['ready','partial','unavailable','not_repo','unsupported_layout'])
const diffStates = new Set(['ready','binary','too_large','unavailable'])
const sides = new Set(['staged','worktree']), letters = new Set([null,'A','D','M','T','U'])
const typ = new Set(['ctx','add','del','hunk'])
const exact = (s, re) => typeof s === 'string' && re.exec(s)?.[0] === s
const bad = () => { throw new HttpError(400, 'invalid_git_request') }
const unavailable = () => { throw gitFault('git_unavailable') }
const stale = () => { throw gitFault('git_stale') }
function fields(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || keys.length !== Object.keys(value).length || !keys.every(k => Object.hasOwn(value,k))) bad()
}
function parseJob(op, body) {
  if (['status','branches','available'].includes(op)) { fields(body, []); return { op } }
  if (op === 'log') {
    fields(body, ['limit'])
    if (!Number.isInteger(body.limit) || body.limit < 1 || body.limit > 100) bad()
    return { op, limit: body.limit }
  }
  if (op !== 'diff') bad()
  fields(body, ['viewId','entryId','side'])
  if (!exact(body.viewId, viewTag) || !exact(body.entryId, entryTag) || !sides.has(body.side)) bad()
  return { op, viewId: body.viewId, entryId: body.entryId, side: body.side }
}
function limits(value) {
  if (!Array.isArray(value) || value.length > 32 || !value.every(s => exact(s, /^[a-z0-9_]{1,64}$/u))) unavailable()
  return value
}
function plainRel(rel) {
  return typeof rel === 'string' && rel.length > 0 && Buffer.byteLength(rel) <= 4095 &&
    !/[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(rel) && rel.split('/').every(p => p && !p.startsWith('.') && !/^[a-z]:/i.test(p))
}
function common(value) {
  if (!value || !states.has(value.state) || (value.branch !== null && typeof value.branch !== 'string')) unavailable()
  return { state: value.state, branch: value.branch, limitations: limits(value.limitations) }
}
function head(value) {
  if (typeof value.detached !== 'boolean' || typeof value.unborn !== 'boolean') unavailable()
  return { detached: value.detached, unborn: value.unborn }
}
function branches(value) {
  const base = common(value)
  if (!Array.isArray(value.branches) || value.branches.length > 2000) unavailable()
  return { ...base, ...head(value), branches: value.branches.map(({name,current,remote}) => {
    if (typeof name !== 'string' || typeof current !== 'boolean' || (remote !== null && typeof remote !== 'string')) unavailable()
    return {name,current,remote}
  }) }
}
function history(value, cap) {
  const base = common(value)
  if (value.traversal !== 'first-parent' || typeof value.more !== 'boolean' || !Array.isArray(value.commits) || value.commits.length > cap) unavailable()
  return { ...base, traversal: 'first-parent', more: value.more, commits: value.commits.map(({oid,short,author,subject,timestamp}) => {
    if (!exact(oid,/^[a-f0-9]{40}$/u) || !exact(short,/^[a-f0-9]{4,40}$/u) || !oid.startsWith(short) ||
        typeof author !== 'string' || typeof subject !== 'string' || !Number.isSafeInteger(timestamp)) unavailable()
    return {oid,short,author,subject,timestamp}
  }) }
}
function difference(value, rel, side) {
  if (value.rel !== rel || value.side !== side || !diffStates.has(value.state) || !Array.isArray(value.lines) ||
      value.lines.length > 1000 || typeof value.truncated !== 'boolean') unavailable()
  return { state: value.state, rel, side, limitations: limits(value.limitations), truncated: value.truncated,
    lines: value.lines.map(({type,oldNo,newNo,text}) => {
      if (!typ.has(type) || typeof text !== 'string' || [oldNo,newNo].some(n => n !== undefined && (!Number.isSafeInteger(n) || n < 0))) unavailable()
      return { type, ...(oldNo === undefined ? {} : {oldNo}), ...(newNo === undefined ? {} : {newNo}), text }
    }) }
}

/** Read-only explicit operator grants. Status snapshots retain only relative entry names and
 * comparison sides (not diff contents). The unguessable IDs are not credentials. */
export function openGitService({ grants, auth, now = () => performance.now(), run = inspectInWorker }) {
  const views = new Map(), active = new Map(), tasks = new Set()
  const maxViews = 24, ttl = 60_000
  let closing = false, closeJob
  function clearLogin(id) {
    for (const [key, view] of views) if (view.login === id) views.delete(key)
    for (const context of active.values()) if (context.login === id) context.abort.abort()
  }
  const unsubscribe = auth.onSessionRevoked(clearLogin)
  function checkActor(actor) {
    if (closing) unavailable()
    if (!auth.isLoginActive(actor)) throw new HttpError(401, 'auth')
  }
  function trim() {
    const time = now()
    for (const [key, view] of views) if (view.until <= time) views.delete(key)
  }
  function recall(actor, workspace, request) {
    trim()
    const view = views.get(request.viewId), row = view?.rows.get(request.entryId)
    if (!view || view.workspace !== workspace || view.login !== actor.loginSessionId || view.owner !== actor.ownerId ||
        !row?.diffSides.includes(request.side)) stale()
    return { view, row }
  }
  function status(value, actor, workspace) {
    const base = { ...common(value), ...head(value) }
    if (typeof value.mergeInProgress !== 'boolean' || !Array.isArray(value.entries) || value.entries.length > 2000 ||
        !exact(value.fingerprint, /^[a-f0-9]{64}$/u)) unavailable()
    const rows = new Map(), paths = new Set()
    const entries = value.entries.map(({rel,staged,worktree,conflicted,diffSides}) => {
      if (!plainRel(rel) || paths.has(rel) || !letters.has(staged) || !letters.has(worktree) || typeof conflicted !== 'boolean' ||
          !Array.isArray(diffSides) || diffSides.length > 2 || !diffSides.every(s => sides.has(s)) || new Set(diffSides).size !== diffSides.length) unavailable()
      paths.add(rel)
      const entryId = opaque('e_')
      rows.set(entryId, {rel,diffSides})
      return {entryId,rel,staged,worktree,conflicted,diffSides}
    })
    let viewId = null
    if (['ready','partial'].includes(base.state) && entries.some(row => row.diffSides.length)) {
      trim()
      // Each new explicit status supersedes this login's earlier view of the same workspace.
      for (const [key, v] of views) if (v.login === actor.loginSessionId && v.workspace === workspace) views.delete(key)
      if (views.size >= maxViews) views.delete(views.keys().next().value)
      viewId = opaque('v_')
      views.set(viewId,{login:actor.loginSessionId,owner:actor.ownerId,workspace,rows,expected:value.fingerprint,until:now()+ttl})
    } else {
      for (const [key, v] of views) if (v.login === actor.loginSessionId && v.workspace === workspace) views.delete(key)
    }
    return { ...base, workspaceId: workspace, viewId, entries, mergeInProgress: value.mergeInProgress }
  }
  async function execute(actor, wid, op, body, signal) {
    const request = parseJob(op, body)
    checkActor(actor); trim()
    if (!grants.enabled) throw new HttpError(403, 'git_not_granted')
    const before = op === 'diff' ? recall(actor, wid, request) : null
    if (active.size >= 2 || active.has(wid)) throw new HttpError(409, 'git_busy')
    const pin = grants.pin(wid), abort = new AbortController()
    const cancel = () => abort.abort()
    active.set(wid, {login:actor.loginSessionId,abort}); signal?.addEventListener('abort',cancel,{once:true})
    try {
      if (signal?.aborted) cancel()
      if (abort.signal.aborted) unavailable()
      pin.assertCurrent()
      if (op === 'available') return {available:true,mode:'read-only',workspaceId:wid}
      const job = before ? { op:'diff', rel:before.row.rel, side:request.side, expectedFingerprint:before.view.expected } : request
      const result = await run(pin, job, abort.signal)
      checkActor(actor)
      if (abort.signal.aborted) unavailable()
      pin.assertCurrent()
      if (op === 'status') return status(result, actor, wid)
      if (op === 'branches') return branches(result)
      if (op === 'log') return history(result, request.limit)
      const { view, row } = recall(actor, wid, request)
      if (view !== before.view || row !== before.row) stale()
      return difference(result,row.rel,request.side)
    } finally { signal?.removeEventListener('abort',cancel); active.delete(wid); pin.close() }
  }
  return Object.freeze({
    inspect(actor, wid, op, body, signal) {
      const task = execute(actor,wid,op,body,signal)
      tasks.add(task); const done = () => tasks.delete(task); void task.then(done,done)
      return task
    },
    close() {
      if (!closeJob) {
        closing=true; unsubscribe(); views.clear()
        for (const context of active.values()) context.abort.abort()
        closeJob=Promise.allSettled([...tasks]).then(()=>{})
      }
      return closeJob
    }
  })
}
