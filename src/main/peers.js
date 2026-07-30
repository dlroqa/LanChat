'use strict';

const WebSocket = require('ws');
const {
  createHandshake,
  applyPinVerdict,
  WIRE_REASON,
  WIRE_CLOSE_CODE,
  ID_IN_USE,
  TIMED_OUT,
} = require('./handshake');

// PeerHub is the single registry of live peer connections and known identities.
// Both inbound (server-accepted) and outbound (we dialed) sockets register here,
// so send() can use whichever socket is open. Discovery feeds it candidate peers.
//
// An id in here is one a peer proved, not one it announced: every socket that
// arrives off the network has completed the handshake in handshake.js before it
// is registered, and the key that did so is held against the id for as long as
// the connection lasts.

// How many times a single presence burst will re-emit to let the roster settle.
// Two is the normal ceiling — one pass for listeners to react, one to show the
// result — so anything approaching this means a listener is not converging.
const MAX_PRESENCE_PASSES = 10;

// Matches the server's. A dial that is accepted but never answered has to fail
// rather than hold the peer in `dialing` where nothing will retry it.
const AUTH_TIMEOUT_MS = 8000;

class PeerHub {
  constructor({ getIdentity, bus, deviceKey = null, pins = null }) {
    this.getIdentity = getIdentity;
    this.bus = bus;
    this.deviceKey = deviceKey;
    this.pins = pins;
    this.keys = new Map(); // peerId -> the public key currently holding it
    this.sockets = new Map(); // peerId -> Set<ws>
    this.identities = new Map(); // peerId -> identity card, as proved on the wire
    this.discoveryHints = new Map(); // peerId -> what we noticed locally
    this.addresses = new Map(); // peerId -> "ip:port" last known
    this.dialing = new Set(); // peerId currently being dialed
    this.emittingPresence = false; // a burst is in flight; nested emits fold in
    this.presenceDirty = false; // the roster changed while that burst ran
  }

  // `publicKey` is optional, and deliberately so: local and remote agents
  // register virtual sockets through here too (agents/index.js, agents/remote.js)
  // and have no wire identity to prove. Only sockets that came off the network
  // carry a key, and only those are held to one.
  register(peerId, ws, { publicKey = null } = {}) {
    if (!peerId) return;
    if (publicKey) this.keys.set(peerId, publicKey);
    if (!this.sockets.has(peerId)) this.sockets.set(peerId, new Set());
    this.sockets.get(peerId).add(ws);
    this.emitPresence();
  }

  // Whether a peer id is free for this key. Two live sockets for one id is
  // ordinary — both ends dial each other and both succeed, which the agent
  // sharing tests depend on. Two live sockets under *different* keys is one of
  // them being somebody else, and that is what this refuses. Getting this wrong
  // as "refuse a second socket" breaks the normal case; getting it wrong as "any
  // socket may claim any id" is the impersonation this whole change is about.
  keyAgrees(peerId, publicKey) {
    const known = this.keys.get(peerId);
    if (!known) return true;
    // A binding only means anything while a socket is actually holding it.
    //
    // Without this, a peer that reconnects before we noticed their old socket
    // drop is refused as an impostor — and that is exactly the reinstall case,
    // the one situation where a changed key is innocent and the user most needs
    // the alarm that shows them both fingerprints and offers a way to re-pin.
    // They would instead be told the peer could not be verified, with no route
    // forward at all.
    //
    // Nothing is relaxed by this. pins.json is the durable authority and still
    // refuses a changed key on its own; this map is only about who currently
    // holds the id on a live connection, and a closed socket holds nothing.
    if (!this.isConnected(peerId)) {
      this.keys.delete(peerId);
      return true;
    }
    return known === publicKey;
  }

  unregister(peerId, ws) {
    const set = this.sockets.get(peerId);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) {
      this.sockets.delete(peerId);
      // The binding lasts as long as the connection does. The durable one lives
      // in pins.json; this is only about who currently holds the id.
      this.keys.delete(peerId);
    }
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

    const dialled = peerId;
    let authed = false;
    const shake = createHandshake({
      role: 'client',
      deviceKey: this.deviceKey,
      getIdentity: this.getIdentity,
    });

    // Nothing is sent on open any more. The client cannot sign a nonce it has
    // not received, so it waits for the server's frame — which the server has
    // always sent first anyway. The cost is that a server which accepts the
    // upgrade and then says nothing would leave this dial hanging forever with
    // the peer stuck in `dialing`, so the clock below is load-bearing, not
    // decoration.
    let authTimer = setTimeout(() => giveUp(TIMED_OUT), AUTH_TIMEOUT_MS);
    const clearAuthTimer = () => {
      if (authTimer) clearTimeout(authTimer);
      authTimer = null;
    };

