import { performance } from 'node:perf_hooks'
import { inflateRawSync } from 'node:zlib'

const MiB = 1024 * 1024
const maxArchive = 8 * MiB
const maxExpanded = 32 * MiB
const maxEntries = 512
const maxPart = 8 * MiB
const maxRaster = 2 * MiB
const maxMetadata = 4 * MiB
const maxManifest = 256 * 1024
const maxRelationships = 128 * 1024
const maxMain = 2 * MiB
const maxRatio = 250
const maxXmlNodes = 60_000
const maxXmlDepth = 96
const maxAttributes = 96
const maxPath = 240
const maxExtra = 256
const maxWorkMs = 250

const contentTypes = '[Content_Types].xml'
const rootRelationships = '_rels/.rels'
const schemas = 'http://schemas.openxmlformats.org/'
const strict = 'http://purl.oclc.org/ooxml/'
const packageTypes = `${schemas}package/2006/content-types`
const packageRels = `${schemas}package/2006/relationships`
const officeRels = `${schemas}officeDocument/2006/relationships`
const strictOfficeRels = `${strict}officeDocument/relationships`
const appType = 'application/vnd.openxmlformats-officedocument.'
const zipType = 'application/vnd.openxmlformats-package.'
const msType = 'application/vnd.ms-'
const wordType = `${appType}wordprocessingml.`
const excelType = `${appType}spreadsheetml.`
const pptType = `${appType}presentationml.`
const relsType = `${zipType}relationships+xml`
const xmlNamespace = 'http://www.w3.org/XML/1998/namespace'
const xmlnsNamespace = 'http://www.w3.org/2000/xmlns/'
const decodeUtf8 = new TextDecoder('utf-8', { fatal: true })
const bad = Symbol('Invalid or unsupported Office package')
const requireThat = valid => { if (!valid) throw bad }
const checkTime = state => requireThat(performance.now() <= state.deadline)

const formats = new Map([
  ['.docx', {
    mime: `${wordType}document`, main: 'word/document.xml', type: `${wordType}document.main+xml`,
    root: 'document', namespace: 'wordprocessingml', folder: 'word', parts: [
      [/^styles\.xml$/u, 'styles', `${wordType}styles+xml`],
      [/^stylesWithEffects\.xml$/u, 'stylesWithEffects', `${msType}word.stylesWithEffects+xml`],
      [/^numbering\.xml$/u, 'numbering', `${wordType}numbering+xml`],
      [/^settings\.xml$/u, 'settings', `${wordType}settings+xml`],
      [/^webSettings\.xml$/u, 'webSettings', `${wordType}webSettings+xml`],
      [/^fontTable\.xml$/u, 'fontTable', `${wordType}fontTable+xml`],
      [/^footnotes\.xml$/u, 'footnotes', `${wordType}footnotes+xml`],
      [/^endnotes\.xml$/u, 'endnotes', `${wordType}endnotes+xml`],
      [/^comments\.xml$/u, 'comments', `${wordType}comments+xml`],
      [/^header[1-9][0-9]*\.xml$/u, 'header', `${wordType}header+xml`],
      [/^footer[1-9][0-9]*\.xml$/u, 'footer', `${wordType}footer+xml`],
    ],
  }],
  ['.xlsx', {
    mime: `${excelType}sheet`, main: 'xl/workbook.xml', type: `${excelType}sheet.main+xml`,
    root: 'workbook', namespace: 'spreadsheetml', folder: 'xl', parts: [
      [/^worksheets\/sheet[1-9][0-9]*\.xml$/u, 'worksheet', `${excelType}worksheet+xml`],
      [/^styles\.xml$/u, 'styles', `${excelType}styles+xml`],
      [/^sharedStrings\.xml$/u, 'sharedStrings', `${excelType}sharedStrings+xml`],
      [/^calcChain\.xml$/u, 'calcChain', `${excelType}calcChain+xml`],
      [/^tables\/table[1-9][0-9]*\.xml$/u, 'table', `${excelType}table+xml`],
      [/^drawings\/drawing[1-9][0-9]*\.xml$/u, 'drawing', `${appType}drawing+xml`],
    ],
  }],
  ['.pptx', {
    mime: `${pptType}presentation`, main: 'ppt/presentation.xml', type: `${pptType}presentation.main+xml`,
    root: 'presentation', namespace: 'presentationml', folder: 'ppt', parts: [
      [/^slides\/slide[1-9][0-9]*\.xml$/u, 'slide', `${pptType}slide+xml`],
      [/^slideLayouts\/slideLayout[1-9][0-9]*\.xml$/u, 'slideLayout', `${pptType}slideLayout+xml`],
      [/^slideMasters\/slideMaster[1-9][0-9]*\.xml$/u, 'slideMaster', `${pptType}slideMaster+xml`],
      [/^notesSlides\/notesSlide[1-9][0-9]*\.xml$/u, 'notesSlide', `${pptType}notesSlide+xml`],
      [/^notesMasters\/notesMaster[1-9][0-9]*\.xml$/u, 'notesMaster', `${pptType}notesMaster+xml`],
      [/^handoutMasters\/handoutMaster[1-9][0-9]*\.xml$/u, 'handoutMaster', `${pptType}handoutMaster+xml`],
      [/^presProps\.xml$/u, 'presProps', `${pptType}presProps+xml`],
      [/^viewProps\.xml$/u, 'viewProps', `${pptType}viewProps+xml`],
      [/^tableStyles\.xml$/u, 'tableStyles', `${pptType}tableStyles+xml`],
    ],
  }],
])
const commonParts = new Map([
  ['docProps/core.xml', ['core', `${zipType}core-properties+xml`]],
  ['docProps/app.xml', ['extended-properties', `${appType}extended-properties+xml`]],
  ['docProps/custom.xml', ['custom-properties', `${appType}custom-properties+xml`]],
])
const rasterTypes = new Map([['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg']])

