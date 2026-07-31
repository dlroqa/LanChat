'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

// The settings the window shows, and the settings on disk, are the same
// settings.
//
// This is the seam that once quietly broke: publicConfig() named a key in its
// returned object that its destructure above never read, so every config call
// threw a ReferenceError before it could answer. Nothing crashed visibly —
// getState, getConfig and setConfig all just rejected, the window kept running
// on the seed defaults it starts with, and a saved preference (agent music, in
// the report) went to disk and never came back. So these tests call the real ipc
// handlers rather than publicConfig directly: a reply that never arrives is the
// failure, and only the handler can show it.
//
// ipc.js pulls in electron, so it is stubbed the same way test/agentshare.js
// does it — ipcMain.handle records the handlers the renderer would call.
const handlers = new Map();
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  return r === 'electron' ? 'estub' : orig.call(this, r, ...a);
};
require.cache['estub'] = {
  id: 'estub',
  filename: 'estub',
  loaded: true,
  exports: {
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    dialog: { showOpenDialog: async () => ({ canceled: true }) },
    shell: {},
    safeStorage: { isEncryptionAvailable: () => false },
  },
};

const { Config, DEFAULTS } = require('../src/main/config.js');
const { createIpc, SETTABLE_KEYS, PUBLIC_KEYS } = require('../src/main/ipc.js');

// Only the config channels are under test, so everything else is a stub that
// answers just enough for createIpc to finish wiring itself up.
function bridge(appVersion = '9.9.9') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-config-'));
  const config = new Config(dir, appVersion);
  handlers.clear();
  createIpc({
    config,
    getIdentity: () => ({ id: config.get('id'), displayName: 'Tester', hostname: 'test' }),
    hub: { presenceList: () => [], emitPresence: () => {} },
    bus: new EventEmitter(),
    store: { append: () => {}, list: () => [] },
    fileSender: { send: async () => ({}) },
    discovery: { peers: () => [], refresh: () => {} },
    updater: null,
    linkStats: null,
    pip: null,
    agentHub: { list: () => [], on: () => {} },
    outbox: { enqueue: () => {}, pendingCount: () => 0, counts: () => ({}) },
    userDataDir: dir,
    downloadsDir: path.join(dir, 'dl'),
    getWindow: () => null,
    revealWindow: () => {},
    applyLoginItem: () => {},
    onUnread: () => {},
  });
  const call = (channel, arg) => handlers.get(channel)(null, arg);
  const onDisk = () => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  return { config, call, onDisk };
}

test('the window can read the config it was started with', () => {
  const { call } = bridge();
  const state = call('lanchat:getState');
  const cfg = call('lanchat:getConfig');
  // Not a truthiness check: the bug returned nothing at all, and a window with
  // no config falls back to seed defaults that look like deliberate settings.
  for (const key of PUBLIC_KEYS) {
    assert.ok(key in cfg, `getConfig is missing ${key}`);
    assert.ok(key in state.config, `getState is missing ${key}`);
  }
  // The feature the report came in about: music arrives switched on, and the
  // window is told so.
  assert.equal(cfg.agentMusicEnabled, true);
});

test('a saved preference comes back, it does not just land on disk', () => {
  const { call, onDisk } = bridge();

  const off = call('lanchat:setConfig', { agentMusicEnabled: false });
  assert.equal(off.agentMusicEnabled, false);
  assert.equal(onDisk().agentMusicEnabled, false);

  const on = call('lanchat:setConfig', { agentMusicEnabled: true, agentMusicVolume: 0.8 });
  assert.equal(on.agentMusicEnabled, true);
  assert.equal(on.agentMusicVolume, 0.8);
  assert.equal(onDisk().agentMusicEnabled, true);

  // And it is still there on the next read, which is what the toggle renders.
  assert.equal(call('lanchat:getConfig').agentMusicEnabled, true);
});

test('a preference the renderer can write is a preference it can see', () => {
  for (const key of SETTABLE_KEYS) {
    assert.ok(PUBLIC_KEYS.includes(key), `${key} is settable but never sent back`);
  }
  // A key on either list that config.js does not define is a dead key: the
  // window would show undefined for it and saving it would write a setting
  // nothing reads.
  for (const key of PUBLIC_KEYS) {
    assert.ok(key in DEFAULTS, `${key} is bridged to the renderer but has no default`);
  }
});

test('acceptLan is shown to the renderer but not settable in bulk', () => {
  const { call, onDisk } = bridge();
  assert.equal(call('lanchat:getConfig').acceptLan, false);

  // Its own channel is the only way in — a bulk save of unrelated preferences
  // must not decide who may open a socket to this machine.
  const ignored = call('lanchat:setConfig', { acceptLan: true, ringtoneVolume: 0.3 });
  assert.equal(ignored.acceptLan, false);
  assert.equal(ignored.ringtoneVolume, 0.3);
  assert.equal(onDisk().acceptLan, false);

  assert.equal(call('lanchat:setAcceptLan', { on: true }).acceptLan, true);
  assert.equal(onDisk().acceptLan, true);
});
