'use strict';

const zlib = require('node:zlib');

// Pulling readable text out of a PDF, with nothing but Node's own zlib.
//
// A PDF is not a document format so much as a drawing program: there is no
// "the text" in the file, only instructions to paint glyphs at coordinates.
// What follows reads those instructions and reconstructs the words.
//
// The part that decides whether this works at all is fonts. A modern writer
// (Word, LibreOffice, print-to-PDF) subsets its fonts and renumbers the glyphs,
// so the content stream says `<01><02><03>` where the page says "The". Reading
// those bytes as characters produces convincing mojibake — which is worse than
// nothing when it is about to be pasted into a prompt. The real mapping lives
// in the font's `/ToUnicode` CMap, so this walks the page tree to find each
// page's fonts and decodes through their CMaps.
//
// Two cases are still refused, and both refuse *loudly* rather than quietly
// returning rubbish:
//
//   - A scan is a picture of a page. There are no glyphs to read, only an
//     image, and this returns nothing so the caller can say so.
//   - A subset font with no `/ToUnicode` map and a non-standard encoding is
//     unreadable by construction. The sanity gate at the bottom throws that
//     output away rather than passing off glyph indices as words.

const MAX_STREAM_BYTES = 32 * 1024 * 1024;

// Below this share of printable characters, a page's output is treated as an
// encoding we cannot read rather than as text.
const PRINTABLE_FLOOR = 0.7;

function extractPdfText(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error('That does not look like a PDF file.');
  }
  // Encrypted PDFs have their streams obfuscated even when the password is
  // empty, so inflating them yields noise. Refused up front, with a reason.
  if (hasEncryption(buf)) {
    throw new Error('This PDF is encrypted — LanChat cannot read it.');
  }

  const objects = parseObjects(buf);
  const pages = [...objects.values()].filter((o) => /\/Type\s*\/Page[^s]/.test(`${o.dict} `));

  const out = [];
  if (pages.length) {
    for (const page of pages) {
      const text = textFromPage(page, objects);
      if (text) out.push(text);
    }
  } else {
    // No page tree we could follow — an unusual file, or one whose pages live
    // somewhere this parser does not reach. Every stream that looks like page
    // content is read instead, without font maps. Less accurate, but the
    // difference between some text and none.
    for (const obj of objects.values()) {
      const data = streamData(obj, objects);
      if (!data) continue;
      const text = gate(scanContent(data.toString('latin1'), new Map()));
      if (text) out.push(text);
    }
  }

  return tidy(out.join('\n\n'));
}

// `/Encrypt` belongs to the trailer, so only the tail of the file is searched —
// the word appearing inside some object's text cannot cause a false refusal.
function hasEncryption(buf) {
  const tail = buf.subarray(Math.max(0, buf.length - 4096)).toString('latin1');
  return /\/Encrypt\b/.test(tail);
}

// ---- objects ----------------------------------------------------------------
//
// Every `N M obj … endobj` in the file, plus the objects packed inside object
// streams. The latter matters more than it sounds: since PDF 1.5 most writers
// compress page and font dictionaries into `/Type /ObjStm`, and a parser that
// skips them sees a document with no pages and no fonts at all.

