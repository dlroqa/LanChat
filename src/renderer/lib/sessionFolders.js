// Sessions, filed.
//
// The Sessions list is one flat list sorted by when each session was last used,
// which is the right answer until there are thirty of them. Folders are the way
// out: user-made, named, collapsible, and holding whichever sessions were put in
// them in whatever order they were put.
//
// **A folder owns an ordered list of session ids; a session knows nothing about
// folders.** That is the load-bearing decision here, and it is not arbitrary.
// `SessionRegistry.update()` sets `updatedAt` on every write and `list()` sorts
// by it, so a `folderId` stored on the session would mean that *filing* a
// session — an act of tidying — bumped it to the top of the recently-used list.
// It would also mean every folder operation rewrote sessions.json, which the
// registry goes out of its way to leave untouched so that opening a session
// leaves the file byte-identical and a downgrade stays a downgrade.
//
// Two things fall out of it for free, and both are worth having:
//
//   - A trashed session leaves the live list, so it vanishes from its folder
//     while its id stays in the array, in place. Restoring it puts it back in
//     exactly the slot it left, with nothing written anywhere.
//   - Deleting a folder makes its sessions loose again simply because nothing
//     points at them any more. No sweep, and no session's `updatedAt` moves.
//
// Everything in this file is arithmetic over those two lists. No React, no DOM —
// the same shape as sidebarSections.js, and for the same reason: the rules are
// worth reading and worth testing without a browser.

// Which folder holds a session, or null.
//
// First folder wins. A hand-edited file could list one session in two folders,
// and the alternative to picking one is drawing the same row twice.
export function folderOf(folders, sessionId) {
  if (!sessionId) return null;
  for (const folder of folders || []) {
    if ((folder.sessionIds || []).includes(sessionId)) return folder;
  }
  return null;
}

// Every session id that is in some folder. Built once per render and asked a lot.
export function filedIds(folders) {
  const out = new Set();
  for (const folder of folders || []) {
    for (const id of folder.sessionIds || []) out.add(id);
  }
  return out;
}

// The sessions in a folder, in the order the folder holds them.
//
// Ids with no live session behind them are dropped rather than repaired: a
// trashed session is not gone, it is somewhere else, and its place in the array
// is exactly what it needs when it comes back.
export function folderSessions(folder, byId) {
  const out = [];
  for (const id of (folder && folder.sessionIds) || []) {
    const session = byId.get(id);
    if (session) out.push(session);
  }
  return out;
}

// The sessions in no folder at all, in the order they arrived — which is most
// recently used first, because that is how main sorted them and nothing here
// re-sorts. Loose sessions keep the behaviour the list has always had; only
// filed ones are arranged by hand.
export function looseSessions(sessions, folders) {
  const filed = filedIds(folders);
  return (sessions || []).filter((s) => !filed.has(s.id));
}

// Where a session being dragged should land, given the row it was dropped on.
//
// **The moving id is removed before the target is located**, and the registry's
// `place()` removes before it inserts for the same reason. Locate first and a
// session dragged *downward* within its own folder lands one slot short, because
// the index it was measured against still counted itself.
export function dropIndex(sessionIds, movingId, overId, before) {
  const ids = sessionIds || [];
  // Dropped on itself. Every row is a target, including the one being carried,
  // and without this the general case below finds nothing (it has already been
  // removed), answers "the end", and quietly sends a session to the bottom of
  // its own folder for a drag that never left the row it started on. Its current
  // index is also its index in the list with it taken out, which is what the
  // caller inserts into.
  if (movingId === overId) return ids.indexOf(movingId);
  const rest = ids.filter((x) => x !== movingId);
  const at = rest.indexOf(overId);
  if (at < 0) return rest.length;
  return at + (before ? 0 : 1);
}

// A folder list with one folder moved to a new position. The same arithmetic
// moveSection() does for the sidebar's categories, over a different list.
export function moveFolder(folders, id, toIndex) {
  const list = [...(folders || [])];
  const from = list.findIndex((f) => f.id === id);
  if (from < 0) return list;
  const at = Math.max(0, Math.min(toIndex, list.length - 1));
  if (at === from) return list;
  const [moved] = list.splice(from, 1);
  list.splice(at, 0, moved);
  return list;
}

// Whether a drop would change anything. A drag that ends where it started should
// write nothing at all — not the same value again, which would publish a list
// and redraw the panel for no reason.
export function isNoopPlace(folders, sessionId, folderId, index) {
  const current = folderOf(folders, sessionId);
  const currentId = current ? current.id : null;
  if (currentId !== (folderId || null)) return false;
  if (!current) return true;
  return current.sessionIds.indexOf(sessionId) === index;
}
