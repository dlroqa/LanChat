'use strict';

const test = require('node:test');
const assert = require('node:assert');

const a2a = require('../src/main/sessions/a2a.js');
const { dialoguePrompt } = require('../src/main/sessions/dialogue.js');

// The discussion record, in A2A's shape.
//
// Two things are worth pinning, and they fail for different reasons.
//
// The first is the wire vocabulary. These field names and state strings are not
// LanChat's to choose — they belong to a published protocol, and the value of
// using them at all is that something else already understands them. A rename
// here that "reads better" is a rename that breaks the one property this file
// exists to provide, so the exact strings are asserted rather than the shapes.
//
// The second is that the record is genuinely the source of the prompt. Building
// a tidy parallel structure that nothing reads would be worse than not building
// it: it would look like a foundation while the real conversation went on
// happening somewhere else.

// ---- the vocabulary ----

test('a turn is an A2A message, in the JSON binding this file pins', () => {
  const msg = a2a.agentMessage({
    text: 'Beacon is taken.',
    contextId: 'session:1',
    taskId: 'round:1',
    agentId: 'agent:h',
    agentName: 'Hermes',
    turn: 3,
  });

  assert.equal(msg.kind, 'message', 'the discriminator the 0.3 binding uses');
  assert.equal(msg.role, 'agent', 'lowercase, not ROLE_AGENT — that is the 1.0 draft');
  assert.deepEqual(msg.parts, [{ kind: 'text', text: 'Beacon is taken.' }]);
  assert.equal(msg.contextId, 'session:1', 'the session is the context');
  assert.equal(msg.taskId, 'round:1', 'and the round is the task');
  assert.ok(msg.messageId, 'every message identifies itself');
});

test('the person watching is the user role, and never an agent', () => {
  const msg = a2a.userMessage({ text: 'stop arguing about birds', contextId: 's', taskId: 't' });
  assert.equal(msg.role, 'user');
  assert.equal(msg.metadata[a2a.KEY.agentId], undefined, 'a person has no agent id');
});

test('which agent spoke rides in metadata, because A2A has no role for it', () => {
  // A2A is one client talking to one agent: there are two roles and no third.
  // A LanChat discussion has four speakers on the agent side, so the identity
  // goes where a protocol expects its extensions to go, under a namespace that
  // will not collide with somebody else's.
  const msg = a2a.agentMessage({ text: 'x', agentId: 'agent:b', agentName: 'Beacon', turn: 2 });
  assert.equal(msg.metadata['lanchat.agentId'], 'agent:b');
  assert.equal(msg.metadata['lanchat.agentName'], 'Beacon');
  assert.equal(msg.metadata['lanchat.turn'], 2);
  assert.equal(msg.metadata['lanchat.a2aVersion'], '0.3', 'and says which binding it was written in');
});

test('the task states are the ones the protocol spells, not ones that read nicely', () => {
  assert.equal(a2a.STATE.inputRequired, 'input-required', 'hyphenated, lowercase');
  assert.equal(a2a.STATE.authRequired, 'auth-required');
  assert.equal(a2a.STATE.canceled, 'canceled', 'one l — the protocol spells it American');
  assert.deepEqual(Object.values(a2a.STATE).sort(), [
    'auth-required',
    'canceled',
    'completed',
    'failed',
    'input-required',
    'rejected',
    'submitted',
    'working',
  ]);
});

test('a round in flight is working, and one waiting on the person needs input', () => {
  assert.equal(a2a.taskState({ open: true }), 'working');
  assert.equal(a2a.taskState({ open: true, paused: true }), 'input-required');
});

test('how a discussion ended decides which terminal state it lands in', () => {
  assert.equal(a2a.taskState({ open: false, ended: 'stopped' }), 'canceled');
  assert.equal(a2a.taskState({ open: false, ended: 'error' }), 'failed');
  // The ones that are not failures. A discussion that ran out of turns, or that
  // stopped because nobody had more to say, produced an answer somebody can
  // read — reporting that as `failed` would mislead anything that later sees
  // these states without LanChat's own reason beside them.
  for (const ended of ['spent', 'converged', 'silence', 'dwindled', null]) {
    assert.equal(a2a.taskState({ open: false, ended }), 'completed', `${ended} is not a failure`);
  }
});

