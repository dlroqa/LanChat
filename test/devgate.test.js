'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { DevGate, DEFAULT_PASSWORD } = require('../src/main/devgate');

// devgate.js has no Electron dependency, so it can be exercised directly with
// plain node:test against a scratch userData directory.

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-devgate-'));
}

test('first run seeds the default password and it verifies', () => {
  const gate = new DevGate(tmpDir());
  assert.equal(gate.verify(DEFAULT_PASSWORD).ok, true);
});

test('wrong password fails and the hash never contains the plaintext', () => {
  const dir = tmpDir();
  const gate = new DevGate(dir);
  assert.equal(gate.verify('not-the-password').ok, false);

  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'devgate.json'), 'utf8'));
  assert.ok(!raw.hash.includes(Buffer.from(DEFAULT_PASSWORD).toString('hex')));
  assert.notEqual(raw.hash, DEFAULT_PASSWORD);
});

test('setPassword is refused unless the gate was just unlocked', () => {
  const gate = new DevGate(tmpDir());
  assert.throws(() => gate.setPassword('new-pass-1'), /locked/i);
});

test('setPassword succeeds once unlocked, and persists across a fresh instance', () => {
  const dir = tmpDir();
  const gate = new DevGate(dir);
  assert.equal(gate.verify(DEFAULT_PASSWORD).ok, true);
  gate.setPassword('a-new-password');

  const reloaded = new DevGate(dir);
  assert.equal(reloaded.verify('a-new-password').ok, true);
  assert.equal(reloaded.verify(DEFAULT_PASSWORD).ok, false);
});

test('lock() immediately revokes the unlocked session', () => {
  const gate = new DevGate(tmpDir());
  assert.equal(gate.verify(DEFAULT_PASSWORD).ok, true);
  assert.equal(gate.isUnlocked(), true);
  gate.lock();
  assert.equal(gate.isUnlocked(), false);
  assert.throws(() => gate.setPassword('whatever'), /locked/i);
});

test('repeated failures lock out even the correct password', () => {
  const gate = new DevGate(tmpDir());
  // First two wrong attempts have no lockout.
  assert.equal(gate.verify('wrong-1').lockedMs, undefined);
  assert.equal(gate.verify('wrong-2').lockedMs, undefined);
  // The third failure starts a lockout window.
  const third = gate.verify('wrong-3');
  assert.equal(third.ok, false);
  assert.ok(third.lockedMs > 0);

  // Even the *correct* password is refused while locked out — the lockout
  // can't be skipped just by knowing the answer.
  const duringLockout = gate.verify(DEFAULT_PASSWORD);
  assert.equal(duringLockout.ok, false);
  assert.ok(duringLockout.lockedMs > 0);
});
