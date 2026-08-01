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

// ---- searching --------------------------------------------------------------
//
// The search box can be aimed at one category or left pointing at all of them.
// `all` is not a category id, so it can never collide with one.
export const SCOPE_ALL = 'all';

// What the box says it will do, which is also what it does.
export function searchPlaceholder(scope) {
  return scope && scope !== SCOPE_ALL ? `Search ${sectionTitle(scope)}` : 'Search everything';
}

// The choices in the scope menu, in the order the categories have been dragged
// into — the menu is a picture of the panel, so it has to agree with it.
export function scopeOptions(order) {
  return [
    { id: SCOPE_ALL, title: 'Everything' },
    ...normalizeOrder(order).map((id) => ({ id, title: sectionTitle(id) })),
  ];
}

// The text a row offers a search, in the order a hit is reported in.
//
// Addresses and connector kinds are in here although a row does not always show
// them — searching for an IP you have on a sticky note should find the machine.
// That is exactly why a result says *which* field it hit: a row that matched on
// something invisible would otherwise look like a mistake.
export function searchFields(id, item, platformLabel = () => '') {
  if (!item) return [];
  switch (id) {
    case 'sessions':
      return [{ field: 'name', text: item.title }];
    case 'agents':
    case 'people':
      return [
        { field: 'name', text: item.name },
        { field: 'hostname', text: item.hostname },
        { field: 'platform', text: platformLabel(item.platform) },
        { field: 'address', text: item.address },
        { field: 'connector', text: item.agentKind },
      ];
    case 'tailnet':
      // A tailnet device's name *is* its hostname — there is nothing else it
      // has been called — so it is reported as the name rather than as a
      // hostname that happens to be all there is.
      return [
        { field: 'name', text: item.hostname },
        { field: 'platform', text: platformLabel(item.os) },
        { field: 'address', text: item.ip },
      ];
    default:
      return [];
  }
}

// The first field of a row that contains `q`, or null. Plain case-insensitive
// substring — the same rule the roster has always used and the same one the find
// bar in a conversation uses, so one search box does not mean something
// different from another.
export function matchIn(id, item, q, platformLabel) {
  const s = String(q ?? '')
    .trim()
    .toLowerCase();
  if (!s) return null;
  for (const f of searchFields(id, item, platformLabel)) {
    const text = String(f.text ?? '');
    if (text && text.toLowerCase().includes(s)) return { field: f.field, text };
  }
  return null;
}

// A category's rows that answer `q`, each carrying what it matched on. An empty
// query is not a search: everything comes back, unmatched.
export function searchSection(id, items, q, platformLabel) {
  const list = items || [];
  if (!String(q ?? '').trim()) return list.map((item) => ({ item, field: null, text: '' }));
  const out = [];
  for (const item of list) {
    const hit = matchIn(id, item, q, platformLabel);
    if (hit) out.push({ item, field: hit.field, text: hit.text });
  }
  return out;
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
