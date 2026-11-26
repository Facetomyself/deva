import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deflateRawSync } from 'node:zlib'
import { officeDeliveryMime } from '../src/files/delivery-office.mjs'
import {
  archive, ctNs, docRel, document, excel, excelNs, officeRel, officeDeliveryFixture,
  part, pkg, plain, powerpoint, rel, relNs, rels, root, typesXml, word, wordMain, wordNs, zip,
} from './fixtures/delivery-office-fixtures.mjs'

const docxMime = `${word}document`
const xlsxMime = `${excel}sheet`
const pptxMime = `${powerpoint}presentation`

function expectRejected(name, examples, ext = '.docx') {
  for (const [label, sample] of examples) {
    assert.equal(officeDeliveryMime(ext, sample), null, `${name}: ${label}`)
  }
}

test('classifies actual minimal Word, Excel and PowerPoint OPC packages', () => {
  const docx = officeDeliveryFixture('.docx')
  const xlsx = officeDeliveryFixture('.xlsx')
  const pptx = officeDeliveryFixture('.pptx')
  assert.equal(officeDeliveryMime('.docx', docx), docxMime)
  assert.equal(officeDeliveryMime('.xlsx', xlsx), xlsxMime)
  assert.equal(officeDeliveryMime('.pptx', pptx), pptxMime)
  expectRejected('cross-format ZIP', [['Excel', xlsx], ['PowerPoint', pptx]])
  expectRejected('cross-format ZIP', [['Word', docx], ['PowerPoint', pptx]], '.xlsx')
  expectRejected('cross-format ZIP', [['Word', docx], ['Excel', xlsx]], '.pptx')
})

test('handles common passive parts and bounded descriptor/ZIP extra metadata', () => {
  const props = 'docProps/core.xml'
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64')
  const timestamp = Buffer.from([0x55, 0x54, 0x05, 0, 1, 0, 0, 0, 0])
  const parts = document([
    plain('word/', ''),
    plain('word/media/', ''),
    part(props, `${pkg}core-properties+xml`, '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"/>'),
    part('word/styles.xml', `${word}styles+xml`, `<w:styles xmlns:w="${wordNs}"/>`, { extra: timestamp }),
    part('word/media/image1.png', undefined, png),
    plain('word/_rels/document.xml.rels', rels(officeRel('styles', 'styles', 'styles.xml'),
      officeRel('picture', 'image', 'media/image1.png')), { deflate: true, descriptor: 'unsigned' }),
  ], { deflate: true, descriptor: 'signed' }, rels(officeRel('main', 'officeDocument', wordMain),
    rel('core', `${relNs}/metadata/core-properties`, props)))
  const xml = typesXml(parts, '<Default Extension="png" ContentType="image/png"/>')
  assert.equal(officeDeliveryMime('.docx', archive(parts, xml, { deflate: true }).bytes), docxMime)
})

test('rejects old, unknown, unsupported extensions, fake magic and non-Buffer input', () => {
  const bytes = archive(document()).bytes
  for (const ext of ['.doc', '.xls', '.ppt', '.docm', '.xlsm', '.pptm', '.dotx', '.zip', '.DOCX', '', undefined, null]) {
    assert.equal(officeDeliveryMime(ext, bytes), null, String(ext))
  }
  expectRejected('wrong input', [
    ['legacy binary', Buffer.from('d0cf11e0a1b11ae1', 'hex')], ['false ZIP magic', Buffer.from('504b030400000000', 'hex')],
    ['ordinary ZIP', zip([plain('text.txt', 'text')]).bytes], ['text', 'text'], ['array', Uint8Array.from(bytes)],
    ['undefined', undefined], ['null', null], ['8 MiB + 1', Buffer.alloc(8 * 1024 * 1024 + 1)],
  ])
})

