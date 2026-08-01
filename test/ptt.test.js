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
  // Strict, because the real thing is. A `new Function` body is sloppy mode, and
  // sloppy mode answers an assignment to an undeclared name by inventing a
  // global instead of throwing — which is how an assignment that killed
  // push-to-talk outright in the app passed every test in this file. Evaluating
  // it the way the browser evaluates the module is the only honest version.
  const fn = new Function(
    'window',
    'document',
    'navigator',
    'RTCPeerConnection',
    'MediaStream',
    `'use strict';
     ${body}
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

test('dictation may claim the key while typing, but nothing else can', () => {
  // The suppression above is what talking to a person needs and what dictation
  // cannot live with — it writes into the very box that holds focus. So the
  // exemption is opt-in, and its default must leave the person path alone.
  const off = loadPtt({ activeTag: 'TEXTAREA' });
  const offCalls = [];
  off.api.attachPttKey({
    keyName: 'meta',
    isEnabled: () => true,
    allowWhileTyping: () => false,
    onDown: () => offCalls.push('down'),
    onUp: () => offCalls.push('up'),
  });
  fire(off.listeners, 'keydown', { key: 'Meta', repeat: false });
  assert.deepEqual(offCalls, [], 'opting out must behave exactly as before');

  const on = loadPtt({ activeTag: 'TEXTAREA' });
  const onCalls = [];
  on.api.attachPttKey({
    keyName: 'meta',
    isEnabled: () => true,
    allowWhileTyping: () => true,
    onDown: () => onCalls.push('down'),
    onUp: () => onCalls.push('up'),
  });
  fire(on.listeners, 'keydown', { key: 'Meta', repeat: false });
  fire(on.listeners, 'keyup', { key: 'Meta' });
  assert.deepEqual(onCalls, ['down', 'up']);
});

test('a shortcut still aborts the hold while typing', () => {
  // This is what keeps ⌘C from opening the microphone: the release arrives
  // within tens of milliseconds, well inside the dictation arming window.
  const { api, listeners } = loadPtt({ activeTag: 'TEXTAREA' });
  const calls = [];
  api.attachPttKey({
    keyName: 'meta',
    isEnabled: () => true,
    allowWhileTyping: () => true,
    onDown: () => calls.push('down'),
    onUp: () => calls.push('up'),
  });
  fire(listeners, 'keydown', { key: 'Meta', repeat: false });
  fire(listeners, 'keydown', { key: 'c', repeat: false }); // ⌘C in the composer
  assert.deepEqual(calls, ['down', 'up'], 'copying must not become a recording');
});

test('the key a card can name is the key it would bind', () => {
  // The card used to read its label straight out of PTT_KEYS, which has no
  // 'custom' entry — so a recorded key showed "Command (⌘)" while F13 was what
  // actually worked. Both sides now go through resolvePttKey, and this is what
  // keeps them from drifting apart again.
  const { api } = loadPtt();
  for (const [keyName, code] of [
    ['meta', null],
    ['control', null],
    ['alt', null],
    ['space', null],
    ['custom', 'F13'],
    ['custom', 'KeyJ'],
    ['nonsense', null], // an old config naming a key this build no longer has
  ]) {
    const def = api.resolvePttKey(keyName, code);
    const calls = [];
    api.attachPttKey({
      keyName,
      customCode: code,
      isEnabled: () => true,
      onDown: () => calls.push('down'),
      onUp: () => calls.push('up'),
    });
    assert.ok(def.label, `${keyName}/${code} must resolve to something nameable`);
    // The definition the label comes from is the definition the listener matches
    // on, so an event built from it has to be the one that starts a hold.
    assert.ok(def.match({ key: def.code, code: def.code }), `${def.label} must match its own key`);
  }
});

test('a recorded key is named by what was recorded, not by the default', () => {
  const { api } = loadPtt();
  assert.equal(api.resolvePttKey('custom', 'F13').label, 'F13');
  assert.equal(api.resolvePttKey('custom', 'KeyJ').label, 'J');
  assert.equal(api.resolvePttKey('alt', null).label, 'Option / Alt');
  // No recorded code yet: falls back to the platform default, which is also
  // what attachPttKey would bind — consistent rather than merely plausible.
  assert.equal(api.resolvePttKey('custom', null).label, 'Command (⌘)');
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
  // Declared here and assigned below on purpose: the stream's getters close over
  // it, so it has to exist before they are written and hold its value after.
  // eslint-disable-next-line prefer-const
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
