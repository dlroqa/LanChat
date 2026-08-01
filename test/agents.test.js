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
const { describeSocketError, profilePrefix } = require('../src/main/agents/transports/http.js');
const { discoverProfiles, isLocalHost } = require('../src/main/agents/profiles.js');
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

// ---- Hermes profiles ----

test('a profile becomes a URL prefix, and no profile leaves the path alone', () => {
  assert.equal(profilePrefix(''), '', 'the server default is the bare path');
  assert.equal(profilePrefix(undefined), '');
  assert.equal(profilePrefix('lanchat'), '/p/lanchat');
  assert.equal(profilePrefix('  lanchat  '), '/p/lanchat', 'stray spacing is not part of the name');
  assert.equal(profilePrefix('/lanchat/'), '/p/lanchat', 'nor stray slashes');
  // A name is not a path: it must not be able to climb out of the prefix.
  assert.equal(profilePrefix('../v1/admin'), '/p/..%2Fv1%2Fadmin');
});

test('profiles are only offered when the agent server is on this machine', () => {
  // The names come from this machine's Hermes install, so they say nothing about
  // a server anywhere else — offering them there would be a guess.
  assert.deepEqual(discoverProfiles({ kind: 'http', baseUrl: 'http://100.85.49.69:8642' }), []);
  assert.deepEqual(discoverProfiles({ kind: 'http', baseUrl: 'http://agent-box:8642' }), []);
  assert.deepEqual(discoverProfiles({ kind: 'command', baseUrl: 'http://127.0.0.1:8642' }), []);
  assert.deepEqual(discoverProfiles({}), []);

  assert.equal(isLocalHost('http://127.0.0.1:8642'), true);
  assert.equal(isLocalHost('http://localhost:8642'), true);
  assert.equal(isLocalHost('http://10.0.0.5:8642'), false);
  assert.equal(isLocalHost('not a url'), false);
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
  await agentHub.add({ name: 'Hermes', kind: 'http', config: {}, allowedPeers: ['friend'] });

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
  await agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
  assert.equal(agentHub.routeFromPeer('stranger', `@Hermes do something`), false);
});

test('an allowlisted peer must still address the agent explicitly', async () => {
  const { agentHub } = makeHub();
  await agentHub.add({ name: 'Hermes', kind: 'http', config: {}, allowedPeers: ['friend'] });
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

    // Bob asks while Alice holds the turn: queued, not served — but kept.
    assert.equal(await ask(agentHub, 'bob', 1, log), 0, 'a waiting peer is not served');
    assert.equal(agentHub.standingFor(agent.id, 'bob').state, 'waiting');
    assert.equal(agentHub.standingFor(agent.id, 'bob').position, 1);
    assert.equal(agentHub.standingFor(agent.id, 'bob').held, true, 'his question is kept');

    // Alice is out of quota with Bob waiting, so she hands over. Nothing of hers
    // runs; the one thing that reaches the agent is the question Bob asked while
    // he was still in line.
    assert.equal(await ask(agentHub, 'alice', 1, log), 1, 'a spent turn is not extended');
    assert.equal(log[log.length - 1], 'q0', "and Bob's held question was read instead");
    assert.equal(agentHub.standingFor(agent.id, 'bob').state, 'active', 'the turn passed to Bob');
    assert.equal(agentHub.standingFor(agent.id, 'bob').held, false, 'nothing is held any more');
    assert.equal(agentHub.standingFor(agent.id, 'alice').state, 'waiting');

    // Reading it cost him nothing: the wait was what it cost.
    assert.equal(agentHub.standingFor(agent.id, 'bob').remaining, 5, 'and it was free');

    // And Bob gets his own full quota — the same limit, not the remainder. The
    // sixth run is Alice's: spending his last query hands the turn back to her,
    // and the question she asked on the way out is read the moment it lands.
    assert.equal(await ask(agentHub, 'bob', 5, log), 6);
    assert.equal(agentHub.standingFor(agent.id, 'alice').state, 'active');
    assert.equal(agentHub.standingFor(agent.id, 'alice').remaining, 5);
  });
});

