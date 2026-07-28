'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { extractPdfText } = require('../src/main/documents/pdfText.js');
const { readDocument, composePrompt, MAX_DOC_CHARS } = require('../src/main/documents');

// ---- fixtures ----

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-docs-'));
}

function write(name, contents) {
  const file = path.join(tmpdir(), name);
  fs.writeFileSync(file, contents);
  return file;
}

// Assembles a PDF from object parts, computing each stream's /Length so the
// fixtures exercise the same path a real writer's output would.
function makePdf(parts, { trailer = '<< /Root 1 0 R >>' } = {}) {
  let body = '%PDF-1.7\n';
  for (const part of parts) {
    body += `${part.num} 0 obj\n`;
    if (part.stream !== undefined) {
      const data = Buffer.isBuffer(part.stream) ? part.stream : Buffer.from(part.stream, 'latin1');
      body += `<< ${part.dict} /Length ${data.length} >>\nstream\n${data.toString('latin1')}\nendstream\n`;
    } else {
      body += `<< ${part.dict} >>\n`;
    }
    body += 'endobj\n';
  }
  return Buffer.from(`${body}trailer\n${trailer}\n%%EOF\n`, 'latin1');
}

const CATALOG = { num: 1, dict: '/Type /Catalog /Pages 2 0 R' };
const PAGES = { num: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' };
const PAGE = { num: 3, dict: '/Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R' };
const FONT = { num: 5, dict: '/Type /Font /Subtype /Type1 /BaseFont /Helvetica' };

const onePage = (content, extra = []) =>
  makePdf([CATALOG, PAGES, PAGE, { num: 4, dict: '', stream: content }, FONT, ...extra]);

// ---- PDF: the shapes real writers emit ----

test('text is read from an uncompressed content stream', () => {
  const pdf = onePage('BT /F1 12 Tf 72 720 Td (Hello, LanChat.) Tj ET');
  assert.equal(extractPdfText(pdf), 'Hello, LanChat.');
});

test('text is read from a FlateDecode content stream', () => {
  const raw = 'BT /F1 12 Tf 72 720 Td (Compressed content.) Tj ET';
  const pdf = onePage(zlib.deflateSync(Buffer.from(raw, 'latin1')), []);
  // The dict has to declare the filter, or the bytes are taken at face value.
  const withFilter = Buffer.from(pdf.toString('latin1').replace('<<  /Length', '<< /Filter /FlateDecode /Length'), 'latin1');
  assert.equal(extractPdfText(withFilter), 'Compressed content.');
});

test('a TJ array is joined, and its kerning becomes the spaces', () => {
  // -250 is a word space; -20 is ordinary letter kerning and must not become one.
  const pdf = onePage('BT /F1 12 Tf [(Widely) -250 (spaced) -20 (text)] TJ ET');
  assert.equal(extractPdfText(pdf), 'Widely spacedtext');
});

test('escapes and octal inside a literal string survive', () => {
  const pdf = onePage('BT /F1 12 Tf (A \\(nested\\) case \\135 and \\\\ too) Tj ET');
  assert.equal(extractPdfText(pdf), 'A (nested) case ] and \\ too');
});

// The regression this file exists for. A subset font is drawn with renumbered
// glyphs — the content stream says <01><02><03> where the page says "The" — and
// reading those bytes as characters yields convincing mojibake. Worse, writers
// habitually declare the boilerplate two-byte codespace on a font whose codes
// are plainly one byte, so believing the CMap reads every pair as a single code
// and produces nothing at all.
test('a subset font is decoded through its ToUnicode map', () => {
  const cmap = [
    '/CIDInit /ProcSet findresource begin',
    'begincmap',
    '1 begincodespacerange',
    '<0000> <FFFF>', // deliberately wrong for this font, as real writers emit
    'endcodespacerange',
    '3 beginbfchar',
    '<01> <0054>',
    '<02> <0068>',
    '<03> <0065>',
    'endbfchar',
    'endcmap',
  ].join('\n');
  const pdf = makePdf([
    CATALOG,
    PAGES,
    PAGE,
    { num: 4, dict: '', stream: 'BT /F1 12 Tf [<010203>] TJ ET' },
    { num: 5, dict: '/Type /Font /Subtype /TrueType /BaseFont /ABCDEF+Ubuntu /ToUnicode 6 0 R' },
    { num: 6, dict: '', stream: cmap },
  ]);
  assert.equal(extractPdfText(pdf), 'The');
});

test('a bfrange maps a whole span of codes', () => {
  const cmap = [
    'begincmap',
    '1 begincodespacerange',
    '<00> <FF>',
    'endcodespacerange',
    '1 beginbfrange',
    '<41> <43> <0061>',
    'endbfrange',
    'endcmap',
  ].join('\n');
  const pdf = makePdf([
    CATALOG,
    PAGES,
    PAGE,
    { num: 4, dict: '', stream: 'BT /F1 12 Tf (ABC) Tj ET' },
    { num: 5, dict: '/Type /Font /Subtype /TrueType /ToUnicode 6 0 R' },
    { num: 6, dict: '', stream: cmap },
  ]);
  assert.equal(extractPdfText(pdf), 'abc');
});

// Since PDF 1.5 most writers pack page and font dictionaries into a compressed
// object stream. A parser that cannot open one sees a file with no pages.
test('pages packed into an object stream are still found', () => {
  const page = '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>';
  const spare = '<< /Type /Font /Subtype /Type1 >>';
  const header = `3 0 5 ${page.length + 1} `;
  const payload = Buffer.from(`${header}${page} ${spare}`, 'latin1');
  const pdf = makePdf([
    CATALOG,
    PAGES,
    { num: 4, dict: '', stream: 'BT (Inside an object stream.) Tj ET' },
    {
      num: 7,
      dict: `/Type /ObjStm /N 2 /First ${header.length} /Filter /FlateDecode`,
      stream: zlib.deflateSync(payload),
    },
  ]);
  assert.equal(extractPdfText(pdf), 'Inside an object stream.');
});

test('several pages come back in order, separated', () => {
  const pdf = makePdf([
    CATALOG,
    { num: 2, dict: '/Type /Pages /Kids [3 0 R 6 0 R] /Count 2' },
    { num: 3, dict: '/Type /Page /Parent 2 0 R /Contents 4 0 R' },
    { num: 4, dict: '', stream: 'BT (Page one.) Tj ET' },
    { num: 6, dict: '/Type /Page /Parent 2 0 R /Contents 7 0 R' },
    { num: 7, dict: '', stream: 'BT (Page two.) Tj ET' },
  ]);
  assert.equal(extractPdfText(pdf), 'Page one.\n\nPage two.');
});

// ---- PDF: the cases that must fail loudly ----

test('an encrypted PDF is refused rather than decoded into noise', () => {
  const pdf = makePdf([CATALOG, PAGES, PAGE, { num: 4, dict: '', stream: 'BT (secret) Tj ET' }, FONT], {
    trailer: '<< /Root 1 0 R /Encrypt 9 0 R >>',
  });
  assert.throws(() => extractPdfText(pdf), /encrypted/i);
});

test('something that is not a PDF is refused', () => {
  assert.throws(() => extractPdfText(Buffer.from('just some text, honestly')), /not look like a PDF/i);
});

test('an image-only page yields nothing rather than inventing text', () => {
  const pdf = makePdf([
    CATALOG,
    PAGES,
    { num: 3, dict: '/Type /Page /Parent 2 0 R /Contents 4 0 R' },
    { num: 4, dict: '', stream: 'q 612 0 0 792 0 0 cm /Im0 Do Q' },
    { num: 5, dict: '/Type /XObject /Subtype /Image /Width 612 /Height 792', stream: '\x00\x01\x02binary' },
  ]);
  assert.equal(extractPdfText(pdf), '');
});

// Glyph indices with no map back to characters. The output would look like text
// to a length check and like nonsense to a reader, so it is thrown away.
test('an unmappable identity-encoded font produces nothing, not mojibake', () => {
  const pdf = makePdf([
    CATALOG,
    PAGES,
    PAGE,
    { num: 4, dict: '', stream: 'BT /F1 12 Tf <0003000400050006000700080009> Tj ET' },
    { num: 5, dict: '/Type /Font /Subtype /Type0 /Encoding /Identity-H /BaseFont /ABCDEF+Sub' },
  ]);
  assert.equal(extractPdfText(pdf), '');
});

// ---- readDocument ----

test('a markdown file is read whole', () => {
  const file = write('notes.md', '# Title\n\nSome notes.\n');
  const doc = readDocument(file);
  assert.equal(doc.name, 'notes.md');
  assert.equal(doc.text, '# Title\n\nSome notes.\n');
  assert.equal(doc.bytes, fs.statSync(file).size);
});

test('a UTF-8 byte-order mark is not left at the front of the prompt', () => {
  const file = write('bom.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Plain text.')]));
  assert.equal(readDocument(file).text, 'Plain text.');
});

