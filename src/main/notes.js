'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Notes: this machine's own writing, kept beside the conversations rather than
// in one.
//
// A note belongs to the person at this keyboard and to nobody else. It is never
// sent, never asked for over the wire, and has no peer, no thread and no
// presence attached to it — which is why it is a store of its own rather than
// another kind of message.
//
// It is stored in two halves, and that split is the point of this file.
// `notes.json` holds one small record per note, and each body lives in its own
// file under `notes/`. A note body is prose with no bound on it, being typed a
// character at a time; a single array rewritten on every keystroke would mean
// rewriting every note anyone has ever written in order to record one letter.
// The list, meanwhile, has to be readable without opening anything, so each
// record carries the first line of its body as a preview.
//
// Deleting sends a note to the Trash rather than destroying it, the same
// bargain sessions make: the record stays on disk with a `deletedAt` stamp, and
// the body file is only unlinked when the note is purged. Losing an afternoon's
// writing to a misclick is not a thing this should be able to do.

const NOTE_ID_PREFIX = 'note:';

// The name a note has before anybody names it. Also the fallback when a title
// is edited down to nothing: a row with no words in it is unclickable.
const DEFAULT_TITLE = 'Untitled note';

// One line in a narrow column, so the same bound the session titles use.
const MAX_TITLE = 80;

// Enough of the first line to recognise a note by in the list, and no more —
// this is metadata that gets rewritten, not the note.
const MAX_PREVIEW = 120;

// How stale a record's timestamp has to be before a body-only edit is worth
// rewriting the metadata file for.
//
// Typing is the case this exists for. The body file is written on every save,
// because it is one file and it is the thing being typed; `notes.json` is not,
// because the only thing changing in it is a clock reading nobody is looking
// at. So it is left alone until either something visible moves — the title, the
// preview — or the reading it holds has drifted this far from the truth. A
// check on write rather than a timer, for the reason the session round makes
// the same argument: a timer would burn a wakeup to notice something nobody is
// waiting on. Looking away flushes it regardless, via `final`.
const META_COALESCE_MS = 10_000;

function newNoteId() {
  return `${NOTE_ID_PREFIX}${crypto.randomUUID()}`;
}

// A note is a purely local construct with no presence, no key and no address,
// and nothing off the wire may ever claim to be one. Every guard that depends
// on that reads this rather than the prefix.
function isNoteId(id) {
  return typeof id === 'string' && id.startsWith(NOTE_ID_PREFIX);
}

function cleanTitle(title) {
  const flat = String(title == null ? '' : title)
    .replace(/\s+/g, ' ')
    .trim();
  return flat ? flat.slice(0, MAX_TITLE) : DEFAULT_TITLE;
}

// The first line with anything on it, which is what a person would call the
// gist. Not the first N characters: a note that opens with a blank line or a
// heading rule would preview as nothing at all.
function previewOf(body) {
  const text = String(body == null ? '' : body);
  for (const line of text.split('\n')) {
    const flat = line.replace(/\s+/g, ' ').trim();
    if (flat) return flat.slice(0, MAX_PREVIEW);
  }
  return '';
}

