import {
  MAX_ENTRIES, MAX_TREE_BYTES, MAX_TREE_DEPTH, MODE_DIR, MODE_EXEC, MODE_FILE, MODE_GITLINK, MODE_LINK,
  SHA1, displayText, fail, safePath,
} from './inspect-policy.mjs'

const MAX_COMMIT_BYTES = 256 * 1024
const MAX_PARENTS = 128
const HASH_BYTES = 20
const ZERO_OID = '0'.repeat(40)
const BLANK_LINE = Buffer.from('\n\n')
const TREE_MODES = new Map([
  ['40000', MODE_DIR], ['100644', MODE_FILE], ['100755', MODE_EXEC], ['120000', MODE_LINK], ['160000', MODE_GITLINK],
])

export function typedObject(reader, oid, type) {
  if (typeof oid !== 'string' || !SHA1.test(oid)) fail('git_corrupt')
  const object = reader.get(oid)
  if (object == null) fail('git_object_unavailable')
  if (object.type !== type || !Buffer.isBuffer(object.bytes)) fail('git_corrupt')
  return object.bytes
}

function readAuthor(bytes) {
  if (bytes.length > 4096) fail('git_limit')
  const match = /^(.*) <[^<>]*> (-?\d{1,12}) [+-]\d{4}$/.exec(bytes.toString('latin1'))
  if (!match) fail('git_corrupt')
  const timestamp = Number(match[2])
  if (timestamp > 253402300799 || timestamp < -62135596800) fail('git_corrupt')
  return { author: displayText(bytes.subarray(0, match[1].length), 96), timestamp }
}

export function readCommit(reader, oid, includeMetadata = false) {
  const bytes = typedObject(reader, oid, 'commit')
  if (bytes.length > MAX_COMMIT_BYTES) fail('git_limit')
  const body = bytes.indexOf(BLANK_LINE)
  if (body < 0 || bytes[4] !== 0x20 || bytes.toString('latin1', 0, 4) !== 'tree') fail('git_corrupt')
  const tree = bytes.toString('latin1', 5, 45)
  if (!SHA1.test(tree) || tree === ZERO_OID || bytes[45] !== 0x0a) fail('git_corrupt')
  let firstParent = null, parents = 0, offset = 46, authorBytes, hasCommitter = false
  while (offset < body) {
    const lineEnd = bytes.indexOf(0x0a, offset)
    if (lineEnd < 0 || lineEnd > body) fail('git_corrupt')
    if (bytes.subarray(offset, offset + 7).toString('latin1') === 'parent ') {
      const parent = bytes.toString('latin1', offset + 7, lineEnd)
      if (!SHA1.test(parent) || parent === ZERO_OID || authorBytes !== undefined) fail('git_corrupt')
      if (++parents > MAX_PARENTS) fail('git_limit')
      firstParent ??= parent
    } else if (bytes.subarray(offset, offset + 7).toString('latin1') === 'author ') {
      if (authorBytes !== undefined) fail('git_corrupt')
      authorBytes = bytes.subarray(offset + 7, lineEnd)
    } else if (bytes.subarray(offset, offset + 10).toString('latin1') === 'committer ') {
      if (authorBytes === undefined || hasCommitter) fail('git_corrupt')
      hasCommitter = true
    }
    offset = lineEnd + 1
  }
  if (authorBytes === undefined || !hasCommitter) fail('git_corrupt')
  if (!includeMetadata) return { tree }
  const nextLine = bytes.indexOf(0x0a, body + 2)
  const subject = displayText(bytes.subarray(body + 2, nextLine < 0 ? bytes.length : nextLine), 160)
  return { firstParent, cost: bytes.length, row: { oid, short: oid.slice(0, 7), subject, ...readAuthor(authorBytes) } }
}

export function readHeadTree(reader, head) {
  const entries = new Map()
  let excluded = false, count = 0, total = 0
  if (head === null) return { entries, excluded }
  const { tree } = readCommit(reader, head)
  function walk(oid, prefix, depth) {
    if (depth > MAX_TREE_DEPTH) fail('git_limit')
    const bytes = typedObject(reader, oid, 'tree')
    total += bytes.length
    if (total > MAX_TREE_BYTES) fail('git_limit')
    const siblings = new Set()
    for (let at = 0; at < bytes.length;) {
      if (++count > MAX_ENTRIES) fail('git_limit')
      const space = bytes.indexOf(0x20, at)
      if (space < 0 || space - at > 6) fail('git_corrupt')
      const mode = TREE_MODES.get(bytes.toString('latin1', at, space))
      const nul = bytes.indexOf(0, space + 1)
      if (!mode || nul <= space + 1 || bytes.length - nul <= HASH_BYTES) fail('git_corrupt')
      const name = bytes.subarray(space + 1, nul)
      if (name.includes(0x2f)) fail('git_corrupt')
      const key = name.toString('hex')
      if (siblings.has(key)) fail('git_corrupt')
      siblings.add(key)
      const entryOid = bytes.toString('hex', nul + 1, nul + 1 + HASH_BYTES)
      if (entryOid === ZERO_OID) fail('git_corrupt')
      at = nul + 1 + HASH_BYTES
      // A visible parent was already decoded; join through bytes so each raw leaf is validated.
      const rel = safePath(prefix ? Buffer.concat([Buffer.from(`${prefix}/`), name]) : name)
      if (rel === null) {
        excluded = true
      } else if (mode === MODE_DIR) {
        walk(entryOid, rel, depth + 1)
      } else {
        entries.set(rel, { mode, oid: entryOid })
      }
    }
  }
  walk(tree, '', 1)
  return { entries, excluded }
}
