'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { fingerprint } = require('./authProto');

// Which key belongs to which peer, remembered.
//
// A hard protocol floor — refuse anyone who cannot prove a key — settles the
// downgrade question completely: there is no lenient mode to negotiate down to,
// so an attacker who omits the proof and an un-updated peer that cannot produce
// one get the same answer. What a floor cannot do anything about is *first*
// contact, where every key is equally unknown. That is what this file is for,
// and it is the same job SSH's known_hosts does.
//
// The rules that make it a ratchet rather than a cache:
//
//   A record is a one-way latch. Once an id has authenticated, no valid proof
//   for that exact key means no connection — never "unknown, allow through".
//   Only an explicit local action removes one.
//
//   A key change is a refusal, not a prompt at connection time. Re-pinning is a
//   separate deliberate act, the way SSH makes you run `ssh-keygen -R`. Nothing
//   here auto-accepts, and nothing accepts on a timeout.
//
//   A file that exists but will not parse is fatal. config.js, devgate.js and
//   registry.js all reset to defaults on an unreadable file, which is right for
//   preferences and wrong here: it would turn "truncate one file" into "every
//   peer silently re-pins", which is the whole mechanism bypassed. Absent (first
//   run) and corrupt are different answers.

const FILE = 'peers.json';

const OK = 'ok'; // known peer, key matches
const FIRST_USE = 'first-use'; // never seen; trust and remember
const CHANGED = 'changed'; // known peer, different key — refuse

function createPins({ userDataDir }) {
  const file = path.join(userDataDir, FILE);
  let peers = null;

  function writeAtomic() {
    fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, peers }, null, 2), { mode: 0o600 });
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {
      /* win32 has no POSIX mode */
    }
    fs.renameSync(tmp, file);
  }

  function load() {
    if (peers) return peers;
    let raw = null;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw new Error(`Could not read known peers at ${file}: ${err.message}`);
      }
    }
    if (raw === null) {
      peers = {};
      return peers;
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      // Fail closed. See the note above about why this is not a reset.
      throw new Error(`The known-peers file at ${file} is damaged (${err.message}).`);
    }
    if (!data || typeof data !== 'object' || typeof data.peers !== 'object' || data.peers === null) {
      throw new Error(`The known-peers file at ${file} is damaged.`);
    }
    peers = data.peers;
    return peers;
  }

  // The verdict, and nothing else — deciding what to do about it belongs to the
  // caller, which is the only place that knows whether this is an inbound socket
  // or a dial we chose to make.
  function check(peerId, publicKey) {
    const all = load();
    const known = all[peerId];
    if (!known) return FIRST_USE;
    return known.key === publicKey ? OK : CHANGED;
  }

  function get(peerId) {
    return load()[peerId] || null;
  }

  function pin(peerId, publicKey, meta = {}) {
    if (!peerId || !publicKey) return null;
    const all = load();
    const now = Date.now();
    const prior = all[peerId];
    if (prior && prior.key !== publicKey) {
      // Only ever reached through repin(); check() refuses this path.
      throw new Error('refusing to overwrite a pinned key — use repin()');
    }
    all[peerId] = {
      ...prior,
      key: publicKey,
      firstSeen: prior ? prior.firstSeen : now,
      lastSeen: now,
      name: meta.name || (prior && prior.name) || null,
      verified: prior ? Boolean(prior.verified) : false,
      // Once a peer has been seen at a protocol level, a future version can
      // refuse a fallback from that specific peer — HSTS's max-age, per peer.
      lastProto: meta.proto || (prior && prior.lastProto) || null,
      prevKeys: (prior && prior.prevKeys) || [],
    };
    writeAtomic();
    return all[peerId];
  }

  function touch(peerId) {
    const all = load();
    if (!all[peerId]) return;
    all[peerId].lastSeen = Date.now();
    writeAtomic();
  }

  // Accepting a new key for an id we already know. Deliberate, local, and never
  // reachable from the wire.
  //
  // The old key is kept rather than dropped: it is the evidence, and the record
  // of having been through this is worth more than the bytes. The caller is
  // responsible for revoking derived trust — see `onRepin` in main.js, which
  // strips the peer from every agent allowlist. Without that, one click through
  // a warning hands an impostor every grant the real peer had, and "warn loudly"
  // becomes the only thing standing between an attacker and the agents.
  function repin(peerId, publicKey) {
    const all = load();
    const prior = all[peerId];
    if (!prior) return pin(peerId, publicKey);
    all[peerId] = {
      ...prior,
      key: publicKey,
      lastSeen: Date.now(),
      // A fresh key has not been checked by a human, whatever the old one was.
      verified: false,
      prevKeys: [...(prior.prevKeys || []), { key: prior.key, retiredAt: Date.now() }],
    };
    writeAtomic();
    return all[peerId];
  }

  // Someone has compared fingerprints out loud. This is the only thing that
  // makes first-use trust falsifiable, which is why the UI has to offer it.
  function markVerified(peerId, verified = true) {
    const all = load();
    if (!all[peerId]) return null;
    all[peerId].verified = Boolean(verified);
    writeAtomic();
    return all[peerId];
  }

  function forget(peerId) {
    const all = load();
    if (!all[peerId]) return false;
    delete all[peerId];
    writeAtomic();
    return true;
  }

  function list() {
    const all = load();
    return Object.entries(all).map(([id, rec]) => ({
      id,
      ...rec,
      fingerprint: fingerprint(rec.key),
    }));
  }

  return { check, get, pin, repin, touch, markVerified, forget, list, file, OK, FIRST_USE, CHANGED };
}

module.exports = { createPins, OK, FIRST_USE, CHANGED, PINS_FILE: FILE };
