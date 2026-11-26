import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import { openGitIo } from './repository.mjs'
import { inspectGit } from './inspect.mjs'

const known = new Set(['git_unsafe', 'git_stale', 'git_corrupt', 'git_object_unavailable', 'git_limit', 'unsupported_git_layout'])

// This thread only separates bounded SHA/pack/diff computation from the owner HTTP loop. It
// is not a general code sandbox, accepts no script or shell command, and has no model RPC.
if (!isMainThread && parentPort) {
  let io, reply
  try {
    io = openGitIo({ fd: workerData.fd, mount: workerData.mount })
    const result = inspectGit(io, workerData.job)
    if (result instanceof Promise || !result || typeof result !== 'object') throw Error('invalid result')
    io.verify()
    if (Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024) throw Object.assign(Error(), {code:'git_limit'})
    reply = { ok: true, result }
  } catch (error) { reply = { ok: false, error: known.has(error?.code) ? error.code : 'git_unavailable' } }
  finally { try { io?.close() } catch { reply = {ok:false,error:'git_unavailable'} } }
  parentPort.postMessage(reply)
  parentPort.close()
}
