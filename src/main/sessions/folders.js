'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Folders of sessions, stored as plain JSON in the Electron userData dir — its
// own file beside sessions.json, for the reason that file gives for being one:
// a growing list has no business travelling through the publicConfig()/
// setConfig() surface that reaches the renderer on every change.
//
// **A folder holds an ordered list of session ids. A session record knows
// nothing about folders, and sessions.json is never written by anything in
// here.** That is the whole design, and it is worth being explicit about why:
//
//   - `SessionRegistry.update()` sets `updatedAt` on every write and `list()`
//     sorts by it. A `folderId` on the session would mean that filing one — an
//     act of tidying — bumped it to the top of the recently-used list.
//   - The session registry deliberately leaves its file byte-identical when a
//     session is merely opened, so that a downgrade is a downgrade. Membership
//     kept over here means a folder operation leaves it byte-identical too, and
//     a build that never heard of folders simply does not read this file.
//   - A trashed session drops out of the live list, so it vanishes from its
//     folder while its id stays in the array **in place** — restoring it puts it
//     back in exactly the slot it left, with nothing written.
//   - Deleting a folder makes its sessions loose again because nothing points at
//     them any more. No sweep, and nobody's `updatedAt` moves.
//
// The one place that has to reach in is a *purge*: a session deleted for good
// would otherwise leave an id behind. See forget(), called from sessions/index.

const FOLDER_ID_PREFIX = 'folder:';

// The name a folder has before anybody names it. Also the fallback when a name
// is edited down to nothing: a row with no words in it cannot be aimed at.
const DEFAULT_FOLDER_NAME = 'New Folder';

// Shorter than a session title's 80. A folder name is a label on a row that also
// carries a count and a chevron, and it is read at a glance rather than read.
const MAX_FOLDER_NAME = 60;

function newFolderId() {
  return `${FOLDER_ID_PREFIX}${crypto.randomUUID()}`;
}

// A folder is as local as the sessions in it: no presence, no key, no address,
// and nothing off the wire may ever claim to be one.
function isFolderId(id) {
  return typeof id === 'string' && id.startsWith(FOLDER_ID_PREFIX);
}

// One line, trimmed, bounded — cleanTitle's rule with a shorter cap. A name is
// written into a sidebar row, so a newline pasted in from anywhere would break it.
function cleanName(name) {
  const flat = String(name == null ? '' : name)
    .replace(/\s+/g, ' ')
    .trim();
  return flat ? flat.slice(0, MAX_FOLDER_NAME) : DEFAULT_FOLDER_NAME;
}

// Strings only, nothing blank, nothing twice, order kept — the order is the
// whole point of the list. cleanIds() in registry.js, for the same reasons.
function cleanIds(ids) {
  if (!Array.isArray(ids)) return [];
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

// Defaults for a record written by an older build. Applied in memory on load and
// deliberately not written back, exactly as the session registry does it: a
// folder merely read leaves the file alone.
function normalize(record) {
  if (!Array.isArray(record.sessionIds)) record.sessionIds = [];
  if (typeof record.name !== 'string') record.name = DEFAULT_FOLDER_NAME;
  return record;
}

class FolderRegistry {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'sessionFolders.json');
    this.records = this.#load();
  }

  #load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!Array.isArray(parsed)) return [];
      const records = parsed.filter((r) => r && isFolderId(r.id)).map(normalize);
      // One session, one folder. A hand-edited file could list the same session
      // twice; the alternative to picking a winner is drawing the row twice, in
      // two places, both of which look authoritative.
      const claimed = new Set();
      for (const record of records) {
        record.sessionIds = cleanIds(record.sessionIds).filter((id) => {
          if (claimed.has(id)) return false;
          claimed.add(id);
          return true;
        });
      }
      return records;
    } catch {
      return [];
    }
  }

  #save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.records, null, 2), 'utf8');
    } catch (err) {
      console.error('[folders] save failed:', err.message);
    }
  }

  // In the order the user put them in. Position in the array is the order —
  // there is no `index` field, for the same reason sessions.json has none and
  // agentIds has none: the order is data.
  list() {
    return this.records;
  }

  get(id) {
    return this.records.find((r) => r.id === id) || null;
  }

  create({ name } = {}) {
    const now = Date.now();
    const record = {
      id: newFolderId(),
      name: cleanName(name),
      sessionIds: [],
      createdAt: now,
      updatedAt: now,
    };
    // At the top, where the person who just made it is looking.
    this.records.unshift(record);
    this.#save();
    return record;
  }

  rename(id, name) {
    const record = this.get(id);
    if (!record) return null;
    record.name = cleanName(name);
    record.updatedAt = Date.now();
    this.#save();
    return record;
  }

  // The folder goes; the sessions in it do not. They become loose again by
  // virtue of nothing pointing at them, which is why there is no sweep here and
  // no session record is touched.
  remove(id) {
    const at = this.records.findIndex((r) => r.id === id);
    if (at < 0) return false;
    this.records.splice(at, 1);
    this.#save();
    return true;
  }

  move(id, toIndex) {
    const from = this.records.findIndex((r) => r.id === id);
    if (from < 0) return false;
    const at = Math.max(0, Math.min(toIndex, this.records.length - 1));
    if (at === from) return false;
    const [moved] = this.records.splice(from, 1);
    this.records.splice(at, 0, moved);
    this.#save();
    return true;
  }

  folderOf(sessionId) {
    return this.records.find((r) => r.sessionIds.includes(sessionId)) || null;
  }

  // The only door to membership, so "a session is in one folder" is a property
  // of this function rather than a rule every caller has to keep.
  //
  // **Removed from everywhere before being inserted anywhere**, and the renderer
  // computes its drop index the same way round. Insert first and a session
  // dragged downward within its own folder lands one slot short, because the
  // index it was measured against still counted itself.
  place(sessionId, { folderId = null, index = null } = {}) {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    const had = this.forget(sessionId, { save: false });
    const target = folderId ? this.get(folderId) : null;
    if (folderId && !target) {
      // Asked for a folder that is not there. The session has already been taken
      // out of wherever it was, so this is "make it loose" rather than a no-op —
      // but only write if something actually changed.
      if (had) this.#save();
      return had;
    }
    if (!target) {
      if (had) this.#save();
      return had;
    }
    const at =
      index == null ? target.sessionIds.length : Math.max(0, Math.min(index, target.sessionIds.length));
    target.sessionIds.splice(at, 0, sessionId);
    target.updatedAt = Date.now();
    this.#save();
    return true;
  }

  // Out of every folder. Used by place() above, and by a purge — a session
  // deleted for good is the one case that would otherwise leave an id behind.
  forget(sessionId, { save = true } = {}) {
    let changed = false;
    for (const record of this.records) {
      const at = record.sessionIds.indexOf(sessionId);
      if (at < 0) continue;
      record.sessionIds.splice(at, 1);
      record.updatedAt = Date.now();
      changed = true;
    }
    if (changed && save) this.#save();
    return changed;
  }
}

module.exports = {
  FolderRegistry,
  isFolderId,
  newFolderId,
  cleanName,
  FOLDER_ID_PREFIX,
  DEFAULT_FOLDER_NAME,
  MAX_FOLDER_NAME,
};
