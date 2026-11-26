// Only the first navigation of a fresh process is classified. Never log a URL, frame ID,
// arbitrary browser error string, response header, site title, or later human input.
const groups = {
  aborted: ['ERR_ABORTED'],
  blocked: ['ERR_BLOCKED_BY_CLIENT', 'ERR_BLOCKED_BY_RESPONSE', 'ERR_BLOCKED_BY_ADMINISTRATOR', 'ERR_ACCESS_DENIED', 'ERR_NETWORK_ACCESS_DENIED'],
  address: ['ERR_INVALID_URL', 'ERR_UNSAFE_PORT', 'ERR_UNKNOWN_URL_SCHEME', 'ERR_ADDRESS_INVALID', 'ERR_ADDRESS_UNREACHABLE'],
  resolution: ['ERR_NAME_NOT_RESOLVED', 'ERR_NAME_RESOLUTION_FAILED'],
  connection: ['ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_FAILED', 'ERR_CONNECTION_RESET', 'ERR_CONNECTION_CLOSED', 'ERR_INTERNET_DISCONNECTED'],
  proxy: ['ERR_PROXY_CONNECTION_FAILED', 'ERR_TUNNEL_CONNECTION_FAILED', 'ERR_NO_SUPPORTED_PROXIES', 'ERR_PROXY_AUTH_REQUESTED'],
  timeout: ['ERR_TIMED_OUT', 'ERR_CONNECTION_TIMED_OUT'],
  certificate: ['ERR_CERT_AUTHORITY_INVALID', 'ERR_CERT_COMMON_NAME_INVALID', 'ERR_CERT_DATE_INVALID', 'ERR_CERT_REVOKED', 'ERR_CERT_INVALID'],
  response: ['ERR_EMPTY_RESPONSE', 'ERR_INVALID_RESPONSE', 'ERR_HTTP_RESPONSE_CODE_FAILURE'],
};
const resultCodes = new Map(Object.entries(groups).flatMap(([group,names]) => names.map(name => [`net::${name}`,group])));
const levels = new Set([...Object.keys(groups), 'none', 'other']);
const frames = new Set(['main', 'other', 'missing']);

export function classifyEntryReceipt(result, expected) {
  const error = result.errorText === undefined || result.errorText === '' ? 'none' : resultCodes.get(result.errorText) ?? 'other';
  const frame = typeof result.frameId !== 'string' || !result.frameId ? 'missing' : result.frameId === expected ? 'main' : 'other';
  return Object.freeze({error,frame,download:result.isDownload===true});
}

export function checkedEntryReceipt(input) {
  if (!input || !levels.has(input.error) || !frames.has(input.frame) || typeof input.download !== 'boolean') return undefined;
  return Object.freeze({error:input.error,frame:input.frame,download:input.download});
}
