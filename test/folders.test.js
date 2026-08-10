'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

// Folders: where sessions are filed.
//
// The claim this whole feature rests on is that **a folder holds session ids and
// a session record knows nothing about folders** — so filing one writes to
// sessionFolders.json and to nothing else. Two things follow that could not be
// had the other way round, and both are tested below by doing them rather than
// by reading the code: filing a session does not bump it up the recently-used
// list, and a trashed session comes back to the exact slot it left.
//
// The decisive test reads the bytes of sessions.json before and after every
// folder operation there is. If that file ever moves, the design has quietly
// become the one this design was chosen over.
//
// Driven through the IPC channels rather than the registry, because the wiring
// is half of what is new: a handler that forgets to publish is exactly the
// mistake that would ship.
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
    dialog: {
      showOpenDialog: async () => ({ canceled: true }),
      showSaveDialog: async () => ({ canceled: true }),
    },
    shell: {},
    safeStorage: { isEncryptionAvailable: () => false },
  },
};

const { Config } = require('../src/main/config.js');
const { buildIdentity } = require('../src/main/identity.js');
const { createDeviceKey } = require('../src/main/deviceKey.js');
const { createPins } = require('../src/main/pins.js');
const { PeerHub } = require('../src/main/peers.js');
const { MessageStore } = require('../src/main/store.js');
const { createAgentHub } = require('../src/main/agents/index.js');
const { createIpc } = require('../src/main/ipc.js');

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`sealed:${s}`),
  decryptString: (b) => b.toString().replace(/^sealed:/, ''),
};

// An agent that answers anything put to it, so a session under test can be given
// a real conversation to lose.
function echoTransports() {
  return {
    http: ({ id, name }) => ({
      id,
      name,
      kind: 'stub',
      start: async () => ({ detail: 'ready' }),
      send: async ({ text }, h) => h.onDone?.({ text: `echo:${text}` }),
      stop: async () => {},
    }),
  };
}

