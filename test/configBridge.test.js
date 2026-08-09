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

test('the dictation preferences round-trip', () => {
  const { call, onDisk } = bridge();

  const saved = call('lanchat:setConfig', { dictationEnabled: false, dictationPort: 47999 });
  assert.equal(saved.dictationEnabled, false);
  assert.equal(saved.dictationPort, 47999);
  assert.equal(onDisk().dictationPort, 47999);

  // The settings a retired version wrote are not settable back into the file by
  // a renderer that still remembers them: they are off the allowlist, and the
  // prune in config.js removes them on load. See configRetired.test.js.
  const ignored = call('lanchat:setConfig', { dictationCliPath: '/opt/homebrew/bin/x' });
  assert.equal(ignored.dictationCliPath, undefined, 'not bridged to the renderer at all');
  assert.equal(onDisk().dictationCliPath, undefined);
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

test('the speech engine is shown to the renderer but not settable in bulk', () => {
  const { call, onDisk } = bridge();

  // Reading a discussion aloud arrives switched on, in the window's own voice.
  // Sending the agents' words to Google does not: that is a separate switch, and
  // it starts off.
  assert.equal(call('lanchat:getConfig').agentSpeechEnabled, true);
  assert.equal(call('lanchat:getConfig').agentSpeechEngine, 'local');

  // Its own channel is the only way in — for the same reason as acceptLan
  // above, and a stronger one: a bulk save of unrelated preferences must not
  // decide whether the agents' words leave this machine.
  const ignored = call('lanchat:setConfig', { agentSpeechEngine: 'gemini', agentSpeechVolume: 0.4 });
  assert.equal(ignored.agentSpeechEngine, 'local');
  assert.equal(ignored.agentSpeechVolume, 0.4, 'the ordinary preferences still save');
  assert.equal(onDisk().agentSpeechEngine, 'local');

  assert.equal(call('lanchat:setSpeechEngine', { engine: 'gemini' }).agentSpeechEngine, 'gemini');
  assert.equal(onDisk().agentSpeechEngine, 'gemini');

  // Anything that is not 'gemini' means the local voice, so a malformed call
  // cannot leave the setting in a state nothing understands.
  assert.equal(call('lanchat:setSpeechEngine', { engine: 'nonsense' }).agentSpeechEngine, 'local');
  assert.equal(call('lanchat:setSpeechEngine', {}).agentSpeechEngine, 'local');
});

test('no API key is ever handed to the renderer', () => {
  const { call } = bridge();

  // Not in the bridge at all — not settable, and not shown. Neither the record
  // that holds them nor the single field an older version used.
  for (const key of ['agentSpeechKeys', 'agentSpeechKey']) {
    assert.ok(!PUBLIC_KEYS.includes(key), `${key} must not be public`);
    assert.ok(!SETTABLE_KEYS.includes(key), `${key} must not be settable`);
    assert.equal(call('lanchat:getConfig')[key], undefined);
  }

  // What Settings is told instead: which providers have a key, which engine is
  // chosen, and which one can really speak. Never a key.
  const status = call('lanchat:speechStatus');
  assert.deepEqual(Object.keys(status).sort(), ['active', 'engine', 'keys', 'model']);
  assert.deepEqual(status.keys, { gemini: false, xai: false });
  assert.equal(status.active, 'local');

  // This stub reports no secure storage, which is the case where a key must be
  // refused rather than written to disk in the clear.
  const saved = call('lanchat:setSpeechKey', { provider: 'gemini', key: 'a-real-key' });
  assert.equal(saved.ok, false);
  assert.equal(saved.speech.keys.gemini, false);

  // And a provider nobody has heard of is refused rather than stored under its
  // own name, which would be a key saved where nothing will ever read it.
  const bogus = call('lanchat:setSpeechKey', { provider: 'not-a-provider', key: 'x' });
  assert.equal(bogus.ok, false);
});

test('the engine accepts every provider, and nothing else', () => {
  const { call, onDisk } = bridge();

  for (const engine of ['gemini', 'xai', 'local']) {
    assert.equal(call('lanchat:setSpeechEngine', { engine }).agentSpeechEngine, engine);
    assert.equal(onDisk().agentSpeechEngine, engine);
  }

  // Anything else means the window's own voices. That is what makes the
  // dropdown's selection true: it can only ever show a state main really is in.
  for (const engine of ['nonsense', '', null, undefined, 42]) {
    assert.equal(call('lanchat:setSpeechEngine', { engine }).agentSpeechEngine, 'local');
  }
  assert.equal(call('lanchat:setSpeechEngine', {}).agentSpeechEngine, 'local');
});

test('a key saved before there were two providers is not lost', () => {
  // The migration that matters: 0.8.10 and earlier kept one sealed key, which
  // was always Gemini's. Somebody has that on disk right now.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-migrate-'));
  const sealed = { mode: 'sealed', cipher: 'SEALED-BYTES' };
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ id: 'abc', agentSpeechEngine: 'gemini', agentSpeechKey: sealed })
  );

  const config = new Config(dir, '9.9.9');
  assert.deepEqual(config.get('agentSpeechKeys'), { gemini: sealed }, 'carried across intact');
  assert.equal(config.get('agentSpeechEngine'), 'gemini', 'and it is still the chosen engine');

  // The old field is gone from memory and from the file, so nothing reads it
  // again and no stale copy of a credential is left lying about.
  assert.ok(!('agentSpeechKey' in config.data));
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.ok(!('agentSpeechKey' in onDisk));
  assert.deepEqual(onDisk.agentSpeechKeys, { gemini: sealed });

  // Loading again is not a second migration.
  assert.deepEqual(new Config(dir, '9.9.9').get('agentSpeechKeys'), { gemini: sealed });

  fs.rmSync(dir, { recursive: true, force: true });
});

test('migrating never overwrites a key that is already there', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-migrate-'));
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({
      id: 'abc',
      agentSpeechKey: { mode: 'sealed', cipher: 'OLD' },
      agentSpeechKeys: { gemini: { mode: 'sealed', cipher: 'NEW' }, xai: { mode: 'sealed', cipher: 'X' } },
    })
  );

  const config = new Config(dir, '9.9.9');
  assert.equal(config.get('agentSpeechKeys').gemini.cipher, 'NEW', 'the newer key wins');
  assert.equal(config.get('agentSpeechKeys').xai.cipher, 'X', 'and the other is untouched');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('two configs do not share one key record', () => {
  // DEFAULTS is spread into each config's data, and a spread copies the
  // reference to a nested object — so without a copy of its own, a key saved in
  // one window would appear in every other config in the process.
  const a = new Config(fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-share-')), '9.9.9');
  const b = new Config(fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-share-')), '9.9.9');

  a.set({ agentSpeechKeys: { ...a.get('agentSpeechKeys'), xai: { mode: 'sealed', cipher: 'A' } } });

  assert.deepEqual(b.get('agentSpeechKeys'), {});
  assert.deepEqual(DEFAULTS.agentSpeechKeys, {}, 'and the defaults themselves are untouched');
});
