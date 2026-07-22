'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// ptt.js is renderer ESM; evaluate the pure pieces without a bundler. The
// keyboard helper touches window/document, so we stub just enough of the DOM.
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'lib', 'ptt.js'), 'utf8');

function loadPtt({
  activeTag = 'BODY',
  RTCPeerConnection = function () {},
  MediaStream = function () {},
  nav = { platform: 'MacIntel' },
} = {}) {
  const listeners = {};
  const win = {
    addEventListener: (t, fn) => ((listeners[t] = listeners[t] || []).push(fn)),
    removeEventListener: (t, fn) => {
      listeners[t] = (listeners[t] || []).filter((f) => f !== fn);
    },
  };
  const doc = { activeElement: { tagName: activeTag, isContentEditable: false } };
  const body = SRC.replace(/^export\s+/gm, '');
  const fn = new Function(
    'window',
    'document',
    'navigator',
    'RTCPeerConnection',
    'MediaStream',
    `${body}
     return { PTT_KEYS, defaultPttKey, attachPttKey, resolvePttKey, describeKeyCode, PttManager };`
  );
  return { api: fn(win, doc, nav, RTCPeerConnection, MediaStream), listeners };
}

function fire(listeners, type, event) {
  for (const fn of listeners[type] || []) fn(event);
}

test('defaultPttKey is Command on macOS', () => {
  const { api } = loadPtt();
  assert.equal(api.defaultPttKey(), 'meta');
});

test('holding the key transmits, releasing stops', () => {
  const { api, listeners } = loadPtt();
  const calls = [];
  api.attachPttKey({
    keyName: 'meta',
    isEnabled: () => true,
    onDown: () => calls.push('down'),
    onUp: () => calls.push('up'),
  });
  fire(listeners, 'keydown', { key: 'Meta', repeat: false });
  fire(listeners, 'keyup', { key: 'Meta' });
  assert.deepEqual(calls, ['down', 'up']);
});

test('a shortcut like Command+C does not keep transmitting', () => {
  const { api, listeners } = loadPtt();
  const calls = [];
  api.attachPttKey({
    keyName: 'meta',
    isEnabled: () => true,
    onDown: () => calls.push('down'),
    onUp: () => calls.push('up'),
  });
  fire(listeners, 'keydown', { key: 'Meta', repeat: false });
  fire(listeners, 'keydown', { key: 'c', repeat: false }); // ⌘C
  assert.deepEqual(calls, ['down', 'up'], 'pressing another key must end transmission');
});

test('the key is ignored while typing a message', () => {
  const { api, listeners } = loadPtt({ activeTag: 'TEXTAREA' });
  const calls = [];
  api.attachPttKey({
    keyName: 'meta',
    isEnabled: () => true,
    onDown: () => calls.push('down'),
    onUp: () => calls.push('up'),
  });
  fire(listeners, 'keydown', { key: 'Meta', repeat: false });
  assert.deepEqual(calls, [], 'must not hijack modifiers while composing');
});

test('losing window focus stops transmitting', () => {
  const { api, listeners } = loadPtt();
  const calls = [];
  api.attachPttKey({
    keyName: 'meta',
    isEnabled: () => true,
    onDown: () => calls.push('down'),
    onUp: () => calls.push('up'),
  });
  fire(listeners, 'keydown', { key: 'Meta', repeat: false });
  fire(listeners, 'blur', {});
  assert.deepEqual(calls, ['down', 'up'], 'the mic must not stay live after focus loss');
});

test('key repeat does not re-trigger', () => {
  const { api, listeners } = loadPtt();
  let downs = 0;
  api.attachPttKey({ keyName: 'meta', isEnabled: () => true, onDown: () => (downs += 1), onUp: () => {} });
  fire(listeners, 'keydown', { key: 'Meta', repeat: false });
  fire(listeners, 'keydown', { key: 'Meta', repeat: true });
  assert.equal(downs, 1);
});

test('disabled push-to-talk never fires', () => {
  const { api, listeners } = loadPtt();
  let downs = 0;
  api.attachPttKey({ keyName: 'meta', isEnabled: () => false, onDown: () => (downs += 1), onUp: () => {} });
  fire(listeners, 'keydown', { key: 'Meta', repeat: false });
  assert.equal(downs, 0);
});

// --- custom recorded key ---

// A user-recorded binding matches on event.code (the physical key) so it keeps
// working after a keyboard-layout change.
test('a custom recorded key transmits on hold and stops on release', () => {
  const { api, listeners } = loadPtt();
  const calls = [];
  api.attachPttKey({
    keyName: 'custom',
    customCode: 'KeyF',
    isEnabled: () => true,
    onDown: () => calls.push('down'),
    onUp: () => calls.push('up'),
  });
  fire(listeners, 'keydown', { key: 'f', code: 'KeyF', repeat: false });
  fire(listeners, 'keyup', { key: 'f', code: 'KeyF' });
  assert.deepEqual(calls, ['down', 'up']);
});

