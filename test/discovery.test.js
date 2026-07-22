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

// Tailscale device sharing: shared machines keep their OWNER's MagicDNS suffix,
// which is the documented way to tell them apart from our own tailnet devices.
const SHARED_SAMPLE = {
  Self: { HostName: 'me', TailscaleIPs: ['100.85.49.69'] },
  CurrentTailnet: { MagicDNSSuffix: 'tail910c1e.ts.net' },
  Peer: {
    mine: {
      HostName: 'my-laptop',
      DNSName: 'my-laptop.tail910c1e.ts.net.',
      TailscaleIPs: ['100.1.1.1'],
      OS: 'macOS',
      Online: true,
    },
    shared: {
      HostName: 'friends-pc',
      DNSName: 'friends-pc.othertailnet.ts.net.',
      TailscaleIPs: ['100.2.2.2'],
      OS: 'windows',
      Online: true,
    },
  },
};

test('parseTailnetPeers flags devices shared in from another tailnet', () => {
  const peers = parseTailnetPeers(SHARED_SAMPLE);
  const mine = peers.find((p) => p.hostname === 'my-laptop');
  const shared = peers.find((p) => p.hostname === 'friends-pc');

  assert.equal(mine.shared, false, 'own-tailnet device must not be flagged');
  assert.equal(shared.shared, true, 'foreign DNS suffix means shared');
  // Shared devices must still be discoverable, not filtered out.
  assert.equal(shared.ip, '100.2.2.2');
  assert.equal(shared.online, true);
});

test('parseTailnetPeers does not guess "shared" without a MagicDNS suffix', () => {
  const noSuffix = { ...SHARED_SAMPLE, CurrentTailnet: {} };
  for (const p of parseTailnetPeers(noSuffix)) {
    assert.equal(p.shared, false, 'must not claim shared when it cannot be determined');
  }
});

// --- Tailscale CLI resolution ---
//
// Regression guard for the bug where tailnet discovery silently found nothing in
// a packaged app: a GUI-launched process does not inherit the shell PATH, so a
// bare execFile('tailscale') fails with ENOENT on every poll.
test('known install locations are probed for each platform', () => {
  const { TAILSCALE_PATHS } = require('../src/main/discovery.js');
  // The macOS App Store build is the one that is never on a GUI PATH.
  assert.ok(
    TAILSCALE_PATHS.darwin.includes('/Applications/Tailscale.app/Contents/MacOS/Tailscale'),
    'the Mac App Store install path must be probed'
  );
  assert.ok(TAILSCALE_PATHS.darwin.some((p) => p.includes('homebrew')), 'Homebrew installs must be probed');
  for (const platform of ['darwin', 'linux', 'win32']) {
    assert.ok(TAILSCALE_PATHS[platform].every((p) => p.includes('tailscale') || p.includes('Tailscale')));
  }
});

test('an unknown install still falls back to PATH rather than giving up', () => {
  const { findTailscaleBinary } = require('../src/main/discovery.js');
  const resolved = findTailscaleBinary();
  assert.ok(typeof resolved === 'string' && resolved.length > 0);
});

// --- Tolerant status parsing ---
//
// A working tailnet used to read "Tailscale is not responding" whenever the CLI
// printed anything other than pristine JSON, or exited non-zero while still
// printing a full status. extractStatusJson recovers the status in those cases.
const { extractStatusJson } = require('../src/main/discovery.js');

test('extractStatusJson parses a clean status payload', () => {
  const out = JSON.stringify({ Version: '1.0', BackendState: 'Running', Self: { HostName: 'me' }, Peer: {} });
  const status = extractStatusJson(out);
  assert.ok(status && status.Self.HostName === 'me');
});

test('extractStatusJson recovers a status printed after a warning line', () => {
  // e.g. a GUI/helper binary emitting a log line before the JSON object.
  const out = 'health check: an update is available\n' + JSON.stringify({ Version: '1.0', Peer: { k: {} } });
  const status = extractStatusJson(out);
  assert.ok(status, 'the JSON after the preamble must still be recovered');
  assert.ok(status.Peer.k, 'peers must survive the noise');
});

test('extractStatusJson recovers a status followed by trailing noise', () => {
  const out = JSON.stringify({ BackendState: 'Running', Peer: {} }) + '\n# some trailing warning';
  assert.ok(extractStatusJson(out), 'trailing text after the object must not defeat parsing');
});

test('extractStatusJson rejects unrelated JSON and junk', () => {
  assert.equal(extractStatusJson(''), null);
  assert.equal(extractStatusJson(null), null);
  assert.equal(extractStatusJson('not json at all'), null);
  // Valid JSON, but not a Tailscale status — must not be mistaken for one.
  assert.equal(extractStatusJson('{"error":"something else"}'), null);
});