test('a peer who keeps asking out of turn cannot flood the agent thread', async () => {
  // The asking machine refuses a second attempt itself, so this is the case it
  // cannot cover: a peer that does not, whether because it is running an older
  // build or because it was told to keep trying. The thread the agent's next
  // answer is read against must stay the questions that were actually asked.
  //
  // The clock is stepped by hand rather than with withFakeClock, which advances
  // on every read and would run the holder past the idle timeout mid-test.
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => t;
  try {
    const { hub, agentHub, log } = makeHub();
    const { agent } = await agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
    await agentHub.setSharing(agent.id, { networkWide: true });

    const asked = [];
    hub.bus.on('agent-request', (r) => asked.push(r.text));
    hub.send = () => true;
    joinPeer(hub, 'alice');
    joinPeer(hub, 'bob');

    // Alice takes the turn; Bob queues behind her and will not stop asking. Each
    // attempt is spaced past the anti-flood interval, so what is under test is
    // the held slot and not the throttle.
    t += 4000;
    await ask(agentHub, 'alice', 1, log);
    for (const q of ['first question', 'second question', 'third question']) {
      t += 4000;
      agentHub.routeFromPeer('bob', `@Hermes ${q}`);
      await new Promise((r) => setImmediate(r));
    }

    assert.deepEqual(
      asked.filter((x) => x.endsWith('question')),
      ['first question'],
      'only the question that was kept is written down'
    );
    assert.equal(log.length, 1, 'and none of them reached the agent while Alice held the turn');

    // Alice spends the rest of her turn, which hands it to Bob. What the agent
    // then reads is the question he asked first, not the last thing he shouted.
    for (let i = 0; i < 4; i += 1) {
      t += 4000;
      await ask(agentHub, 'alice', 1, log);
    }
    assert.ok(log.includes('first question'), 'the held question is what gets answered');
    assert.ok(!log.includes('third question'), 'and the repeats never arrive at all');
  } finally {
    Date.now = realNow;
  }
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

    // The nag is once per turn, but the countdown keeps being re-sent so both
    // sides stay locked to the same deadline and can recover a dropped frame.
    frames.length = 0;
    t += 5000;
    agentHub.releaseIdleTurns();
    assert.equal(
      frames.filter((f) => f.obj.type === 'agent-reply').length,
      0,
      'the warning message does not repeat'
    );
    const refresh = frames.filter((f) => f.peerId === 'alice' && f.obj.type === 'agent-queue');
    assert.equal(refresh.length, 1, 'but the standing is refreshed');
    assert.ok(refresh[0].obj.expiresInSec < 20, 'and the clock has moved on');

    // Acting on the warning keeps the turn and resets the countdown.
    t += 4000;
    assert.equal(await ask(agentHub, 'alice', 1, log), 1, 'she can still use it');
    assert.equal(agentHub.standingFor(agent.id, 'alice').expiring, false, 'the countdown resets');
    assert.equal(agentHub.standingFor(agent.id, 'bob').state, 'waiting', 'and Bob keeps waiting');
  } finally {
    Date.now = realNow;
  }
});

test('the holder and whoever is next count down to the same handover', async () => {
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
    joinPeer(hub, 'carol');

    t += 4000;
    await ask(agentHub, 'alice', 1, log);
    t += 4000;
    await ask(agentHub, 'bob', 1, log);
    t += 4000;
    await ask(agentHub, 'carol', 1, log);

    // Nothing is counting down yet — the holder is still within her time.
    assert.equal(agentHub.standingFor(agent.id, 'alice').expiring, false);
    assert.equal(agentHub.standingFor(agent.id, 'bob').expiring, false);

    t += 45000; // past the warning point, before the handover
    frames.length = 0;
    agentHub.releaseIdleTurns();

    const alice = agentHub.standingFor(agent.id, 'alice');
    const bob = agentHub.standingFor(agent.id, 'bob');
    const carol = agentHub.standingFor(agent.id, 'carol');

    // Both sides of the handover are told the same number of seconds, so their
    // countdowns agree without their clocks having to.
    assert.equal(alice.expiring, true, 'the holder is losing it');
    assert.equal(bob.expiring, true, 'and the person next in line is gaining it');
    assert.equal(bob.expiresInSec, alice.expiresInSec, 'the same countdown on both sides');
    assert.ok(alice.expiresInSec > 0 && alice.expiresInSec <= 20);

    // Only whoever is actually next inherits the turn, so nobody else counts.
    assert.equal(carol.state, 'waiting');
    assert.equal(carol.position, 2);
    assert.equal(carol.expiring, false, 'second in line has nothing to count down to');

    // Both are told over the wire, not left to poll.
    for (const who of ['alice', 'bob']) {
      const q = frames.filter((f) => f.peerId === who && f.obj.type === 'agent-queue').at(-1);
      assert.ok(q, `${who} is sent their standing`);
      assert.equal(q.obj.expiring, true);
      assert.equal(q.obj.expiresInSec, alice.expiresInSec);
    }

    // Acting on the warning cancels it for everyone.
    t += 4000;
    await ask(agentHub, 'alice', 1, log);
    assert.equal(agentHub.standingFor(agent.id, 'alice').expiring, false);
    assert.equal(agentHub.standingFor(agent.id, 'bob').expiring, false, 'the waiter stops counting too');
  } finally {
    Date.now = realNow;
  }
});

test('a remote asker is told when the agent starts and stops working', async () => {
  const { hub, agentHub } = makeHub();
  const { agent } = await agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
  await agentHub.setSharing(agent.id, { networkWide: true });
  const frames = [];
  hub.send = (peerId, obj) => {
    frames.push({ peerId, obj });
    return true;
  };
  joinPeer(hub, 'friend');

  agentHub.routeFromPeer('friend', '@Hermes do something');
  await new Promise((r) => setImmediate(r));

  // Without this a peer sees only "online" and silence, with no way to tell
  // thinking from stuck.
  const activity = frames.filter((f) => f.obj.type === 'agent-activity').map((f) => f.obj.busy);
  assert.deepEqual(activity, [true, false], 'busy on the way in, idle again on the way out');
  assert.ok(
    frames.every((f) => f.peerId === 'friend'),
    'activity goes only to the peer who asked'
  );
});

