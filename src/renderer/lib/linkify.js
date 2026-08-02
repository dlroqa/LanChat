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

// `[label](target)`, the one piece of markdown that is worth reading. Agents
// write it constantly and people paste it, and until it was scanned for it was
// the one thing in a message guaranteed to render as something nobody meant: a
// label in brackets beside a URL, neither of them clickable.
//
// The label may not span lines and the target may hold neither whitespace nor
// parentheses, which is what keeps a sentence that happens to contain a bracket
// and a bracket-pair from being read as a link.
const MD_LINK_RE = /\[([^\]\n]{1,200})\]\(([^()\s]+)\)/g;

// A file's own name, for deciding whether a link is a picture. Kept in step with
// the mime table in main/fileTransfer.js, which is the list of extensions this
// app is willing to treat as an image anywhere.
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

// Whether an href points at a picture rather than a page. Used to decide what a
// bubble does with it: draw it, or unfurl it into a card.
export function isImageUrl(href) {
  try {
    return IMAGE_EXT_RE.test(new URL(href).pathname);
  } catch {
    return false;
  }
}

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

// The file a markdown target names, or null.
//
// Matched *against* the list main attached to the message rather than parsed out
// of the text, and that is the whole point of it. A path the window worked out
// for itself would be a path a peer could choose, and opening one goes straight
// to the OS — so the only paths that can ever reach that call are the ones main
// already checked and wrote down. A message with no such list can name nothing.
function mediaPath(target, media) {
  const list = Array.isArray(media) ? media : [];
  const t = String(target || '').trim();
  if (!t) return null;
  const bare = t.replace(/^sandbox:/i, '');
  let decoded = null;
  if (/^file:\/\//i.test(t)) {
    decoded = t.slice('file://'.length);
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      // A target that will not decode is simply not a match for anything.
    }
  }
  for (const item of list) {
    const p = item && item.path;
    if (!p) continue;
    if (bare === p || decoded === p) return p;
  }
  return null;
}

// Everything in `s` that is not plain text, found in one pass and in order.
//
// Markdown is looked for first and wins where the two overlap: the URL inside
// `[label](https://x)` is part of the link, not a second one sitting next to it.
// A markdown link whose target resolves to nothing is not a link at all and
// claims no ground, so the text it sits in is still scanned normally.
function findMarks(s, media) {
  const marks = [];
  MD_LINK_RE.lastIndex = 0;
  for (let m = MD_LINK_RE.exec(s); m; m = MD_LINK_RE.exec(s)) {
    const [whole, label, target] = m;
    const href = safeHref(target);
    const path = href ? null : mediaPath(target, media);
    if (!href && !path) continue;
    const labelAt = m.index + 1;
    marks.push({
      start: m.index,
      end: m.index + whole.length,
      open: '[',
      body: { type: href ? 'link' : 'file', text: label, ...(href ? { href } : { path }) },
      close: s.slice(labelAt + label.length, m.index + whole.length),
    });
  }

  const taken = (from, to) => marks.some((k) => from < k.end && to > k.start);
  URL_RE.lastIndex = 0;
  for (let m = URL_RE.exec(s); m; m = URL_RE.exec(s)) {
    const matched = trimTrailing(m[0]);
    const href = safeHref(matched);
    const end = m.index + matched.length;
    if (href && !taken(m.index, end)) {
      marks.push({ start: m.index, end, body: { type: 'link', text: matched, href } });
    }
    // Resume right after the trimmed link, so punctuation we gave back is still
    // available to whatever follows.
    URL_RE.lastIndex = end;
  }

  return marks.sort((a, b) => a.start - b.start);
}

// Splits text into runs, in order. Four types:
//
//   text    what it says
//   link    an http(s) URL, opened in the real browser
//   file    a picture on this machine, from `media` — see mediaPath above
//   syntax  the brackets and target of a markdown link, hidden by the bubble
//
// The concatenated `text` of every run still equals the input exactly, which is
// the invariant everything downstream is built on: findInThread.js numbers the
// search hits by their offsets into the message and re-cuts these same runs at
// their edges, and a run list that had quietly dropped a character would put
// every highlight after it in the wrong place. It is also why the markdown
// syntax is kept as runs of its own rather than thrown away — hiding it is the
// bubble's business, not the scanner's.
export function linkify(text, media) {
  const s = String(text ?? '');
  if (!s) return [];
  const out = [];
  let at = 0;
  for (const mark of findMarks(s, media)) {
    if (mark.start > at) out.push({ type: 'text', text: s.slice(at, mark.start) });
    if (mark.open) out.push({ type: 'syntax', text: mark.open });
    out.push(mark.body);
    if (mark.close) out.push({ type: 'syntax', text: mark.close });
    at = mark.end;
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
