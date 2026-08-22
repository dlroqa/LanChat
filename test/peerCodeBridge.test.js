'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

// The cross-tenant flow, driven through the real ipc handlers.
//
// The codec is pinned in test/peerCode.test.js. What is left is everything that
// only exists once the handlers are wired: a code built from this machine's own
// key and addresses, a code redeemed into the manual-peer list, and — the part
// that actually matters — what happens when the peer that turns up does not
// match the fingerprint their code promised.
//
// ipc.js pulls in electron, so it is stubbed the way test/configBridge.test.js
// does it: ipcMain.handle records the handlers the renderer would call.
const handlers = new Map();
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  return r === 'electron' ? 'pc-estub' : orig.call(this, r, ...a);
};
require.cache['pc-estub'] = {
  id: 'pc-estub',
  filename: 'pc-estub',
  loaded: true,
  exports: {
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    dialog: { showOpenDialog: async () => ({ canceled: true }) },
    shell: {},
    safeStorage: { isEncryptionAvailable: () => false },
  },
};

const { Config } = require('../src/main/config.js');
const { createIpc } = require('../src/main/ipc.js');
const { decodePeerCode, encodePeerCode } = require('../src/main/peerCode.js');

const FP_SELF = 'A1B2-C3D4-E5F6-0718-2938-4A5B';
const FP_THEM = 'B2C3-D4E5-F607-1829-3849-5A6B';
const FP_IMPOSTOR = 'CCCC-DDDD-EEEE-FFFF-0000-1111';
const THEIR_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

// authProto.fingerprint() is what the listener compares against, so the stub pin
// store holds real keys and the test derives the expected value the same way.
const { fingerprint } = require('../src/main/authProto.js');
const crypto = require('node:crypto');
function keyWithFingerprint() {
  // Any real ed25519 public key; we read its fingerprint rather than inventing one.
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'jwk' }).x;
  return { key: raw, fp: fingerprint(raw) };
}

