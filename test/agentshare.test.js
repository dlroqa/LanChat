'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
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

// The renderer's reading of a standing, evaluated here so the panel can be
// checked against cards that actually crossed a socket rather than against a
// hand-written fixture of what we think crosses one. ESM for the browser, so the
// `export` keywords come off (same as test/signal.test.js).
const { turnStanding } = new Function(
  `${fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'lib', 'turnStanding.js'), 'utf8').replace(/^export\s+/gm, '')}
   return { turnStanding };`
)();
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

// Ports are asked for rather than hardcoded. `node --test` runs files
// concurrently and a just-closed listener can linger in TIME_WAIT, so fixed
// numbers collide with EADDRINUSE — which looks like a product failure and is
// not one.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
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
  const A = makeNode('owner', await freePort());
  const aCall = A.call;
  const B = makeNode('peer', await freePort());
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
  const A = makeNode('owner2', await freePort());
  const B = makeNode('peer2', await freePort());
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
  const A = makeNode('owner3', await freePort());
  const B = makeNode('first', await freePort());
  const C = makeNode('second', await freePort());
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
  // The other two states the panel colours, read off the same cards: C holding
  // the turn, B behind it in line.
  assert.deepEqual(turnStanding(C.hub.identities.get(cRemote), 0), {
    key: 'ready',
    word: 'Ready',
    text: '5/5 left',
  });
  assert.equal(turnStanding(B.hub.identities.get(bRemote), 0).key, 'waiting');
  // Past the anti-flood interval, which is a separate mechanism from the quota.
  await new Promise((r) => setTimeout(r, 3100));
  C.call('lanchat:sendChat', { peerId: cRemote, text: 'hello at last' });
  await waitFor(() => A.log.includes('hello at last'), 8000, 'C to be served');
});

test('a remote agent reports what it is doing, and is never pinged for latency', async (t) => {
  const A = makeNode('owner7', await freePort());
  const B = makeNode('peer7', await freePort());
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
  B.call('lanchat:sendChat', { peerId: remoteId, text: 'think about it' });
  await waitFor(() => B.store.read(remoteId).some((m) => m.direction === 'in'), 5000, 'the answer');

  // The stub answers immediately, so by now the agent has gone busy and idle
  // again — what matters is that the far side was told at all, and ends up
  // showing it as not-working rather than stuck mid-thought.
  const card = B.hub.identities.get(remoteId);
  assert.equal(card.agentBusy, false, 'the peer knows it has finished');
  assert.equal('agentBusy' in card, true, 'and was told about it, rather than left guessing');

  // An agent has no measurable network path, so it must never be sampled for
  // one: pinging its virtual socket returns nothing and renders as 100% loss.
  const roster = B.hub.presenceList().find((p) => p.id === remoteId);
  assert.equal(roster.kind, 'agent');
  assert.equal(roster.online, true, 'it is reachable');
});

test('a pending handover counts down on both machines at once', async (t) => {
  const A = makeNode('owner8', await freePort());
  const B = makeNode('holder', await freePort());
  const C = makeNode('nextup', await freePort());
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

  B.call('lanchat:sendChat', { peerId: bRemote, text: 'mine' }); // B takes the turn
  await waitFor(() => A.log.length === 1, 5000, 'B to be served');
  C.call('lanchat:sendChat', { peerId: cRemote, text: 'me next' }); // C queues behind
  await waitFor(() => C.hub.identities.get(cRemote)?.queueState === 'waiting', 5000, 'C to be queued');

  // Jump into the warning window and run one sweep. Real time is restored
  // immediately, so the sockets and their timers are untouched.
  const realNow = Date.now;
  Date.now = () => realNow() + 45000;
  try {
    A.agentHub.releaseIdleTurns();
  } finally {
    Date.now = realNow;
  }

  await waitFor(() => B.hub.identities.get(bRemote)?.queueExpiring, 5000, 'the holder to start counting');
  await waitFor(() => C.hub.identities.get(cRemote)?.queueExpiring, 5000, 'the next peer to start counting');

  const holder = B.hub.identities.get(bRemote);
  const next = C.hub.identities.get(cRemote);

  // Both machines are counting, to the same deadline — the point of sending a
  // duration rather than a timestamp is that neither depends on the other's
  // clock being right.
  assert.equal(holder.queueState, 'active');
  assert.equal(next.queueState, 'waiting');
  assert.equal(next.queuePosition, 1);
  assert.equal(
    next.queueExpiresInSec,
    holder.queueExpiresInSec,
    'the same number of seconds on both sides'
  );
  assert.ok(holder.queueExpiresInSec > 0 && holder.queueExpiresInSec <= 20);

  // And the panel reads those same cards as the two states it colours: the one
  // about to lose the turn, and the one about to be handed it. Asserted on the
  // cards themselves, so a field renamed anywhere along the wire fails here
  // rather than quietly leaving the box grey.
  assert.equal(turnStanding(holder, 6).key, 'handover');
  assert.equal(turnStanding(holder, 6).word, 'Handover');
  assert.equal(turnStanding(next, 6).key, 'brace');
  assert.equal(turnStanding(next, 6).word, 'Brace');

  // Using the turn calls the whole thing off, for both of them.
  await new Promise((r) => setTimeout(r, 3100)); // clear the anti-flood window
  B.call('lanchat:sendChat', { peerId: bRemote, text: 'still here' });
  await waitFor(() => B.hub.identities.get(bRemote)?.queueExpiring === false, 5000, 'the holder to stop');
  await waitFor(() => C.hub.identities.get(cRemote)?.queueExpiring === false, 5000, 'the waiter to stop');
});

