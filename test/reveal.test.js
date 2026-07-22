'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

// ipc.js needs electron + agents; stub what's touched at require time.
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  if (r === 'electron') return 'estub';
  return orig.call(this, r, ...a);
};
require.cache['estub'] = {
  id: 'estub', filename: 'estub', loaded: true,
  exports: { ipcMain: { handle: () => {} }, dialog: {}, shell: {} },
};

const { isIncomingCallSignal } = require('../src/main/ipc.js');

// When LanChat is launched hidden to the tray, only a genuine incoming call or
// group invite should raise the window — never PTT audio or mid-call ICE noise,
// which would make the window pop up unexpectedly.
test('a 1:1 call offer raises the window', () => {
  assert.equal(isIncomingCallSignal({ kind: 'offer' }), true);
});

test('a group invite raises the window', () => {
  assert.equal(isIncomingCallSignal({ channel: 'group', kind: 'invite' }), true);
});

test('PTT never raises the window', () => {
  assert.equal(isIncomingCallSignal({ channel: 'ptt', kind: 'offer' }), false);
});

test('mid-call frames do not raise the window', () => {
  assert.equal(isIncomingCallSignal({ kind: 'answer' }), false);
  assert.equal(isIncomingCallSignal({ kind: 'candidate' }), false);
  assert.equal(isIncomingCallSignal({ channel: 'group', kind: 'offer' }), false);
  assert.equal(isIncomingCallSignal({ channel: 'group', kind: 'answer' }), false);
});

test('malformed signals are safe', () => {
  assert.equal(isIncomingCallSignal(null), false);
  assert.equal(isIncomingCallSignal(undefined), false);
  assert.equal(isIncomingCallSignal('offer'), false);
});
