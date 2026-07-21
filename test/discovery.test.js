'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseTailnetPeers } = require('../src/main/discovery.js');

// A trimmed real-shape `tailscale status --json` payload.
const SAMPLE = {
  Self: { HostName: 'me', TailscaleIPs: ['100.85.49.69', 'fd7a:115c:a1e0::ad35:3147'] },
  Peer: {
    k1: { HostName: 'eds-macbook-air', DNSName: 'eds-macbook-air.tail.ts.net.', TailscaleIPs: ['100.105.210.28', 'fd7a::1'], OS: 'macOS', Online: true },
    k2: { HostName: 'old-box', TailscaleIPs: ['100.75.4.89'], OS: 'linux', Online: false },
    kself: { HostName: 'me-dup', TailscaleIPs: ['100.85.49.69'], OS: 'linux', Online: true },
  },
};

test('parseTailnetPeers extracts IPv4 peers and online state', () => {
  const peers = parseTailnetPeers(SAMPLE);
  const air = peers.find((p) => p.hostname === 'eds-macbook-air');
  assert.ok(air, 'should include the macbook');
  assert.equal(air.ip, '100.105.210.28');
  assert.equal(air.online, true);
  assert.equal(air.os, 'macOS');

  const old = peers.find((p) => p.hostname === 'old-box');
  assert.equal(old.online, false);
});

test('parseTailnetPeers excludes self by shared IP', () => {
  const peers = parseTailnetPeers(SAMPLE);
  assert.ok(!peers.some((p) => p.ip === '100.85.49.69'), 'self IP must be filtered out');
});

test('parseTailnetPeers is safe on empty/null input', () => {
  assert.deepEqual(parseTailnetPeers(null), []);
  assert.deepEqual(parseTailnetPeers({}), []);
});
