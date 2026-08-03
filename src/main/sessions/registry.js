'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { cleanTurns, DEFAULT_TURNS } = require('./dialogue.js');

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

// How a session puts a question to more than one agent: all at once, one after
// another with each shown what has been said so far, or talking to each other
// until they are done.
//
// A build older than this one reads `dialogue` through cleanMode() below and
// gets `parallel`, which is the right way for this to degrade: the session still
// asks the same agents the same question, it simply stops looping. Nothing about
// the record has to be repaired to go back.
const MODES = ['parallel', 'relay', 'dialogue'];
const DEFAULT_MODE = 'parallel';

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

// The agents a session asks, cleaned. Strings only, nothing blank, nothing
// twice — and the order kept, because in relay mode the order of this list is
// the order the agents are asked in. That makes it data rather than
// presentation, and sorting it anywhere would quietly rewrite a conversation.
function cleanIds(ids) {
  if (!Array.isArray(ids)) return [];
  const out = [];
  for (const id of ids) {
    if (typeof id === 'string' && id && !out.includes(id)) out.push(id);
  }
  return out;
}

function cleanMode(mode) {
  return MODES.includes(mode) ? mode : DEFAULT_MODE;
}

// Fills in what a record written by an older build does not have.
//
// In memory only, and deliberately not saved: a session opened by this build and
// otherwise left alone leaves sessions.json byte for byte as it was, so going
// back to the previous version is a downgrade rather than a repair job. The
// fields reach the file the first time something is actually changed.
//
// `agentId` is the field every build before this one knew, so it is what a
// counsel of one is reconstructed from.
function normalize(record) {
  if (!record.agentIds) record.agentIds = record.agentId ? [record.agentId] : [];
  if (record.allAgents === undefined) record.allAgents = false;
  if (!MODES.includes(record.mode)) record.mode = DEFAULT_MODE;
  if (record.turns === undefined) record.turns = DEFAULT_TURNS;
  return record;
}