const segmentIsSafe = segment => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u.test(segment) && !segment.endsWith('.')

function pathIsSafe(path) {
  return path.length <= maxPath && (path === contentTypes || path === rootRelationships ||
    path.split('/').every(segmentIsSafe))
}

function checkExtra(bytes, start, length, local) {
  requireThat(length <= maxExtra)
  const end = start + length
  const fields = new Set()
  for (let at = start; at < end;) {
    requireThat(at + 4 <= end)
    const tag = bytes.readUInt16LE(at)
    const size = bytes.readUInt16LE(at + 2)
    at += 4
    requireThat(at + size <= end && !fields.has(tag))
    fields.add(tag)
    // Only two metadata extras that cannot change names, sizes, or file types.
    if (tag === 0x5455) {
      requireThat(size >= 1)
      const flags = bytes[at]
      requireThat((flags & ~7) === 0)
      const count = (flags & 1) + ((flags >> 1) & 1) + ((flags >> 2) & 1)
      requireThat(size === 1 + 4 * (local ? count : flags & 1))
    } else if (tag === 0x7875) {
      requireThat(size >= 5 && bytes[at] === 1)
      const uidSize = bytes[at + 1]
      requireThat(uidSize >= 1 && uidSize <= 8 && 3 + uidSize < size)
      const gidSize = bytes[at + 2 + uidSize]
      requireThat(gidSize >= 1 && gidSize <= 8 && size === 3 + uidSize + gidSize)
    } else {
      throw bad
    }
    at += size
  }
}

