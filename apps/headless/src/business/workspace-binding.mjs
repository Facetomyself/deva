import { HttpError } from '../http/policy.mjs'

const project = /^w_[a-f0-9]{32}$/u

/** Resolve an ID against the currently mounted catalog. The callback is synchronous and
 * server-internal: it receives the native root only for the desktop file format. Nothing
 * here grants a conversation or its model directory, Git, shell or note access. */
export function workspaceBindingResolver(catalog) {
  return function withWorkspace(id, action) {
    if (typeof id !== 'string' || id.length !== 34 || !project.test(id) || typeof action !== 'function') return undefined
    let lease
    try { lease = catalog.pinProject(id) }
    catch (error) { if (error?.code === 'ERR_WORKSPACE_UNAVAILABLE') return undefined; throw new HttpError(503, 'workspace_catalog_unavailable') }
    try {
      lease.assertCurrent()
      const result = action(Object.freeze({ id: lease.id, name: lease.name, root: lease.root }))
      if (result && typeof result.then === 'function') throw new TypeError('Workspace grant operation must be synchronous')
      lease.assertCurrent()
      return result
    } catch (error) {
      if (error?.code === 'ERR_WORKSPACE_UNAVAILABLE') throw new HttpError(409,'workspace_changed')
      throw error
    } finally { lease.close() }
  }
}