test('rejects mismatched main XML, false manifests, unsupported content types and XML syntax', () => {
  const parts = document()
  const xml = typesXml(parts)
  const disguised = content => archive([parts[0], { ...parts[1], content }]).bytes
  expectRejected('manifest/main', [
    ['missing manifest', zip(parts).bytes], ['missing root', archive(parts.slice(1)).bytes],
    ['wrong namespace', archive(parts, xml.replace(ctNs, `${ctNs}/other`)).bytes],
    ['wrong main type', archive(parts, xml.replace(`${word}document.main+xml`, `${excel}sheet.main+xml`)).bytes],
    ['macro-enabled type', archive(parts, xml.replace(`${word}document.main+xml`, 'application/vnd.ms-word.document.macroEnabled.main+xml')).bytes],
    ['duplicate override', archive(parts, typesXml(parts, `<Override PartName="/${wordMain}" ContentType="${word}document.main+xml"/>`)).bytes],
    ['unknown override', archive(parts, typesXml(parts, '<Override PartName="/other.xml" ContentType="application/xml"/>')).bytes],
    ['unknown default', archive(parts, typesXml(parts, '<Default Extension="bin" ContentType="application/octet-stream"/>')).bytes],
    ['doctype', archive(parts, xml.replace('<Types', '<!DOCTYPE Types><Types')).bytes],
    ['duplicate attrs', archive(parts, xml.replace('Extension="rels"', 'Extension="rels" Extension="rels"')).bytes],
    ['multiple roots', archive(parts, `${xml}<Types xmlns="${ctNs}"/>`).bytes],
    ['invalid UTF-8', archive(parts, Buffer.concat([Buffer.from(xml), Buffer.from([0xff])])).bytes],
    ['binary main', disguised(Buffer.from([0x4d, 0x5a, 0]))], ['wrong main', disguised(`<workbook xmlns="${excelNs}"/>`)],
    ['wrong main namespace', disguised(`<w:document xmlns:w="${wordNs}/other"/>`)],
    ['broken main', disguised(`<w:document xmlns:w="${wordNs}"><w:body></w:document>`)],
    ['mis-bound prefix', disguised(`<w:document xmlns:w="${wordNs}"><unbound:body/></w:document>`)],
    ['unknown entity', disguised(`<w:document xmlns:w="${wordNs}">&unknown;</w:document>`)],
  ])
})

test('rejects unknown/active parts, duplicate names, links, traversal and foreign relationships', () => {
  expectRejected('parts', [
    ...['word/vbaProject.bin', 'word/embeddings/object.bin', 'word/activeX/activeX1.xml', 'word/media/art.svg',
      'word/externalLinks/externalLink1.xml', 'word/customXml/unknown.xml', '../document.xml', 'word\\styles.xml',
      '/word/styles.xml', 'word/styles.xml.', 'word/%73tyles.xml', 'word/../document.xml', wordMain, 'WORD/DOCUMENT.XML']
      .map(name => [name, archive(document([plain(name, 'placeholder')])).bytes]),
    ['symlink attrs', archive(document([], { attrs: 0xa1ff0000 })).bytes],
    ['Windows reparse attrs', archive(document([], { attrs: 0x00000400 })).bytes],
    ['orphan approved part', archive(document([part('word/styles.xml', `${word}styles+xml`, '<styles/>')])).bytes],
    ['relationship source missing', archive(document([plain('word/_rels/header1.xml.rels', rels())])).bytes],
  ])
  const target = (to, type = `${docRel}/officeDocument`, mode) =>
    archive(document([], undefined, rels(rel('rId1', type, to, mode)))).bytes
  expectRejected('relationship', [
    ['absent root link', archive(document([], undefined, rels())).bytes],
    ['missing target', target('word/missing.xml')], ['wrong rel namespace', target(wordMain, `${docRel}/different`)],
    ['external mode', target(wordMain, undefined, 'External')], ['mode casing', target(wordMain, undefined, 'internal')],
    ['absolute URL', target('https://example.invalid/demo.docx')], ['encoded path', target('word/%64ocument.xml')],
    ['scheme with parent step', target('example:x/../word/document.xml')], ['escaped root', target(`../${wordMain}`)],
    ['fragment', target(`${wordMain}#element`)], ['repeated slash', target(`//${wordMain}`)],
    ['two main links', archive(document([], undefined, rels(officeRel('main1', 'officeDocument', wordMain),
      officeRel('main2', 'officeDocument', wordMain)))).bytes],
    ['bad side relationship', archive(document([plain('word/_rels/document.xml.rels',
      rels(rel('rId1', `${docRel}/hyperlink`, 'https://example.invalid/', 'External')))])).bytes],
  ])
})