function parseObjects(buf) {
  const latin = buf.toString('latin1');
  const objects = new Map();
  const re = /(\d+)\s+\d+\s+obj\b/g;
  let match;
  while ((match = re.exec(latin)) !== null) {
    const num = Number(match[1]);
    const start = match.index + match[0].length;
    const endObj = latin.indexOf('endobj', start);
    const streamAt = latin.indexOf('stream', start);
    const hasStream = streamAt !== -1 && (endObj === -1 || streamAt < endObj);

    if (!hasStream) {
      // `obj` markers are found by scanning the whole file, so a match can land
      // inside another object's binary payload. A dictionary running past its
      // own `endobj` is such a ghost.
      if (endObj === -1 || endObj - start > 65536) continue;
      objects.set(num, { num, dict: latin.slice(start, endObj), raw: null });
      continue;
    }

    const dict = latin.slice(start, streamAt);
    if (dict.length > 65536) continue;
    let from = streamAt + 'stream'.length;
    if (latin[from] === '\r') from += 1;
    if (latin[from] === '\n') from += 1;

    // `/Length` is authoritative when it is a plain number; `endstream` is the
    // fallback, since a length given by reference cannot be resolved until
    // every object is known and the data may itself contain the word.
    let to;
    const len = readValue(dict, indexOfKey(dict, 'Length'));
    if (len && typeof len.number === 'number' && from + len.number <= buf.length) {
      to = from + len.number;
      const after = latin.slice(to, to + 20);
      if (!/^\s*endstream/.test(after)) to = null;
    }
    if (to == null) {
      const endAt = latin.indexOf('endstream', from);
      if (endAt === -1) continue;
      to = endAt;
      while (to > from && (latin[to - 1] === '\n' || latin[to - 1] === '\r')) to -= 1;
    }
    if (to - from > MAX_STREAM_BYTES) continue;
    objects.set(num, { num, dict, raw: buf.subarray(from, to) });
  }

  for (const obj of [...objects.values()]) {
    if (/\/Type\s*\/ObjStm\b/.test(obj.dict)) expandObjectStream(obj, objects);
  }
  return objects;
}

// An object stream holds N objects: a header of `objnum offset` pairs, then the
// objects themselves starting at `/First`.
function expandObjectStream(obj, objects) {
  const data = streamData(obj, objects);
  if (!data) return;
  const n = numberValue(obj.dict, 'N');
  const first = numberValue(obj.dict, 'First');
  if (!n || first == null) return;
  const text = data.toString('latin1');
  const header = text.slice(0, first).trim().split(/\s+/).map(Number);
  for (let k = 0; k < n; k += 1) {
    const num = header[k * 2];
    const off = header[k * 2 + 1];
    if (!Number.isFinite(num) || !Number.isFinite(off)) continue;
    // Objects inside an object stream may never be streams themselves, so the
    // whole span up to the next one is the dictionary.
    const nextOff = Number.isFinite(header[k * 2 + 3]) ? header[k * 2 + 3] : text.length - first;
    if (objects.has(num)) continue;
    objects.set(num, { num, dict: text.slice(first + off, first + nextOff), raw: null });
  }
}

// Decoded bytes of an object's stream, or null when it is not one we can or
// should read. Image and font-program payloads are refused by their dictionary
// so their binary is never mistaken for content.
function streamData(obj, objects) {
  if (!obj || !obj.raw) return null;
  const dict = obj.dict;
  if (/\/Subtype\s*\/(Image|Type1C|CIDFontType0C|OpenType)\b/.test(dict)) return null;
  if (/\/(DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode)\b/.test(dict)) return null;
  if (!/\/FlateDecode\b/.test(dict)) {
    if (/\/Filter\b/.test(dict)) return null; // a filter we do not implement
    return obj.raw;
  }
  try {
    return zlib.inflateSync(obj.raw);
  } catch {
    // Some writers omit the zlib header; some leave a stray leading byte.
    for (const attempt of [() => zlib.inflateRawSync(obj.raw), () => zlib.inflateSync(obj.raw.subarray(1))]) {
      try {
        return attempt();
      } catch {}
    }
    return null;
  }
}

// ---- dictionary reading -----------------------------------------------------
//
// Just enough of the object grammar to follow references. Values are returned
// as one of { dict, array, ref, name, number, string }.

function indexOfKey(dict, key) {
  const re = new RegExp(`/${key}(?![A-Za-z0-9])`);
  const m = re.exec(dict);
  return m ? m.index + m[0].length : -1;
}