test('two idle peers keep their places and stop being told about a turn neither is using', async () => {
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
    const said = () => frames.filter((f) => f.obj.type === 'agent-reply');
    joinPeer(hub, 'alice');
    joinPeer(hub, 'bob');

    t += 4000;
    await ask(agentHub, 'alice', 1, log);
    t += 4000;
    await ask(agentHub, 'bob', 1, log); // queued behind her

    // Alice sits out her whole turn. Bob inherits it.
    t += 61000;
    agentHub.releaseIdleTurns();
    assert.equal(agentHub.standingFor(agent.id, 'bob').state, 'active');
    assert.equal(agentHub.standingFor(agent.id, 'alice').state, 'waiting', 'she goes to the back');

    // Bob then sits out his entire turn without asking anything at all. The turn
    // he never wanted must not cost him the place he queued for.
    t += 61000;
    agentHub.releaseIdleTurns();
    assert.equal(agentHub.standingFor(agent.id, 'alice').state, 'active', 'the turn moves on');
    assert.equal(
      agentHub.standingFor(agent.id, 'bob').state,
      'waiting',
      'and he keeps his place rather than dropping out of the queue'
    );

    // From here neither is using the agent, so neither is told about it again —
    // the turn goes on circulating, in silence.
    frames.length = 0;
    for (let i = 0; i < 5; i += 1) {
      t += 61000;
      agentHub.releaseIdleTurns();
      assert.equal(
        agentHub.standingFor(agent.id, i % 2 === 0 ? 'bob' : 'alice').state,
        'active',
        'the turn is still genuinely rotating between them'
      );
    }
    assert.deepEqual(said(), [], 'and neither peer is messaged on any of those handovers');
    assert.ok(
      frames.some((f) => f.obj.type === 'agent-queue'),
      'their standing is still published, so the roster stays accurate'
    );

    // Coming back makes them audible again: Bob asks, sits out one more turn,
    // and is told when it comes round to him.
    t += 4000;
    await ask(agentHub, 'bob', 1, log);
    frames.length = 0;
    t += 61000;
    agentHub.releaseIdleTurns(); // Bob's turn passes to Alice
    t += 61000;
    agentHub.releaseIdleTurns(); // and back to Bob, who used it last time round
    assert.ok(
      said().some((f) => f.peerId === 'bob' && /Your turn/.test(f.obj.text)),
      'a peer who has used the agent is told when the turn reaches them'
    );
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
    assert.ok(
      told.some((f) => /Your turn/.test(f.obj.text)),
      'the waiting peer is notified'
    );
    // And it is not just an invitation to ask again: the question he asked while
    // he was still in line is answered the moment the turn lands.
    assert.equal(told.at(-1).obj.text, 'echo:q0', 'his held question was read');
    assert.equal(agentHub.standingFor(agent.id, 'bob').held, false);
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

// The turn is passed on, never taken away — including when nobody was waiting to
// trigger the sweep, so the takeover happens on the next peer's question
// instead. Getting this wrong left the outgoing holder outside the queue
// entirely, which meant nothing was ever addressed to them again and their card
// went on claiming a turn that had moved on.
test('a turn taken over after a silence leaves the outgoing holder next in line', async () => {
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

    // Alice has the agent to herself: two queries, nobody queued behind her, so
    // no sweep ever warns her or moves the turn along.
    t += 4000;
    await ask(agentHub, 'alice', 1, log);
    t += 4000;
    await ask(agentHub, 'alice', 1, log);
    assert.equal(agentHub.standingFor(agent.id, 'alice').remaining, 3);

    // She wanders off. A minute later Bob turns up and asks.
    frames.length = 0;
    t += 61000;
    assert.equal(await ask(agentHub, 'bob', 1, log), 1, 'the newcomer is served straight away');

    assert.equal(agentHub.standingFor(agent.id, 'bob').state, 'active', 'and holds the turn');
    const alice = agentHub.standingFor(agent.id, 'alice');
    assert.equal(alice.state, 'waiting', 'while she is put in the queue, not dropped from it');
    assert.equal(alice.position, 1, 'at the front of it, since nobody else is waiting');
    assert.equal(alice.ahead, 4, 'with what Bob has left standing between her and the agent');

    // The point of the requeue: she is a participant again, so the correction
    // actually reaches her.
    const hers = frames.filter((f) => f.peerId === 'alice' && f.obj.type === 'agent-queue');
    assert.equal(hers.at(-1).obj.state, 'waiting', 'her card is told the turn has moved');
    assert.equal(hers.at(-1).obj.position, 1);

    // And she is told why, since the idle warning never fired for her — there
    // was nobody waiting at the time for it to fire about.
    const told = frames.filter((f) => f.peerId === 'alice' && f.obj.type === 'agent-reply');
    assert.match(told.at(-1).obj.text, /#1 in line/);
    assert.equal(told.at(-1).obj.notice, true, 'as a notice, shown once rather than kept');
  } finally {
    Date.now = realNow;
  }
});

test('a peer who never used the turn they were handed is not told when it goes', async () => {
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
    await ask(agentHub, 'bob', 1, log); // queued behind her

    // Alice sits out her turn, so Bob inherits one he never asked for.
    t += 61000;
    agentHub.releaseIdleTurns();
    assert.equal(agentHub.standingFor(agent.id, 'bob').state, 'active');

    // Alice comes back and takes it over. Bob has shown he is not reading, so
    // he keeps his place and hears nothing about it.
    frames.length = 0;
    t += 61000;
    await ask(agentHub, 'alice', 1, log);

    assert.equal(agentHub.standingFor(agent.id, 'bob').state, 'waiting', 'he keeps his place');
    assert.equal(agentHub.standingFor(agent.id, 'bob').position, 1);
    assert.ok(
      frames.some((f) => f.peerId === 'bob' && f.obj.type === 'agent-queue' && f.obj.state === 'waiting'),
      'his card still tracks the queue accurately'
    );
    assert.deepEqual(
      frames.filter((f) => f.peerId === 'bob' && f.obj.type === 'agent-reply'),
      [],
      'but nothing is said to him about a turn he never used'
    );
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

// ---- finding the agent's executable ----

// A GUI-launched Electron process does not see the PATH a shell would give it,
// so a bare `hermes` fails with ENOENT on a machine where `hermes` is installed
// and on the user's own PATH. These pin the fallback that fixes it — and, just
// as importantly, that it stays a *fallback* and never rewrites what the user
// typed.
function freshResolve() {
  const id = require.resolve('../src/main/agents/transports/resolve.js');
  delete require.cache[id];
  return require(id);
}

// A temp dir holding an executable, plus a stand-in login shell that reports
// that dir as the user's PATH — the shape of the real problem, where the
// binary exists somewhere only the shell knows about.
function fakeShellEnv() {
  const dir = tmpdir('resolve');
  const bin = path.join(dir, 'fakeagent');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(bin, 0o755);

  const shell = path.join(dir, 'fakeshell');
  // Prints a banner first: rc files do that, and the PATH must still be read
  // off the last line rather than the first.
  fs.writeFileSync(shell, `#!/bin/sh\necho "welcome to the shell"\necho "${dir}:/usr/bin"\n`);
  fs.chmodSync(shell, 0o755);
  return { dir, bin, shell };
}

test('a command already on PATH is left alone for spawn to find', () => {
  const { resolveExecutable } = freshResolve();
  assert.equal(resolveExecutable('sh'), 'sh');
});

test('a command the user typed as a path is honoured exactly', () => {
  const { resolveExecutable } = freshResolve();
  // Even one that does not exist: resolving it against anything else would run
  // a different program than the one they named.
  assert.equal(resolveExecutable('/opt/hermes/bin/hermes'), '/opt/hermes/bin/hermes');
  assert.equal(resolveExecutable('./hermes'), './hermes');
});

test('a command found only on the login shell PATH resolves to an absolute path', (t) => {
  if (process.platform === 'win32') return;
  const { dir, bin, shell } = fakeShellEnv();
  const oldPath = process.env.PATH;
  const oldShell = process.env.SHELL;
  t.after(() => {
    process.env.PATH = oldPath;
    process.env.SHELL = oldShell;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  process.env.PATH = '/nonexistent-lanchat-test';
  process.env.SHELL = shell;
  const { resolveExecutable } = freshResolve();
  assert.equal(resolveExecutable('fakeagent'), bin);
});

test('a command that exists nowhere comes back unchanged, so the error names what was typed', (t) => {
  const oldPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = oldPath;
  });
  process.env.PATH = '/nonexistent-lanchat-test';
  const { resolveExecutable } = freshResolve();
  assert.equal(resolveExecutable('lanchat-no-such-agent-binary'), 'lanchat-no-such-agent-binary');
});

// ---- what a failure says, and to whom ----

test('a missing ACP command fails with a fix rather than with ENOENT', async () => {
  const { createAcpTransport } = require('../src/main/agents/transports/acp.js');
  const transport = createAcpTransport({
    id: 'agent:x',
    name: 'Missing',
    config: { command: 'lanchat-no-such-agent-binary', args: ['acp'] },
    timeoutMs: 5000,
  });

  await assert.rejects(
    () => transport.start(),
    (err) => {
      assert.match(err.detail, /Command not found: lanchat-no-such-agent-binary/);
      assert.match(err.detail, /full path/, 'and says what to do about it');
      assert.doesNotMatch(err.message, /ENOENT/, 'Node’s own wording never reaches the user');
      return true;
    }
  );
  await transport.stop();
});

test('a peer is told the agent failed, but never what is on this machine', async () => {
  const dir = tmpdir('detail');
  const bus = new EventEmitter();
  const hub = new PeerHub({ getIdentity: () => ({ id: 'me', name: 'Me' }), bus });
  const store = new MessageStore(dir);

  const SECRET = '/home/someone/.local/bin/hermes';
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
        send: async (_msg, h) => {
          const err = new Error('The agent could not be started.');
          err.detail = `Command not found: ${SECRET}.`;
          h.onError?.(err);
        },
        stop: async () => {},
      }),
    },
  });

  const { agent } = await agentHub.add({ name: 'Hermes', kind: 'http', config: {}, allowedPeers: ['friend'] });
  assert.ok(agent);

  const local = [];
  bus.on('peer-message', (m) => local.push(m.text));
  const relayed = [];
  hub.send = (peerId, obj) => {
    relayed.push({ peerId, obj });
    return true;
  };

  agentHub.routeFromPeer('friend', '@Hermes hello');
  await new Promise((r) => setImmediate(r));

  const toPeer = relayed.filter((r) => r.obj.type === 'agent-reply').map((r) => r.obj.text);
  assert.equal(toPeer.length, 1, 'the peer is answered');
  assert.doesNotMatch(toPeer[0], /home\/someone/, 'but never sees a path from this machine');
  assert.doesNotMatch(toPeer[0], /Command not found/, 'nor which command is missing');
  assert.match(toPeer[0], /could not be started/, 'only that it failed');

  assert.ok(
    local.some((text) => text.includes(SECRET)),
    'while the owner gets the detail that tells them how to fix it'
  );
});

