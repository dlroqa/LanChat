// Finding the links in a message.
//
// Message text is plain text on the wire — no markup, no markdown — and it stays
// that way here: the text is *scanned*, never parsed into HTML. linkify() hands
// back a list of runs, and the bubble renders each one as either text or an <a>
// it builds itself, so nothing a peer (or an agent) writes can become an element
// we did not ask for.
//
// Pure and dependency-free, so the test suite can load it the way it loads the
// other renderer helpers and pin the scanner against real messages.

// A link is either explicit about its scheme or starts with the one prefix
// people actually type without one. Everything up to whitespace belongs to the
// match; the punctuation a sentence leaves behind is trimmed off afterwards.
const URL_RE = /(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;

// Sentence punctuation that can never be the last character a user meant to
// include. Brackets are handled separately — they are legitimate inside a URL.
const TRAILING = new Set(['.', ',', ';', ':', '!', '?', '…', '"', "'", '’', '”', '»']);
const CLOSERS = { ')': '(', ']': '[', '}': '{' };

// True when every closing bracket in `s` has an opener, i.e. the last one is
// part of the URL (…/wiki/Foo_(bar)) rather than the wrapping of a sentence.
function bracketsBalanced(s, closer) {
  const opener = CLOSERS[closer];
  let depth = 0;
  for (const ch of s) {
    if (ch === opener) depth += 1;
    else if (ch === closer) depth -= 1;
  }
  return depth === 0;
}

function trimTrailing(url) {
  let out = url;
  while (out.length > 1) {
    const last = out[out.length - 1];
    if (TRAILING.has(last)) {
      out = out.slice(0, -1);
      continue;
    }
    if (CLOSERS[last] && !bracketsBalanced(out, last)) {
      out = out.slice(0, -1);
      continue;
    }
    break;
  }
  return out;
}

// The href a matched run actually opens. Returns null for anything that is not
// plain web browsing, so a `javascript:`/`file:`/`data:` URL smuggled into a
// message can never reach shell.openExternal. URL() also re-encodes the parts
// that need it, which is what makes the result safe to hand to the OS.
export function safeHref(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const withScheme = /^www\./i.test(s) ? `https://${s}` : s;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname) return null;
    return u.href;
  } catch {
    return null;
  }
}

// Splits text into `{ type: 'text' | 'link' }` runs, in order. The concatenated
// `text` of every run always equals the input, so nothing is ever dropped.
export function linkify(text) {
  const s = String(text ?? '');
  if (!s) return [];
  const out = [];
  let at = 0;
  URL_RE.lastIndex = 0;
  let m = URL_RE.exec(s);
  while (m) {
    const matched = trimTrailing(m[0]);
    const href = safeHref(matched);
    if (href) {
      if (m.index > at) out.push({ type: 'text', text: s.slice(at, m.index) });
      out.push({ type: 'link', text: matched, href });
      at = m.index + matched.length;
      // Resume right after the trimmed link, so punctuation we gave back is
      // still part of the following text run.
      URL_RE.lastIndex = at;
    }
    m = URL_RE.exec(s);
  }
  if (at < s.length) out.push({ type: 'text', text: s.slice(at) });
  return out;
}

export function hasLink(text) {
  return linkify(text).some((run) => run.type === 'link');
}

// The one link a bubble shows a preview for: the first, so a message with
// several never turns into a wall of cards.
export function firstLink(text) {
  const run = linkify(text).find((r) => r.type === 'link');
  return run ? run.href : null;
}