function readCentral(bytes, state) {
  // Require a single ordinary ZIP, with no prefix, suffix, comments, or Zip64.
  const end = bytes.length - 22
  requireThat(end >= 0 && bytes.readUInt32LE(end) === 0x06054b50 && bytes.readUInt32LE(end + 4) === 0 &&
    bytes.readUInt16LE(end + 20) === 0)
  const count = bytes.readUInt16LE(end + 10)
  const start = bytes.readUInt32LE(end + 16)
  requireThat(count >= 3 && count <= maxEntries && count === bytes.readUInt16LE(end + 8) &&
    start > 0 && start + bytes.readUInt32LE(end + 12) === end)

  const entries = new Map()
  const names = new Set()
  let expanded = 0
  let at = start
  for (let index = 0; index < count; index++) {
    checkTime(state)
    requireThat(at + 46 <= end && bytes.readUInt32LE(at) === 0x02014b50)
    const version = bytes.readUInt16LE(at + 6)
    const flags = bytes.readUInt16LE(at + 8)
    const method = bytes.readUInt16LE(at + 10)
    const date = bytes.readUInt32LE(at + 12)
    const crc = bytes.readUInt32LE(at + 16)
    const compressed = bytes.readUInt32LE(at + 20)
    const size = bytes.readUInt32LE(at + 24)
    const nameLength = bytes.readUInt16LE(at + 28)
    const extra = bytes.readUInt16LE(at + 30)
    const attrs = bytes.readUInt32LE(at + 38)
    const offset = bytes.readUInt32LE(at + 42)
    const next = at + 46 + nameLength + extra
    requireThat(version >= 10 && version <= 20 && (flags & ~0x080e) === 0 &&
      (method === 8 || (method === 0 && (flags & 6) === 0 && compressed === size)) &&
      nameLength > 0 && nameLength <= maxPath + 1 && next <= end &&
      bytes.readUInt32LE(at + 32) === 0 && bytes.readUInt16LE(at + 36) <= 1 && offset < start &&
      size <= maxPart && compressed <= maxArchive && size <= maxRatio * compressed)
    expanded += size
    requireThat(expanded <= maxExpanded)
    const rawName = bytes.subarray(at + 46, at + 46 + nameLength)
    const name = rawName.toString('latin1')
    const directory = name.endsWith('/')
    const path = directory ? name.slice(0, -1) : name
    const key = path.toLowerCase()
    const fileType = (attrs >>> 28) & 15
    const dosAttrs = attrs & 0xffff
    requireThat(pathIsSafe(path) && !names.has(key) && (dosAttrs & ~0x37) === 0 &&
      (fileType === 0 || fileType === (directory ? 4 : 8)) &&
      (directory ? (size === 0 && method === 0 && crc === 0) : (dosAttrs & 16) === 0 && size > 0))
    checkExtra(bytes, at + 46 + nameLength, extra, false)
    names.add(key)
    entries.set(name, { rawName, directory, offset, version, flags, method, date, crc, compressed, size })
    at = next
  }
  requireThat(at === end)
  return { entries, start }
}

function readLocals(bytes, entries, start, state) {
  const sorted = [...entries.values()].sort((a, b) => a.offset - b.offset)
  requireThat(sorted[0].offset === 0)
  for (let i = 0; i < sorted.length; i++) {
    checkTime(state)
    const entry = sorted[i]
    const { offset, version, flags, method, date, rawName, crc, compressed, size } = entry
    const end = i + 1 < sorted.length ? sorted[i + 1].offset : start
    requireThat(offset + 30 <= end && bytes.readUInt32LE(offset) === 0x04034b50 &&
      bytes.readUInt16LE(offset + 4) === version && bytes.readUInt16LE(offset + 6) === flags &&
      bytes.readUInt16LE(offset + 8) === method && bytes.readUInt32LE(offset + 10) === date &&
      bytes.readUInt16LE(offset + 26) === rawName.length)
    const extra = bytes.readUInt16LE(offset + 28)
    const header = offset + 30 + rawName.length + extra
    const dataEnd = header + compressed
    requireThat(dataEnd <= end && rawName.equals(bytes.subarray(offset + 30, offset + 30 + rawName.length)))
    checkExtra(bytes, offset + 30 + rawName.length, extra, true)
    const matches = pos => bytes.readUInt32LE(pos) === crc && bytes.readUInt32LE(pos + 4) === compressed &&
      bytes.readUInt32LE(pos + 8) === size
    if (flags & 8) {
      requireThat(matches(offset + 14) || (bytes.readUInt32LE(offset + 14) === 0 &&
        bytes.readUInt32LE(offset + 18) === 0 && bytes.readUInt32LE(offset + 22) === 0))
      requireThat((end - dataEnd === 12 && matches(dataEnd)) || (end - dataEnd === 16 &&
        bytes.readUInt32LE(dataEnd) === 0x08074b50 && matches(dataEnd + 4)))
    } else {
      requireThat(dataEnd === end && matches(offset + 14))
    }
    entry.start = header
    entry.end = dataEnd
  }
}

// Use a local CRC to support Node 22.0 as well as versions with zlib.crc32().
const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  for (let bit = 0; bit < 8; bit++) i = (i >>> 1) ^ ((i & 1) ? 0xedb88320 : 0)
  return i
})

