'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const {
  createNetmaker,
  networksFromInterfaces,
  toNetworkRecords,
  locateSelf,
  reconcile,
  migrateKeys,
  parseNetclientList,
  parseNetmakerNodes,
  hostOf,
  netclientNetworks,
  fetchNetmakerNodes,
  findNetclientBinary,
  resetNetclientBinary,
  NETCLIENT_PATHS,
  mergeNetworks,
  homeKeyOf,
  overlappingKeys,
} = require('../src/main/netmaker.js');

// Netmaker awareness, read from our own interfaces.
//
// This tier spawns nothing and sends nothing, which is what makes it the floor:
// it is the only source that works for a desktop user whose /etc/netclient is
// root-owned, and the only one that has already answered by the time the server
// starts accepting connections.

const OFFICE = 'iface:netmaker/10.101.0.0/24';
const SHARED = 'iface:netmaker/10.20.0.0/16';

const IFACES = {
  lo: [{ address: '127.0.0.1', internal: true }],
  en0: [{ address: '10.101.0.9', cidr: '10.101.0.9/24', internal: false }],
  netmaker: [
    { address: '10.101.0.5', cidr: '10.101.0.5/24', internal: false },
    { address: '10.20.0.4', cidr: '10.20.0.4/16', internal: false },
  ],
};

function harness({ ifaces = IFACES, stored = {} } = {}) {
  const settings = {
    enableNetmaker: false,
    netmakerNetworks: [],
    netmakerTrusted: [],
    netmakerHomeKey: null,
    ...stored,
  };
  const bus = new EventEmitter();
  const events = [];
  bus.on('netmaker-networks', (l) => events.push(['networks', l]));
  bus.on('netmaker-status', (s) => events.push(['status', s]));
  const nm = createNetmaker({
    config: { get: (k) => settings[k], set: (patch) => Object.assign(settings, patch) },
    bus,
    interfaces: () => ifaces,
  });
  return { nm, settings, events };
}

// ---- reading the interfaces ------------------------------------------------

test('one mesh interface carrying two networks yields two networks', () => {
  const found = networksFromInterfaces(IFACES);
  assert.deepEqual(
    found.map((r) => r.key),
    [OFFICE, SHARED],
    'this is the shape modern netclient produces, and they must not collapse into one'
  );
  assert.ok(
    found.every((r) => r.iface === 'netmaker'),
    'en0 also carries a 10.101.x address and must not be taken for a mesh'
  );
  assert.equal(found[0].discovered, 'interface');
  assert.equal(found[0].server, null, 'this tier cannot know the server');
  assert.equal(found[0].network, null, 'nor the network name');
});

test('a v4 and a v6 address in one network are one network', () => {
  const found = networksFromInterfaces({
    netmaker: [
      { address: '10.101.0.5', cidr: '10.101.0.5/24', internal: false },
      { address: '10.101.0.6', cidr: '10.101.0.6/24', internal: false },
    ],
  });
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].addresses, ['10.101.0.5', '10.101.0.6']);
});

test('no mesh interface is an empty answer, not a failure', () => {
  assert.deepEqual(networksFromInterfaces({ en0: [{ address: '192.168.1.5', internal: false }] }), []);
  assert.deepEqual(networksFromInterfaces({}), []);
});

// ---- merging ---------------------------------------------------------------

test('merging keeps the first sighting and the richer facts', () => {
  const before = [{ key: OFFICE, server: 'nm.acme.com', network: 'office', firstSeen: 1000 }];
  const observed = [{ key: OFFICE, server: null, network: null, cidr: '10.101.0.0/24' }];
  const [rec] = mergeNetworks(before, observed, 5000);

  assert.equal(rec.firstSeen, 1000, 'a network does not become new because it was re-read');
  assert.equal(rec.lastSeen, 5000);
  assert.equal(rec.server, 'nm.acme.com', 'a thinner sighting must not blank what we already knew');
  assert.equal(rec.network, 'office');
  assert.equal(rec.cidr, '10.101.0.0/24');
});

