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

const {
  AgentRegistry,
  isAgentId,
  remoteAgentIdFor,
  isRemoteAgentId,
  parseRemoteAgentId,
} = require('../src/main/agents/registry.js');
const { createRemoteAgents } = require('../src/main/agents/remote.js');
const { describeSocketError } = require('../src/main/agents/transports/http.js');
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

// ---- socket error copy ----

test('a refused connection explains the loopback trap instead of dumping the raw error', () => {
  const url = new URL('http://100.85.49.69:8642/v1/models');
  const err = describeSocketError(Object.assign(new Error('connect ECONNREFUSED 100.85.49.69:8642'), {
    code: 'ECONNREFUSED',
  }), url);

  assert.match(err.message, /Nothing is listening on 100\.85\.49\.69:8642/);
  assert.match(err.message, /127\.0\.0\.1/, 'should name the address that would work');
  assert.match(err.message, /loopback/i, 'should explain why the tailnet address fails');
  assert.match(err.message, /\(ECONNREFUSED\)$/, 'the raw code stays searchable');
});

test('other socket failures are named too, and unknown ones pass through untouched', () => {
  const url = new URL('http://agent-box:8642/v1/models');
  const at = (code) => describeSocketError(Object.assign(new Error('raw'), { code }), url).message;

  assert.match(at('ENOTFOUND'), /Unknown host "agent-box"/);
  assert.match(at('ETIMEDOUT'), /No response from agent-box/);
  assert.match(at('ERR_TLS_CERT_ALTNAME_INVALID'), /TLS certificate/);

  // The timeout path destroys with a code-less Error; its wording must survive.
  const timeout = new Error('Request timed out.');
  assert.equal(describeSocketError(timeout, url), timeout, 'unrecognised errors are not rewritten');
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
// `startError` makes the probe fail, so "saved" and "reachable" can be told
// apart; `lifecycle` records construction and start/stop so a restart on edit
// can be asserted without a real transport.
function stubTransports(log = [], { startError = null, lifecycle = [] } = {}) {
  return {
    http: ({ id, name, config }) => {
      lifecycle.push({ event: 'built', baseUrl: config.baseUrl });
      return {
        id,
        name,
        kind: 'stub',
        start: async () => {
          lifecycle.push({ event: 'start', baseUrl: config.baseUrl });
          if (startError) throw new Error(startError);
          return { detail: 'stub ready' };
        },
        send: async ({ text }, h) => {
          log.push(text);
          h.onDone?.({ text: `echo:${text}` });
        },
        stop: async () => {
          lifecycle.push({ event: 'stop', baseUrl: config.baseUrl });
        },
      };
    },
  };
}

function makeHub({ startError = null } = {}) {
  const dir = tmpdir('hub');
  const bus = new EventEmitter();
  const self = { id: 'me', name: 'Me' };
  const hub = new PeerHub({ getIdentity: () => self, bus });
  const store = new MessageStore(dir);
  const log = [];
  const lifecycle = [];
  const agentHub = createAgentHub({
    userDataDir: dir,
    hub,
    bus,
    store,
    safeStorage: fakeSafeStorage,
    transports: stubTransports(log, { startError, lifecycle }),
  });
  return { dir, bus, hub, store, agentHub, log, lifecycle };
}

// A hub whose transport always asks for authorisation, so the local-only
// approval property can be asserted against a remote peer's request.
function approvalHub() {
  const dir = tmpdir('approval');
  const bus = new EventEmitter();
  const hub = new PeerHub({ getIdentity: () => ({ id: 'me', name: 'Me' }), bus });
  const agentHub = createAgentHub({
    userDataDir: dir,
    hub,
    bus,
    store: new MessageStore(dir),
    safeStorage: fakeSafeStorage,
    transports: {
      http: ({ id, name }) => ({
        id,
        name,
        kind: 'stub',
        start: async () => ({ detail: 'stub ready' }),
        send: async (_msg, h) => {
          h.onApproval?.({ runId: 'run-1', command: 'rm -rf /', choices: ['allow', 'deny'] });
        },
        stop: async () => {},
      }),
    },
  });
  return { dir, bus, hub, agentHub };
}

test('an enabled agent joins the roster as online; disabling keeps it visible but offline', async () => {
  const { hub, agentHub } = makeHub();
  const { agent } = await agentHub.add({ name: 'Hermes', kind: 'http', config: {} });

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
  const { agent } = await agentHub.add({ name: 'Hermes', kind: 'http', config: {} });

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
  const { agent } = await agentHub.add({ name: 'Hermes', kind: 'http', config: {}, allowedPeers: ['friend'] });

  const relayed = [];
  hub.send = (peerId, obj) => {
    relayed.push({ peerId, obj });
    return true;
  };

  assert.equal(agentHub.routeFromPeer('friend', '@Hermes what is the time'), true);
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(log, ['what is the time'], 'the mention prefix is stripped');
  const replies = relayed.filter((r) => r.obj.type === 'agent-reply');
  assert.equal(replies.length, 1, 'exactly one answer is sent');
  assert.equal(replies[0].peerId, 'friend', 'and only to the peer that asked');
  // Nothing about this exchange reaches anyone else — queue status included.
  assert.deepEqual([...new Set(relayed.map((r) => r.peerId))], ['friend']);
});

test('removing an agent leaves nothing behind', async () => {
  const { hub, store, agentHub } = makeHub();
  const { agent } = await agentHub.add({
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

// ---- saved vs. reachable, and editing in place ----

test('an agent that fails its probe is reported as unreachable, not as a clean success', async () => {
  const { agentHub } = makeHub({ startError: 'Nothing is listening on 100.85.49.69:8642. (ECONNREFUSED)' });
  const { agent, probe } = await agentHub.add({
    name: 'Hermes',
    kind: 'http',
    config: { baseUrl: 'http://100.85.49.69:8642' },
  });

  assert.equal(probe.ok, false, 'the caller must be able to see the probe failed');
  assert.match(probe.detail, /ECONNREFUSED/);
  // The record is still written, so the address can be corrected without
  // retyping everything — but the UI is told not to claim success.
  assert.equal(agentHub.list().length, 1, 'the record is kept so it can be edited or discarded');
  assert.equal(agent.id, agentHub.list()[0].id);
});

test('editing a live agent restarts the transport so the new address is actually used', async () => {
  const { agentHub, lifecycle } = makeHub();
  const { agent } = await agentHub.add({
    name: 'Hermes',
    kind: 'http',
    config: { baseUrl: 'http://100.85.49.69:8642' },
    secret: { mode: 'sealed', value: 'keepme' },
  });

  lifecycle.length = 0;
  const { agent: updated, probe } = await agentHub.update(agent.id, {
    config: { baseUrl: 'http://127.0.0.1:8642' },
  });

  assert.equal(probe.ok, true);
  assert.equal(updated.config.baseUrl, 'http://127.0.0.1:8642');
  // A transport captures its config at construction, so an edit that did not
  // rebuild and restart it would silently keep using the old address.
  assert.deepEqual(
    lifecycle.map((l) => l.event),
    ['stop', 'built', 'start'],
    'the old transport is torn down and a new one is started'
  );
  assert.equal(lifecycle.at(-1).baseUrl, 'http://127.0.0.1:8642', 'the new transport uses the new address');
});

test('editing an agent in place keeps its stored key', async () => {
  const { agentHub, dir } = makeHub();
  const { agent } = await agentHub.add({
    name: 'Hermes',
    kind: 'http',
    config: { baseUrl: 'http://100.85.49.69:8642' },
    secret: { mode: 'sealed', value: 'keepme' },
  });

  // No `secret` in the patch — the same thing the form sends when the key
  // field is left blank.
  await agentHub.update(agent.id, { config: { baseUrl: 'http://127.0.0.1:8642' } });

  const reg = new AgentRegistry(dir, { safeStorage: fakeSafeStorage });
  assert.equal(reg.secretFor(agent.id), 'keepme', 'an edit must not wipe a key the user did not retype');
  assert.equal(reg.get(agent.id).config.baseUrl, 'http://127.0.0.1:8642');
});

test('switching transport replaces the config instead of leaving stale settings behind', async () => {
  const reg = new AgentRegistry(tmpdir('switch'), { safeStorage: fakeSafeStorage });
  const rec = reg.add({ name: 'H', kind: 'http', config: { baseUrl: 'http://127.0.0.1:8642', timeoutMs: 5000 } });

  // A same-transport edit merges, so fields the form never shows survive.
  reg.update(rec.id, { kind: 'http', config: { baseUrl: 'http://localhost:9999' } });
  assert.equal(reg.get(rec.id).config.timeoutMs, 5000, 'an unrelated setting is not dropped');

  // Switching transport replaces, so nothing from the old one lingers.
  reg.update(rec.id, { kind: 'command', config: { command: 'hermes' } });
  assert.equal(reg.get(rec.id).kind, 'command');
  assert.equal(reg.get(rec.id).config.baseUrl, undefined, 'no leftovers from the previous transport');
  assert.throws(() => reg.update(rec.id, { kind: 'telepathy' }), /Unknown agent transport/);
});

test('editing a disabled agent does not start it but does refresh the roster card', async () => {
  const { agentHub, hub, lifecycle } = makeHub();
  const { agent } = await agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
  await agentHub.setEnabled(agent.id, false);

  lifecycle.length = 0;
  const { agent: updated } = await agentHub.update(agent.id, { name: 'Renamed' });

  assert.equal(lifecycle.filter((l) => l.event === 'start').length, 0, 'a dormant agent stays dormant');
  assert.equal(updated.name, 'Renamed');
  const card = hub.presenceList().find((p) => p.id === agent.id);
  // Peers address an agent by name, so a rename has to reach the roster even
  // while the agent is switched off.
  assert.equal(card.name, 'Renamed');
  assert.equal(card.online, false);
});

// ---- reach: network-wide sharing ----

test('network-wide lets a peer through who is not on the allowlist', async () => {
  const { agentHub, log } = makeHub();
  const { agent } = await agentHub.add({ name: 'Hermes', kind: 'http', config: {} });

  assert.equal(agentHub.routeFromPeer('stranger', '@Hermes hello'), false, 'closed by default');

  await agentHub.setSharing(agent.id, { networkWide: true });
  assert.equal(agentHub.routeFromPeer('stranger', '@Hermes hello'), true);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(log, ['hello']);
});

test('switching network-wide off restores the allowlist rather than clearing it', async () => {
  const { agentHub } = makeHub();
  const { agent } = await agentHub.add({
    name: 'Hermes',
    kind: 'http',
    config: {},
    allowedPeers: ['friend'],
  });

  await agentHub.setSharing(agent.id, { networkWide: true });
  assert.equal(agentHub.routeFromPeer('stranger', '@Hermes hi'), true);

  await agentHub.setSharing(agent.id, { networkWide: false });
  assert.equal(agentHub.routeFromPeer('stranger', '@Hermes hi'), false, 'the stranger loses access');
  // The grant was narrowed, never discarded — this is what makes the toggle
  // safe to flip: nothing the user configured is lost.
  assert.deepEqual(agentHub.list()[0].allowedPeers, ['friend'], 'the ticked list survived untouched');
  assert.equal(agentHub.routeFromPeer('friend', '@Hermes hi'), true, 'and governs again immediately');
});

test('the enabled toggle still overrides network-wide', async () => {
  const { agentHub } = makeHub();
  const { agent } = await agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
  await agentHub.setSharing(agent.id, { networkWide: true, directChat: true });
  await agentHub.setEnabled(agent.id, false);
  assert.equal(
    agentHub.routeFromPeer('stranger', '@Hermes run something'),
    false,
    'a disabled agent refuses everyone regardless of reach'
  );
});

test('directChat does not grant reach — it only affects discoverability', async () => {
  const { agentHub } = makeHub();
  const { agent } = await agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
  await agentHub.setSharing(agent.id, { directChat: true });
  assert.equal(
    agentHub.routeFromPeer('stranger', '@Hermes hi'),
    false,
    'showing it in a roster must not be a back door into reaching it'
  );
});

test('a peer that is not allowlisted cannot reach an agent', async () => {
  const { agentHub } = makeHub();
  const { agent } = await agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
  assert.equal(agentHub.routeFromPeer('stranger', `@Hermes do something`), false);
});

test('an allowlisted peer must still address the agent explicitly', async () => {
  const { agentHub } = makeHub();
  const { agent } = await agentHub.add({ name: 'Hermes', kind: 'http', config: {}, allowedPeers: ['friend'] });
  assert.equal(agentHub.routeFromPeer('friend', 'just chatting, no mention'), false);
});

test('the enabled toggle is a hard gate, not a UI hint', async () => {
  const { agentHub } = makeHub();
  const { agent } = await agentHub.add({ name: 'Hermes', kind: 'http', config: {}, allowedPeers: ['friend'] });
  await agentHub.setEnabled(agent.id, false);
  assert.equal(
    agentHub.routeFromPeer('friend', '@Hermes run something'),
    false,
    'a disabled agent must refuse an allowlisted peer'
  );
});

test('agent ids are recognised so wire frames claiming one can be rejected', async () => {
  const { agentHub } = makeHub();
  const { agent } = await agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
  assert.equal(agentHub.isAgent(agent.id), true);
  assert.equal(agentHub.isAgent('some-peer-uuid'), false);
});

// ---- confined agent conversations ----

test("a peer's agent traffic is confined to its own thread, not the chat with them", async () => {
  const { hub, agentHub } = makeHub();
  const { agent } = await agentHub.add({
    name: 'Hermes',
    kind: 'http',
    config: {},
    allowedPeers: ['friend'],
  });

  const requests = [];
  const replies = [];
  hub.bus.on('agent-request', (r) => requests.push(r));
  hub.bus.on('peer-message', (m) => replies.push(m));
  hub.send = () => true; // swallow the outbound relay

  assert.equal(agentHub.routeFromPeer('friend', '@Hermes what is the time'), true);
  await new Promise((r) => setImmediate(r));

  const expected = `${agent.id}#friend`;
  assert.equal(requests.length, 1);
  assert.equal(requests[0].threadId, expected, 'the request is filed under the delegate thread');
  assert.equal(requests[0].peerId, 'friend', 'and still records who asked');

  // The crux: neither the request nor the reply is attributed to the human peer,
  // so the chat with them stays clean.
  assert.equal(replies.length, 1);
  assert.equal(replies[0].from, expected, 'the reply lands in the delegate thread too');
  assert.notEqual(replies[0].from, 'friend');
  assert.notEqual(replies[0].from, agent.id, "and not in the owner's own private thread");
});

test('two peers get two separate delegate threads', async () => {
  const { hub, agentHub } = makeHub();
  const { agent } = await agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
  await agentHub.setSharing(agent.id, { networkWide: true });
  hub.send = () => true;

  const seen = [];
  hub.bus.on('agent-request', (r) => seen.push(r.threadId));
  agentHub.routeFromPeer('alice', '@Hermes one');
  agentHub.routeFromPeer('bob', '@Hermes two');
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(seen, [`${agent.id}#alice`, `${agent.id}#bob`]);
  assert.equal(new Set(seen).size, 2, 'conversations do not bleed between peers');
});

test('removing an agent deletes every delegate thread, not just its own history', async () => {
  const { hub, store, agentHub } = makeHub();
  const { agent } = await agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
  await agentHub.setSharing(agent.id, { networkWide: true });
  hub.send = () => true;

  agentHub.routeFromPeer('alice', '@Hermes one');
  await new Promise((r) => setImmediate(r));
  const delegate = `${agent.id}#alice`;
  store.append(delegate, { id: '1', peerId: delegate, direction: 'in', kind: 'text', text: 'x', ts: 1 });
  assert.ok(fs.existsSync(store.fileFor(delegate)));

  await agentHub.remove(agent.id);

  // "Nothing permanent" has to include the transcripts of other people's
  // conversations with it, or removal quietly leaves them on disk.
  assert.equal(fs.existsSync(store.fileFor(delegate)), false, 'delegate transcript is gone');
  assert.equal(hub.presenceList().find((p) => p.id === delegate), undefined, 'and its roster card');
});

test('an approval raised by a remote peer is surfaced locally and never relayed', async () => {
  const { dir, hub, agentHub } = approvalHub();
  const { agent } = await agentHub.add({
    name: 'Hermes',
    kind: 'http',
    config: {},
    allowedPeers: ['friend'],
  });

  const approvals = [];
  const relayed = [];
  hub.bus.on('agent-approval', (a) => approvals.push(a));
  hub.send = (peerId, obj) => {
    relayed.push({ peerId, obj });
    return true;
  };

  agentHub.routeFromPeer('friend', '@Hermes delete everything');
  await new Promise((r) => setImmediate(r));

  // The core security property: a peer may ask, but the authorisation prompt
  // belongs to the owner of the machine and is never put on the wire.
  assert.equal(approvals.length, 1, 'the owner is asked');
  assert.equal(approvals[0].agentId, agent.id);
  assert.equal(
    relayed.some((r) => JSON.stringify(r.obj).includes('approval')),
    false,
    'no approval request is ever relayed to a peer'
  );
  assert.ok(dir);
});

// ---- safeguards ----

test('a flooding peer is throttled and silenced, while the local user never is', async () => {
  const { hub, agentHub, log } = makeHub();
  const { agent } = await agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
  await agentHub.setSharing(agent.id, { networkWide: true });

  const realSend = hub.send.bind(hub);
  const relayed = [];
  hub.send = (peerId, obj) => {
    if (String(peerId).startsWith('agent:')) return realSend(peerId, obj); // local path
    relayed.push(obj);
    return true;
  };

  // Back-to-back messages from one peer: the first lands, the rest are dropped
  // without a reply, so a looping peer cannot amplify itself into a frame storm
  // or keep the agent permanently busy for everyone else.
  for (let i = 0; i < 5; i += 1) agentHub.routeFromPeer('flooder', `@Hermes ${i}`);
  await new Promise((r) => setImmediate(r));
  assert.equal(log.length, 1, 'only the first request reaches the transport');
  assert.equal(relayed.filter((f) => f.type === 'agent-reply').length, 1, 'exactly one answer goes out');

  // The point is that outbound traffic does not scale with the flood: the four
  // dropped messages produce nothing at all.
  const afterFive = relayed.length;
  for (let i = 0; i < 20; i += 1) agentHub.routeFromPeer('flooder', `@Hermes more ${i}`);
  await new Promise((r) => setImmediate(r));
  assert.equal(relayed.length, afterFive, 'twenty more messages produce no further frames');
  assert.equal(log.length, 1, 'and never reach the transport');

  // The owner is on the same agent at the same moment and is unaffected.
  log.length = 0;
  for (let i = 0; i < 5; i += 1) {
    realSend(agent.id, { type: 'chat', text: `mine ${i}` });
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(log.length, 5, 'the local user is never throttled');
});

// ---- fair-share turns on a shared agent ----

// Registers a peer as connected. The queue drops peers who have gone offline,
// so a test peer needs a socket to keep its place in it.
function joinPeer(hub, id) {
  hub.register(id, { readyState: 1, send() {}, close() {} });
}

// Drives N requests from a peer, letting each run settle, and reports what the
// transport actually saw.
async function ask(agentHub, peerId, n, log) {
  const before = log.length;
  for (let i = 0; i < n; i += 1) {
    agentHub.routeFromPeer(peerId, `@Hermes q${i}`);
    await new Promise((r) => setImmediate(r));
  }
  return log.length - before;
}

// The throttle's minimum interval would swallow a rapid burst, which is a
// different mechanism; step the clock so only the quota is under test.
function withFakeClock(fn) {
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => (t += 4000);
  return Promise.resolve(fn()).finally(() => {
    Date.now = realNow;
  });
}

test('a remote peer gets five queries, then the turn passes to whoever is waiting', async () => {
  await withFakeClock(async () => {
    const { hub, agentHub, log } = makeHub();
    const { agent } = await agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
    await agentHub.setSharing(agent.id, { networkWide: true });
    hub.send = () => true;

    // Alice arrives first and gets the turn.
    assert.equal(await ask(agentHub, 'alice', 5, log), 5, 'the holder gets a full quota');
    const alice = agentHub.standingFor(agent.id, 'alice');
    assert.equal(alice.state, 'active');
    assert.equal(alice.remaining, 0, 'the quota is spent');
    assert.equal(alice.quota, 5);
    assert.equal(alice.expiring, false, 'and nothing is expiring while she is active');

    // Bob asks while Alice holds the turn: queued, not served.
    assert.equal(await ask(agentHub, 'bob', 1, log), 0, 'a waiting peer is not served');
    assert.equal(agentHub.standingFor(agent.id, 'bob').state, 'waiting');
    assert.equal(agentHub.standingFor(agent.id, 'bob').position, 1);

    // Alice is out of quota with Bob waiting, so she hands over.
    assert.equal(await ask(agentHub, 'alice', 1, log), 0, 'a spent turn is not extended');
    assert.equal(agentHub.standingFor(agent.id, 'bob').state, 'active', 'the turn passed to Bob');
    assert.equal(agentHub.standingFor(agent.id, 'alice').state, 'waiting');

    // And Bob gets his own full quota — the same limit, not the remainder.
    assert.equal(await ask(agentHub, 'bob', 5, log), 5);
  });
});

test('with nobody waiting a lone peer keeps going rather than being blocked', async () => {
  await withFakeClock(async () => {
    const { hub, agentHub, log } = makeHub();
    const { agent } = await agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
    await agentHub.setSharing(agent.id, { networkWide: true });
    hub.send = () => true;

    // Twice the quota, no queue: there is nothing to be fair about.
    assert.equal(await ask(agentHub, 'alice', 12, log), 12);
    assert.equal(agentHub.standingFor(agent.id, 'alice').state, 'active');
  });
});

test('the owner never queues for their own agent', async () => {
  await withFakeClock(async () => {
    const { hub, agentHub, log } = makeHub();
    const { agent } = await agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
    await agentHub.setSharing(agent.id, { networkWide: true });

    const realSend = hub.send.bind(hub);
    hub.send = (peerId, obj) => (String(peerId).startsWith('agent:') ? realSend(peerId, obj) : true);

    // A peer takes and holds the turn.
    await ask(agentHub, 'alice', 5, log);
    log.length = 0;

    // The owner is unaffected by somebody else's turn, and by any quota.
    for (let i = 0; i < 8; i += 1) {
      realSend(agent.id, { type: 'chat', text: `mine ${i}` });
      await new Promise((r) => setImmediate(r));
    }
    assert.equal(log.length, 8, 'the local user is never queued or capped');
    assert.equal(agentHub.standingFor(agent.id, 'alice').state, 'active', "and does not steal a peer's turn");
  });
});

test('a peer waiting their turn is told where they stand', async () => {
  await withFakeClock(async () => {
    const { hub, agentHub, log } = makeHub();
    const { agent } = await agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
    await agentHub.setSharing(agent.id, { networkWide: true });

    const frames = [];
    hub.send = (peerId, obj) => {
      frames.push({ peerId, obj });
      return true;
    };

    await ask(agentHub, 'alice', 5, log);
    frames.length = 0;
    await ask(agentHub, 'bob', 1, log);

    // Silence would look like the agent ignoring them, so standing is pushed.
    const queued = frames.filter((f) => f.obj.type === 'agent-queue');
    assert.ok(queued.length >= 2, 'both the holder and the waiter are updated');
    const forBob = queued.filter((f) => f.peerId === 'bob').at(-1).obj;
    assert.equal(forBob.state, 'waiting');
    assert.equal(forBob.position, 1);
    assert.equal(forBob.quota, 5);

    const told = frames.filter((f) => f.peerId === 'bob' && f.obj.type === 'agent-reply');
    assert.match(told.at(-1).obj.text, /#1 in line/, 'and told in the thread too');
  });
});

test('the holder is warned before losing the turn, and asking again keeps it', async () => {
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => t;
  try {
    const { hub, agentHub, log } = makeHub();
    const { agent } = await agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
    await agentHub.setSharing(agent.id, { networkWide: true });

    const frames = [];
    hub.send = (peerId, obj) => {
      frames.push({ peerId, obj });
      return true;
    };
    joinPeer(hub, 'alice');
    joinPeer(hub, 'bob');

    t += 4000;
    await ask(agentHub, 'alice', 1, log);
    t += 4000;
    await ask(agentHub, 'bob', 1, log); // waiting, so a handover is possible

    // Nothing is said while she is still within her time.
    frames.length = 0;
    t += 20000;
    agentHub.releaseIdleTurns();
    assert.equal(frames.length, 0, 'no nagging before the warning point');

    // Past the warning point she is told, with time left to act on it.
    t += 25000; // 45s idle, warn at 40s, handover at 60s
    agentHub.releaseIdleTurns();
    const warned = frames.filter((f) => f.peerId === 'alice' && f.obj.type === 'agent-reply');
    assert.equal(warned.length, 1, 'the holder is warned exactly once');
    assert.match(warned[0].obj.text, /turn passes/i);
    assert.match(warned[0].obj.text, /\d+s/, 'and told how long is left');
    assert.equal(agentHub.standingFor(agent.id, 'alice').state, 'active', 'but still holds it');
    assert.equal(agentHub.standingFor(agent.id, 'alice').expiring, true);

    // Warned once per turn, not on every sweep.
    frames.length = 0;
    t += 5000;
    agentHub.releaseIdleTurns();
    assert.equal(frames.length, 0, 'the warning does not repeat');

    // Acting on the warning keeps the turn and resets the countdown.
    t += 4000;
    assert.equal(await ask(agentHub, 'alice', 1, log), 1, 'she can still use it');
    assert.equal(agentHub.standingFor(agent.id, 'alice').expiring, false, 'the countdown resets');
    assert.equal(agentHub.standingFor(agent.id, 'bob').state, 'waiting', 'and Bob keeps waiting');
  } finally {
    Date.now = realNow;
  }
});

test('an idle holder is moved aside even with queries left, and the next peer is told', async () => {
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => t;
  try {
    const { hub, agentHub, log } = makeHub();
    const { agent } = await agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
    await agentHub.setSharing(agent.id, { networkWide: true });

    const frames = [];
    hub.send = (peerId, obj) => {
      frames.push({ peerId, obj });
      return true;
    };

    joinPeer(hub, 'alice');
    joinPeer(hub, 'bob');

    // Two queries, spaced past the anti-flood interval, leaving her three.
    t += 4000;
    await ask(agentHub, 'alice', 1, log);
    t += 4000;
    await ask(agentHub, 'alice', 1, log);
    t += 4000;
    await ask(agentHub, 'bob', 1, log); // queued behind her
    assert.equal(agentHub.standingFor(agent.id, 'alice').remaining, 3, 'she has quota to spare');
    assert.equal(agentHub.standingFor(agent.id, 'bob').state, 'waiting');

    // She stops using it. Unused quota must not hold the queue hostage.
    frames.length = 0;
    t += 61000;
    agentHub.releaseIdleTurns();

    assert.equal(agentHub.standingFor(agent.id, 'bob').state, 'active', 'the turn moved on its own');
    assert.equal(agentHub.standingFor(agent.id, 'bob').remaining, 5, 'with a full quota, not her leftovers');
    assert.equal(agentHub.standingFor(agent.id, 'alice').state, 'waiting', 'and she goes to the back');

    // Being told is the point: without this Bob would have to keep trying to
    // discover his turn had come.
    const told = frames.filter((f) => f.peerId === 'bob' && f.obj.type === 'agent-reply');
    assert.match(told.at(-1).obj.text, /Your turn/, 'the waiting peer is notified');
    assert.ok(
      frames.some((f) => f.peerId === 'bob' && f.obj.type === 'agent-queue' && f.obj.state === 'active'),
      'and their roster card is updated'
    );
  } finally {
    Date.now = realNow;
  }
});

test('an idle holder yields so one peer cannot block the queue forever', async () => {
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => t;
  try {
    const { hub, agentHub, log } = makeHub();
    const { agent } = await agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
    await agentHub.setSharing(agent.id, { networkWide: true });
    hub.send = () => true;

    joinPeer(hub, 'alice');
    joinPeer(hub, 'bob');

    t += 4000;
    await ask(agentHub, 'alice', 1, log);
    t += 4000;
    await ask(agentHub, 'bob', 1, log); // queued behind Alice
    assert.equal(agentHub.standingFor(agent.id, 'bob').state, 'waiting');

    // Alice walks away mid-turn with quota to spare.
    t += 61000;
    assert.equal(await ask(agentHub, 'bob', 1, log), 1, 'the abandoned turn is released');
    assert.equal(agentHub.standingFor(agent.id, 'bob').state, 'active');
  } finally {
    Date.now = realNow;
  }
});

test('a forged sender id is replaced by the socket it actually arrived on', () => {
  const bus = new EventEmitter();
  const seen = [];
  bus.on('peer-message', (m) => seen.push(m));

  // Mirrors the re-stamping both inbound paths perform before the app bus.
  const deliverFromSocket = (boundPeerId, frame) => {
    if (!boundPeerId) return;
    bus.emit('peer-message', { ...frame, from: boundPeerId });
  };

  deliverFromSocket('mallory', { type: 'chat', from: 'alice', text: 'transfer the funds' });
  assert.equal(seen[0].from, 'mallory', 'attribution comes from the socket, not the payload');

  seen.length = 0;
  deliverFromSocket(null, { type: 'chat', from: 'alice', text: 'before hello' });
  assert.equal(seen.length, 0, 'a frame with no established sender is dropped');
});

test('broadcast reaches every online peer and skips the rest', () => {
  const bus = new EventEmitter();
  const hub = new PeerHub({ getIdentity: () => ({ id: 'me' }), bus });
  const sent = [];
  hub.send = (peerId) => {
    sent.push(peerId);
    return true;
  };
  hub.presenceList = () => [
    { id: 'a', online: true },
    { id: 'b', online: false },
    { id: 'c', online: true },
    { id: 'agent:1', online: true, kind: 'agent' },
  ];

  assert.deepEqual(hub.broadcast({ type: 'agent-withdraw' }), ['a', 'c', 'agent:1']);
  assert.deepEqual(hub.broadcast({ type: 'x' }, { except: ['c', 'agent:1'] }), ['a']);
  assert.ok(sent.length > 0);
});

// ---- the peer side: an agent somebody else shared with us ----

function remoteSetup() {
  const dir = tmpdir('remote');
  const bus = new EventEmitter();
  const hub = new PeerHub({ getIdentity: () => ({ id: 'me' }), bus });
  const sent = [];
  hub.send = (peerId, obj) => {
    sent.push({ peerId, obj });
    return true;
  };
  hub.presenceList = () => [{ id: 'owner', online: true, name: 'Ed' }];
  const store = new MessageStore(dir);
  return { hub, store, sent, remote: createRemoteAgents({ hub, store }) };
}

const ADVERT = { agentId: 'agent:abc', name: 'Hermes', agentKind: 'http', directChat: false };

test('a remote agent id survives a round trip and stays outside the agent: namespace', () => {
  const id = remoteAgentIdFor('owner-uuid', 'agent:abc');
  assert.deepEqual(parseRemoteAgentId(id), { ownerPeerId: 'owner-uuid', agentId: 'agent:abc' });
  // Critical: the guard in ipc.js drops wire frames whose sender is an `agent:`
  // id, and a remote agent's traffic legitimately arrives off the wire.
  assert.equal(isAgentId(id), false, 'must not collide with the local-agent namespace');
  assert.equal(isRemoteAgentId(id), true);
});

test('an agent shared without direct chat stays hidden until it is first used', () => {
  const { hub, remote, sent } = remoteSetup();
  remote.adopt('owner', ADVERT);

  assert.equal(hub.identities.has(remoteAgentIdFor('owner', 'agent:abc')), false, 'not in the roster yet');

  // Knowing about it is what lets `@Hermes` be filed locally even while hidden.
  const match = remote.matchMention('owner', '@Hermes what is the time');
  assert.ok(match, 'the mention is recognised');
  assert.equal(match.text, 'what is the time', 'the prefix is stripped');

  remote.send('owner', match.entry, match.text);
  assert.equal(sent.at(-1).peerId, 'owner', 'the frame goes to the owner, not to the agent');
  assert.equal(sent.at(-1).obj.type, 'agent-chat');
  assert.equal(sent.at(-1).obj.agentId, 'agent:abc');
  assert.ok(hub.identities.has(remoteAgentIdFor('owner', 'agent:abc')), 'using it reveals the contact');
});

test('direct chat puts a shared agent in the roster up front', () => {
  const { hub, remote } = remoteSetup();
  remote.adopt('owner', { ...ADVERT, directChat: true });
  assert.ok(hub.identities.has(remoteAgentIdFor('owner', 'agent:abc')), 'visible without being used');
});

test('a remote agent conversation is stored in its own thread, not the chat with its owner', () => {
  const { remote, store } = remoteSetup();
  const entry = remote.adopt('owner', ADVERT);
  const threadId = remoteAgentIdFor('owner', 'agent:abc');

  remote.send('owner', entry, 'what is the time');
  remote.receive('owner', { agentId: 'agent:abc', name: 'Hermes', text: '3:42pm' });

  assert.deepEqual(
    store.read(threadId).map((m) => `${m.direction}:${m.text}`),
    ['out:what is the time', 'in:3:42pm']
  );
  // The whole point: the chat with the person hosting the agent is untouched.
  assert.deepEqual(store.read('owner'), [], "the owner's human thread stays empty");
});

test('withdrawal and an owner going offline both remove the contact', () => {
  const { hub, remote } = remoteSetup();
  const threadId = remoteAgentIdFor('owner', 'agent:abc');

  remote.adopt('owner', { ...ADVERT, directChat: true });
  assert.equal(remote.drop('owner', 'agent:abc'), true);
  assert.equal(hub.identities.has(threadId), false, 'a retracted agent leaves the roster');

  remote.adopt('owner', { ...ADVERT, directChat: true });
  remote.dropOwner('owner');
  assert.equal(hub.identities.has(threadId), false, 'so does one whose owner went away');
  assert.equal(remote.resolveThread(threadId), null, 'and it can no longer be addressed');
});

test('the local-origin marker is a Symbol, so JSON from the wire cannot forge it', () => {
  // This is the property the impersonation guard in ipc.js relies on.
  assert.equal(typeof LOCAL_ORIGIN, 'symbol');
  const forged = JSON.parse('{"from":"agent:evil","type":"chat","text":"x","lanchat.agent.localOrigin":true}');
  assert.equal(forged[LOCAL_ORIGIN], undefined, 'a parsed frame can never carry the Symbol');
});
