'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

// End-to-end for agent sharing, over real sockets between two processes' worth
// of wiring. The unit tests in agents.test.js drive the hub directly with stub
// transports; this exercises the parts they cannot reach — the wire frames, the
// ipc.js router that dispatches them, and the peer-side remote agent registry —
// because none of that is covered by driving the hub in isolation.
//
// ipc.js is the module under test as much as the agent code is, so electron is
// stubbed rather than avoided: `ipcMain.handle` records its handlers so the same
// functions the renderer calls can be invoked here.
const handlers = new Map();
let saveTo = null; // where the stubbed save dialog pretends the user chose
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
      // The save dialog is the user's choice of path; tests set it directly.
      showSaveDialog: async () => (saveTo ? { canceled: false, filePath: saveTo } : { canceled: true }),
    },
    shell: {},
    safeStorage: { isEncryptionAvailable: () => false },
  },
};

const { Config } = require('../src/main/config.js');
const { buildIdentity } = require('../src/main/identity.js');
const { PeerHub } = require('../src/main/peers.js');
const { createServer } = require('../src/main/server.js');
const { MessageStore } = require('../src/main/store.js');
const { createAgentHub } = require('../src/main/agents/index.js');
const { createIpc } = require('../src/main/ipc.js');

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`sealed:${s}`),
  decryptString: (b) => b.toString().replace(/^sealed:/, ''),
};

// Echoes the prompt back, so a reply arriving on the far side proves the whole
// path rather than the transport.
function echoTransports(log) {
  return {
    http: ({ id, name }) => ({
      id,
      name,
      kind: 'stub',
      start: async () => ({ detail: 'ready' }),
      send: async ({ text }, h) => {
        log.push(text);
        h.onDone?.({ text: `echo:${text}` });
      },
      stop: async () => {},
    }),
  };
}

function makeNode(name, port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lanchat-share-${name}-`));
  const config = new Config(dir);
  config.set({ displayName: name, servicePort: port });
  const bus = new EventEmitter();
  const getIdentity = () => buildIdentity(config);
  const hub = new PeerHub({ getIdentity, bus });
  const server = createServer({ config, getIdentity, hub, bus, downloadsDir: path.join(dir, 'dl') });
  const store = new MessageStore(dir);
  const log = [];
  const agentHub = createAgentHub({
    userDataDir: dir,
    hub,
    bus,
    store,
    safeStorage: fakeSafeStorage,
    transports: echoTransports(log),
  });

  // Each node gets its own ipc router. The handler map is shared and overwritten
  // by each createIpc call, so it must be snapshotted here — reading it lazily
  // would silently route one node's calls through another node's handlers.
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

  return { dir, config, bus, getIdentity, hub, server, store, agentHub, log, events, call, port };
}

function waitFor(fn, timeout = 5000, what = 'condition') {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const t = setInterval(() => {
      let v;
      try {
        v = fn();
      } catch {
        v = false;
      }
      if (v) {
        clearInterval(t);
        resolve(v);
      } else if (Date.now() - start > timeout) {
        clearInterval(t);
        reject(new Error(`timed out waiting for ${what}`));
      }
    }, 25);
  });
}

async function connect(from, to) {
  from.hub.connect(to.getIdentity().id, `127.0.0.1:${to.port}`);
  await waitFor(() => from.hub.isConnected(to.getIdentity().id), 5000, 'the socket to open');
  await waitFor(() => to.hub.isConnected(from.getIdentity().id), 5000, 'the reverse registration');
}

const remoteIdOn = (peer, ownerId, agentId) =>
  [...peer.hub.identities.keys()].find((k) => k.startsWith(`remote-agent:${ownerId}:${agentId}`));

test('a shared agent reaches a peer over the wire and its chat stays out of the human thread', async (t) => {
  const A = makeNode('owner', 47431);
  const aCall = A.call;
  const B = makeNode('peer', 47432);
  await A.server.start();
  await B.server.start();
  t.after(() => {
    A.hub.close();
    B.hub.close();
    A.server.stop();
    B.server.stop();
  });

  const idA = A.getIdentity().id;
  const idB = B.getIdentity().id;

  const { agent } = await A.agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
  await A.agentHub.setSharing(agent.id, { networkWide: true, directChat: true });

  await connect(A, B);

  // The advert crosses on handshake, so B learns about an agent it was never
  // configured with.
  const remoteId = await waitFor(() => remoteIdOn(B, idA, agent.id), 5000, "B to see A's agent");
  const card = B.hub.presenceList().find((p) => p.id === remoteId);
  assert.equal(card.kind, 'agent');
  assert.equal(card.remote, true);
  assert.equal(card.name, 'Hermes');
  assert.equal(card.online, true, 'and can be talked to');

  // B talks to it exactly as the renderer would — through the real ipc handler.
  B.call('lanchat:sendChat', { peerId: remoteId, text: 'what is the time' });

  await waitFor(() => A.log.length === 1, 5000, 'the request to reach the agent');
  assert.deepEqual(A.log, ['what is the time']);
  await waitFor(
    () => B.store.read(remoteId).some((m) => m.direction === 'in'),
    5000,
    'the answer to come back'
  );

  // The whole point of the feature: both sides keep the conversation in the
  // agent's own thread and leave the human chat untouched.
  assert.deepEqual(
    B.store.read(remoteId).map((m) => `${m.direction}:${m.text}`),
    ['out:what is the time', 'in:echo:what is the time']
  );
  assert.deepEqual(B.store.read(idA), [], "B's chat with A is untouched");

  const delegate = `${agent.id}#${idB}`;
  assert.deepEqual(
    A.store.read(delegate).map((m) => `${m.direction}:${m.text}`),
    ['in:what is the time', 'in:echo:what is the time'],
    'A sees the exchange filed under the delegate thread'
  );
  assert.deepEqual(A.store.read(idB), [], "A's chat with B is untouched");
  assert.deepEqual(A.store.read(agent.id), [], "and A's own agent thread is untouched");

  assert.ok(aCall);
});