test('merging is ordered oldest first, so the list does not shuffle', () => {
  const merged = mergeNetworks(
    [
      { key: SHARED, firstSeen: 200 },
      { key: OFFICE, firstSeen: 100 },
    ],
    [{ key: OFFICE }, { key: SHARED }],
    900
  );
  assert.deepEqual(
    merged.map((r) => r.key),
    [OFFICE, SHARED]
  );
});

// ---- home ------------------------------------------------------------------

test('home is the network you were on first, unless you said otherwise', () => {
  const recs = [
    { key: OFFICE, firstSeen: 100 },
    { key: SHARED, firstSeen: 200 },
  ];
  assert.equal(homeKeyOf(recs), OFFICE, 'the one you had before you joined one to reach somebody');
  assert.equal(homeKeyOf(recs, SHARED), SHARED, 'a choice wins');
  assert.equal(homeKeyOf(recs, 'gone'), OFFICE, 'a choice naming a network that is not here is ignored');
  assert.equal(homeKeyOf([]), null);
});

// ---- overlap ---------------------------------------------------------------

test('overlapping ranges are reported, never resolved', () => {
  assert.deepEqual(
    overlappingKeys([
      { key: 'a', cidr: '10.0.0.0/8' },
      { key: 'b', cidr: '10.101.0.0/24' },
    ]).sort(),
    ['a', 'b']
  );
  assert.deepEqual(
    overlappingKeys([
      { key: 'a', cidr: '10.101.0.0/24' },
      { key: 'b', cidr: '10.20.0.0/16' },
    ]),
    []
  );
  assert.deepEqual(overlappingKeys([{ key: 'a', cidr: '10.0.0.0/8' }, { key: 'b' }]), []);
});

// ---- the service ------------------------------------------------------------

test('a poll reports the networks and says how it knows', () => {
  const h = harness();
  h.nm.refresh();

  const status = h.nm.status();
  assert.equal(status.ok, true);
  assert.equal(status.source, 'interfaces');
  assert.equal(status.reason, null, 'a mesh with no CLI is healthy, not broken');
  assert.equal(status.networks, 2);
  assert.deepEqual(
    h.nm.networks().map((r) => r.key),
    [OFFICE, SHARED]
  );
});

test('tier C runs even with the feature switched off', () => {
  // netScope has to be able to place an inbound connection whether or not we
  // are looking for peers.
  const h = harness({ stored: { enableNetmaker: false } });
  h.nm.refresh();
  assert.equal(h.nm.networks().length, 2);
});

test('no mesh at all reports no-networks rather than an error', () => {
  const h = harness({ ifaces: { en0: [{ address: '192.168.1.5', internal: false }] } });
  h.nm.refresh();
  assert.equal(h.nm.status().ok, true);
  assert.equal(h.nm.status().reason, 'no-networks');
  assert.equal(h.nm.status().source, null);
});

test('trust and home are shown but never stored on the record', () => {
  const h = harness({ stored: { netmakerTrusted: [OFFICE] } });
  h.nm.refresh();

  const office = h.nm.networks().find((r) => r.key === OFFICE);
  assert.equal(office.trusted, true);
  assert.equal(office.home, true);
  assert.equal(h.nm.status().trusted, 1);

  // The authority for trust is netmakerTrusted. Writing a copy into the record
  // would give a security decision two homes that could disagree.
  const persisted = h.settings.netmakerNetworks;
  assert.ok(persisted.length > 0);
  for (const rec of persisted) {
    assert.ok(!('trusted' in rec), 'trust is not a property of the network');
    assert.ok(!('home' in rec));
    assert.ok(!('overlapping' in rec));
  }
});

test('an unchanged interface list is not written back every poll', () => {
  // config.save() rewrites the whole file. `lastSeen` moves on every poll, so
  // comparing it would rewrite config.json every five seconds for as long as the
  // app is open.
  let writes = 0;
  const settings = { netmakerNetworks: [], netmakerTrusted: [], netmakerHomeKey: null };
  const nm = createNetmaker({
    config: {
      get: (k) => settings[k],
      set: (patch) => {
        writes += 1;
        Object.assign(settings, patch);
      },
    },
    bus: new EventEmitter(),
    interfaces: () => IFACES,
  });

  nm.refresh();
  assert.equal(writes, 1, 'the first sighting is worth writing');
  for (let i = 0; i < 5; i += 1) nm.refresh();
  assert.equal(writes, 1, 'and nothing after it, while the interfaces stand still');
});

