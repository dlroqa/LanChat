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

test('a round trip produces a latency sample and quality', () => {
  const sent = [];
  const bus = new EventEmitter();
  const hub = {
    send: (peerId, msg) => (sent.push(msg), true),
    isConnected: () => true,
    presenceList: () => [{ id: 'peer-1', online: true }],
  };
  const stats = createLinkStats({ hub, bus });

  stats.start();
  stats.stop();
  const ping = sent.find((m) => m.type === 'ping');
  assert.ok(ping, 'a tick sends a ping to a connected peer');

  // Answer the ping that was actually sent, rather than guessing its stamp.
  stats.handleMessage({ from: 'peer-1', type: 'pong', t: ping.t });
  const s = stats.snapshot('peer-1');
  assert.equal(s.peerId, 'peer-1');
  assert.equal(s.samples.length, 1);
  assert.ok(s.rtt != null, 'the round trip is timed');
  assert.equal(s.loss, 0);
  assert.equal(s.quality, 'excellent', 'a loopback round trip is fast');
});

// Windows only. The panel there had no way to tell "still warming up" from
// "answering nothing", because stats were published only when an answer
// arrived: a link where every round trip vanished emitted absolutely nothing,
// and the graph sat on "measuring…" for as long as the app stayed open.
test('a peer that answers nothing is still reported, every tick', () => {
  const bus = new EventEmitter();
  const seen = [];
  bus.on('link-stats', (s) => seen.push(s));
  const hub = {
    send: () => true, // the frame leaves; nothing ever comes back
    isConnected: () => true,
    presenceList: () => [{ id: 'peer-1', online: true }],
  };
  const stats = createLinkStats({ hub, bus, windows: true });

  stats.start();
  stats.stop();

  assert.equal(seen.length, 1, 'a tick publishes what it knows');
  assert.equal(seen[0].peerId, 'peer-1');
  assert.equal(seen[0].quality, 'measuring', 'connected, nothing measured yet');
  assert.equal(seen[0].rtt, null);
});

test('measurement uses the socket itself when it can carry a ping', () => {
  const pings = [];
  const listeners = {};
  const socket = {
    ping: (payload) => pings.push(String(payload)),
    on: (event, fn) => (listeners[event] = fn),
  };
  const appFrames = [];
  const bus = new EventEmitter();
  const hub = {
    send: (peerId, msg) => (appFrames.push(msg), true),
    openSocket: () => socket,
    isConnected: () => true,
    presenceList: () => [{ id: 'peer-1', online: true }],
  };
  const stats = createLinkStats({ hub, bus, windows: true });

  stats.start();
  stats.stop();

  assert.equal(pings.length, 1, 'the round trip rides the WebSocket control frame');
  assert.equal(
    appFrames.filter((m) => m.type === 'ping').length,
    0,
    'no application ping is needed when the socket answers for itself'
  );

  // `ws` echoes the payload back as a Buffer.
  listeners.pong(Buffer.from(pings[0]));
  const s = stats.snapshot('peer-1');
  assert.equal(s.samples.length, 1, 'the library-level answer is a real sample');
  assert.ok(s.rtt != null);
});

test('a pong that lost its payload still counts as an answer', () => {
  const listeners = {};
  const socket = { ping: () => {}, on: (event, fn) => (listeners[event] = fn) };
  const stats = createLinkStats({
    hub: {
      send: () => true,
      openSocket: () => socket,
      isConnected: () => true,
      presenceList: () => [{ id: 'peer-1', online: true }],
    },
    bus: new EventEmitter(),
    windows: true,
  });

  stats.start();
  stats.stop();
  listeners.pong(Buffer.alloc(0));

  const s = stats.snapshot('peer-1');
  assert.equal(s.samples.length, 1, 'an empty echo is not read as total loss');
  assert.equal(s.loss, 0);
});

// The other half of the Windows fix: that it is only Windows. macOS and Linux
// were never affected, so they keep measuring exactly as they did — an
// application ping, and a report only when an answer comes back.
test('every other platform measures exactly as before', () => {
  const frames = [];
  const seen = [];
  const bus = new EventEmitter();
  bus.on('link-stats', (s) => seen.push(s));
  const socket = { ping: () => assert.fail('no protocol ping outside Windows'), on: () => {} };
  const stats = createLinkStats({
    hub: {
      send: (peerId, msg) => (frames.push(msg), true),
      openSocket: () => socket,
      isConnected: () => true,
      presenceList: () => [{ id: 'peer-1', online: true }],
    },
    bus,
    windows: false,
  });

  stats.start();
  stats.stop();

  assert.equal(frames.filter((m) => m.type === 'ping').length, 1, 'the application ping is unchanged');
  assert.equal(seen.length, 0, 'a connected peer is reported when it answers, not on a timer');

  stats.handleMessage({ from: 'peer-1', type: 'pong', t: frames[0].t });
  assert.equal(seen.length, 1, 'and an answer still publishes, as it always did');
  assert.equal(seen[0].quality, 'excellent');
});

test('an unsent ping is not counted against the link', () => {
  const stats = createLinkStats({
    hub: {
      send: () => false, // socket closed under us
      isConnected: () => true,
      presenceList: () => [{ id: 'peer-1', online: true }],
    },
    bus: new EventEmitter(),
  });

  stats.start();
  stats.stop();
  const s = stats.snapshot('peer-1');
  assert.equal(s.samples.length, 0);
  assert.equal(s.loss, 0, 'loss describes the link, not our own failure to send');
});