// ---- form copy ----

// ESM for the renderer; drop the export keywords and evaluate it, the way
// statusMotion.test.js does. There is no JSX transform in the test runner, so
// this is the only way the strings can be asserted at all.
test('the ACP arguments hint does not tell users to write {prompt}', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'lib', 'agentCopy.js'), 'utf8');
  const { argumentHint, argumentPlaceholder } = new Function(
    `${src.replace(/^export\s+/gm, '')}
     return { argumentHint, argumentPlaceholder };`
  )();

  assert.match(argumentHint('command'), /\{prompt\}/, 'a local command really does take it');
  assert.doesNotMatch(argumentHint('acp'), /\{prompt\}/, 'an ACP agent never does');
  assert.match(argumentHint('acp'), /travels over ACP/, 'and is told where the message goes instead');
  assert.equal(argumentPlaceholder('acp'), 'acp');
});

// The reported failure itself, against the real agent rather than a stand-in.
// Off by default: it needs Hermes installed and configured, and the adapter
// spends several seconds loading its environment and MCP servers before it
// answers `initialize`. Run with LANCHAT_ACP_LIVE=1.
test('a real ACP agent starts from a PATH that does not contain it', { skip: !process.env.LANCHAT_ACP_LIVE }, async (t) => {
  const { createAcpTransport } = require('../src/main/agents/transports/acp.js');
  const oldPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = oldPath;
  });
  // Exactly what a GUI-launched Electron process sees: no per-user bin dir.
  process.env.PATH = (oldPath || '')
    .split(path.delimiter)
    .filter((d) => d && !d.includes(`${path.sep}.local${path.sep}bin`))
    .join(path.delimiter);

  const transport = createAcpTransport({
    id: 'agent:live',
    name: 'Hermes',
    config: { command: 'hermes', args: ['acp'] },
    timeoutMs: 90000,
  });
  try {
    const info = await transport.start();
    assert.match(info.detail, /ACP session with/);
  } finally {
    await transport.stop();
  }
});