function readValue(src, at) {
  if (at < 0) return null;
  let i = at;
  while (i < src.length && isWhitespace(src[i])) i += 1;
  if (i >= src.length) return null;

  if (src[i] === '<' && src[i + 1] === '<') {
    const end = matchDelimiter(src, i, '<<', '>>');
    return end === -1 ? null : { dict: src.slice(i + 2, end) };
  }
  if (src[i] === '[') {
    const end = matchDelimiter(src, i, '[', ']');
    return end === -1 ? null : { array: src.slice(i + 1, end) };
  }
  if (src[i] === '/') {
    let j = i + 1;
    while (j < src.length && !isWhitespace(src[j]) && !'()<>[]/%'.includes(src[j])) j += 1;
    return { name: src.slice(i + 1, j) };
  }
  const ref = /^(\d+)\s+(\d+)\s+R(?![A-Za-z0-9])/.exec(src.slice(i, i + 32));
  if (ref) return { ref: Number(ref[1]) };
  const num = /^[-+]?[\d.]+/.exec(src.slice(i, i + 32));
  if (num) return { number: Number(num[0]) };
  return null;
}

function matchDelimiter(src, start, open, close) {
  let depth = 0;
  let i = start;
  while (i < src.length) {
    if (src.startsWith(open, i)) {
      depth += 1;
      i += open.length;
      continue;
    }
    if (src.startsWith(close, i)) {
      depth -= 1;
      if (depth === 0) return i;
      i += close.length;
      continue;
    }
    i += 1;
  }
  return -1;
}

function numberValue(dict, key) {
  const v = readValue(dict, indexOfKey(dict, key));
  return v && typeof v.number === 'number' ? v.number : null;
}

// Follows a value to a dictionary body, through a reference if need be.
function asDict(value, objects) {
  if (!value) return null;
  if (typeof value.dict === 'string') return value.dict;
  if (typeof value.ref === 'number') {
    const target = objects.get(value.ref);
    return target ? target.dict : null;
  }
  return null;
}

// `/F1 5 0 R /F7 9 0 R` → [['F1', 5], ['F7', 9]]
function* namedRefs(dict) {
  const re = /\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R\b/g;
  let m;
  while ((m = re.exec(dict)) !== null) yield [m[1], Number(m[2])];
}

// ---- pages ------------------------------------------------------------------

function textFromPage(page, objects) {
  const fonts = fontsForPage(page, objects);
  const chunks = [];
  for (const num of contentRefs(page.dict)) {
    const data = streamData(objects.get(num), objects);
    if (data) chunks.push(data.toString('latin1'));
  }
  if (!chunks.length) return '';
  // A page's content may be split across several streams, and a token can be
  // split with it, so they are joined before scanning rather than scanned apart.
  return gate(scanContent(chunks.join('\n'), fonts));
}

function contentRefs(dict) {
  const value = readValue(dict, indexOfKey(dict, 'Contents'));
  if (!value) return [];
  if (typeof value.ref === 'number') return [value.ref];
  if (typeof value.array === 'string') {
    return [...value.array.matchAll(/(\d+)\s+\d+\s+R\b/g)].map((m) => Number(m[1]));
  }
  return [];
}

// Resource name → decoding table for that font, or null where the font needs no
// translation. `/Resources` is inheritable, so a page without one takes its
// parent's — which is where most writers put a single shared font dictionary.
function fontsForPage(page, objects) {
  const fonts = new Map();
  let dict = page.dict;
  for (let hop = 0; hop < 8 && dict; hop += 1) {
    const resources = asDict(readValue(dict, indexOfKey(dict, 'Resources')), objects);
    if (resources) {
      const fontDict = asDict(readValue(resources, indexOfKey(resources, 'Font')), objects);
      if (fontDict) {
        for (const [name, num] of namedRefs(fontDict)) {
          if (fonts.has(name)) continue;
          fonts.set(name, cmapForFont(objects.get(num), objects));
        }
      }
    }
    const parent = readValue(dict, indexOfKey(dict, 'Parent'));
    dict = parent && typeof parent.ref === 'number' ? objects.get(parent.ref)?.dict : null;
  }
  return fonts;
}

