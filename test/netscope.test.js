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

// ---- overlay meshes ---------------------------------------------------------
//
// Netmaker is a second overlay beside Tailscale, and admitting it must not cost
// this module the three properties the header comment is about: the check asks
// about *our* interface, it is synchronous and local, and it fails closed.
//
// The extra property here is that trust is per network. Joining a shared network
// so one person can reach you is not consent to be reachable from every network
// you happen to be enrolled in.

const OFFICE_KEY = 'iface:netmaker/10.101.0.0/24';
const SHARED_KEY = 'iface:netmaker/10.20.0.0/16';

// One `netmaker` interface carrying two networks — the shape modern netclient
// actually produces — plus a LAN interface inside one of the same ranges.
const MESH_IFACES = {
  lo: [{ address: '127.0.0.1', internal: true }],
  en0: [{ address: '10.101.0.42', cidr: '10.101.0.42/24', internal: false }],
  netmaker: [
    { address: '10.101.0.5', cidr: '10.101.0.5/24', internal: false },
    { address: '10.20.0.4', cidr: '10.20.0.4/16', internal: false },
  ],
};

function meshScope(trusted = [], extra = {}) {
  const settings = {
    acceptLan: false,
    netmakerTrusted: trusted,
    netmakerNetworks: [],
    ...extra,
  };
  return createNetScope({
    config: { get: (k) => settings[k] },
    interfaces: () => MESH_IFACES,
  });
}

test('a mesh network nobody ticked cannot reach us', () => {
  const scope = meshScope([]);
  assert.equal(scope.isMeshLocal('10.101.0.5'), true, 'we do hold an address on it');
  assert.equal(scope.isTrustedMeshLocal('10.101.0.5'), false, 'but it was never trusted');
  assert.equal(
    scope.allowInbound('10.101.0.5', '10.101.0.9'),
    false,
    'joining a network is not consent to be reachable on it'
  );
});

test('ticking a network opens that network and no other', () => {
  const scope = meshScope([OFFICE_KEY]);
  assert.equal(scope.allowInbound('10.101.0.5', '10.101.0.9'), true);
  assert.equal(
    scope.allowInbound('10.20.0.4', '10.20.0.9'),
    false,
    'the other network on the very same interface stays shut'
  );
});

test('a trust decision is read live, so unticking takes effect at once', () => {
  const settings = { acceptLan: false, netmakerTrusted: [OFFICE_KEY], netmakerNetworks: [] };
  const scope = createNetScope({
    config: { get: (k) => settings[k] },
    interfaces: () => MESH_IFACES,
  });
  assert.equal(scope.allowInbound('10.101.0.5', '10.101.0.9'), true);

  settings.netmakerTrusted = [];
  assert.equal(
    scope.allowInbound('10.101.0.5', '10.101.0.9'),
    false,
    'no restart, no cached answer — exactly how acceptLan behaves'
  );
});

test('a mesh range on an ordinary interface is not a mesh', () => {
  // en0 carries 10.101.0.42, inside the very range the mesh uses. Trusting the
  // network must not trust the café.
  const scope = meshScope([OFFICE_KEY]);
  assert.equal(scope.isMeshLocal('10.101.0.42'), false, 'the interface name is the gate');
  assert.equal(scope.allowInbound('10.101.0.42', '10.101.0.9'), false);
});

test('a remote address in a trusted range cannot let itself in', () => {
  // The whole point of the module: the peer chooses its source address, and we
  // choose which of our interfaces we listen on. A connection landing on the LAN
  // claiming to come from the mesh is still a LAN connection.
  const scope = meshScope([OFFICE_KEY]);
  assert.equal(scope.allowInbound('192.168.1.5', '10.101.0.9'), false);
  assert.equal(scope.allowInbound(null, '10.101.0.9'), false);
});

test('a trusted mesh is a way of being reachable', () => {
  const shut = meshScope([]);
  assert.equal(shut.reachability().unreachable, true, 'no tailnet, no LAN, no ticked mesh');
  assert.equal(shut.reachability().meshTrusted, false);

  const open = meshScope([OFFICE_KEY]);
  assert.equal(
    open.reachability().unreachable,
    false,
    'a machine reachable only over a ticked mesh must not be told nobody can reach it'
  );
  assert.equal(open.reachability().meshTrusted, true);
});

test('reachability lists the meshes without widening the tailnet field', () => {
  const scope = meshScope([OFFICE_KEY]);
  const r = scope.reachability();

  assert.deepEqual(
    r.mesh.map((m) => [m.key, m.trusted]),
    [
      [OFFICE_KEY, true],
      [SHARED_KEY, false],
    ]
  );
  // Settings shows `addresses` under Tailscale. Putting mesh addresses in it
  // would make that block say something untrue.
  assert.deepEqual(r.addresses, [], 'these are tailnet addresses, and there is no tailnet here');
  assert.equal(r.tailnet, false);
});

test('a machine with no mesh at all is unchanged in every respect', () => {
  // The regression guard for every installation that upgrades into this.
  const settings = { acceptLan: false, netmakerTrusted: [], netmakerNetworks: [] };
  const scope = createNetScope({
    config: { get: (k) => settings[k] },
    interfaces: () => TAILNET_IFACES,
  });
  assert.equal(scope.allowInbound('100.85.49.69'), true, 'the tailnet still admits');
  assert.equal(scope.allowInbound('192.168.1.42'), false, 'and the LAN still does not');
  assert.deepEqual(scope.reachability().mesh, []);
  assert.equal(scope.reachability().meshTrusted, false);
  assert.equal(scope.reachability().unreachable, false);
});

test('an address two stored networks both claim admits nobody by mistake', () => {
  // Overlapping CIDRs are a real state — Netmaker cannot bridge them either —
  // and an address inside both cannot say which network it belongs to. The
  // fallback is the key the interface's own range implies, which is the most
  // specific true fact available and can never be wider than the interface.
  const overlapping = [
    { key: 'wide', cidr: '10.0.0.0/8' },
    { key: 'narrow', cidr: '10.101.0.0/24' },
  ];
  const scope = (trusted) =>
    createNetScope({
      config: {
        get: (k) => ({ acceptLan: false, netmakerNetworks: overlapping, netmakerTrusted: trusted })[k],
      },
      interfaces: () => ({ netmaker: [{ address: '10.101.0.5', cidr: '10.101.0.5/24', internal: false }] }),
    });

  assert.equal(
    scope(['wide']).allowInbound('10.101.0.5'),
    false,
    'an ambiguous address refuses rather than picking whichever record sorted first'
  );
  assert.equal(scope(['iface:netmaker/10.101.0.0/24']).allowInbound('10.101.0.5'), true);
});

test('a network wider than our own prefix is still the network we ticked', () => {
  // Netmaker hands out the network's CIDR, which can be wider than the prefix on
  // our interface. Matching it is correct: it is the network the user ticked.
  const records = [{ key: 'office', cidr: '10.0.0.0/8' }];
  const scope = (trusted) =>
    createNetScope({
      config: {
        get: (k) => ({ acceptLan: false, netmakerNetworks: records, netmakerTrusted: trusted })[k],
      },
      interfaces: () => ({ netmaker: [{ address: '10.101.0.5', cidr: '10.101.0.5/24', internal: false }] }),
    });

  assert.equal(scope(['office']).allowInbound('10.101.0.5'), true);
  assert.equal(scope([]).allowInbound('10.101.0.5'), false, 'and it is still opt-in');
});