function readStructure(bytes, entry, limit, state) {
  checkTime(state)
  requireThat(entry && entry.size <= limit && entry.compressed <= limit)
  state.metadata += entry.size
  requireThat(state.metadata <= maxMetadata)
  const input = bytes.subarray(entry.start, entry.end)
  let data = input
  if (entry.method === 8) {
    // maxOutputLength is enforced by zlib's synchronous wrapper; info confirms
    // exactly one raw deflate stream consumed the entire ZIP member.
    const { buffer, engine } = inflateRawSync(input, { maxOutputLength: entry.size, info: true })
    requireThat(engine.bytesWritten === input.length)
    data = buffer
  }
  requireThat(data.length === entry.size)
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ data[i]) & 255]
  requireThat((~crc >>> 0) === entry.crc)
  checkTime(state)
  return data
}

const xmlChars = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u
const whitespace = /[ \t\r\n]*/uy
const xmlName = /[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?/uy
const xmlDeclaration = /<\?xml[ \t\r\n]+version[ \t\r\n]*=[ \t\r\n]*(?:"1\.0"|'1\.0')(?:[ \t\r\n]+encoding[ \t\r\n]*=[ \t\r\n]*(?:"[Uu][Tt][Ff]-8"|'[Uu][Tt][Ff]-8'))?(?:[ \t\r\n]+standalone[ \t\r\n]*=[ \t\r\n]*(?:"(?:yes|no)"|'(?:yes|no)'))?[ \t\r\n]*\?>/uy
const entity = /&(?:amp|lt|gt|apos|quot|#[0-9]{1,7}|#x[0-9A-Fa-f]{1,6});/uy
const references = new Map([['&amp;', '&'], ['&lt;', '<'], ['&gt;', '>'], ['&quot;', '"'], ['&apos;', "'"]])

function xmlValue(value, decoded) {
  let start = 0
  let result = ''
  for (let at = value.indexOf('&'); at !== -1; at = value.indexOf('&', start)) {
    entity.lastIndex = at
    const match = entity.exec(value)?.[0]
    requireThat(match)
    let character = references.get(match)
    if (character === undefined) {
      const hex = match[2] === 'x'
      const code = Number.parseInt(match.slice(hex ? 3 : 2, -1), hex ? 16 : 10)
      requireThat(code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0xd7ff) ||
        (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff))
      if (decoded) character = String.fromCodePoint(code)
    }
    if (decoded) result += value.slice(start, at) + character
    start = entity.lastIndex
  }
  return decoded ? result + value.slice(start) : undefined
}

function qualified(name, bindings, attribute) {
  const colon = name.indexOf(':')
  if (colon === -1) return [attribute ? '' : bindings[''] ?? '', name]
  const prefix = name.slice(0, colon)
  const namespace = bindings[prefix]
  requireThat(namespace && prefix !== 'xmlns')
  return [namespace, name.slice(colon + 1)]
}

// Parse just bounded UTF-8 XML. DTDs, custom entities and processing instructions
// have no role here; there is no entity resolver or external I/O.
function readXml(data, state, { element, strictNodes = false }) {
  const xml = decodeUtf8.decode(data)
  requireThat(!xmlChars.test(xml))
  const stack = []
  const base = Object.assign(Object.create(null), { xml: xmlNamespace })
  let root = false
  let at = 0
  function take(pattern) {
    pattern.lastIndex = at
    const value = pattern.exec(xml)?.[0]
    if (value !== undefined) at = pattern.lastIndex
    return value
  }
  if (xml.startsWith('<?xml')) requireThat(take(xmlDeclaration))
  while (at < xml.length) {
    requireThat(++state.nodes <= maxXmlNodes)
    if ((state.nodes & 127) === 0) checkTime(state)
    if (xml[at] !== '<') {
      const next = xml.indexOf('<', at)
      const value = xml.slice(at, next === -1 ? xml.length : next)
      if (stack.length === 0 || strictNodes) requireThat(/^[ \t\r\n]*$/u.test(value))
      else {
        requireThat(!value.includes(']]>'))
        xmlValue(value, false)
      }
      at += value.length
      continue
    }
    if (xml.startsWith('<!--', at)) {
      const end = xml.indexOf('--', at + 4)
      requireThat(end !== -1 && xml[end + 2] === '>')
      at = end + 3
      continue
    }
    if (xml.startsWith('<![CDATA[', at)) {
      requireThat(!strictNodes && stack.length > 0)
      const end = xml.indexOf(']]>', at + 9)
      requireThat(end !== -1)
      at = end + 3
      continue
    }
    at++
    if (xml[at] === '/') {
      at++
      const name = take(xmlName)
      take(whitespace)
      requireThat(name && stack.pop()?.name === name && xml[at++] === '>')
      continue
    }
    const name = take(xmlName)
    requireThat(name && stack.length < maxXmlDepth)
    if (!stack.length) {
      requireThat(!root)
      root = true
    }
    const inherited = stack.at(-1)?.bindings ?? base
    let bindings = inherited
    const raw = new Map()
    let closed = false
    for (;;) {
      const space = take(whitespace).length
      if (xml[at] === '>') { at++; break }
      if (xml.startsWith('/>', at)) { at += 2; closed = true; break }
      const attr = take(xmlName)
      requireThat(space && attr && attr.length <= maxPath && !raw.has(attr) && raw.size < maxAttributes)
      take(whitespace)
      requireThat(xml[at++] === '=')
      take(whitespace)
      const quote = xml[at++]
      requireThat(quote === '"' || quote === "'")
      const end = xml.indexOf(quote, at)
      requireThat(end !== -1 && end - at <= 16 * 1024)
      const value = xml.slice(at, end)
      requireThat(!value.includes('<'))
      const normalized = xmlValue(value.replace(/\r\n?|\n|\t/gu, ' '), true)
      at = end + 1
      raw.set(attr, normalized)
      if (attr === 'xmlns' || attr.startsWith('xmlns:')) {
        const prefix = attr === 'xmlns' ? '' : attr.slice(6)
        requireThat(prefix !== 'xmlns' && normalized !== xmlnsNamespace &&
          (normalized === xmlNamespace) === (prefix === 'xml') &&
          (!prefix || normalized) && normalized.length <= maxPath && !/[ \t\r\n]/u.test(normalized))
        if (bindings === inherited) bindings = Object.create(inherited)
        bindings[prefix] = normalized
      }
    }
    const attrs = new Map()
    for (const [attr, value] of raw) {
      if (attr === 'xmlns' || attr.startsWith('xmlns:')) continue
      const [namespace, local] = qualified(attr, bindings, true)
      const key = namespace ? `{${namespace}}${local}` : local
      requireThat(!attrs.has(key))
      attrs.set(key, value)
    }
    const [namespace, local] = qualified(name, bindings, false)
    element(namespace, local, attrs, stack.length)
    if (!closed) stack.push({ name, bindings })
  }
  requireThat(root && stack.length === 0)
  checkTime(state)
}

function validatedAttrs(attrs, names, optional) {
  requireThat(names.every(name => attrs.has(name)) &&
    (attrs.size === names.length || (optional && attrs.size === names.length + 1 && attrs.has(optional))))
}

function memberType(format, name) {
  if (name === format.main) return ['officeDocument', format.type]
  const common = commonParts.get(name)
  if (common) return common
  const extension = name.slice(name.lastIndexOf('.') + 1)
  const raster = rasterTypes.get(extension)
  if (raster && /^docProps\/thumbnail\.(?:png|jpe?g)$/u.test(name)) return ['thumbnail', raster]
  if (!name.startsWith(`${format.folder}/`)) return null
  const inFolder = name.slice(format.folder.length + 1)
  if (raster && /^media\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:png|jpe?g)$/u.test(inFolder)) return ['image', raster]
  if (/^theme\/theme[1-9][0-9]*\.xml$/u.test(inFolder)) return ['theme', `${appType}theme+xml`]
  if (/^charts\/chart[1-9][0-9]*\.xml$/u.test(inFolder)) return ['chart', `${appType}drawingml.chart+xml`]
  for (const [pattern, role, type] of format.parts) {
    if (pattern.test(inFolder)) return [role, type]
  }
  return null
}

