'use strict';

const crypto = require('node:crypto');

// The peer handshake, as pure functions.
//
// Nothing here touches a socket, the filesystem or Electron — it is bytes in,
// bytes out — because this is the part where a mistake is silent. A protocol
// flaw does not throw; it accepts somebody it should have refused. So it lives
// on its own where the adversarial tests can reach it directly.
//
// The shape, using the fact that the server already speaks first:
//
//   1. S→C  hello  { proto, from, identity, auth: { nonce, key, kx } }
//   2. C→S  hello  { proto, from, identity, auth: { nonce, key, kx, sig } }
//   3. S→C  auth   { proto, sig }
//
// Each side signs a transcript covering both nonces, both signing keys, both
// key-agreement keys and both ids. Three properties come out of that, and each
// one is a specific attack that would otherwise work:
//
//   Reflection — the transcript is identical for both parties except for a role
//     byte. Without it both sides sign the same tuple, and an attacker who opens
//     a socket to us can take the signature we send and present it back as its
//     own proof. With it, our signature is over role 'S' and is checked as 'C'.
//
//   Replay — nonces are fresh per connection and a verifier substitutes the
//     nonce *it* generated, never the one on the peer's frame. An old signature
//     can therefore only match a nonce that no longer exists anywhere, which is
//     why there is no replay cache to keep or to get wrong.
//
//   Transcript binding — both ids and both keys are inside the signature, and
//     variable-length fields are length-prefixed so that ('ab','c') and
//     ('a','bc') cannot produce the same bytes. A signature cannot be lifted off
//     one identity claim and presented alongside another.

// The protocol we speak and the only one we accept. There is deliberately no
// wire field that can lower this, and it is inside the signed transcript, so a
// peer claiming "I only speak the old one" is refused rather than obeyed. That
// is the whole downgrade story: not detection, absence of a lenient mode.
const PROTO = 2;

const DOMAIN = 'lanchat-auth-v2';
const ROLE_SERVER = 0x53; // 'S'
const ROLE_CLIENT = 0x43; // 'C'
const KEY_BYTES = 32;
const NONCE_BYTES = 32;
const SIG_BYTES = 64;

// ---------------------------------------------------------------- encoding

function b64u(buf) {
  return Buffer.from(buf).toString('base64url');
}

// Decoding is where hostile input arrives, so length is checked here rather than
// left to a later primitive to complain about. Returns null instead of throwing:
// every caller is deciding whether to refuse a connection, not handling an error.
function fromB64u(s, expectBytes) {
  if (typeof s !== 'string' || s.length === 0 || s.length > 512) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  let buf;
  try {
    buf = Buffer.from(s, 'base64url');
  } catch {
    return null;
  }
  if (expectBytes && buf.length !== expectBytes) return null;
  return buf;
}

// Length-prefixed, so no two distinct field tuples can serialise the same way.
function lp(value) {
  const body = Buffer.from(String(value), 'utf8');
  if (body.length > 0xffff) throw new Error('field too long for the transcript');
  const head = Buffer.alloc(2);
  head.writeUInt16BE(body.length, 0);
  return Buffer.concat([head, body]);
}

// ------------------------------------------------------------------- keys

// Ed25519 for identity. Raw 32-byte keys go over the wire as the JWK `x` field,
// which is exactly the raw key in base64url — no DER, no PEM, nothing to parse
// by hand.
function generateSigningKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  return { publicKey: publicKey.export({ format: 'jwk' }).x, privateKey: jwk.d };
}

function signingPublicFrom(privateB64u) {
  return importSigningPrivate(privateB64u).publicKey;
}

function importSigningPrivate(privateB64u) {
  const d = fromB64u(privateB64u, KEY_BYTES);
  if (!d) throw new Error('malformed private key');
  // A JWK Ed25519 private key must carry its public half; derive it once so the
  // caller only ever has to store the seed.
  const seed = Buffer.from(d);
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const key = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const publicKey = crypto.createPublicKey(key).export({ format: 'jwk' }).x;
  return { key, publicKey };
}

function importSigningPublic(publicB64u) {
  if (!fromB64u(publicB64u, KEY_BYTES)) return null;
  try {
    return crypto.createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: publicB64u },
      format: 'jwk',
    });
  } catch {
    return null;
  }
}

