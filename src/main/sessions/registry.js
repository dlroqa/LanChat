'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Persistent list of sessions, stored as plain JSON in the Electron userData
// dir — its own file rather than config.json, for the same reason agents.json is
// its own file: deleting a session should be a clean record deletion, and a
// growing list of workspaces has no business travelling through the
// publicConfig()/setConfig() surface that reaches the renderer on every change.
//
// A record holds only what the window cannot work out for itself. The messages
// live where every other thread's messages live, in MessageStore under the
// session's own id, so nothing here duplicates a transcript.

const SESSION_ID_PREFIX = 'session:';

// The name a session has before anybody names it. Also the fallback when a
// title is edited down to nothing: a row with no words in it is unclickable.
const DEFAULT_TITLE = 'New Session';

// Long enough for a sentence about what the session is for, short enough that
// the sidebar row and the header stay one line.
const MAX_TITLE = 80;

function newSessionId() {
  return `${SESSION_ID_PREFIX}${crypto.randomUUID()}`;
}

// A session is a purely local construct: it has no presence, no key, and no
// address, and nothing off the wire may ever claim to be one. Every guard that
// depends on that reads this function rather than the prefix.
function isSessionId(id) {
  return typeof id === 'string' && id.startsWith(SESSION_ID_PREFIX);
}

// One line, trimmed, bounded. A title is written into a sidebar row and a
// header, so a newline pasted in from a transcript would break both.
function cleanTitle(title) {
  const flat = String(title == null ? '' : title)
    .replace(/\s+/g, ' ')
    .trim();
  return flat ? flat.slice(0, MAX_TITLE) : DEFAULT_TITLE;
}

class SessionRegistry {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'sessions.json');
    this.records = this.#load();
  }

  #load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(parsed) ? parsed.filter((r) => r && isSessionId(r.id)) : [];
    } catch {
      return [];
    }
  }

  #save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.records, null, 2), 'utf8');
    } catch (err) {
      console.error('[sessions] save failed:', err.message);
    }
  }

  // Newest first: a session is a piece of work in progress, and the one you were
  // just in is the one you are most likely to want back.
  list() {
    return [...this.records].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  get(id) {
    return this.records.find((r) => r.id === id) || null;
  }

  create({ title, agentId } = {}) {
    const now = Date.now();
    const record = {
      id: newSessionId(),
      title: cleanTitle(title),
      // Which agent this session asks. Null is a real state, not a missing one:
      // a session can be started, filled with an imported transcript and read
      // through before anybody decides who to ask about it.
      agentId: agentId || null,
      createdAt: now,
      updatedAt: now,
    };
    this.records.push(record);
    this.#save();
    return record;
  }

  update(id, patch) {
    const record = this.get(id);
    if (!record) return null;
    if (patch.title !== undefined) record.title = cleanTitle(patch.title);
    if (patch.agentId !== undefined) record.agentId = patch.agentId || null;
    record.updatedAt = Date.now();
    this.#save();
    return record;
  }

  // Bumps a session up the list without changing anything about it. Called when
  // something is said in one, so the ordering above reflects use rather than
  // renaming.
  touch(id) {
    const record = this.get(id);
    if (!record) return null;
    record.updatedAt = Date.now();
    this.#save();
    return record;
  }

  remove(id) {
    const before = this.records.length;
    this.records = this.records.filter((r) => r.id !== id);
    if (this.records.length === before) return false;
    this.#save();
    return true;
  }

  // Every session that asked a particular agent. Used when an agent is removed
  // or a peer who shared one goes away for good: the session survives as a
  // record of what was said, but it stops claiming it can ask anybody.
  unbindAgent(agentId) {
    let changed = false;
    for (const record of this.records) {
      if (record.agentId === agentId) {
        record.agentId = null;
        changed = true;
      }
    }
    if (changed) this.#save();
    return changed;
  }
}

module.exports = {
  SessionRegistry,
  isSessionId,
  newSessionId,
  cleanTitle,
  SESSION_ID_PREFIX,
  DEFAULT_TITLE,
  MAX_TITLE,
};