function cmapForFont(font, objects) {
  if (!font) return null;
  // How many bytes make one code is the font's business, not the CMap's.
  // Writers routinely emit the boilerplate `<0000> <FFFF>` codespace on a font
  // whose codes are plainly one byte, and believing that reads every pair of
  // characters as one — which is how "Printer test page" becomes nothing at all.
  // The spec is unambiguous here: simple fonts are single-byte, always.
  const simple = /\/Subtype\s*\/(TrueType|Type1|MMType1|Type3)\b/.test(font.dict);
  const toUnicode = readValue(font.dict, indexOfKey(font.dict, 'ToUnicode'));
  if (toUnicode && typeof toUnicode.ref === 'number') {
    const data = streamData(objects.get(toUnicode.ref), objects);
    if (data) {
      const cmap = parseCMap(data.toString('latin1'));
      return simple ? { ...cmap, width: 1 } : cmap;
    }
  }
  // No map. Two-byte identity encodings are unreadable without one; single-byte
  // ones are usually WinAnsi or Standard, near enough to Latin-1 that reading
  // the bytes straight through is right far more often than not.
  if (!simple && /\/Encoding\s*\/Identity-[HV]\b/.test(font.dict)) return { width: 2, map: new Map() };
  return null;
}

// A ToUnicode CMap: `beginbfchar` maps single codes, `beginbfrange` maps spans.
// Destinations are UTF-16BE, and may be several code units for a ligature.
function parseCMap(src) {
  const map = new Map();
  // The widest source code the map actually keys on. Trusted ahead of the
  // declared codespace, which is often left at its boilerplate value.
  let observed = 0;
  const note = (hex) => {
    observed = Math.max(observed, Math.ceil(hex.length / 2));
  };

  for (const block of src.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
      map.set(parseInt(pair[1], 16), utf16(pair[2]));
      note(pair[1]);
    }
  }

  for (const block of src.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1];
    // `<lo> <hi> [<a> <b> …]` — one destination per code in the span.
    for (const range of body.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([\s\S]*?)\]/g)) {
      const lo = parseInt(range[1], 16);
      let k = 0;
      for (const dst of range[3].matchAll(/<([0-9a-fA-F]*)>/g)) {
        map.set(lo + k, utf16(dst[1]));
        k += 1;
      }
      note(range[1]);
    }
    // `<lo> <hi> <dst>` — destinations run consecutively from dst.
    for (const range of body.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>(?!\s*\[)/g)) {
      const lo = parseInt(range[1], 16);
      const hi = parseInt(range[2], 16);
      const base = parseInt(range[3], 16);
      if (hi - lo > 65535) continue;
      for (let code = lo; code <= hi; code += 1) map.set(code, String.fromCodePoint(base + (code - lo)));
      note(range[1]);
    }
  }

  let width = observed;
  if (!width) {
    const space = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(src);
    const first = space && /<([0-9a-fA-F]+)>/.exec(space[1]);
    width = first ? Math.max(1, Math.ceil(first[1].length / 2)) : 1;
  }
  return { width, map };
}

function utf16(hex) {
  let out = '';
  for (let k = 0; k + 3 < hex.length + 1; k += 4) {
    const unit = parseInt(hex.slice(k, k + 4).padEnd(4, '0'), 16);
    if (Number.isFinite(unit)) out += String.fromCharCode(unit);
  }
  return out;
}

// ---- the content-stream scanner ---------------------------------------------
//
// Page content is postfix: operands first, then the operator. So the scanner
// collects operands as it goes and acts when an operator it cares about
// arrives. The ones that put marks on the page:
//
//   (Hello) Tj            show a string
//   [(H) -250 (i)] TJ     show strings with kerning between them
//   (Hello) '             next line, then show
//   aw ac (Hello) "       spacing, next line, then show
//
// plus /F1 12 Tf, which says which font the bytes should be read through, and
// Td / TD / T* / ET, which move the cursor and so mark where a line ends.