test('a network appearing or disappearing is written back', () => {
  let writes = 0;
  let ifaces = IFACES;
  const settings = { netmakerNetworks: [], netmakerTrusted: [], netmakerHomeKey: null };
  const nm = createNetmaker({
    config: {
      get: (k) => settings[k],
      set: (patch) => {
        writes += 1;
        Object.assign(settings, patch);
      },
    },
    bus: new EventEmitter(),
    interfaces: () => ifaces,
  });

  nm.refresh();
  assert.equal(writes, 1);
  ifaces = { netmaker: [{ address: '10.101.0.5', cidr: '10.101.0.5/24', internal: false }] };
  nm.refresh();
  assert.equal(writes, 2, 'leaving a network is a real change');
  assert.equal(settings.netmakerNetworks.length, 1);
});

test('a thrown interface list narrows what we report rather than crashing', () => {
  const bus = new EventEmitter();
  const settings = { netmakerNetworks: [], netmakerTrusted: [], netmakerHomeKey: null };
  const nm = createNetmaker({
    config: { get: (k) => settings[k], set: (p) => Object.assign(settings, p) },
    bus,
    interfaces: () => {
      throw new Error('no interfaces today');
    },
  });
  assert.doesNotThrow(() => nm.refresh());
  assert.equal(nm.status().reason, 'no-networks');
});

test('start() and stop() leave no interval behind', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const h = harness();
  let polls = 0;
  h.events.length = 0;
  h.nm.start();
  polls = h.events.filter((e) => e[0] === 'status').length;
  assert.equal(polls, 1, 'polled once immediately');

  t.mock.timers.tick(5000);
  assert.equal(h.events.filter((e) => e[0] === 'status').length, 2);

  h.nm.stop();
  t.mock.timers.tick(20000);
  assert.equal(h.events.filter((e) => e[0] === 'status').length, 2, 'stopped means stopped');
});

test('ourAddresses lists every mesh address we hold', () => {
  const h = harness();
  h.nm.refresh();
  assert.deepEqual(
    h.nm
      .ourAddresses()
      .map((a) => a.address)
      .sort(),
    ['10.101.0.5', '10.20.0.4']
  );
});

// ---- tier A: netclient ------------------------------------------------------
//
// The direct equivalent of `tailscale status --json`, with the same two hazards:
// a CLI can print a log line before its JSON, and can emit a complete answer
// while exiting non-zero. Every field is optional on purpose — a netclient that
// renames one should cost us the field, not the whole mesh.

const NETCLIENT_ROWS = [
  {
    network: 'office',
    node_id: 'n1',
    connected: true,
    ipv4_addr: '10.101.0.5',
    peers: [
      { public_key: 'PK1', endpoint: '1.2.3.4:51820', allowed_ips: ['10.101.0.9/32'] },
      { public_key: 'GW', endpoint: '5.6.7.8:51820', allowed_ips: ['10.101.0.20/32', '10.102.0.0/24'] },
    ],
  },
];

test('host addresses become peers and wider prefixes become routes', () => {
  const [net] = parseNetclientList(NETCLIENT_ROWS);
  assert.deepEqual(
    net.peers.map((p) => p.address),
    ['10.101.0.9', '10.101.0.20'],
    'only /32 and /128 entries are somebody to talk to'
  );
  // A prefix wider than one host is a route an egress gateway advertises — the
  // second network bridged into this one. Discarding it would lose the only
  // evidence that an expanded mesh exists.
  assert.deepEqual(net.reachableRanges, [{ cidr: '10.102.0.0/24', viaPeer: 'GW' }]);
  assert.equal(net.network, 'office');
  assert.deepEqual(net.addresses, ['10.101.0.5']);
});

test('the list is read through noise and through either shape', () => {
  assert.equal(parseNetclientList(`log: starting\n${JSON.stringify(NETCLIENT_ROWS)}`).length, 1);
  assert.equal(parseNetclientList(`${JSON.stringify(NETCLIENT_ROWS)}\n# trailing`).length, 1);
  assert.equal(parseNetclientList({ networks: NETCLIENT_ROWS }).length, 1);
  assert.equal(parseNetclientList({ nodes: NETCLIENT_ROWS }).length, 1);
});

