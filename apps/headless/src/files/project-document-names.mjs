import { HttpError } from '../http/policy.mjs'
import { disclosurePath, sensitiveBytes } from './workspace-disclosure.mjs'
import { validWorkspaceName, workspacePathParts } from './workspace-files-fd.mjs'
import { decodeWorkspaceText } from './workspace-files.mjs'

const status = Object.freeze({
  auth: 401, document_invalid: 400, document_read_only: 403, document_unsafe: 403,
  workspace_unavailable: 404, document_exists: 409, document_changed: 409,
  document_limit: 413, document_restricted: 422, document_unconfirmed: 503,
})
export class ProjectDocumentError extends HttpError {
  constructor(code) { super(status[code], code) }
}
export const rejectDocument = code => { throw new ProjectDocumentError(code) }
export const PROJECT_DOCUMENT_MAX_BYTES = 2 * 1024 * 1024
const MAX_NAME_BYTES = 200
const extension = /\.(?:md|txt)$/i
const windows = /[<>:"|?*\/\\]|~[0-9]+(?:\.|$)/u
const device = /^(?:aux|clock\$|con|conin\$|conout\$|nul|prn|(?:com|lpt)[0-9])(?:\s*[.]|\s*$)/iu
const invisible = /[\p{C}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u
const ambiguous = /^[.\s]|[.\s]$/u
const instruction = /^(?:agents|claude|gemini|skill|instructions|copilot-instructions|cursor-rules|codex|opencode)(?:[.]|$)/iu
const control = /^(?:dockerfile|containerfile|makefile|gnumakefile|justfile|jenkinsfile|procfile|vagrantfile|codeowners|autorun)(?:[.]|$)/iu
const executable = /\.(?:app|apk|bash|bat|bin|cmd|com|cpl|deb|desktop|dll|dmg|exe|fish|hta|html?|ini|ins|jar|js|jse|jsx|lnk|lua|mjs|msi|msp|nsh|php|pl|ps1|py|rb|reg|rpm|scr|sh|svg|sys|ts|tsx|url|vbe|vbs|wsf|zsh)(?:\s*[.]|\s*$)/iu
const extraSensitiveName = /^(?:auth|key|keyfiles?|ssh[-_ ]config)(?:[._ -]|$)/iu
const recognizableCredential = /\b(?:gh[pousr]_[a-zA-Z0-9]{30,}|github_pat_[a-zA-Z0-9_]{30,}|glpat-[a-zA-Z0-9_-]{20,}|xox[baprs]-[a-zA-Z0-9-]{20,}|sk-(?:proj-|svcacct-)?[a-zA-Z0-9_-]{24,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/u
const credentialAssignment = /^[\t ]*(?:export[\t ]+)?(?:[A-Z0-9]+_)*(?:PRIVATE_KEY|API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|AUTH_TOKEN|CLIENT_SECRET|SECRET_ACCESS_KEY)[\t ]*=[\t ]*["']?[a-z0-9_+/=-]{16,}/imu

// Conservative compatibility/case key for an advisory scan on case-sensitive mounts.
// Exact no-clobber is still enforced by the kernel at the final link operation.
export const documentNameKey = name => name.normalize('NFKC').toLowerCase().toUpperCase().trimEnd().replace(/[. ]+$/u, '')

export function assertDocumentDisclosure(parts) {
  if (parts.length && (!disclosurePath(parts.join('/')) || parts.some(part => {
    const folded = part.normalize('NFKC')
    return invisible.test(part) || !disclosurePath(folded) || extraSensitiveName.test(folded)
  }))) rejectDocument('document_restricted')
}

export function projectDocumentPath(input) {
  const { directory, name } = input ?? {}
  const parts = workspacePathParts(directory, true)
  if (!parts || typeof name !== 'string' || !name.isWellFormed()) rejectDocument('document_invalid')
  if (Buffer.byteLength(name) > MAX_NAME_BYTES) rejectDocument('document_limit')
  if (!validWorkspaceName(name) || !extension.test(name) || invisible.test(name)) rejectDocument('document_invalid')
  const folded = name.normalize('NFKC')
  const stem = folded.replace(extension, '')
  if (!stem || ambiguous.test(stem) || windows.test(folded) || device.test(folded)) rejectDocument('document_invalid')
  if (instruction.test(stem) || control.test(stem) || executable.test(stem)) rejectDocument('document_restricted')
  const segments = [...parts, name]
  const path = segments.join('/')
  if (!workspacePathParts(path)) rejectDocument('document_limit')
  assertDocumentDisclosure(segments)
  return { parts, name, path }
}

export function projectDocumentBytes(content) {
  if (typeof content !== 'string') rejectDocument('document_invalid')
  if (content.length > PROJECT_DOCUMENT_MAX_BYTES || Buffer.byteLength(content) > PROJECT_DOCUMENT_MAX_BYTES) {
    rejectDocument('document_limit')
  }
  if (!content.isWellFormed()) rejectDocument('document_invalid')
  const bytes = Buffer.from(content)
  if (decodeWorkspaceText(bytes) === null) rejectDocument('document_invalid')
  if (sensitiveBytes(bytes) || recognizableCredential.test(content) || credentialAssignment.test(content)) {
    rejectDocument('document_restricted')
  }
  return bytes
}
