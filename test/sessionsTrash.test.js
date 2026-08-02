'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

// The Trash: where a deleted session waits until somebody puts it back or
// deletes it for good.
//
// The one thing worth proving here, and the one thing that cannot be proved by
// reading the code, is that **the transcript survives**. Before this existed,
// deleting a session called store.clear() and the conversation was gone; the
// whole feature is the claim that it no longer does. So the tests below do not
// stop at the record — they send real messages into a real MessageStore, delete
// the session, and then read the history back out after restoring it. A test
// that only checked `listTrash()` would pass just as happily against a build
// that still shredded the file on the way in.
//
// Driven through the IPC channels rather than the registry, because the wiring
// is half of what is new: a handler that forgets to publish, or a `remove` left
// pointing at the old hard delete, is exactly the mistake that would ship.
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
const { SessionRegistry } = require('../src/main/sessions/registry.js');

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lanchat-trash-${name}-`));
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

// A session with an agent it can ask and something already said in it.
async function seed(node, title) {
  const { agent } = await node.agentHub.add({ name: `${title}-agent`, kind: 'http', config: {} });
  const session = await node.call('lanchat:createSession', { title, agentId: agent.id });
  await node.call('lanchat:sendChat', { peerId: session.id, text: 'the question' });
  return { session, agent };
}

const ids = (list) => list.map((s) => s.id);

test('deleting a session moves it to the Trash and keeps every word of it', async () => {
  const n = makeNode('keep');
  const { session } = await seed(n, 'quakes');

  const before = n.call('lanchat:getHistory', session.id);
  assert.ok(before.length >= 1, 'the session should have something in it to lose');

  assert.deepStrictEqual(n.call('lanchat:deleteSession', { id: session.id }), { ok: true });

  // Out of the list, into the Trash — and nowhere in both.
  assert.ok(!ids(n.call('lanchat:listSessions')).includes(session.id));
  assert.deepStrictEqual(ids(n.call('lanchat:listTrash')), [session.id]);

  // The claim the whole feature rests on: the file is still there.
  assert.ok(fs.existsSync(n.store.fileFor(session.id)), 'the transcript must survive a delete');
  assert.deepStrictEqual(n.call('lanchat:getHistory', session.id), before);
});

test('a trashed session carries when it was deleted, and survives a restart', async () => {
  const n = makeNode('restart');
  const { session } = await seed(n, 'roads');
  const at = Date.now();
  n.call('lanchat:deleteSession', { id: session.id });

  const [trashed] = n.call('lanchat:listTrash');
  assert.ok(trashed.deletedAt >= at && trashed.deletedAt <= Date.now());

  // Read back off disk by a registry that has never seen this process's state:
  // `deletedAt` has to be written down, or a restart empties the Trash by
  // putting everything in it back.
  const fresh = new SessionRegistry(n.dir);
  assert.deepStrictEqual(ids(fresh.list()), []);
  assert.deepStrictEqual(ids(fresh.trashed()), [session.id]);
});

test('restoring puts the session back with its conversation and its counsel intact', async () => {
  const n = makeNode('restore');
  const { session, agent } = await seed(n, 'harbour');
  const before = n.call('lanchat:getHistory', session.id);
  n.call('lanchat:deleteSession', { id: session.id });

  const record = n.call('lanchat:restoreSession', { id: session.id });
  assert.strictEqual(record.id, session.id);
  assert.strictEqual(record.title, 'harbour');
  assert.deepStrictEqual(record.agentIds, [agent.id]);
  assert.strictEqual(record.deletedAt, undefined, 'a restored record must not still be marked deleted');

  assert.deepStrictEqual(ids(n.call('lanchat:listSessions')), [session.id]);
  assert.deepStrictEqual(n.call('lanchat:listTrash'), []);
  assert.deepStrictEqual(n.call('lanchat:getHistory', session.id), before);
});

test('a session in the Trash cannot be asked anything', async () => {
  const n = makeNode('refuse');
  const { session } = await seed(n, 'silent');
  const kept = n.call('lanchat:getHistory', session.id).length;
  n.call('lanchat:deleteSession', { id: session.id });

  const res = await n.call('lanchat:sendChat', { peerId: session.id, text: 'anyone there?' });
  assert.ok(res.rejected, 'a deleted session must refuse a question');
  assert.match(res.notice.text, /no longer exists/);
  // Refused rather than written down: the refusal must not add to a transcript
  // that is being kept exactly as it was left.
  assert.strictEqual(n.call('lanchat:getHistory', session.id).length, kept);

  // And it does not quietly come back to life by being asked.
  assert.deepStrictEqual(ids(n.call('lanchat:listTrash')), [session.id]);
  assert.deepStrictEqual(n.call('lanchat:listSessions'), []);
});

test('deleting for good is the step that takes the conversation with it', async () => {
  const n = makeNode('purge');
  const { session } = await seed(n, 'gone');
  n.call('lanchat:deleteSession', { id: session.id });

  assert.deepStrictEqual(n.call('lanchat:purgeSession', { id: session.id }), { ok: true });
  assert.deepStrictEqual(n.call('lanchat:listTrash'), []);
  assert.deepStrictEqual(n.call('lanchat:listSessions'), []);
  assert.ok(!fs.existsSync(n.store.fileFor(session.id)), 'purging must remove the transcript');
  // Twice is not an error, and not a second deletion either.
  assert.deepStrictEqual(n.call('lanchat:purgeSession', { id: session.id }), { ok: false });
});

test('a live session cannot be purged — only something already in the Trash', async () => {
  const n = makeNode('guard');
  const { session } = await seed(n, 'safe');

  assert.deepStrictEqual(n.call('lanchat:purgeSession', { id: session.id }), { ok: false });
  assert.deepStrictEqual(ids(n.call('lanchat:listSessions')), [session.id]);
  assert.ok(fs.existsSync(n.store.fileFor(session.id)));
});

test('Restore all and Delete all move everything in the Trash and nothing outside it', async () => {
  const n = makeNode('bulk');
  const a = await seed(n, 'one');
  const b = await seed(n, 'two');
  const live = await seed(n, 'three');
  n.call('lanchat:deleteSession', { id: a.session.id });
  n.call('lanchat:deleteSession', { id: b.session.id });

  assert.deepStrictEqual(n.call('lanchat:restoreAllSessions'), { ok: true, count: 2 });
  assert.deepStrictEqual(n.call('lanchat:listTrash'), []);
  assert.strictEqual(n.call('lanchat:listSessions').length, 3);
  // Nought is a fine answer, not a failure.
  assert.deepStrictEqual(n.call('lanchat:restoreAllSessions'), { ok: true, count: 0 });

  n.call('lanchat:deleteSession', { id: a.session.id });
  n.call('lanchat:deleteSession', { id: b.session.id });
  assert.deepStrictEqual(n.call('lanchat:purgeAllSessions'), { ok: true, count: 2 });
  assert.deepStrictEqual(n.call('lanchat:listTrash'), []);
  // The session that was never deleted is untouched by either sweep — including
  // its transcript, which is the thing Delete all could most easily overreach on.
  assert.deepStrictEqual(ids(n.call('lanchat:listSessions')), [live.session.id]);
  assert.ok(fs.existsSync(n.store.fileFor(live.session.id)));
  assert.ok(!fs.existsSync(n.store.fileFor(a.session.id)));
});

test('the window is told about both lists on every move', async () => {
  const n = makeNode('publish');
  const { session } = await seed(n, 'told');

  const since = (from) => n.events.slice(from).filter((e) => e.type === 'sessions' || e.type === 'trash');

  let mark = n.events.length;
  n.call('lanchat:deleteSession', { id: session.id });
  let sent = since(mark);
  assert.deepStrictEqual(
    sent.map((e) => e.type),
    ['sessions', 'trash'],
    'a delete must republish both lists, or the window shows the session in two places or in neither'
  );
  assert.deepStrictEqual(sent[0].payload, []);
  assert.deepStrictEqual(ids(sent[1].payload), [session.id]);

  mark = n.events.length;
  n.call('lanchat:restoreSession', { id: session.id });
  sent = since(mark);
  assert.deepStrictEqual(ids(sent[0].payload), [session.id]);
  assert.deepStrictEqual(sent[1].payload, []);
});

test('an agent removed while a session is in the Trash is gone from it when it comes back', async () => {
  const n = makeNode('unbind');
  const { session, agent } = await seed(n, 'orphan');
  n.call('lanchat:deleteSession', { id: session.id });

  await n.call('lanchat:removeAgent', { id: agent.id });
  const record = n.call('lanchat:restoreSession', { id: session.id });
  assert.deepStrictEqual(record.agentIds, [], 'a restored session must not claim an agent that is gone');
  assert.strictEqual(record.agentId, null);
});