test('a custom binding ignores other keys', () => {
  const { api, listeners } = loadPtt();
  let downs = 0;
  api.attachPttKey({
    keyName: 'custom',
    customCode: 'KeyF',
    isEnabled: () => true,
    onDown: () => (downs += 1),
    onUp: () => {},
  });
  fire(listeners, 'keydown', { key: 'g', code: 'KeyG', repeat: false });
  assert.equal(downs, 0);
});

// Push-to-talk must never end up bound to nothing, or the feature silently dies.
test('custom mode with no recorded key falls back to the platform default', () => {
  const { api } = loadPtt();
  assert.equal(api.resolvePttKey('custom', null).label, api.PTT_KEYS[api.defaultPttKey()].label);
  assert.equal(api.resolvePttKey('nonsense', null).label, api.PTT_KEYS[api.defaultPttKey()].label);
});

test('a recorded code is described legibly for the settings label', () => {
  const { api } = loadPtt();
  assert.equal(api.describeKeyCode('KeyF'), 'F');
  assert.equal(api.describeKeyCode('Digit4'), '4');
  assert.equal(api.describeKeyCode('Backquote'), '`');
  assert.equal(api.describeKeyCode(null), 'Not set');
});

// --- radio-style cues ---

function makeManager(api, { onCue } = {}) {
  return new api.PttManager({
    sendSignal: () => {},
    onState: () => {},
    getIceServers: () => [],
    getDevices: () => ({ audioInputId: null }),
    onError: () => {},
    onCue,
  });
}

// The listener hears an "incoming" cue the moment a peer starts talking, exactly
// once per transmission — on the silence->talking edge, never on release.
test('an incoming talk signal fires the receive cue once, on the rising edge', () => {
  const cues = [];
  const { api } = loadPtt();
  const mgr = makeManager(api, { onCue: (kind) => cues.push(kind) });
  mgr.inbound.set('peer-1', { pc: { close() {} }, stream: null, pending: [], talking: false });

  mgr.handleSignal('peer-1', { kind: 'talk', talking: true });
  mgr.handleSignal('peer-1', { kind: 'talk', talking: true }); // no re-trigger while held
  mgr.handleSignal('peer-1', { kind: 'talk', talking: false }); // release is silent
  mgr.handleSignal('peer-1', { kind: 'talk', talking: true }); // next transmission cues again

  assert.deepEqual(cues, ['incoming', 'incoming']);
});

// A talk signal for a peer we never accepted an offer from must not cue.
test('a talk signal with no inbound channel does not cue', () => {
  const cues = [];
  const { api } = loadPtt();
  const mgr = makeManager(api, { onCue: (kind) => cues.push(kind) });
  mgr.handleSignal('stranger', { kind: 'talk', talking: true });
  assert.deepEqual(cues, []);
});

// onCue is optional: an unwired manager must not throw on an incoming talk.
test('the cue callback defaults to a no-op', () => {
  const { api } = loadPtt();
  const mgr = makeManager(api);
  mgr.inbound.set('peer-1', { pc: { close() {} }, stream: null, pending: [], talking: false });
  assert.doesNotThrow(() => mgr.handleSignal('peer-1', { kind: 'talk', talking: true }));
});

// Keying up plays the local "go ahead" cue while the mic is still muted, so the
// beep is a prompt to the talker and never rides out to the peer on the hot mic.
test('the transmit cue fires before the microphone is unmuted', async () => {
  let track;
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  };
  const nav = {
    platform: 'MacIntel',
    mediaDevices: { getUserMedia: async () => stream },
  };
  function FakePc() {
    this.connectionState = 'new';
    this.onicecandidate = null;
    this.onconnectionstatechange = null;
  }
  FakePc.prototype.addTrack = () => {};
  FakePc.prototype.createOffer = async () => ({ type: 'offer', sdp: 'x' });
  FakePc.prototype.setLocalDescription = async () => {};
  FakePc.prototype.close = () => {};

  const { api } = loadPtt({ RTCPeerConnection: FakePc, nav });

  const cueMicStates = [];
  track = { enabled: false };
  const mgr = makeManager(api, {
    onCue: (kind) => cueMicStates.push([kind, track.enabled]),
  });

  await mgr.setTransmitting(true, { id: 'peer-1' });

  assert.deepEqual(cueMicStates, [['transmit', false]], 'cue must play with the mic still muted');
  assert.equal(track.enabled, true, 'the mic is live once transmission starts');
  assert.equal(mgr.transmitting, true);
});