test('a peer reaching the agent by @name lands in the same thread, not the human chat', async (t) => {
  const A = makeNode('owner2', 47433);
  const B = makeNode('peer2', 47434);
  await A.server.start();
  await B.server.start();
  t.after(() => {
    A.hub.close();
    B.hub.close();
    A.server.stop();
    B.server.stop();
  });

  const idA = A.getIdentity().id;
  const { agent } = await A.agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
  // Deliberately not shared for direct chat: it must still be reachable by name,
  // and using it is what reveals the contact.
  await A.agentHub.setSharing(agent.id, { networkWide: true, directChat: false });

  await connect(A, B);
  await waitFor(() => B.hub.presenceList().length > 0, 5000, 'B to see A');

  // B types the mention into its chat with A, as a user would.
  await waitFor(
    () => {
      B.call('lanchat:sendChat', { peerId: idA, text: '@Hermes ping' });
      return A.log.length > 0;
    },
    5000,
    'the mention to be recognised'
  );

  const remoteId = remoteIdOn(B, idA, agent.id);
  assert.ok(remoteId, 'using it revealed the contact even though direct chat was off');
  await waitFor(() => B.store.read(remoteId).some((m) => m.direction === 'in'), 5000, 'the answer');

  assert.deepEqual(B.store.read(idA), [], 'the mention never entered the chat with A');
  assert.ok(
    B.store.read(remoteId).some((m) => m.text === 'ping'),
    'it went to the agent thread with the prefix stripped'
  );
});