// ---- ACP against a scripted agent ----

// A stand-in ACP agent, so the paths that only appear when an agent behaves
// unusually — a protocol version we do not speak, a session that will not open,
// a run that stops without producing anything — can be driven on demand. The
// real Hermes cannot be asked to do any of these.
const FAKE_ACP = `
const cfg = JSON.parse(process.argv[2] || '{}');
if (cfg.stderr) process.stderr.write(cfg.stderr + '\\n');
if (cfg.exitImmediately) process.exit(3);
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  const lines = buf.split('\\n');
  buf = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: cfg.protocolVersion === undefined ? 1 : cfg.protocolVersion,
        agentInfo: { name: 'fake-agent', version: '0' },
        authMethods: cfg.authMethods || [],
      } });
    } else if (msg.method === 'session/new') {
      if (cfg.sessionFails) send({ jsonrpc: '2.0', id: msg.id, error: { message: 'not configured' } });
      else send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } });
    } else if (msg.method === 'session/prompt') {
      // An update kind this client has never modelled. Ignoring it must stay
      // harmless — a future agent will send kinds we have not seen.
      send({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'usage_update', used: 1 } } });
      for (const t of cfg.chunks || []) {
        send({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: t } } } });
      }
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: cfg.stopReason || 'end_turn' } });
    }
  }
});
`;

function fakeAcp(cfg = {}) {
  const dir = tmpdir('fakeacp');
  const file = path.join(dir, 'fake-acp.js');
  fs.writeFileSync(file, FAKE_ACP);
  const { createAcpTransport } = require('../src/main/agents/transports/acp.js');
  const transport = createAcpTransport({
    id: 'agent:fake',
    name: 'Fake',
    config: { command: process.execPath, args: [file, JSON.stringify(cfg)] },
    timeoutMs: 8000,
  });
  return { transport, dir };
}

test('an agent speaking a newer ACP than we do is refused rather than misunderstood', async () => {
  const { transport } = fakeAcp({ protocolVersion: 99 });
  await assert.rejects(
    () => transport.start(),
    (err) => {
      assert.match(err.message, /newer version of ACP/);
      assert.match(err.detail, /v99/, 'and the detail names both versions');
      return true;
    }
  );
  await transport.stop();
});

test('an agent that answers with no protocol version, or an older one, still works', async () => {
  for (const protocolVersion of [undefined, 0]) {
    const { transport } = fakeAcp({ protocolVersion });
    const info = await transport.start();
    assert.match(info.detail, /ACP session with fake-agent/);
    await transport.stop();
  }
});

test('a session that will not open names the ways the agent says it can be set up', async () => {
  const { transport } = fakeAcp({
    sessionFails: true,
    authMethods: [
      { id: 'hermes-setup', name: 'Configure Hermes provider', description: 'secret prose about providers' },
    ],
  });
  await assert.rejects(
    () => transport.start(),
    (err) => {
      assert.match(err.message, /did not start a session/);
      assert.match(err.detail, /Configure Hermes provider/, 'the method is named');
      assert.doesNotMatch(err.detail, /secret prose/, 'but its description is not repeated');
      return true;
    }
  );
  await transport.stop();
});

test('an agent that dies on startup explains itself instead of timing out', async () => {
  const { transport } = fakeAcp({ exitImmediately: true, stderr: 'config file is unreadable' });
  await assert.rejects(
    () => transport.start(),
    (err) => {
      assert.match(err.message, /stopped unexpectedly/);
      assert.match(err.detail, /config file is unreadable/, 'stderr is kept for the owner');
      return true;
    }
  );
  await transport.stop();
});

test('a run that stops without answering says why, and one that answers is left alone', async () => {
  const refused = fakeAcp({ stopReason: 'refusal' });
  await refused.transport.start();
  await new Promise((resolve) => {
    refused.transport.send({ text: 'hi' }, { onDone: resolve, onError: resolve });
  }).then((r) => assert.match(r.text, /declined to answer/));
  await refused.transport.stop();

  // An unknown reason is reported rather than swallowed.
  const odd = fakeAcp({ stopReason: 'something_new' });
  await odd.transport.start();
  await new Promise((resolve) => {
    odd.transport.send({ text: 'hi' }, { onDone: resolve, onError: resolve });
  }).then((r) => assert.match(r.text, /stopped early \(something_new\)/));
  await odd.transport.stop();

  // A real answer is never second-guessed by the reason the run ended, and the
  // unmodelled `usage_update` the agent also sent is simply ignored.
  const answered = fakeAcp({ stopReason: 'max_tokens', chunks: ['the ', 'answer'] });
  await answered.transport.start();
  await new Promise((resolve) => {
    answered.transport.send({ text: 'hi' }, { onDone: resolve, onError: resolve });
  }).then((r) => assert.equal(r.text, 'the answer'));
  await answered.transport.stop();
});