test('a list we cannot make sense of is empty, never a throw', () => {
  assert.deepEqual(parseNetclientList('not json at all'), []);
  assert.deepEqual(parseNetclientList(null), []);
  assert.deepEqual(parseNetclientList([]), []);
  assert.deepEqual(parseNetclientList([{ no: 'network name' }]), [], 'a row with no network names nothing');
  assert.deepEqual(parseNetclientList([{ network: 'x', peers: 'nonsense' }])[0].peers, []);
});

test('netclient rows key on the network, ready for a server to upgrade them', () => {
  const [rec] = toNetworkRecords(parseNetclientList(NETCLIENT_ROWS));
  assert.equal(rec.key, '?|office', 'no server known yet');
  assert.equal(rec.discovered, 'netclient');

  const [withServer] = toNetworkRecords(parseNetclientList(NETCLIENT_ROWS), 'nm.acme.com');
  assert.equal(withServer.key, 'nm.acme.com|office', 'and the real identity once one is');
});

test('a root-owned configuration is named as such, not reported as broken', async () => {
  // The case that makes the other tiers necessary: netclient is installed, runs,
  // and can tell a desktop user nothing.
  const answer = await netclientNetworks({
    run: async () => ({ permission: true, detail: 'permission denied' }),
  });
  assert.equal(answer.__error, 'permission');
});

test('netclient missing everywhere is not-installed, and is retried later', async () => {
  const answer = await netclientNetworks({ run: async () => ({ missing: true }) });
  assert.equal(answer.__error, 'not-installed');
});

test('netclient that runs but has joined nothing is a real answer', async () => {
  const answer = await netclientNetworks({ run: async () => ({ payload: [] }) });
  assert.equal(answer.__error, 'no-networks');
});

test('a configured binary path is tried first', async () => {
  const tried = [];
  await netclientNetworks({
    configured: '/opt/custom/netclient',
    run: async (bin) => {
      tried.push(bin);
      return { missing: true };
    },
  });
  assert.equal(tried[0], '/opt/custom/netclient');
});

// ---- the cascade -----------------------------------------------------------

function cascadeHarness({ rows = NETCLIENT_ROWS, enabled = true, home = null } = {}) {
  const settings = {
    enableNetmaker: enabled,
    netmakerNetworks: [],
    netmakerTrusted: [],
    netmakerHomeKey: home,
    netmakerBinaryPath: null,
  };
  const bus = new EventEmitter();
  const adopted = [];
  const emitted = [];
  bus.on('netmaker-peers', (l) => emitted.push(l));
  const nm = createNetmaker({
    config: { get: (k) => settings[k], set: (p) => Object.assign(settings, p) },
    bus,
    adopter: {
      adopt: async (ip, port, hint) => {
        adopted.push({ ip, hint });
        return null;
      },
      isBackedOff: () => false,
      noteAuthFailure() {},
    },
    interfaces: () => IFACES,
    runList: async () => ({ payload: rows }),
  });
  return { nm, adopted, emitted, settings };
}

// poll() kicks tier A off without waiting for it, so the interface floor is
// never delayed by a slow CLI. Tests have to let that land.
const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)));

test('a peer named by netclient is dialled through the shared funnel', async () => {
  const h = cascadeHarness();
  h.nm.refresh();
  await settle();

  assert.deepEqual(
    h.adopted.map((a) => a.ip).sort(),
    ['10.101.0.20', '10.101.0.9'],
    'every host address in the mesh is offered to the funnel'
  );
  const hint = h.adopted[0].hint;
  assert.equal(hint.source, 'netmaker');
  assert.equal(hint.network, 'office');
  assert.equal(hint.networkKey, '?|office');
  assert.equal(typeof hint.foreign, 'boolean');
});

test('the interface floor answers before the CLI does', () => {
  const h = cascadeHarness();
  h.nm.refresh();
  // Synchronously, before tier A has landed, we already know the networks we are
  // on — which is what netScope needs and what a slow CLI must not delay.
  assert.ok(h.nm.networks().length >= 2);
  assert.equal(h.nm.status().source, 'interfaces');
});

