'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  MESH_BACKENDS,
  bareAddress,
  isMeshInterfaceName,
  parseCidr,
  inCidr,
  prefixFromNetmask,
  meshInterfaces,
  networkKey,
  resolveNetwork,
} = require('../src/main/mesh.js');

// The vocabulary netScope and netmaker share. Two questions run through all of
// it: is this interface one an overlay put here, and which network does an
// address of ours belong to. Getting the first wrong promotes a café LAN to a
// trusted mesh; getting the second wrong collapses several networks into one
// trust decision.

// ---- naming ----------------------------------------------------------------

test('a mesh interface is recognised by name, and only by name', () => {
  assert.equal(isMeshInterfaceName('netmaker'), 'netmaker');
  assert.equal(isMeshInterfaceName('nm-office'), 'netmaker');
  assert.equal(isMeshInterfaceName('NM-Office'), 'netmaker', 'interface names are not case sensitive');

  // The negatives matter more than the positives here.
  assert.equal(isMeshInterfaceName('mynetmaker'), null, 'must anchor at the start');
  assert.equal(isMeshInterfaceName('netmaker0'), null, 'netclient does not number the base name');
  assert.equal(isMeshInterfaceName('nm-'), null, 'a bare prefix names no network');
  assert.equal(isMeshInterfaceName('tailscale0'), null);
  assert.equal(isMeshInterfaceName('en0'), null);
  assert.equal(isMeshInterfaceName(''), null);
  assert.equal(isMeshInterfaceName(null), null);
});

test('adding an overlay is a data change, not a code change', () => {
  assert.ok(Array.isArray(MESH_BACKENDS) && MESH_BACKENDS.length >= 1);
  for (const entry of MESH_BACKENDS) {
    assert.equal(typeof entry.backend, 'string');
    assert.ok(entry.pattern instanceof RegExp);
  }
  assert.ok(Object.isFrozen(MESH_BACKENDS), 'the table must not be mutable at runtime');
});

// ---- addresses -------------------------------------------------------------

test('bareAddress is the same one netScope admits with', () => {
  assert.equal(bareAddress('::ffff:10.101.0.5'), '10.101.0.5');
  assert.equal(bareAddress('[fd00::1]'), 'fd00::1');
  assert.equal(bareAddress('fe80::1%netmaker'), 'fe80::1');
  assert.equal(bareAddress(null), null);
});

test('parseCidr masks to the network address, however it was spelled', () => {
  assert.equal(parseCidr('10.101.0.5/24').base, '10.101.0.0');
  assert.equal(parseCidr('10.101.0.0/24').base, '10.101.0.0');
  assert.equal(parseCidr('10.101.0.255/24').base, '10.101.0.0');
  assert.equal(parseCidr('10.101.0.5/24').prefix, 24);
  assert.equal(parseCidr('10.101.0.5/32').base, '10.101.0.5');
  assert.equal(parseCidr('1.2.3.4/0').base, '0.0.0.0');
});

test('parseCidr refuses malformed input rather than guessing', () => {
  assert.equal(parseCidr(''), null);
  assert.equal(parseCidr(null), null);
  assert.equal(parseCidr('10.101.0.5'), null, 'no prefix is not a network');
  assert.equal(parseCidr('10.101.0.5/33'), null, 'a v4 prefix cannot exceed 32');
  assert.equal(parseCidr('10.101.0.5/-1'), null);
  assert.equal(parseCidr('999.1.1.1/24'), null);
  assert.equal(parseCidr('not-an-address/24'), null);
  assert.equal(parseCidr('fd00::1/129'), null, 'a v6 prefix cannot exceed 128');
});

test('inCidr places an address in its network, across families', () => {
  assert.equal(inCidr('10.101.0.7', '10.101.0.0/24'), true);
  assert.equal(inCidr('10.101.0.0', '10.101.0.0/24'), true, 'the network address is in the network');
  assert.equal(inCidr('10.101.0.255', '10.101.0.0/24'), true, 'so is the broadcast address');
  assert.equal(inCidr('10.102.0.7', '10.101.0.0/24'), false);
  assert.equal(inCidr('fd00::5', 'fd00::/8'), true);
  assert.equal(inCidr('fe80::5', 'fd00::/8'), false);
});

test('inCidr never matches across address families', () => {
  // A v4 address inside a v6 range would be a silent widening of trust.
  assert.equal(inCidr('10.101.0.7', 'fd00::/8'), false);
  assert.equal(inCidr('fd00::5', '10.101.0.0/24'), false);
  assert.equal(inCidr('10.101.0.7', 'garbage'), false);
  assert.equal(inCidr(null, '10.101.0.0/24'), false);
});