// Notepad still writes this when you pick "Unicode", and it is full of NUL
// bytes — so the binary sniff has to check the byte-order mark first.
test('a UTF-16 text file is read rather than mistaken for binary', () => {
  const le = write('utf16le.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Wide text.', 'utf16le')]));
  assert.equal(readDocument(le).text, 'Wide text.');
  const beBody = Buffer.from('Wide text.', 'utf16le');
  const be = write('utf16be.txt', Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(beBody).swap16()]));
  assert.equal(readDocument(be).text, 'Wide text.');
});

test('data files that happen to be text are readable too', () => {
  for (const [name, body] of [
    ['data.json', '{"a":1}'],
    ['rows.csv', 'a,b\n1,2\n'],
    ['app.log', 'started\nstopped\n'],
    ['conf.yml', 'key: value\n'],
  ]) {
    assert.equal(readDocument(write(name, body)).text, body, name);
  }
});

test('a binary file is refused by its content', () => {
  const file = write('mystery.dat', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]));
  assert.throws(() => readDocument(file), /does not look like text/i);
});

test('a binary file is refused by its extension, before it is sniffed', () => {
  // Text inside, but a .png is not a document whatever its bytes say.
  const file = write('photo.png', 'this is not really a png');
  assert.throws(() => readDocument(file), /not a document/i);
});

