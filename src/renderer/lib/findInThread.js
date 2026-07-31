// Finding a word in a conversation.
//
// A long session is not something anybody scrolls twice, so the find bar asks
// this module two things: how many times a word occurs in the whole thread, and
// where each occurrence sits inside a particular message. Both answers have to
// agree, because the counter says "5 of 17" and the arrows walk the same 17 in
// the order they are read on screen. That agreement is the whole design here:
// every hit gets an ordinal, ordinals are handed out in render order, and the
// bubble marks its own text using the same order the pane counted with.
//
// Like linkify.js, this is pure and dependency-free — message text is *scanned*,
// never parsed — so the test suite can load it and pin it against real messages.

// Where `query` occurs in `text`, as [start, end) offsets into the original
// string, in order and never overlapping.
//
// Matching is a plain case-insensitive substring, the same rule the sidebar
// search already uses: no regex, no word boundaries, no accent folding. A user
// who types a trailing space means it, the way they would in a browser.
export function matchRanges(text, query) {
  const s = String(text ?? '');
  const q = String(query ?? '');
  if (!s || !q.trim()) return [];

  // Lowercasing is per-character in nearly every script, but not all of it —
  // 'İ' becomes two code units, and every offset after it would then point at
  // the wrong character. When the lengths disagree the offsets can no longer be
  // trusted, so that rare case falls back to matching exactly as typed rather
  // than marking the wrong letters.
  const hay = s.toLowerCase();
  const needle = q.toLowerCase();
  const exact = hay.length !== s.length || needle.length !== q.length;
  const inText = exact ? s : hay;
  const inQuery = exact ? q : needle;

  const out = [];
  let at = inText.indexOf(inQuery);
  while (at !== -1) {
    out.push({ start: at, end: at + inQuery.length });
    // Non-overlapping: "aa" in "aaaa" is two hits, not three, which is what the
    // counter has to say for the arrows to be able to visit each one.
    at = inText.indexOf(inQuery, at + inQuery.length);
  }
  return out;
}

// Everything in one message a search should look at, in the order the bubble
// renders it — the quote a fork pinned, then the documents handed over, then
// the message itself. Ordinals are handed out in this order, so stepping
// forward always moves down the screen.
export function searchableFields(msg) {
  const out = [];
  if (msg?.context?.text) out.push({ key: 'context', text: msg.context.text });
  for (const [i, doc] of (msg?.docs || []).entries()) {
    if (doc?.name) out.push({ key: `doc:${i}`, text: doc.name });
  }
  // A file bubble has no text of its own: what is on screen, and what somebody
  // would search for, is the name of the file.
  if (msg?.kind === 'file') {
    if (msg.file?.name) out.push({ key: 'file', text: msg.file.name });
  } else if (msg?.text) {
    out.push({ key: 'text', text: msg.text });
  }
  return out;
}

// How many times the query occurs anywhere in one message.
export function countHits(msg, query) {
  let n = 0;
  for (const field of searchableFields(msg)) n += matchRanges(field.text, query).length;
  return n;
}

// The ranges for each field of one message, each carrying the ordinal its first
// hit was given. `base` is where this message starts in the thread's numbering.
export function fieldHits(msg, query, base = 0) {
  const out = new Map();
  let at = base;
  for (const field of searchableFields(msg)) {
    const ranges = matchRanges(field.text, query);
    out.set(field.key, { ranges, base: at });
    at += ranges.length;
  }
  return out;
}

// The whole thread: how many hits there are, and where each message's numbering
// starts. The pane needs only these two facts — each bubble works out its own
// ranges from its base, which keeps the memo per message rather than one array
// that every new message would rebuild.
export function threadHits(messages, query) {
  const bases = new Map();
  let total = 0;
  for (const msg of messages || []) {
    bases.set(msg.id, total);
    total += countHits(msg, query);
  }
  return { total, bases };
}

// Splits linkify()'s runs again, at the edges of the hits, so each piece is
// either inside a match or outside one. A piece inside carries the ordinal of
// the hit it belongs to; everything else carries null.
//
// linkify's invariant survives: the concatenated `text` of the returned runs is
// still exactly the input, so nothing said can be dropped, and a hit that
// straddles the start of a link comes back as two pieces sharing one ordinal
// rather than as a match that quietly went missing.
export function sliceRuns(runs, ranges, base = 0) {
  const list = runs || [];
  if (!ranges || ranges.length === 0) return list.map((run) => ({ ...run, hit: null }));

  const out = [];
  const push = (run, from, to, hit) => {
    if (to > from) out.push({ ...run, text: run.text.slice(from, to), hit });
  };

  // `at` walks the absolute offset of each run's first character; `first` is the
  // earliest range that can still reach the run being looked at.
  let at = 0;
  let first = 0;
  for (const run of list) {
    const start = at;
    const end = at + run.text.length;
    at = end;
    while (first < ranges.length && ranges[first].end <= start) first += 1;

    let cut = start;
    let i = first;
    while (i < ranges.length && ranges[i].start < end) {
      const from = Math.max(ranges[i].start, start);
      const to = Math.min(ranges[i].end, end);
      push(run, cut - start, from - start, null);
      push(run, from - start, to - start, base + i);
      cut = to;
      i += 1;
    }
    push(run, cut - start, end - start, null);
  }
  return out;
}