// X25519 for the session key. Ephemeral: generated per connection, never stored,
// so a recovered device key cannot decrypt a conversation captured earlier.
function generateAgreementKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return { publicKey: publicKey.export({ format: 'jwk' }).x, privateKey };
}

function importAgreementPublic(publicB64u) {
  if (!fromB64u(publicB64u, KEY_BYTES)) return null;
  try {
    return crypto.createPublicKey({
      key: { kty: 'OKP', crv: 'X25519', x: publicB64u },
      format: 'jwk',
    });
  } catch {
    return null;
  }
}

function newNonce() {
  return b64u(crypto.randomBytes(NONCE_BYTES));
}

// --------------------------------------------------------------- transcript

// Server fields always precede client fields whatever the signer — only the role
// byte differs between the two signatures. Getting this wrong in the direction
// of "each side puts itself first" is what makes reflection work.
function transcript({ role, proto, nonceS, nonceC, keyS, keyC, kxS, kxC, idS, idC }) {
  const raw = (s) => {
    const b = fromB64u(s, KEY_BYTES) || fromB64u(s, NONCE_BYTES);
    if (!b) throw new Error('malformed transcript field');
    return b;
  };
  if (role !== ROLE_SERVER && role !== ROLE_CLIENT) throw new Error('bad role');
  return Buffer.concat([
    Buffer.from(DOMAIN, 'utf8'),
    Buffer.from([0x00, role]),
    lp(proto),
    raw(nonceS),
    raw(nonceC),
    raw(keyS),
    raw(keyC),
    raw(kxS),
    raw(kxC),
    lp(idS),
    lp(idC),
  ]);
}

function sign(privateB64u, transcriptBuf) {
  const { key } = importSigningPrivate(privateB64u);
  return crypto.sign(null, transcriptBuf, key).toString('base64');
}

// False rather than a throw on every failure path — malformed key, malformed
// signature, wrong signature are all the same answer to the only question the
// caller is asking.
function verify(publicB64u, transcriptBuf, sigB64) {
  const key = importSigningPublic(publicB64u);
  if (!key) return false;
  let sig;
  try {
    sig = Buffer.from(String(sigB64), 'base64');
  } catch {
    return false;
  }
  if (sig.length !== SIG_BYTES) return false;
  try {
    return crypto.verify(null, transcriptBuf, key, sig);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------- session keys

// One shared secret, split into two directional keys so the same counter value
// never encrypts two different frames under the same key. `info` names the
// direction; HKDF does the rest.
function sessionKeys({ privateKey, peerPublicB64u, transcriptBuf }) {
  const peer = importAgreementPublic(peerPublicB64u);
  if (!peer) return null;
  let shared;
  try {
    shared = crypto.diffieHellman({ privateKey, publicKey: peer });
  } catch {
    return null;
  }
  // Salting with the transcript binds the session keys to the identities that
  // were proved — a shared secret alone would be the same for a relayed pair.
  const salt = crypto.createHash('sha256').update(transcriptBuf).digest();
  const derive = (label) =>
    Buffer.from(crypto.hkdfSync('sha256', shared, salt, Buffer.from(label, 'utf8'), 32));
  return { s2c: derive(`${DOMAIN}:s2c`), c2s: derive(`${DOMAIN}:c2s`) };
}

// ------------------------------------------------------------- fingerprints

// What a person compares out loud. The full key is unreadable and nobody checks
// 43 characters of base64; the first bytes of its hash, grouped, is what SSH and
// Signal settled on for the same reason.
function fingerprint(publicB64u) {
  const raw = fromB64u(publicB64u, KEY_BYTES);
  if (!raw) return null;
  const digest = crypto.createHash('sha256').update(raw).digest('hex').toUpperCase();
  return digest.slice(0, 24).match(/.{4}/g).join('-');
}

module.exports = {
  PROTO,
  DOMAIN,
  ROLE_SERVER,
  ROLE_CLIENT,
  KEY_BYTES,
  NONCE_BYTES,
  SIG_BYTES,
  b64u,
  fromB64u,
  generateSigningKey,
  signingPublicFrom,
  importSigningPrivate,
  importSigningPublic,
  generateAgreementKey,
  importAgreementPublic,
  newNonce,
  transcript,
  sign,
  verify,
  sessionKeys,
  fingerprint,
};
