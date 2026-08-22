'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// manualPeers grew from flat "ip:port" strings into records, because a peer code
// has to record the id and fingerprint it promised.
//
// The risk in that is entirely one-directional: netScope treats a hand-typed
// address as consent to accept inbound from it, so a reader that stopped
// understanding the old spelling would quietly close a door the user had opened.
// These are the guard on that.

const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  return r === 'electron' ? 'mp-estub' : orig.call(this, r, ...a);
};
require.cache['mp-estub'] = {
  id: 'mp-estub',
  filename: 'mp-estub',
  loaded: true,
  exports: { app: {}, safeStorage: { isEncryptionAvailable: () => false } },
};

const { manualPeerRecord } = require('../src/main/adopt.js');
const { Config } = require('../src/main/config.js');

test('both spellings are read, not just the one on disk today', () => {
  const fromString = manualPeerRecord('203.0.113.9:47100');
  assert.equal(fromString.address, '203.0.113.9');
  assert.equal(fromString.port, 47100);
  assert.equal(fromString.fingerprint, null, 'a hand-typed address promised nothing');

  const fromRecord = manualPeerRecord({ address: '10.55.0.2', port: 47100, fingerprint: 'AAAA-BBBB' });
  assert.equal(fromRecord.address, '10.55.0.2');
  assert.equal(fromRecord.fingerprint, 'AAAA-BBBB');
});

test('a default port fills in for an address written without one', () => {
  assert.equal(manualPeerRecord('203.0.113.9', 47100).port, 47100);
  assert.equal(manualPeerRecord({ address: '10.1.1.1' }, 47100).port, 47100);
  assert.equal(manualPeerRecord('203.0.113.9:47999', 47100).port, 47999, 'and never overrides one');
});

test('an entry with no address is nothing, rather than a peer at ""', () => {
  assert.equal(manualPeerRecord(''), null);
  assert.equal(manualPeerRecord(null), null);
  assert.equal(manualPeerRecord({}), null);
  assert.equal(manualPeerRecord({ address: '   ' }), null);
  assert.equal(manualPeerRecord(':47100'), null);
});

function configWith(manualPeers) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-mp-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ id: 'abc', manualPeers }));
  return { config: new Config(dir, '9.9.9'), dir };
}

test('an old config is upgraded on load', () => {
  const { config, dir } = configWith(['203.0.113.9:47100', '198.51.100.4:47100']);
  assert.deepEqual(config.get('manualPeers'), [
    { address: '203.0.113.9', port: 47100 },
    { address: '198.51.100.4', port: 47100 },
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a config that has already been upgraded is left alone', () => {
  const records = [{ address: '10.55.0.2', port: 47100, peerId: 'p1', fingerprint: 'AAAA' }];
  const { config, dir } = configWith(records);
  assert.deepEqual(config.get('manualPeers'), records, 'idempotent');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('junk in the list is dropped rather than carried forward', () => {
  const { config, dir } = configWith(['203.0.113.9:47100', '', null, ':47100']);
  assert.deepEqual(config.get('manualPeers'), [{ address: '203.0.113.9', port: 47100 }]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the addresses netScope is told about do not change across the upgrade', () => {
  // The exact regression this migration could have caused: netScope consults
  // these to decide whether to accept an inbound connection, so the set before
  // and after must be identical.
  const before = ['203.0.113.9:47100', '198.51.100.4:47100'];
  const addressesOf = (list) => list.map((e) => manualPeerRecord(e)).map((r) => r && r.address);

  const { config, dir } = configWith(before);
  assert.deepEqual(addressesOf(before), addressesOf(config.get('manualPeers')));
  fs.rmSync(dir, { recursive: true, force: true });
});