// ---- summoning: a bare @name ----
//
// A bare `@name` used to be handed to the question path with an empty prompt. It
// spent one of the asker's five queries, ran the agent on nothing, and the run of
// nothing came back as the word "(no output)" — an error report at the exact
// moment somebody was trying to find out whether the channel worked at all.
//
// These tests hold the two halves of the fix apart: that a summon is *answered*,
// and that it costs nothing.

// Every outbound frame the hub would have put on the wire.
function captureSend(hub) {
  const relayed = [];
  hub.send = (peerId, obj) => {
    relayed.push({ peerId, obj });
    return true;
  };
  return relayed;
}

async function summonHub(opts = {}) {
  const h = makeHub(opts);
  const { agent } = await h.agentHub.add({
    name: 'Hermes',
    kind: 'http',
    config: {},
    allowedPeers: ['friend'],
  });
  joinPeer(h.hub, 'friend');
  return { ...h, agent, relayed: captureSend(h.hub) };
}

test('a bare @name is a trigger: nothing is run, and nothing is said', async () => {
  const { agentHub, hub, log, relayed, bus, agent } = await summonHub();
  const requests = [];
  bus.on('agent-request', (r) => requests.push(r));

  assert.equal(agentHub.routeFromPeer('friend', '@Hermes'), true, 'the summon is consumed');
  await new Promise((r) => setImmediate(r));

  // No prompt of nothing, so no run of nothing.
  assert.deepEqual(log, [], 'the transport was never run');

  // And no words either way. `@Hermes` is how you open an agent rather than
  // something anybody said, so neither half of it is written down: not the
  // synthesised `@name` bubble, and not a greeting to sit under it.
  assert.deepEqual(
    relayed.filter((r) => r.obj.type === 'agent-reply'),
    [],
    'no greeting goes back'
  );
  assert.deepEqual(requests, [], 'and nothing is filed in the agent thread');

  // What it does produce is the one thing a summon is for: the thread exists, so
  // the agent is there to be opened.
  assert.ok(
    hub.identities.has(`${agent.id}#friend`),
    'the delegate thread is on the roster, ready to be opened'
  );
});

test('a summon spends no turn, so the introduction does not cost the first question', async () => {
  await withFakeClock(async () => {
    const { agentHub, agent, log, relayed } = await summonHub();

    agentHub.routeFromPeer('friend', '@Hermes');
    await new Promise((r) => setImmediate(r));

    const standing = agentHub.standingFor(agent.id, 'friend');
    assert.equal(standing.state, 'idle', 'saying hello does not make you the holder');
    assert.equal(standing.remaining, agentHub.TURN_QUOTA, 'and costs none of the quota');
    assert.equal(standing.position, 0, 'nor does it put you in the queue');
    assert.equal(
      relayed.filter((r) => r.obj.type === 'agent-queue').length,
      0,
      'no queue standing is published for somebody who is not in the queue'
    );

    // And the five are all still there afterwards.
    assert.equal(await ask(agentHub, 'friend', 5, log), 5, 'the full quota survived the greeting');
  });
});

test('a summon never displaces a turn-holder and never joins the queue', async () => {
  await withFakeClock(async () => {
    const { hub, agentHub, agent, log } = makeHub();
    const { agent: rec } = { agent: (await agentHub.add({ name: 'Hermes', kind: 'http', config: {} })).agent };
    await agentHub.setSharing(rec.id, { networkWide: true });
    joinPeer(hub, 'alice');
    joinPeer(hub, 'bob');
    captureSend(hub);

    // Alice takes the turn with a real question.
    assert.equal(await ask(agentHub, 'alice', 2, log), 2);
    const before = agentHub.standingFor(rec.id, 'alice');

    // Bob only says hello.
    agentHub.routeFromPeer('bob', '@Hermes');
    await new Promise((r) => setImmediate(r));

    const after = agentHub.standingFor(rec.id, 'alice');
    assert.equal(after.state, 'active', 'the holder still holds it');
    assert.equal(after.remaining, before.remaining, 'and has lost nothing off her quota');

    const bob = agentHub.standingFor(rec.id, 'bob');
    assert.equal(bob.state, 'idle', 'the summoner did not join the line');
    assert.equal(bob.held, false, 'and left no question waiting to be read');
    assert.deepEqual(log, ['q0', 'q1'], 'only the real questions ever ran');
    void agent;
  });
});