test('two peers take turns, and each is told where they stand', async (t) => {
  const A = makeNode('owner3', 47435);
  const B = makeNode('first', 47436);
  const C = makeNode('second', 47437);
  await A.server.start();
  await B.server.start();
  await C.server.start();
  t.after(() => {
    for (const n of [A, B, C]) {
      n.hub.close();
      n.server.stop();
    }
  });

  const idA = A.getIdentity().id;
  const { agent } = await A.agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
  await A.agentHub.setSharing(agent.id, { networkWide: true, directChat: true });

  await connect(A, B);
  await connect(A, C);

  const bRemote = await waitFor(() => remoteIdOn(B, idA, agent.id), 5000, 'B to see the agent');
  const cRemote = await waitFor(() => remoteIdOn(C, idA, agent.id), 5000, 'C to see the agent');

  // B spends its whole turn. The throttle enforces spacing between requests, so
  // this is paced rather than blasted — which is also how a person would use it.
  for (let i = 0; i < 5; i += 1) {
    B.call('lanchat:sendChat', { peerId: bRemote, text: `b${i}` });
    await waitFor(() => A.log.length === i + 1, 8000, `B's query ${i} to land`);
    await new Promise((r) => setTimeout(r, 3100));
  }
  assert.equal(A.log.length, 5, 'the holder gets a full quota');

  // C now asks and must be queued, not served.
  const before = A.log.length;
  C.call('lanchat:sendChat', { peerId: cRemote, text: 'my turn?' });
  await waitFor(
    () => C.hub.identities.get(cRemote)?.queueState,
    5000,
    'C to be told where it stands'
  );
  assert.equal(A.log.length, before, "C's request was not served while B held the turn");

  const cCard = C.hub.identities.get(cRemote);
  assert.equal(cCard.queueState, 'waiting');
  assert.equal(cCard.queuePosition, 1, 'and knows it is next');
  assert.equal(cCard.queueQuota, 5);

  // B is out of quota with C waiting, so the next attempt hands over.
  B.call('lanchat:sendChat', { peerId: bRemote, text: 'one more' });
  await waitFor(
    () => C.hub.identities.get(cRemote)?.queueState === 'active',
    8000,
    'the turn to pass to C'
  );
  assert.equal(A.log.length, before, "B's over-quota request was refused, not served");
  assert.equal(B.hub.identities.get(bRemote).queueState, 'waiting', 'and B is now queued');

  // C gets its own full quota, not the remainder of B's.
  assert.equal(C.hub.identities.get(cRemote).queueRemaining, 5);
  // Past the anti-flood interval, which is a separate mechanism from the quota.
  await new Promise((r) => setTimeout(r, 3100));
  C.call('lanchat:sendChat', { peerId: cRemote, text: 'hello at last' });
  await waitFor(() => A.log.includes('hello at last'), 8000, 'C to be served');
});

test('deleting a chat history removes it from disk, agent threads included', async (t) => {
  const A = makeNode('owner5', 47441);
  const B = makeNode('peer5', 47442);
  await A.server.start();
  await B.server.start();
  t.after(() => {
    A.hub.close();
    B.hub.close();
    A.server.stop();
    B.server.stop();
  });

  const idA = A.getIdentity().id;
  const idB = B.getIdentity().id;
  const { agent } = await A.agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
  await A.agentHub.setSharing(agent.id, { networkWide: true, directChat: true });
  await connect(A, B);

  const remoteId = await waitFor(() => remoteIdOn(B, idA, agent.id), 5000, 'B to see the agent');
  B.call('lanchat:sendChat', { peerId: remoteId, text: 'something private' });
  await waitFor(() => B.store.read(remoteId).some((m) => m.direction === 'in'), 5000, 'the answer');
  B.call('lanchat:sendChat', { peerId: idA, text: 'a human message' });

  assert.ok(B.store.read(remoteId).length >= 2);
  assert.equal(B.store.read(idA).length, 1);

  // Deleting one conversation must not touch the other.
  assert.deepEqual(B.call('lanchat:clearHistory', { peerId: remoteId }), { ok: true });
  assert.deepEqual(B.store.read(remoteId), [], 'the agent thread is gone');
  assert.equal(B.store.read(idA).length, 1, 'the human chat is untouched');

  // Gone from disk, not merely emptied in memory — a reload must not bring it
  // back, which is the whole point of "delete".
  const reread = new MessageStore(B.dir);
  assert.deepEqual(reread.read(remoteId), []);

  // The owner's own transcript of that conversation is separate and is theirs
  // to delete: one side clearing their copy does not clear the other's.
  const delegate = `${agent.id}#${idB}`;
  assert.ok(A.store.read(delegate).length >= 1, "the owner's copy is unaffected");
  assert.deepEqual(A.call('lanchat:clearHistory', { peerId: delegate }), { ok: true });
  assert.deepEqual(A.store.read(delegate), []);
});

