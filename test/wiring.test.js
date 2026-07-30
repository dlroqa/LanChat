'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// main.js, actually run.
//
// It is the one file where every service is constructed and handed to every
// other, and until now nothing loaded it — `find` over the suite showed
// main.js and tray.js as the only src/main modules no test touched. Which means
// a name typed wrong in the wiring would compile, lint, pass 400 tests, and then
// fail the first time a person launched the app.
//
// That mattered here more than usual: this change added five services to that
// function (the device key, the pin store, the network scope, the grant table,
// and the discovery back-reference the scope reads through) and threaded them
// into three constructors. So the wiring gets a test, even though the thing it
// is testing is mostly `const x = createX(...)`.

// Electron, reduced to the parts main.js touches. Same stubbing technique as
// agentshare.test.js, which patches the module resolver rather than the loader.
function stubElectron(userDataDir) {
  const app = {
    getPath: (k) => (k === 'userData' ? userDataDir : path.join(userDataDir, k)),
    getVersion: () => '0.0.0-test',
    setName: () => {},
    setPath: () => {},
    // Never resolves: the test calls startServices() itself rather than waiting
    // for a lifecycle that has no window behind it.
    whenReady: () => new Promise(() => {}),
    on: () => {},
    requestSingleInstanceLock: () => true,
    setLoginItemSettings: () => {},
    quit: () => {},
  };
  function FakeWindow() {
    return {
      on: () => {},
      once: () => {},
      loadFile: () => {},
      loadURL: () => {},
      isDestroyed: () => false,
      webContents: { send: () => {}, setWindowOpenHandler: () => {}, on: () => {} },
    };
  }
  FakeWindow.getAllWindows = () => [];
  return {
    app,
    BrowserWindow: FakeWindow,
    session: { defaultSession: { setPermissionRequestHandler: () => {} } },
    // The case the plain-file key path exists for, and the one CI runs in.
    safeStorage: { isEncryptionAvailable: () => false },
    shell: { openExternal: () => {} },
    ipcMain: { handle: () => {} },
    dialog: {},
    Menu: { buildFromTemplate: () => ({}) },
    Tray: function Tray() {
      return { setToolTip: () => {}, setContextMenu: () => {}, on: () => {}, destroy: () => {} };
    },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true, resize: () => ({}) }) },
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    powerMonitor: { on: () => {} },
  };
}

function loadMain(userDataDir) {
  const original = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    return request === 'electron' ? 'electron-stub' : original.call(this, request, ...rest);
  };
  require.cache['electron-stub'] = {
    id: 'electron-stub',
    filename: 'electron-stub',
    loaded: true,
    exports: stubElectron(userDataDir),
  };
  const mainPath = require.resolve('../src/main/main.js');
  delete require.cache[mainPath];
  const main = require(mainPath);
  return { main, restore: () => (Module._resolveFilename = original) };
}

test('every service main.js constructs is wired and reachable', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-wiring-'));
  // Port 0 lets the OS pick, so this never collides with the socket suites
  // running alongside it.
  process.env.LANCHAT_PORT = '0';
  process.env.LANCHAT_DISCOVERY_PORT = '0';

  const { main, restore } = loadMain(dir);
  t.after(() => {
    const s = main.getServices();
    if (s) {
      s.discovery.stop();
      s.linkStats.stop();
      s.server.stop();
      s.outbox.stop();
      s.hub.close();
      s.agentHub.stopAll();
    }
    restore();
    delete process.env.LANCHAT_PORT;
    delete process.env.LANCHAT_DISCOVERY_PORT;
  });

  await main.startServices();
  const s = main.getServices();
  assert.ok(s, 'startServices should publish its services');

  // The five this change added, each actually constructed rather than merely
  // named in an argument list.
  assert.ok(s.deviceKey && s.deviceKey.publicKey(), 'a device key exists and has a public half');
  assert.match(s.deviceKey.fingerprint(), /^[0-9A-F]{4}(-[0-9A-F]{4}){5}$/);
  assert.equal(s.deviceKey.mode(), 'plain', 'no keychain in the suite, so the file path is used');
  assert.ok(s.pins && Array.isArray(s.pins.list()), 'a pin store exists and can be read');
  assert.ok(s.netScope && typeof s.netScope.allowInbound === 'function');
  assert.ok(s.grants && typeof s.grants.issue === 'function');

  // The key and the pins landed on disk, only readable by us.
  assert.ok(fs.existsSync(s.deviceKey.file));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(s.deviceKey.file).mode & 0o777, 0o600);
  }

  // The hub can authenticate: it was handed the key and the pins, not just built.
  assert.ok(s.hub.deviceKey && s.hub.pins, 'the hub can run a handshake');
  assert.equal(s.hub.deviceKey.publicKey(), s.deviceKey.publicKey());

  // netScope reads manual peers through the discovery reference that is assigned
  // *after* it is constructed — the one piece of this wiring with an ordering
  // hazard, and the one a smoke test earns its keep on.
  s.config.set({ manualPeers: ['203.0.113.9:47100'] });
  assert.ok(
    s.netScope.allowInbound('198.51.100.4', '203.0.113.9'),
    'a hand-added peer is accepted even with LAN accept off'
  );
  assert.ok(!s.netScope.allowInbound('198.51.100.4', '203.0.113.10'), 'and nobody else is');
});

test('the unauthenticated card main.js serves carries the key it will prove', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-wiring-card-'));
  process.env.LANCHAT_PORT = '0';
  process.env.LANCHAT_DISCOVERY_PORT = '0';

  const { main, restore } = loadMain(dir);
  t.after(() => {
    const s = main.getServices();
    if (s) {
      s.discovery.stop();
      s.linkStats.stop();
      s.server.stop();
      s.outbox.stop();
      s.hub.close();
      s.agentHub.stopAll();
    }
    restore();
    delete process.env.LANCHAT_PORT;
    delete process.env.LANCHAT_DISCOVERY_PORT;
  });

  await main.startServices();
  const s = main.getServices();

  // If getPublicCard were not threaded into createServer, /lanchat/whoami would
  // fall back to a card with no key at all and every peer would fail to dial —
  // which is precisely the sort of thing that only shows up when a human runs it.
  const { buildPublicCard } = require('../src/main/identity.js');
  const card = buildPublicCard(s.config, s.deviceKey);
  assert.equal(card.publicKey, s.deviceKey.publicKey());
  assert.ok(card.proto >= 2);
  assert.ok(!('avatar' in card) && !('hostname' in card));
});
