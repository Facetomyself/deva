import { constants, openSync } from 'node:fs'
import { HttpError } from '../http/policy.mjs'
import { close, fdPath, stat, workspacePathParts } from '../files/workspace-files-fd.mjs'
import { access, assertFile, onProjectMount, pinWorkspaceDirectory, readBytes, sameVersion, withFilePin } from '../files/workspace-files-pin.mjs'
import { decodeWorkspaceText, workspaceTextRevision } from '../files/workspace-files.mjs'
import { disclosurePath, sensitiveBytes } from '../files/workspace-disclosure.mjs'

const MAX_BYTES = 65536, MAX_LINES = 4096
const changed = () => new HttpError(409,'terminal_source_changed')
const denied = () => new HttpError(403,'terminal_source_denied')
function initialError(error) {
  if (error instanceof HttpError) return error
  if (['ERR_WORKSPACE_UNAVAILABLE','ERR_WORKSPACE_FILE_NOT_FOUND','ENOENT','ESTALE'].includes(error?.code)) return new HttpError(404,'terminal_not_found')
  if (error?.code==='ERR_WORKSPACE_FILE_CONFLICT') return changed()
  if (['ERR_WORKSPACE_FILE_UNSAFE','EACCES','EPERM','ELOOP','ENOTDIR','EISDIR'].includes(error?.code)) return denied()
  return new HttpError(503,'terminal_unavailable')
}
function enoughLines(text) {
  let lines=1
  for (let i=0; i<text.length; i++) if (text.charCodeAt(i)===10 && ++lines>MAX_LINES) return false
  return true
}

/** Capture precisely the saved regular file already selected in the manual workspace editor.
 * Keep its inode, every parent and the granted project pinned. Revalidation checks the current
 * name/permissions/version without rereading private contents or depending on sibling changes. */
export function openTerminalSource(catalog, workspaceId, path, revision) {
  if (typeof workspaceId!=='string' || workspaceId.length!==34 || !workspaceId.startsWith('w_') || /[^a-f0-9]/u.test(workspaceId.slice(2)) ||
      typeof revision!=='string' || revision.length!==66 || !revision.startsWith('r_') || /[^a-f0-9]/u.test(revision.slice(2)) || !workspacePathParts(path)) {
    throw new HttpError(400,'terminal_invalid')
  }
  // The separate process is not a renderer for obvious credential files, even when the
  // owner can read those files in the ordinary editor. These checks do not promise DLP.
  const parts=disclosurePath(path)
  if (!parts) throw denied()
  const name=parts.pop()
  let scope, file, expected, text, released=false
  const release=()=>{
    if (released) return
    released=true; text=undefined
    try { close(file) } finally { scope?.close() }
  }
  try {
    scope=pinWorkspaceDirectory(catalog,workspaceId,parts)
    withFilePin(scope,name,({pin,info})=>{
      if (info.size>BigInt(MAX_BYTES)) throw new HttpError(413,'terminal_limit')
      file=openSync(fdPath(pin),constants.O_RDONLY|constants.O_NONBLOCK)
      onProjectMount(scope.project,file)
      if (!sameVersion(info,stat(file))) throw changed()
      expected=info
      const bytes=readBytes(file,info)
      try {
        assertFile(scope,name,info)
        if (workspaceTextRevision(path,info,bytes)!==revision) throw changed()
        if (sensitiveBytes(bytes)) throw denied()
        text=decodeWorkspaceText(bytes)
        if (text===null) throw new HttpError(422,'terminal_unsupported')
        if (!enoughLines(text)) throw new HttpError(413,'terminal_limit')
      } finally { bytes.fill(0) }
    })
    function verify() {
      if (released) throw changed()
      try {
        assertFile(scope,name,expected)
        if (!sameVersion(expected,stat(file)) || !access(file,expected,constants.R_OK)) throw changed()
      } catch { throw changed() }
    }
    verify()
    // This is private domain data, never the response body. No native name/fd/cwd in it.
    return Object.freeze({get text(){ if(released)throw changed(); return text },verify,close:release})
  } catch (error) { release();throw initialError(error) }
}