test('an oversized file is refused with its size named', () => {
  const file = write('huge.txt', Buffer.alloc(11 * 1024 * 1024, 0x41));
  assert.throws(() => readDocument(file), /too large/i);
});

test('an empty file is refused', () => {
  assert.throws(() => readDocument(write('nothing.txt', '')), /empty/i);
});

test('a missing file says so rather than throwing something internal', () => {
  assert.throws(() => readDocument(path.join(tmpdir(), 'absent.txt')), /could not be opened/i);
});

test('a folder is not a document', () => {
  assert.throws(() => readDocument(tmpdir()), /folder/i);
});

test('a scanned PDF is refused with a reason a person can act on', () => {
  const pdf = makePdf([
    CATALOG,
    PAGES,
    { num: 3, dict: '/Type /Page /Parent 2 0 R /Contents 4 0 R' },
    { num: 4, dict: '', stream: 'q 612 0 0 792 0 0 cm /Im0 Do Q' },
  ]);
  assert.throws(() => readDocument(write('scan.pdf', pdf)), /scan|image-only/i);
});

test('a PDF is recognised by its bytes even under the wrong extension', () => {
  const pdf = onePage('BT (Renamed but still a PDF.) Tj ET');
  assert.equal(readDocument(write('report.txt', pdf)).text, 'Renamed but still a PDF.');
});

// ---- composePrompt ----

test('with nothing attached the prompt is exactly what was typed', () => {
  assert.equal(composePrompt('what is this?', []), 'what is this?');
  assert.equal(composePrompt('what is this?', null), 'what is this?');
});

test('a document is fenced, named, and the question comes last', () => {
  const doc = { name: 'spec.md', path: '/tmp/spec.md', bytes: 24, text: 'The body of the spec.' };
  const prompt = composePrompt('summarise this', [doc]);
  assert.match(prompt, /\[Attached document: spec\.md — \/tmp\/spec\.md \(24 B\)\]/);
  assert.match(prompt, /<<<\nThe body of the spec\.\n>>>/);
  // The question is what the agent has to act on, so it reads last.
  assert.ok(prompt.trimEnd().endsWith('summarise this'), prompt);
  assert.ok(prompt.indexOf('The body of the spec.') < prompt.indexOf('summarise this'));
});

