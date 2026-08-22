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

// The fifth category, which is not one of the four.
//
// A room somebody else runs is not a session of yours filed among your own: it
// arrived, somebody is waiting for an answer, and it stops existing when they
// end it. So it is given a heading of its own that comes and goes with it,
// pinned above the four rather than ordered among them.
//
// **Deliberately not in SECTIONS.** Everything that reads that array is about
// the arrangement a person has made of the panel — the order they dragged it
// into, the ones they pinned open, the scopes the search box offers — and none
// of those can be true of a category that may not be there tomorrow. Keeping it
// out means normalizeOrder() drops it from a saved order for free, and a config
// file can never come back naming a category that no longer exists.
export const SHARED = { id: 'shared', title: 'Shared with you' };

// The sixth category, on the same terms as the fifth.
//
// Devices on a Netmaker network that are not running LanChat — the mesh
// equivalent of the tailnet list. **Deliberately not in SECTIONS**, for the same
// reason SHARED is not: a person with no mesh should never see the heading, and
// nothing that reads SECTIONS — the order they dragged it into, the ones they
// pinned, the scopes the search box offers — can be true of a category that may
// not be there tomorrow.
export const NETMAKER = { id: 'netmaker', title: 'On your Netmaker network' };

export function sectionTitle(id) {
  if (id === SHARED.id) return SHARED.title;
  if (id === NETMAKER.id) return NETMAKER.title;
  const found = SECTIONS.find((s) => s.id === id);
  return found ? found.title : '';
}

// ---- rooms somebody else runs ----------------------------------------------
//
// A guest's copy of a shared session, and whether it is still live. Both are
// decided here, next to sectionForThread(), because they are the same question
// that function answers — which heading a session belongs under — and answering
// it in two places is how the two would come to disagree.

// Whose room it is. A session with a host is one we were invited into; one
// without is our own.
export function isGuestRoom(session) {
  return Boolean(session && session.hostPeerId);
}

// A room that has ended: the host has taken us out of it, or gone.
//
// The record stays — it holds a real conversation, and a peer saying so is not
// grounds for deleting somebody's transcript — but it is no longer live, so it
// leaves the pinned category and goes back to being an ordinary session, filed.
// `left` and `revoked` are both endings; see room.js, which writes them.
export function roomEnded(session) {
  if (!isGuestRoom(session)) return false;
  const host = (session.members || []).find((m) => m && m.peerId === session.hostPeerId);
  return host ? host.state === 'left' || host.state === 'revoked' : false;
}

// The two halves of the session list, split by the one rule above. An ended room
// is in `ownSessions` on purpose: it is history now, and history lives under
// Sessions with everything else.
export function liveGuestRooms(sessions) {
  return (sessions || []).filter((s) => isGuestRoom(s) && !roomEnded(s));
}

export function ownSessions(sessions) {
  return (sessions || []).filter((s) => !isGuestRoom(s) || roomEnded(s));
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
    // A room somebody else runs is searched the way a session is, because it is
    // one: the only thing written on the row is the title its host gave it.
    case 'shared':
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
    case 'netmaker':
      // A mesh node is known by its address and the network it is on; a server
      // may also have a name for it. The network is searchable because it is the
      // thing that distinguishes two people who are otherwise just addresses.
      return [
        { field: 'name', text: item.name || item.address },
        { field: 'network', text: item.network },
        { field: 'address', text: item.address },
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
//
// A live room somebody else runs answers `shared` rather than `sessions` — it is
// drawn under the pinned heading, and a category that shut while the
// conversation inside it was open would be the panel losing track of where you
// are. An ended one is back under Sessions and says so.
export function sectionForThread(id, { sessions = [], peers = [] } = {}) {
  if (!id) return null;
  if (liveGuestRooms(sessions).some((s) => s.id === id)) return SHARED.id;
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
