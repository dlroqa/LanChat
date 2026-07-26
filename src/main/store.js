'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Lightweight append-only chat history persisted as JSON per peer id.
// Dependency-free by design; message volume for a personal LAN tool is small.

class MessageStore {
  constructor(userDataDir) {
    this.dir = path.join(userDataDir, 'history');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  fileFor(peerId) {
    const safe = String(peerId).replace(/[^\w.\-]+/g, '_');
    return path.join(this.dir, `${safe}.json`);
  }

  read(peerId) {
    try {
      return JSON.parse(fs.readFileSync(this.fileFor(peerId), 'utf8'));
    } catch {
      return [];
    }
  }

  append(peerId, message) {
    const list = this.read(peerId);
    list.push(message);
    // Keep the last 2000 messages per peer to bound file size.
    const trimmed = list.slice(-2000);
    try {
      fs.writeFileSync(this.fileFor(peerId), JSON.stringify(trimmed), 'utf8');
    } catch (err) {
      console.error('[store] append failed:', err.message);
    }
    return message;
  }

  // Patches a stored message in place. Used when a queued message is finally
  // delivered: the bubble that was written as pending has to stop being pending,
  // and it must survive a restart that way.
  update(peerId, messageId, patch) {
    const list = this.read(peerId);
    const idx = list.findIndex((m) => m.id === messageId);
    if (idx < 0) return null;
    list[idx] = { ...list[idx], ...patch };
    try {
      fs.writeFileSync(this.fileFor(peerId), JSON.stringify(list), 'utf8');
    } catch (err) {
      console.error('[store] update failed:', err.message);
      return null;
    }
    return list[idx];
  }

  // Removes turn-queue notices written by an older version, which stored them as
  // ordinary messages. Without this, upgrading stops new ones but leaves every
  // one already on disk in place — so the threads that prompted the change stay
  // exactly as cluttered, and still export that way.
  //
  // Matching on text is the only option available: those messages carry no flag
  // to find them by, which is the very thing being fixed. It is narrow on
  // purpose — the patterns are anchored, only inbound messages are considered,
  // and only agent threads are opened (`agent_…` and `remote-agent_…`, since
  // `fileFor` turns `:` and `#` into underscores, while a chat with a person is
  // named by a bare id). A message a human typed is never a candidate.
  //
  // Idempotent, so it can run at every startup: once the notices are gone
  // nothing matches, and a peer still running an older build gets their notices
  // cleaned up on the next launch too. The patterns can be dropped in a later
  // release, once no history predating the change is still in circulation.
  pruneLegacyNotices() {
    const PATTERNS = [
      /^Your turn — you have \d+ queries\.$/,
      /^You have been idle — your turn passes to the next person in about \d+s \(\d+ waiting\)\. Ask something to keep it\.$/,
      /^That is \d+ queries — passing to the next person waiting\. You are #\d+ in line; ask again when your turn comes round\.$/,
      /^.{1,64} is busy with someone else\. You are #\d+ in line — ask again when it is your turn\.$/,
      /^I am still working on the previous message — one at a time, please\.$/,
    ];
    const isNotice = (m) =>
      m &&
      m.direction === 'in' &&
      (m.kind === 'text' || !m.kind) &&
      typeof m.text === 'string' &&
      PATTERNS.some((p) => p.test(m.text));

    let removed = 0;
    let files;
    try {
      files = fs.readdirSync(this.dir);
    } catch {
      return 0;
    }
    for (const file of files) {
      if (!/^(remote-)?agent_.*\.json$/.test(file)) continue;
      const full = path.join(this.dir, file);
      let list;
      try {
        list = JSON.parse(fs.readFileSync(full, 'utf8'));
      } catch {
        continue;
      }
      if (!Array.isArray(list)) continue;
      const kept = list.filter((m) => !isNotice(m));
      if (kept.length === list.length) continue;
      try {
        fs.writeFileSync(full, JSON.stringify(kept), 'utf8');
        removed += list.length - kept.length;
      } catch (err) {
        console.error('[store] pruning notices failed:', err.message);
      }
    }
    if (removed) console.log(`[store] removed ${removed} stored turn notice(s) from agent threads`);
    return removed;
  }

  // Deletes a conversation outright. Used by "clear chat history", which is
  // meant to be exactly as final as it sounds — the file goes, rather than the
  // messages being hidden while staying on disk.
  clear(peerId) {
    try {
      fs.rmSync(this.fileFor(peerId), { force: true });
      return true;
    } catch (err) {
      console.error('[store] clear failed:', err.message);
      return false;
    }
  }
}

module.exports = { MessageStore };