test('a chat history saves as readable text, naming who said what', async (t) => {
  const A = makeNode('owner6', 47443);
  const B = makeNode('peer6', 47444);
  await A.server.start();
  await B.server.start();
  t.after(() => {
    saveTo = null;
    A.hub.close();
    B.hub.close();
    A.server.stop();
    B.server.stop();
  });

  const idA = A.getIdentity().id;
  const idB = B.getIdentity().id;
  const { agent } = await A.agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
  await A.agentHub.setSharing(agent.id, { networkWide: true, directChat: true });
  await connect(A, B);

  const remoteId = await waitFor(() => remoteIdOn(B, idA, agent.id), 5000, 'B to see the agent');
  B.call('lanchat:sendChat', { peerId: remoteId, text: 'what is the time' });
  await waitFor(() => B.store.read(remoteId).some((m) => m.direction === 'in'), 5000, 'the answer');

  // Nothing is written unless the user picks a file.
  saveTo = null;
  assert.deepEqual(await B.call('lanchat:exportHistory', { peerId: remoteId, name: 'Hermes' }), {
    ok: false,
    canceled: true,
  });

  saveTo = path.join(B.dir, 'export.txt');
  const res = await B.call('lanchat:exportHistory', { peerId: remoteId, name: 'Hermes' });
  assert.equal(res.ok, true);
  assert.equal(res.count, 2);

  const text = fs.readFileSync(saveTo, 'utf8');
  assert.match(text, /^Chat history with Hermes/, 'it says whose conversation it is');
  assert.match(text, /Exported .* from LanChat/);
  assert.match(text, /peer6: what is the time/, 'our own line is attributed to us');
  assert.match(text, /Hermes: echo:what is the time/, 'and theirs to them');
  assert.match(text, /\[\d{1,2}:\d{2}/, 'with timestamps');

  // An empty conversation is a no-op with an explanation, not an empty file.
  const empty = await A.call('lanchat:exportHistory', { peerId: idB, name: 'peer6' });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /nothing in this conversation/i);
});

test('withdrawing a shared agent removes it from the peer roster', async (t) => {
  const A = makeNode('owner4', 47438);
  const B = makeNode('peer4', 47439);
  await A.server.start();
  await B.server.start();
  t.after(() => {
    A.hub.close();
    B.hub.close();
    A.server.stop();
    B.server.stop();
  });

  const idA = A.getIdentity().id;
  const { agent } = await A.agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
  await A.agentHub.setSharing(agent.id, { networkWide: true, directChat: true });

  await connect(A, B);
  const remoteId = await waitFor(() => remoteIdOn(B, idA, agent.id), 5000, 'B to see the agent');

  // Switching sharing off has to reach the far side; access is re-checked per
  // message anyway, but a stale contact that silently fails is worse than none.
  await A.agentHub.setSharing(agent.id, { networkWide: false });
  await waitFor(() => !B.hub.identities.has(remoteId), 5000, 'the contact to disappear');

  assert.equal(B.hub.presenceList().find((p) => p.id === remoteId), undefined);
  B.call('lanchat:sendChat', { peerId: idA, text: '@Hermes still there?' });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(A.log.length, 0, 'and it can no longer be reached');
  // With the agent gone the mention is just text, so it belongs in the chat again.
  assert.equal(B.store.read(idA).length, 1, 'the message falls back to the human thread');
});
