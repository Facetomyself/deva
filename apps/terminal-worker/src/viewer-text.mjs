export const MAX_SOURCE_BYTES = 65_536;
export const MAX_SOURCE_LINES = 4_096;
export const MAX_FRAME_BYTES = 128 * 1_024;
export const SOURCE_NAME = 'source';

export const KEY_BYTES = Object.freeze({
  up: 'k', down: 'j', 'page-up': 'b', 'page-down': 'f',
  home: 'g', end: 'G', left: 'h', right: 'l', quit: 'q',
});

export function validSize(cols, rows) {
  return Number.isInteger(cols) && cols >= 24 && cols <= 160 &&
    Number.isInteger(rows) && rows >= 4 && rows <= 50;
}

export function countLines(text) {
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 && ++count > MAX_SOURCE_LINES) break;
  }
  return count;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const unsafeCodePoint = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const formatOrMark = /[\p{Cf}\p{M}]/u;
const emoji = /[\p{Emoji_Presentation}\p{Regional_Indicator}\uFE0F\u20E3]/u;
const isJoiner = (ch) => ch === '\u200c' || ch === '\u200d';
const isUnsafe = (ch) => unsafeCodePoint.test(ch) && !isJoiner(ch);

// East Asian wide/fullwidth code points. Ambiguous characters use one cell.
function isWide(cp) {
  return cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) || (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff01 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x16fe0 && cp <= 0x18dff) || (cp >= 0x1aff0 && cp <= 0x1b2ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd));
}

function cellWidth(grapheme) {
  for (const ch of grapheme) {
    if (!formatOrMark.test(ch)) return emoji.test(grapheme) || isWide(ch.codePointAt(0)) ? 2 : 1;
  }
  return 0;
}

export function safeRenderedLine(line, cols) {
  if (typeof line !== 'string' || !line.isWellFormed()) return false;
  for (const ch of line) if (isUnsafe(ch)) return false;
  let width = 0;
  for (const { segment } of segmenter.segment(line)) width += cellWidth(segment);
  return width <= cols;
}

function prepareLine(line) {
  // Escape syntax is always data. Render its introducers and other terminal
  // controls visibly, so neither tabs nor bare carriage returns can move a cursor.
  let safe = '';
  for (const ch of line) safe += ch === '\t' || !isUnsafe(ch) ? ch : '\ufffd';
  const cells = [];
  let width = 0;
  for (const { segment } of segmenter.segment(safe)) {
    const span = segment === '\t' ? 8 - (width % 8) : cellWidth(segment);
    // A standalone combining mark or joiner at the left margin has no base.
    if (span === 0) continue;
    cells.push({ text: segment, start: width, end: width + span });
    width += span;
  }
  return { cells, width };
}

export function prepareText(text) {
  if (text.startsWith('\ufeff')) text = text.slice(1);
  const raw = text.split('\n');
  const lines = raw.map((line, i) => prepareLine(
    i < raw.length - 1 && line.endsWith('\r') ? line.slice(0, -1) : line,
  ));
  return { lines, width: lines.reduce((max, line) => Math.max(max, line.width), 0) };
}

function clipLine({ cells, width }, left, cols) {
  if (left >= width) return '';
  const right = left + cols;
  // Binary search makes a horizontal shift in a maximum-length line cheap.
  let lo = 0;
  let hi = cells.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cells[mid].end <= left) lo = mid + 1;
    else hi = mid;
  }
  let result = '';
  for (let i = lo; i < cells.length && cells[i].start < right; i++) {
    const { text, start, end } = cells[i];
    result += text === '\t' || start < left || end > right
      ? ' '.repeat(Math.min(right, end) - Math.max(left, start)) : text;
  }
  return result;
}

export function createViewport({ lines, width }) {
  let top = 0;
  let left = 0;
  return (cols, rows, key) => {
    const maxTop = Math.max(0, lines.length - rows);
    const maxLeft = Math.max(0, width - cols);
    switch (key) {
      case 'up': top--; break;
      case 'down': top++; break;
      case 'page-up': top -= rows; break;
      case 'page-down': top += rows; break;
      case 'home': top = 0; break;
      case 'end': top = maxTop; break;
      case 'left': left--; break;
      case 'right': left++; break;
    }
    top = Math.max(0, Math.min(top, maxTop));
    left = Math.max(0, Math.min(left, maxLeft));
    return {
      cols, rows, top, left, totalLines: lines.length,
      lines: lines.slice(top, top + rows).map((line) => clipLine(line, left, cols)),
    };
  };
}
