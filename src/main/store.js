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

  // An agent thread should hold what was asked and what came back. Older versions
  // also wrote the machinery around that — whose turn it is, where you are in the
  // queue, that the agent is busy — as ordinary messages, so upgrading stops new
  // ones but leaves every one already on disk in place. Those threads would stay
  // exactly as cluttered, and keep exporting that way.
  //
  // Only that machinery goes. Anything a running version keeps, this keeps too:
  // questions, answers, and the errors that explain a missing answer all stay,
  // whatever their age.
  //
  // Going forward that distinction is carried on the message itself, decided
  // where it is written. Here it cannot be: the records this looks at predate the
  // flag, which is the very thing being fixed, so text is all there is to go on.
  //
  // Kept narrow, in four independent ways, because deleting somebody's history
  // wrongly is far worse than leaving a line of clutter behind:
  //   * only agent threads are opened at all — `agent_…` and `remote-agent_…`,
  //     which `fileFor`'s sanitising makes recognisable, while a chat with a
  //     person is named by a bare id;
  //   * only inbound text messages are considered;
  //   * anything a peer asked is exempt outright — `askedBy` is set only on the
  //     question path, so a real question can never match however it is worded;
  //   * the patterns are anchored end to end. Their wording has not changed since
  //     the turn system was introduced (verified across every release that
  //     touched it), so they match what is actually out there.
  //
  // Idempotent, so it runs at every startup rather than behind a migration flag:
  // once the notices are gone nothing matches, and it also cleans up whatever a
  // peer still on an older build sends us in the meantime. The patterns can be
  // dropped in a later release, once no history predating the change survives.
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
      !m.askedBy &&
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

  // Every file a stored conversation refers to, sent or received.
  //
  // The preview endpoint serves only files LanChat itself put in a conversation,
  // and that list was rebuilt from live events alone — so it held whatever had
  // been sent or received since launch, and nothing else. Every image already in
  // a thread came back 404 on the next start and drew as a broken thumbnail.
  // Reading the paths back off disk is what makes a preview outlive the session
  // that created it, without widening what may be read: the same files, still
  // named explicitly, still nothing else on the machine.
  filePaths() {
    const out = [];
    let files;
    try {
      files = fs.readdirSync(this.dir);
    } catch {
      return out;
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      let list;
      try {
        list = JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf8'));
      } catch {
        continue;
      }
      if (!Array.isArray(list)) continue;
      for (const m of list) {
        if (m && m.kind === 'file' && m.file && typeof m.file.path === 'string' && m.file.path) {
          out.push(m.file.path);
        }
      }
    }
    return out;
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
