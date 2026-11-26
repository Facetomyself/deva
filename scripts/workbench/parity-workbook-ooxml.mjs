import { createRequire } from 'node:module'

const requireFromDesktop = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))
const mainNs = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const relNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const pkgNs = 'http://schemas.openxmlformats.org/package/2006'
const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml'
const xml = (body) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${body}`
const escapes = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }
const attr = (value) => String(value).replace(/[&<>"']/g, (character) => escapes[character])
const text = (value) => attr(String(value)
  .replace(/_x[\da-fA-F]{4}_/gi, (escape) => `_x005F_${escape.slice(1)}`)
  .replace(/[\u0000-\u0008\u000b-\u001f\uD800-\uDFFF\uFFFE\uFFFF]/gu, (character) =>
    `_x${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`))
const rels = (items) => xml(`<Relationships xmlns="${pkgNs}/relationships">${items.join('')}</Relationships>`)
const rel = (id, type, target, external = false) => `<Relationship Id="${id}" Type="${relNs}/${type}" Target="${attr(target)}"${external ? ' TargetMode="External"' : ''}/>`
const override = (name, type) => `<Override PartName="/${name}" ContentType="${mime}.${type}+xml"/>`

const palette = {
  body: ['172B42', 'FFFFFF'], alternate: ['172B42', 'F2F6FA'], header: ['FFFFFF', '254B69', 'bold'],
  title: ['FFFFFF', '162F48', 'bold', 17], meta: ['324E65', 'EAF1F8'], link: ['14548C', 'FFFFFF', 'underline'],
  metaLink: ['14548C', 'EAF1F8', 'underline'], total: ['162F48', 'E1ECF7', 'bold'],
  implemented: ['0F5132', 'DDF3E8', 'bold'], partial: ['704700', 'FFF0C2', 'bold'],
  pending: ['713247', 'F7E5EE', 'bold'], desktop: ['37465D', 'E8EDF3', 'bold'], subscription: ['1F4F7A', 'D9EDF9', 'bold'],
}
const styles = Object.keys(palette)

function styleXml() {
  const values = Object.values(palette)
  const fonts = values.map(([foreground, , mark, size = 11]) =>
    `<font>${mark === 'bold' ? '<b/>' : mark === 'underline' ? '<u/>' : ''}<sz val="${size}"/><color rgb="FF${foreground}"/><name val="Microsoft YaHei"/></font>`)
  const fills = values.map(([, bg]) => `<fill><patternFill patternType="solid"><fgColor rgb="FF${bg}"/><bgColor indexed="64"/></patternFill></fill>`)
  const xfs = values.map((_, i) => `<xf numFmtId="0" fontId="${i}" fillId="${i + 2}" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>`)
  return xml(`<styleSheet xmlns="${mainNs}"><fonts count="${fonts.length}">${fonts.join('')}</fonts><fills count="${fills.length + 2}"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>${fills.join('')}</fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`)
}

export const cell = (value, style, href) => ({ value, style, href })
const asCell = (value) => typeof value === 'object' && value !== null ? value : { value }
function col(index) {
  let name = ''
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name
  return name
}

function height(row, widths) {
  const lines = row.map((item, i) => String(asCell(item).value ?? '').split('\n').reduce((sum, line) => {
    const chars = [...line].reduce((size, character) => size + (character.codePointAt(0) > 255 ? 2 : 1), 0)
    return sum + Math.max(1, Math.ceil(chars / Math.max(1, widths[i] - 3)))
  }, 0))
  return Math.min(390, 8 + 16 * Math.max(1, ...lines))
}

function sheetXml({ widths, prefix, header, rows, frozenColumns = 0 }) {
  const links = []
  const headerRow = prefix.length + 1
  const lastCol = col(widths.length - 1)
  const render = (row, number, rowHeight, fallback) => `<row r="${number}" ht="${rowHeight}" customHeight="1">${row.map((item, i) => {
    const { value, href, style } = asCell(item)
    const ref = `${col(i)}${number}`
    if (href) links.push({ ref, href })
    const s = styles.indexOf(style ?? (href ? 'link' : fallback))
    if (Number.isSafeInteger(value)) return `<c r="${ref}" s="${s}"><v>${value}</v></c>`
    return `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${text(value ?? '')}</t></is></c>`
  }).join('')}</row>`
  const top = `${col(frozenColumns)}${headerRow + 1}`
  const pane = frozenColumns ? 'bottomRight' : 'bottomLeft'
  const view = `<sheetViews><sheetView showGridLines="0" workbookViewId="0"><pane ${frozenColumns ? `xSplit="${frozenColumns}" ` : ''}ySplit="${headerRow}" topLeftCell="${top}" activePane="${pane}" state="frozen"/><selection pane="${pane}" activeCell="${top}" sqref="${top}"/></sheetView></sheetViews>`
  const cols = `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
  const body = prefix.map((item, i) => render([item], i + 1, i === 0 ? 32 : 21, i === 0 ? 'title' : 'meta')).join('') +
    render(header, headerRow, height(header, widths), 'header') + rows.map((row, i) =>
      render(row, headerRow + i + 1, height(row, widths), i % 2 ? 'alternate' : 'body')).join('')
  const filter = `<autoFilter ref="A${headerRow}:${lastCol}${headerRow + rows.length}"/>`
  const merges = `<mergeCells count="${prefix.length}">${prefix.map((_, i) => `<mergeCell ref="A${i + 1}:${lastCol}${i + 1}"/>`).join('')}</mergeCells>`
  const hyperlinks = links.length ? `<hyperlinks>${links.map(({ ref }, i) => `<hyperlink ref="${ref}" r:id="rId${i + 1}"/>`).join('')}</hyperlinks>` : ''
  return {
    data: xml(`<worksheet xmlns="${mainNs}" xmlns:r="${relNs}">${view}<sheetFormatPr defaultRowHeight="20"/>${cols}<sheetData>${body}</sheetData>${filter}${merges}${hyperlinks}</worksheet>`),
    relationships: links.length ? rels(links.map(({ href }, i) => rel(`rId${i + 1}`, 'hyperlink', href, true))) : null,
  }
}

export function zipWorkbook(sheets) {
  const { zipSync, strToU8 } = requireFromDesktop('fflate')
  const path = (i) => `xl/worksheets/sheet${i + 1}.xml`
  const files = {
    '[Content_Types].xml': xml(`<Types xmlns="${pkgNs}/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${override('xl/workbook.xml', 'sheet.main')}${override('xl/styles.xml', 'styles')}${sheets.map((_, i) => override(path(i), 'worksheet')).join('')}</Types>`),
    '_rels/.rels': rels([rel('rId1', 'officeDocument', 'xl/workbook.xml')]),
    'xl/workbook.xml': xml(`<workbook xmlns="${mainNs}" xmlns:r="${relNs}"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${sheets.map(({ name }, i) => `<sheet name="${attr(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': rels([...sheets.map((_, i) => rel(`rId${i + 1}`, 'worksheet', `worksheets/sheet${i + 1}.xml`)), rel(`rId${sheets.length + 1}`, 'styles', 'styles.xml')]),
    'xl/styles.xml': styleXml(),
  }
  sheets.forEach((sheet, i) => {
    const { data, relationships } = sheetXml(sheet)
    files[path(i)] = data
    if (relationships) files[`xl/worksheets/_rels/sheet${i + 1}.xml.rels`] = relationships
  })
  // ZIP stores local DOS time; a fixed local calendar date is stable across time zones.
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, body]) => [name, strToU8(body)])), { level: 6, mtime: new Date(2000, 0, 1) })
}
