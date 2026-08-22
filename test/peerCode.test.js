'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { encodePeerCode, decodePeerCode, PREFIX, MAX_CODE_BYTES } = require('../src/main/peerCode.js');

// How two people on different tenants introduce themselves.
//
// The code is public — an address, a port, a name, and a fingerprint Settings
// already asks people to read aloud — and it grants nothing: the handshake still
// has to succeed. What it buys is that first use can be *checked*, because the
// fingerprint arrived out of band with the address.
//
// So the only thing that matters here is that a doubtful code is refused
// outright rather than partly believed. This string was typed or pasted from a
// channel the app knows nothing about.

const ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const FP = 'A1B2-C3D4-E5F6-0718-2938-4A5B';
const ADDR = { addr: '10.55.0.2', port: 47100, net: 'shared', server: 'nm.partner.io' };

test('a code survives the round trip intact', () => {
  const code = encodePeerCode({ id: ID, fingerprint: FP, name: 'Ed', addrs: [ADDR] });
  assert.ok(code.startsWith(PREFIX), 'the version prefix is what lets a later shape be added');

  const back = decodePeerCode(code);
  assert.equal(back.id, ID);
  assert.equal(back.fp, FP);
  assert.equal(back.name, 'Ed');
  assert.deepEqual(back.addrs, [{ addr: '10.55.0.2', port: 47100, net: 'shared', server: 'nm.partner.io' }]);
});

test('a code carries every address, so one code works from any network', () => {
  const code = encodePeerCode({
    id: ID,
    fingerprint: FP,
    addrs: [ADDR, { addr: '10.101.0.5', port: 47100, net: 'office' }],
  });
  assert.equal(decodePeerCode(code).addrs.length, 2);
});

test('duplicate and unusable addresses are dropped rather than encoded', () => {
  const code = encodePeerCode({
    id: ID,
    fingerprint: FP,
    addrs: [ADDR, ADDR, { addr: 'not-an-address', port: 47100 }, { addr: '10.1.1.1', port: 0 }],
  });
  assert.equal(decodePeerCode(code).addrs.length, 1);
});

test('a code that could not be redeemed is never produced', () => {
  // Worse than no code, because it is pasted before it fails.
  assert.equal(encodePeerCode({ id: ID, fingerprint: FP, addrs: [] }), null, 'nowhere to be reached');
  assert.equal(encodePeerCode({ id: 'not-a-uuid', fingerprint: FP, addrs: [ADDR] }), null);
  assert.equal(encodePeerCode({ id: ID, fingerprint: 'nonsense', addrs: [ADDR] }), null);
  assert.equal(encodePeerCode({}), null);
});

test('a tampered code is refused, not partly believed', () => {
  const code = encodePeerCode({ id: ID, fingerprint: FP, addrs: [ADDR] });
  assert.equal(decodePeerCode(`${code.slice(0, -6)}AAAAAA`), null);
  assert.equal(decodePeerCode(code.slice(0, code.length - 20)), null);
  assert.equal(
    decodePeerCode(code.replace(PREFIX, 'lanchat9:')),
    null,
    'an unknown version is not guessed at'
  );
});

test('anything that is not a code at all is refused quietly', () => {
  for (const junk of ['', null, undefined, 'hello', 'lanchat1:', 'lanchat1:!!!!', {}, 42]) {
    assert.equal(decodePeerCode(junk), null);
  }
});

test('an oversized paste is refused before it is parsed', () => {
  assert.equal(decodePeerCode(PREFIX + 'A'.repeat(MAX_CODE_BYTES)), null);
});

test('a fingerprint of the wrong shape is refused', () => {
  // It has to be the exact shape authProto.fingerprint() produces, or comparing
  // it against a real one could never match and the check would be theatre.
  const body = (fp) =>
    PREFIX +
    Buffer.from(JSON.stringify({ v: 1, id: ID, fp, addrs: [{ addr: '10.1.1.1', port: 47100 }] })).toString(
      'base64url'
    );

  assert.equal(decodePeerCode(body('a1b2-c3d4-e5f6-0718-2938-4a5b')), null, 'lower case is not the shape');
  assert.equal(decodePeerCode(body('A1B2C3D4E5F60718293848A5')), null, 'nor is it without the groups');
  assert.equal(decodePeerCode(body('A1B2-C3D4')), null, 'nor a truncated one');
  assert.ok(decodePeerCode(body(FP)), 'and the real shape is accepted');
});

test('a code with no version, or the wrong one, is refused', () => {
  const raw = (obj) => PREFIX + Buffer.from(JSON.stringify(obj)).toString('base64url');
  assert.equal(decodePeerCode(raw({ id: ID, fp: FP, addrs: [ADDR] })), null, 'no version');
  assert.equal(
    decodePeerCode(raw({ v: 2, id: ID, fp: FP, addrs: [ADDR] })),
    null,
    'a version we do not know'
  );
  assert.equal(decodePeerCode(raw([1, 2, 3])), null, 'an array is not a code');
});

test('long free text in a code is trimmed rather than trusted', () => {
  // The name is displayed, so its length is ours to decide, not the sender's.
  const code = encodePeerCode({ id: ID, fingerprint: FP, name: 'x'.repeat(500), addrs: [ADDR] });
  assert.ok(code === null || decodePeerCode(code).name.length <= 64);
});