function indexParts(entries, format) {
  const parts = new Map()
  const relations = new Map()
  requireThat(entries.get(contentTypes)?.directory === false && entries.get(format.main)?.directory === false &&
    entries.get(rootRelationships)?.directory === false)
  const neededDirs = new Set()
  for (const [name, entry] of entries) {
    if (entry.directory || name === contentTypes) continue
    for (let slash = name.indexOf('/'); slash !== -1; slash = name.indexOf('/', slash + 1)) {
      neededDirs.add(name.slice(0, slash + 1))
    }
    if (name === rootRelationships) {
      relations.set('', name)
    } else {
      const relationship = /^(.*\/)?_rels\/([^/]+\.xml)\.rels$/u.exec(name)
      if (relationship) relations.set((relationship[1] ?? '') + relationship[2], name)
      else {
        const part = memberType(format, name)
        requireThat(part && (!(part[1].startsWith('image/')) || entry.size <= maxRaster))
        parts.set(name, part)
      }
    }
  }
  for (const [name, entry] of entries) if (entry.directory) requireThat(neededDirs.has(name))
  for (const source of relations.keys()) if (source) {
    const part = parts.get(source)
    requireThat(part?.[1].endsWith('+xml'))
  }
  return { parts, relations }
}

function readManifest(bytes, entries, parts, relations, state) {
  const defaults = new Map()
  const overrides = new Map()
  const expected = new Map(Array.from(parts, ([name, part]) => [name, part[1]]))
  for (const name of relations.values()) expected.set(name, relsType)
  readXml(readStructure(bytes, entries.get(contentTypes), maxManifest, state), state, {
    strictNodes: true,
    element(namespace, local, attrs, depth) {
      requireThat(namespace === packageTypes && depth <= 1)
      if (!depth) {
        requireThat(local === 'Types' && attrs.size === 0)
      } else if (local === 'Default') {
        validatedAttrs(attrs, ['Extension', 'ContentType'])
        const ext = attrs.get('Extension')
        const type = attrs.get('ContentType')
        const allowed = ext === 'rels' ? type === relsType : ext === 'xml' ?
          type === 'application/xml' || type === 'text/xml' : rasterTypes.get(ext) === type
        requireThat(allowed && !defaults.has(ext))
        defaults.set(ext, type)
      } else {
        requireThat(local === 'Override')
        validatedAttrs(attrs, ['PartName', 'ContentType'])
        const path = attrs.get('PartName')
        const name = path.slice(1)
        const type = attrs.get('ContentType')
        requireThat(path.startsWith('/') && expected.get(name) === type && !overrides.has(name))
        overrides.set(name, type)
      }
    },
  })
  for (const [name, type] of expected) {
    requireThat((overrides.get(name) ?? defaults.get(name.slice(name.lastIndexOf('.') + 1))) === type)
  }
}