function scanContent(src, fonts) {
  const out = [];
  const operands = [];
  let font = null;
  let i = 0;

  while (i < src.length) {
    const ch = src[i];

    if (ch === '(') {
      const parsed = readLiteralString(src, i);
      operands.push({ str: parsed.value });
      i = parsed.next;
      continue;
    }
    if (ch === '<' && src[i + 1] === '<') {
      // An inline dictionary is never an operand used here; skipping it whole
      // keeps its contents from being read as strings.
      const end = matchDelimiter(src, i, '<<', '>>');
      i = end === -1 ? src.length : end + 2;
      operands.length = 0;
      continue;
    }
    if (ch === '<') {
      const parsed = readHexString(src, i);
      operands.push({ str: parsed.value, hex: true });
      i = parsed.next;
      continue;
    }
    if (ch === '[') {
      const parsed = readArray(src, i);
      operands.push({ array: parsed.value });
      i = parsed.next;
      continue;
    }
    if (ch === '%') {
      while (i < src.length && src[i] !== '\n' && src[i] !== '\r') i += 1;
      continue;
    }
    if (isWhitespace(ch) || ch === ']' || ch === ')' || ch === '>') {
      i += 1;
      continue;
    }
    if (ch === '/') {
      let j = i + 1;
      while (j < src.length && !isWhitespace(src[j]) && !'()<>[]/%'.includes(src[j])) j += 1;
      operands.push({ name: src.slice(i + 1, j) });
      i = j;
      continue;
    }

    let j = i;
    while (j < src.length && !isWhitespace(src[j]) && !'()<>[]/%'.includes(src[j])) j += 1;
    const token = src.slice(i, j === i ? i + 1 : j);
    i = j === i ? i + 1 : j;

    if (/^[-+.\d]/.test(token)) {
      operands.push({ number: Number(token) });
      continue;
    }

    switch (token) {
      case 'Tf': {
        const name = lastOf(operands, 'name');
        font = name !== null && fonts.has(name) ? fonts.get(name) : null;
        break;
      }
      case 'Tj':
      case "'":
      case '"': {
        const item = lastStringItem(operands);
        if (item) {
          if (token !== 'Tj') out.push('\n');
          out.push(decodeShown(item, font));
        }
        break;
      }
      case 'TJ': {
        const arr = lastOf(operands, 'array');
        if (arr) out.push(showArray(arr, font));
        break;
      }
      case 'Td':
      case 'TD':
      case 'T*':
      case 'ET':
        out.push('\n');
        break;
      default:
        break;
    }
    operands.length = 0;
  }

  return out.join('');
}

function lastOf(operands, key) {
  for (let k = operands.length - 1; k >= 0; k -= 1) {
    if (operands[k][key] !== undefined) return operands[k][key];
  }
  return null;
}

function lastStringItem(operands) {
  for (let k = operands.length - 1; k >= 0; k -= 1) {
    if (typeof operands[k].str === 'string') return operands[k];
  }
  return null;
}

// The bytes of a shown string mean whatever the current font says they mean.
// With a CMap they are codes to look up; without one they are close enough to
// Latin-1 to pass straight through.
function decodeShown(item, font) {
  if (!font) return item.str;
  const { width, map } = font;
  let out = '';
  for (let k = 0; k + width <= item.str.length; k += width) {
    let code = 0;
    for (let b = 0; b < width; b += 1) code = (code << 8) | (item.str.charCodeAt(k + b) & 0xff);
    const mapped = map.get(code);
    // An unmapped code in a font that has a map is a glyph we cannot name. A
    // replacement character marks it, which the sanity gate then counts.
    out += mapped !== undefined ? mapped : width === 1 ? item.str[k] : '�';
  }
  return out;
}