test('a summon from a peer who may not reach the agent gets nothing at all', async () => {
  // Not on the allowlist.
  {
    const { agentHub, agent, hub, relayed, log } = await summonHub();
    joinPeer(hub, 'stranger');
    assert.equal(agentHub.routeSummon('stranger', agent.id), false, 'closed by default');
    assert.equal(agentHub.routeFromPeer('stranger', '@Hermes'), false, 'and by @name too');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(relayed, [], 'nothing is sent to somebody with no grant');
    assert.deepEqual(log, []);
    assert.equal(hub.identities.has(`${agent.id}#stranger`), false, 'and no thread is created for them');
  }

  // Switched off: the toggle is a hard gate, allowlist or not.
  {
    const { agentHub, agent, relayed } = await summonHub();
    await agentHub.setEnabled(agent.id, false);
    relayed.length = 0;
    assert.equal(agentHub.routeSummon('friend', agent.id), false);
    assert.deepEqual(
      relayed.filter((r) => r.obj.type === 'agent-reply'),
      [],
      'a disabled agent does not greet anyone'
    );
  }

  // Configured, allowed, but the transport never came up.
  {
    const { agentHub, agent, relayed } = await summonHub({ startError: 'nope' });
    assert.equal(agentHub.routeSummon('friend', agent.id), false, 'an agent that is not running cannot answer');
    assert.deepEqual(relayed.filter((r) => r.obj.type === 'agent-reply'), []);
  }

  // An id nobody has.
  {
    const { agentHub } = await summonHub();
    assert.equal(agentHub.routeSummon('friend', 'agent:does-not-exist'), false);
  }
});

test('a summon flood is absorbed, and still never lands in the human chat', async () => {
  const { agentHub, log, relayed, bus } = await summonHub();
  const requests = [];
  bus.on('agent-request', (r) => requests.push(r));

  const returns = [];
  for (let i = 0; i < 20; i += 1) returns.push(agentHub.routeFromPeer('friend', '@Hermes'));
  await new Promise((r) => setImmediate(r));

  // Nothing is said now, so the throttle is no longer about words. It is about
  // the roster: ensureDelegateIdentity touches it, and republishing presence
  // twenty times on twenty keystrokes is a denial of service whether or not any
  // text comes with it.
  assert.deepEqual(relayed.filter((r) => r.obj.type === 'agent-reply'), [], 'nothing is said back');
  assert.deepEqual(requests, [], 'and nothing is written down');
  assert.deepEqual(log, [], 'nothing was ever run');
  // The load-bearing one. ipc.js reads this return value to decide whether the
  // message was consumed; a `false` here would drop a bare `@Hermes` into the
  // owner's chat with the peer — the one place agent traffic must never go.
  assert.deepEqual(
    [...new Set(returns)],
    [true],
    'every summon is consumed, including the ones the throttle swallowed'
  );
});

test('a summon is not throttled against the question it invites', async () => {
  const { agentHub, log } = await summonHub();

  // The greeting says "ask me anything", so the next thing that happens is
  // somebody asking. Sharing one throttle key made that question vanish.
  assert.equal(agentHub.routeFromPeer('friend', '@Hermes'), true);
  await new Promise((r) => setImmediate(r));
  assert.equal(agentHub.routeFromPeer('friend', '@Hermes are you there'), true);
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(log, ['are you there'], 'the invitation did not swallow the reply to it');
});

test('a run that finishes silently is signalled, not written down as an error', async () => {
  const dir = tmpdir('silent');
  const bus = new EventEmitter();
  const hub = new PeerHub({ getIdentity: () => ({ id: 'me', name: 'Me' }), bus });
  const store = new MessageStore(dir);
  const agentHub = createAgentHub({
    userDataDir: dir,
    hub,
    bus,
    store,
    safeStorage: fakeSafeStorage,
    // A CLI that exits 0 having printed nothing, or an ACP session that stops for
    // a normal reason having said nothing. Both are real outcomes, not faults.
    transports: {
      http: ({ id, name }) => ({
        id,
        name,
        kind: 'stub',
        start: async () => ({ detail: 'ready' }),
        send: async (_msg, h) => h.onDone?.({ text: '' }),
        stop: async () => {},
      }),
    },
  });
  const { agent } = await agentHub.add({ name: 'Quiet', kind: 'http', config: {} });

  const messages = [];
  const empties = [];
  bus.on('peer-message', (m) => messages.push(m));
  bus.on('agent-empty', (e) => empties.push(e));

  hub.send(agent.id, { type: 'chat', text: 'say nothing' });
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(messages, [], 'no bubble is produced for an answer that does not exist');
  assert.deepEqual(
    empties,
    [{ threadId: agent.id, agentId: agent.id, agentName: 'Quiet' }],
    'the window is told, in the thread it happened in, and by whom'
  );
  assert.deepEqual(store.read(agent.id), [], 'and nothing is written to disk');
});

// ---- Hermes profiles ----

test('a profile becomes a leading flag, and only for Hermes', () => {
  const { hermesLaunchArgs } = require('../src/main/agents/profiles.js');
  assert.deepEqual(
    hermesLaunchArgs({ command: 'hermes', args: ['acp'], profile: 'lanchat' }),
    ['--profile', 'lanchat', 'acp']
  );
  assert.deepEqual(
    hermesLaunchArgs({ command: '/home/me/.local/bin/hermes', args: [], profile: 'lanchat' }),
    ['--profile', 'lanchat', 'acp'],
    'and the subcommand is supplied when Arguments was left blank'
  );
  assert.deepEqual(
    hermesLaunchArgs({ command: 'hermes', args: ['acp'], profile: '' }),
    ['acp'],
    'no profile, no flag'
  );
  // The stale-config case: the profile outlives a command that was changed.
  assert.deepEqual(
    hermesLaunchArgs({ command: 'claude-code-acp', args: [], profile: 'lanchat' }),
    [],
    'a leftover profile is never handed to an agent that would choke on it'
  );
});