function makeNode(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lanchat-folders-${name}-`));
  const config = new Config(dir);
  config.set({ displayName: name, servicePort: 0 });
  const bus = new EventEmitter();
  const getIdentity = () => buildIdentity(config);
  const deviceKey = createDeviceKey({ userDataDir: dir });
  const pins = createPins({ userDataDir: dir });
  const hub = new PeerHub({ getIdentity, bus, deviceKey, pins });
  const store = new MessageStore(dir);
  const agentHub = createAgentHub({
    userDataDir: dir,
    hub,
    bus,
    store,
    safeStorage: fakeSafeStorage,
    transports: echoTransports(),
  });

  const events = [];
  handlers.clear();
  createIpc({
    config,
    getIdentity,
    hub,
    bus,
    store,
    fileSender: { send: async () => ({}) },
    discovery: { peers: () => [], refresh: () => {} },
    updater: null,
    linkStats: null,
    pip: null,
    agentHub,
    outbox: { enqueue: () => {}, pendingCount: () => 0, counts: () => ({}) },
    userDataDir: dir,
    downloadsDir: path.join(dir, 'dl'),
    getWindow: () => ({
      isDestroyed: () => false,
      webContents: { send: (_c, payload) => events.push(payload) },
    }),
    revealWindow: () => {},
    applyLoginItem: () => {},
    onUnread: () => {},
  });
  const own = new Map(handlers);
  const call = (channel, arg) => own.get(channel)(null, arg);
  return { dir, store, agentHub, call, events };
}

const sessionsFile = (n) => path.join(n.dir, 'sessions.json');
const foldersFile = (n) => path.join(n.dir, 'sessionFolders.json');
const readBytes = (p) => (fs.existsSync(p) ? fs.readFileSync(p) : null);
const ids = (list) => list.map((x) => x.id);
const titles = (list) => list.map((s) => s.title);

const newSession = (n, title) => n.call('lanchat:createSession', { title });
const newFolder = (n, name) => n.call('lanchat:createFolder', { name });
const listFolders = (n) => n.call('lanchat:listFolders');
const listSessions = (n) => n.call('lanchat:listSessions');

// ------------------------------------------------------------------- the file

test('no folders means no file at all', () => {
  const n = makeNode('none');
  assert.deepEqual(listFolders(n), []);
  assert.equal(fs.existsSync(foldersFile(n)), false, 'a feature nobody used writes nothing');
});

// The decisive one. Every other property here is a consequence of this: if a
// folder operation ever writes sessions.json, membership has moved onto the
// session record and the recently-used order, the trash slot and the
// downgrade-safety all go with it.
test('no folder operation ever writes sessions.json', () => {
  const n = makeNode('untouched');
  const a = newSession(n, 'alpha');
  const b = newSession(n, 'beta');
  const before = readBytes(sessionsFile(n));
  assert.ok(before, 'there is a sessions file to leave alone');

  const f1 = newFolder(n, 'Work');
  const f2 = newFolder(n, 'Home');
  n.call('lanchat:placeSession', { id: a.id, folderId: f1.id, index: null });
  n.call('lanchat:placeSession', { id: b.id, folderId: f1.id, index: 0 });
  n.call('lanchat:placeSession', { id: b.id, folderId: f2.id, index: null });
  n.call('lanchat:renameFolder', { id: f1.id, name: 'Work things' });
  n.call('lanchat:moveFolder', { id: f1.id, toIndex: 1 });
  n.call('lanchat:placeSession', { id: a.id, folderId: null, index: null });
  n.call('lanchat:deleteFolder', { id: f2.id });

  assert.deepEqual(readBytes(sessionsFile(n)), before, 'byte for byte what it was');
});

test('a folder file survives being hand-edited into nonsense', () => {
  const n = makeNode('garbage');
  newFolder(n, 'Real');
  for (const junk of ['not json at all', '{"not":"an array"}', '[{"id":"nope"},null,7]', '[]']) {
    fs.writeFileSync(foldersFile(n), junk, 'utf8');
    const again = makeNode('garbage-reload');
    fs.writeFileSync(foldersFile(again), junk, 'utf8');
    assert.doesNotThrow(() => listFolders(again), `on ${junk}`);
  }
});

// ------------------------------------------------------------------ membership

test('a session is in one folder at a time, and filing it does not move it up the list', () => {
  const n = makeNode('one-folder');
  const older = newSession(n, 'older');
  newSession(n, 'newer');
  // Whatever order the list is in, filing one must not change it — the whole
  // reason membership is not a field on the session record. Captured rather
  // than written down, because two sessions made in the same millisecond tie on
  // `updatedAt` and the tie-break is not what is being tested.
  const before = titles(listSessions(n));

  const f1 = newFolder(n, 'One');
  const f2 = newFolder(n, 'Two');
  n.call('lanchat:placeSession', { id: older.id, folderId: f1.id, index: null });
  assert.deepEqual(titles(listSessions(n)), before, 'tidying is not using');

  n.call('lanchat:placeSession', { id: older.id, folderId: f2.id, index: null });
  const folders = listFolders(n);
  const one = folders.find((f) => f.id === f1.id);
  const two = folders.find((f) => f.id === f2.id);
  assert.deepEqual(one.sessionIds, [], 'out of the first');
  assert.deepEqual(two.sessionIds, [older.id], 'and into the second, in one move');
});

test('a session lands where it was dropped, including at the top', () => {
  const n = makeNode('order');
  const a = newSession(n, 'a');
  const b = newSession(n, 'b');
  const c = newSession(n, 'c');
  const f = newFolder(n, 'F');
  for (const s of [a, b, c]) n.call('lanchat:placeSession', { id: s.id, folderId: f.id, index: null });
  assert.deepEqual(listFolders(n)[0].sessionIds, [a.id, b.id, c.id], 'appended in the order filed');

  n.call('lanchat:placeSession', { id: c.id, folderId: f.id, index: 0 });
  assert.deepEqual(listFolders(n)[0].sessionIds, [c.id, a.id, b.id]);
  // Removed before it is inserted, which is what makes a downward move land
  // where it was aimed rather than one slot short.
  n.call('lanchat:placeSession', { id: c.id, folderId: f.id, index: 2 });
  assert.deepEqual(listFolders(n)[0].sessionIds, [a.id, b.id, c.id]);
});

test('taking a session out of a folder leaves it loose', () => {
  const n = makeNode('loose');
  const a = newSession(n, 'a');
  const f = newFolder(n, 'F');
  n.call('lanchat:placeSession', { id: a.id, folderId: f.id, index: null });
  n.call('lanchat:placeSession', { id: a.id, folderId: null, index: null });
  assert.deepEqual(listFolders(n)[0].sessionIds, []);
  assert.deepEqual(titles(listSessions(n)), ['a'], 'and it is still a session');
});

// ------------------------------------------------------------ trash and purge

test('a trashed session keeps its slot, and gets it back', async () => {
  const n = makeNode('trash-slot');
  const a = newSession(n, 'a');
  const b = newSession(n, 'b');
  const c = newSession(n, 'c');
  const f = newFolder(n, 'F');
  for (const s of [a, b, c]) n.call('lanchat:placeSession', { id: s.id, folderId: f.id, index: null });

  n.call('lanchat:deleteSession', { id: b.id });
  assert.deepEqual(
    listFolders(n)[0].sessionIds,
    [a.id, b.id, c.id],
    'the id waits where it was — the row simply stops being drawn'
  );
  // As a set: sessions made in the same millisecond tie on `updatedAt`, and
  // which way the tie falls is not what this is about.
  assert.deepEqual(titles(listSessions(n)).sort(), ['a', 'c'], 'and it is out of the live list');

  n.call('lanchat:restoreSession', { id: b.id });
  assert.deepEqual(listFolders(n)[0].sessionIds, [a.id, b.id, c.id], 'back between the two it was between');
});

test('a session deleted for good is swept out of its folder', () => {
  const n = makeNode('purge');
  const a = newSession(n, 'a');
  const b = newSession(n, 'b');
  const f = newFolder(n, 'F');
  for (const s of [a, b]) n.call('lanchat:placeSession', { id: s.id, folderId: f.id, index: null });

  n.call('lanchat:deleteSession', { id: a.id });
  n.call('lanchat:purgeSession', { id: a.id });
  assert.deepEqual(listFolders(n)[0].sessionIds, [b.id], 'an id with nothing behind it would wait for ever');

  n.call('lanchat:deleteSession', { id: b.id });
  n.call('lanchat:purgeAllSessions');
  assert.deepEqual(listFolders(n)[0].sessionIds, [], 'and the bulk door sweeps too');
});

test('a session in the Trash cannot be filed', () => {
  const n = makeNode('no-filing-the-dead');
  const a = newSession(n, 'a');
  const f = newFolder(n, 'F');
  n.call('lanchat:deleteSession', { id: a.id });
  assert.deepEqual(n.call('lanchat:placeSession', { id: a.id, folderId: f.id, index: null }), { ok: false });
  assert.deepEqual(listFolders(n)[0].sessionIds, [], 'a row that would not draw is not filed');
});

// ------------------------------------------------------------------ the folder

test('a folder is named, renamed, and never nameless', () => {
  const n = makeNode('names');
  assert.equal(newFolder(n, '   ').name, 'New Folder', 'nothing is not a name');
  assert.equal(newFolder(n, 'a\n  b').name, 'a b', 'flattened, so a row stays one line');
  assert.equal(newFolder(n, 'x'.repeat(200)).name.length, 60, 'and bounded');
  const f = newFolder(n, 'Before');
  assert.equal(n.call('lanchat:renameFolder', { id: f.id, name: 'After' }).name, 'After');
  assert.equal(n.call('lanchat:renameFolder', { id: f.id, name: '  ' }).name, 'New Folder');
});

test('a new folder goes on top, and folders move where they are put', () => {
  const n = makeNode('folder-order');
  const first = newFolder(n, 'first');
  const second = newFolder(n, 'second');
  assert.deepEqual(ids(listFolders(n)), [second.id, first.id], 'newest where the eye already is');
  assert.deepEqual(n.call('lanchat:moveFolder', { id: second.id, toIndex: 1 }), { ok: true });
  assert.deepEqual(ids(listFolders(n)), [first.id, second.id]);
  assert.deepEqual(n.call('lanchat:moveFolder', { id: second.id, toIndex: 1 }), { ok: false }, 'no-op');
});

test('deleting a folder keeps every session in it', () => {
  const n = makeNode('delete-folder');
  const a = newSession(n, 'a');
  const before = listSessions(n).find((s) => s.id === a.id).updatedAt;
  const f = newFolder(n, 'F');
  n.call('lanchat:placeSession', { id: a.id, folderId: f.id, index: null });

  assert.deepEqual(n.call('lanchat:deleteFolder', { id: f.id }), { ok: true });
  assert.deepEqual(listFolders(n), []);
  const after = listSessions(n).find((s) => s.id === a.id);
  assert.ok(after, 'the session is still here');
  assert.equal(after.updatedAt, before, 'and nothing about it was touched to make it loose');
});

// --------------------------------------------------------------- the wiring

test('every folder change publishes all three lists together', () => {
  const n = makeNode('publish');
  const a = newSession(n, 'a');
  const f = newFolder(n, 'F');

  const kindsAfter = (fn) => {
    n.events.length = 0;
    fn();
    return n.events.map((e) => e.type);
  };

  for (const [what, fn] of [
    ['place', () => n.call('lanchat:placeSession', { id: a.id, folderId: f.id, index: null })],
    ['rename', () => n.call('lanchat:renameFolder', { id: f.id, name: 'G' })],
    ['create', () => newFolder(n, 'H')],
    ['delete', () => n.call('lanchat:deleteFolder', { id: f.id })],
  ]) {
    const kinds = kindsAfter(fn);
    for (const list of ['sessions', 'trash', 'folders']) {
      assert.ok(kinds.includes(list), `${what} publishes ${list}`);
    }
  }
});

// Six new channels is the moment to notice there was never a test for this: a
// preload method naming a channel nobody registered fails at the click, in the
// renderer, with nothing in the log that says which one.
test('every channel the preload calls is a channel main answers', () => {
  // For the side effect, not the node: makeNode builds the whole IPC surface,
  // and what is being read below is the set of channels it registered.
  makeNode('parity');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'preload.js'), 'utf8');
  const called = [...preload.matchAll(/invoke\(\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(called.length > 40, `found ${called.length} channels — the regex should be finding them all`);
  const registered = new Set(handlers.keys());
  const orphans = [...new Set(called)].filter((c) => !registered.has(c));
  assert.deepEqual(orphans, [], 'the preload offers something main does not answer');
});