// A TJ array interleaves strings with kerning adjustments in thousandths of an
// em. A large negative adjustment is how most writers render a space, so that
// is where a space is put back — without it, everything runs together as
// "Thequickbrownfox".
function showArray(items, font) {
  let text = '';
  for (const item of items) {
    if (typeof item.str === 'string') text += decodeShown(item, font);
    else if (typeof item.number === 'number' && item.number < -100) text += ' ';
  }
  return text;
}

function readLiteralString(src, start) {
  let depth = 0;
  let value = '';
  let i = start;
  for (; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '\\') {
      const next = src[i + 1];
      if (next === undefined) break;
      if (next >= '0' && next <= '7') {
        let oct = '';
        let k = i + 1;
        while (k < src.length && oct.length < 3 && src[k] >= '0' && src[k] <= '7') {
          oct += src[k];
          k += 1;
        }
        value += String.fromCharCode(parseInt(oct, 8));
        i = k - 1;
        continue;
      }
      // A backslash before a newline is a line continuation, contributing
      // nothing to the string.
      if (next === '\n') {
        i += 1;
        continue;
      }
      if (next === '\r') {
        i += src[i + 2] === '\n' ? 2 : 1;
        continue;
      }
      value += ESCAPES[next] ?? next;
      i += 1;
      continue;
    }
    if (ch === '(') {
      depth += 1;
      if (depth > 1) value += ch;
      continue;
    }
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) return { value, next: i + 1 };
      value += ch;
      continue;
    }
    if (depth > 0) value += ch;
  }
  return { value, next: i };
}

const ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };

function readHexString(src, start) {
  const end = src.indexOf('>', start + 1);
  if (end === -1) return { value: '', next: src.length };
  const hex = src.slice(start + 1, end).replace(/[^0-9a-fA-F]/g, '');
  let value = '';
  for (let k = 0; k < hex.length; k += 2) {
    // An odd trailing digit is padded with zero, per the spec.
    value += String.fromCharCode(parseInt((hex[k] + (hex[k + 1] || '0')).padEnd(2, '0'), 16));
  }
  return { value, next: end + 1 };
}

function readArray(src, start) {
  const items = [];
  let i = start + 1;
  while (i < src.length && src[i] !== ']') {
    const ch = src[i];
    if (ch === '(') {
      const parsed = readLiteralString(src, i);
      items.push({ str: parsed.value });
      i = parsed.next;
      continue;
    }
    if (ch === '<') {
      const parsed = readHexString(src, i);
      items.push({ str: parsed.value, hex: true });
      i = parsed.next;
      continue;
    }
    if (isWhitespace(ch)) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < src.length && !isWhitespace(src[j]) && !'()<>[]'.includes(src[j])) j += 1;
    const token = src.slice(i, j === i ? i + 1 : j);
    i = j === i ? i + 1 : j;
    if (/^[-+.\d]/.test(token)) items.push({ number: Number(token) });
  }
  return { value: items, next: i + 1 };
}

function isWhitespace(ch) {
  return ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '\f' || ch === '\0';
}

// The sanity gate. Unmappable glyph indices decode to replacement characters
// and control bytes; real prose does not. Judged per page, so one unreadable
// font does not discard a document that is otherwise fine.
function gate(text) {
  const meaningful = text.slice(0, 8000).replace(/\s/g, '');
  // The ratio is the whole judgement; length is not evidence either way. A
  // title page holding two words is as real as a chapter, and a single
  // replacement character is as unreadable as a thousand.
  if (!meaningful.length) return '';
  let printable = 0;
  for (const ch of meaningful) {
    const code = ch.codePointAt(0);
    if (code >= 0x20 && code !== 0x7f && code !== 0xfffd) printable += 1;
  }
  return printable / meaningful.length >= PRINTABLE_FLOOR ? text : '';
}

// Text arrives with a newline at every cursor move, which for justified or
// multi-column layouts means one per line of type. Runs of blank lines collapse
// so the result reads as paragraphs rather than a column of fragments.
function tidy(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { extractPdfText };