test('prefixFromNetmask reads the older interface shape', () => {
  assert.equal(prefixFromNetmask('255.255.255.0', 4), 24);
  assert.equal(prefixFromNetmask('255.255.0.0', 4), 16);
  assert.equal(prefixFromNetmask('255.255.255.255', 4), 32);
  assert.equal(prefixFromNetmask('0.0.0.0', 4), 0);
});

// ---- interfaces ------------------------------------------------------------

const IFACES = {
  lo: [{ address: '127.0.0.1', internal: true }],
  en0: [{ address: '10.101.0.9', cidr: '10.101.0.9/24', internal: false }],
  netmaker: [
    { address: '10.101.0.5', cidr: '10.101.0.5/24', internal: false },
    { address: '10.20.0.4', cidr: '10.20.0.4/16', internal: false },
  ],
  tailscale0: [{ address: '100.85.49.69', cidr: '100.85.49.69/32', internal: false }],
};

test('meshInterfaces takes only interfaces an overlay named', () => {
  const found = meshInterfaces(IFACES);
  assert.equal(found.length, 2, 'both addresses on the mesh interface, and nothing else');
  assert.ok(
    found.every((f) => f.iface === 'netmaker'),
    'en0 carries a 10.101.x address too — a range test alone would have taken it'
  );
  assert.deepEqual(
    found.map((f) => f.cidr),
    ['10.101.0.0/24', '10.20.0.0/16']
  );
});

test('one interface can carry several networks at once', () => {
  // This is the shape modern netclient actually produces, and the reason the
  // address rather than the interface name decides which network an address is
  // in. Resolving by name would collapse these two into one trust decision.
  const found = meshInterfaces(IFACES);
  const keys = new Set(found.map((f) => networkKey({ iface: f.iface, cidr: f.cidr })));
  assert.equal(keys.size, 2, 'two networks on one interface must key apart');
});

test('meshInterfaces skips internal entries and survives a thin interface list', () => {
  assert.deepEqual(meshInterfaces({ netmaker: [{ address: '10.1.0.1', internal: true }] }), []);
  assert.deepEqual(meshInterfaces(null), []);
  assert.deepEqual(meshInterfaces({}), []);
  // No cidr and no netmask: the address is still one we hold.
  const thin = meshInterfaces({ netmaker: [{ address: '10.1.0.1', internal: false }] });
  assert.equal(thin.length, 1);
  assert.equal(thin[0].cidr, null, 'an address we cannot place says so rather than inventing a range');
});

// ---- identity --------------------------------------------------------------

test('networkKey degrades in a fixed order', () => {
  assert.equal(networkKey({ server: 'nm.acme.com', network: 'office' }), 'nm.acme.com|office');
  assert.equal(networkKey({ network: 'office' }), '?|office');
  assert.equal(networkKey({ iface: 'netmaker', cidr: '10.101.0.5/24' }), 'iface:netmaker/10.101.0.0/24');
  assert.equal(networkKey({ iface: 'netmaker' }), 'iface:netmaker');
  assert.equal(networkKey({}), null);
});

test('networkKey is stable against the spellings of the same facts', () => {
  // A trust tick has to survive a restart, so the same network must not key two
  // ways depending on which address of it happened to be read.
  assert.equal(
    networkKey({ iface: 'netmaker', cidr: '10.101.0.5/24' }),
    networkKey({ iface: 'netmaker', cidr: '10.101.0.77/24' }),
    'any host address in the network yields one key'
  );
  assert.equal(
    networkKey({ server: 'NM.Acme.Com', network: 'office' }),
    networkKey({ server: 'nm.acme.com', network: 'office' }),
    'a server name is not case sensitive'
  );
  const once = networkKey({ server: 'nm.acme.com', network: 'office' });
  assert.equal(networkKey({ server: 'nm.acme.com', network: 'office' }), once, 'and it is idempotent');
});

test('resolveNetwork refuses to guess between overlapping networks', () => {
  const records = [
    { key: 'a', cidr: '10.101.0.0/24' },
    { key: 'b', cidr: '10.20.0.0/16' },
  ];
  assert.equal(resolveNetwork('10.101.0.5', 'netmaker', records).key, 'a');
  assert.equal(resolveNetwork('10.20.5.5', 'netmaker', records).key, 'b');
  assert.equal(resolveNetwork('192.168.1.5', 'netmaker', records), null, 'no match is not a match');

  // Netmaker cannot bridge overlapping CIDRs either. Picking whichever sorted
  // first would silently attach a trust decision to the wrong network.
  const overlapping = [
    { key: 'a', cidr: '10.0.0.0/8' },
    { key: 'b', cidr: '10.101.0.0/24' },
  ];
  assert.equal(resolveNetwork('10.101.0.5', 'netmaker', overlapping), null);
  assert.equal(resolveNetwork('10.101.0.5', 'netmaker', null), null);
});