test('rejects malformed local/central headers, CRCs, descriptors and raw deflate streams', () => {
  const original = archive(document([], { deflate: true, descriptor: 'signed' }))
  const { bytes, eocd, positions } = original
  const { local, central, descriptor } = positions.get(wordMain)
  const mutate = fn => { const copy = Buffer.from(bytes); fn(copy); return copy }
  expectRejected('ZIP', [
    ['truncated', bytes.subarray(0, bytes.length - 1)], ['prefix', Buffer.concat([Buffer.from('prefix'), bytes])],
    ['suffix', Buffer.concat([bytes, Buffer.from('suffix')])],
    ['split ZIP disk', mutate(buf => buf.writeUInt16LE(1, eocd + 4))],
    ['entry on other disk', mutate(buf => buf.writeUInt16LE(1, central + 34))],
    ['count disagreement', mutate(buf => buf.writeUInt16LE(2, eocd + 8))],
    ['large ZIP64 offset', mutate(buf => buf.writeUInt32LE(0xffffffff, eocd + 16))],
    ['large member offset', mutate(buf => buf.writeUInt32LE(0xffffffff, central + 42))],
    ['local overlap', mutate(buf => buf.writeUInt32LE(0, central + 42))],
    ['encrypted flags', mutate(buf => buf.writeUInt16LE(0x0809, central + 8))],
    ['method mismatch', mutate(buf => buf.writeUInt16LE(0, local + 8))],
    ['local name mismatch', mutate(buf => { buf[local + 30] ^= 1 })],
    ['descriptor mismatch', mutate(buf => buf.writeUInt32LE(0, descriptor + 4))],
    ['wrong structure CRC', archive(document([], { crc: 0 })).bytes],
    ['deflate stream invalid', archive(document([], { deflate: true, compressed: Buffer.from([0xff, 0xff]) })).bytes],
    ['claimed output short', archive(document([], { deflate: true, size: 10 })).bytes],
    ['claimed output long', archive(document([], { deflate: true, size: 600 })).bytes],
    ['compressed bytes after deflate stream', archive(document([], { deflate: true, compressed: Buffer.concat([
      deflateRawSync(Buffer.from(document()[1].content)), Buffer.from([0]),
    ]) })).bytes],
    ['ZIP64 extra', archive(document([], { extra: Buffer.from([1, 0, 0, 0]) })).bytes],
    ['malformed extra', archive(document([], { extra: Buffer.from([0x55, 0x54, 5, 0, 1]) })).bytes],
  ])
})

test('enforces bounded archive and XML declarations/complexity before classification', () => {
  const parts = document()
  const xml = typesXml(parts)
  const withMain = content => archive([parts[0], { ...parts[1], content }]).bytes
  const relPadding = rels().replace('</Relationships>', `${' '.repeat(128 * 1024)}</Relationships>`)
  expectRejected('resource limit', [
    ['513 ZIP entries', archive(document(Array.from({ length: 510 }, (_, i) => plain(`file${i}`, 'x')))).bytes],
    ['expanded member greater than 8 MiB', archive(document([], { deflate: true, size: 8 * 1024 * 1024 + 1 })).bytes],
    ['declared ratio greater than 250:1', archive(document([], { deflate: true, size: 192 * 1024 })).bytes],
    ['manifest greater than 256 KiB', archive(parts, xml + ' '.repeat(256 * 1024)).bytes],
    ['relationships greater than 128 KiB', archive(document([], undefined, relPadding)).bytes],
    ['main larger than 2 MiB', withMain(parts[1].content + ' '.repeat(2 * 1024 * 1024))],
    ['XML depth', withMain(`<document xmlns="${wordNs}">${'<x>'.repeat(100)}${'</x>'.repeat(100)}</document>`)],
    ['XML token budget', withMain(`<document xmlns="${wordNs}">${'<x/>'.repeat(60_001)}</document>`)],
  ])
})