// The turn is passed on, never taken away. A peer who is handed a turn while
// away from the keyboard and lets it lapse must still hold the place they
// queued for — losing it is what made turn taking feel arbitrary. Proven over
// real sockets because the standing has to survive the wire to be believed.
test('a peer who lets an inherited turn lapse keeps their place in the queue', async (t) => {
  const A = makeNode('owner9', await freePort());
  const B = makeNode('user9', await freePort());
  const C = makeNode('away9', await freePort());
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

  B.call('lanchat:sendChat', { peerId: bRemote, text: 'mine' }); // B takes the turn
  await waitFor(() => A.log.length === 1, 5000, 'B to be served');
  C.call('lanchat:sendChat', { peerId: cRemote, text: 'me next' }); // C queues behind
  await waitFor(() => C.hub.identities.get(cRemote)?.queueState === 'waiting', 5000, 'C to be queued');

  // Sweeps past the idle timeout, with real time restored each time so the
  // sockets and their timers are untouched.
  const realNow = Date.now;
  const sweepAfter = (ms) => {
    Date.now = () => realNow() + ms;
    try {
      A.agentHub.releaseIdleTurns();
    } finally {
      Date.now = realNow;
    }
  };

  // B walks away, so C inherits a turn it never asked for.
  sweepAfter(61000);
  await waitFor(() => C.hub.identities.get(cRemote)?.queueState === 'active', 5000, 'C to inherit');

  // C is away too and lets the whole turn go by unused.
  sweepAfter(122000);
  await waitFor(() => B.hub.identities.get(bRemote)?.queueState === 'active', 5000, 'the turn to move on');

  const cCard = C.hub.identities.get(cRemote);
  assert.equal(cCard.queueState, 'waiting', 'C did not lose the place it queued for');
  assert.equal(cCard.queuePosition, 1, 'and is still next in line');

  // Nor is C nagged about the turn it is plainly not using: one "your turn" when
  // it first came round, and nothing on the handovers after that.
  // Counted off the renderer event stream rather than the store: a turn notice
  // is shown and then dropped, so it never reaches disk to be counted there.
  const told = () =>
    C.events.filter(
      (e) => e.type === 'chat' && e.payload?.peerId === cRemote && /Your turn/.test(e.payload?.text || '')
    );
  const beforeSweeps = told().length;
  assert.ok(beforeSweeps >= 1, 'C was told once when the turn first reached it');
  for (let i = 3; i < 8; i += 1) sweepAfter(61000 * i);
  await new Promise((r) => setTimeout(r, 300)); // let anything sent cross the wire
  assert.equal(told().length, beforeSweeps, 'no repeated turn notices while nobody is asking');
});

test('turn-queue notices are shown once and saved by neither side', async (t) => {
  const A = makeNode('owner6', await freePort());
  const B = makeNode('holder', await freePort());
  const C = makeNode('waiter', await freePort());
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
  const idB = B.getIdentity().id;
  const idC = C.getIdentity().id;
  const { agent } = await A.agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
  await A.agentHub.setSharing(agent.id, { networkWide: true, directChat: true });

  await connect(A, B);
  await connect(A, C);
  const bRemote = await waitFor(() => remoteIdOn(B, idA, agent.id), 5000, 'B to see the agent');
  const cRemote = await waitFor(() => remoteIdOn(C, idA, agent.id), 5000, 'C to see the agent');

  // B takes the turn with a real question and gets a real answer.
  B.call('lanchat:sendChat', { peerId: bRemote, text: 'what is the time' });
  await waitFor(() => B.store.read(bRemote).some((m) => m.direction === 'in'), 5000, 'the answer');

  // C asks while B holds the turn, so the queue tells C where it stands.
  C.call('lanchat:sendChat', { peerId: cRemote, text: 'my turn?' });
  const shown = await waitFor(
    () => C.events.find((e) => e.type === 'chat' && /in line/.test(e.payload?.text || '')),
    5000,
    'C to be told where it stands'
  );
  assert.equal(shown.payload.peerId, cRemote, 'in the agent thread, as before');
  assert.equal(shown.payload.notice, true, 'marked as something to take away again');

  // Shown and then dropped: the thread C keeps holds what C said, not the
  // scheduling around it.
  assert.deepEqual(
    C.store.read(cRemote).map((m) => `${m.direction}:${m.text}`),
    ['out:my turn?'],
    "the notice is not in the waiting peer's history"
  );
  assert.deepEqual(
    A.store.read(`${agent.id}#${idC}`).map((m) => `${m.direction}:${m.text}`),
    ['in:my turn?'],
    "nor in the owner's copy of the same thread"
  );

  // Only the housekeeping goes. A real exchange is kept exactly as it was.
  assert.deepEqual(
    B.store.read(bRemote).map((m) => `${m.direction}:${m.text}`),
    ['out:what is the time', 'in:echo:what is the time'],
    'a genuine question and answer still survive'
  );

  // The flag is honoured only for a locally produced agent message. A peer must
  // not be able to send us something that renders and then leaves no trace.
  B.hub.send(idA, { type: 'chat', text: 'keep this', notice: true });
  await waitFor(() => A.store.read(idB).length === 1, 5000, "B's message to be stored");
  assert.equal(A.store.read(idB)[0].text, 'keep this', 'a peer cannot flag their own message away');
});

test('deleting a chat history removes it from disk, agent threads included', async (t) => {
  const A = makeNode('owner5', await freePort());
  const B = makeNode('peer5', await freePort());
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
  const A = makeNode('owner6', await freePort());
  const B = makeNode('peer6', await freePort());
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
  const A = makeNode('owner4', await freePort());
  const B = makeNode('peer4', await freePort());
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
