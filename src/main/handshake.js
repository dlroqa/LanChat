'use strict';

const proto = require('./authProto');

// The three-frame handshake, as a small state machine used by both ends.
//
//   1. S→C  hello  { proto, from, identity, auth: { nonce, key, kx } }
//   2. C→S  hello  { proto, from, identity, auth: { nonce, key, kx, sig } }
//   3. S→C  auth   { proto, sig }
//
// One module rather than a copy in server.js and another in peers.js. The two
// directions differ only in who speaks first, and a verification rule that holds
// on one side and not the other is exactly the kind of asymmetry an attacker
// looks for — so there is one implementation and both sides call it.
//
// Everything here answers with a reason string rather than throwing. The caller
// is deciding whether to keep a socket, not handling an error, and the reasons
// are for *us*: the wire only ever hears 'refused'.

// Why a handshake failed. These never leave the machine — see refusalForWire.
const OLDER_LANCHAT = 'older-lanchat'; // no proof offered at all: probably an old build
const BAD_HELLO = 'bad-hello'; // malformed, or the card disagrees with the proof
const BAD_SIGNATURE = 'bad-signature'; // proof offered and it does not check out
const KEY_CHANGED = 'key-changed'; // known peer, different key
const ID_IN_USE = 'id-in-use'; // that id is already bound to another key
const TIMED_OUT = 'timed-out';

// One string, always, whatever actually happened. An attacker who omits the
// proof gets the same answer as one whose forgery failed, so the refusal cannot
// be used to probe what we know. The friendlier diagnostic is local only, which
// is what makes it safe to be friendly.
const WIRE_REASON = 'refused';
const WIRE_CLOSE_CODE = 4401;

function refusalForWire() {
  return { type: 'auth-fail', reason: WIRE_REASON };
}

// A peer that answers a v2 hello with something carrying no proof and no version
// looks like a build from before any of this existed. It is refused either way —
// the shape only decides which sentence the roster shows.
function looksLikeOldBuild(msg) {
  return Boolean(msg) && msg.auth === undefined && msg.proto === undefined;
}

function nonEmptyString(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= 256;
}

// The claim a peer makes, checked for self-consistency before any crypto runs.
// The card and the proof have to name the same identity and the same key: a card
// saying one thing while the signature covers another is how a valid proof gets
// lifted onto somebody else's name.
function parseHello(msg, { needSig }) {
  if (!msg || typeof msg !== 'object') return null;
  if (msg.proto !== proto.PROTO) return null;
  if (!nonEmptyString(msg.from)) return null;
  const auth = msg.auth;
  if (!auth || typeof auth !== 'object') return null;
  if (!proto.fromB64u(auth.nonce, proto.NONCE_BYTES)) return null;
  if (!proto.fromB64u(auth.key, proto.KEY_BYTES)) return null;
  if (!proto.fromB64u(auth.kx, proto.KEY_BYTES)) return null;
  if (needSig && !nonEmptyString(auth.sig)) return null;
  const identity = msg.identity;
  if (!identity || typeof identity !== 'object') return null;
  if (identity.id !== msg.from) return null;
  if (identity.publicKey !== auth.key) return null;
  return { id: msg.from, key: auth.key, kx: auth.kx, nonce: auth.nonce, sig: auth.sig, identity };
}