test('once netclient answers, the networks carry their real names', async () => {
  const h = cascadeHarness();
  h.nm.refresh();
  await settle();

  assert.ok(
    h.nm.networks().some((r) => r.network === 'office'),
    'a named network replaces the anonymous interface record'
  );
  assert.equal(h.nm.status().source, 'netclient');
  assert.equal(h.nm.status().peers, 2);
});

test('nothing is dialled while the feature is switched off', async () => {
  const h = cascadeHarness({ enabled: false });
  h.nm.refresh();
  await settle();

  assert.deepEqual(h.adopted, [], 'looking for peers is opt-in');
  assert.ok(h.nm.networks().length >= 2, 'but the interface floor still runs, for netScope');
});

test('a peer is marked by whether its network is the home one', async () => {
  // `foreign` is display only: it says which network a peer came in over, never
  // anything about who they are. Here `office` is explicitly the home network,
  // so nobody reached over it is foreign.
  const own = cascadeHarness({ home: '?|office' });
  own.nm.refresh();
  await settle();
  assert.ok(
    own.adopted.length > 0 && own.adopted.every((a) => a.hint.foreign === false),
    'reached over the home network'
  );

  // Name the other network as home and the same peers become foreign.
  const away = cascadeHarness({ home: 'iface:netmaker/10.20.0.0/16' });
  away.nm.refresh();
  await settle();
  assert.ok(
    away.adopted.length > 0 && away.adopted.every((a) => a.hint.foreign === true),
    'reached over a network that is not the home one'
  );
});

test('a hung netclient is never called twice at once', async () => {
  let calls = 0;
  const settings = {
    enableNetmaker: true,
    netmakerNetworks: [],
    netmakerTrusted: [],
    netmakerHomeKey: null,
    netmakerBinaryPath: null,
  };
  const nm = createNetmaker({
    config: { get: (k) => settings[k], set: (p) => Object.assign(settings, p) },
    bus: new EventEmitter(),
    interfaces: () => IFACES,
    runList: () => {
      calls += 1;
      return new Promise(() => {}); // never resolves
    },
  });

  nm.refresh();
  nm.refresh();
  nm.refresh();
  await settle();
  assert.equal(calls, 1, 'single-flight: a CLI that hangs must not stack up calls behind it');
});

// ---- reconciling the tiers --------------------------------------------------
//
// The tiers see different halves of one network and key them differently. If
// they stayed two records, netScope — which resolves an inbound address through
// the stored CIDR — would lose the half it needs the moment netclient answered.

test('two tiers describing one network become one record', () => {
  const fromIface = [
    {
      key: 'iface:netmaker/10.101.0.0/24',
      cidr: '10.101.0.0/24',
      iface: 'netmaker',
      addresses: ['10.101.0.5'],
    },
    { key: 'iface:netmaker/10.20.0.0/16', cidr: '10.20.0.0/16', iface: 'netmaker', addresses: ['10.20.0.4'] },
  ];
  const fromCli = [{ key: '?|office', network: 'office', addresses: ['10.101.0.5'], peers: [] }];

  const out = reconcile(fromIface, fromCli);
  assert.equal(out.length, 2, 'one merged network, and the one netclient did not mention');

  const office = out.find((r) => r.network === 'office');
  assert.equal(office.key, '?|office', 'the more specific key wins');
  assert.equal(office.cidr, '10.101.0.0/24', 'but the CIDR netScope reads survives');
  assert.equal(office.iface, 'netmaker');
  assert.equal(office.supersedes, 'iface:netmaker/10.101.0.0/24', 'and it records what it replaced');

  const other = out.find((r) => r.key === 'iface:netmaker/10.20.0.0/16');
  assert.ok(other, 'a network we can see but netclient did not name is still one we are on');
});

test('networks are matched on a shared address, not on hope', () => {
  const fromIface = [
    {
      key: 'iface:netmaker/10.101.0.0/24',
      cidr: '10.101.0.0/24',
      iface: 'netmaker',
      addresses: ['10.101.0.5'],
    },
  ];
  const fromCli = [{ key: '?|elsewhere', network: 'elsewhere', addresses: ['10.55.0.1'], peers: [] }];

  const out = reconcile(fromIface, fromCli);
  assert.equal(out.length, 2, 'nothing in common means two networks, not one guess');
  assert.equal(out.find((r) => r.network === 'elsewhere').supersedes, null);
});

