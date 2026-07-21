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
}

module.exports = { MessageStore };
