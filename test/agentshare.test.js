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
const { buildIdentity, buildPublicCard } = require('../src/main/identity.js');
const { createDeviceKey } = require('../src/main/deviceKey.js');
const { createPins } = require('../src/main/pins.js');
const { PeerHub } = require('../src/main/peers.js');
const { createServer } = require('../src/main/server.js');
const { MessageStore } = require('../src/main/store.js');
const { createAgentHub } = require('../src/main/agents/index.js');
const { greetingLine } = require('../src/main/agents/turnCopy.js');
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
        // A prompt that makes the run fail, so the error path can be driven
        // without a second transport stub.
        if (text.startsWith('faildetail:')) {
          // The shape a real transport failure has: a message safe to relay,
          // and detail that names something on the owner's machine.
          const err = new Error('The agent could not be started.');
          err.detail = 'Command not found: /home/owner/.local/bin/hermes.';
          h.onError?.(err);
          return;
        }
        if (text.startsWith('fail:')) {
          h.onError?.(new Error('transport is down'));
          return;
        }
        // A run that succeeds having said nothing — the other real outcome a
        // transport can have, and the one that used to be reported as an error.
        if (text.startsWith('quiet:')) {
          h.onDone?.({ text: '' });
          return;
        }
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
  // Its own key and its own pins, in its own dir. `fakeSafeStorage` reports no
  // encryption available, which is exactly the case the plain-file fallback in
  // deviceKey.js exists for — refusing there would have taken this whole suite
  // down before a single agent test ran.
  const deviceKey = createDeviceKey({ userDataDir: dir });
  const pins = createPins({ userDataDir: dir });
  const getPublicCard = () => buildPublicCard(config, deviceKey);
  const hub = new PeerHub({ getIdentity, bus, deviceKey, pins });
  const server = createServer({
    config,
    getIdentity,
    getPublicCard,
    deviceKey,
    pins,
    hub,
    bus,
    downloadsDir: path.join(dir, 'dl'),
  });
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

  return { dir, config, bus, getIdentity, hub, server, store, agentHub, log, events, call, port, deviceKey, pins };
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

// A bare `@name` — the reported bug, over real sockets, in the exact
// configuration it was reported in: shared network-wide with direct chat off, so
// the contact is meant to appear only once somebody writes the name.
//
// What used to happen: the mention fell through to an ordinary chat frame and sat
// in the human conversation, the owner spent one of the asker's five queries
// running the agent on a prompt of nothing, and the run of nothing came back as a
// stored bubble reading "(no output)".
test('a bare @name introduces the agent instead of reporting no output', async (t) => {
  const A = makeNode('owner-summon', await freePort());
  const B = makeNode('peer-summon', await freePort());
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
  await A.agentHub.setSharing(agent.id, { networkWide: true, directChat: false });

  await connect(A, B);
  await waitFor(() => B.hub.presenceList().length > 0, 5000, 'B to see A');

  // Exactly what the user typed: the name and nothing else.
  const sent = await waitFor(
    () => {
      const m = B.call('lanchat:sendChat', { peerId: idA, text: '@Hermes' });
      return m && m.summoned ? m : false;
    },
    5000,
    'the summon to be recognised as one'
  );
  assert.equal(sent.summoned, true, 'the renderer is told this was the moment of connection');

  const remoteId = remoteIdOn(B, idA, agent.id);
  assert.ok(remoteId, 'summoning revealed the contact even with direct chat off');
  const card = B.hub.presenceList().find((p) => p.id === remoteId);
  assert.equal(card.kind, 'agent', 'and it is an agent card, under AGENTS');
  assert.equal(card.remote, true);
  assert.equal(card.online, true);

  await waitFor(
    () => B.store.read(remoteId).some((m) => m.direction === 'in'),
    5000,
    'the greeting to come back'
  );

  // The greeting, asserted against the one place it is written so the two
  // machines cannot drift apart on the wording.
  assert.deepEqual(
    B.store.read(remoteId).map((m) => `${m.direction}:${m.text}`),
    ['out:@Hermes', `in:${greetingLine('Hermes')}`]
  );

  // The core of the bug: the agent was never run.
  assert.deepEqual(A.log, [], 'no prompt of nothing, so no run of nothing');

  // And the string that started all this appears nowhere, in either direction.
  const everything = [
    ...B.store.read(remoteId).map((m) => m.text || ''),
    ...A.store.read(`${agent.id}#${idB}`).map((m) => m.text || ''),
    ...B.events.map((e) => e.payload?.text || ''),
    ...A.events.map((e) => e.payload?.text || ''),
  ];
  assert.ok(!everything.some((t2) => /no output/i.test(t2)), everything.join(' | '));

  // Agent talk stays out of the human conversation on both machines.
  assert.deepEqual(B.store.read(idA), [], 'the summon never entered B’s chat with A');
  assert.deepEqual(A.store.read(idB), [], "and never entered A's chat with B");
  assert.deepEqual(
    A.store.read(`${agent.id}#${idB}`).map((m) => `${m.direction}:${m.text}`),
    ['in:@Hermes', `in:${greetingLine('Hermes')}`],
    'A sees it filed under the delegate thread'
  );
  assert.deepEqual(A.store.read(agent.id), [], "A's own thread with the agent is untouched");

  // No turn was spent, observed from both ends: no standing was ever published to
  // B, and the owner still has B down for a full quota.
  assert.equal(
    B.hub.identities.get(remoteId).queueState,
    undefined,
    'somebody who is not in the queue is not given a place in it'
  );
  assert.equal(turnStanding(B.hub.identities.get(remoteId)), null, 'so the panel shows no turn box');
  assert.equal(A.agentHub.standingFor(agent.id, idB).remaining, A.agentHub.TURN_QUOTA);

  // Summoning again greets again — every time, which is the point.
  await waitFor(
    () => {
      B.call('lanchat:sendChat', { peerId: idA, text: '@Hermes' });
      return B.store.read(remoteId).filter((m) => m.direction === 'in').length === 2;
    },
    8000,
    'a second summon to be answered too'
  );
  assert.deepEqual(A.log, [], 'and still nothing has been run');
});