test('a trust decision survives its network being renamed', () => {
  // The property that matters: a user who ticked a network before netclient
  // could name it must not silently lose inbound access when it answers.
  const records = [{ key: '?|office', supersedes: 'iface:netmaker/10.101.0.0/24' }];
  const moved = migrateKeys(records, {
    trusted: ['iface:netmaker/10.101.0.0/24'],
    homeKey: 'iface:netmaker/10.101.0.0/24',
  });

  assert.deepEqual(moved.netmakerTrusted, ['?|office']);
  assert.equal(moved.netmakerHomeKey, '?|office');
});

test('a rename never invents trust that was not there', () => {
  const records = [{ key: '?|office', supersedes: 'iface:netmaker/10.101.0.0/24' }];
  assert.equal(
    migrateKeys(records, { trusted: [], homeKey: null }),
    null,
    'an untrusted network cannot become trusted by being renamed'
  );
  assert.equal(
    migrateKeys(records, { trusted: ['something-else'], homeKey: null }),
    null,
    'and another network’s trust is not borrowed'
  );
  assert.equal(migrateKeys([{ key: 'a' }], { trusted: ['a'] }), null, 'nothing moved, nothing written');
});

// ---- tier B: a Netmaker server ---------------------------------------------
//
// The tier that makes cross-tenant work. netclient only knows the networks this
// machine has joined, so somebody on another Netmaker server is invisible to it;
// a read token for that server is what makes them appear.

const API_NODES = [
  { network: 'shared', address: '10.55.0.2/24', name: 'us', hostid: 'h-us' },
  { network: 'shared', address: '10.55.0.3/24', name: 'their-laptop', hostid: 'h-them' },
  { network: 'office', address: '10.101.0.9/24', egressgatewayranges: ['10.102.0.0/24'] },
];

test('a node list is read through any of the envelopes Netmaker has used', () => {
  for (const payload of [API_NODES, { Response: API_NODES }, { data: API_NODES }, { nodes: API_NODES }]) {
    assert.equal(parseNetmakerNodes(payload).length, 2, 'two networks, however the list was wrapped');
  }
  assert.deepEqual(parseNetmakerNodes(null), []);
  assert.deepEqual(parseNetmakerNodes({ unexpected: true }), []);
  assert.deepEqual(parseNetmakerNodes([{ no: 'network' }]), []);
});

test('nodes are grouped by network, and egress ranges are kept', () => {
  const out = parseNetmakerNodes(API_NODES);
  const shared = out.find((r) => r.network === 'shared');
  assert.deepEqual(
    shared.peers.map((p) => p.address),
    ['10.55.0.2', '10.55.0.3']
  );
  assert.equal(shared.discovered, 'api', 'and it says where it came from');

  const office = out.find((r) => r.network === 'office');
  assert.deepEqual(office.reachableRanges, [{ cidr: '10.102.0.0/24', viaPeer: '10.101.0.9' }]);
});

test('a server list does not say which node is us, so we work it out', () => {
  // Without this the record has no address to be matched on, reconcile cannot
  // join it to the interface record carrying the CIDR, and netScope loses the
  // half it needs to admit an inbound connection.
  const [shared] = parseNetmakerNodes(API_NODES).filter((r) => r.network === 'shared');
  assert.deepEqual(shared.addresses, [], 'the server told us nothing about which node is ours');

  const [located] = locateSelf([shared], ['10.55.0.2']);
  assert.deepEqual(located.addresses, ['10.55.0.2'], 'an address of ours that it listed is ours');
  assert.equal(located.ourAddress, '10.55.0.2');
  assert.deepEqual(
    located.peers.map((p) => p.address),
    ['10.55.0.3'],
    'and we are taken out of the list of people to dial'
  );
});

