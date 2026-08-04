'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

// Same electron stub the other agent tests use — the registry reaches for
// safeStorage and nothing here needs a real keychain.
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

const { createApprovalGate } = require('../src/main/agents/approvalGate.js');
const { createAgentHub } = require('../src/main/agents/index.js');
const { normaliseApprovals } = require('../src/main/agents/registry.js');
const { PeerHub } = require('../src/main/peers.js');
const { MessageStore } = require('../src/main/store.js');

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`sealed:${s}`),
  decryptString: (b) => b.toString().replace(/^sealed:/, ''),
};

function tmpdir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lanchat-${name}-`));
}

// A hub whose transport asks for permission on every run and records what it was
// finally told. `answered` is the transport's side of the story: what the agent
// actually received, as opposed to what any UI thought it had decided.
function approvalHub() {
  const dir = tmpdir('delegated');
  const bus = new EventEmitter();
  const hub = new PeerHub({ getIdentity: () => ({ id: 'me', name: 'Me' }), bus });
  const answered = [];
  let raise = null; // fires the pending approval for the current run

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
          raise = () =>
            h.onApproval?.({
              runId: 'run-1',
              command: 'rm -rf /',
              choices: ['once', 'always', 'deny'],
            });
          raise();
        },
        answerApproval: async (runId, choice) => {
          answered.push({ runId, choice });
          return true;
        },
        stop: async () => {},
      }),
    },
  });

  // Every peer the tests name is treated as connected, and every frame it is
  // sent is recorded. Replacing hub.send is how the existing agent tests observe
  // the wire; presenceList is what the audience and revocation paths read.
  const relayed = [];
  hub.send = (peerId, obj) => {
    relayed.push({ peerId, obj });
    return true;
  };
  const online = new Set(['friend', 'other']);
  hub.presenceList = () => [...online].map((id) => ({ id, name: id, online: true, kind: 'peer' }));

  const framesTo = (peerId, type) =>
    relayed.filter((r) => r.peerId === peerId && r.obj.type === type).map((r) => r.obj);

  return { dir, bus, hub, agentHub, answered, relayed, framesTo, online, raise: () => raise && raise() };
}

const settle = () => new Promise((r) => setImmediate(r));

// Adds an agent that `friend` may reach, with approvals delegated behind a
// passcode. `extra` moves the switches the individual tests are about.
async function sharedAgent(agentHub, extra = {}) {
  const { agent } = await agentHub.add({
    name: 'Hermes',
    kind: 'http',
    config: {},
    allowedPeers: ['friend'],
  });
  await agentHub.setApprovals(agent.id, {
    delegated: true,
    passcode: 'open sesame',
    handoverMs: 0,
    ...extra,
  });
  return agent;
}

// ---- the gate itself ----

test('a passcode is checked without being recoverable, and wrong tries cost time', () => {
  const dir = tmpdir('gate');
  const gate = createApprovalGate({ userDataDir: dir });
  gate.setPasscode('agent:1', 'hunter2');

  // What lands on disk is a salted hash and nothing else. This is the whole
  // reason it is a file of its own rather than a key in agents.json.
  const raw = fs.readFileSync(path.join(dir, 'agent-approvals.json'), 'utf8');
  assert.ok(!raw.includes('hunter2'), 'the passcode is never written down');
  assert.match(raw, /"salt"/);

  assert.equal(gate.redeem({ agentId: 'agent:1', peerId: 'friend', passcode: 'nope' }).ok, false);
  assert.equal(gate.redeem({ agentId: 'agent:1', peerId: 'friend', passcode: 'nope' }).ok, false);
  const third = gate.redeem({ agentId: 'agent:1', peerId: 'friend', passcode: 'nope' });
  assert.equal(third.ok, false);
  assert.ok(third.lockedMs > 0, 'a third wrong attempt starts costing time');

  // While locked, even the right passcode is refused — knowing the answer must
  // not be a way to skip the wait.
  const locked = gate.redeem({ agentId: 'agent:1', peerId: 'friend', passcode: 'hunter2' });
  assert.equal(locked.ok, false);
  assert.ok(locked.lockedMs > 0);

  // Another peer's attempts are counted separately, so one peer fumbling cannot
  // lock out somebody who has theirs right.
  const other = gate.redeem({ agentId: 'agent:1', peerId: 'other', passcode: 'hunter2' });
  assert.equal(other.ok, true);
  assert.ok(other.token);
  assert.deepEqual(gate.holders('agent:1'), ['other']);
});

test('a token is bound to one peer and one agent, and dies with the connection', () => {
  const gate = createApprovalGate({ userDataDir: tmpdir('gate-token') });
  gate.setPasscode('agent:1', 'pw');
  gate.setPasscode('agent:2', 'pw');
  const { token } = gate.redeem({ agentId: 'agent:1', peerId: 'friend', passcode: 'pw' });

  assert.equal(gate.verifyToken({ agentId: 'agent:1', peerId: 'friend', token }), true);
  assert.equal(gate.verifyToken({ agentId: 'agent:1', peerId: 'other', token }), false, 'not another peer');
  assert.equal(gate.verifyToken({ agentId: 'agent:2', peerId: 'friend', token }), false, 'not another agent');

  gate.revokePeer('friend');
  assert.equal(gate.verifyToken({ agentId: 'agent:1', peerId: 'friend', token }), false);
});

test('unattended cannot be armed on its own, and a stale one does not survive', () => {
  // Storing "unattended" while delegation is off would leave a trap: switching
  // delegation back on months later would find the wider setting still armed.
  assert.deepEqual(normaliseApprovals({ delegated: false, unattended: true }), {
    delegated: false,
    unattended: false,
    handoverMs: 20000,
  });
  assert.equal(normaliseApprovals({ delegated: true, unattended: true }).unattended, true);
  // And a handover delay is clamped rather than trusted.
  assert.equal(normaliseApprovals({ handoverMs: -5 }).handoverMs, 0);
  assert.equal(normaliseApprovals({ handoverMs: 99999999 }).handoverMs, 600000);
});

// ---- what is relayed, and to whom ----

test('with nothing delegated, an approval is surfaced locally and never relayed', async () => {
  const { hub, agentHub, framesTo, relayed } = approvalHub();
  const { agent } = await agentHub.add({
    name: 'Hermes',
    kind: 'http',
    config: {},
    allowedPeers: ['friend'],
  });

  const approvals = [];
  hub.bus.on('agent-approval', (a) => approvals.push(a));

  agentHub.routeFromPeer('friend', '@Hermes delete everything');
  await settle();

  // The property this feature had to leave standing: opting in is the only way
  // an approval reaches the network, and the default is still nobody.
  assert.equal(approvals.length, 1, 'the owner is asked');
  assert.equal(approvals[0].agentId, agent.id);
  assert.deepEqual(approvals[0].delegates, [], 'and nobody else is offered it');
  assert.equal(framesTo('friend', 'agent-approval-ask').length, 0);
  assert.equal(
    relayed.some((r) => JSON.stringify(r.obj).includes('rm -rf')),
    false,
    'the command itself never goes out'
  );
});

test('a claim needs reach as well as the passcode', async () => {
  const { agentHub, framesTo } = approvalHub();
  const agent = await sharedAgent(agentHub);

  // Right passcode, no reach. Two gates means this is refused.
  assert.equal(agentHub.claimApprovals('other', agent.id, 'open sesame'), false);
  // Reach, wrong passcode.
  assert.equal(agentHub.claimApprovals('friend', agent.id, 'guess'), false);
  // Both.
  assert.equal(agentHub.claimApprovals('friend', agent.id, 'open sesame'), true);

  const refusals = framesTo('other', 'agent-approval-grant');
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0].ok, false);
  assert.equal(refusals[0].token, undefined, 'a refusal carries nothing');

  const grants = framesTo('friend', 'agent-approval-grant').filter((f) => f.ok);
  assert.equal(grants.length, 1);
  assert.ok(grants[0].token, 'the grant carries a token');
});

test('a holder is offered the approval their own question raised', async () => {
  const { agentHub, framesTo, answered } = approvalHub();
  const agent = await sharedAgent(agentHub);
  agentHub.claimApprovals('friend', agent.id, 'open sesame');
  const token = framesTo('friend', 'agent-approval-grant').find((f) => f.ok).token;

  agentHub.routeFromPeer('friend', '@Hermes delete everything');
  await settle();

  const asks = framesTo('friend', 'agent-approval-ask');
  assert.equal(asks.length, 1, 'the peer who asked is offered it');
  assert.equal(asks[0].command, 'rm -rf /');
  // The transport's own run id never leaves this machine — the wire carries an
  // id minted for the relay and nothing else.
  assert.notEqual(asks[0].approvalId, 'run-1');

  await agentHub.answerRemoteApproval('friend', {
    agentId: agent.id,
    approvalId: asks[0].approvalId,
    choice: 'once',
    token,
  });
  assert.deepEqual(answered, [{ runId: 'run-1', choice: 'once' }], 'the agent is told what they chose');
});

test('a delegate cannot answer under an id issued to somebody else', async () => {
  const { agentHub, framesTo, answered, online } = approvalHub();
  const agent = await sharedAgent(agentHub);
  // Both peers may reach it, and both hold rights.
  await agentHub.setAllowedPeers(agent.id, ['friend', 'other']);
  agentHub.claimApprovals('friend', agent.id, 'open sesame');
  agentHub.claimApprovals('other', agent.id, 'open sesame');
  const otherToken = framesTo('other', 'agent-approval-grant').find((f) => f.ok).token;
  assert.ok(online.has('other'));

  agentHub.routeFromPeer('friend', '@Hermes delete everything');
  await settle();

  const asks = framesTo('friend', 'agent-approval-ask');
  assert.equal(asks.length, 1);
  // Origin binding: the question was friend's, so only friend was offered it.
  assert.equal(framesTo('other', 'agent-approval-ask').length, 0, 'nobody else is asked');

  // And even holding valid rights of their own, `other` cannot answer it — the
  // wire id was issued to friend.
  const stolen = await agentHub.answerRemoteApproval('other', {
    agentId: agent.id,
    approvalId: asks[0].approvalId,
    choice: 'always',
    token: otherToken,
  });
  assert.equal(stolen, false);
  assert.deepEqual(answered, [], 'the agent was told nothing');
});

test('with unattended off, a run the owner started is offered to nobody', async () => {
  const { agentHub, framesTo, answered } = approvalHub();
  const agent = await sharedAgent(agentHub, { unattended: false });
  agentHub.claimApprovals('friend', agent.id, 'open sesame');
  const token = framesTo('friend', 'agent-approval-grant').find((f) => f.ok).token;

  // Asked from this machine — a session, or the agent's own thread. No origin.
  agentHub.ask(agent.id, 'tidy up the repo');
  await settle();

  assert.equal(
    framesTo('friend', 'agent-approval-ask').length,
    0,
    'a holder is not offered the owner’s own run'
  );
  // Nor can they answer one by guessing at it: there is no wire id to use.
  const forged = await agentHub.answerRemoteApproval('friend', {
    agentId: agent.id,
    approvalId: 'run-1',
    choice: 'always',
    token,
  });
  assert.equal(forged, false);
  assert.deepEqual(answered, []);
});

test('with unattended on, the owner’s own run is offered to every holder', async () => {
  const { agentHub, framesTo, answered, hub } = approvalHub();
  const agent = await sharedAgent(agentHub, { unattended: true });
  await agentHub.setAllowedPeers(agent.id, ['friend', 'other']);
  agentHub.claimApprovals('friend', agent.id, 'open sesame');
  agentHub.claimApprovals('other', agent.id, 'open sesame');
  const otherToken = framesTo('other', 'agent-approval-grant').find((f) => f.ok).token;

  agentHub.ask(agent.id, 'tidy up the repo');
  await settle();

  assert.equal(framesTo('friend', 'agent-approval-ask').length, 1);
  const asks = framesTo('other', 'agent-approval-ask');
  assert.equal(asks.length, 1, 'every holder is offered it — whoever is around answers');

  const closed = [];
  hub.bus.on('agent-approval-closed', (c) => closed.push(c));

  assert.equal(
    await agentHub.answerRemoteApproval('other', {
      agentId: agent.id,
      approvalId: asks[0].approvalId,
      choice: 'always',
      token: otherToken,
    }),
    true
  );
  assert.deepEqual(answered, [{ runId: 'run-1', choice: 'always' }]);
  // The first answer wins: everyone else showing it is told to take it down,
  // and so is the local card.
  assert.equal(closed.length, 1);
  assert.equal(closed[0].by, 'other');
  assert.equal(framesTo('friend', 'agent-approval-close').length, 1);
  assert.equal(framesTo('other', 'agent-approval-close').length, 0, 'not back to whoever answered');
});

test('switching the toggle off refuses an answer already in flight', async () => {
  const { agentHub, framesTo, answered } = approvalHub();
  const agent = await sharedAgent(agentHub, { unattended: true });
  agentHub.claimApprovals('friend', agent.id, 'open sesame');
  const token = framesTo('friend', 'agent-approval-grant').find((f) => f.ok).token;

  agentHub.ask(agent.id, 'tidy up the repo');
  await settle();
  const ask = framesTo('friend', 'agent-approval-ask')[0];
  assert.ok(ask, 'it was offered');

  // The owner changes their mind while the answer is on the wire.
  await agentHub.setApprovals(agent.id, { delegated: false });

  const late = await agentHub.answerRemoteApproval('friend', {
    agentId: agent.id,
    approvalId: ask.approvalId,
    choice: 'always',
    token,
  });
  assert.equal(late, false, 'the answer is refused, not raced');
  assert.deepEqual(answered, []);
});

test('the local user answering first closes the relayed card', async () => {
  const { agentHub, framesTo, answered } = approvalHub();
  const agent = await sharedAgent(agentHub, { unattended: true });
  agentHub.claimApprovals('friend', agent.id, 'open sesame');
  const token = framesTo('friend', 'agent-approval-grant').find((f) => f.ok).token;

  agentHub.routeFromPeer('friend', '@Hermes delete everything');
  await settle();
  const ask = framesTo('friend', 'agent-approval-ask')[0];

  // The owner walks back to their desk and denies it.
  assert.equal(await agentHub.answerApproval(agent.id, 'run-1', 'deny'), true);
  assert.deepEqual(answered, [{ runId: 'run-1', choice: 'deny' }]);
  assert.equal(framesTo('friend', 'agent-approval-close').length, 1, 'their card comes down');

  // And the delegate's click, arriving a moment later, decides nothing.
  const late = await agentHub.answerRemoteApproval('friend', {
    agentId: agent.id,
    approvalId: ask.approvalId,
    choice: 'always',
    token,
  });
  assert.equal(late, false);
  assert.equal(answered.length, 1, 'the agent was told once');
});

// ---- losing the right ----

test('rights are revoked by re-pin, by losing reach, and by the agent going off', async () => {
  const { agentHub, framesTo, answered } = approvalHub();
  const agent = await sharedAgent(agentHub);

  const claim = () => {
    agentHub.claimApprovals('friend', agent.id, 'open sesame');
    const grants = framesTo('friend', 'agent-approval-grant').filter((f) => f.ok);
    return grants[grants.length - 1].token;
  };

  // A key change takes the grant with it — the peer id survives a re-pin, so
  // without this, accepting a new key would inherit everything the old one had.
  let token = claim();
  agentHub.revokePeer('friend');
  agentHub.claimApprovals('friend', agent.id, 'open sesame');
  assert.equal(
    framesTo('friend', 'agent-approval-grant').filter((f) => f.ok).length,
    1,
    'revokePeer stripped reach, so the re-claim is refused too'
  );

  // Losing reach alone is enough, with the agent otherwise untouched.
  await agentHub.setAllowedPeers(agent.id, ['friend']);
  token = claim();
  await agentHub.setAllowedPeers(agent.id, []);
  agentHub.routeFromPeer('friend', '@Hermes delete everything');
  await settle();
  assert.equal(framesTo('friend', 'agent-approval-ask').length, 0);

  // And switching the agent off is the hardest gate of all.
  await agentHub.setAllowedPeers(agent.id, ['friend']);
  token = claim();
  await agentHub.setEnabled(agent.id, false);
  await agentHub.setEnabled(agent.id, true);
  agentHub.routeFromPeer('friend', '@Hermes delete everything');
  await settle();
  assert.equal(framesTo('friend', 'agent-approval-ask').length, 0, 'the token did not survive the toggle');
  assert.ok(token);
  assert.deepEqual(answered, []);
});

test('a run ending closes the questions it left open, on a transport that never says so', async () => {
  // The ACP transport reports each question it closes; the HTTP one has no such
  // signal and can raise an approval and simply finish. Without a sweep at the
  // end of a run, that question stays on the books for the life of the process
  // and its wire id goes on resolving to a run that is over.
  const { agentHub, framesTo, answered, hub } = approvalHub();
  const agent = await sharedAgent(agentHub, { unattended: true });
  agentHub.claimApprovals('friend', agent.id, 'open sesame');
  const token = framesTo('friend', 'agent-approval-grant').find((f) => f.ok).token;

  agentHub.ask(agent.id, 'tidy up the repo');
  await settle();
  const ask = framesTo('friend', 'agent-approval-ask')[0];
  assert.ok(ask, 'it was offered');

  const closed = [];
  hub.bus.on('agent-approval-closed', (c) => closed.push(c));
  // The transport finishes the run without anybody having answered.
  await agentHub.stopRun(agent.id);

  assert.equal(
    closed.some((c) => c.reason === 'stopped' || c.reason === 'ended'),
    true
  );
  assert.equal(framesTo('friend', 'agent-approval-close').length, 1, 'their card comes down');

  const late = await agentHub.answerRemoteApproval('friend', {
    agentId: agent.id,
    approvalId: ask.approvalId,
    choice: 'always',
    token,
  });
  assert.equal(late, false, 'and the id no longer resolves to anything');
  assert.deepEqual(answered, []);
});

test('a delegated answer is written into the owner’s transcript', async () => {
  const { agentHub, framesTo, bus } = approvalHub();
  const agent = await sharedAgent(agentHub);
  agentHub.claimApprovals('friend', agent.id, 'open sesame');
  const token = framesTo('friend', 'agent-approval-grant').find((f) => f.ok).token;

  const filed = [];
  bus.on('peer-message', (m) => filed.push(m));

  agentHub.routeFromPeer('friend', '@Hermes delete everything');
  await settle();
  const ask = framesTo('friend', 'agent-approval-ask')[0];
  await agentHub.answerRemoteApproval('friend', {
    agentId: agent.id,
    approvalId: ask.approvalId,
    choice: 'always',
    token,
  });

  // Kept, not swept: a tool call authorised while the owner was away is exactly
  // what they will want to find afterwards.
  const audit = filed.find((m) => m.text && m.text.includes('on your behalf'));
  assert.ok(audit, 'the decision is recorded');
  assert.match(audit.text, /friend/);
  assert.match(audit.text, /allowed \(always\)/);
  assert.match(audit.text, /rm -rf \//);
  assert.notEqual(audit.notice, true, 'and it is not swept away like queue chatter');
});