test('a round becomes a Task carrying its whole history', () => {
  const round = {
    id: 'round:1',
    sessionId: 'session:1',
    mode: 'dialogue',
    open: false,
    ended: 'spent',
    turn: 12,
    cap: 12,
    lastAt: Date.UTC(2026, 7, 5),
    history: [a2a.userMessage({ text: 'q' }), a2a.agentMessage({ text: 'a', agentName: 'Hermes' })],
  };
  const t = a2a.task(round);

  assert.equal(t.kind, 'task');
  assert.equal(t.id, 'round:1');
  assert.equal(t.contextId, 'session:1', 'the session groups every task in it');
  assert.equal(t.status.state, 'completed');
  assert.equal(t.status.timestamp, '2026-08-05T00:00:00.000Z', 'ISO 8601, as the protocol asks');
  assert.equal(t.history.length, 2);
  assert.notEqual(t.history, round.history, 'and the copy cannot be edited through');
});

// ---- reading it back ----

test('the text of a message is all of its text parts', () => {
  assert.equal(a2a.textOf(a2a.agentMessage({ text: 'one' })), 'one');
  assert.equal(
    a2a.textOf({
      parts: [
        { kind: 'text', text: 'one ' },
        { kind: 'text', text: 'two' },
      ],
    }),
    'one two'
  );
  assert.equal(
    a2a.textOf({
      parts: [
        { kind: 'text', text: 'words' },
        { kind: 'file', uri: 'x' },
      ],
    }),
    'words',
    'and a part that is not text contributes none'
  );
  assert.equal(a2a.textOf(null), '', 'nothing is empty rather than a crash');
});

test('a part with no kind is still text, so a 1.0 server can be read', () => {
  // The 1.0 draft drops the discriminator in favour of a oneof. Being generous
  // on the way in costs nothing and is the difference between reading such a
  // server and silently seeing every reply as blank.
  assert.equal(a2a.textOf({ parts: [{ text: 'from a newer server' }] }), 'from a newer server');
});

test('turns come back out as speakers, in the order they were said', () => {
  const history = [
    a2a.agentMessage({ text: 'first', agentId: 'a', agentName: 'Hermes' }),
    a2a.userMessage({ text: 'stop that' }),
    a2a.agentMessage({ text: 'second', agentId: 'b', agentName: 'Tessie' }),
  ];
  assert.deepEqual(a2a.turnsOf(history), [
    { agentId: 'a', name: 'Hermes', role: 'agent', text: 'first' },
    { agentId: null, name: 'The person watching', role: 'user', text: 'stop that' },
    { agentId: 'b', name: 'Tessie', role: 'agent', text: 'second' },
  ]);
});

test('the person is labelled, never named as though they were an agent', () => {
  // An agent reading "Hermes: stop that" replies to Hermes. The label has to say
  // plainly that this one came from outside the discussion, or the next speaker
  // answers a colleague who does not exist.
  const [turn] = a2a.turnsOf([a2a.userMessage({ text: 'stop that' })]);
  assert.equal(turn.name, 'The person watching');
  assert.equal(turn.agentId, null);
});

// ---- and it really is what the prompt is built from ----

test('the record renders into the prompt agents are actually shown', () => {
  const history = [
    a2a.agentMessage({ text: 'Beacon is taken.', agentId: 'a', agentName: 'Hermes' }),
    a2a.agentMessage({ text: 'Then Wren.', agentId: 'b', agentName: 'Tessie' }),
  ];
  const prompt = dialoguePrompt({
    question: 'what should we call it?',
    speaker: { agentId: 'c', name: 'Beacon' },
    roster: [
      { agentId: 'a', name: 'Hermes' },
      { agentId: 'b', name: 'Tessie' },
      { agentId: 'c', name: 'Beacon' },
    ],
    history: a2a.turnsOf(history),
    turn: 3,
    cap: 12,
  });

  assert.match(prompt, /Hermes:\nBeacon is taken\./, 'quoted and attributed straight from the record');
  assert.match(prompt, /Tessie:\nThen Wren\./);
  assert.match(prompt, /what should we call it\?$/, 'with the question still last');
});