// `role` is 'server' (we accepted the socket) or 'client' (we dialled).
function createHandshake({ role, deviceKey, getIdentity }) {
  const isServer = role === 'server';
  const myNonce = proto.newNonce();
  const myKx = proto.generateAgreementKey();
  const myKey = deviceKey.publicKey();
  const myId = getIdentity().id;
  let peer = null;
  let done = false;

  function card() {
    return { ...getIdentity(), publicKey: myKey, proto: proto.PROTO };
  }

  // The frame this side opens with. The server sends it unprompted; the client
  // sends its own in reply, because it cannot sign a nonce it has not received.
  function helloFrame({ sig = null } = {}) {
    const auth = { nonce: myNonce, key: myKey, kx: myKx.publicKey };
    if (sig) auth.sig = sig;
    return { type: 'hello', proto: proto.PROTO, from: myId, identity: card(), auth };
  }

  // Server fields always first, whoever is signing. Only the role byte moves.
  function transcriptFor(roleByte) {
    if (!peer) throw new Error('no peer claim yet');
    const mine = { nonce: myNonce, key: myKey, kx: myKx.publicKey, id: myId };
    const theirs = { nonce: peer.nonce, key: peer.key, kx: peer.kx, id: peer.id };
    const S = isServer ? mine : theirs;
    const C = isServer ? theirs : mine;
    return proto.transcript({
      role: roleByte,
      proto: proto.PROTO,
      nonceS: S.nonce,
      nonceC: C.nonce,
      keyS: S.key,
      keyC: C.key,
      kxS: S.kx,
      kxC: C.kx,
      idS: S.id,
      idC: C.id,
    });
  }

  // --- server side -------------------------------------------------------

  // Frame 2 has arrived. Verify the client's proof against the nonce *we*
  // generated — never the one on their frame, which is how replay dies.
  function acceptClientHello(msg) {
    if (looksLikeOldBuild(msg)) return { ok: false, reason: OLDER_LANCHAT };
    const claim = parseHello(msg, { needSig: true });
    if (!claim) return { ok: false, reason: BAD_HELLO };
    peer = claim;
    if (!proto.verify(claim.key, transcriptFor(proto.ROLE_CLIENT), claim.sig)) {
      peer = null;
      return { ok: false, reason: BAD_SIGNATURE };
    }
    return { ok: true, peer: claim };
  }

  // Our half of the mutual proof, sent only after theirs checked out.
  function serverProof() {
    done = true;
    return {
      type: 'auth',
      proto: proto.PROTO,
      sig: proto.sign(deviceKey.privateKey(), transcriptFor(proto.ROLE_SERVER)),
    };
  }

  // --- client side -------------------------------------------------------

  // Frame 1 has arrived. Record what the server claims and answer with a proof.
  // Nothing is registered here — the server has proved nothing yet.
  function answerServerHello(msg) {
    if (looksLikeOldBuild(msg)) return { ok: false, reason: OLDER_LANCHAT };
    const claim = parseHello(msg, { needSig: false });
    if (!claim) return { ok: false, reason: BAD_HELLO };
    peer = claim;
    const sig = proto.sign(deviceKey.privateKey(), transcriptFor(proto.ROLE_CLIENT));
    return { ok: true, peer: claim, frame: helloFrame({ sig }) };
  }

  // Frame 3. Only now has the far end proved it holds the key its card names.
  function verifyServerProof(msg) {
    if (!peer) return { ok: false, reason: BAD_HELLO };
    if (!msg || msg.proto !== proto.PROTO || !nonEmptyString(msg.sig)) {
      return { ok: false, reason: BAD_HELLO };
    }
    if (!proto.verify(peer.key, transcriptFor(proto.ROLE_SERVER), msg.sig)) {
      return { ok: false, reason: BAD_SIGNATURE };
    }
    done = true;
    return { ok: true, peer };
  }

  // The shared secret, for step 8. Available only once both proofs are in, so a
  // session key can never exist for a peer that did not authenticate.
  function sessionKeys() {
    if (!done || !peer) return null;
    return proto.sessionKeys({
      privateKey: myKx.privateKey,
      peerPublicB64u: peer.kx,
      transcriptBuf: transcriptFor(proto.ROLE_SERVER),
    });
  }

  return {
    helloFrame,
    acceptClientHello,
    serverProof,
    answerServerHello,
    verifyServerProof,
    sessionKeys,
    get peer() {
      return peer;
    },
    get complete() {
      return done;
    },
  };
}

// What the pin store said, turned into a decision. Split out so both directions
// apply it identically — a peer we dialled gets exactly the scrutiny a peer that
// dialled us does.
function applyPinVerdict({ pins, hub, claim }) {
  const verdict = pins.check(claim.id, claim.key);
  if (verdict === 'changed') return { ok: false, reason: KEY_CHANGED };
  // A second socket for a peer already online is ordinary — both ends dial each
  // other and both succeed. A second socket presenting a *different* key is not.
  if (hub && typeof hub.keyAgrees === 'function' && !hub.keyAgrees(claim.id, claim.key)) {
    return { ok: false, reason: ID_IN_USE };
  }
  if (verdict === 'first-use') {
    pins.pin(claim.id, claim.key, { name: claim.identity && claim.identity.name, proto: proto.PROTO });
  } else {
    pins.touch(claim.id);
  }
  return { ok: true, firstUse: verdict === 'first-use' };
}

module.exports = {
  createHandshake,
  applyPinVerdict,
  refusalForWire,
  looksLikeOldBuild,
  parseHello,
  WIRE_REASON,
  WIRE_CLOSE_CODE,
  OLDER_LANCHAT,
  BAD_HELLO,
  BAD_SIGNATURE,
  KEY_CHANGED,
  ID_IN_USE,
  TIMED_OUT,
};
