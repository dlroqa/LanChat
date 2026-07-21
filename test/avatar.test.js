'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

// ipc.js pulls in electron; stub it so the pure helper can be tested.
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  return r === 'electron' ? 'estub' : orig.call(this, r, ...a);
};
require.cache['estub'] = {
  id: 'estub',
  filename: 'estub',
  loaded: true,
  exports: { ipcMain: { handle: () => {} }, dialog: {}, shell: {} },
};

const { sanitizeAvatar, MAX_AVATAR_BYTES } = require('../src/main/ipc.js');

// The avatar is embedded in the identity card sent on every discovery probe, so
// an oversized or non-image value must never reach the wire.
test('a small data-URL image is kept', () => {
  const img = `data:image/jpeg;base64,${'A'.repeat(500)}`;
  assert.equal(sanitizeAvatar({ color: '#2563eb', image: img }).image, img);
});

test('an oversized image is dropped but the colour survives', () => {
  const huge = `data:image/jpeg;base64,${'A'.repeat(MAX_AVATAR_BYTES + 10)}`;
  const out = sanitizeAvatar({ color: '#059669', image: huge });
  assert.equal(out.image, null, 'oversized avatar must not reach the identity card');
  assert.equal(out.color, '#059669', 'colour fallback is preserved');
});

test('non-image values are rejected', () => {
  assert.equal(sanitizeAvatar({ image: 'https://example.com/evil.png' }).image, null);
  assert.equal(sanitizeAvatar({ image: 'javascript:alert(1)' }).image, null);
  assert.equal(sanitizeAvatar({ image: 42 }).image, null);
});

test('null avatar stays null', () => {
  assert.equal(sanitizeAvatar(null), null);
});
