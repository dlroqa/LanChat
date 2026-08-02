'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { guessMime } = require('./fileTransfer');

// The pictures a message is talking about.
//
// Agents announce what they made by naming it — a bare `MEDIA:/path` line, or a
// markdown link pointing at `sandbox:/path` — and until now those were two lines
// of dead grey text with the file sitting unreachable on disk beside them. This
// module is what turns a named path into something the window can show: it is
// asked once, where the text becomes a message, and what it hands back is a list
// in exactly the shape of `msg.file`, so the bubble draws an agent's picture with
// the same code that draws one a friend sent.
//
// Four rules decide whether a named path is media at all, and the third is the
// one doing the security work. `guessMime` knows a fixed table of extensions and
// answers `application/octet-stream` for everything else, so `~/.ssh/id_rsa`,
// `/etc/shadow`, a `.pdf` and every extensionless file all fail it. What can be
// named here is therefore a photo, a clip or a sound and nothing else — which
// matters, because a resolved path is one the preview endpoint will then serve.
//
// Who may name a path is decided by the callers, not here: an agent running on
// this machine and the person at the keyboard, never a frame off the wire. See
// reply() in agents/index.js and the two `chat` branches in ipc.js.
//
// Pure apart from the two stat calls, and dependency-free beyond the mime table,
// so the suite can point it at real files in a temp directory.

// A whole line that is nothing but the marker. Anchored per line rather than
// searched for anywhere, because `MEDIA:` in the middle of a sentence is a
// sentence, not an announcement. The trailing newline is part of the match so a
// stripped line leaves no blank one behind.
const MEDIA_LINE = /^[ \t]*MEDIA:(\S[^\n]*?)[ \t]*(?:\r?\n|$)/gm;

// `[label](target)`. The label may not span lines and the target may hold no
// whitespace or parentheses, which is what keeps a run of prose containing a
// bracket and a bracket-pair from being read as a link.
const MARKDOWN_LINK = /\[[^\]\n]{1,200}\]\(([^()\s]+)\)/g;

// Enough for a message that made a handful of charts, few enough that a reply
// which somehow names a thousand files cannot turn into a thousand stat calls.
const MAX_MEDIA = 8;

// The path a marker's target is pointing at, or null when it is pointing
// somewhere that is not a local file.
//
// `sandbox:` is the prefix agents use for a file inside their own working
// directory; it is not a real URL scheme and there is nothing to parse, so the
// prefix simply comes off. `file://` is a real one and goes through
// fileURLToPath, which is what decodes the percent-escapes a path with a space
// in it arrives wearing.
function candidatePath(target) {
  const s = String(target || '').trim();
  if (!s) return null;
  if (/^sandbox:/i.test(s)) return s.slice('sandbox:'.length);
  if (/^file:\/\//i.test(s)) {
    try {
      return fileURLToPath(s);
    } catch {
      return null;
    }
  }
  // Any other scheme belongs to somebody else — `https:` is a link and is
  // handled as one, `javascript:` is refused everywhere. Two or more characters
  // before the colon on purpose: `C:\Users\…` is a Windows path, not a scheme.
  if (/^[a-z][a-z0-9+.-]+:/i.test(s)) return null;
  return s;
}

// What a named path is, or null if it is not media we will show. The cheap
// checks come first so a message full of prose never touches the disk.
function describe(p) {
  if (!p || !path.isAbsolute(p)) return null;
  const mime = guessMime(p);
  if (!/^(image|audio|video)\//.test(mime)) return null;
  let stat;
  try {
    stat = fs.statSync(p);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  return { name: path.basename(p), path: p, size: stat.size, mime };
}

// `strip` removes the bare `MEDIA:` lines that resolved.
//
// It is opt-in because the two callers mean different things by the same marker.
// From an agent it is output protocol — the picture is what the line was
// standing in for, and leaving both would be showing the machinery next to the
// thing it announced. From the person at the keyboard it is prose they typed and
// sent to somebody, so it stays: what is stored has to be what was said.
//
// Markdown links are never stripped either way. They carry a label somebody
// wrote, and the window has somewhere to put it.
function resolveMedia(text, { strip = false } = {}) {
  const s = String(text ?? '');
  if (!s) return { text: s, media: [] };

  const media = [];
  const seen = new Set();
  // True when this path is media, whether it was already found or has just been
  // resolved — a marker naming the same file twice is one picture and two
  // markers, and both of them are machinery.
  const add = (target) => {
    const p = candidatePath(target);
    if (!p) return false;
    if (seen.has(p)) return true;
    if (media.length >= MAX_MEDIA) return false;
    const item = describe(p);
    if (!item) return false;
    seen.add(p);
    media.push(item);
    return true;
  };

  // Both regexes are global, and both are used through methods that leave
  // `lastIndex` alone — replace() resets it, matchAll() works on a copy — so
  // neither call can be affected by the one before it.
  let stripped = 0;
  let out = s.replace(MEDIA_LINE, (line, target) => {
    if (!add(target)) return line;
    stripped += 1;
    return strip ? '' : line;
  });
  for (const m of s.matchAll(MARKDOWN_LINK)) add(m[1]);

  // Taking a line out of the middle of a message leaves the blank lines that
  // were spacing it apart, stacked. Only ever run where a line actually went,
  // so an ordinary message is returned exactly as it arrived.
  if (strip && stripped > 0) out = out.replace(/\n{3,}/g, '\n\n').trim();

  return { text: out, media };
}

module.exports = { resolveMedia, MAX_MEDIA };