test('a network with none of our addresses in it is left alone', () => {
  const [shared] = parseNetmakerNodes(API_NODES).filter((r) => r.network === 'shared');
  const [untouched] = locateSelf([shared], ['192.168.1.5']);
  assert.deepEqual(untouched.addresses, [], 'no guessing which node might be us');
  assert.equal(untouched.peers.length, 2);
});

test('a server names the tenant half of a network key', () => {
  assert.equal(hostOf('https://api.nm.acme.com'), 'api.nm.acme.com');
  assert.equal(hostOf('https://api.nm.acme.com:8443/x'), 'api.nm.acme.com:8443');
  assert.equal(hostOf('NOT A URL'), null, 'and a bad one names nothing rather than throwing');

  const [rec] = toNetworkRecords(parseNetmakerNodes(API_NODES), 'api.nm.acme.com');
  assert.equal(rec.key, 'api.nm.acme.com|shared', 'the real identity, server and network');
  assert.equal(rec.discovered, 'api', 'provenance is preserved, not assumed to be netclient');
});

test('a token that is refused is reported as refused, not as a dead server', async () => {
  // The two need different fixes, so they must not read the same in Settings.
  const settings = {
    enableNetmaker: true,
    netmakerNetworks: [],
    netmakerTrusted: [],
    netmakerHomeKey: null,
    netmakerBinaryPath: null,
    netmakerServers: [{ id: 's1', apiUrl: 'https://nm.example' }],
    netmakerApiTokens: { s1: { mode: 'env', name: 'NM_TEST_TOKEN' } },
  };
  process.env.NM_TEST_TOKEN = 'tok';
  const nm = createNetmaker({
    config: { get: (k) => settings[k], set: (p) => Object.assign(settings, p) },
    bus: new EventEmitter(),
    interfaces: () => IFACES,
    runList: async () => ({ payload: [] }),
    fetchNodes: async () => ({ __error: 'unauthorised' }),
  });

  nm.refresh();
  await settle();
  assert.deepEqual(nm.status().servers, [{ id: 's1', reason: 'unauthorised', detail: null }]);
  delete process.env.NM_TEST_TOKEN;
});

test('a server with no token is named as such rather than silently skipped', async () => {
  const settings = {
    enableNetmaker: true,
    netmakerNetworks: [],
    netmakerTrusted: [],
    netmakerHomeKey: null,
    netmakerBinaryPath: null,
    netmakerServers: [{ id: 's1', apiUrl: 'https://nm.example' }],
    netmakerApiTokens: {},
  };
  const nm = createNetmaker({
    config: { get: (k) => settings[k], set: (p) => Object.assign(settings, p) },
    bus: new EventEmitter(),
    interfaces: () => IFACES,
    runList: async () => ({ payload: [] }),
    fetchNodes: async () => {
      throw new Error('must not be called without a token');
    },
  });

  nm.refresh();
  await settle();
  assert.deepEqual(nm.status().servers, [{ id: 's1', reason: 'no-token', detail: null }]);
});

test('a peer only a second server knows about is found and tagged', async () => {
  // The cross-tenant case end to end: this machine is on `shared` via its own
  // interface, netclient cannot name it, and the other tenant's server can.
  const ifaces = { netmaker: [{ address: '10.55.0.2', cidr: '10.55.0.2/24', internal: false }] };
  const settings = {
    enableNetmaker: true,
    netmakerNetworks: [],
    netmakerTrusted: [],
    netmakerHomeKey: null,
    netmakerBinaryPath: null,
    netmakerServers: [{ id: 's1', apiUrl: 'https://nm.partner.io' }],
    netmakerApiTokens: { s1: { mode: 'env', name: 'NM_X' } },
  };
  process.env.NM_X = 'tok';
  const adopted = [];
  const nm = createNetmaker({
    config: { get: (k) => settings[k], set: (p) => Object.assign(settings, p) },
    bus: new EventEmitter(),
    adopter: {
      adopt: async (ip, port, hint) => {
        adopted.push({ ip, hint });
        return null;
      },
      isBackedOff: () => false,
      noteAuthFailure() {},
    },
    interfaces: () => ifaces,
    runList: async () => ({ payload: [] }),
    fetchNodes: async () => ({
      payload: [
        { network: 'shared', address: '10.55.0.2/24', name: 'us' },
        { network: 'shared', address: '10.55.0.3/24', name: 'them' },
      ],
    }),
  });

  nm.refresh();
  await settle();

  assert.deepEqual(
    adopted.map((a) => a.ip),
    ['10.55.0.3'],
    'the other person is dialled, and we are not dialled by ourselves'
  );
  assert.equal(adopted[0].hint.networkKey, 'nm.partner.io|shared');
  assert.equal(adopted[0].hint.networkServer, 'nm.partner.io');
  assert.equal(adopted[0].hint.network, 'shared');

  const rec = nm.networks().find((r) => r.network === 'shared');
  assert.equal(rec.cidr, '10.55.0.0/24', 'reconciled with the interface, so netScope can still admit it');
  delete process.env.NM_X;
});

