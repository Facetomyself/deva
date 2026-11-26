import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

// Keep the browser policy separate from the model-provider egress and its credentials.
const public6 = new BlockList()
const private4 = new BlockList()
const private6 = new BlockList()
const loopback6 = new BlockList()
const blocked4 = new BlockList()
const blocked6 = new BlockList()
const metadataNames = new Set(['metadata', 'metadata.google.internal', 'metadata.azure.internal', 'instance-data', 'instance-data.ec2.internal'])
for (const [address, bits] of [['10.0.0.0', 8], ['100.64.0.0', 10], ['172.16.0.0', 12], ['192.168.0.0', 16]]) private4.addSubnet(address, bits)
for (const [address, bits] of [
  ['0.0.0.0', 8], ['100.100.100.200', 32], ['168.63.129.16', 32], ['169.254.0.0', 16],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked4.addSubnet(address, bits)
private6.addSubnet('fc00::', 7, 'ipv6')
loopback6.addAddress('::1', 'ipv6')
public6.addSubnet('2000::', 3, 'ipv6')
for (const [address, bits] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20], ['fd00:ec2::', 32], ['fd20:ce::254', 128],
]) blocked6.addSubnet(address, bits, 'ipv6')

function addressClass(record) {
  if (typeof record?.address !== 'string' || record.address.includes('%') || isIP(record.address) !== record.family) return null
  if (record.family === 4) {
    if (blocked4.check(record.address)) return null
    if (record.address.startsWith('127.')) return 'loopback'
    return private4.check(record.address) ? 'private' : 'public'
  }
  if (record.family === 6) {
    if (blocked6.check(record.address, 'ipv6')) return null
    if (loopback6.check(record.address, 'ipv6')) return 'loopback'
    if (private6.check(record.address, 'ipv6')) return 'private'
    return public6.check(record.address, 'ipv6') ? 'public' : null
  }
  return null
}

export function selectAddress(records, privateAllowed) {
  if (!Array.isArray(records) || records.length === 0 || records.length > 64) return null
  const firstClass = addressClass(records[0])
  if (!firstClass || (firstClass !== 'public' && !privateAllowed)) return null
  for (const record of records) if (addressClass(record) !== firstClass) return null
  return { address: records[0].address, family: records[0].family }
}

let pendingLookups = 0

export async function pinnedAddress(hostname, privateAllowed, signal) {
  signal.throwIfAborted()
  if (metadataNames.has(hostname)) return null
  const family = isIP(hostname)
  if (family) return selectAddress([{ address: hostname, family }], privateAllowed)
  // getaddrinfo itself is not abortable. Bound outstanding OS jobs separately from
  // the proxy operations, which can end sooner on timeout/client disconnect.
  if (pendingLookups >= 16) throw new Error('DNS operation limit reached')
  pendingLookups++
  const records = await new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    lookup(hostname, { all: true, order: 'verbatim' }).then(resolve, reject).finally(() => {
      pendingLookups--
      signal.removeEventListener('abort', abort)
    })
  })
  signal.throwIfAborted()
  return selectAddress(records, privateAllowed)
}
