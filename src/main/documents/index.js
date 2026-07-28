'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { extractPdfText } = require('./pdfText.js');

// Reading a document so an agent can be asked about it.
//
// No agent transport carries attachments — `transport.send({ text }, …)` is the
// whole contract — so a document reaches an agent the only way anything does:
// as words in the prompt. That is not a workaround. It is the same thing a
// person does when they paste a page into a chat, and it works identically for
// a local connector and for an agent shared by a peer, with nothing added to
// the wire protocol.

// Read past this and we are no longer reading a document, we are reading a
// database dump somebody dragged in by accident.
const MAX_BYTES = 10 * 1024 * 1024;

// How much extracted text may go into one prompt, across every attached file.
//
// This is not a taste judgement, it is the smallest hard limit in the chain.
// The `command` and `ssh` transports hand the prompt to spawn() as a single
// argv entry, and Windows caps an entire command line at 32,767 characters.
// Staying well under that keeps every connector working; the truncation notice
// and the file path keep the user informed about what was left out.
const MAX_DOC_CHARS = 24000;

// Only the first slice is sniffed — enough to catch a binary header without
// walking a ten-megabyte file to decide it is not text.
const SNIFF_BYTES = 8192;

// Extensions whose content is binary by definition. Checked before sniffing so
// the message can name the file type rather than saying "this looks binary".
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tif', '.tiff',
  '.mp4', '.webm', '.mov', '.mkv', '.avi', '.wmv',
  '.mp3', '.wav', '.ogg', '.weba', '.m4a', '.flac', '.opus',
  '.zip', '.gz', '.bz2', '.xz', '.7z', '.rar', '.tar', '.jar',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dmg', '.iso', '.appimage',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp',
  '.sqlite', '.db', '.woff', '.woff2', '.ttf', '.otf', '.psd', '.blend',
]);

const CANNOT_READ = 'LanChat can only give agents text and PDF documents.';

// Reads one document into the text an agent will see.
//
// Throws with a sentence fit to put in front of a person — every caller shows
// the message verbatim, so it says what happened and, where it can, why.
function readDocument(filePath) {
  const name = path.basename(filePath);
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new Error(`${name} could not be opened.`);
  }
  if (stat.isDirectory()) throw new Error(`${name} is a folder, not a document.`);
  if (stat.size === 0) throw new Error(`${name} is empty.`);
  if (stat.size > MAX_BYTES) {
    throw new Error(`${name} is too large (${formatBytes(stat.size)}; the limit is ${formatBytes(MAX_BYTES)}).`);
  }

  const ext = path.extname(name).toLowerCase();
  const buf = fs.readFileSync(filePath);

  let text;
  if (ext === '.pdf' || buf.subarray(0, 5).toString('latin1') === '%PDF-') {
    text = extractPdfText(buf);
    // A scan is a picture of a page: nothing was extracted because there was
    // nothing written, only something drawn. Saying so is more use than an
    // empty attachment the agent would be asked about regardless.
    if (!text.trim()) throw new Error(`No readable text in ${name} — it may be a scan or an image-only PDF.`);
  } else {
    if (BINARY_EXTENSIONS.has(ext)) throw new Error(`${name} is not a document. ${CANNOT_READ}`);
    text = decodeText(buf);
    if (text === null) throw new Error(`${name} does not look like text. ${CANNOT_READ}`);
    if (!text.trim()) throw new Error(`${name} has no text in it.`);
  }

  return { path: filePath, name, bytes: stat.size, text };
}

// Text, or null when the bytes are not text at all.
//
// A NUL byte is the giveaway for binary: no encoding this app will meet uses
// one — except UTF-16, which is full of them, and which Notepad still writes
// when you choose "Unicode". So the byte-order mark is checked first, and only
// then does a NUL mean what it usually means.
//
// Deliberately permissive beyond that: .json, .csv, .log, .yml and source files
// of every kind pass, because all of them are worth asking an agent about.
function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) return swap16(buf.subarray(2)).toString('utf16le');
  if (buf.subarray(0, SNIFF_BYTES).includes(0)) return null;
  const text = buf.toString('utf8');
  // A UTF-8 byte-order mark survives decoding as U+FEFF and would otherwise be
  // the first character of the prompt.
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function swap16(buf) {
  const copy = Buffer.from(buf);
  // An odd trailing byte cannot be half of a code unit; drop it rather than
  // letting swap16() throw on the whole file.
  return copy.subarray(0, copy.length - (copy.length % 2)).swap16();
}

// Builds the string handed to the transport.
//
// Documents first, question last: the question is what the agent must act on,
// and it should be the most recent thing it read. Each document is fenced and
// labelled with its absolute path — so a connector that can reach the
// filesystem (`acp`, `command`) can open the whole file itself when the excerpt
// stops short.
function composePrompt(text, docs) {
  if (!docs || !docs.length) return text;
  // Shared evenly, so attaching a long file and a short one does not let the
  // long one crowd the short one out entirely.
  const share = Math.floor(MAX_DOC_CHARS / docs.length);
  const blocks = docs.map((doc) => {
    const body = doc.text.length > share ? doc.text.slice(0, share) : doc.text;
    const lines = [`[Attached document: ${doc.name} — ${doc.path} (${formatBytes(doc.bytes)})]`, '<<<', body, '>>>'];
    if (doc.text.length > share) {
      lines.push(`[Truncated at ${share.toLocaleString('en-US')} characters. The whole file is at ${doc.path}]`);
    }
    return lines.join('\n');
  });
  return text ? `${blocks.join('\n\n')}\n\n${text}` : blocks.join('\n\n');
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

module.exports = { readDocument, composePrompt, formatBytes, MAX_DOC_CHARS, MAX_BYTES };