    const giveUp = (reason) => {
      clearAuthTimer();
      if (dialled) this.dialing.delete(dialled);
      if (peerId) this.dialing.delete(peerId);
      this.bus.emit('peer-auth-failed', { reason, peerId: dialled || peerId, address, direction: 'out' });
      try {
        ws.close(WIRE_CLOSE_CODE, WIRE_REASON);
      } catch {
        /* already closing */
      }
    };

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === 'hello' && !authed) {
        const answer = shake.answerServerHello(msg);
        if (!answer.ok) return giveUp(answer.reason);
        // We dialled an address expecting a particular peer. It answering as
        // somebody else used to be silently accepted as "reconcile" — which
        // meant whoever held the address decided who they were. If we had no
        // expectation the claim is fine; if we did, it has to match.
        if (dialled && answer.peer.id !== dialled) return giveUp(ID_IN_USE);
        ws.send(JSON.stringify(answer.frame));
        return;
      }

      if (msg.type === 'auth' && !authed) {
        const verified = shake.verifyServerProof(msg);
        if (!verified.ok) return giveUp(verified.reason);

        const verdict = applyPinVerdict({ pins: this.pins, hub: this, claim: verified.peer });
        if (!verdict.ok) {
          this.bus.emit('peer-key-alarm', {
            peerId: verified.peer.id,
            reason: verdict.reason,
            offered: verified.peer.key,
            known: (this.pins.get(verified.peer.id) || {}).key || null,
          });
          return giveUp(verdict.reason);
        }

        // Registration waits for the far end to have proved itself, so a socket
        // never appears online on the strength of a claim.
        clearAuthTimer();
        authed = true;
        peerId = verified.peer.id;
        this.register(peerId, ws, { publicKey: verified.peer.key });
        this.setIdentity(peerId, verified.peer.identity);
        this.dialing.delete(peerId);
        if (dialled) this.dialing.delete(dialled);
        this.bus.emit('peer-hello', {
          peerId,
          identity: verified.peer.identity,
          direction: 'out',
          firstUse: verdict.firstUse,
        });
        return;
      }

      if (msg.type === 'auth-fail') return giveUp(msg.reason || 'refused');

      // Attribution comes from the socket, never from the payload. `from` is
      // sender-supplied, so without this any peer could put someone else's id in
      // it and be stored and rendered as them. send() already stamps exactly
      // this value, so nothing legitimate changes.
      if (!authed || !peerId) return;
      this.bus.emit('peer-message', { ...msg, from: peerId });
    });
    ws.on('close', () => {
      clearAuthTimer();
      if (dialled) this.dialing.delete(dialled);
      if (peerId) {
        this.dialing.delete(peerId);
        this.unregister(peerId, ws);
      }
    });
    ws.on('error', () => {
      clearAuthTimer();
      if (dialled) this.dialing.delete(dialled);
      if (peerId) this.dialing.delete(peerId);
    });
  }

  // Close every socket (used on shutdown / in tests).
  //
  // Closed *and* terminated, in that order. `close()` on its own begins a
  // graceful handshake — a close frame out, the peer's reply back — and only
  // then does the socket actually go. Which means this method returns, the
  // roster is cleared here, and the far end still shows us online for as long as
  // that round trip takes. On a loaded machine that is seconds; against a peer
  // that has stopped responding it is never, and the socket sits there until TCP
  // gives up on it minutes later.
  //
  // Nothing that calls this wants to negotiate. It is shutdown and teardown —
  // "we are going away" — so the close frame is sent as a courtesy and the
  // socket is then destroyed, which the peer sees at once. Virtual sockets (the
  // local and remote agents) have no `terminate`, hence the check rather than a
  // bare call.
  close() {
    for (const set of this.sockets.values()) {
      for (const ws of set) {
        try {
          ws.close();
        } catch {}
        try {
          if (typeof ws.terminate === 'function') ws.terminate();
        } catch {}
      }
    }
    this.sockets.clear();
    this.keys.clear();
  }

  // Facts discovery worked out locally about a peer — that it is shared in from
  // another tailnet, which tailnet it belongs to. Kept apart from `identities`
  // because those two have very different provenance: an identity is something a
  // peer proved during the handshake, a hint is something we noticed. They are
  // merged for display, hints underneath, so a peer can never overwrite what we
  // observed and — the part that mattered — an unauthenticated probe response can
  // never put a name or an avatar on the roster.
  setDiscoveryHint(peerId, hint) {
    if (!peerId || !hint) return;
    this.discoveryHints.set(peerId, { ...this.discoveryHints.get(peerId), ...hint });
  }

  // Snapshot of everyone we know about, with live connection state.
  presenceList() {
    const out = [];
    const ids = new Set([
      ...this.identities.keys(),
      ...this.sockets.keys(),
      ...this.discoveryHints.keys(),
    ]);
    for (const id of ids) {
      if (id === this.getIdentity().id) continue;
      out.push({
        ...this.discoveryHints.get(id),
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