function bridge({ networks = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-pc-'));
  const config = new Config(dir, '9.9.9');
  const bus = new EventEmitter();
  const events = [];
  const pinned = new Map();
  handlers.clear();

  createIpc({
    config,
    getIdentity: () => ({ id: config.get('id'), displayName: 'Tester', hostname: 'test' }),
    hub: { presenceList: () => [], emitPresence: () => {} },
    bus,
    store: { append: () => {}, list: () => [] },
    fileSender: { send: async () => ({}) },
    discovery: { peers: () => [], refresh: () => {} },
    updater: null,
    linkStats: null,
    pip: null,
    agentHub: { list: () => [], on: () => {} },
    outbox: { enqueue: () => {}, pendingCount: () => 0, counts: () => ({}) },
    deviceKey: { fingerprint: () => FP_SELF, publicKey: () => 'PUB', mode: () => 'plain' },
    pins: {
      get: (id) => pinned.get(id) || null,
      markVerified: (id, v) => pinned.set(id, { ...(pinned.get(id) || {}), verified: v }),
      list: () => [],
    },
    netScope: { refresh: () => {}, reachability: () => ({}) },
    netmaker: {
      status: () => ({ ok: true }),
      probeOnce: async () => ({ ok: true, source: 'interfaces', networks: networks.length }),
      networks: () => networks,
      ourAddresses: () => networks.map((n) => ({ address: n.ourAddress, key: n.key, network: n.network })),
      refresh: () => {},
    },
    userDataDir: dir,
    downloadsDir: path.join(dir, 'dl'),
    getWindow: () => ({
      isDestroyed: () => false,
      webContents: { send: (_c, evt) => events.push(evt) },
    }),
    revealWindow: () => {},
    applyLoginItem: () => {},
    onUnread: () => {},
  });

  const call = (channel, arg) => handlers.get(channel)(null, arg);
  return { config, call, bus, events, pinned, dir };
}

const MESH = [{ key: 'nm.partner.io|shared', network: 'shared', ourAddress: '10.55.0.2' }];

// ---- making a code ---------------------------------------------------------

test('a code is built from this machine’s own key and mesh address', () => {
  const { call, config } = bridge({ networks: MESH });
  const res = call('lanchat:createPeerCode', {});

  assert.equal(res.ok, true);
  const decoded = decodePeerCode(res.code);
  assert.equal(decoded.id, config.get('id'), 'it is this device');
  assert.equal(decoded.fp, FP_SELF, 'and this device’s key');
  assert.deepEqual(decoded.addrs, [{ addr: '10.55.0.2', port: 47100, net: 'shared', server: null }]);
});

test('with no mesh address there is no code, and it says why', () => {
  const { call } = bridge({ networks: [] });
  const res = call('lanchat:createPeerCode', {});
  assert.equal(res.ok, false);
  assert.match(res.error, /Netmaker network/);
});

// ---- redeeming one ---------------------------------------------------------

// Built directly rather than through a second bridge: `handlers` is module
// level, so standing another one up would re-register the channels onto a
// different Config and the assertions below would be reading the wrong one.
function theirCode(fp = FP_THEM) {
  return encodePeerCode({
    id: THEIR_ID,
    fingerprint: fp,
    name: 'Them',
    addrs: [{ addr: '10.55.0.3', port: 47100, net: 'shared' }],
  });
}

test('redeeming a code adds them as a manual peer, with what it promised', () => {
  const { call, config } = bridge({ networks: MESH });
  const res = call('lanchat:redeemPeerCode', { code: theirCode() });

  assert.equal(res.ok, true);
  assert.equal(res.peer.id, THEIR_ID);

  const [entry] = config.get('manualPeers');
  assert.equal(entry.address, '10.55.0.3');
  assert.equal(entry.peerId, THEIR_ID);
  assert.equal(entry.fingerprint, FP_THEM, 'the promise, kept so the handshake can be checked against it');
  assert.equal(entry.label, 'Them');
});

test('redeeming the same code twice does not list them twice', () => {
  const { call, config } = bridge({ networks: MESH });
  const code = theirCode();
  call('lanchat:redeemPeerCode', { code });
  const second = call('lanchat:redeemPeerCode', { code });
  assert.equal(second.added, 0);
  assert.equal(config.get('manualPeers').length, 1);
});

test('rubbish, and our own code, are refused', () => {
  const { call, config } = bridge({ networks: MESH });
  assert.equal(call('lanchat:redeemPeerCode', { code: 'nonsense' }).ok, false);
  assert.equal(call('lanchat:redeemPeerCode', {}).ok, false);

  const mine = call('lanchat:createPeerCode', {}).code;
  const own = call('lanchat:redeemPeerCode', { code: mine });
  assert.equal(own.ok, false, 'adding yourself is a mistake worth naming');
  assert.match(own.error, /own code/);
  assert.deepEqual(config.get('manualPeers'), [], 'and nothing was written');
});

// ---- taking one away -------------------------------------------------------

test('a manual peer can finally be removed', () => {
  // The list only ever grew before this, and removing an entry *closes* an
  // inbound door — netScope reads it as consent to accept from that address.
  const { call, config } = bridge({ networks: MESH });
  call('lanchat:redeemPeerCode', { code: theirCode() });
  assert.equal(config.get('manualPeers').length, 1);

  const kept = call('lanchat:removeManualPeer', { address: '10.55.0.3', port: 47100 });
  assert.deepEqual(kept, []);
  assert.deepEqual(config.get('manualPeers'), []);
});

test('removing by address alone takes every port for it', () => {
  const { call, config } = bridge({ networks: MESH });
  config.set({
    manualPeers: [
      { address: '10.55.0.3', port: 47100 },
      { address: '10.55.0.3', port: 47999 },
      { address: '10.55.0.9', port: 47100 },
    ],
  });
  call('lanchat:removeManualPeer', { address: '10.55.0.3' });
  assert.deepEqual(
    config.get('manualPeers').map((r) => r.address),
    ['10.55.0.9']
  );
});

// ---- the check that makes first use falsifiable ----------------------------

test('a peer whose key matches their code is marked verified', () => {
  const { call, bus, events, pinned } = bridge({ networks: MESH });
  const them = keyWithFingerprint();
  call('lanchat:redeemPeerCode', {
    code: encodePeerCode({
      id: THEIR_ID,
      fingerprint: them.fp,
      name: 'Them',
      addrs: [{ addr: '10.55.0.3', port: 47100 }],
    }),
  });

  pinned.set(THEIR_ID, { key: them.key });
  bus.emit('peer-hello', { peerId: THEIR_ID });

  assert.equal(pinned.get(THEIR_ID).verified, true, 'evidence, not an assumption: it came out of band');
  assert.ok(events.some((e) => e.type === 'peer-code-verified'));
  assert.ok(!events.some((e) => e.type === 'peer-code-mismatch'));
});

test('a peer whose key does not match is reported, and nothing else', () => {
  // The safe-looking action here is the dangerous one. A mismatch must never
  // repin and never forget — it is surfaced and left for a person to decide.
  const { call, bus, events, pinned } = bridge({ networks: MESH });
  const impostor = keyWithFingerprint();
  call('lanchat:redeemPeerCode', {
    code: encodePeerCode({
      id: THEIR_ID,
      fingerprint: FP_IMPOSTOR,
      name: 'Them',
      addrs: [{ addr: '10.55.0.3', port: 47100 }],
    }),
  });

  pinned.set(THEIR_ID, { key: impostor.key });
  bus.emit('peer-hello', { peerId: THEIR_ID });

  assert.equal(pinned.get(THEIR_ID).verified, undefined, 'never marked verified');
  const alarm = events.find((e) => e.type === 'peer-code-mismatch');
  assert.ok(alarm, 'and it is not silent');
  assert.equal(alarm.payload.expected, FP_IMPOSTOR);
  assert.equal(alarm.payload.actual, impostor.fp);
});

test('a peer nobody handed a code for is left entirely alone', () => {
  const { bus, events, pinned } = bridge({ networks: MESH });
  const someone = keyWithFingerprint();
  pinned.set('other-peer', { key: someone.key });

  bus.emit('peer-hello', { peerId: 'other-peer' });
  assert.equal(pinned.get('other-peer').verified, undefined, 'ordinary trust on first use is untouched');
  assert.ok(!events.some((e) => e.type === 'peer-code-verified' || e.type === 'peer-code-mismatch'));
});

// ---- the two remaining channels --------------------------------------------

test('probing asks the service to look now', () => {
  const { call } = bridge({ networks: MESH });
  const res = call('lanchat:probeNetmaker');
  assert.ok(res && typeof res.then === 'function', 'it answers with a promise, as Settings awaits it');
  return res.then((r) => assert.equal(r.ok, true));
});

test('naming a home network is display only, and clearable', () => {
  const { call, config } = bridge({ networks: MESH });
  call('lanchat:setNetmakerHome', { key: 'nm.partner.io|shared' });
  assert.equal(config.get('netmakerHomeKey'), 'nm.partner.io|shared');

  call('lanchat:setNetmakerHome', { key: null });
  assert.equal(config.get('netmakerHomeKey'), null);

  // It decides what the UI calls a peer, never what the machine accepts.
  assert.deepEqual(config.get('netmakerTrusted'), [], 'naming a home network trusts nothing');
});
