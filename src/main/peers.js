'use strict';

const WebSocket = require('ws');

// PeerHub is the single registry of live peer connections and known identities.
// Both inbound (server-accepted) and outbound (we dialed) sockets register here,
// so send() can use whichever socket is open. Discovery feeds it candidate peers.

class PeerHub {
  constructor({ getIdentity, bus }) {
    this.getIdentity = getIdentity;
    this.bus = bus;
    this.sockets = new Map(); // peerId -> Set<ws>
    this.identities = new Map(); // peerId -> identity card
    this.addresses = new Map(); // peerId -> "ip:port" last known
    this.dialing = new Set(); // peerId currently being dialed
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
      this.bus.emit('peer-message', msg);
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

  emitPresence() {
    this.bus.emit('presence', this.presenceList());
  }
}

module.exports = { PeerHub };
