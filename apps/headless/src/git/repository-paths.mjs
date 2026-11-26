import { validWorkspaceName, workspacePathParts } from '../files/workspace-files-fd.mjs'

export const MAX_GIT_DEPTH = 16
const META = new Set(['HEAD', 'packed-refs', 'index', 'shallow', 'MERGE_HEAD'])
export const layoutMarkers = [
  'commondir', 'gitdir', 'reftable', 'objects/info/alternates', 'objects/info/http-alternates',
  'info/grafts', 'refs/replace',
]
const markerPaths = new Set([...META, ...layoutMarkers])
const hex2 = /^[0-9a-f]{2}$/u
const hex38 = /^[0-9a-f]{38}$/u
const packSHA1 = /^pack-[0-9a-f]{40}\.(?:pack|idx)$/u
export const unsupportedPack = /^pack-(?:[0-9a-f]{40}\.promisor|[0-9a-f]{64}\.(?:pack|idx|promisor))$/u

export function validRefComponent(name) {
  return validWorkspaceName(name) && !name.endsWith('.lock') && !name.includes('..') && !name.includes('@{') &&
    !/[ ~^:?*\[\p{Cf}\p{Zl}\p{Zp}]/u.test(name)
}
export function validRefName(ref) {
  if (typeof ref !== 'string' || ref.length > 4095 || Buffer.byteLength(ref) > 4095 || ref.endsWith('.')) return false
  const parts = ref.split('/')
  return parts.length > 1 && parts.every(validRefComponent)
}

function refTree(parts) {
  return parts[0] === 'refs' && (parts[1] === 'heads' || parts[1] === 'remotes') &&
    parts.slice(2).every(validRefComponent)
}

export function metadataPath(rel, mode) {
  if (typeof rel !== 'string' || rel.length > 4095 || Buffer.byteLength(rel) > 4095) return null
  const parts = rel.split('/')
  if (mode === 'marker') {
    return markerPaths.has(rel) || (parts.length === 3 && parts[0] === 'objects' && parts[1] === 'pack' && unsupportedPack.test(parts[2])) ? parts : null
  }
  if (parts.length > MAX_GIT_DEPTH) return null
  if (mode === 'read') {
    if (META.has(rel) || (parts.length >= 3 && refTree(parts) && validRefName(rel))) return parts
    if (parts.length === 3 && parts[0] === 'objects' &&
      ((hex2.test(parts[1]) && hex38.test(parts[2])) || (parts[1] === 'pack' && packSHA1.test(parts[2])))) return parts
  } else if (refTree(parts) || (parts[0] === 'objects' &&
    (parts.length === 1 || (parts.length === 2 && (parts[1] === 'pack' || hex2.test(parts[1])))))) return parts
  return null
}

export function listMetaType(parts, name) {
  if (parts[0] === 'refs') return validRefComponent(name) ? 'either' : undefined
  if (parts.length === 1) return hex2.test(name) || name === 'pack' ? 'dir' : undefined
  return (parts[1] === 'pack' ? packSHA1.test(name) : hex38.test(name)) ? 'file' : undefined
}

const sensitiveName = /(?:^|[._ -])(?:env|credentials?|secrets?|passwords?|private[-_ ]?keys?|api[-_ ]?keys?|(?:access[-_ ]?|refresh[-_ ]?)?tokens?|id[-_](?:rsa|dsa|ecdsa|ed25519)|known_hosts|authorized_keys|passwd|shadow|htpasswd|kubeconfig|keyrings?|keystores?|netrc|npmrc|pypirc|auth\.json)(?:[._ -]|$)|\.(?:pem|key|p12|pfx|pkcs12|kdbx|jks|keystore|ovpn|ppk)(?:\.|$)/iu
export function workPath(rel) {
  const parts = workspacePathParts(rel)
  if (!parts || parts.some(name => sensitiveName.test(name) || /[\p{Cf}\p{Zl}\p{Zp}]/u.test(name))) return null
  return parts
}

export function sensitiveBytes(bytes) {
  // Check the bounded payload, including keys embedded below a comment or JSON prefix.
  return /(?<!-)-{3,16}\s{0,16}BEGIN [A-Z0-9 -]{0,64}(?:PRIVATE KEY(?: BLOCK)?|PKCS12)\s{0,16}-{3}|PuTTY-User-Key-File-\d+:|"(?:private_key|client_secret|access_token|refresh_token)"\s*:\s*"[^"\r\n]+"/iu.test(bytes.toString('latin1'))
}
