'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const proto = require('../src/main/authProto.js');
const { createDeviceKey } = require('../src/main/deviceKey.js');
const { createPins, OK, FIRST_USE, CHANGED } = require('../src/main/pins.js');

// The handshake, without a socket in sight.
//
// A protocol flaw is silent: it does not throw, it accepts somebody it should
// have refused. So these are written as attacks rather than as features — each
// one is a thing that works if a specific line is wrong, and passes quietly if
// it is right.

function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lanchat-${name}-`));
}

// A full pair of handshake parties, as the wire would produce them.
function parties({ idS = 'server-uuid', idC = 'client-uuid' } = {}) {
  const S = proto.generateSigningKey();
  const C = proto.generateSigningKey();
  const kxS = proto.generateAgreementKey();
  const kxC = proto.generateAgreementKey();
  const base = {
    proto: proto.PROTO,
    nonceS: proto.newNonce(),
    nonceC: proto.newNonce(),
    keyS: S.publicKey,
    keyC: C.publicKey,
    kxS: kxS.publicKey,
    kxC: kxC.publicKey,
    idS,
    idC,
  };
  return { S, C, kxS, kxC, base };
}

// ------------------------------------------------------------------- keys

test('a signing key round-trips, and its public half is derivable from the seed', () => {
  const k = proto.generateSigningKey();
  assert.equal(Buffer.from(k.publicKey, 'base64url').length, 32);
  assert.equal(Buffer.from(k.privateKey, 'base64url').length, 32);
  // Only the seed is stored; everything else is derived. If this drifts, a
  // restored key file signs proofs nobody can verify.
  assert.equal(proto.signingPublicFrom(k.privateKey), k.publicKey);
});

test('malformed key material is refused rather than thrown at the caller', () => {
  // Every one of these arrives from the network. A throw here would take out the
  // connection handler; false is the only answer the caller has a use for.
  for (const bad of ['', '!!!!', 'a'.repeat(600), null, undefined, 'AAAA']) {
    assert.equal(proto.fromB64u(bad, 32), null, `${bad} should not decode`);
    assert.equal(proto.importSigningPublic(bad), null);
  }
});

// ------------------------------------------------------------- transcript

test('both sides build byte-identical transcripts apart from the role', () => {
  const { base } = parties();
  const tS = proto.transcript({ ...base, role: proto.ROLE_SERVER });
  const tC = proto.transcript({ ...base, role: proto.ROLE_CLIENT });
  assert.equal(tS.length, tC.length);
  assert.notDeepEqual(tS, tC, 'the role byte must actually differ');
  // Exactly one byte apart — if more differs, the two sides are signing
  // different things and the symmetry argument below stops holding.
  let differing = 0;
  for (let i = 0; i < tS.length; i += 1) if (tS[i] !== tC[i]) differing += 1;
  assert.equal(differing, 1);
});

test('REFLECTION: a signature made as one role never verifies as the other', () => {
  // The attack this stops: an attacker opens a socket to us and receives the
  // proof we send as the server. It then opens a second socket and presents that
  // same proof as its own client proof. Without the role byte both parties sign
  // the identical tuple and this works.
  const { S, C, base } = parties();
  const tS = proto.transcript({ ...base, role: proto.ROLE_SERVER });
  const tC = proto.transcript({ ...base, role: proto.ROLE_CLIENT });

  const sigS = proto.sign(S.privateKey, tS);
  const sigC = proto.sign(C.privateKey, tC);

  assert.ok(proto.verify(S.publicKey, tS, sigS), 'the server proof is good as a server proof');
  assert.ok(proto.verify(C.publicKey, tC, sigC), 'and the client proof as a client proof');
  assert.ok(!proto.verify(S.publicKey, tC, sigS), 'server proof reflected as a client proof');
  assert.ok(!proto.verify(C.publicKey, tS, sigC), 'client proof reflected as a server proof');
});

test('BINDING: a proof cannot be lifted onto a different identity', () => {
  // Both ids and both keys are inside the signature, so a valid proof for one
  // claim is worthless beside another. Otherwise an attacker could relay a real
  // peer's signature while claiming to be somebody else.
  const { C, base } = parties();
  const tC = proto.transcript({ ...base, role: proto.ROLE_CLIENT });
  const sigC = proto.sign(C.privateKey, tC);

  for (const field of ['idC', 'idS', 'keyS', 'nonceS', 'nonceC', 'proto']) {
    const altered = { ...base, role: proto.ROLE_CLIENT };
    if (field === 'proto') altered.proto = proto.PROTO + 1;
    else if (field.startsWith('id')) altered[field] = 'mallory';
    else altered[field] = field.startsWith('nonce') ? proto.newNonce() : proto.generateSigningKey().publicKey;
    assert.ok(
      !proto.verify(C.publicKey, proto.transcript(altered), sigC),
      `changing ${field} should invalidate the proof`
    );
  }
});

test('BINDING: a proof made with one key is not accepted under another', () => {
  const { C, base } = parties();
  const tC = proto.transcript({ ...base, role: proto.ROLE_CLIENT });
  const sigC = proto.sign(C.privateKey, tC);
  const mallory = proto.generateSigningKey();
  assert.ok(!proto.verify(mallory.publicKey, tC, sigC));
});

test('field boundaries cannot be shifted to forge a matching transcript', () => {
  // Without length prefixes, ('ab','c') and ('a','bc') serialise identically and
  // a proof for one identity pair is a proof for the other.
  const { base } = parties();
  const a = proto.transcript({ ...base, role: proto.ROLE_CLIENT, idS: 'ab', idC: 'c' });
  const b = proto.transcript({ ...base, role: proto.ROLE_CLIENT, idS: 'a', idC: 'bc' });
  assert.notDeepEqual(a, b);
});

test('the protocol version is signed, so it cannot be talked down', () => {
  // There is no wire field that lowers what we accept — but the version being
  // inside the transcript is what stops a relay claiming a peer only speaks the
  // old one and having that claim survive.
  const { C, base } = parties();
  const good = proto.transcript({ ...base, role: proto.ROLE_CLIENT });
  const sig = proto.sign(C.privateKey, good);
  const downgraded = proto.transcript({ ...base, role: proto.ROLE_CLIENT, proto: 1 });
  assert.ok(!proto.verify(C.publicKey, downgraded, sig));
});

test('a garbage signature is false, not an exception', () => {
  const { base, C } = parties();
  const t = proto.transcript({ ...base, role: proto.ROLE_CLIENT });
  for (const bad of ['', 'zzzz', Buffer.alloc(63).toString('base64'), null, undefined, {}]) {
    assert.equal(proto.verify(C.publicKey, t, bad), false);
  }
});

// ----------------------------------------------------------- session keys

test('both sides derive the same pair of directional keys', () => {
  const { kxS, kxC, base } = parties();
  const t = proto.transcript({ ...base, role: proto.ROLE_SERVER });
  const a = proto.sessionKeys({ privateKey: kxS.privateKey, peerPublicB64u: kxC.publicKey, transcriptBuf: t });
  const b = proto.sessionKeys({ privateKey: kxC.privateKey, peerPublicB64u: kxS.publicKey, transcriptBuf: t });
  assert.ok(a.s2c.equals(b.s2c) && a.c2s.equals(b.c2s), 'the two ends agree');
  assert.ok(!a.s2c.equals(a.c2s), 'and the two directions differ');
  assert.equal(a.s2c.length, 32);
});

test('session keys are bound to the transcript, not just to the shared secret', () => {
  // Salting with the transcript is what stops a relayed pair deriving the same
  // keys as the honest pair they sit between.
  const { kxS, kxC, base } = parties();
  const t1 = proto.transcript({ ...base, role: proto.ROLE_SERVER });
  const t2 = proto.transcript({ ...base, role: proto.ROLE_SERVER, idC: 'somebody-else' });
  const a = proto.sessionKeys({ privateKey: kxS.privateKey, peerPublicB64u: kxC.publicKey, transcriptBuf: t1 });
  const b = proto.sessionKeys({ privateKey: kxS.privateKey, peerPublicB64u: kxC.publicKey, transcriptBuf: t2 });
  assert.ok(!a.s2c.equals(b.s2c));
});

test('a malformed agreement key yields no session rather than a crash', () => {
  const { kxS, base } = parties();
  const t = proto.transcript({ ...base, role: proto.ROLE_SERVER });
  assert.equal(proto.sessionKeys({ privateKey: kxS.privateKey, peerPublicB64u: 'nope', transcriptBuf: t }), null);
});

// ----------------------------------------------------------- fingerprints

test('a fingerprint is short, stable and grouped for reading aloud', () => {
  const k = proto.generateSigningKey();
  const f = proto.fingerprint(k.publicKey);
  assert.match(f, /^[0-9A-F]{4}(-[0-9A-F]{4}){5}$/);
  assert.equal(f, proto.fingerprint(k.publicKey), 'stable');
  assert.notEqual(f, proto.fingerprint(proto.generateSigningKey().publicKey));
  assert.equal(proto.fingerprint('rubbish'), null);
});

// ------------------------------------------------------------- device key

test('a key is minted on first run and reopened unchanged afterwards', () => {
  const dir = tmp('key');
  const first = createDeviceKey({ userDataDir: dir });
  const pub = first.publicKey();
  assert.equal(first.mode(), 'plain', 'no keychain in the suite');

  const second = createDeviceKey({ userDataDir: dir });
  assert.equal(second.publicKey(), pub, 'the same identity across restarts');
  assert.equal(second.privateKey(), first.privateKey());
});

test('the key file is not readable by anyone else', { skip: process.platform === 'win32' }, () => {
  const dir = tmp('key-mode');
  const key = createDeviceKey({ userDataDir: dir });
  key.load();
  assert.equal(fs.statSync(key.file).mode & 0o777, 0o600);
});

test('a key file left world-readable is tightened on open', { skip: process.platform === 'win32' }, () => {
  const dir = tmp('key-loose');
  const key = createDeviceKey({ userDataDir: dir });
  key.load();
  fs.chmodSync(key.file, 0o644);
  createDeviceKey({ userDataDir: dir }).load();
  assert.equal(fs.statSync(key.file).mode & 0o777, 0o600);
});

test('sealing is used when the OS offers it, and the public half stays readable', () => {
  const dir = tmp('key-sealed');
  // The shape agentshare.test.js already stubs, inverted to available.
  const vault = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`sealed:${s}`),
    decryptString: (b) => b.toString().replace(/^sealed:/, ''),
  };
  const key = createDeviceKey({ userDataDir: dir, safeStorage: vault });
  const pub = key.publicKey();
  assert.equal(key.mode(), 'sealed');

  const onDisk = JSON.parse(fs.readFileSync(key.file, 'utf8'));
  assert.equal(onDisk.publicKey, pub, 'the public half is never sealed');
  assert.ok(!onDisk.privateKey.includes(key.privateKey()), 'the private half is not in the clear');

  assert.equal(createDeviceKey({ userDataDir: dir, safeStorage: vault }).publicKey(), pub);
});

test('a damaged key file is fatal — it is never quietly replaced', () => {
  // Regenerating here would present every peer we have ever met with the exact
  // signature of an attack, same id and a different key, all at once. Refusing
  // to network is the safe failure; the user can reset deliberately.
  const dir = tmp('key-broken');
  const key = createDeviceKey({ userDataDir: dir });
  key.load();
  fs.writeFileSync(key.file, '{ this is not json');
  assert.throws(() => createDeviceKey({ userDataDir: dir }).load(), /device key|Could not read/i);
});

test('a key file whose halves disagree is refused', () => {
  const dir = tmp('key-mismatch');
  const key = createDeviceKey({ userDataDir: dir });
  key.load();
  const data = JSON.parse(fs.readFileSync(key.file, 'utf8'));
  data.publicKey = proto.generateSigningKey().publicKey;
  fs.writeFileSync(key.file, JSON.stringify(data));
  assert.throws(() => createDeviceKey({ userDataDir: dir }).load(), /do not match/);
});

test('a sealed key cannot be opened without the keychain that sealed it', () => {
  const dir = tmp('key-nokeychain');
  const vault = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`sealed:${s}`),
    decryptString: (b) => b.toString().replace(/^sealed:/, ''),
  };
  createDeviceKey({ userDataDir: dir, safeStorage: vault }).load();
  assert.throws(() => createDeviceKey({ userDataDir: dir }).load(), /keychain/i);
});

test('an explicit reset mints a genuinely new identity', () => {
  const dir = tmp('key-reset');
  const key = createDeviceKey({ userDataDir: dir });
  const before = key.publicKey();
  key.reset();
  assert.notEqual(key.publicKey(), before);
  assert.equal(createDeviceKey({ userDataDir: dir }).publicKey(), key.publicKey(), 'and it persisted');
});

// ------------------------------------------------------------------ pins

test('an unknown peer is first-use; a known one with the same key is ok', () => {
  const pins = createPins({ userDataDir: tmp('pins') });
  const k = proto.generateSigningKey().publicKey;
  assert.equal(pins.check('alice', k), FIRST_USE);
  pins.pin('alice', k, { name: 'Alice' });
  assert.equal(pins.check('alice', k), OK);
  assert.equal(pins.get('alice').name, 'Alice');
  assert.equal(pins.get('alice').verified, false, 'first use is not verification');
});

test('a known peer presenting a different key is CHANGED, and never re-pinned', () => {
  const pins = createPins({ userDataDir: tmp('pins-change') });
  const good = proto.generateSigningKey().publicKey;
  const impostor = proto.generateSigningKey().publicKey;
  pins.pin('alice', good);
  assert.equal(pins.check('alice', impostor), CHANGED);
  // The latch: nothing short of a deliberate repin moves it.
  assert.throws(() => pins.pin('alice', impostor), /refusing to overwrite/);
  assert.equal(pins.get('alice').key, good);
});

test('re-pinning keeps the evidence and drops any human verification', () => {
  const pins = createPins({ userDataDir: tmp('pins-repin') });
  const good = proto.generateSigningKey().publicKey;
  const fresh = proto.generateSigningKey().publicKey;
  pins.pin('alice', good);
  pins.markVerified('alice', true);
  assert.equal(pins.get('alice').verified, true);

  pins.repin('alice', fresh);
  const rec = pins.get('alice');
  assert.equal(rec.key, fresh);
  assert.equal(rec.verified, false, 'a new key has not been checked by anybody');
  assert.equal(rec.prevKeys.length, 1);
  assert.equal(rec.prevKeys[0].key, good, 'the old key is kept as evidence');
});

test('pins survive a restart, and forgetting is explicit', () => {
  const dir = tmp('pins-persist');
  const k = proto.generateSigningKey().publicKey;
  createPins({ userDataDir: dir }).pin('alice', k);
  const reopened = createPins({ userDataDir: dir });
  assert.equal(reopened.check('alice', k), OK);
  assert.ok(reopened.forget('alice'));
  assert.equal(createPins({ userDataDir: dir }).check('alice', k), FIRST_USE);
});

test('an absent file is first run; a damaged one refuses to answer at all', () => {
  // The difference matters more than it looks. Resetting to empty on a parse
  // error — which is what config.js, devgate.js and registry.js all do — would
  // mean deleting or truncating one file makes every peer re-pin silently, and
  // the ratchet is gone.
  const dir = tmp('pins-broken');
  const pins = createPins({ userDataDir: dir });
  const k = proto.generateSigningKey().publicKey;
  assert.equal(pins.check('alice', k), FIRST_USE, 'absent is fine');
  pins.pin('alice', k);

  fs.writeFileSync(pins.file, '{ truncated');
  assert.throws(() => createPins({ userDataDir: dir }).check('alice', k), /damaged/);

  fs.writeFileSync(pins.file, JSON.stringify({ v: 1 }));
  assert.throws(() => createPins({ userDataDir: dir }).check('alice', k), /damaged/);
});

test('the pin file is not readable by anyone else', { skip: process.platform === 'win32' }, () => {
  const pins = createPins({ userDataDir: tmp('pins-mode') });
  pins.pin('alice', proto.generateSigningKey().publicKey);
  assert.equal(fs.statSync(pins.file).mode & 0o777, 0o600);
});

test('listing pins carries the fingerprint a person would compare', () => {
  const pins = createPins({ userDataDir: tmp('pins-list') });
  const k = proto.generateSigningKey().publicKey;
  pins.pin('alice', k, { name: 'Alice' });
  const [rec] = pins.list();
  assert.equal(rec.id, 'alice');
  assert.equal(rec.fingerprint, proto.fingerprint(k));
});
