import { isIP } from 'node:net'

const namePattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i
const tokenPattern = /^[!#$%&'*+.^_`|~\-0-9a-z]+$/i
const hopHeaders = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization',
  'proxy-authentication-info', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'forwarded', 'via', 'x-real-ip',
])

/** A single, unambiguous HTTP authority. Equivalent default ports, host case and IPv6 spellings normalize. */
export function authority(raw, protocol, explicitPort = false) {
  if (typeof raw !== 'string' || !['http:', 'https:'].includes(protocol)) return null
  const match = /^(\[[a-f0-9:.]+\]|[a-z0-9.-]+)(?::([1-9][0-9]{0,4}))?$/i.exec(raw)
  if (!match || match[0] !== raw || (explicitPort && !match[2]) || Number(match[2]) > 65535) return null
  const name = match[1].toLowerCase()
  const ipv6 = name.startsWith('[')
  if (ipv6 ? isIP(name.slice(1, -1)) !== 6 : name.length > 253 || !namePattern.test(name)) return null
  try {
    const url = new URL(`${protocol}//${raw}`)
    // URL accepts numeric IPv4 aliases such as 127.1, 2130706433 and 0x7f000001.
    if (!ipv6 && url.hostname !== name) return null
    return {
      origin: url.origin, protocol, host: url.host,
      hostname: ipv6 ? url.hostname.slice(1, -1) : url.hostname,
      port: Number(url.port || (protocol === 'https:' ? 443 : 80)),
    }
  } catch {
    return null
  }
}

export function absoluteTarget(raw) {
  if (typeof raw !== 'string' || /[\x00-\x20\x7f-\uffff\\#]/.test(raw)) return null
  const match = /^(https?):\/\/([^/?]+)([/?].*)?$/i.exec(raw)
  if (!match) return null
  const dest = authority(match[2], `${match[1].toLowerCase()}:`)
  if (!dest) return null
  const tail = match[3] || '/'
  return { ...dest, path: tail.startsWith('/') ? tail : `/${tail}` }
}

export function headerValues(message, key) {
  const values = []
  for (let i = 0; i < message.rawHeaders.length; i += 2) {
    if (message.rawHeaders[i].toLowerCase() === key) values.push(message.rawHeaders[i + 1])
  }
  return values
}

export function requestDestination(req, connect = false) {
  const dest = connect ? authority(req.url, 'https:', true) : absoluteTarget(req.url)
  if (!dest) return null
  const hosts = headerValues(req, 'host')
  if (hosts.length !== 1 || authority(hosts[0], dest.protocol)?.origin !== dest.origin) return null
  return dest
}

export function endToEndHeaders(message) {
  const nominated = new Set()
  for (const key of ['connection', 'proxy-connection']) {
    for (const value of headerValues(message, key)) {
      for (const part of value.split(',')) {
        const name = part.trim().toLowerCase()
        if (!name) continue
        if (!tokenPattern.test(name)) return null
        nominated.add(name)
      }
    }
  }
  const headers = Object.create(null)
  for (const [name, value] of Object.entries(message.headers)) {
    if (!hopHeaders.has(name) && !nominated.has(name) && !name.startsWith('x-forwarded-')) headers[name] = value
  }
  return headers
}