const relationshipTypes = new Map([
  ['core', `${packageRels}/metadata/core-properties`],
  ['thumbnail', `${packageRels}/metadata/thumbnail`],
  ['stylesWithEffects', 'http://schemas.microsoft.com/office/2007/relationships/stylesWithEffects'],
])
const subRelations = new Map([
  ['officeDocument', new Set(['styles', 'stylesWithEffects', 'numbering', 'settings', 'webSettings', 'fontTable',
    'footnotes', 'endnotes', 'comments', 'header', 'footer', 'worksheet', 'sharedStrings', 'calcChain', 'slide',
    'slideMaster', 'notesMaster', 'handoutMaster', 'presProps', 'viewProps', 'tableStyles', 'theme', 'image', 'chart'])],
  ['header', new Set(['image', 'chart'])], ['footer', new Set(['image', 'chart'])],
  ['footnotes', new Set(['image', 'chart'])], ['endnotes', new Set(['image', 'chart'])],
  ['comments', new Set(['image'])], ['numbering', new Set(['image'])], ['theme', new Set(['image'])],
  ['worksheet', new Set(['drawing', 'table', 'image'])], ['drawing', new Set(['image', 'chart'])],
  ['chart', new Set(['image', 'theme'])],
  ['slide', new Set(['slideLayout', 'notesSlide', 'image', 'chart', 'slide'])],
  ['slideLayout', new Set(['slideMaster', 'image', 'chart'])],
  ['slideMaster', new Set(['slideLayout', 'theme', 'image', 'chart'])],
  ['notesSlide', new Set(['notesMaster', 'slide', 'image'])],
  ['notesMaster', new Set(['theme', 'image'])], ['handoutMaster', new Set(['theme', 'image'])],
])
const rootRelations = new Set(['officeDocument', 'core', 'extended-properties', 'custom-properties', 'thumbnail'])

