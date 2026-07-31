'use strict';

// Reading a conversation back in.
//
// LanChat writes conversations out as plain text (see `lanchat:exportHistory`),
// and until now that was a one-way door: readable, shareable, and impossible to
// pick up again. This is the way back in — the exact inverse of the exporter, so
// a file saved from any thread loads into a session with its speakers, its days
// and its clock intact.
//
// Deliberately pure and Electron-free: the whole of the parsing is a string in
// and messages out, which is what makes it testable without a window, a dialog
// or a disk.

// What the exporter puts at the top. Recognising it is what tells a transcript
// apart from any other text file somebody drags in.
const HEADER = /^Chat history with (.+)$/;
const EXPORTED = /^Exported .* from LanChat$/;

// `--- Wed Jul 29 2026 ---`, written by Date.toDateString().
const DAY = /^---\s+(.+?)\s+---$/;

// `[09:34] Server: what it said`, or `[09:34 AM] …` where the exporting machine
// runs a 12-hour clock. The speaker is taken up to the first `: ` only, so a
// colon inside the message stays in the message.
const LINE = /^\[(\d{1,2}):(\d{2})(?::\d{2})?(?:\s*([AaPp])\.?[Mm]\.?)?\]\s(.+?):\s?([\s\S]*)$/;

// A peer's question to one of our agents is exported with this after the name.
const VIA_PEER = ' (via peer)';

// Bounds. The store keeps the last 2000 messages of a thread anyway, and one
// bubble holding a whole log file would be unreadable long before it was
// unwise.
const MAX_MESSAGES = 2000;
const MAX_TEXT = 20000;

// A day with no separator above it. Blocks in a plain-text file are spaced a
// minute apart so they read in order and the day separator does not fire.
const BLOCK_GAP_MS = 60 * 1000;

// Turns exported text back into messages.
//
// `at` is when the transcript is from — the file's own modification time, so an
// imported conversation sits in the past where it belongs rather than claiming
// to have happened at the moment it was opened. Only the plain-text path uses
// it; a LanChat export carries its own clock.
function parseTranscript(raw, { at = Date.now() } = {}) {
  const text = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const peer = transcriptPeer(lines);
  return peer === null ? parseBlocks(text, at) : parseExport(lines, peer);
}

// The name in the header of a LanChat export, or null if this is not one.
function transcriptPeer(lines) {
  const first = (lines[0] || '').trim();
  const second = (lines[1] || '').trim();
  const match = HEADER.exec(first);
  if (!match || !EXPORTED.test(second)) return null;
  return match[1].trim();
}

function parseExport(lines, peer) {
  const messages = [];
  let day = null;
  let current = null;

  const flush = () => {
    if (!current) return;
    current.text = current.text.replace(/\s+$/, '');
    if (current.text) messages.push(current);
    current = null;
  };

  for (const line of lines) {
    const dayMatch = DAY.exec(line.trim());
    if (dayMatch) {
      flush();
      const parsed = new Date(dayMatch[1]);
      if (!Number.isNaN(parsed.getTime())) day = parsed;
      continue;
    }

    const match = LINE.exec(line);
    if (match) {
      flush();
      const [, hh, mm, meridiem, speaker, body] = match;
      current = {
        direction: directionOf(speaker.trim(), peer),
        kind: 'text',
        text: body,
        ts: stampFor(day, Number(hh), Number(mm), meridiem),
        speaker: speaker.trim(),
      };
      continue;
    }

    // Anything else belongs to the message above it. The exporter writes the
    // message text raw, so a reply with newlines in it — which is most of what
    // an agent says — arrives here as a run of unprefixed lines. A parser that
    // dropped them would shred every answer it imported and keep only the first
    // sentence.
    if (current) current.text += `\n${line}`;
  }
  flush();

  return { mode: 'lanchat', peer, messages: bound(messages) };
}

// Who said it. The header names the far end of the conversation, so anything
// under that name came in and everything else went out — including a question a
// peer put to one of our agents, which the exporter marks but which was still
// somebody else talking.
function directionOf(speaker, peer) {
  if (speaker === peer) return 'in';
  if (speaker === `${peer}${VIA_PEER}`) return 'in';
  return 'out';
}

function stampFor(day, hour, minute, meridiem) {
  let h = hour;
  if (meridiem) {
    const pm = meridiem.toLowerCase() === 'p';
    h = (hour % 12) + (pm ? 12 : 0);
  }
  const base = day ? new Date(day.getTime()) : new Date();
  base.setHours(h, minute, 0, 0);
  return base.getTime();
}

// Any other text file. Nothing is refused for not being a LanChat export: notes,
// a transcript from somewhere else and a page of pasted log are all things worth
// asking about, and the point of a session is to have something to ask about.
//
// Split on blank lines, because that is the one paragraph convention every kind
// of text file agrees on.
function parseBlocks(text, at) {
  const blocks = text
    .split(/\n\s*\n/)
    .map((b) => b.replace(/\s+$/, '').replace(/^\n+/, ''))
    .filter((b) => b.trim());
  const kept = blocks.slice(0, MAX_MESSAGES);
  const messages = kept.map((block, i) => ({
    direction: 'in',
    kind: 'text',
    text: block,
    // Spaced backwards from the file's own time, so the blocks read in the
    // order they were written and the newest sits at the bottom.
    ts: at - (kept.length - 1 - i) * BLOCK_GAP_MS,
    speaker: null,
  }));
  return { mode: 'text', peer: null, messages: bound(messages) };
}

// The two limits, applied once at the end so both paths get them.
function bound(messages) {
  return messages.slice(-MAX_MESSAGES).map((m) => ({
    ...m,
    text: m.text.length > MAX_TEXT ? `${m.text.slice(0, MAX_TEXT)}\n[Truncated on import]` : m.text,
  }));
}

module.exports = { parseTranscript, MAX_MESSAGES, MAX_TEXT };
