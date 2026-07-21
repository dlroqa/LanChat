'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// ptt.js is renderer ESM; evaluate the pure pieces without a bundler. The
// keyboard helper touches window/document, so we stub just enough of the DOM.
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'lib', 'ptt.js'), 'utf8');

function loadPtt({ activeTag = 'BODY' } = {}) {
  const listeners = {};
  const win = {
    addEventListener: (t, fn) => ((listeners[t] = listeners[t] || []).push(fn)),
    removeEventListener: (t, fn) => {
      listeners[t] = (listeners[t] || []).filter((f) => f !== fn);
    },
  };
  const doc = { activeElement: { tagName: activeTag, isContentEditable: false } };
  const nav = { platform: 'MacIntel' };
  const body = SRC.replace(/^export\s+/gm, '');
  const fn = new Function(
    'window',
    'document',
    'navigator',
    'RTCPeerConnection',
    'MediaStream',
    `${body}
     return { PTT_KEYS, defaultPttKey, attachPttKey };`
  );
  return { api: fn(win, doc, nav, function () {}, function () {}), listeners };
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
