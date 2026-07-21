'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

// The agent modules pull in electron (for safeStorage); stub it, and provide a
// reversible fake keychain so sealing can be asserted without an OS backend.
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  return r === 'electron' ? 'estub' : orig.call(this, r, ...a);
};
require.cache['estub'] = {
  id: 'estub',
  filename: 'estub',
  loaded: true,
  exports: { ipcMain: { handle: () => {} }, dialog: {}, shell: {} },
};

const { AgentRegistry, isAgentId } = require('../src/main/agents/registry.js');
const { createVirtualSocket, OPEN, CLOSED } = require('../src/main/agents/virtualSocket.js');
const { createAgentHub, LOCAL_ORIGIN } = require('../src/main/agents/index.js');
const { buildArgs } = require('../src/main/agents/transports/spawn.js');
const { PeerHub } = require('../src/main/peers.js');
const { MessageStore } = require('../src/main/store.js');

// Reversible stand-in for Electron's safeStorage.
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`sealed:${s}`),
  decryptString: (b) => b.toString().replace(/^sealed:/, ''),
};

function tmpdir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lanchat-${name}-`));
}

// ---- registry ----

test('an added agent round-trips and gets a namespaced id', () => {
  const reg = new AgentRegistry(tmpdir('reg'), { safeStorage: fakeSafeStorage });
  const rec = reg.add({ name: 'Hermes', kind: 'http', config: { baseUrl: 'http://127.0.0.1:8642' } });
  assert.ok(isAgentId(rec.id), 'id should be namespaced with agent:');
  assert.equal(reg.list().length, 1);
  assert.equal(reg.get(rec.id).name, 'Hermes');
});

test('a sealed secret is encrypted at rest and never exposed to the renderer', () => {
  const dir = tmpdir('secret');
  const reg = new AgentRegistry(dir, { safeStorage: fakeSafeStorage });
  const rec = reg.add({
    name: 'Hermes',
    kind: 'http',
    config: {},
    secret: { mode: 'sealed', value: 'super-secret-key' },
  });

  // Round-trips for the main process...
  assert.equal(reg.secretFor(rec.id), 'super-secret-key');

  // ...but the renderer-facing view carries only a boolean.
  const pub = reg.publicList()[0];
  assert.equal(pub.hasSecret, true);
  assert.equal(pub.secret, undefined);
  assert.ok(!JSON.stringify(pub).includes('super-secret-key'));

  // ...and the plaintext is not sitting in the file either.
  const onDisk = fs.readFileSync(path.join(dir, 'agents.json'), 'utf8');
  assert.ok(!onDisk.includes('super-secret-key'), 'plaintext key must not reach disk');
});

test('sealing is refused rather than silently downgraded when no keychain exists', () => {
  const reg = new AgentRegistry(tmpdir('nokeychain'), {
    safeStorage: { isEncryptionAvailable: () => false },
  });
  assert.throws(
    () => reg.add({ name: 'X', kind: 'http', config: {}, secret: { mode: 'sealed', value: 'k' } }),
    /secure storage is unavailable/i
  );
});

test('an env-backed secret stores only the variable name', () => {
  const dir = tmpdir('env');
  const reg = new AgentRegistry(dir, { safeStorage: fakeSafeStorage });
  process.env.LANCHAT_TEST_KEY = 'from-env';
  const rec = reg.add({ name: 'E', kind: 'http', config: {}, secret: { mode: 'env', name: 'LANCHAT_TEST_KEY' } });
  assert.equal(reg.secretFor(rec.id), 'from-env');
  assert.ok(!fs.readFileSync(path.join(dir, 'agents.json'), 'utf8').includes('from-env'));
  delete process.env.LANCHAT_TEST_KEY;
});

test('editing an agent without supplying a secret keeps the existing one', () => {
  const reg = new AgentRegistry(tmpdir('keep'), { safeStorage: fakeSafeStorage });
  const rec = reg.add({ name: 'H', kind: 'http', config: {}, secret: { mode: 'sealed', value: 'keepme' } });
  reg.update(rec.id, { name: 'Renamed' });
  assert.equal(reg.secretFor(rec.id), 'keepme');
});

// ---- virtual socket ----

test('the virtual socket looks like an open ws and parses frames back', () => {
  const seen = [];
  const sock = createVirtualSocket((f) => seen.push(f));
  assert.equal(sock.readyState, OPEN);
  sock.send(JSON.stringify({ type: 'chat', text: 'hi' }));
  assert.deepEqual(seen, [{ type: 'chat', text: 'hi' }]);
  sock.close();
  assert.equal(sock.readyState, CLOSED);
});

// ---- argv building (shell-injection safety) ----

test('the prompt stays a single argv entry even when it contains shell syntax', () => {
  const nasty = 'hi"; rm -rf / #';
  const args = buildArgs(['-z', '{prompt}'], nasty);
  assert.deepEqual(args, ['-z', nasty]);
  assert.equal(args.filter((a) => a === nasty).length, 1);
});

test('a template without a placeholder appends the prompt as the last argument', () => {
  assert.deepEqual(buildArgs(['chat', '-q'], 'hello'), ['chat', '-q', 'hello']);
});

// ---- hub: lifecycle, gating, removal ----

// A transport that never touches the network, so the hub's lifecycle, gating and
// routing can be tested on their own.
function stubTransports(log = []) {
  return {
    http: ({ id, name }) => ({
      id,
      name,
      kind: 'stub',
      start: async () => ({ detail: 'stub ready' }),
      send: async ({ text }, h) => {
        log.push(text);
        h.onDone?.({ text: `echo:${text}` });
      },
      stop: async () => {},
    }),
  };
}

function makeHub() {
  const dir = tmpdir('hub');
  const bus = new EventEmitter();
  const self = { id: 'me', name: 'Me' };
  const hub = new PeerHub({ getIdentity: () => self, bus });
  const store = new MessageStore(dir);
  const log = [];
  const agentHub = createAgentHub({
    userDataDir: dir,
    hub,
    bus,
    store,
    safeStorage: fakeSafeStorage,
    transports: stubTransports(log),
  });
  return { dir, bus, hub, store, agentHub, log };
}

test('an enabled agent joins the roster as online; disabling keeps it visible but offline', async () => {
  const { hub, agentHub } = makeHub();
  const agent = await agentHub.add({ name: 'Hermes', kind: 'http', config: {} });

  const inRoster = () => hub.presenceList().find((p) => p.id === agent.id);
  assert.ok(inRoster(), 'agent should appear in the roster');
  assert.equal(inRoster().kind, 'agent');
  assert.equal(inRoster().online, true, 'a started agent reports online');

  await agentHub.setEnabled(agent.id, false);
  assert.ok(inRoster(), 'a disabled agent stays visible');
  assert.equal(inRoster().online, false, 'a disabled agent is offline');

  await agentHub.setEnabled(agent.id, true);
  assert.equal(inRoster().online, true, 're-enabling reconnects without reconfiguration');
});

test('a message sent through PeerHub reaches the agent and the reply is stored', async () => {
  const { hub, agentHub, log } = makeHub();
  const agent = await agentHub.add({ name: 'Hermes', kind: 'http', config: {} });

  // Agent output re-enters through the same bus event as real peer traffic, so
  // ipc.js stores and renders it with no agent-specific case.
  const seen = [];
  hub.bus.on('peer-message', (m) => seen.push(m));

  // This is the ordinary outbound chat path — no agent-specific call site.
  const delivered = hub.send(agent.id, { type: 'chat', text: 'hello' });
  assert.equal(delivered, true, 'the virtual socket accepts the frame');

  await new Promise((r) => setImmediate(r));
  assert.deepEqual(log, ['hello'], 'the transport received the prompt');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].from, agent.id);
  assert.equal(seen[0].text, 'echo:hello');
  assert.equal(seen[0][LOCAL_ORIGIN], true, 'agent output is marked local-origin');
});

test('an allowlisted peer can reach the agent and the reply goes back only to them', async () => {
  const { hub, agentHub, log } = makeHub();
  const agent = await agentHub.add({ name: 'Hermes', kind: 'http', config: {}, allowedPeers: ['friend'] });

  const relayed = [];
  hub.send = (peerId, obj) => {
    relayed.push({ peerId, obj });
    return true;
  };

  assert.equal(agentHub.routeFromPeer('friend', '@Hermes what is the time'), true);
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(log, ['what is the time'], 'the mention prefix is stripped');
  assert.equal(relayed.length, 1, 'the reply goes to exactly one peer');
  assert.equal(relayed[0].peerId, 'friend', 'and only to the peer that asked');
});

test('removing an agent leaves nothing behind', async () => {
  const { hub, store, agentHub } = makeHub();
  const agent = await agentHub.add({
    name: 'Temp',
    kind: 'http',
    config: {},
    secret: { mode: 'sealed', value: 'k' },
  });
  store.append(agent.id, { id: '1', peerId: agent.id, direction: 'in', kind: 'text', text: 'hi', ts: Date.now() });
  assert.ok(fs.existsSync(store.fileFor(agent.id)));

  await agentHub.remove(agent.id);

  assert.equal(agentHub.list().length, 0, 'record is gone');
  assert.equal(hub.presenceList().find((p) => p.id === agent.id), undefined, 'roster entry is gone');
  assert.equal(fs.existsSync(store.fileFor(agent.id)), false, 'history file is deleted');
});

test('a peer that is not allowlisted cannot reach an agent', async () => {
  const { agentHub } = makeHub();
  const agent = await agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
  assert.equal(agentHub.routeFromPeer('stranger', `@Hermes do something`), false);
});

test('an allowlisted peer must still address the agent explicitly', async () => {
  const { agentHub } = makeHub();
  const agent = await agentHub.add({ name: 'Hermes', kind: 'http', config: {}, allowedPeers: ['friend'] });
  assert.equal(agentHub.routeFromPeer('friend', 'just chatting, no mention'), false);
});

test('the enabled toggle is a hard gate, not a UI hint', async () => {
  const { agentHub } = makeHub();
  const agent = await agentHub.add({ name: 'Hermes', kind: 'http', config: {}, allowedPeers: ['friend'] });
  await agentHub.setEnabled(agent.id, false);
  assert.equal(
    agentHub.routeFromPeer('friend', '@Hermes run something'),
    false,
    'a disabled agent must refuse an allowlisted peer'
  );
});

test('agent ids are recognised so wire frames claiming one can be rejected', async () => {
  const { agentHub } = makeHub();
  const agent = await agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
  assert.equal(agentHub.isAgent(agent.id), true);
  assert.equal(agentHub.isAgent('some-peer-uuid'), false);
});

test('the local-origin marker is a Symbol, so JSON from the wire cannot forge it', () => {
  // This is the property the impersonation guard in ipc.js relies on.
  assert.equal(typeof LOCAL_ORIGIN, 'symbol');
  const forged = JSON.parse('{"from":"agent:evil","type":"chat","text":"x","lanchat.agent.localOrigin":true}');
  assert.equal(forged[LOCAL_ORIGIN], undefined, 'a parsed frame can never carry the Symbol');
});
