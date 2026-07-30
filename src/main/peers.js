'use strict';

const WebSocket = require('ws');

// PeerHub is the single registry of live peer connections and known identities.
// Both inbound (server-accepted) and outbound (we dialed) sockets register here,
// so send() can use whichever socket is open. Discovery feeds it candidate peers.

// How many times a single presence burst will re-emit to let the roster settle.
// Two is the normal ceiling — one pass for listeners to react, one to show the
// result — so anything approaching this means a listener is not converging.
const MAX_PRESENCE_PASSES = 10;

class PeerHub {
  constructor({ getIdentity, bus }) {
    this.getIdentity = getIdentity;
    this.bus = bus;
    this.sockets = new Map(); // peerId -> Set<ws>
    this.identities = new Map(); // peerId -> identity card
    this.addresses = new Map(); // peerId -> "ip:port" last known
    this.dialing = new Set(); // peerId currently being dialed
    this.emittingPresence = false; // a burst is in flight; nested emits fold in
    this.presenceDirty = false; // the roster changed while that burst ran
  }

  register(peerId, ws) {
    if (!peerId) return;
    if (!this.sockets.has(peerId)) this.sockets.set(peerId, new Set());
    this.sockets.get(peerId).add(ws);
    this.emitPresence();
  }

  unregister(peerId, ws) {
    const set = this.sockets.get(peerId);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) this.sockets.delete(peerId);
    this.emitPresence();
  }

  setIdentity(peerId, identity) {
    if (!peerId || !identity) return;
    this.identities.set(peerId, { ...this.identities.get(peerId), ...identity });
    this.emitPresence();
  }

  setAddress(peerId, address) {
    if (peerId && address) this.addresses.set(peerId, address);
  }

  isConnected(peerId) {
    const set = this.sockets.get(peerId);
    if (!set) return false;
    for (const ws of set) if (ws.readyState === WebSocket.OPEN) return true;
    return false;
  }

  openSocket(peerId) {
    const set = this.sockets.get(peerId);
    if (!set) return null;
    for (const ws of set) if (ws.readyState === WebSocket.OPEN) return ws;
    return null;
  }

  send(peerId, obj) {
    const ws = this.openSocket(peerId);
    if (!ws) return false;
    try {
      ws.send(JSON.stringify({ from: this.getIdentity().id, ...obj }));
      return true;
    } catch {
      return false;
    }
  }

  // Fan out to every connected peer. Offline peers are skipped rather than
  // queued: this carries state announcements, which are re-sent on reconnect,
  // so a stale one is worse than a missed one. Returns the peer ids reached.
  broadcast(obj, { except = [] } = {}) {
    const skip = new Set(except);
    const reached = [];
    for (const peer of this.presenceList()) {
      if (!peer.online || skip.has(peer.id)) continue;
      if (this.send(peer.id, obj)) reached.push(peer.id);
    }
    return reached;
  }

  // Dial a discovered peer at ip:port and keep the socket registered.
  connect(peerId, address) {
    if (!address) return;
    this.setAddress(peerId, address);
    if (peerId && (this.isConnected(peerId) || this.dialing.has(peerId))) return;
    if (peerId) this.dialing.add(peerId);

    const url = `ws://${address}/lanchat/ws`;
    let ws;
    try {
      ws = new WebSocket(url, { handshakeTimeout: 4000 });
    } catch {
      if (peerId) this.dialing.delete(peerId);
      return;
    }

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', from: this.getIdentity().id, identity: this.getIdentity() }));
    });
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'hello') {
        const id = msg.from;
        if (peerId && id && id !== peerId) {
          // Reconcile: we dialed an address, learned its real id.
          this.dialing.delete(peerId);
          peerId = id;
        }
        peerId = peerId || id;
        this.register(peerId, ws);
        if (msg.identity) this.setIdentity(peerId, msg.identity);
        this.dialing.delete(peerId);
        this.bus.emit('peer-hello', { peerId, identity: msg.identity, direction: 'out' });
        return;
      }
      // Attribution comes from the socket, never from the payload. `from` is
      // sender-supplied, so without this any peer could put someone else's id in
      // it and be stored and rendered as them. send() already stamps exactly
      // this value, so nothing legitimate changes.
      if (!peerId) return;
      this.bus.emit('peer-message', { ...msg, from: peerId });
    });
    ws.on('close', () => {
      if (peerId) {
        this.dialing.delete(peerId);
        this.unregister(peerId, ws);
      }
    });
    ws.on('error', () => {
      if (peerId) this.dialing.delete(peerId);
    });
  }

  // Close every socket (used on shutdown / in tests).
  close() {
    for (const set of this.sockets.values()) {
      for (const ws of set) {
        try {
          ws.close();
        } catch {}
      }
    }
    this.sockets.clear();
  }

  // Snapshot of everyone we know about, with live connection state.
  presenceList() {
    const out = [];
    const ids = new Set([...this.identities.keys(), ...this.sockets.keys()]);
    for (const id of ids) {
      if (id === this.getIdentity().id) continue;
      out.push({
        ...(this.identities.get(id) || { id }),
        id,
        address: this.addresses.get(id) || null,
        online: this.isConnected(id),
      });
    }
    return out;
  }

  // Every roster change funnels through here, which makes this the one place
  // that can make re-entrancy safe for all of them.
  //
  // Presence listeners are allowed to change the roster — answering "an owner
  // went offline" by dropping their agents is exactly that — and those changes
  // emit presence in turn. Recursing into a fresh emit for each one is what once
  // ran the main process out of stack, so a nested emit is folded into the burst
  // already in flight: it marks the roster dirty and returns, and the call still
  // running loops round to emit again. The list is rebuilt every pass, so a
  // listener that changed the roster is never answered with the list from before
  // it did, and the last emit of a burst always carries the settled roster.
  //
  // A caller that is not already inside a burst still emits once, synchronously,
  // exactly as before — nothing about the ordinary path changes.
  emitPresence() {
    if (this.emittingPresence) {
      this.presenceDirty = true;
      return;
    }
    this.emittingPresence = true;
    try {
      let passes = 0;
      do {
        this.presenceDirty = false;
        this.bus.emit('presence', this.presenceList());
      } while (this.presenceDirty && ++passes < MAX_PRESENCE_PASSES);
      if (this.presenceDirty) {
        // A listener is changing the roster on every pass, so it is never going
        // to settle. Ending the burst leaves the roster where it stands, which
        // is a stale contact at worst; spinning here would wedge the main
        // process, which is the failure this whole guard exists to prevent.
        console.warn(
          `[peers] presence did not settle in ${MAX_PRESENCE_PASSES} passes; a listener keeps changing the roster`
        );
      }
    } finally {
      // Cleared even when a listener throws. A flag left standing would swallow
      // every later presence emit for the rest of the session — the roster would
      // freeze silently, which is far worse than the throw on its way out.
      this.emittingPresence = false;
      this.presenceDirty = false;
    }
  }
}

module.exports = { PeerHub };
