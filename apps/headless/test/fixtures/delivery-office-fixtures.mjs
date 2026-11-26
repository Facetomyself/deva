import { deflateRawSync } from 'node:zlib'

const manifest = '[Content_Types].xml'
const root = '_rels/.rels'
const base = 'http://schemas.openxmlformats.org/'
const ctNs = `${base}package/2006/content-types`
const relNs = `${base}package/2006/relationships`
const docRel = `${base}officeDocument/2006/relationships`
const types = 'application/vnd.openxmlformats-officedocument.'
const pkg = 'application/vnd.openxmlformats-package.'
const word = `${types}wordprocessingml.`
const excel = `${types}spreadsheetml.`
const powerpoint = `${types}presentationml.`
const wordNs = `${base}wordprocessingml/2006/main`
const excelNs = `${base}spreadsheetml/2006/main`
const pptNs = `${base}presentationml/2006/main`
const drawNs = `${base}drawingml/2006/main`
const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const plain = (name, content, zip = {}) => ({ name, content, ...zip })
const part = (name, type, content, zip) => ({ ...plain(name, content, zip), type })
const rel = (id, type, target, mode) =>
  `<Relationship Id="${id}" Type="${type}" Target="${target}"${mode ? ` TargetMode="${mode}"` : ''}/>`
const officeRel = (id, kind, target) => rel(id, `${docRel}/${kind}`, target)
const rels = (...elements) => `${declaration}<Relationships xmlns="${relNs}">${elements.join('')}</Relationships>`
const typesXml = (parts, extra = '') => `${declaration}<Types xmlns="${ctNs}">` +
  `<Default Extension="rels" ContentType="${pkg}relationships+xml"/>` +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  parts.filter(item => item.type).map(item => `<Override PartName="/${item.name}" ContentType="${item.type}"/>`).join('') +
  `${extra}</Types>`