class SessionRegistry {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'sessions.json');
    this.records = this.#load();
  }

  #load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(parsed) ? parsed.filter((r) => r && isSessionId(r.id)).map(normalize) : [];
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
  //
  // Everything in the Trash is left out. A deleted session is still a record on
  // disk — that is the whole point, it can be put back — but it is not one of
  // this machine's workspaces any more, and every reader of this list treats
  // what it returns as exactly that.
  list() {
    return this.records.filter((r) => !r.deletedAt).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  // What is in the Trash, most recently deleted first — the order somebody
  // looking for what they just lost reads in.
  trashed() {
    return this.records.filter((r) => r.deletedAt).sort((a, b) => b.deletedAt - a.deletedAt);
  }

  // Any record, in the Trash or out of it. The internal door: update(), touch()
  // and the trash pair below all go through it, and so does the service layer,
  // which puts the "not while it is deleted" rule on top rather than in here.
  get(id) {
    return this.records.find((r) => r.id === id) || null;
  }

  create({ title, agentId, agentIds, allAgents, mode, turns } = {}) {
    const now = Date.now();
    const list = agentIds ? cleanIds(agentIds) : cleanIds(agentId ? [agentId] : []);
    const record = {
      id: newSessionId(),
      title: cleanTitle(title),
      // Which agent this session asks. Null is a real state, not a missing one:
      // a session can be started, filled with an imported transcript and read
      // through before anybody decides who to ask about it.
      //
      // The head of `agentIds`, and never anything else — see update() for the
      // whole of why this field still exists.
      agentId: list[0] || null,
      // Everyone this session asks. One question can be put to several agents at
      // once, so this is the real membership and the field above is a view of it.
      agentIds: list,
      // Whether that membership is "whoever is here" rather than a list. Stored
      // as a flag with no names under it on purpose: that is what makes it a
      // standing instruction, so an agent added or shared tomorrow is in this
      // session's counsel tomorrow with nothing having been written down today.
      allAgents: allAgents === true,
      // All at once, one after another with each shown what the last one said,
      // or talking to each other.
      mode: cleanMode(mode),
      // How many turns a dialogue in this session may take. Stored whatever the
      // mode is, so switching to a dialogue and back does not lose the number
      // somebody chose — and so the field is always there to read rather than
      // being one more thing that might be missing.
      turns: cleanTurns(turns === undefined ? DEFAULT_TURNS : turns),
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
    if (patch.agentIds !== undefined) record.agentIds = cleanIds(patch.agentIds);
    if (patch.allAgents !== undefined) record.allAgents = patch.allAgents === true;
    if (patch.mode !== undefined) record.mode = cleanMode(patch.mode);
    if (patch.turns !== undefined) record.turns = cleanTurns(patch.turns);
    // `agentId` is a mirror of the counsel, not a member of it, and it is written
    // on every change so it can never disagree with the list.
    //
    // It exists for one reason: a build older than this one knows only this field.
    // Keeping it filled in means somebody who installs this version, points a
    // session at three agents and then goes back to the previous release opens
    // that session and finds it asking one of them — not nothing, and not a file
    // it cannot read. Which one is the caller's to say, because for a session that
    // asks whoever is available there is no list to take a head from; when nobody
    // says, the head of the list is the obvious answer.
    if (patch.agentId !== undefined) {
      record.agentId = patch.agentId || null;
      // A caller that named an agent and no list means the two are the same
      // thing. Kept in step here rather than at every call site, so no door into
      // this function can leave the mirror pointing at somebody the counsel has
      // never heard of.
      if (patch.agentIds === undefined) record.agentIds = cleanIds(patch.agentId ? [patch.agentId] : []);
    } else if (patch.agentIds !== undefined) {
      record.agentId = record.agentIds[0] || null;
    }
    // How many questions in this session failed without leaving a mark on the
    // question itself.
    //
    // Errors written before failures were attributable name nothing, so there is
    // no way to say *which* question each belonged to — and guessing would write
    // a false commit, which is worse than the wrong total it was meant to fix.
    // The count does not need the link: every error came from exactly one failed
    // run, so N errors swept from a thread means N of its questions were not
    // answered. Subtracting N is arithmetic rather than attribution.
    //
    // Added to rather than replaced, so a session swept twice does not forget the
    // first correction. Clamped at nought, because a negative would be a
    // correction inventing work.
    if (patch.unlinkedFailures !== undefined) {
      record.unlinkedFailures = Math.max(0, (record.unlinkedFailures || 0) + patch.unlinkedFailures);
    }
    // Whether this session has lost questions it can no longer put back. Set with
    // the correction above and cleared when the session is asked something new —
    // by then there is fresh context and the warning has nothing left to warn
    // about.
    if (patch.needsContext !== undefined) record.needsContext = Boolean(patch.needsContext);
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

  // Into the Trash. The record stays exactly as it is and gains one field, so
  // putting it back is deleting that field again — nothing about the session is
  // rebuilt from anything, because nothing about it was ever taken apart.
  //
  // `updatedAt` is deliberately not touched, here or in restore(): when this
  // comes back it belongs where it was in the list, not at the top. Deleting
  // something by accident and putting it back should leave no trace at all.
  trash(id) {
    const record = this.get(id);
    if (!record || record.deletedAt) return null;
    record.deletedAt = Date.now();
    this.#save();
    return record;
  }

  restore(id) {
    const record = this.get(id);
    if (!record || !record.deletedAt) return null;
    delete record.deletedAt;
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
  // record of what was said, but it stops claiming it can ask that agent.
  //
  // The rest of the counsel is untouched. An agent leaving is not the end of a
  // session that was asking three of them — it is one fewer answer to the next
  // question, and the other two carry on. For a counsel of one this comes out
  // exactly where it always did, at a session with nobody to ask.
  //
  // A session set to ask whoever is available is left completely alone, and that
  // is the point of it: there is no list to take a name out of. The agent simply
  // stops being one of the people who are here, which is a fact about the room
  // rather than something to write into the record.
  unbindAgent(agentId) {
    let changed = false;
    for (const record of this.records) {
      if (record.allAgents) continue;
      if (!record.agentIds.includes(agentId)) continue;
      record.agentIds = record.agentIds.filter((id) => id !== agentId);
      record.agentId = record.agentIds[0] || null;
      changed = true;
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
  MODES,
  DEFAULT_MODE,
  DEFAULT_TURNS,
  cleanIds,
  cleanTurns,
  normalize,
};