test('a profile name that could be read as another flag is refused', () => {
  const { hermesLaunchArgs } = require('../src/main/agents/profiles.js');
  for (const bad of ['--yolo', '-p', 'has space', 'UPPER', '../etc', 'x'.repeat(65)]) {
    assert.throws(
      () => hermesLaunchArgs({ command: 'hermes', args: ['acp'], profile: bad }),
      /not a valid Hermes profile name/,
      `${bad} must not reach argv`
    );
  }
});

test('ACP profiles are discovered from this machine, but only for Hermes', () => {
  const { discoverProfiles } = require('../src/main/agents/profiles.js');
  const home = tmpdir('hermeshome');
  fs.mkdirSync(path.join(home, 'profiles', 'iris'), { recursive: true });
  fs.mkdirSync(path.join(home, 'profiles', 'tessie'), { recursive: true });
  const old = process.env.HERMES_HOME;
  process.env.HERMES_HOME = home;
  try {
    assert.deepEqual(discoverProfiles({ kind: 'acp', command: 'hermes' }), ['iris', 'tessie']);
    assert.deepEqual(
      discoverProfiles({ kind: 'acp', command: 'claude-code-acp' }),
      [],
      'another ACP agent is offered nothing, because --profile would break it'
    );
    // An ACP agent is a child process here, so no localhost question applies.
    assert.deepEqual(discoverProfiles({ kind: 'acp', command: 'hermes', baseUrl: undefined }), ['iris', 'tessie']);
  } finally {
    if (old === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = old;
  }
});

// ---- the row badge ----

test('the agent row shows the profile without pretending it is uppercase', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'lib', 'agentBadge.js'), 'utf8');
  const { agentTag } = new Function(`${src.replace(/^export\s+/gm, '')}\nreturn { agentTag };`)();

  const plain = agentTag({ kind: 'acp', config: {} });
  assert.equal(plain.profile, null, 'an agent with no profile gets no second half');

  const withProfile = agentTag({ kind: 'acp', config: { profile: 'lanchat' } });
  assert.equal(withProfile.kind, 'acp');
  assert.equal(withProfile.profile, 'lanchat', 'kept exactly as the user chose it');
  assert.match(withProfile.title, /Hermes profile: lanchat/, 'and explained on hover');

  // The same field exists on an HTTP agent and was never surfaced before.
  assert.equal(agentTag({ kind: 'http', config: { profile: 'iris' } }).profile, 'iris');

  const long = agentTag({ kind: 'acp', config: { profile: 'a'.repeat(64) } });
  assert.equal(long.truncated, true, 'a name too long for the row is marked for cutting');
  assert.match(long.title, /a{64}/, 'but the whole of it stays on the title');
});

test('sharing an agent tells the peer it exists and nothing about how it is run', async () => {
  const dir = tmpdir('advert');
  const bus = new EventEmitter();
  const hub = new PeerHub({ getIdentity: () => ({ id: 'me', name: 'Me' }), bus });
  const agentHub = createAgentHub({
    userDataDir: dir,
    hub,
    bus,
    store: new MessageStore(dir),
    safeStorage: fakeSafeStorage,
    transports: {
      acp: ({ id, name }) => ({
        id,
        name,
        kind: 'acp',
        start: async () => ({ detail: 'ready' }),
        send: async () => {},
        stop: async () => {},
      }),
    },
  });
  await agentHub.add({
    name: 'Hermes',
    kind: 'acp',
    config: { command: '/home/me/.local/bin/hermes', args: ['acp'], cwd: '/home/me/secrets', profile: 'lanchat' },
    allowedPeers: ['friend'],
  });

  const sent = [];
  // An entitled peer that is present, so the advert has somewhere to go.
  hub.presenceList = () => [{ id: 'friend', online: true, kind: 'peer' }];
  hub.send = (peerId, obj) => {
    sent.push(obj);
    return true;
  };
  agentHub.announceAll();

  const advert = sent.find((o) => o.type === 'agent-advert');
  assert.ok(advert, 'the peer is told the agent exists');
  assert.deepEqual(
    Object.keys(advert).sort(),
    ['agentId', 'agentKind', 'directChat', 'name', 'type'],
    'and is told exactly that — no command, no working directory, no profile'
  );
  const wire = JSON.stringify(advert);
  assert.doesNotMatch(wire, /lanchat/, 'the profile never crosses');
  assert.doesNotMatch(wire, /secrets/, 'nor the working directory');
});

// Profiles against the real Hermes. Off by default for the same reasons as the
// launch test above; run with LANCHAT_ACP_LIVE=1.
test('a real ACP agent starts under a named profile, and says so when the name is wrong', { skip: !process.env.LANCHAT_ACP_LIVE }, async () => {
  const { createAcpTransport } = require('../src/main/agents/transports/acp.js');
  const { hermesLaunchArgs, localProfiles } = require('../src/main/agents/profiles.js');
  const available = localProfiles();
  assert.ok(available.length, 'this machine has at least one Hermes profile to test with');

  const build = (profile) =>
    createAcpTransport({
      id: 'agent:live-profile',
      name: 'Hermes',
      config: { command: 'hermes', args: hermesLaunchArgs({ command: 'hermes', args: ['acp'], profile }) },
      timeoutMs: 90000,
    });

  const good = build(available[0]);
  try {
    assert.match((await good.start()).detail, /ACP session with/);
  } finally {
    await good.stop();
  }

  // Unlike HTTP, a name Hermes does not know is an error rather than a silent
  // fallback — and it is only legible because stderr is kept.
  const bad = build('nosuchprofilehere');
  try {
    await assert.rejects(
      () => bad.start(),
      (err) => {
        assert.match(err.detail || '', /does not exist/);
        return true;
      }
    );
  } finally {
    await bad.stop();
  }
});
