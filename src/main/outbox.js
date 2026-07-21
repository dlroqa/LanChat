'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Messages typed while a peer was unreachable, held until they come back.
//
// LanChat is peer-to-peer with no server, so there is nowhere to park a message
// except this machine. That means delivery is "next time we are both online",
// not "eventually" — the sender has to still be running for the queue to drain.
// The UI says as much rather than implying store-and-forward it cannot do.
//
// Persisted to its own JSON file so a queue survives a restart. Chat history is
// written separately at send time (as a pending bubble); this file only tracks
// what still needs to go out, and the two are reconciled on delivery.

const MAX_PER_PEER = 200; // bounds a queue for a peer who never returns

class Outbox {
  constructor(userDataDir, { hub, bus, store }) {
    this.file = path.join(userDataDir, 'outbox.json');
    this.hub = hub;
    this.bus = bus;
    this.store = store;
    this.queues = new Map(); // peerId -> [{ id, text, ts }]
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [peerId, list] of Object.entries(raw.queues || {})) {
        if (Array.isArray(list) && list.length) this.queues.set(peerId, list);
      }
    } catch {
      // No queue yet, or unreadable — start empty.
    }
    return this.queues;
  }

  save() {
    const queues = {};
    for (const [peerId, list] of this.queues) if (list.length) queues[peerId] = list;
    try {
      fs.writeFileSync(this.file, JSON.stringify({ queues }, null, 2), 'utf8');
    } catch (err) {
      console.error('[outbox] save failed:', err.message);
    }
  }

  pendingCount(peerId) {
    return (this.queues.get(peerId) || []).length;
  }

  // Total per peer, for a roster badge.
  counts() {
    const out = {};
    for (const [peerId, list] of this.queues) if (list.length) out[peerId] = list.length;
    return out;
  }

  enqueue(peerId, message) {
    const list = this.queues.get(peerId) || [];
    list.push({ id: message.id, text: message.text, ts: message.ts });
    // Drop the oldest rather than growing without bound.
    if (list.length > MAX_PER_PEER) list.splice(0, list.length - MAX_PER_PEER);
    this.queues.set(peerId, list);
    this.save();
    this.emitCounts();
    return message;
  }

  // Attempts delivery of everything queued for one peer, oldest first. Stops at
  // the first failure so ordering is preserved — a half-delivered queue that
  // reordered messages would be worse than one that waits.
  flush(peerId) {
    const list = this.queues.get(peerId);
    if (!list || list.length === 0) return 0;
    if (!this.hub.isConnected(peerId)) return 0;

    let sent = 0;
    while (list.length > 0) {
      const item = list[0];
      const ok = this.hub.send(peerId, { type: 'chat', id: item.id, text: item.text, ts: item.ts });
      if (!ok) break;
      list.shift();
      sent += 1;
      // The bubble was stored as pending when it was typed; it is real now.
      const updated = this.store.update(peerId, item.id, { pending: false, delivered: true });
      this.bus.emit('outbox-sent', updated || { id: item.id, peerId, pending: false });
    }

    if (list.length === 0) this.queues.delete(peerId);
    if (sent > 0) {
      this.save();
      this.emitCounts();
    }
    return sent;
  }

  flushAll() {
    let sent = 0;
    for (const peerId of [...this.queues.keys()]) sent += this.flush(peerId);
    return sent;
  }

  emitCounts() {
    this.bus.emit('outbox-counts', this.counts());
  }

  // Flush whenever someone becomes reachable. Presence fires on every socket
  // register/unregister, which is exactly when a queue might become drainable.
  start() {
    this.onPresence = () => this.flushAll();
    this.bus.on('presence', this.onPresence);
    this.emitCounts();
  }

  stop() {
    if (this.onPresence) this.bus.off('presence', this.onPresence);
    this.onPresence = null;
  }
}

module.exports = { Outbox, MAX_PER_PEER };