// Tiny fixture-only ZIP writer: two ZIP methods, independent CRC, and an optional
// streaming descriptor. No package dependency and no external application.
function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return ~crc >>> 0
}
function zip(items) {
  const local = []
  const central = []
  const positions = new Map()
  let offset = 0
  let cdLength = 0
  for (const item of items) {
    const name = Buffer.from(item.name)
    const input = Buffer.from(item.content)
    const data = item.compressed ?? (item.deflate ? deflateRawSync(input) : input)
    const crc = item.crc ?? crc32(input)
    const size = item.size ?? input.length
    const attrs = item.attrs ?? (item.name.endsWith('/') ? 0x41ed0010 : 0x81a40020)
    const flag = item.descriptor ? 0x0808 : 0x0800
    const method = item.deflate ? 8 : 0
    const extra = item.extra ?? Buffer.alloc(0)
    const lh = Buffer.alloc(30)
    const ch = Buffer.alloc(46)
    lh.writeUInt32LE(0x04034b50)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(flag, 6)
    lh.writeUInt16LE(method, 8)
    if (!item.descriptor) {
      lh.writeUInt32LE(crc, 14)
      lh.writeUInt32LE(data.length, 18)
      lh.writeUInt32LE(size, 22)
    }
    lh.writeUInt16LE(name.length, 26)
    lh.writeUInt16LE(extra.length, 28)
    ch.writeUInt32LE(0x02014b50)
    ch.writeUInt16LE(0x0314, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(flag, 8)
    ch.writeUInt16LE(method, 10)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(data.length, 20)
    ch.writeUInt32LE(size, 24)
    ch.writeUInt16LE(name.length, 28)
    ch.writeUInt16LE(extra.length, 30)
    ch.writeUInt32LE(attrs, 38)
    ch.writeUInt32LE(offset, 42)
    const dd = Buffer.alloc(item.descriptor === 'signed' ? 16 : item.descriptor ? 12 : 0)
    if (dd.length) {
      const first = dd.length - 12
      if (first) dd.writeUInt32LE(0x08074b50)
      dd.writeUInt32LE(crc, first)
      dd.writeUInt32LE(data.length, first + 4)
      dd.writeUInt32LE(size, first + 8)
    }
    positions.set(item.name, { local: offset, relativeCentral: cdLength, descriptor: offset + lh.length + name.length + extra.length + data.length })
    offset += lh.length + name.length + extra.length + data.length + dd.length
    cdLength += ch.length + name.length + extra.length
    local.push(lh, name, extra, data, dd)
    central.push(ch, name, extra)
  }
  const footer = Buffer.alloc(22)
  footer.writeUInt32LE(0x06054b50)
  footer.writeUInt16LE(items.length, 8)
  footer.writeUInt16LE(items.length, 10)
  footer.writeUInt32LE(cdLength, 12)
  footer.writeUInt32LE(offset, 16)
  for (const pos of positions.values()) pos.central = offset + pos.relativeCentral
  return { bytes: Buffer.concat([...local, ...central, footer]), positions, eocd: offset + cdLength }
}

const wordMain = 'word/document.xml'
const excelMain = 'xl/workbook.xml'
const pptMain = 'ppt/presentation.xml'
function document(parts = [], mainZip, rootXml) {
  return [
    plain(root, rootXml ?? rels(officeRel('rId1', 'officeDocument', wordMain))),
    part(wordMain, `${word}document.main+xml`, `${declaration}<w:document xmlns:w="${wordNs}">` +
      '<w:body><w:p><w:r><w:t>附件 &amp; delivery.</w:t></w:r></w:p><w:sectPr/></w:body></w:document>', mainZip),
    ...parts,
  ]
}
const workbook = [
  plain(root, rels(officeRel('rId1', 'officeDocument', `/${excelMain}`))),
  part(excelMain, `${excel}sheet.main+xml`, `${declaration}<workbook xmlns="${excelNs}" xmlns:r="${docRel}">` +
    '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>', { deflate: true }),
  plain('xl/_rels/workbook.xml.rels', rels(officeRel('rId1', 'worksheet', 'worksheets/sheet1.xml')), { deflate: true }),
  part('xl/worksheets/sheet1.xml', `${excel}worksheet+xml`, `<worksheet xmlns="${excelNs}">` +
    '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>hello</t></is></c></row></sheetData></worksheet>'),
]
const pptCommon = '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/>' +
  '</p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>'
const pptAttrs = `xmlns:p="${pptNs}" xmlns:a="${drawNs}" xmlns:r="${docRel}"`
const themeColors = { dk1: '000000', lt1: 'FFFFFF', dk2: '202020', lt2: 'F0F0F0', accent1: '113355',
  accent2: '335577', accent3: '557799', accent4: '7799BB', accent5: '99BBDD', accent6: 'BBDDFF',
  hlink: '0000FF', folHlink: '800080' }
const font = '<a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/>'
const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
const theme = `<a:theme xmlns:a="${drawNs}" name="Simple"><a:themeElements><a:clrScheme name="Simple">` +
  Object.entries(themeColors).map(([role, rgb]) => `<a:${role}><a:srgbClr val="${rgb}"/></a:${role}>`).join('') +
  `</a:clrScheme><a:fontScheme name="Simple"><a:majorFont>${font}</a:majorFont><a:minorFont>${font}</a:minorFont>` +
  `</a:fontScheme><a:fmtScheme name="Simple"><a:fillStyleLst>${fill.repeat(3)}</a:fillStyleLst><a:lnStyleLst>` +
  [6350, 12700, 19050].map(width => `<a:ln w="${width}">${fill}</a:ln>`).join('') + '</a:lnStyleLst>' +
  `<a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst>` +
  `<a:bgFillStyleLst>${fill.repeat(3)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`
const powerpointParts = [
  plain(root, rels(officeRel('rId1', 'officeDocument', pptMain))),
  part(pptMain, `${powerpoint}presentation.main+xml`, `<p:presentation ${pptAttrs}>` +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    '<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>' +
    '<p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>', { deflate: true }),
  plain('ppt/_rels/presentation.xml.rels', rels(officeRel('rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'),
    officeRel('rId2', 'slide', 'slides/slide1.xml'), officeRel('rId3', 'presProps', 'presProps.xml'))),
  part('ppt/presProps.xml', `${powerpoint}presProps+xml`, `<p:presentationPr ${pptAttrs}/>`),
  part('ppt/slides/slide1.xml', `${powerpoint}slide+xml`, `<p:sld ${pptAttrs}>${pptCommon}</p:sld>`),
  plain('ppt/slides/_rels/slide1.xml.rels', rels(officeRel('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'))),
  part('ppt/slideLayouts/slideLayout1.xml', `${powerpoint}slideLayout+xml`,
    `<p:sldLayout ${pptAttrs} type="blank">${pptCommon}</p:sldLayout>`),
  plain('ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels(officeRel('rId1', 'slideMaster', '../slideMasters/slideMaster1.xml'))),
  part('ppt/slideMasters/slideMaster1.xml', `${powerpoint}slideMaster+xml`, `<p:sldMaster ${pptAttrs}>${pptCommon}` +
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" ' +
    'accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>'),
  plain('ppt/slideMasters/_rels/slideMaster1.xml.rels', rels(officeRel('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'),
    officeRel('rId2', 'theme', '../theme/theme1.xml'))),
  part('ppt/theme/theme1.xml', `${types}theme+xml`, theme, { deflate: true }),
]
const archive = (parts, xml = typesXml(parts), options) =>
  zip([plain(manifest, xml, options), ...parts])

/** Reuse the same synthetic Office fixtures in attachment integration tests. */
export function officeDeliveryFixture(ext) {
  if (ext === '.docx') return archive(document()).bytes
  if (ext === '.xlsx') return archive(workbook, undefined, { deflate: true }).bytes
  if (ext === '.pptx') return archive(powerpointParts).bytes
  throw new TypeError('Unknown Office fixture extension')
}

export {
  archive, ctNs, docRel, document, excel, excelNs, officeRel, part, pkg, plain, powerpoint, rel,
  relNs, rels, root, typesXml, word, wordMain, wordNs, zip,
}
