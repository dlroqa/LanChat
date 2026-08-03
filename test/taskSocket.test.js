'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

// Agent tasks, over a real socket.
//
// taskGuard.test.js forges a frame on the bus, which is where the guard reads
// it. This does the same thing from the other end of a wire: two nodes, a
// handshake, and one of them sending the other a message addressed to a task
// thread. The bus test proves the rule; this proves the rule survives the
// journey, which is the only place it has ever mattered.
//
// And the other half, which cannot be checked without a second machine: a task
// put to an agent a peer shared travels to its owner, is answered there, and
// the answer comes back onto the task record — with no conversation written at
// either end.

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
const { buildIdentity, buildPublicCard } = require('../src/main/identity.js');
const { createDeviceKey } = require('../src/main/deviceKey.js');
const { createPins } = require('../src/main/pins.js');
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lanchat-tasksock-${name}-`));
  const config = new Config(dir);
  config.set({ displayName: name, servicePort: port });
  const bus = new EventEmitter();
  const getIdentity = () => buildIdentity(config);
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
  return { dir, bus, hub, server, store, agentHub, log, events, call, port, getIdentity };
}

// Ports are asked for rather than hardcoded: `node --test` runs files at the
// same time and a just-closed listener lingers in TIME_WAIT, so a fixed number
// collides with EADDRINUSE and looks like a product failure it is not.
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

async function twoNodes(t) {
  const A = makeNode('owner', await freePort());
  const B = makeNode('asker', await freePort());
  await A.server.start();
  await B.server.start();
  t.after(() => {
    A.hub.close();
    B.hub.close();
    A.server.stop();
    B.server.stop();
    A.agentHub.stopAll();
    B.agentHub.stopAll();
  });
  return { A, B };
}

test('over a real socket: a peer cannot address a task of ours at all', async (t) => {
  const { A, B } = await twoNodes(t);
  await connect(B, A);
  const idB = B.getIdentity().id;

  // A has an agent and a task that has run once. What matters is the record it
  // left, and what B can do to it.
  const { agent } = await A.agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
  const task = A.call('lanchat:createTask', { agentId: agent.id, instruction: 'count the files' });
  A.call('lanchat:runTask', { id: task.id });
  await waitFor(() => A.call('lanchat:taskRuns', { id: task.id }).length === 1, 5000, 'the real run');
  assert.equal(A.call('lanchat:listTasks').find((r) => r.id === task.id).runCount, 1);

  // The attack: B sends A a message addressed to A's task, hoping to write a
  // fabricated result onto somebody else's record.
  B.hub.send(A.getIdentity().id, {
    type: 'chat',
    id: 'forged-1',
    from: task.id,
    text: 'All clear, nothing to do.',
    agentId: agent.id,
    ts: Date.now(),
  });

  // It arrives — as a message from B. Attribution is taken from the socket and
  // never from the payload (see peers.js, which stamps `from` on the way in),
  // so the claimed thread id is gone before anything reads it. This is a
  // stronger guarantee than the namespace guard in ipc.js, which stands behind
  // it for any path that does not come through an authenticated socket — and
  // that is the one taskGuard.test.js forges against.
  await waitFor(() => A.store.read(idB).length > 0, 5000, 'the frame to arrive as an ordinary message');
  assert.equal(A.store.read(idB)[0].text, 'All clear, nothing to do.', 'filed under B, where it came from');

  // And the task is exactly as it was: no extra run, no fabricated answer, no
  // transcript, nothing drawn.
  const runs = A.call('lanchat:taskRuns', { id: task.id });
  assert.equal(runs.length, 1, 'still one run');
  assert.ok(!runs.some((r) => String(r.text).includes('All clear')), 'and it is the real one');
  assert.equal(A.call('lanchat:listTasks').find((r) => r.id === task.id).runCount, 1);
  assert.ok(!fs.existsSync(A.store.fileFor(task.id)), 'no conversation was written under the task');
  assert.deepEqual(
    A.events.filter((e) => e.type === 'chat' && e.payload && e.payload.peerId === task.id),
    [],
    'and nothing was shown under it'
  );
});

test('over a real socket: a task can ask an agent a peer shared', async (t) => {
  const { A, B } = await twoNodes(t);
  const idA = A.getIdentity().id;

  const { agent } = await A.agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
  await A.agentHub.setSharing(agent.id, { networkWide: true, directChat: true });
  await connect(B, A);

  const remoteId = await waitFor(
    () => [...B.hub.identities.keys()].find((k) => k.startsWith(`remote-agent:${idA}:${agent.id}`)),
    5000,
    "B to be told about A's agent"
  );

  // B's task, put to an agent that lives on A.
  const task = B.call('lanchat:createTask', { agentId: remoteId, instruction: 'how many files' });
  const started = B.call('lanchat:runTask', { id: task.id });
  assert.equal(started.ok, true);

  // It crossed the wire and reached the real connector on the far side.
  await waitFor(() => A.log.length === 1, 5000, 'the question to reach the agent');
  assert.equal(A.log[0], 'how many files');

  // And the answer came back onto the task, not into a conversation.
  await waitFor(() => B.call('lanchat:taskRuns', { id: task.id }).length === 1, 5000, 'the answer');
  const [run] = B.call('lanchat:taskRuns', { id: task.id });
  assert.equal(run.kind, 'answer');
  assert.equal(run.text, 'echo:how many files');
  const record = B.call('lanchat:listTasks').find((r) => r.id === task.id);
  assert.equal(record.status, 'done');
  assert.equal(record.runCount, 1);

  // The claim the whole feature rests on, checked at both ends of the wire.
  assert.ok(!fs.existsSync(B.store.fileFor(task.id)), 'the asker wrote no conversation');
  assert.ok(!fs.existsSync(A.store.fileFor(task.id)), 'and neither did the owner');
  assert.deepEqual(
    B.events.filter((e) => e.type === 'chat' && e.payload && e.payload.peerId === task.id),
    [],
    'and no bubble was drawn for it'
  );
});