// ---- finding netclient ------------------------------------------------------
//
// The same trap discovery.js documents for the Tailscale CLI: a GUI-launched app
// does not inherit the shell's PATH, so a bare execFile('netclient') fails with
// ENOENT and the mesh silently never returns a peer.

test('the binary is looked for where netclient actually installs', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const paths = NETCLIENT_PATHS[platform];
    assert.ok(Array.isArray(paths) && paths.length, `${platform} should have candidates`);
    assert.ok(
      paths.every((p) => p.includes('netclient')),
      'every candidate names the binary'
    );
  }
  assert.ok(
    NETCLIENT_PATHS.win32.some((p) => p.endsWith('.exe')),
    'and on Windows it is an .exe'
  );
});

test('a configured path is taken as given, and cached lookups can be re-run', () => {
  assert.equal(findNetclientBinary('/opt/custom/netclient'), '/opt/custom/netclient');
  // Falls back to PATH when nothing known exists, which is correct in a terminal
  // and the only option for an install we do not know about.
  resetNetclientBinary();
  const found = findNetclientBinary();
  assert.ok(typeof found === 'string' && found.includes('netclient'));
  resetNetclientBinary();
});

// ---- talking to a server ----------------------------------------------------

test('a server that is not a server is reported, not thrown', async () => {
  assert.equal((await fetchNetmakerNodes({ apiUrl: 'not a url', token: 't' })).__error, 'api-unreachable');
  assert.equal((await fetchNetmakerNodes({ apiUrl: '', token: 't' })).__error, 'api-unreachable');
});

test('a real server is read, and its answers are told apart', async () => {
  // The injected fake elsewhere proves the cascade; this proves the request
  // itself — that the bearer header goes out and each reply is read correctly.
  const http = require('node:http');
  let sawAuth = null;
  const server = http.createServer((req, res) => {
    sawAuth = req.headers.authorization;
    if (req.url === '/api/nodes') {
      if (sawAuth !== 'Bearer good') {
        res.writeHead(401);
        return res.end('no');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify([{ network: 'shared', address: '10.55.0.3/24' }]));
    }
    res.writeHead(500);
    res.end('boom');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const apiUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const ok = await fetchNetmakerNodes({ apiUrl, token: 'good' });
    assert.equal(sawAuth, 'Bearer good', 'the token travels as a bearer header');
    assert.deepEqual(
      parseNetmakerNodes(ok.payload).map((r) => r.network),
      ['shared']
    );

    const refused = await fetchNetmakerNodes({ apiUrl, token: 'wrong' });
    assert.equal(refused.__error, 'unauthorised', 'a refused token is not a dead server');
  } finally {
    server.close();
  }
});

test('a server that is not listening is unreachable, with a reason', async () => {
  const answer = await fetchNetmakerNodes({ apiUrl: 'http://127.0.0.1:1', token: 't', timeout: 1500 });
  assert.equal(answer.__error, 'api-unreachable');
  assert.equal(typeof answer.detail, 'string', 'and it says what went wrong');
});

test('a server answering with something that is not JSON is not a crash', async () => {
  const http = require('node:http');
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>login page</html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const answer = await fetchNetmakerNodes({
      apiUrl: `http://127.0.0.1:${server.address().port}`,
      token: 't',
    });
    assert.equal(answer.__error, 'api-unreachable');
    assert.match(answer.detail, /JSON/);
  } finally {
    server.close();
  }
});