test('a document may be sent with no question at all', () => {
  const doc = { name: 'a.txt', path: '/tmp/a.txt', bytes: 3, text: 'abc' };
  const prompt = composePrompt('', [doc]);
  assert.match(prompt, /abc/);
  assert.ok(!prompt.endsWith('\n\n'), 'no empty question should be tacked on');
});

// The cap is the smallest hard limit in the chain: `command` and `ssh` hand the
// prompt to spawn() as one argv entry, and Windows caps a command line at
// 32,767 characters.
test('a long document is truncated, and says so with the path to the rest', () => {
  const doc = { name: 'long.txt', path: '/tmp/long.txt', bytes: 99999, text: 'x'.repeat(MAX_DOC_CHARS * 2) };
  const prompt = composePrompt('summarise', [doc]);
  assert.ok(prompt.length < MAX_DOC_CHARS + 500, `prompt was ${prompt.length}`);
  assert.match(prompt, /Truncated at [\d,]+ characters/);
  assert.match(prompt, /The whole file is at \/tmp\/long\.txt/);
});

test('several documents share the budget evenly rather than the first one taking it', () => {
  const docs = [
    { name: 'a.txt', path: '/tmp/a.txt', bytes: 1, text: 'a'.repeat(MAX_DOC_CHARS) },
    { name: 'b.txt', path: '/tmp/b.txt', bytes: 1, text: 'b'.repeat(MAX_DOC_CHARS) },
  ];
  const prompt = composePrompt('compare them', docs);
  const share = MAX_DOC_CHARS / 2;
  assert.equal((prompt.match(/a/g) || []).filter(Boolean).length >= share, true);
  assert.ok(prompt.includes('b'.repeat(share)), 'the second document must not be crowded out');
  assert.ok(!prompt.includes('a'.repeat(share + 1)), 'the first document must not exceed its share');
  assert.ok(prompt.length < MAX_DOC_CHARS + 900, `prompt was ${prompt.length}`);
});

test('a short document is passed through untruncated', () => {
  const doc = { name: 's.txt', path: '/tmp/s.txt', bytes: 5, text: 'short' };
  const prompt = composePrompt('q', [doc]);
  assert.ok(!/Truncated/.test(prompt));
});

// ---- the prompt actually reaching a command-line agent ----
//
// The `command` and `ssh` transports hand the prompt to spawn() as a single
// argv entry, which is the whole reason MAX_DOC_CHARS exists. This runs a real
// child process to prove a document survives the trip intact — quotes,
// newlines, backticks and all — rather than being re-split by a shell.
test('a document reaches a command-line agent as one intact argument', async () => {
  const { createCommandTransport } = require('../src/main/agents/transports/command.js');
  const file = write(
    'awkward.md',
    '# Notes\n\nA line with "quotes", $VARS, `backticks` and a ; semicolon.\nAnd a second line.\n'
  );
  const doc = readDocument(file);
  const prompt = composePrompt('summarise this', [doc]);

  const transport = createCommandTransport({
    id: 'agent:test',
    name: 'echo',
    config: {
      command: process.execPath,
      // Echoes back the single argument it was given.
      args: ['-e', 'process.stdout.write(process.argv[1])', '{prompt}'],
    },
    timeoutMs: 20000,
  });

  await transport.start();
  const received = await new Promise((resolve, reject) => {
    transport.send({ text: prompt }, { onDone: ({ text }) => resolve(text), onError: reject });
  });

  assert.match(received, /A line with "quotes", \$VARS, `backticks` and a ; semicolon\./);
  assert.match(received, /And a second line\./);
  assert.match(received, new RegExp(`\\[Attached document: awkward\\.md`));
  assert.ok(received.includes(file), 'the agent is told where the file is');
  assert.ok(received.trimEnd().endsWith('summarise this'), 'the question still reads last');
});

test('the cap keeps a prompt inside the tightest limit any transport imposes', () => {
  // Windows caps an entire command line at 32,767 characters; Linux caps one
  // argv entry at 128 KB. The cap has to clear the smaller of the two with room
  // for the command, its other arguments, and the fences around the document.
  const docs = [{ name: 'big.txt', path: '/tmp/big.txt', bytes: 1, text: 'x'.repeat(5_000_000) }];
  const prompt = composePrompt('x'.repeat(2000), docs);
  assert.ok(prompt.length < 30000, `prompt was ${prompt.length}, too close to the Windows limit`);
});