function resolveTarget(source, target) {
  requireThat(target.length > 0 && target.length <= maxPath && !target.startsWith('//'))
  const parent = source.lastIndexOf('/')
  const resolved = target.startsWith('/') || parent < 0 ? [] : source.slice(0, parent).split('/')
  for (const segment of (target.startsWith('/') ? target.slice(1) : target).split('/')) {
    if (segment === '..') requireThat(resolved.pop())
    else {
      requireThat(segmentIsSafe(segment))
      resolved.push(segment)
    }
  }
  const name = resolved.join('/')
  requireThat(pathIsSafe(name))
  return name
}

function readRelationships(bytes, entries, parts, relations, state) {
  const graph = new Map()
  for (const [source, name] of relations) {
    const links = new Map()
    const rootRoles = new Set()
    graph.set(source, links)
    const allowed = source ? subRelations.get(parts.get(source)[0]) : rootRelations
    readXml(readStructure(bytes, entries.get(name), maxRelationships, state), state, {
      strictNodes: true,
      element(namespace, local, attrs, depth) {
        requireThat(namespace === packageRels && depth <= 1)
        if (!depth) {
          requireThat(local === 'Relationships' && attrs.size === 0)
          return
        }
        requireThat(local === 'Relationship')
        validatedAttrs(attrs, ['Id', 'Type', 'Target'], 'TargetMode')
        const id = attrs.get('Id')
        requireThat(/^[A-Za-z_][A-Za-z0-9_.-]{0,95}$/u.test(id) && !links.has(id) &&
          (!attrs.has('TargetMode') || attrs.get('TargetMode') === 'Internal'))
        const target = resolveTarget(source, attrs.get('Target'))
        const role = parts.get(target)?.[0]
        const type = attrs.get('Type')
        const explicit = relationshipTypes.get(role)
        requireThat(target !== source && allowed?.has(role) && (explicit ? type === explicit :
          type === `${officeRels}/${role}` || type === `${strictOfficeRels}/${role}`))
        if (!source) {
          requireThat(!rootRoles.has(role))
          rootRoles.add(role)
        }
        links.set(id, target)
      },
    })
    if (!source) requireThat(rootRoles.has('officeDocument'))
  }
  const visited = new Set()
  const queue = [...graph.get('').values()]
  while (queue.length) {
    const part = queue.pop()
    if (visited.has(part)) continue
    visited.add(part)
    for (const target of graph.get(part)?.values() ?? []) if (!visited.has(target)) queue.push(target)
  }
  requireThat(visited.size === parts.size)
}

function verifyMain(bytes, entries, format, state) {
  readXml(readStructure(bytes, entries.get(format.main), maxMain, state), state, {
    element(namespace, local, _attrs, depth) {
      if (!depth) requireThat(local === format.root && (namespace === `${schemas}${format.namespace}/2006/main` ||
        namespace === `${strict}${format.namespace}/main`))
    },
  })
}

/**
 * Classify a bounded subset of ordinary OOXML packages for attachment download.
 * No extraction or rendering: only the manifest, relationships and main XML
 * are decoded. Other member contents are opaque; ZIP sizes/ratios for those
 * members are declarations. This neither validates all OOXML semantics nor
 * detects malware, and is not a basis for a same-origin document preview.
 */
export function officeDeliveryMime(ext, bytes) {
  const format = formats.get(ext)
  if (!format || !Buffer.isBuffer(bytes) || bytes.length > maxArchive) return null
  const state = { deadline: performance.now() + maxWorkMs, metadata: 0, nodes: 0 }
  try {
    const { entries, start } = readCentral(bytes, state)
    readLocals(bytes, entries, start, state)
    const { parts, relations } = indexParts(entries, format)
    readManifest(bytes, entries, parts, relations, state)
    readRelationships(bytes, entries, parts, relations, state)
    verifyMain(bytes, entries, format, state)
    return format.mime
  } catch {
    return null
  }
}
