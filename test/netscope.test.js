'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createNetScope, isLoopback, inTailscaleRange, bareAddress } = require('../src/main/netScope.js');

// Which network a connection landed on, and whether we want it.
//
// The whole point of this module is that it asks about *our* address rather than
// the peer's. A remote address is whatever the packet says; the interface it
// arrived on is not. Every test here is really one of two questions: does an
// address get recognised however it is spelled, and does the policy fail closed.

const TAILNET_IFACES = {
  lo: [{ address: '127.0.0.1', internal: true }],
  en0: [{ address: '192.168.1.42', internal: false }],
  tailscale0: [
    { address: '100.85.49.69', internal: false },
    { address: 'fd7a:115c:a1e0::ad35:3147', internal: false },
  ],
};
const LAN_ONLY_IFACES = {
  lo: [{ address: '127.0.0.1', internal: true }],
  en0: [{ address: '192.168.1.42', internal: false }],
};

function scope(interfaces, acceptLan = false) {
  return createNetScope({
    config: { get: (k) => (k === 'acceptLan' ? acceptLan : undefined) },
    interfaces: () => interfaces,
  });
}

// ------------------------------------------------------------ recognition

test('an address is recognised however Node happens to spell it', () => {
  // Three spellings of one address reach this module from three directions: a
  // dual-stack socket reports IPv4-mapped, server.js brackets bare IPv6 for
  // host:port strings, and os.networkInterfaces() returns it plain. If they do
  // not compare equal the tailnet check silently refuses everything.
  assert.equal(bareAddress('::ffff:100.85.49.69'), '100.85.49.69');
  assert.equal(bareAddress('[fd7a:115c:a1e0::1]'), 'fd7a:115c:a1e0::1');
  assert.equal(bareAddress('fe80::1%en0'), 'fe80::1', 'a zone index is routing, not identity');
  assert.equal(bareAddress(null), null);
});

test('loopback is recognised in both families', () => {
  for (const a of ['127.0.0.1', '127.0.0.53', '::1', '::ffff:127.0.0.1', '[::1]']) {
    assert.ok(isLoopback(a), `${a} should be loopback`);
  }
  for (const a of ['100.85.49.69', '192.168.1.1', '', null]) {
    assert.ok(!isLoopback(a), `${a} should not be loopback`);
  }
});

test('the Tailscale ranges are matched at their edges and not beyond', () => {
  assert.ok(inTailscaleRange('100.64.0.0'), 'the bottom of the CGNAT block');
  assert.ok(inTailscaleRange('100.127.255.255'), 'the top of it');
  assert.ok(!inTailscaleRange('100.63.255.255'), 'one below is ordinary space');
  assert.ok(!inTailscaleRange('100.128.0.0'), 'and so is one above');
  assert.ok(inTailscaleRange('fd7a:115c:a1e0::ad35:3147'));
  assert.ok(!inTailscaleRange('fd7a:115c:a1e1::1'), 'a neighbouring ULA prefix is not ours');
  assert.ok(!inTailscaleRange('999.1.1.1') && !inTailscaleRange('100.x.1.1'));
});

// ----------------------------------------------------------------- policy

test('a connection that landed on the tailnet is accepted; the LAN is not', () => {
  const s = scope(TAILNET_IFACES, false);
  assert.ok(s.hasTailnet());
  assert.ok(s.allowInbound('100.85.49.69'), 'arrived on the tailnet');
  assert.ok(s.allowInbound('::ffff:100.85.49.69'), 'and the mapped spelling of it');
  assert.ok(s.allowInbound('fd7a:115c:a1e0::ad35:3147'), 'and over v6');
  assert.ok(!s.allowInbound('192.168.1.42'), 'arrived on the LAN, which is off');
});

test('the peer does not get to choose — only the interface it landed on counts', () => {
  // The listener binds 0.0.0.0, so a LAN host can absolutely present a 100.x
  // source address. What it cannot do is make the connection arrive on our
  // tailscale0. This is the whole reason the check is on localAddress.
  const s = scope(TAILNET_IFACES, false);
  assert.ok(!s.allowInbound('100.99.99.99'), 'a tailnet-shaped address that is not one of ours');
  assert.ok(!s.isTailnetLocal('100.99.99.99'));
});

test('loopback is always ours', () => {
  // The renderer fetches its own previews over localhost and the suite connects
  // to 127.0.0.1; neither should depend on a tailnet existing.
  for (const s of [scope(TAILNET_IFACES, false), scope(LAN_ONLY_IFACES, false)]) {
    assert.ok(s.allowInbound('127.0.0.1'));
    assert.ok(s.allowInbound('::1'));
  }
});

test('turning LAN accept on opens the LAN and nothing else changes', () => {
  const s = scope(TAILNET_IFACES, true);
  assert.ok(s.allowInbound('192.168.1.42'));
  assert.ok(s.allowInbound('100.85.49.69'), 'the tailnet still works');
});

test('with no tailnet and no LAN accept, nothing is accepted — and it says so', () => {
  // Failing open here would mean a Tailscale outage quietly reopening the app to
  // whatever coffee-shop network it is sitting on. Failing closed is right, but
  // only if the app can explain itself instead of looking broken, which is what
  // reachability() is for.
  const s = scope(LAN_ONLY_IFACES, false);
  assert.ok(!s.hasTailnet());
  assert.ok(!s.allowInbound('192.168.1.42'));
  const r = s.reachability();
  assert.deepEqual(
    { tailnet: r.tailnet, lan: r.lan, unreachable: r.unreachable },
    { tailnet: false, lan: false, unreachable: true }
  );
});

test('reachability stops reporting unreachable once either route is open', () => {
  assert.equal(scope(LAN_ONLY_IFACES, true).reachability().unreachable, false);
  assert.equal(scope(TAILNET_IFACES, false).reachability().unreachable, false);
});

test('an interface list that cannot be read refuses rather than throwing', () => {
  // os.networkInterfaces() can fail; a throw here would take down the request
  // handler. No tailnet is the safe answer, not an exception.
  const s = createNetScope({
    config: { get: () => false },
    interfaces: () => {
      throw new Error('nope');
    },
  });
  assert.equal(s.hasTailnet(), false);
  assert.equal(s.allowInbound('100.85.49.69'), false);
  assert.equal(s.allowInbound('127.0.0.1'), true, 'loopback needs no interface list');
});

test('a tailnet coming up is noticed without a restart', () => {
  // Tailscale starts after the app does more often than not. The cache exists so
  // this is not re-read per packet, but it must not pin the answer for the life
  // of the process.
  let ifaces = LAN_ONLY_IFACES;
  const s = createNetScope({
    config: { get: () => false },
    interfaces: () => ifaces,
    now: () => Date.now(),
  });
  assert.ok(!s.hasTailnet());
  ifaces = TAILNET_IFACES;
  assert.ok(s.refresh().size > 0, 'an explicit refresh sees it immediately');
  assert.ok(s.allowInbound('100.85.49.69'));
});

test('internal interfaces are never treated as the tailnet', () => {
  const s = scope({ weird: [{ address: '100.85.49.69', internal: true }] }, false);
  assert.ok(!s.hasTailnet(), 'a loopback alias in CGNAT space is not a tailnet');
});
