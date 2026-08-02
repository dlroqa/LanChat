'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// rtc.js is renderer ESM built around WebRTC globals (RTCPeerConnection,
// navigator.mediaDevices) that do not exist in node. offerPayload/
// answerPayload are pure and never touch them, so the module can be evaluated
// here (the CallManager class body is only *defined*, never instantiated)
// exactly the way groupcall.test.js already does for shouldOffer/reconcileRoster.
const RTC_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'lib', 'rtc.js'), 'utf8');
const { offerPayload, answerPayload } = new Function(
  `${RTC_SRC.replace(/^import[^\n]*\n/gm, '').replace(/^export /gm, '')}
   return { offerPayload, answerPayload };`
)();

const SIGNAL_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'lib', 'signal.js'), 'utf8');
const { isCloneable } = new Function(
  `${SIGNAL_SRC.replace(/^export\s+/gm, '')}
   return { isCloneable };`
)();

test('offerPayload marks a support session and defaults to false', () => {
  const supportOffer = offerPayload({
    callId: 'c1',
    withVideo: true,
    name: 'Alex',
    sdp: { type: 'offer', sdp: 'x' },
    support: true,
  });
  assert.equal(supportOffer.kind, 'offer');
  assert.equal(supportOffer.support, true);

  const plainOffer = offerPayload({
    callId: 'c2',
    withVideo: true,
    name: 'Alex',
    sdp: { type: 'offer', sdp: 'x' },
  });
  assert.equal(plainOffer.support, false);
});

test('answerPayload only attaches deviceInfo for a support session', () => {
  const deviceInfo = { mic: 'Realtek Audio', camera: 'HD Webcam' };

  // An ordinary call's answer shape must be unchanged, even if a stray
  // deviceInfo were ever computed for it.
  const plain = answerPayload({
    callId: 'c1',
    sdp: { type: 'answer', sdp: 'x' },
    support: false,
    deviceInfo,
  });
  assert.ok(!('deviceInfo' in plain));

  const support = answerPayload({
    callId: 'c1',
    sdp: { type: 'answer', sdp: 'x' },
    support: true,
    deviceInfo,
  });
  assert.deepEqual(support.deviceInfo, deviceInfo);

  // A support session where labels failed to resolve must not add a null key.
  const noInfo = answerPayload({
    callId: 'c1',
    sdp: { type: 'answer', sdp: 'x' },
    support: true,
    deviceInfo: null,
  });
  assert.ok(!('deviceInfo' in noInfo));
});

test('offer and answer payloads survive structured clone across the IPC boundary', () => {
  const offer = offerPayload({
    callId: 'c1',
    withVideo: true,
    name: 'Alex',
    sdp: { type: 'offer', sdp: 'x' },
    support: true,
  });
  assert.ok(isCloneable(offer));

  const answer = answerPayload({
    callId: 'c1',
    sdp: { type: 'answer', sdp: 'x' },
    support: true,
    deviceInfo: { mic: 'Mic', camera: 'Cam' },
  });
  assert.ok(isCloneable(answer));
});
