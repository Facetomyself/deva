import { workspacePathParts } from './workspace-files-fd.mjs'

// Additional restrictions for human views projected beyond the ordinary file editor.
// Recognizable names/key material only; this is not a generic secrets scanner.
const sensitiveName = /(?:^|[._ -])(?:env|credentials?|secrets?|passwords?|private[-_ ]?keys?|api[-_ ]?keys?|(?:access[-_ ]?|refresh[-_ ]?)?tokens?|id[-_](?:rsa|dsa|ecdsa|ed25519)|known_hosts|authorized_keys|passwd|shadow|htpasswd|kubeconfig|keyrings?|keystores?|netrc|npmrc|pypirc|auth\.json)(?:[._ -]|$)|\.(?:pem|key|p12|pfx|pkcs12|kdbx|jks|keystore|ovpn|ppk)(?:\.|$)/iu
export function disclosurePath(rel) {
  const parts = workspacePathParts(rel)
  if (!parts || parts.some(name => sensitiveName.test(name) || /[\p{Cf}\p{Zl}\p{Zp}]/u.test(name))) return null
  return parts
}

export function sensitiveBytes(bytes) {
  // Check the bounded payload, including keys embedded below a comment or JSON prefix.
  return /(?<!-)-{3,16}\s{0,16}BEGIN [A-Z0-9 -]{0,64}(?:PRIVATE KEY(?: BLOCK)?|PKCS12)\s{0,16}-{3}|PuTTY-User-Key-File-\d+:|"(?:private_key|client_secret|access_token|refresh_token)"\s*:\s*"[^"\r\n]+"/iu.test(bytes.toString('latin1'))
}
