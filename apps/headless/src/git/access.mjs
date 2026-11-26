import { validWorkspaceName } from '../files/workspace-files-fd.mjs'
import { HttpError } from '../http/policy.mjs'

/** Approving file browsing alone does not authorize viewing Git history. No glob or path syntax. */
export function gitProjectNames(input) {
  if (input === undefined || input === '') return []
  let names = input
  if (typeof input === 'string') {
    if (Buffer.byteLength(input) > 12 * 1024) throw Error('Invalid Git project allowlist')
    try { names = JSON.parse(input) } catch { throw Error('Git project grants must be a JSON array of project names') }
  }
  if (!Array.isArray(names) || names.length > 32 || names.some(n => !validWorkspaceName(n) || n.trim() !== n ||
      /[?*:\[\]\p{Cf}\p{Zl}\p{Zp}]/u.test(n)) || new Set(names).size !== names.length) throw Error('Invalid Git project allowlist')
  return Object.freeze([...names])
}

export function gitGrants(catalog, names) {
  const chosen = new Set(gitProjectNames(names))
  // Pin *IDs* from the deployment's initial grant, not eternal authority over whatever may
  // later replace a same-named directory. A newly created/replaced project needs a restart
  // with an intentional operator grant. The bootstrap itself scans no Git metadata.
  const ids = new Set(chosen.size ? catalog.list().filter(p => chosen.has(p.name)).map(p => p.id) : [])
  return Object.freeze({
    enabled: chosen.size > 0,
    pin(wid) {
      if (!ids.has(wid)) throw new HttpError(403, 'git_not_granted')
      return catalog.pinProject(wid)
    }
  })
}