class NoteStore {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'notes.json');
    this.dir = path.join(userDataDir, 'notes');
    fs.mkdirSync(this.dir, { recursive: true });
    this.records = this.#load();
  }

  // One body, one file. The same sanitising MessageStore does, so an id that
  // somehow arrived with a path separator in it cannot name a file outside this
  // directory.
  bodyFile(id) {
    const safe = String(id).replace(/[^\w.\-]+/g, '_');
    return path.join(this.dir, `${safe}.md`);
  }

  #load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(parsed) ? parsed.filter((r) => r && isNoteId(r.id)) : [];
    } catch {
      return [];
    }
  }

  #save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.records, null, 2), 'utf8');
    } catch (err) {
      console.error('[notes] save failed:', err.message);
    }
  }

  #writeBody(id, body) {
    try {
      fs.writeFileSync(this.bodyFile(id), String(body == null ? '' : body), 'utf8');
      return true;
    } catch (err) {
      console.error('[notes] body save failed:', err.message);
      return false;
    }
  }

  // Newest first, and everything in the Trash left out — a deleted note is
  // still a record on disk, which is the whole point, but it is not one of this
  // machine's notes any more.
  list() {
    return this.records.filter((r) => !r.deletedAt).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  // What is in the Trash, most recently deleted first: the order somebody
  // looking for what they just lost reads in.
  trashed() {
    return this.records.filter((r) => r.deletedAt).sort((a, b) => b.deletedAt - a.deletedAt);
  }

  // Any record, in the Trash or out of it. The internal door.
  get(id) {
    return this.records.find((r) => r.id === id) || null;
  }

  // A note and its body together. The only call that opens a body file, and the
  // reason the list never has to.
  read(id) {
    const record = this.get(id);
    if (!record) return null;
    let body = '';
    try {
      body = fs.readFileSync(this.bodyFile(id), 'utf8');
    } catch {
      // A record with no body file is a note that has never had anything typed
      // into it, which is exactly what a new one is.
      body = '';
    }
    return { ...record, body };
  }

  create({ title, body } = {}) {
    const now = Date.now();
    const record = {
      id: newNoteId(),
      // A brand-new note is untitled until somebody types in it, and cleanTitle
      // would name it before they had the chance. Only an actual title given
      // here is cleaned.
      title: title == null ? DEFAULT_TITLE : cleanTitle(title),
      preview: previewOf(body),
      createdAt: now,
      updatedAt: now,
    };
    this.records.push(record);
    if (body != null) this.#writeBody(record.id, body);
    this.#save();
    return record;
  }

  // A save from the editor. `body` and `title` are both optional: the editor
  // sends whichever moved.
  //
  // `final` is the flush — the editor sets it when the note is closed, switched
  // away from, or has lost focus. It is what makes the coalescing above safe:
  // the moment somebody stops typing, the record on disk agrees with the body
  // beside it, whatever the clock says.
  save(id, { title, body, final } = {}) {
    const record = this.get(id);
    if (!record) return null;

    let moved = Boolean(final);
    if (body !== undefined) {
      this.#writeBody(id, body);
      const preview = previewOf(body);
      if (preview !== record.preview) {
        record.preview = preview;
        moved = true;
      }
    }
    if (title !== undefined) {
      const clean = cleanTitle(title);
      if (clean !== record.title) {
        record.title = clean;
        moved = true;
      }
    }
    // Nothing visible changed and the timestamp is still roughly true: the body
    // is already on disk, and rewriting every other note's record to move this
    // one's clock by a second is work with nobody waiting on it.
    if (!moved && Date.now() - (record.updatedAt || 0) < META_COALESCE_MS) return record;

    record.updatedAt = Date.now();
    this.#save();
    return record;
  }

  // To the Trash. `updatedAt` is deliberately left alone — it says when the note
  // was last written in, and deleting is not writing. Restoring therefore puts
  // it back in the list exactly where it was.
  trash(id) {
    const record = this.get(id);
    if (!record || record.deletedAt) return false;
    record.deletedAt = Date.now();
    this.#save();
    return true;
  }

  restore(id) {
    const record = this.get(id);
    if (!record || !record.deletedAt) return false;
    delete record.deletedAt;
    this.#save();
    return true;
  }

  // Gone for good, body and all. Only reachable from the Trash: a note that has
  // not been deleted cannot be purged, so there is no path from the list
  // straight to this.
  //
  // The body file goes with the record. One left behind is bytes on disk that
  // nothing points at and nothing will ever clean up.
  purge(id) {
    const record = this.get(id);
    if (!record || !record.deletedAt) return false;
    try {
      fs.rmSync(this.bodyFile(id), { force: true });
    } catch (err) {
      console.error('[notes] purge failed:', err.message);
    }
    this.records = this.records.filter((r) => r.id !== id);
    this.#save();
    return true;
  }

  restoreAll() {
    const ids = this.trashed().map((r) => r.id);
    for (const id of ids) this.restore(id);
    return ids.length;
  }

  purgeAll() {
    const ids = this.trashed().map((r) => r.id);
    for (const id of ids) this.purge(id);
    return ids.length;
  }
}

module.exports = { NoteStore, isNoteId, newNoteId, previewOf, DEFAULT_TITLE, MAX_TITLE, MAX_PREVIEW };
