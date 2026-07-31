// The four categories in the left panel, and the arithmetic behind them.
//
// Each category is collapsed until something opens it, which means the heading
// is often the only thing a reader can see of a whole list. Two questions then
// have to be answered without looking inside: which category holds the
// conversation that is open, and which one has something waiting in it. Both are
// decided here rather than in the component, so they can be pinned by the tests
// against the same fixtures the panel renders.
//
// Pure and dependency-free, like linkify.js and findInThread.js — the suite
// loads this file directly with the `export` keywords stripped.

// Canonical order, and the only place a category's title is written down.
export const SECTIONS = [
  { id: 'sessions', title: 'Sessions' },
  { id: 'agents', title: 'Agents' },
  { id: 'people', title: 'People' },
  { id: 'tailnet', title: 'On your tailnet' },
];

export const SECTION_IDS = SECTIONS.map((s) => s.id);

export function sectionTitle(id) {
  const found = SECTIONS.find((s) => s.id === id);
  return found ? found.title : '';
}

// A saved order, made safe to render from.
//
// The order comes back from a config file that an older build wrote, that a
// newer build will write, and that a person can edit by hand. Anything at all
// can be in it. What must never happen is a category going missing: it holds a
// whole list, and a reader with no heading for it has no way to ask for it back.
// So unknown ids are dropped, repeats are dropped, and every canonical id the
// array does not mention is appended in its canonical position order — a
// category added in a later version therefore appears at the bottom for people
// upgrading, rather than not at all.
export function normalizeOrder(saved) {
  const seen = new Set();
  const out = [];
  for (const id of Array.isArray(saved) ? saved : []) {
    if (SECTION_IDS.includes(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  for (const id of SECTION_IDS) if (!seen.has(id)) out.push(id);
  return out;
}

// `id` moved to sit at `toIndex`, counted in the list it has been lifted out of.
//
// Dropping onto your own position, or off either end, gives the order back
// unchanged rather than an error — a drag that ends where it began is a drag the
// user changed their mind about, not a failure.
export function moveSection(order, id, toIndex) {
  const list = normalizeOrder(order);
  const from = list.indexOf(id);
  if (from < 0) return list;
  const rest = list.slice(0, from).concat(list.slice(from + 1));
  const at = Math.max(0, Math.min(rest.length, Math.trunc(toIndex)));
  rest.splice(at, 0, id);
  return rest;
}

// Which category the open conversation lives in, so that one category stays
// expanded whatever else is collapsed. Sessions are checked first: a session id
// and a peer id come from different registries and could in principle collide,
// and the session list is the one the app selected from.
export function sectionForThread(id, { sessions = [], peers = [] } = {}) {
  if (!id) return null;
  if (sessions.some((s) => s.id === id)) return 'sessions';
  const peer = peers.find((p) => p.id === id);
  if (!peer) return null;
  return peer.kind === 'agent' ? 'agents' : 'people';
}

// What a collapsed heading has to say for itself: `{ count, alert }`.
//
// `count` is the number the pill beside the title shows, and `alert` is whether
// the title flashes. They are not the same question. A summoned agent writes no
// message, so it raises no unread count — the row inside says so in words, and
// with the row hidden the heading has to carry it instead. That is why a
// category can be alerting with a count of nought.
//
// Outbound `queued` counts are deliberately not consulted. Those are messages of
// yours waiting to go out, not something that has arrived for you, and a heading
// that flashed for your own outbox would be crying wolf.
export function sectionSignal(items, unread = {}, summoned = {}) {
  let count = 0;
  let alert = false;
  for (const item of items || []) {
    const n = unread[item.id] || 0;
    count += n;
    if (n > 0 || summoned[item.id]) alert = true;
  }
  return { count, alert };
}
