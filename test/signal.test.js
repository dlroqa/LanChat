'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Signaling payloads cross Electron's IPC boundary, which uses the structured
// clone algorithm. Platform objects (RTCIceCandidate, RTCSessionDescription) are
// NOT cloneable — passing one rejects the invoke, and because the send was never
// awaited the failure was silent: ICE candidates never reached the peer, so
// calls connected but carried no audio or video.
//
// These tests reproduce that by cloning what we put on the wire.

// The module is ESM for the renderer; evaluate it here without pulling in a
// bundler by dropping the `export` keywords and returning the bindings.
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'lib', 'signal.js'), 'utf8');
const { serializeCandidate, serializeDescription, isCloneable } = new Function(
  `${SRC.replace(/^export\s+/gm, '')}
   return { serializeCandidate, serializeDescription, isCloneable };`
)();

// Stand-in for Chromium's RTCIceCandidate: a class instance with a toJSON(),
// which structuredClone refuses because of the prototype methods.
class FakeRTCIceCandidate {
  constructor(init) {
    Object.assign(this, init);
  }
  toJSON() {
    return {
      candidate: this.candidate,
      sdpMid: this.sdpMid,
      sdpMLineIndex: this.sdpMLineIndex,
      usernameFragment: this.usernameFragment,
    };
  }
}

const RAW = new FakeRTCIceCandidate({
  candidate: 'candidate:1 1 udp 2113937151 100.85.49.69 51820 typ host',
  sdpMid: '0',
  sdpMLineIndex: 0,
  usernameFragment: 'abcd',
});

test('serializeCandidate produces a structured-cloneable plain object', () => {
  const out = serializeCandidate(RAW);
  assert.ok(isCloneable(out), 'serialized candidate must survive structured clone');
  assert.ok(isCloneable({ kind: 'candidate', callId: 'x', candidate: out }), 'full signal frame must clone');
});

test('serializeCandidate preserves every field ICE needs', () => {
  const out = serializeCandidate(RAW);
  assert.equal(out.candidate, RAW.candidate);
  assert.equal(out.sdpMid, '0');
  assert.equal(out.sdpMLineIndex, 0);
  assert.equal(out.usernameFragment, 'abcd');
  // sdpMLineIndex 0 is falsy — it must not be dropped or coerced to null.
  assert.notEqual(out.sdpMLineIndex, null);
});

test('serializeCandidate handles a plain object with no toJSON', () => {
  const out = serializeCandidate({ candidate: 'candidate:2 1 udp 1 10.0.0.2 4 typ host', sdpMid: '1', sdpMLineIndex: 1 });
  assert.ok(isCloneable(out));
  assert.equal(out.sdpMid, '1');
  assert.equal(out.usernameFragment, null);
});

test('serializeDescription reduces a session description to type + sdp', () => {
  const desc = { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n', extra: () => {} };
  const out = serializeDescription(desc);
  assert.deepEqual(Object.keys(out).sort(), ['sdp', 'type']);
  assert.ok(isCloneable(out), 'description must survive structured clone');
});

test('null inputs do not throw', () => {
  assert.equal(serializeCandidate(null), null);
  assert.equal(serializeDescription(undefined), null);
});

test('isCloneable rejects values that cannot cross the IPC boundary', () => {
  // Node cannot construct a real RTCIceCandidate, and a plain class instance IS
  // cloneable here (structuredClone just drops the prototype), so this asserts
  // the guard against a representative non-cloneable value instead. In Chromium
  // RTCIceCandidate fails for a related reason: it is a platform object that the
  // spec does not mark [Serializable], so structured clone throws DataCloneError.
  assert.equal(isCloneable({ candidate: 'x', onFoo: () => {} }), false, 'functions must not be cloneable');
  assert.equal(isCloneable(serializeCandidate(RAW)), true, 'our serialized form must be cloneable');
});
