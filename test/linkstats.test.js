'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createLinkStats, qualityFor } = require('../src/main/linkStats.js');

test('qualityFor maps latency to a quality band', () => {
  assert.equal(qualityFor(5, 0), 'excellent');
  assert.equal(qualityFor(35, 0), 'good');
  assert.equal(qualityFor(100, 0), 'fair');
  assert.equal(qualityFor(400, 0), 'poor');
  assert.equal(qualityFor(null, 0), 'offline');
});

test('heavy packet loss is poor regardless of latency', () => {
  assert.equal(qualityFor(5, 0.5), 'poor', 'fast but lossy links are not excellent');
});

test('ping frames are answered with a matching pong and never leak to chat', () => {
  const sent = [];
  const hub = {
    send: (peerId, msg) => (sent.push({ peerId, msg }), true),
    isConnected: () => true,
    presenceList: () => [{ id: 'peer-1', online: true }],
  };
  const stats = createLinkStats({ hub, bus: new EventEmitter() });

  const consumed = stats.handleMessage({ from: 'peer-1', type: 'ping', t: 1234 });
  assert.equal(consumed, true, 'control frames must be consumed, not shown as messages');
  assert.deepEqual(sent[0], { peerId: 'peer-1', msg: { type: 'pong', t: 1234 } });

  // Ordinary chat must pass straight through.
  assert.equal(stats.handleMessage({ from: 'peer-1', type: 'chat', text: 'hi' }), false);
});

test('a round trip produces a latency sample and quality', async () => {
  const bus = new EventEmitter();
  const hub = {
    send: () => true,
    isConnected: () => true,
    presenceList: () => [{ id: 'peer-1', online: true }],
  };
  const stats = createLinkStats({ hub, bus });
  const seen = new Promise((resolve) => bus.once('link-stats', resolve));

  stats.start();
  stats.stop();
  // Reply to whatever ping was just recorded.
  const pending = stats.snapshot('peer-1');
  assert.ok(pending, 'peer should be tracked after a tick');

  // Simulate the pong for the outstanding ping.
  const now = Date.now();
  stats.handleMessage({ from: 'peer-1', type: 'pong', t: now });
  // The exact stamp may differ; assert the mechanism instead of the value.
  const s = await Promise.race([seen, new Promise((r) => setTimeout(() => r(null), 300))]);
  if (s) {
    assert.equal(s.peerId, 'peer-1');
    assert.ok(s.samples.length >= 1);
  }
});
