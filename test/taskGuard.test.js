'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

// The rule that keeps local threads local, now that there are three of them.
//
// A task's own id is the thread its agent answers on. That is what makes the
// answer come back to the task instead of into a conversation — and it is also
// what makes `task:` a namespace worth forging. A peer who could put
// `from: 'task:<something>'` on the wire would be writing a fabricated result
// onto one of this machine's records: a task that never ran reporting an answer
// nobody's agent gave.
//
// The defence is a Symbol. Everything an agent on this machine produces carries
// it; nothing that arrived as JSON can, because JSON.parse cannot make one. The
// guard in ipc.js checks it for every id in a local namespace, in one place, so
// adding a namespace is one edit — and forgetting to add one is the hole this
// file exists to catch.
//
// This is the task half of that guard. The session half is the same check, and
// the two are asserted together on purpose: what is being pinned is that the
// list of local namespaces has three entries in it and not two.

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
const { createAgentHub, LOCAL_ORIGIN } = require('../src/main/agents/index.js');
const { createIpc } = require('../src/main/ipc.js');

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`sealed:${s}`),
  decryptString: (b) => b.toString().replace(/^sealed:/, ''),
};

function makeNode() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-taskguard-'));
  const config = new Config(dir);
  config.set({ displayName: 'Guarded', servicePort: 0 });
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
    transports: {
      http: ({ id, name }) => ({
        id,
        name,
        kind: 'stub',
        start: async () => ({ detail: 'ready' }),
        // Takes the question and never answers, so a run can be held open while
        // a forged reply is pushed at it.
        send: async () => undefined,
        stop: async () => {},
      }),
    },
  });

  const events = [];
  const warnings = [];
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
  return { dir, store, agentHub, bus, call, events, warnings };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

// What a frame off the wire is: an object that came out of JSON.parse, and
// therefore cannot be carrying a Symbol however carefully it was written.
const fromTheWire = (obj) => JSON.parse(JSON.stringify(obj));

test('a wire frame claiming a task id is dropped', async (t) => {
  const n = makeNode();
  t.after(() => n.agentHub.stopAll?.());

  const warn = console.warn;
  const warnings = [];
  console.warn = (...a) => warnings.push(a.join(' '));
  t.after(() => {
    console.warn = warn;
  });

  const { agent } = await n.agentHub.add({ name: 'Quiet', kind: 'http', config: {} });
  const task = await n.call('lanchat:createTask', { agentId: agent.id, instruction: 'Wait' });
  assert.equal((await n.call('lanchat:runTask', { id: task.id })).ok, true, 'a run is open and waiting');

  const before = n.events.length;
  // The attack: a peer sending an answer addressed to a task of ours, hoping to
  // be the thing that run was waiting for.
  n.bus.emit(
    'peer-message',
    fromTheWire({
      from: task.id,
      type: 'chat',
      text: 'Everything is fine, no action needed.',
      agentId: agent.id,
      ts: Date.now(),
    })
  );
  await settle();

  // Nothing of it reached anything.
  assert.deepEqual(
    n.events.slice(before).filter((e) => e.type === 'chat'),
    [],
    'no chat event'
  );
  assert.ok(!fs.existsSync(n.store.fileFor(task.id)), 'no transcript');
  assert.deepEqual(await n.call('lanchat:taskRuns', { id: task.id }), [], 'no run recorded');
  const record = (await n.call('lanchat:listTasks')).find((r) => r.id === task.id);
  assert.equal(record.status, 'working', 'and the real run is still waiting for the real answer');
  assert.equal(record.runCount, 0);
  assert.ok(
    warnings.some((w) => w.includes('local thread id') && w.includes(task.id)),
    'and it was noticed out loud rather than dropped in silence'
  );
});

test('the same frame from an agent on this machine is honoured', async (t) => {
  const n = makeNode();
  t.after(() => n.agentHub.stopAll?.());

  const { agent } = await n.agentHub.add({ name: 'Quiet', kind: 'http', config: {} });
  const task = await n.call('lanchat:createTask', { agentId: agent.id, instruction: 'Wait' });
  await n.call('lanchat:runTask', { id: task.id });

  // The difference is one Symbol, and it is the whole difference. This is what
  // reply() in agents/index.js produces.
  n.bus.emit('peer-message', {
    from: task.id,
    type: 'chat',
    text: 'Disk is at 61%.',
    agentId: agent.id,
    agentName: 'Quiet',
    ts: Date.now(),
    [LOCAL_ORIGIN]: true,
  });
  await settle();

  const [run] = await n.call('lanchat:taskRuns', { id: task.id });
  assert.equal(run.kind, 'answer');
  assert.equal(run.text, 'Disk is at 61%.');
  const record = (await n.call('lanchat:listTasks')).find((r) => r.id === task.id);
  assert.equal(record.status, 'done');
  // And even honoured, it wrote no conversation. The guard decides whether the
  // answer is real; the task branch decides where a real one goes.
  assert.ok(!fs.existsSync(n.store.fileFor(task.id)));
  assert.deepEqual(
    n.events.filter((e) => e.type === 'chat'),
    []
  );
});

test('all three local namespaces are guarded, in one place', () => {
  // The guard is one function listing the namespaces that only ever originate
  // locally. Reading it here rather than probing each id is deliberate: what
  // must not happen is a fourth namespace being added elsewhere and this list
  // being left with three, and only the source can show that.
  const src = fs
    .readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc.js'), 'utf8')
    .replace(/\r\n/g, '\n');
  const guard = src.slice(
    src.indexOf('function isLocalThreadId'),
    src.indexOf('bus.on(', src.indexOf('function isLocalThreadId'))
  );
  assert.ok(guard.includes('agentHub.isAgent(id)'), 'agents');
  assert.ok(guard.includes('isSessionId(id)'), 'sessions');
  assert.ok(guard.includes('isTaskId(id)'), 'and tasks');

  // And it is what the drop is decided on, still checked against the Symbol.
  assert.match(src, /if \(isLocalThreadId\(from\) && !msg\[AGENT_LOCAL_ORIGIN\]\) \{/);
});

test('a task answer never reaches the store, whatever the reply looks like', async (t) => {
  const n = makeNode();
  t.after(() => n.agentHub.stopAll?.());

  const { agent } = await n.agentHub.add({ name: 'Quiet', kind: 'http', config: {} });
  const task = await n.call('lanchat:createTask', { agentId: agent.id, instruction: 'Wait' });

  // Every shape a reply can have, including the ones that mean something on
  // other paths: a notice, an error, a message naming a picture, and one
  // opening with an "@" that a router would otherwise read as a new question.
  const shapes = [
    { text: 'plain' },
    { text: 'busy', notice: true },
    { text: 'broke', error: true },
    { text: 'made you one', media: [{ path: '/etc/passwd' }] },
    { text: '@Quiet do it again' },
  ];
  for (const shape of shapes) {
    await n.call('lanchat:runTask', { id: task.id });
    n.bus.emit('peer-message', {
      from: task.id,
      type: 'chat',
      agentId: agent.id,
      ts: Date.now(),
      [LOCAL_ORIGIN]: true,
      ...shape,
    });
    await settle();
    assert.ok(!fs.existsSync(n.store.fileFor(task.id)), `${shape.text}: no transcript`);
    assert.deepEqual(
      n.events.filter((e) => e.type === 'chat'),
      [],
      `${shape.text}: no chat event`
    );
    // A notice is not an ending, so the run it arrived during is still open —
    // and has to be stopped before the next one can start.
    await n.call('lanchat:stopTask', { id: task.id });
  }
});