test('a bare @name from an older peer still gets a greeting', async (t) => {
  const A = makeNode('owner-legacy', await freePort());
  const B = makeNode('peer-legacy', await freePort());
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
  await A.agentHub.setSharing(agent.id, { networkWide: true, directChat: false });
  await connect(A, B);

  // A build with no summon frame sends the bare mention as ordinary chat — which
  // is what every existing install does. The owner has to map it onto the same
  // greeting rather than onto an empty run, or the fix only helps peers who have
  // already updated.
  B.hub.send(idA, { type: 'chat', id: 'legacy-1', text: '@Hermes', ts: Date.now() });

  const remoteId = await waitFor(() => remoteIdOn(B, idA, agent.id), 5000, 'the contact to appear');
  await waitFor(() => B.store.read(remoteId).some((m) => m.direction === 'in'), 5000, 'the greeting');

  assert.equal(B.store.read(remoteId)[0].text, greetingLine('Hermes'));
  assert.deepEqual(A.log, [], 'no empty run for an older asker either');
  assert.deepEqual(A.store.read(idB), [], 'and the bare mention was consumed, not stored as a human message');
  assert.equal(A.agentHub.standingFor(agent.id, idB).remaining, A.agentHub.TURN_QUOTA, 'no turn spent');
});

test('a run that finishes with nothing leaves no bubble on either machine', async (t) => {
  const A = makeNode('owner-quiet', await freePort());
  const B = makeNode('peer-quiet', await freePort());
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
  const remoteId = await waitFor(() => remoteIdOn(B, idA, agent.id), 5000, "B to see A's agent");

  // `quiet:` makes the echo transport answer with an empty string — a CLI exiting
  // 0 having printed nothing, or an ACP run stopping normally with no text.
  B.call('lanchat:sendChat', { peerId: remoteId, text: 'quiet:now' });
  await waitFor(() => A.log.length === 1, 5000, 'the request to reach the agent');
  await waitFor(
    () => B.events.some((e) => e.type === 'agent-empty' && e.payload?.peerId === remoteId),
    5000,
    'the empty-run signal to reach the far side'
  );

  // The question is still on the record; the non-answer is not.
  assert.deepEqual(
    B.store.read(remoteId).map((m) => `${m.direction}:${m.text}`),
    ['out:quiet:now'],
    'no bubble is stored for an answer that does not exist'
  );
  const delegate = `${agent.id}#${idB}`;
  assert.deepEqual(A.store.read(delegate).map((m) => `${m.direction}:${m.text}`), ['in:quiet:now']);

  // Nobody is left waiting on a reply that is never coming: the signal is what
  // clears the "thinking" indicator, since no chat message arrives to do it.
  const empties = B.events.filter((e) => e.type === 'agent-empty' && e.payload?.peerId === remoteId);
  assert.equal(empties.length, 1, 'the window is told once that the run came back');
  // And no bubble was pushed into the thread alongside it. The outbound question
  // is handed back through the ipc call rather than emitted, so a `chat` event on
  // this thread could only be an answer — and there is no answer.
  assert.deepEqual(
    B.events.filter((e) => e.type === 'chat' && e.payload?.peerId === remoteId),
    [],
    'nothing is pushed into the thread for an answer that does not exist'
  );
  // The owner's own window sees the same, filed under the delegate thread.
  assert.ok(
    A.events.some((e) => e.type === 'agent-empty' && e.payload?.peerId === delegate),
    'the owner is told too, in the thread it happened in'
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

  // C now asks and must be queued, not served — but the question is kept.
  const before = A.log.length;
  C.call('lanchat:sendChat', { peerId: cRemote, text: 'my turn?' });
  await waitFor(
    () => C.hub.identities.get(cRemote)?.queueHeld === true,
    5000,
    'C to be told its question is held'
  );
  assert.equal(A.log.length, before, "C's request was not served while B held the turn");

  const cCard = C.hub.identities.get(cRemote);
  assert.equal(cCard.queueState, 'waiting');
  assert.equal(cCard.queuePosition, 1, 'and knows it is next');
  assert.equal(cCard.queueQuota, 5);
  assert.deepEqual(
    C.store.read(cRemote).map((m) => m.text),
    ['my turn?'],
    'and it is still in the transcript to come back to'
  );
  // The wording is the whole difference between being told to come back and try
  // again and being told there is nothing to come back for. Asserted on the copy
  // C actually reads, not on the string the owner built.
  const firstNotice = C.events
    .filter((e) => e.type === 'chat' && e.payload.peerId === cRemote && e.payload.notice)
    .at(-1).payload;
  assert.match(firstNotice.text, /kept your question/, 'C is told the question is held');
  assert.doesNotMatch(firstNotice.text, /ask again/, 'and not told to ask again');

  // Asking again while that one is still waiting is the same question twice. It
  // is refused on C's own machine: nothing sent, nothing written down, and the
  // words handed back so they can be typed at instead of retyped.
  const refused = C.call('lanchat:sendChat', { peerId: cRemote, text: 'well?' });
  assert.equal(refused.rejected, true);
  assert.equal(refused.text, 'well?', 'the text comes back');
  assert.match(refused.notice.text, /busy with someone else/);
  assert.equal(refused.notice.notice, true, 'and the explanation is transient');
  assert.deepEqual(
    C.store.read(cRemote).map((m) => m.text),
    ['my turn?'],
    'the second attempt was never stored'
  );

  // B is out of quota with C waiting, so the next attempt hands over.
  B.call('lanchat:sendChat', { peerId: bRemote, text: 'one more' });
  await waitFor(
    () => C.hub.identities.get(cRemote)?.queueState === 'active',
    8000,
    'the turn to pass to C'
  );
  assert.ok(!A.log.includes('one more'), "B's over-quota request was refused, not served");
  assert.equal(B.hub.identities.get(bRemote).queueState, 'waiting', 'and B is now queued');

  // The question C asked while it was in line is read the moment the turn lands,
  // rather than C having to notice and ask it again.
  await waitFor(() => A.log.includes('my turn?'), 8000, "C's held question to be read");
  await waitFor(
    () => C.hub.identities.get(cRemote)?.queueHeld === false,
    5000,
    'the held marker to clear'
  );

  // And reading it cost nothing: C gets its own full quota, not the remainder of
  // B's, and not one less for the question it asked while waiting.
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

// The other way a turn changes hands: nobody was waiting, so no sweep ever ran,
// and the takeover happens on the newcomer's question instead. The machine that
// lost the turn has to be told over the wire — it has no other way to find out,
// and a card left saying "your turn" while somebody else is being served is how
// two people end up both believing the agent is theirs.
test('a turn taken over after a silence is corrected on the machine that lost it', async (t) => {
  const A = makeNode('owner10', await freePort());
  const B = makeNode('faded', await freePort());
  const C = makeNode('newcomer', await freePort());
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
  const idC = C.getIdentity().id;
  const { agent } = await A.agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
  await A.agentHub.setSharing(agent.id, { networkWide: true, directChat: true });
  await connect(A, B);
  await connect(A, C);

  const bRemote = await waitFor(() => remoteIdOn(B, idA, agent.id), 5000, 'B to see the agent');
  const cRemote = await waitFor(() => remoteIdOn(C, idA, agent.id), 5000, 'C to see the agent');

  // B has the agent to itself and spends one query. Nothing is queued behind it,
  // so no sweep will ever warn it or move the turn on.
  B.call('lanchat:sendChat', { peerId: bRemote, text: 'mine' });
  await waitFor(() => B.hub.identities.get(bRemote)?.queueState === 'active', 5000, 'B to hold the turn');
  assert.equal(B.hub.identities.get(bRemote).queueRemaining, 4);

  // B goes quiet. A minute later C asks. The inbound leg is driven directly, the
  // way the sweep is in the tests above — routeDirect is the exact function
  // ipc.js calls on an agent-chat frame — so the clock can be moved without
  // holding it forward across the wire. Everything that follows is real traffic.
  const realNow = Date.now;
  Date.now = () => realNow() + 61000;
  try {
    A.agentHub.routeDirect(idC, agent.id, 'my turn now');
  } finally {
    Date.now = realNow;
  }

  await waitFor(() => C.hub.identities.get(cRemote)?.queueState === 'active', 5000, 'C to take over');
  await waitFor(() => B.hub.identities.get(bRemote)?.queueState === 'waiting', 5000, 'B to be corrected');

  const faded = B.hub.identities.get(bRemote);
  assert.equal(faded.queuePosition, 1, 'B keeps a place rather than dropping out of the queue');
  assert.equal(faded.queueAhead, 4, "with what C has left of C's turn ahead of it");

  // Read the way the panel reads it, off the card that actually crossed the
  // socket: the box that said Ready / 4/5 left now says Waiting / #1 in line.
  assert.equal(turnStanding(faded, 0).word, 'Waiting');
  assert.equal(turnStanding(faded, 0).text, '#1 in line');
  assert.equal(turnStanding(C.hub.identities.get(cRemote), 0).word, 'Ready');

  // And B is told why, since the idle warning never fired for it — there was
  // nobody waiting at the time for it to fire about.
  const told = await waitFor(
    () =>
      B.events.find(
        (e) => e.type === 'chat' && e.payload?.peerId === bRemote && /passed to them/.test(e.payload?.text || '')
      ),
    5000,
    'B to be told the turn moved'
  );
  assert.match(told.payload.text, /#1 in line/);
  assert.equal(told.payload.notice, true, 'as a notice, not a message');
  assert.ok(
    B.store.read(bRemote).every((m) => !/passed to them/.test(m.text || '')),
    'so it is shown once and never written down'
  );
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

  // A failed run is a result, not housekeeping: it says what became of a question
  // somebody asked, so it is kept like the output would have been. Only the queue
  // machinery is transient.
  await new Promise((r) => setTimeout(r, 3100)); // past the anti-flood interval
  B.call('lanchat:sendChat', { peerId: bRemote, text: 'fail:now' });
  const failed = await waitFor(
    () => B.events.find((e) => e.type === 'chat' && /transport is down/.test(e.payload?.text || '')),
    5000,
    'the error to reach the renderer'
  );
  assert.ok(!failed.payload.notice, 'an error is not treated as a notice');
  assert.deepEqual(
    B.store.read(bRemote).map((m) => `${m.direction}:${m.text}`),
    ['out:what is the time', 'in:echo:what is the time', 'out:fail:now', 'in:⚠️ transport is down'],
    'the question and the error explaining it are both kept'
  );

  // The flag is honoured only for a locally produced agent message. A peer must
  // not be able to send us something that renders and then leaves no trace.
  B.hub.send(idA, { type: 'chat', text: 'keep this', notice: true });
  await waitFor(() => A.store.read(idB).length === 1, 5000, "B's message to be stored");
  assert.equal(A.store.read(idB)[0].text, 'keep this', 'a peer cannot flag their own message away');
});

test('notices already on disk from an older version are cleared out at startup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-prune-'));
  const store = new MessageStore(dir);
  const history = path.join(dir, 'history');
  const write = (file, list) => fs.writeFileSync(path.join(history, file), JSON.stringify(list), 'utf8');
  const read = (file) => JSON.parse(fs.readFileSync(path.join(history, file), 'utf8'));

  // Every shape the old build wrote, as it appears in a real history file.
  const notices = [
    'Your turn — you have 5 queries.',
    'You have been idle — your turn passes to the next person in about 20s (1 waiting). Ask something to keep it.',
    'That is 5 queries — passing to the next person waiting. You are #1 in line; ask again when your turn comes round.',
    'Hermes is busy with someone else. You are #1 in line — ask again when it is your turn.',
    'I am still working on the previous message — one at a time, please.',
  ].map((text, i) => ({ id: `n${i}`, direction: 'in', kind: 'text', text, ts: 1000 + i }));

  // The owner's view of a peer's conversation with their agent. The second
  // question is a peer quoting a notice back at the agent: `askedBy` marks it as
  // something a person asked, so it stays whatever it says.
  write('agent_aaa_bbb.json', [
    { id: 'q', direction: 'in', kind: 'text', text: 'what profile are you using?', ts: 1, askedBy: 'bbb' },
    ...notices,
    { id: 'q2', direction: 'in', kind: 'text', text: 'Your turn — you have 5 queries.', ts: 1500, askedBy: 'bbb' },
    { id: 'a', direction: 'in', kind: 'text', text: 'I’m using the Hermes profile “lanchat”.', ts: 2000 },
    // An old error stays too: a running version keeps these, so the cleanup does.
    { id: 'e', direction: 'in', kind: 'text', text: '⚠️ connect ECONNREFUSED 127.0.0.1:8081', ts: 2100 },
  ]);
  // The asking peer's own copy of the same thing.
  write('remote-agent_ccc_ddd.json', [
    { id: 'ask', direction: 'out', kind: 'text', text: 'give me a brief report of the system status', ts: 1 },
    ...notices,
  ]);
  // A chat with a person, named by a bare id. Even the exact wording is left
  // alone here: only agent threads are candidates.
  write('7cd6bd1c-ac68-4bb8-bc07-dd906ddc1861.json', [
    { id: 'h', direction: 'in', kind: 'text', text: 'Your turn — you have 5 queries.', ts: 1 },
  ]);

  const removed = store.pruneLegacyNotices();
  assert.equal(removed, 10, 'every stored notice in both agent threads goes');

  assert.deepEqual(
    read('agent_aaa_bbb.json').map((m) => m.text),
    [
      'what profile are you using?',
      'Your turn — you have 5 queries.',
      'I’m using the Hermes profile “lanchat”.',
      '⚠️ connect ECONNREFUSED 127.0.0.1:8081',
    ],
    'questions, answers and errors survive in order, a quoted notice included'
  );
  assert.deepEqual(
    read('remote-agent_ccc_ddd.json').map((m) => m.text),
    ['give me a brief report of the system status'],
    "and so does the asking peer's own question"
  );
  assert.equal(
    read('7cd6bd1c-ac68-4bb8-bc07-dd906ddc1861.json').length,
    1,
    'a message from a person is never touched, whatever it says'
  );

  // Safe to run on every launch, which is what also cleans up notices sent by a
  // peer who has not upgraded yet.
  assert.equal(store.pruneLegacyNotices(), 0, 'a second pass finds nothing to do');
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

test('switching direct chat off takes the contact off the peer roster, even after they used it', async (t) => {
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
  const { agent } = await A.agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
  await A.agentHub.setSharing(agent.id, { networkWide: true, directChat: true });

  await connect(A, B);
  const remoteId = await waitFor(() => remoteIdOn(B, idA, agent.id), 5000, 'B to see the agent');

  // Having talked to it is exactly the case that used to pin the contact in
  // place: the roster entry outlived the grant that put it there.
  B.call('lanchat:sendChat', { peerId: remoteId, text: 'hello' });
  await waitFor(() => B.store.read(remoteId).some((m) => m.direction === 'in'), 5000, 'an answer');

  await A.agentHub.setSharing(agent.id, { directChat: false });
  await waitFor(() => !B.hub.identities.has(remoteId), 5000, 'the contact to go away');
  assert.equal(B.hub.presenceList().find((p) => p.id === remoteId), undefined);

  // Off means "not in their list", not "revoked": it is still reachable by name,
  // and using it brings the contact back — with the transcript intact.
  await waitFor(
    () => {
      B.call('lanchat:sendChat', { peerId: idA, text: '@Hermes still there?' });
      return A.log.length > 1;
    },
    5000,
    'the mention to reach the agent'
  );
  await waitFor(() => B.hub.identities.has(remoteId), 5000, 'the contact to come back');
  assert.ok(
    B.store.read(remoteId).some((m) => m.text === 'hello'),
    'and what was said before it was hidden is still there'
  );
  assert.deepEqual(B.store.read(idA), [], 'the mention never entered the chat with A');
});

test('a retraction that never landed is finished on the next handshake', async (t) => {
  const A = makeNode('owner6', await freePort());
  const B = makeNode('peer6', await freePort());
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

  // The frame is lost — a dropped link at the wrong moment, which is precisely
  // when a stale grant would otherwise survive on the far machine.
  const realSend = A.hub.send.bind(A.hub);
  A.hub.send = (peerId, obj) => (obj.type === 'agent-withdraw' ? false : realSend(peerId, obj));
  await A.agentHub.setSharing(agent.id, { networkWide: false });
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(B.hub.identities.has(remoteId), 'the retraction did not land');

  // Reconnecting is what finishes it: the handshake re-sends the whole picture,
  // withdrawals included.
  A.hub.send = realSend;
  A.bus.emit('peer-hello', { peerId: idB });
  await waitFor(() => !B.hub.identities.has(remoteId), 5000, 'the contact to disappear');
});

test('a peer is never told about agents it was not given', async (t) => {
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

  const idB = B.getIdentity().id;
  const { agent: shared } = await A.agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
  const { agent: privateOne } = await A.agentHub.add({ name: 'Scribe', kind: 'http', config: {} });
  await A.agentHub.setSharing(shared.id, { networkWide: true, directChat: true });

  const sent = [];
  const realSend = A.hub.send.bind(A.hub);
  A.hub.send = (peerId, obj) => {
    sent.push(obj);
    return realSend(peerId, obj);
  };

  await connect(A, B);
  await waitFor(() => sent.some((f) => f.type === 'agent-advert'), 5000, 'the advert for the shared one');
  A.bus.emit('peer-hello', { peerId: idB });
  await new Promise((r) => setTimeout(r, 200));

  assert.ok(
    !sent.some((f) => f.agentId === privateOne.id),
    'the local-only agent is not mentioned at all, not even to be withdrawn'
  );
});

// ---- documents ----
//
// A document reaches an agent as text in the prompt, because no transport
// carries attachments. That makes the split between what is sent and what is
// remembered the thing to prove: the agent must get the document's contents,
// and the transcript must not — a chat history that quoted every attached PDF
// back at you would be unusable.

test('a document attached to a local agent reaches it, without landing in the transcript', async (t) => {
  const A = makeNode('docs-local', await freePort());
  await A.server.start();
  t.after(() => {
    A.hub.close();
    A.server.stop();
  });

  const file = path.join(A.dir, 'brief.md');
  fs.writeFileSync(file, '# Brief\n\nShip the thing by Friday.\n');

  const { agent } = await A.agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
  const message = A.call('lanchat:sendChat', {
    peerId: agent.id,
    text: 'when is this due?',
    docPaths: [file],
  });

  await waitFor(() => A.log.length === 1, 5000, 'the agent to be asked');
  const prompt = A.log[0];
  assert.match(prompt, /Ship the thing by Friday\./, 'the agent is given the document');
  assert.match(prompt, /\[Attached document: brief\.md/);
  assert.ok(prompt.includes(file), 'and told where the whole file is');
  assert.ok(prompt.trimEnd().endsWith('when is this due?'), 'with the question last');

  // What is remembered is what was typed, plus the fact a document went with it.
  assert.equal(message.text, 'when is this due?');
  assert.deepEqual(
    message.docs.map((d) => d.name),
    ['brief.md']
  );
  // Only the asking side is checked: this stub agent echoes the prompt back, so
  // the document's words legitimately appear in its *reply*, which is its answer
  // and belongs in the thread like any other.
  const stored = A.store.read(agent.id).filter((m) => m.direction === 'out');
  assert.equal(stored[0].text, 'when is this due?');
  assert.ok(!/Ship the thing by Friday/.test(JSON.stringify(stored)), 'the body is not written into what we asked');
});

test("a document reaches somebody else's shared agent over the wire", async (t) => {
  const A = makeNode('docs-owner', await freePort());
  const B = makeNode('docs-peer', await freePort());
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
  const remoteId = await waitFor(() => remoteIdOn(B, idA, agent.id), 5000, "B to see A's agent");

  // The document lives on B's machine; only its text crosses to A.
  const file = path.join(B.dir, 'minutes.txt');
  fs.writeFileSync(file, 'Decision: we go with the blue one.\n');

  B.call('lanchat:sendChat', { peerId: remoteId, text: 'what did we decide?', docPaths: [file] });

  await waitFor(() => A.log.length === 1, 5000, 'the request to reach the agent');
  assert.match(A.log[0], /Decision: we go with the blue one\./, "the far agent is given the document's text");
  assert.ok(A.log[0].trimEnd().endsWith('what did we decide?'));

  await waitFor(() => B.store.read(remoteId).some((m) => m.direction === 'in'), 5000, 'the answer');

  // B's own transcript keeps the short form; the document is named, not quoted.
  const asked = B.store.read(remoteId).find((m) => m.direction === 'out');
  assert.equal(asked.text, 'what did we decide?');
  assert.deepEqual(
    asked.docs.map((d) => d.name),
    ['minutes.txt']
  );
  assert.ok(!/blue one/.test(JSON.stringify(asked)), "B's transcript does not hold the document");
});

test('a document that cannot be read is reported, and the question still goes', async (t) => {
  const A = makeNode('docs-bad', await freePort());
  await A.server.start();
  t.after(() => {
    A.hub.close();
    A.server.stop();
  });

  const good = path.join(A.dir, 'good.txt');
  fs.writeFileSync(good, 'readable content');
  const bad = path.join(A.dir, 'photo.png');
  fs.writeFileSync(bad, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));

  const { agent } = await A.agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
  const message = A.call('lanchat:sendChat', {
    peerId: agent.id,
    text: 'have a look',
    docPaths: [good, bad],
  });

  await waitFor(() => A.log.length === 1, 5000, 'the agent to be asked');
  assert.match(A.log[0], /readable content/, 'the file that could be read still went');
  assert.ok(!/photo\.png\]/.test(A.log[0]), 'and the one that could not did not');
  assert.deepEqual(
    message.docs.map((d) => d.name),
    ['good.txt']
  );
  // The reason is said out loud rather than swallowed.
  const toast = A.events.find((e) => e.type === 'toast' && /photo\.png/.test(e.payload?.text || ''));
  assert.ok(toast, 'the user is told why one file did not go');
  assert.equal(toast.payload.level, 'error');
});

test('documents cannot be smuggled into a chat with a person', async (t) => {
  const A = makeNode('docs-guard-a', await freePort());
  const B = makeNode('docs-guard-b', await freePort());
  await A.server.start();
  await B.server.start();
  t.after(() => {
    A.hub.close();
    B.hub.close();
    A.server.stop();
    B.server.stop();
  });

  await connect(A, B);
  const idB = B.getIdentity().id;
  const file = path.join(A.dir, 'private.txt');
  fs.writeFileSync(file, 'SECRET CONTENTS');

  const message = A.call('lanchat:sendChat', { peerId: idB, text: 'hello', docPaths: [file] });

  assert.equal(message.text, 'hello');
  assert.equal(message.docs, undefined);
  await waitFor(() => B.store.read(A.getIdentity().id).length === 1, 5000, 'the message to arrive');
  assert.equal(B.store.read(A.getIdentity().id)[0].text, 'hello', 'and it is only the message');
  assert.ok(A.events.some((e) => e.type === 'toast' && /only be attached to an agent/i.test(e.payload?.text || '')));
});

test('a failing agent tells the peer what happened without telling them about this machine', async (t) => {
  const A = makeNode('owner11', await freePort());
  const B = makeNode('peer11', await freePort());
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

  const remoteId = await waitFor(() => remoteIdOn(B, idA, agent.id), 5000, "B to see A's agent");
  B.call('lanchat:sendChat', { peerId: remoteId, text: 'faildetail:now' });

  const seen = await waitFor(
    () => B.store.read(remoteId).find((m) => m.direction === 'in'),
    5000,
    'the failure to reach B over the wire'
  );

  // B is told the run failed — an unanswered question would be worse than a
  // vague answer — but the failure is described in terms of the agent, not of
  // the machine it runs on.
  assert.match(seen.text, /could not be started/, 'B learns the agent failed');
  assert.doesNotMatch(seen.text, /home\/owner/, 'but never sees a path on A');
  assert.doesNotMatch(seen.text, /Command not found/, 'nor which command A is missing');

  // The owner, on the same failure, gets the part that says how to fix it.
  const delegate = `${agent.id}#${idB}`;
  const kept = A.store.read(delegate).map((m) => m.text).join('\n');
  assert.match(kept, /Command not found: \/home\/owner\/\.local\/bin\/hermes/, 'A keeps the detail');
});

test('an owner going offline takes their agents with them, without a runaway presence loop', async (t) => {
  const A = makeNode('owner9', await freePort());
  const B = makeNode('peer9', await freePort());
  await A.server.start();
  await B.server.start();
  t.after(() => {
    A.hub.close();
    B.hub.close();
    A.server.stop();
    B.server.stop();
  });

  const idA = A.getIdentity().id;
  // Two agents, because dropping them is a loop: the second one is what proves
  // the first one's departure did not leave the loop walking a mutated map.
  const { agent: one } = await A.agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
  const { agent: two } = await A.agentHub.add({ name: 'Mercury', kind: 'http', config: {} });
  await A.agentHub.setSharing(one.id, { networkWide: true, directChat: true });
  await A.agentHub.setSharing(two.id, { networkWide: true, directChat: true });

  await connect(A, B);
  const remoteOne = await waitFor(() => remoteIdOn(B, idA, one.id), 5000, 'B to see Hermes');
  const remoteTwo = await waitFor(() => remoteIdOn(B, idA, two.id), 5000, 'B to see Mercury');

  // Dropping an owner runs inside a presence listener and emits presence itself.
  // Re-entering that listener with the entry still on the books recursed until
  // the stack gave out, which took the whole main process down with it.
  const blewUp = [];
  const onCrash = (err) => blewUp.push(err);
  process.on('uncaughtException', onCrash);
  t.after(() => process.off('uncaughtException', onCrash));

  A.hub.close();
  await A.server.stop();

  await waitFor(() => !B.hub.isConnected(idA), 5000, 'B to notice A is gone');
  await waitFor(
    () => !B.hub.identities.has(remoteOne) && !B.hub.identities.has(remoteTwo),
    5000,
    "A's agents to leave B's roster"
  );

  assert.deepEqual(blewUp.map((e) => e.message), [], 'and nothing blew the stack on the way');
  const ids = B.hub.presenceList().map((p) => p.id);
  assert.equal(ids.includes(remoteOne), false);
  assert.equal(ids.includes(remoteTwo), false);
});
